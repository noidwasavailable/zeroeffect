import { Context, Effect, Layer } from "effect";
import * as Schema from "effect/Schema";
import { LlmEndpointError } from "../../shared/errors";
import { LabellingDecisionSchema, type LabellingDecision } from "../../shared/schemas";

export interface LlmEndpoint {
  readonly baseUrl: string;
  readonly modelId: string;
  readonly timeoutMs?: number;
}

export interface LlmProviderService {
  readonly decide: (
    endpoint: LlmEndpoint,
    apiKey: string,
    apiMode: "responses" | "chat_completions",
    instructions: string,
    input: string,
  ) => Effect.Effect<LabellingDecision, LlmEndpointError>;
}

export class LlmProvider extends Context.Service<LlmProvider, LlmProviderService>()(
  "zeroeffect/LlmProvider",
) {}

export interface LlmProviderConfig {
  readonly fetch?: (input: URL, init?: RequestInit) => Promise<Response>;
}

const decisionJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    matched: { type: "boolean" },
    labelsToAdd: { type: "array", items: { type: "string" } },
    labelsToRemove: { type: "array", items: { type: "string" } },
    archive: { type: "boolean" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    reasoning: { type: "string" },
  },
  required: ["matched", "labelsToAdd", "labelsToRemove", "archive", "confidence", "reasoning"],
} as const;

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

const makeService = (config: LlmProviderConfig): LlmProviderService => ({
  decide: (endpoint, apiKey, apiMode, instructions, input) =>
    Effect.tryPromise({
      try: async () => {
        const baseUrl = endpoint.baseUrl.replace(/\/+$/, "");
        const url = new URL(`${baseUrl}/${apiMode === "responses" ? "responses" : "chat/completions"}`);
        const body = apiMode === "responses"
          ? {
              model: endpoint.modelId,
              instructions,
              input,
              text: {
                format: {
                  type: "json_schema",
                  name: "labelling_decision",
                  strict: true,
                  schema: decisionJsonSchema,
                },
              },
            }
          : {
              model: endpoint.modelId,
              messages: [
                { role: "system", content: instructions },
                { role: "user", content: input },
              ],
              response_format: {
                type: "json_schema",
                json_schema: { name: "labelling_decision", strict: true, schema: decisionJsonSchema },
              },
            };
        let response: Response;
        try {
          response = await (config.fetch ?? globalThis.fetch)(url, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
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
        const decisionText = apiMode === "responses"
          ? extractResponsesText(responseJson)
          : extractChatText(responseJson);
        if (decisionText === null) throw error(apiMode, "LLM response did not contain structured output.", rawBody);

        let decisionJson: unknown;
        try {
          decisionJson = JSON.parse(decisionText);
        } catch {
          throw error(apiMode, "LLM structured output was invalid JSON.", decisionText);
        }
        let decision: LabellingDecision;
        try {
          decision = Schema.decodeUnknownSync(LabellingDecisionSchema)(decisionJson);
        } catch {
          throw error(apiMode, "LLM structured output did not match the labelling decision schema.", decisionText);
        }
        if (!Number.isFinite(decision.confidence) || decision.confidence < 0 || decision.confidence > 1) {
          throw error(apiMode, "LLM confidence must be between 0 and 1.", decisionText);
        }
        return decision;
      },
      catch: (cause) => cause instanceof LlmEndpointError
        ? cause
        : error(apiMode, "LLM request failed.", cause instanceof Error ? cause.message : ""),
    }),
});

export const LlmProviderLive = (config: LlmProviderConfig = {}): Layer.Layer<LlmProvider> =>
  Layer.succeed(LlmProvider, makeService(config));

export const LlmProviderTest = LlmProviderLive;
