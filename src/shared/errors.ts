import { Data } from "effect";

export class AccountIsolationError extends Data.TaggedError("AccountIsolationError")<{
  readonly accountId: string;
  readonly reason: string;
}> {}

export class FilterParseError extends Data.TaggedError("FilterParseError")<{
  readonly input: string;
  readonly message: string;
  readonly offset: number;
}> {}

export class GmailApiError extends Data.TaggedError("GmailApiError")<{
  readonly message: string;
  readonly status: number;
  readonly retryable: boolean;
}> {}

export class LlmEndpointError extends Data.TaggedError("LlmEndpointError")<{
  readonly message: string;
  readonly apiMode: "responses" | "chat_completions";
  readonly rawBody: string;
}> {}

export class SendAsComposeError extends Data.TaggedError("SendAsComposeError")<{
  readonly message: string;
}> {}

export class RedisQueueError extends Data.TaggedError("RedisQueueError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class DatabaseError extends Data.TaggedError("DatabaseError")<{
  readonly message: string;
  readonly operation: string;
  readonly cause?: unknown;
}> {}
