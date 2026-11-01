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

export interface GmailLabel {
  readonly id: string;
  readonly name: string;
  readonly type?: string;
  readonly color?: { readonly backgroundColor?: string; readonly textColor?: string };
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
  readonly listLabels: () => Effect.Effect<ReadonlyArray<GmailLabel>, GmailApiError>;
  /** `color` must come from Gmail's label palette (see GmailLabels.labelColorFor). */
  readonly createLabel: (name: string, color?: { readonly backgroundColor: string; readonly textColor: string }) => Effect.Effect<GmailLabel, GmailApiError>;
  readonly watch: (topicName: string) => Effect.Effect<GmailWatchResponse, GmailApiError>;
  /** Sends an RFC 2822 message; with `threadId` Gmail files it in that conversation. */
  readonly sendRaw: (raw: string, threadId?: string) => Effect.Effect<{ readonly id: string; readonly threadId: string }, GmailApiError>;
  readonly modifyMessage: (id: string, addLabelIds: ReadonlyArray<string>, removeLabelIds: ReadonlyArray<string>) => Effect.Effect<void, GmailApiError>;
  /** Applies label changes to every message in a thread with one request. */
  readonly modifyThread: (id: string, addLabelIds: ReadonlyArray<string>, removeLabelIds: ReadonlyArray<string>) => Effect.Effect<void, GmailApiError>;
  /** Applies label changes to up to 1000 messages with one request (bulk actions). */
  readonly batchModify: (ids: ReadonlyArray<string>, addLabelIds: ReadonlyArray<string>, removeLabelIds: ReadonlyArray<string>) => Effect.Effect<void, GmailApiError>;
  /** An attachment's bytes, base64url-encoded as Gmail returns them. */
  readonly getAttachment: (messageId: string, attachmentId: string) => Effect.Effect<{ readonly data: string; readonly size?: number }, GmailApiError>;
  /**
   * Sends an RFC 2822 message through Gmail's upload endpoint, which accepts messages up to 35 MB
   * (the JSON `raw` form is limited to a few MB, too small for attachments).
   */
  readonly sendMime: (mime: Uint8Array, threadId?: string) => Effect.Effect<{ readonly id: string; readonly threadId: string }, GmailApiError>;
  readonly renameLabel: (id: string, name: string) => Effect.Effect<GmailLabel, GmailApiError>;
  readonly deleteLabel: (id: string) => Effect.Effect<void, GmailApiError>;
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

interface RequestOptions {
  readonly method?: "GET" | "POST" | "PATCH" | "DELETE";
  /** A pre-encoded body sent as is (e.g. multipart uploads), instead of JSON. */
  readonly rawBody?: { readonly contentType: string; readonly bytes: Uint8Array };
  /** Gmail's upload endpoint (…/upload/gmail/v1) instead of the regular API base. */
  readonly upload?: boolean;
}

const describeOperation = (method: string, path: string): string =>
  `${method} ${path.replace(/\/threads\/[^/]+/g, "/threads/{threadId}").replace(/\/messages\/(?!batchModify|send)[^/]+/g, "/messages/{messageId}").replace(/\/attachments\/[^/]+/g, "/attachments/{attachmentId}")}`;

const makeClient = (config: GmailClientConfig): GmailClientService => {
  const apiBaseUrl = (config.apiBaseUrl ?? "https://gmail.googleapis.com/gmail/v1").replace(/\/$/, "");
  // https://gmail.googleapis.com/gmail/v1 -> https://gmail.googleapis.com/upload/gmail/v1
  const uploadBaseUrl = apiBaseUrl.replace(/\/gmail\/v1$/, "/upload/gmail/v1");
  const fetcher = config.fetch ?? globalThis.fetch;
  const request = <A>(
    path: string,
    query: Record<string, string | number | ReadonlyArray<string> | undefined> = {},
    body?: unknown,
    options: RequestOptions = {},
  ): Effect.Effect<A, GmailApiError> => {
    const method = options.method ?? (body === undefined && !options.rawBody ? "GET" : "POST");
    const operation = describeOperation(method, path);
    const requestOnce = Effect.tryPromise({
      try: async () => {
        const url = new URL(`${options.upload ? uploadBaseUrl : apiBaseUrl}${path}`);
        for (const [key, value] of Object.entries(query)) {
          if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, item);
          else if (value !== undefined) url.searchParams.set(key, String(value));
        }
        const contentType = options.rawBody?.contentType ?? (body === undefined ? undefined : "application/json");
        const response = await fetcher(url, {
          method,
          headers: {
            Authorization: `Bearer ${config.accessToken}`,
            ...(contentType ? { "Content-Type": contentType } : {}),
          },
          ...(options.rawBody ? { body: options.rawBody.bytes as Uint8Array<ArrayBuffer> } : body === undefined ? {} : { body: JSON.stringify(body) }),
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

    // Retry transient failures and rate-limited 403s, as identified by the typed
    // error. Permission and other permanent failures are marked non-retryable.
    return Effect.retry(requestOnce, {
      schedule: Schedule.exponential("250 millis").pipe(Schedule.upTo({ times: 5 })),
      while: (error) => error.retryable,
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
    listLabels: () => request<{ labels?: ReadonlyArray<GmailLabel> }>("/users/me/labels").pipe(
      Effect.map((result) => result.labels ?? []),
    ),
    createLabel: (name, color) => request("/users/me/labels", {}, {
      name,
      labelListVisibility: "labelShow",
      messageListVisibility: "show",
      ...(color ? { color } : {}),
    }),
    watch: (topicName) => request("/users/me/watch", {}, { topicName }),
    sendRaw: (raw, threadId) => request("/users/me/messages/send", {}, { raw, ...(threadId ? { threadId } : {}) }),
    modifyMessage: (id, addLabelIds, removeLabelIds) => request(
      `/users/me/messages/${encodeURIComponent(id)}/modify`,
      {},
      { addLabelIds, removeLabelIds },
    ).pipe(Effect.asVoid),
    modifyThread: (id, addLabelIds, removeLabelIds) => request(
      `/users/me/threads/${encodeURIComponent(id)}/modify`,
      {},
      { addLabelIds, removeLabelIds },
    ).pipe(Effect.asVoid),
    batchModify: (ids, addLabelIds, removeLabelIds) => request(
      "/users/me/messages/batchModify",
      {},
      { ids, addLabelIds, removeLabelIds },
    ).pipe(Effect.asVoid),
    getAttachment: (messageId, attachmentId) => request(
      `/users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
    ),
    sendMime: (mime, threadId) => {
      // Multipart upload: JSON metadata (the thread) followed by the message itself.
      const boundary = `zeroeffect_upload_${crypto.randomUUID().replaceAll("-", "")}`;
      const head = new TextEncoder().encode([
        `--${boundary}`,
        "Content-Type: application/json; charset=UTF-8",
        "",
        JSON.stringify(threadId ? { threadId } : {}),
        `--${boundary}`,
        "Content-Type: message/rfc822",
        "",
        "",
      ].join("\r\n"));
      const tail = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
      const bytes = new Uint8Array(head.byteLength + mime.byteLength + tail.byteLength);
      bytes.set(head, 0);
      bytes.set(mime, head.byteLength);
      bytes.set(tail, head.byteLength + mime.byteLength);
      return request("/users/me/messages/send", { uploadType: "multipart" }, undefined, {
        upload: true,
        rawBody: { contentType: `multipart/related; boundary=${boundary}`, bytes },
      });
    },
    renameLabel: (id, name) => request(`/users/me/labels/${encodeURIComponent(id)}`, {}, { name }, { method: "PATCH" }),
    deleteLabel: (id) => request(`/users/me/labels/${encodeURIComponent(id)}`, {}, undefined, { method: "DELETE" }).pipe(Effect.asVoid),
  };
};
