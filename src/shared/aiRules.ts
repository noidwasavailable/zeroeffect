// AI labelling rules as stored per account in `data/accounts/<accountId>.rules.json`.
// Rules use Inbox Zero's export shape (name, instructions, automate, runOnThreads, systemType,
// static conditions, actions) so exports can be imported and the file stays easy to hand-edit.

/** Mutually exclusive "where does this conversation stand" rules, resolved together. */
export const CONVERSATION_STATUSES = ["TO_REPLY", "AWAITING_REPLY", "FYI", "ACTIONED"] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

export const isConversationStatus = (value: string | null | undefined): value is ConversationStatus =>
  CONVERSATION_STATUSES.some((status) => status === value);

export const RULE_ACTION_TYPES = ["LABEL", "ARCHIVE", "MARK_READ"] as const;
export type RuleActionType = (typeof RULE_ACTION_TYPES)[number];

export interface RuleAction {
  readonly type: RuleActionType;
  /** Required for LABEL. */
  readonly label?: string | null;
}

export interface AiRule {
  /** Unique (case-insensitive) within the file; also the name the LLM chooses. */
  readonly name: string;
  /** Plain-English description of the emails this rule is for. */
  readonly instructions: string;
  readonly enabled: boolean;
  /** false: suggest the rule's labels as ghost labels for approval instead of applying them. */
  readonly automate: boolean;
  /** false: only classify a conversation's first message; later messages inherit the result for free. */
  readonly runOnThreads: boolean;
  /** Inbox Zero system rule type, e.g. TO_REPLY or NEWSLETTER (null for custom rules). */
  readonly systemType: string | null;
  /** How static conditions combine with `instructions`: AND = both must match, OR = either. */
  readonly conditionalOperator: "AND" | "OR";
  /** Static conditions: case-insensitive substrings; `|` separates alternatives. */
  readonly from: string | null;
  readonly to: string | null;
  readonly subject: string | null;
  readonly body: string | null;
  /** ZeroEffect extension: Boolean filter DSL the thread must match before the rule is considered. */
  readonly precondition?: string | null;
  readonly actions: ReadonlyArray<RuleAction>;
}

export interface AiRulesFile {
  readonly version: 1;
  /** Registry id of the LLM endpoint used for this account's rules. */
  readonly llmEndpointId: string | null;
  /** Overrides the endpoint's API mode for this account. */
  readonly apiMode?: "responses" | "chat_completions" | null;
  readonly rules: ReadonlyArray<AiRule>;
}

export const EMPTY_RULES_FILE: AiRulesFile = { version: 1, llmEndpointId: null, rules: [] };
