import { Context, Effect, Layer } from "effect";
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

const retryDelay = (retryAfter: string | null, attempt: number): number => {
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    const requestedDelay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(requestedDelay) && requestedDelay >= 0) return Math.min(requestedDelay, 5_000);
  }
  return Math.min(250 * 2 ** attempt, 2_000);
};

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const makeClient = (config: GmailClientConfig): GmailClientService => {
  const apiBaseUrl = (config.apiBaseUrl ?? "https://gmail.googleapis.com/gmail/v1").replace(/\/$/, "");
  const fetcher = config.fetch ?? globalThis.fetch;
  const request = <A>(path: string, query: Record<string, string | number | ReadonlyArray<string> | undefined> = {}, body?: unknown): Effect.Effect<A, GmailApiError> =>
    Effect.tryPromise({
      try: async () => {
        const url = new URL(`${apiBaseUrl}${path}`);
        for (const [key, value] of Object.entries(query)) {
          if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, item);
          else if (value !== undefined) url.searchParams.set(key, String(value));
        }
        const method = body === undefined ? "GET" : "POST";
        const operation = describeOperation(method, path);
        for (let attempt = 0; ; attempt++) {
          const response = await fetcher(url, {
            method,
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
            const error = new GmailApiError({
              message: `Gmail API returned HTTP ${response.status}${details.reason ? ` (${details.reason})` : ""}.`,
              status: response.status,
              retryable: response.status === 408 || response.status === 429 || response.status >= 500 || rateLimited,
              ...details,
              operation,
            });
            // Gmail documents these 403 reasons as quota/rate-limit responses that
            // should use exponential backoff. Other 403s need different fixes and
            // must not be retried as though they were transient.
            if (rateLimited && attempt < 3) {
              await delay(retryDelay(response.headers.get("Retry-After"), attempt));
              continue;
            }
            throw error;
          }
          try {
            return (responseBody ? JSON.parse(responseBody) : {}) as A;
          } catch {
            throw new GmailApiError({ message: "Gmail API returned invalid JSON.", status: response.status, retryable: false, operation });
          }
        }
      },
      catch: (cause) => cause instanceof GmailApiError
        ? cause
        : new GmailApiError({ message: `Gmail API request failed: ${String(cause)}`, status: 0, retryable: true }),
    });

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
