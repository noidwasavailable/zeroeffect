import { Context, Effect, Layer, Schedule } from "effect";
import { GmailApiError } from "../../shared/errors";
import type { GmailMimePart } from "./MimeParser";

export interface GmailMessage {
  readonly id: string;
  readonly threadId: string;
  readonly snippet?: string;
  readonly internalDate?: string;
  readonly labelIds?: ReadonlyArray<string>;
  readonly payload?: GmailMimePart & {
    readonly headers?: ReadonlyArray<{ readonly name?: string | null; readonly value?: string | null }>;
  };
}

export interface GmailProfile {
  readonly emailAddress: string;
  readonly historyId: string;
}

export interface GmailThread {
  readonly id: string;
  readonly messages: ReadonlyArray<GmailMessage>;
}

export interface GmailHistoryPage {
  readonly history?: ReadonlyArray<{
    readonly id: string;
    readonly messagesAdded?: ReadonlyArray<{ readonly message?: { readonly id?: string } }>;
    readonly messagesDeleted?: ReadonlyArray<{ readonly message?: { readonly id?: string } }>;
    readonly labelsAdded?: ReadonlyArray<{ readonly message?: { readonly id?: string } }>;
    readonly labelsRemoved?: ReadonlyArray<{ readonly message?: { readonly id?: string } }>;
  }>;
  readonly nextPageToken?: string;
  readonly historyId?: string;
}

export interface GmailWatchResponse {
  readonly historyId: string;
  readonly expiration: string;
}

export interface GmailSendAs {
  readonly sendAsEmail: string;
  readonly displayName?: string;
  readonly replyToAddress?: string;
  readonly signature?: string;
  readonly isPrimary?: boolean;
  readonly isDefault?: boolean;
  readonly verificationStatus?: string;
}

export interface GmailClientService {
  readonly getProfile: () => Effect.Effect<GmailProfile, GmailApiError>;
  readonly listMessages: (pageToken?: string) => Effect.Effect<{
    readonly messages: ReadonlyArray<{ readonly id: string; readonly threadId?: string }>;
    readonly nextPageToken?: string;
  }, GmailApiError>;
  readonly getMessage: (id: string) => Effect.Effect<GmailMessage, GmailApiError>;
  readonly listThreads: (pageToken?: string, maxResults?: number) => Effect.Effect<{
    readonly threads: ReadonlyArray<{ readonly id: string }>;
    readonly nextPageToken?: string;
  }, GmailApiError>;
  readonly getThread: (id: string) => Effect.Effect<GmailThread, GmailApiError>;
  readonly listHistory: (startHistoryId: string, pageToken?: string) => Effect.Effect<GmailHistoryPage, GmailApiError>;
  readonly listSendAs: () => Effect.Effect<ReadonlyArray<GmailSendAs>, GmailApiError>;
  readonly watch: (topicName: string) => Effect.Effect<GmailWatchResponse, GmailApiError>;
  readonly sendRaw: (raw: string) => Effect.Effect<{ readonly id: string; readonly threadId: string }, GmailApiError>;
}

export class GmailClient extends Context.Service<GmailClient, GmailClientService>()(
  "zeroeffect/GmailClient",
) {}

export interface GmailClientConfig {
  readonly accessToken: string;
  readonly apiBaseUrl?: string;
  readonly fetch?: (input: URL, init?: RequestInit) => Promise<Response>;
}

export const GmailClientLive = (config: GmailClientConfig): Layer.Layer<GmailClient> =>
  Layer.succeed(GmailClient, makeClient(config));

export const GmailClientTest = GmailClientLive;

const safeIdentifier = (value: unknown): string | undefined =>
  typeof value === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(value) ? value : undefined;

const parseGoogleErrorDetails = (body: string): { readonly reason?: string; readonly apiStatus?: string } => {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null || !("error" in parsed)) return {};
    const error = parsed.error;
    if (typeof error !== "object" || error === null) return {};
    const errors = "errors" in error && Array.isArray(error.errors) ? error.errors : [];
    const firstError = errors.find((item: unknown) => typeof item === "object" && item !== null && "reason" in item);
    const reason = typeof firstError === "object" && firstError !== null && "reason" in firstError
      ? safeIdentifier(firstError.reason)
      : undefined;
    const apiStatus = "status" in error ? safeIdentifier(error.status) : undefined;
    return { ...(reason ? { reason } : {}), ...(apiStatus ? { apiStatus } : {}) };
  } catch {
    return {};
  }
};

const describeOperation = (method: string, path: string): string =>
  `${method} ${path.replace(/\/threads\/[^/]+/g, "/threads/{threadId}").replace(/\/messages\/[^/]+/g, "/messages/{messageId}")}`;

const makeClient = (config: GmailClientConfig): GmailClientService => {
  const apiBaseUrl = (config.apiBaseUrl ?? "https://gmail.googleapis.com/gmail/v1").replace(/\/$/, "");
  const fetcher = config.fetch ?? globalThis.fetch;
  const request = <A>(path: string, query: Record<string, string | number | ReadonlyArray<string> | undefined> = {}, body?: unknown): Effect.Effect<A, GmailApiError> => {
    const operation = describeOperation(body === undefined ? "GET" : "POST", path);
    const requestOnce = Effect.tryPromise({
      try: async () => {
        const url = new URL(`${apiBaseUrl}${path}`);
        for (const [key, value] of Object.entries(query)) {
          if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, item);
          else if (value !== undefined) url.searchParams.set(key, String(value));
        }
        const response = await fetcher(url, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            Authorization: `Bearer ${config.accessToken}`,
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const responseBody = await response.text();
        if (!response.ok) {
          const details = parseGoogleErrorDetails(responseBody);
          const rateLimited = response.status === 403
            && (details.reason === "rateLimitExceeded" || details.reason === "userRateLimitExceeded");
          throw new GmailApiError({
            message: `Gmail API returned HTTP ${response.status}${details.reason ? ` (${details.reason})` : ""}.`,
            status: response.status,
            retryable: response.status === 408 || response.status === 429 || response.status >= 500 || rateLimited,
            ...details,
            operation,
          });
        }
        try {
          return (responseBody ? JSON.parse(responseBody) : {}) as A;
        } catch {
          throw new GmailApiError({ message: "Gmail API returned invalid JSON.", status: response.status, retryable: false, operation });
        }
      },
      catch: (cause) => cause instanceof GmailApiError
        ? cause
        : new GmailApiError({ message: "Gmail API request failed.", status: 0, retryable: true, operation }),
    });

    // Rate-limit responses (including quota-related 403s) are the documented
    // exception to non-retryable Gmail errors. Retry a bounded number of times
    // using Effect's exponential schedule; permission and other 403s fail fast.
    return Effect.retry(requestOnce, {
      schedule: Schedule.exponential("250 millis").pipe(Schedule.upTo({ times: 5 })),
      while: (error) => error.status === 429 || (
        error.status === 403
        && (error.reason === "rateLimitExceeded" || error.reason === "userRateLimitExceeded")
      ),
    });
  };

  return {
    getProfile: () => request("/users/me/profile"),
    listMessages: (pageToken) => request("/users/me/messages", { maxResults: 100, pageToken }),
    getMessage: (id) => request(`/users/me/messages/${encodeURIComponent(id)}`, { format: "full" }),
    listThreads: (pageToken, maxResults = 100) => request("/users/me/threads", { maxResults, pageToken }),
    getThread: (id) => request(`/users/me/threads/${encodeURIComponent(id)}`, { format: "full" }),
    listHistory: (startHistoryId, pageToken) => request("/users/me/history", {
      startHistoryId,
      pageToken,
      maxResults: 100,
      historyTypes: ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"],
    }),
    listSendAs: () => request<{ sendAs?: ReadonlyArray<GmailSendAs> }>("/users/me/settings/sendAs").pipe(
      Effect.map((result) => result.sendAs ?? []),
    ),
    watch: (topicName) => request("/users/me/watch", {}, { topicName }),
    sendRaw: (raw) => request("/users/me/messages/send", {}, { raw }),
  };
};
