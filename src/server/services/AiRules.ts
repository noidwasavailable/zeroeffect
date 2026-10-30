import * as Schema from "effect/Schema";
import {
  EMPTY_RULES_FILE,
  isConversationStatus,
  RULE_ACTION_TYPES,
  type AiRule,
  type AiRulesFile,
} from "../../shared/aiRules";
import { formatFilterExpr, renameFilterLabels } from "../../shared/filterDsl";
import { parseFilterDsl } from "../../shared/filterParser";

// Parsing, validation and import of per-account AI rule files (see src/shared/aiRules.ts).

const NullableString = Schema.NullOr(Schema.String);

const RuleActionSchema = Schema.Struct({
  type: Schema.Literals(RULE_ACTION_TYPES),
  label: Schema.optional(NullableString),
});

const AiRuleSchema = Schema.Struct({
  name: Schema.String,
  instructions: Schema.String,
  enabled: Schema.Boolean,
  automate: Schema.Boolean,
  runOnThreads: Schema.Boolean,
  systemType: NullableString,
  conditionalOperator: Schema.Literals(["AND", "OR"]),
  from: NullableString,
  to: NullableString,
  subject: NullableString,
  body: NullableString,
  precondition: Schema.optional(NullableString),
  actions: Schema.Array(RuleActionSchema),
});

const RulesFileSchema = Schema.Struct({
  version: Schema.Literal(1),
  llmEndpointId: NullableString,
  apiMode: Schema.optional(Schema.NullOr(Schema.Literals(["responses", "chat_completions"]))),
  rules: Schema.Array(Schema.Unknown),
});

export interface RulesProblem {
  /** The rule's name, or its position when it has no usable name. */
  readonly rule: string | null;
  readonly message: string;
}

export interface LoadedRules {
  /** The file's settings and its valid rules. Writing this back would drop invalid rules, so editors must fix problems first. */
  readonly file: AiRulesFile;
  /** Rules that passed validation, in file order. Invalid rules stay in the file but never run. */
  readonly rules: ReadonlyArray<AiRule>;
  readonly problems: ReadonlyArray<RulesProblem>;
}

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** Semantic checks the schema cannot express. */
const ruleProblems = (rule: AiRule): string[] => {
  const problems: string[] = [];
  if (!rule.name.trim()) problems.push("Rule name is empty.");
  if (!rule.instructions.trim() && !rule.from && !rule.to && !rule.subject && !rule.body) {
    problems.push("Rule needs instructions or at least one static condition.");
  }
  if (rule.actions.length === 0 && !isConversationStatus(rule.systemType)) problems.push("Rule has no actions.");
  for (const action of rule.actions) {
    if (action.type === "LABEL" && !action.label?.trim()) problems.push("LABEL actions need a label.");
  }
  if (rule.precondition?.trim()) {
    const parsed = parseFilterDsl(rule.precondition);
    if (!parsed.ok) problems.push(`Invalid precondition: ${parsed.message} (at character ${parsed.offset + 1}).`);
  }
  return problems;
};

/** Reads a rules file. A missing file is an empty rule set; one broken rule never disables the others. */
export const parseRulesFile = (text: string | null): LoadedRules => {
  if (text === null || text.trim() === "") return { file: EMPTY_RULES_FILE, rules: [], problems: [] };
  let file: Schema.Schema.Type<typeof RulesFileSchema>;
  try {
    file = Schema.decodeUnknownSync(RulesFileSchema)(JSON.parse(text));
  } catch (error) {
    return { file: EMPTY_RULES_FILE, rules: [], problems: [{ rule: null, message: `The rules file is invalid: ${errorText(error)}` }] };
  }
  const rules: AiRule[] = [];
  const problems: RulesProblem[] = [];
  const names = new Set<string>();
  file.rules.forEach((candidate, index) => {
    const fallbackName = typeof (candidate as { name?: unknown })?.name === "string"
      ? (candidate as { name: string }).name
      : `Rule #${index + 1}`;
    let rule: AiRule;
    try {
      rule = Schema.decodeUnknownSync(AiRuleSchema)(candidate);
    } catch (error) {
      problems.push({ rule: fallbackName, message: errorText(error) });
      return;
    }
    const issues = ruleProblems(rule);
    const key = rule.name.trim().toLowerCase();
    if (names.has(key)) issues.push("Another rule already uses this name.");
    names.add(key);
    if (issues.length > 0) problems.push(...issues.map((message) => ({ rule: rule.name, message })));
    else rules.push(rule);
  });
  return { file: { version: 1, llmEndpointId: file.llmEndpointId, apiMode: file.apiMode ?? null, rules }, rules, problems };
};

/** Serializes a rules file the way it is kept on disk: stable key order, no null-only noise in actions. */
export const formatRulesFile = (file: AiRulesFile): string => JSON.stringify({
  version: 1,
  llmEndpointId: file.llmEndpointId,
  ...(file.apiMode ? { apiMode: file.apiMode } : {}),
  rules: file.rules.map((rule) => ({
    name: rule.name,
    instructions: rule.instructions,
    enabled: rule.enabled,
    automate: rule.automate,
    runOnThreads: rule.runOnThreads,
    systemType: rule.systemType,
    conditionalOperator: rule.conditionalOperator,
    from: rule.from,
    to: rule.to,
    subject: rule.subject,
    body: rule.body,
    ...(rule.precondition ? { precondition: rule.precondition } : {}),
    actions: rule.actions.map((action) => action.type === "LABEL" ? { type: action.type, label: action.label } : { type: action.type }),
  })),
}, null, 2) + "\n";

// Inbox Zero action fields that would change what an action does; any non-null value is unsupported.
const UNSUPPORTED_ACTION_FIELDS = [
  "to", "cc", "bcc", "subject", "content", "folderName", "url", "delayInMinutes",
  "integrationName", "integrationToolName", "integrationArgs",
] as const;

export interface ImportResult {
  readonly file: AiRulesFile;
  readonly imported: ReadonlyArray<string>;
  /** Rules (or parts of rules) that ZeroEffect cannot represent and therefore left out. */
  readonly skipped: ReadonlyArray<RulesProblem>;
}

/**
 * Converts an Inbox Zero rules export (an array of rules) into a ZeroEffect rules file.
 * Rules using features ZeroEffect does not support are skipped rather than silently weakened.
 */
export const importInboxZeroRules = (exported: unknown, llmEndpointId: string | null): ImportResult => {
  if (!Array.isArray(exported)) throw new Error("An Inbox Zero export is a JSON array of rules.");
  const rules: AiRule[] = [];
  const skipped: RulesProblem[] = [];
  for (const [index, raw] of exported.entries()) {
    const source = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    const name = typeof source.name === "string" ? source.name : `Rule #${index + 1}`;
    const issues: string[] = [];
    if (source.categoryFilterType !== null && source.categoryFilterType !== undefined) {
      issues.push("Sender category filters (categoryFilterType) are not supported.");
    }
    const actions = Array.isArray(source.actions) ? source.actions : [];
    const converted = actions.flatMap((rawAction) => {
      const action = (typeof rawAction === "object" && rawAction !== null ? rawAction : {}) as Record<string, unknown>;
      if (!RULE_ACTION_TYPES.some((type) => type === action.type)) {
        issues.push(`Action ${String(action.type)} is not supported (only ${RULE_ACTION_TYPES.join(", ")}).`);
        return [];
      }
      const extras = UNSUPPORTED_ACTION_FIELDS.filter((field) => action[field] !== null && action[field] !== undefined);
      if (extras.length > 0) issues.push(`${String(action.type)} action uses unsupported fields: ${extras.join(", ")}.`);
      return [action.type === "LABEL" ? { type: "LABEL" as const, label: typeof action.label === "string" ? action.label : null } : { type: action.type as "ARCHIVE" | "MARK_READ" }];
    });
    const candidate = {
      name,
      instructions: typeof source.instructions === "string" ? source.instructions : "",
      enabled: source.enabled !== false,
      automate: source.automate !== false,
      runOnThreads: source.runOnThreads === true,
      systemType: typeof source.systemType === "string" ? source.systemType : null,
      conditionalOperator: source.conditionalOperator === "OR" ? "OR" as const : "AND" as const,
      from: typeof source.from === "string" ? source.from : null,
      to: typeof source.to === "string" ? source.to : null,
      subject: typeof source.subject === "string" ? source.subject : null,
      body: typeof source.body === "string" ? source.body : null,
      actions: converted,
    } satisfies AiRule;
    issues.push(...ruleProblems(candidate));
    if (rules.some((rule) => rule.name.toLowerCase() === name.toLowerCase())) issues.push("Another rule already uses this name.");
    if (issues.length > 0) skipped.push(...issues.map((message) => ({ rule: name, message })));
    else rules.push(candidate);
  }
  return { file: { version: 1, llmEndpointId, rules }, imported: rules.map((rule) => rule.name), skipped };
};

/**
 * Applies Gmail label renames (keyed by lower-cased old name) to LABEL actions and precondition
 * DSL. Works on the raw JSON so invalid rules are preserved untouched; returns null when unchanged.
 */
export const renameLabelsInRulesFile = (text: string, renames: ReadonlyMap<string, string>): string | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { rules?: unknown }).rules)) return null;
  let changed = false;
  const rules = (parsed as { rules: unknown[] }).rules.map((rawRule) => {
    if (typeof rawRule !== "object" || rawRule === null) return rawRule;
    const rule = { ...(rawRule as Record<string, unknown>) };
    if (Array.isArray(rule.actions)) {
      rule.actions = rule.actions.map((rawAction) => {
        const action = rawAction as Record<string, unknown> | null;
        const renamed = typeof action?.label === "string" ? renames.get(action.label.toLowerCase()) : undefined;
        if (!renamed) return rawAction;
        changed = true;
        return { ...action, label: renamed };
      });
    }
    if (typeof rule.precondition === "string" && rule.precondition.trim()) {
      const precondition = parseFilterDsl(rule.precondition);
      if (precondition.ok) {
        const renamed = formatFilterExpr(renameFilterLabels(precondition.expression, renames));
        if (renamed !== formatFilterExpr(precondition.expression)) {
          rule.precondition = renamed;
          changed = true;
        }
      }
    }
    return rule;
  });
  return changed ? JSON.stringify({ ...(parsed as object), rules }, null, 2) + "\n" : null;
};
