import { useEffect, useState } from "react";
import type { AiRulesFile, LlmApiMode, OpenAiApiMode } from "../../shared/aiRules";
import type { AppSettings, LlmEndpointSummary, RulesResponse } from "../../shared/api";
import type { AppAction } from "../actions";
import { api } from "../api";
import { noAutofill } from "../noAutofill";
import { toolbarButtonClass } from "./ActionToolbar";

const inputClass = "w-full rounded border border-zinc-200 bg-transparent px-2 py-1.5 text-sm outline-none focus:border-zinc-400 disabled:opacity-60 dark:border-zinc-700";
const labelClass = "flex flex-col gap-1 text-xs font-medium text-zinc-600 dark:text-zinc-400";
const sectionClass = "flex flex-col gap-3 border-b border-zinc-200 px-5 py-4 dark:border-zinc-800";

export const API_MODE_LABELS: Readonly<Record<LlmApiMode, string>> = {
  responses: "OpenAI Responses (/v1/responses)",
  chat_completions: "OpenAI-compatible Chat Completions (/v1/chat/completions)",
  anthropic_messages: "Anthropic Messages (/v1/messages)",
};

/** Starting points for a new endpoint; every field stays editable. */
const PRESETS: ReadonlyArray<{ readonly name: string; readonly baseUrl: string; readonly modelId: string; readonly apiMode: LlmApiMode }> = [
  { name: "Anthropic", baseUrl: "https://api.anthropic.com", modelId: "claude-haiku-5-5", apiMode: "anthropic_messages" },
  { name: "OpenAI", baseUrl: "https://api.openai.com/v1", modelId: "", apiMode: "responses" },
  { name: "OpenAI-compatible", baseUrl: "", modelId: "", apiMode: "chat_completions" },
];

interface EndpointDraft {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly modelId: string;
  readonly apiMode: LlmApiMode;
  readonly apiKey: string;
}

/** Adds an endpoint, or edits one (its id is fixed and an empty key keeps the stored one). */
function EndpointForm({ initial, editing, onSaved, onCancel }: {
  readonly initial: EndpointDraft;
  readonly editing: boolean;
  readonly onSaved: (endpoints: ReadonlyArray<LlmEndpointSummary>) => void;
  readonly onCancel: () => void;
}) {
  const [form, setForm] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const field = (key: "id" | "name" | "baseUrl" | "modelId" | "apiKey", label: string, options: { readonly type?: string; readonly disabled?: boolean; readonly placeholder?: string } = {}) => (
    <label className={labelClass}>
      {label}
      <input
        {...noAutofill}
        className={inputClass}
        type={options.type ?? "text"}
        disabled={options.disabled}
        placeholder={options.placeholder}
        value={form[key]}
        onChange={(event) => setForm({ ...form, [key]: event.target.value })}
      />
    </label>
  );
  return (
    <form
      className="flex flex-col gap-3 rounded-md border border-zinc-200 p-3 dark:border-zinc-800"
      onSubmit={async (event) => {
        event.preventDefault();
        setSaving(true);
        try {
          onSaved(await api.saveLlmEndpoint(form));
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "Could not save the endpoint.");
        } finally {
          setSaving(false);
        }
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {field("id", "Id (letters, digits, - or _)", { disabled: editing })}
        {field("name", "Display name")}
        <label className={labelClass}>
          API
          <select className={inputClass} value={form.apiMode} onChange={(event) => setForm({ ...form, apiMode: event.target.value as LlmApiMode })}>
            {(Object.keys(API_MODE_LABELS) as LlmApiMode[]).map((mode) => <option key={mode} value={mode}>{API_MODE_LABELS[mode]}</option>)}
          </select>
        </label>
        {field("baseUrl", form.apiMode === "anthropic_messages" ? "Base URL" : "Base URL (ending in /v1)", { placeholder: "https://…" })}
        {field("modelId", "Model")}
        {field("apiKey", editing ? "API key (leave empty to keep the stored key)" : "API key (stored encrypted)", { type: "password" })}
      </div>
      {error && <p role="alert" className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" className={toolbarButtonClass} disabled={saving}>{saving ? "Saving…" : editing ? "Save changes" : "Add endpoint"}</button>
        <button type="button" className={toolbarButtonClass} onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

interface Chain {
  readonly primary: string | null;
  readonly fallbacks: ReadonlyArray<string>;
  readonly apiMode: OpenAiApiMode | null;
}

const chainOf = (rules: AiRulesFile): Chain => ({
  primary: rules.llmEndpointId,
  fallbacks: rules.fallbackLlmEndpointIds ?? [],
  apiMode: rules.apiMode ?? null,
});

/**
 * App settings, the LLM endpoints both accounts share, and which of them (in what order) this
 * account's AI rules use.
 */
export function SettingsPage({ accountId, accountName, settings, actions, onClose, onRulesSaved }: {
  readonly accountId: string;
  readonly accountName: string;
  readonly settings: AppSettings;
  readonly actions: ReadonlyArray<AppAction>;
  readonly onClose: () => void;
  readonly onRulesSaved: (rules: AiRulesFile) => void;
}) {
  const [endpoints, setEndpoints] = useState<ReadonlyArray<LlmEndpointSummary> | null>(null);
  const [rules, setRules] = useState<RulesResponse | null>(null);
  const [chain, setChain] = useState<Chain | null>(null);
  const [form, setForm] = useState<{ readonly initial: EndpointDraft; readonly editing: boolean } | null>(null);
  const [message, setMessage] = useState<{ readonly text: string; readonly tone: "info" | "error" } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([api.llmEndpoints(), api.rules(accountId)]).then(([list, loaded]) => {
      setEndpoints(list);
      setRules(loaded);
      setChain(chainOf(loaded.rules));
    }, (error) => setMessage({ text: error instanceof Error ? error.message : "Could not load settings.", tone: "error" }));
  }, [accountId]);

  const dirty = rules !== null && chain !== null && JSON.stringify(chain) !== JSON.stringify(chainOf(rules.rules));
  const close = () => {
    if (!dirty || confirm("Discard the unsaved AI provider changes?")) onClose();
  };

  const byId = new Map((endpoints ?? []).map((endpoint) => [endpoint.id, endpoint]));
  const describe = (id: string) => {
    const endpoint = byId.get(id);
    return endpoint ? `${endpoint.name} · ${endpoint.modelId}` : `${id} (deleted)`;
  };
  const primaryEndpoint = chain?.primary ? byId.get(chain.primary) : undefined;
  const unused = (endpoints ?? []).filter((endpoint) => endpoint.id !== chain?.primary && !chain?.fallbacks.includes(endpoint.id));
  const markRead = actions.find((action) => action.id === "settings.markReadOnArchive");

  const moveFallback = (index: number, delta: -1 | 1) => {
    if (!chain) return;
    const next = [...chain.fallbacks];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    setChain({ ...chain, fallbacks: next });
  };

  const saveChain = async () => {
    if (!chain) return;
    setSaving(true);
    try {
      const saved = await api.saveRulesProviders(accountId, {
        llmEndpointId: chain.primary,
        fallbackLlmEndpointIds: chain.primary ? chain.fallbacks : [],
        apiMode: primaryEndpoint?.apiMode === "anthropic_messages" ? null : chain.apiMode,
      });
      setRules(saved);
      setChain(chainOf(saved.rules));
      onRulesSaved(saved.rules);
      setMessage({ text: `Saved ${accountName}'s AI providers.`, tone: "info" });
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : "Could not save.", tone: "error" });
    } finally {
      setSaving(false);
    }
  };

  const deleteEndpoint = async (endpoint: LlmEndpointSummary) => {
    if (!confirm(`Delete the LLM endpoint “${endpoint.name}” and its stored key? Accounts that still list it skip it and use their next endpoint.`)) return;
    try {
      setEndpoints(await api.deleteLlmEndpoint(endpoint.id));
      setMessage({ text: `Deleted “${endpoint.name}”.`, tone: "info" });
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : "Could not delete the endpoint.", tone: "error" });
    }
  };

  return (
    <div className="fixed inset-0 z-30 flex items-stretch justify-center bg-black/30 p-0 sm:p-6" onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); close(); } }}>
      <section role="dialog" aria-modal="true" aria-label="Settings" className="flex w-full max-w-3xl flex-col overflow-hidden bg-white shadow-2xl sm:rounded-xl dark:bg-zinc-950">
        <header className="flex items-center gap-3 border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
          <h2 className="font-semibold">Settings</h2>
          <button type="button" className={`${toolbarButtonClass} ml-auto`} onClick={close}>Close</button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <section aria-labelledby="settings-general" className={sectionClass}>
            <h3 id="settings-general" className="text-sm font-semibold">General</h3>
            {markRead && (
              <button
                type="button"
                role="switch"
                aria-checked={settings.markReadOnArchive}
                onClick={markRead.run}
                className="flex items-start justify-between gap-4 rounded-md px-1 py-1 text-left text-sm hover:bg-zinc-50 dark:hover:bg-zinc-900"
              >
                <span className="flex flex-col">
                  Mark conversations read when archiving or moving to Trash
                  <span className="text-xs text-zinc-500">Keeps archived mail from showing as unread elsewhere, e.g. GitHub notifications. Applies to both accounts.</span>
                </span>
                <span className={`mt-0.5 shrink-0 rounded px-1.5 text-xs font-medium ${settings.markReadOnArchive ? "bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300" : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800"}`}>
                  {settings.markReadOnArchive ? "On" : "Off"}
                </span>
              </button>
            )}
          </section>

          <section aria-labelledby="settings-endpoints" className={sectionClass}>
            <div className="flex items-center gap-2">
              <h3 id="settings-endpoints" className="text-sm font-semibold">LLM endpoints</h3>
              <span className="text-xs text-zinc-500">Shared by both accounts; keys are stored encrypted and never sent back.</span>
            </div>
            {endpoints === null
              ? <p className="text-sm text-zinc-500">Loading…</p>
              : endpoints.length === 0
                ? <p className="text-sm text-zinc-500">No endpoints yet. Add one to run AI rules.</p>
                : (
                  <ul className="flex flex-col divide-y divide-zinc-200 rounded-md border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
                    {endpoints.map((endpoint) => (
                      <li key={endpoint.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate font-medium">{endpoint.name} <span className="font-normal text-zinc-500">· {endpoint.modelId}</span></span>
                          <span className="truncate text-xs text-zinc-500">{API_MODE_LABELS[endpoint.apiMode]} · {endpoint.baseUrl}</span>
                        </span>
                        <button type="button" className={toolbarButtonClass} onClick={() => setForm({ editing: true, initial: { ...endpoint, apiKey: "" } })}>Edit</button>
                        <button type="button" className={toolbarButtonClass} onClick={() => void deleteEndpoint(endpoint)}>Delete</button>
                      </li>
                    ))}
                  </ul>
                )}
            {form
              ? (
                <EndpointForm
                  key={form.initial.id || form.initial.apiMode}
                  initial={form.initial}
                  editing={form.editing}
                  onCancel={() => setForm(null)}
                  onSaved={(list) => {
                    setEndpoints(list);
                    setForm(null);
                    setMessage({ text: "Endpoint saved.", tone: "info" });
                  }}
                />
              )
              : (
                <div className="flex flex-wrap gap-2">
                  {PRESETS.map((preset) => (
                    <button
                      key={preset.name}
                      type="button"
                      className={toolbarButtonClass}
                      onClick={() => setForm({ editing: false, initial: { id: preset.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), name: preset.name, baseUrl: preset.baseUrl, modelId: preset.modelId, apiMode: preset.apiMode, apiKey: "" } })}
                    >
                      + {preset.name}
                    </button>
                  ))}
                </div>
              )}
          </section>

          <section aria-labelledby="settings-chain" className={sectionClass}>
            <div className="flex items-center gap-2">
              <h3 id="settings-chain" className="text-sm font-semibold">AI rules provider · {accountName}</h3>
              <span className="text-xs text-zinc-500">data/accounts/{accountId}.rules.json</span>
            </div>
            {!chain || !endpoints
              ? <p className="text-sm text-zinc-500">Loading…</p>
              : (
                <>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className={labelClass}>
                      Primary endpoint
                      <select
                        className={inputClass}
                        value={chain.primary ?? ""}
                        onChange={(event) => {
                          const primary = event.target.value || null;
                          setChain({ ...chain, primary, fallbacks: chain.fallbacks.filter((id) => id !== primary) });
                        }}
                      >
                        <option value="">None (AI rules off)</option>
                        {chain.primary && !byId.has(chain.primary) && <option value={chain.primary}>{describe(chain.primary)}</option>}
                        {endpoints.map((endpoint) => <option key={endpoint.id} value={endpoint.id}>{endpoint.name} · {endpoint.modelId}</option>)}
                      </select>
                    </label>
                    {primaryEndpoint && primaryEndpoint.apiMode !== "anthropic_messages" && (
                      <label className={labelClass}>
                        API for the primary endpoint
                        <select className={inputClass} value={chain.apiMode ?? ""} onChange={(event) => setChain({ ...chain, apiMode: (event.target.value || null) as OpenAiApiMode | null })}>
                          <option value="">Endpoint default ({API_MODE_LABELS[primaryEndpoint.apiMode]})</option>
                          <option value="responses">{API_MODE_LABELS.responses}</option>
                          <option value="chat_completions">{API_MODE_LABELS.chat_completions}</option>
                        </select>
                      </label>
                    )}
                  </div>
                  {chain.primary && (
                    <div className="flex flex-col gap-2">
                      <p className="text-xs text-zinc-500">
                        Fallbacks are tried in order when the endpoint before them fails: an HTTP or network error, a timeout, a refusal,
                        or an answer that stays invalid after one correction.
                      </p>
                      {chain.fallbacks.length > 0 && (
                        <ol className="flex flex-col gap-1">
                          {chain.fallbacks.map((id, index) => (
                            <li key={id} className="flex items-center gap-2 text-sm">
                              <span className="w-5 text-right text-xs text-zinc-500">{index + 1}.</span>
                              <span className={`min-w-0 flex-1 truncate ${byId.has(id) ? "" : "text-red-600 dark:text-red-400"}`}>{describe(id)}</span>
                              <button type="button" className={toolbarButtonClass} title="Try earlier" disabled={index === 0} onClick={() => moveFallback(index, -1)}>↑</button>
                              <button type="button" className={toolbarButtonClass} title="Try later" disabled={index === chain.fallbacks.length - 1} onClick={() => moveFallback(index, 1)}>↓</button>
                              <button type="button" className={toolbarButtonClass} onClick={() => setChain({ ...chain, fallbacks: chain.fallbacks.filter((other) => other !== id) })}>Remove</button>
                            </li>
                          ))}
                        </ol>
                      )}
                      {unused.length > 0 && (
                        <label className={`${labelClass} sm:w-1/2`}>
                          Add a fallback
                          <select className={inputClass} value="" onChange={(event) => { if (event.target.value) setChain({ ...chain, fallbacks: [...chain.fallbacks, event.target.value] }); }}>
                            <option value="">Choose an endpoint…</option>
                            {unused.map((endpoint) => <option key={endpoint.id} value={endpoint.id}>{endpoint.name} · {endpoint.modelId}</option>)}
                          </select>
                        </label>
                      )}
                    </div>
                  )}
                  <div>
                    <button type="button" className={toolbarButtonClass} disabled={!dirty || saving} onClick={() => void saveChain()}>
                      {saving ? "Saving…" : "Save AI providers"}
                    </button>
                  </div>
                </>
              )}
          </section>
        </div>
        {message && (
          <footer className="border-t border-zinc-200 px-5 py-2 dark:border-zinc-800">
            <p role={message.tone === "error" ? "alert" : "status"} className={`text-xs ${message.tone === "error" ? "text-red-600 dark:text-red-400" : "text-zinc-500"}`}>{message.text}</p>
          </footer>
        )}
      </section>
    </div>
  );
}
