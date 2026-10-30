import {
  LOCAL_REQUEST_HEADER,
  type AccountSummary,
  type ApiErrorBody,
  type LabelSummary,
  type SyncJobStatus,
  type ThreadAction,
  type ThreadDetail,
  type ThreadPage,
  type ThreadSummary,
  type ViewSummary,
} from "../shared/api";

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly offset?: number,
  ) {
    super(message);
  }
}

const request = async <A>(path: string, init: { readonly method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"; readonly body?: unknown } = {}): Promise<A> => {
  const method = init.method ?? "GET";
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: {
        Accept: "application/json",
        ...(method === "GET" ? {} : { "Content-Type": "application/json", [LOCAL_REQUEST_HEADER]: "1" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch {
    throw new ApiRequestError("Could not reach the ZeroEffect server.", 0);
  }
  const body = await response.json().catch(() => null) as (A & Partial<ApiErrorBody>) | null;
  if (!response.ok) throw new ApiRequestError(body?.error ?? `Request failed with HTTP ${response.status}.`, response.status, body?.offset);
  return body as A;
};

const accountPath = (accountId: string, path: string) => `/api/a/${encodeURIComponent(accountId)}${path}`;

export const api = {
  accounts: () => request<{ accounts: ReadonlyArray<AccountSummary> }>("/api/accounts").then((body) => body.accounts),
  views: (accountId: string) => request<{ views: ReadonlyArray<ViewSummary> }>(accountPath(accountId, "/views")).then((body) => body.views),
  createView: (accountId: string, view: { readonly name: string; readonly dsl: string }) =>
    request<{ view: ViewSummary }>(accountPath(accountId, "/views"), { method: "POST", body: view }).then((body) => body.view),
  updateView: (accountId: string, viewId: string, update: { readonly name?: string; readonly dsl?: string }) =>
    request<{ view: ViewSummary }>(accountPath(accountId, `/views/${encodeURIComponent(viewId)}`), { method: "PATCH", body: update })
      .then((body) => body.view),
  deleteView: (accountId: string, viewId: string) =>
    request<unknown>(accountPath(accountId, `/views/${encodeURIComponent(viewId)}`), { method: "DELETE" }),
  reorderViews: (accountId: string, ids: ReadonlyArray<string>) =>
    request<{ views: ReadonlyArray<ViewSummary> }>(accountPath(accountId, "/views/order"), { method: "PUT", body: { ids } })
      .then((body) => body.views),
  labels: (accountId: string) => request<{ labels: ReadonlyArray<LabelSummary> }>(accountPath(accountId, "/labels")).then((body) => body.labels),
  threads: (accountId: string, options: { readonly view: string; readonly q?: string; readonly limit: number; readonly offset?: number }) => {
    const params = new URLSearchParams({ view: options.view, limit: String(options.limit), offset: String(options.offset ?? 0) });
    if (options.q) params.set("q", options.q);
    return request<ThreadPage>(accountPath(accountId, `/threads?${params}`));
  },
  thread: (accountId: string, threadId: string) =>
    request<{ thread: ThreadDetail }>(accountPath(accountId, `/threads/${encodeURIComponent(threadId)}`)).then((body) => body.thread),
  threadAction: (accountId: string, threadId: string, action: ThreadAction) =>
    request<{ thread: ThreadSummary }>(accountPath(accountId, `/threads/${encodeURIComponent(threadId)}/actions`), { method: "POST", body: action })
      .then((body) => body.thread),
  syncStatus: (accountId: string) =>
    request<{ job: { readonly status: SyncJobStatus; readonly error?: string } | null }>(`/api/accounts/${encodeURIComponent(accountId)}/sync`)
      .then((body) => body.job),
  sync: (accountId: string) => request<unknown>(`/api/accounts/${encodeURIComponent(accountId)}/sync`, { method: "POST", body: {} }),
  eventsUrl: (accountId: string) => accountPath(accountId, "/events"),
};
