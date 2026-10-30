import { Context, Effect, Layer } from "effect";
import * as Schema from "effect/Schema";
import type { ConversationStatus } from "../../shared/aiRules";
import { LlmEndpointError } from "../../shared/errors";
import { RuleSelectionSchema, type RuleSelection } from "../../shared/schemas";
import { resolveRuleName } from "./AiRulePrompt";

export interface LlmEndpoint {
  readonly baseUrl: string;
  readonly modelId: string;
  readonly timeoutMs?: number;
}

export interface RuleSelectionRequest {
  readonly instructions: string;
  readonly input: string;
  /** The only names the model may return (enforced by the JSON schema and checked on the way back). */
  readonly ruleNames: ReadonlyArray<string>;
  /** Valid conversation statuses for this thread; empty when the conversations option is not offered. */
  readonly conversationStatuses: ReadonlyArray<ConversationStatus>;
}

export interface LlmProviderService {
  /** One structured-output call choosing which offered rules apply to a thread. */
  readonly chooseRules: (
    endpoint: LlmEndpoint,
    apiKey: string,
    apiMode: "responses" | "chat_completions",
    request: RuleSelectionRequest,
  ) => Effect.Effect<RuleSelection, LlmEndpointError>;
}

export class LlmProvider extends Context.Service<LlmProvider, LlmProviderService>()(
  "zeroeffect/LlmProvider",
) {}

export interface LlmProviderConfig {
  readonly fetch?: (input: URL, init?: RequestInit) => Promise<Response>;
}

/**
 * Strict-mode JSON schema for one request. `reasoning` comes first so models reason before they
 * choose; enums stop invented rule names and statuses at the source on providers that enforce
 * schemas (OpenAI, vLLM, LiteLLM), and the same checks run on the response for those that don't.
 */
export const ruleSelectionJsonSchema = (request: Pick<RuleSelectionRequest, "ruleNames" | "conversationStatuses">) => ({
  type: "object",
  additionalProperties: false,
  properties: {
    reasoning: { type: "string", description: "One or two sentences: what the thread is and why the chosen rules fit." },
    matchedRules: {
      type: "array",
      description: "Every rule that applies; usually one. Empty when noMatchFound is true.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          ruleName: { type: "string", enum: [...request.ruleNames], description: "The exact rule name." },
          isPrimary: { type: "boolean", description: "True for exactly one rule: the most specific match." },
        },
        required: ["ruleName", "isPrimary"],
      },
    },
    noMatchFound: { type: "boolean", description: "True only when no rule reasonably applies." },
    conversationStatus: request.conversationStatuses.length > 0
      ? { type: ["string", "null"], enum: [...request.conversationStatuses, null], description: "Set only when the conversations option is selected; otherwise null." }
      : { type: "null", description: "Always null." },
  },
  required: ["reasoning", "matchedRules", "noMatchFound", "conversationStatus"],
});

const error = (
  apiMode: "responses" | "chat_completions",
  message: string,
  rawBody = "",
): LlmEndpointError => new LlmEndpointError({ apiMode, message, rawBody });

const extractResponsesText = (value: unknown): string | null => {
  if (typeof value !== "object" || value === null) return null;
  if ("output_text" in value && typeof value.output_text === "string") return value.output_text;
  if (!("output" in value) || !Array.isArray(value.output)) return null;
  for (const item of value.output) {
    if (typeof item !== "object" || item === null || !("content" in item) || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (typeof part === "object" && part !== null && "text" in part && typeof part.text === "string") return part.text;
    }
  }
  return null;
};

const extractChatText = (value: unknown): string | null => {
  if (typeof value !== "object" || value === null || !("choices" in value) || !Array.isArray(value.choices)) return null;
  const first = value.choices[0];
  if (typeof first !== "object" || first === null || !("message" in first)) return null;
  const message = first.message;
  return typeof message === "object" && message !== null && "content" in message && typeof message.content === "string"
    ? message.content
    : null;
};

/** Providers that ignore the schema sometimes wrap the object in prose or ``` fences. */
const extractJsonObject = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("no JSON object found");
    return JSON.parse(text.slice(start, end + 1));
  }
};

/** A response the model can be asked to correct, as opposed to a transport or HTTP failure. */
class InvalidSelection extends Error {}

/** Validates and canonicalizes a selection; throws InvalidSelection describing what to fix. */
export const validateSelection = (raw: unknown, request: Pick<RuleSelectionRequest, "ruleNames" | "conversationStatuses">): RuleSelection => {
  let selection: RuleSelection;
  try {
    selection = Schema.decodeUnknownSync(RuleSelectionSchema)(raw);
  } catch (cause) {
    throw new InvalidSelection(`The JSON did not match the required shape: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  const unknownNames: string[] = [];
  const matchedRules = selection.matchedRules.flatMap((match) => {
    const name = resolveRuleName(request.ruleNames, match.ruleName);
    if (!name) unknownNames.push(match.ruleName);
    return name ? [{ ruleName: name, isPrimary: match.isPrimary }] : [];
  });
  if (unknownNames.length > 0) {
    throw new InvalidSelection(`Unknown rule name(s): ${unknownNames.join(", ")}. Use only: ${request.ruleNames.join(", ")}.`);
  }
  if (!selection.noMatchFound && matchedRules.length === 0) {
    throw new InvalidSelection("noMatchFound is false but matchedRules is empty.");
  }
  if (selection.conversationStatus !== null && !request.conversationStatuses.includes(selection.conversationStatus)) {
    throw new InvalidSelection(`conversationStatus must be one of: ${[...request.conversationStatuses, "null"].join(", ")}.`);
  }
  // Keep a single primary: the first one marked, else the first match.
  const primaryIndex = Math.max(0, matchedRules.findIndex((match) => match.isPrimary));
  const deduplicated = matchedRules.filter((match, index) => matchedRules.findIndex((other) => other.ruleName === match.ruleName) === index);
  return {
    ...selection,
    noMatchFound: deduplicated.length === 0,
    matchedRules: deduplicated.map((match) => ({ ...match, isPrimary: match.ruleName === matchedRules[primaryIndex]?.ruleName })),
  };
};

const makeService = (config: LlmProviderConfig): LlmProviderService => {
  const call = async (
    endpoint: LlmEndpoint,
    apiKey: string,
    apiMode: "responses" | "chat_completions",
    request: RuleSelectionRequest,
    input: string,
  ): Promise<string> => {
    const baseUrl = endpoint.baseUrl.replace(/\/+$/, "");
    const url = new URL(`${baseUrl}/${apiMode === "responses" ? "responses" : "chat/completions"}`);
    const schema = ruleSelectionJsonSchema(request);
    const body = apiMode === "responses"
      ? {
          model: endpoint.modelId,
          instructions: request.instructions,
          input,
          text: { format: { type: "json_schema", name: "rule_selection", strict: true, schema } },
        }
      : {
          model: endpoint.modelId,
          messages: [
            { role: "system", content: request.instructions },
            { role: "user", content: input },
          ],
          response_format: { type: "json_schema", json_schema: { name: "rule_selection", strict: true, schema } },
        };
    let response: Response;
    try {
      response = await (config.fetch ?? globalThis.fetch)(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(endpoint.timeoutMs ?? 30_000),
      });
    } catch (cause) {
      throw error(apiMode, cause instanceof Error ? cause.message : "LLM request failed.");
    }
    const rawBody = await response.text();
    if (!response.ok) throw error(apiMode, `LLM endpoint returned HTTP ${response.status}.`, rawBody);
    let responseJson: unknown;
    try {
      responseJson = JSON.parse(rawBody);
    } catch {
      throw error(apiMode, "LLM endpoint returned invalid JSON.", rawBody);
    }
    const text = apiMode === "responses" ? extractResponsesText(responseJson) : extractChatText(responseJson);
    if (text === null) throw error(apiMode, "LLM response did not contain structured output.", rawBody);
    return text;
  };

  return {
    chooseRules: (endpoint, apiKey, apiMode, request) =>
      Effect.tryPromise({
        try: async () => {
          let input = request.input;
          // One correction round for malformed answers; transport and HTTP errors are not retried here.
          for (let attempt = 1; ; attempt++) {
            const text = await call(endpoint, apiKey, apiMode, request, input);
            try {
              let raw: unknown;
              try {
                raw = extractJsonObject(text);
              } catch {
                throw new InvalidSelection("The reply was not a JSON object.");
              }
              return validateSelection(raw, request);
            } catch (cause) {
              if (!(cause instanceof InvalidSelection)) throw cause;
              if (attempt >= 2) throw error(apiMode, `LLM structured output was invalid: ${cause.message}`, text);
              input = `${request.input}\n\nYour previous reply was invalid: ${cause.message}\nReply again with only the corrected JSON object.`;
            }
          }
        },
        catch: (cause) => cause instanceof LlmEndpointError
          ? cause
          : error(apiMode, "LLM request failed.", cause instanceof Error ? cause.message : ""),
      }),
  };
};

export const LlmProviderLive = (config: LlmProviderConfig = {}): Layer.Layer<LlmProvider> =>
  Layer.succeed(LlmProvider, makeService(config));

export const LlmProviderTest = LlmProviderLive;
