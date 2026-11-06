import { useEffect, useRef, useState } from "react";
import { CONVERSATION_STATUSES, type AiRule, type AiRulesFile, type RuleAction } from "../../shared/aiRules";
import type { LlmEndpointSummary, RulesProblemSummary, RulesResponse } from "../../shared/api";
import { parseFilterDsl } from "../../shared/filterParser";
import { api, ApiRequestError } from "../api";
import { toolbarButtonClass } from "./ActionToolbar";

const inputClass = "w-full rounded border border-zinc-200 bg-transparent px-2 py-1.5 text-sm outline-none focus:border-zinc-400 dark:border-zinc-700";
const labelClass = "flex flex-col gap-1 text-xs font-medium text-zinc-600 dark:text-zinc-400";

const STATUS_NAMES: Record<string, string> = {
  TO_REPLY: "To reply", AWAITING_REPLY: "Awaiting reply", FYI: "FYI", ACTIONED: "Actioned",
};

/** New rules start as dry-run suggestions, so a first draft can never relabel mail on its own. */
const newRule = (existing: ReadonlyArray<AiRule>): AiRule => {
  let name = "New rule";
  for (let index = 2; existing.some((rule) => rule.name.toLowerCase() === name.toLowerCase()); index++) name = `New rule ${index}`;
  return {
    name, instructions: "", enabled: true, automate: false, runOnThreads: false, systemType: null, conditionalOperator: "AND",
    from: null, to: null, subject: null, body: null, actions: [{ type: "LABEL", label: "" }],
  };
};

const nullIfBlank = (value: string): string | null => value.trim() ? value : null;

/** Mirrors the server's checks so problems show while editing; the server re-validates on save. */
const ruleIssues = (rule: AiRule, rules: ReadonlyArray<AiRule>): string[] => {
  const issues: string[] = [];
  if (!rule.name.trim()) issues.push("Name the rule.");
  if (rules.filter((other) => other.name.trim().toLowerCase() === rule.name.trim().toLowerCase()).length > 1) issues.push("Another rule has this name.");
  if (!rule.instructions.trim() && !rule.from && !rule.to && !rule.subject && !rule.body) issues.push("Add instructions or a static condition.");
  const isStatus = CONVERSATION_STATUSES.some((status) => status === rule.systemType);
  if (rule.actions.length === 0 && !isStatus) issues.push("Add a label, archive or mark-read action.");
  if (rule.actions.some((action) => action.type === "LABEL" && !action.label?.trim())) issues.push("Label actions need a label name.");
  if (rule.precondition?.trim()) {
    const parsed = parseFilterDsl(rule.precondition);
    if (!parsed.ok) issues.push(`Precondition: ${parsed.message}`);
  }
  return issues;
};

function Toggle({ checked, label, hint, onChange }: { readonly checked: boolean; readonly label: string; readonly hint: string; readonly onChange: (checked: boolean) => void }) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" className="mt-1" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span className="flex flex-col">
        {label}
        <span className="text-xs text-zinc-500">{hint}</span>
      </span>
    </label>
  );
}

function RuleEditor({ rule, issues, onChange, onDelete }: {
  readonly rule: AiRule;
  readonly issues: ReadonlyArray<string>;
  readonly onChange: (rule: AiRule) => void;
  readonly onDelete: () => void;
}) {
  // Label names are edited as text ("A, B") and committed as LABEL actions.
  const [labelsText, setLabelsText] = useState(() => rule.actions.flatMap((action) => action.type === "LABEL" ? [action.label ?? ""] : []).join(", "));
  const archive = rule.actions.some((action) => action.type === "ARCHIVE");
  const markRead = rule.actions.some((action) => action.type === "MARK_READ");
  const setActions = (labels: string, nextArchive: boolean, nextMarkRead: boolean) => {
    const actions: RuleAction[] = [
      ...labels.split(",").map((label) => label.trim()).filter(Boolean).map((label) => ({ type: "LABEL" as const, label })),
      ...(nextArchive ? [{ type: "ARCHIVE" as const }] : []),
      ...(nextMarkRead ? [{ type: "MARK_READ" as const }] : []),
    ];
    onChange({ ...rule, actions });
  };
  const precondition = rule.precondition?.trim() ? parseFilterDsl(rule.precondition) : null;
  const knownSystemType = rule.systemType === null || CONVERSATION_STATUSES.some((status) => status === rule.systemType);

  return (
    <div className="flex flex-col gap-4">
      <label className={labelClass}>
        Name
        <input className={inputClass} value={rule.name} onChange={(event) => onChange({ ...rule, name: event.target.value })} />
      </label>
      <label className={labelClass}>
        Instructions for the AI
        <textarea className={inputClass} rows={4} value={rule.instructions} placeholder="Describe the emails this rule is for, in plain English."
          onChange={(event) => onChange({ ...rule, instructions: event.target.value })} />
      </label>
      <div className="grid gap-3 sm:grid-cols-3">
        <Toggle checked={rule.enabled} label="Enabled" hint="Disabled rules are never offered to the AI." onChange={(enabled) => onChange({ ...rule, enabled })} />
        <Toggle checked={rule.automate} label="Apply automatically" hint="Off = dry run: labels are suggested for Y / N." onChange={(automate) => onChange({ ...rule, automate })} />
        <Toggle checked={rule.runOnThreads} label="Re-check on replies" hint="Off = first message only; replies inherit the result for free." onChange={(runOnThreads) => onChange({ ...rule, runOnThreads })} />
      </div>
      <label className={labelClass}>
        Kind
        <select className={inputClass} value={rule.systemType ?? ""} onChange={(event) => onChange({ ...rule, systemType: event.target.value || null })}>
          <option value="">Category rule</option>
          {CONVERSATION_STATUSES.map((status) => <option key={status} value={status}>Conversation status: {STATUS_NAMES[status]}</option>)}
          {!knownSystemType && <option value={rule.systemType!}>Imported type: {rule.systemType}</option>}
        </select>
        <span className="font-normal text-zinc-500">Conversation statuses are mutually exclusive: a new status replaces the previous one.</span>
      </label>
      <fieldset className="flex flex-col gap-2 rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
        <legend className="px-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">Actions</legend>
        <label className={labelClass}>
          Labels (comma-separated; created in Gmail if missing)
          <input className={inputClass} value={labelsText} onChange={(event) => { setLabelsText(event.target.value); setActions(event.target.value, archive, markRead); }} />
        </label>
        <div className="flex gap-4 text-sm">
          <label className="flex items-center gap-2"><input type="checkbox" checked={archive} onChange={(event) => setActions(labelsText, event.target.checked, markRead)} /> Archive</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={markRead} onChange={(event) => setActions(labelsText, archive, event.target.checked)} /> Mark read</label>
        </div>
      </fieldset>
      <details className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800" open={Boolean(rule.precondition || rule.from || rule.to || rule.subject || rule.body)}>
        <summary className="cursor-pointer text-xs font-medium text-zinc-600 dark:text-zinc-400">Conditions (optional)</summary>
        <div className="mt-3 flex flex-col gap-3">
          <label className={labelClass}>
            Precondition (Boolean DSL; must match before the AI is asked)
            <input className={`${inputClass} font-mono`} spellCheck={false} value={rule.precondition ?? ""} placeholder="NOT label:Marketing"
              onChange={(event) => onChange({ ...rule, precondition: nullIfBlank(event.target.value) })} />
            {precondition && !precondition.ok && <span className="font-normal text-red-600 dark:text-red-400">{precondition.message} (at character {precondition.offset + 1})</span>}
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            {(["from", "to", "subject", "body"] as const).map((field) => (
              <label key={field} className={labelClass}>
                {field[0]!.toUpperCase() + field.slice(1)} contains
                <input className={inputClass} value={rule[field] ?? ""} placeholder="text | other text"
                  onChange={(event) => onChange({ ...rule, [field]: nullIfBlank(event.target.value) })} />
              </label>
            ))}
          </div>
          <label className={labelClass}>
            Static conditions and instructions
            <select className={inputClass} value={rule.conditionalOperator} onChange={(event) => onChange({ ...rule, conditionalOperator: event.target.value as "AND" | "OR" })}>
              <option value="AND">AND: conditions must match, then the AI decides</option>
              <option value="OR">OR: matching conditions apply the rule without the AI</option>
            </select>
          </label>
        </div>
      </details>
      {issues.length > 0 && (
        <ul role="alert" className="list-disc pl-5 text-xs text-red-600 dark:text-red-400">
          {issues.map((issue) => <li key={issue}>{issue}</li>)}
        </ul>
      )}
      <div>
        <button type="button" className={`${toolbarButtonClass} text-red-700 dark:text-red-400`} onClick={onDelete}>Delete rule</button>
      </div>
    </div>
  );
}

/** Edits one account's AI rules file (data/accounts/<account>.rules.json); its LLM endpoints are set in Settings. */
export function RulesPanel({ accountId, accountName, startWithNewRule, onClose, onSaved, onOpenSettings }: {
  readonly accountId: string;
  readonly accountName: string;
  readonly startWithNewRule: boolean;
  readonly onClose: () => void;
  readonly onSaved: (rules: AiRulesFile) => void;
  /** Closes the rules and opens Settings, where the account's LLM endpoints are chosen. */
  readonly onOpenSettings: () => void;
}) {
  const [loaded, setLoaded] = useState<RulesResponse | null>(null);
  const [draft, setDraft] = useState<AiRulesFile | null>(null);
  const [selected, setSelected] = useState(0);
  const [endpoints, setEndpoints] = useState<ReadonlyArray<LlmEndpointSummary>>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ readonly text: string; readonly tone: "info" | "error" } | null>(null);
  const [serverProblems, setServerProblems] = useState<ReadonlyArray<RulesProblemSummary>>([]);
  // Bumped when the rules are replaced wholesale (import), so editors reset their local text.
  const [version, setVersion] = useState(0);
  const importInput = useRef<HTMLInputElement>(null);
  const importMode = useRef<"replace" | "append">("replace");

  useEffect(() => {
    Promise.all([api.rules(accountId), api.llmEndpoints()]).then(([rules, list]) => {
      setLoaded(rules);
      setEndpoints(list);
      if (startWithNewRule) {
        setDraft({ ...rules.rules, rules: [...rules.rules.rules, newRule(rules.rules.rules)] });
        setSelected(rules.rules.rules.length);
        setDirty(true);
      } else {
        setDraft(rules.rules);
      }
    }, (error) => setMessage({ text: error instanceof Error ? error.message : "Could not load rules.", tone: "error" }));
  }, [accountId, startWithNewRule]);

  const update = (next: AiRulesFile) => {
    setDraft(next);
    setDirty(true);
    setServerProblems([]);
  };
  const close = () => {
    if (!dirty || confirm("Discard unsaved rule changes?")) onClose();
  };

  if (!draft || !loaded) {
    return (
      <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/30">
        <p className="rounded-lg bg-white p-4 text-sm dark:bg-zinc-950">{message?.text ?? "Loading rules…"}</p>
      </div>
    );
  }

  const endpointName = (id: string) => {
    const endpoint = endpoints.find((candidate) => candidate.id === id);
    return endpoint ? `${endpoint.name} · ${endpoint.modelId}` : `${id} (missing)`;
  };
  const rules = draft.rules;
  const current = rules[selected];
  const issuesByRule = rules.map((rule) => ruleIssues(rule, rules));
  const hasIssues = issuesByRule.some((issues) => issues.length > 0);
  const setRule = (index: number, rule: AiRule) => update({ ...draft, rules: rules.map((existing, position) => position === index ? rule : existing) });
  const move = (delta: -1 | 1) => {
    const target = selected + delta;
    if (target < 0 || target >= rules.length) return;
    const next = [...rules];
    [next[selected], next[target]] = [next[target]!, next[selected]!];
    update({ ...draft, rules: next });
    setSelected(target);
  };

  const save = async () => {
    if (loaded.problems.length > 0 && !confirm(`The rules file has ${loaded.problems.length} invalid rule problem(s). Saving rewrites the file without those rules. Continue?`)) return;
    setSaving(true);
    try {
      const saved = await api.saveRules(accountId, draft);
      setLoaded(saved);
      setDraft(saved.rules);
      setDirty(false);
      setMessage({ text: "Rules saved.", tone: "info" });
      onSaved(saved.rules);
    } catch (error) {
      if (error instanceof ApiRequestError && error.problems) setServerProblems(error.problems);
      setMessage({ text: error instanceof Error ? error.message : "Could not save the rules.", tone: "error" });
    } finally {
      setSaving(false);
    }
  };

  const startImport = (mode: "replace" | "append") => {
    if (dirty && !confirm("Importing saves straight to the rules file and discards unsaved edits. Continue?")) return;
    importMode.current = mode;
    importInput.current?.click();
  };

  return (
    <div className="fixed inset-0 z-30 flex items-stretch justify-center bg-black/30 p-0 sm:p-6" onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); close(); } }}>
      <section role="dialog" aria-modal="true" aria-label="AI rules" className="flex w-full max-w-5xl flex-col overflow-hidden bg-white shadow-2xl sm:rounded-xl dark:bg-zinc-950">
        <header className="flex flex-wrap items-center gap-3 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <h2 className="font-semibold">AI rules · {accountName}</h2>
          <span className="text-xs text-zinc-500">data/accounts/{accountId}.rules.json</span>
          <span className="ml-auto flex gap-2">
            <button type="button" className={toolbarButtonClass} onClick={() => startImport("append")}>Import (add new)…</button>
            <button type="button" className={toolbarButtonClass} onClick={() => startImport("replace")}>Import (replace)…</button>
            <input
              ref={importInput}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={async (event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file) return;
                try {
                  const result = await api.importRules(accountId, JSON.parse(await file.text()), importMode.current);
                  setLoaded(result);
                  setDraft(result.rules);
                  setSelected(0);
                  setVersion((value) => value + 1);
                  setDirty(false);
                  onSaved(result.rules);
                  setMessage({
                    text: `Imported ${result.imported.length} rule(s).${result.skipped.length ? ` Skipped: ${result.skipped.map((problem) => `${problem.rule} (${problem.message})`).join("; ")}` : ""}`,
                    tone: result.skipped.length ? "error" : "info",
                  });
                } catch (error) {
                  setMessage({ text: error instanceof SyntaxError ? "That file is not valid JSON." : error instanceof Error ? error.message : "Import failed.", tone: "error" });
                }
              }}
            />
          </span>
        </header>

        <div className="flex flex-wrap items-center gap-3 border-b border-zinc-200 px-4 py-2 text-sm dark:border-zinc-800">
          <span className="text-zinc-600 dark:text-zinc-400">
            {draft.llmEndpointId
              ? <>AI provider: <span className="font-medium text-zinc-900 dark:text-zinc-100">{endpointName(draft.llmEndpointId)}</span>
                  {(draft.fallbackLlmEndpointIds?.length ?? 0) > 0 && <>, then {draft.fallbackLlmEndpointIds!.map(endpointName).join(", ")}</>}</>
              : "No LLM endpoint: rules with instructions do not run."}
          </span>
          <button
            type="button"
            className={toolbarButtonClass}
            onClick={() => { if (!dirty || confirm("Discard unsaved rule changes and open Settings?")) onOpenSettings(); }}
          >
            Choose in Settings…
          </button>
        </div>

        {(loaded.problems.length > 0 || serverProblems.length > 0) && (
          <div role="alert" className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
            {loaded.problems.length > 0 && <p className="font-medium">These rules in the file are invalid and do not run (fix them in the JSON file, or save here to drop them):</p>}
            <ul className="list-disc pl-5">
              {[...loaded.problems, ...serverProblems].map((problem, index) => <li key={index}>{problem.rule ?? "File"}: {problem.message}</li>)}
            </ul>
          </div>
        )}

        <div className="flex min-h-0 flex-1">
          <nav aria-label="Rules" className="flex w-60 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-zinc-200 p-2 dark:border-zinc-800">
            {rules.map((rule, index) => (
              <button
                key={index}
                type="button"
                aria-current={index === selected ? "true" : undefined}
                onClick={() => setSelected(index)}
                className={`flex flex-col rounded-md px-2 py-1.5 text-left text-sm ${index === selected ? "bg-zinc-100 dark:bg-zinc-800" : "hover:bg-zinc-50 dark:hover:bg-zinc-900"}`}
              >
                <span className={`truncate ${rule.enabled ? "" : "text-zinc-400 line-through"}`}>{rule.name || "(unnamed)"}</span>
                <span className="flex gap-1 text-[10px] text-zinc-500">
                  {!rule.automate && <span>dry run</span>}
                  {!rule.runOnThreads && <span>· first message</span>}
                  {STATUS_NAMES[rule.systemType ?? ""] && <span>· status</span>}
                  {issuesByRule[index]!.length > 0 && <span className="text-red-600">· needs fixing</span>}
                </span>
              </button>
            ))}
            <div className="mt-2 flex flex-wrap gap-1 px-1">
              <button type="button" className={toolbarButtonClass} onClick={() => { update({ ...draft, rules: [...rules, newRule(rules)] }); setSelected(rules.length); }}>+ Add rule</button>
              <button type="button" className={toolbarButtonClass} title="Move up" disabled={selected === 0} onClick={() => move(-1)}>↑</button>
              <button type="button" className={toolbarButtonClass} title="Move down" disabled={selected >= rules.length - 1} onClick={() => move(1)}>↓</button>
            </div>
            <p className="px-2 pt-2 text-[11px] text-zinc-500">Order is the order the AI sees the rules in.</p>
          </nav>
          <div className="min-w-0 flex-1 overflow-y-auto p-4">
            {current
              ? <RuleEditor
                  key={`${version}:${selected}`}
                  rule={current}
                  issues={issuesByRule[selected]!}
                  onChange={(rule) => setRule(selected, rule)}
                  onDelete={() => {
                    if (!confirm(`Delete the rule “${current.name}”?`)) return;
                    update({ ...draft, rules: rules.filter((_, index) => index !== selected) });
                    setSelected(Math.max(0, selected - 1));
                  }}
                />
              : <p className="text-sm text-zinc-500">No rules yet. Add one, or import an Inbox Zero export.</p>}
          </div>
        </div>

        <footer className="flex flex-wrap items-center gap-2 border-t border-zinc-200 px-4 py-3 dark:border-zinc-800">
          {message && <p role={message.tone === "error" ? "alert" : "status"} className={`text-xs ${message.tone === "error" ? "text-red-600 dark:text-red-400" : "text-zinc-500"}`}>{message.text}</p>}
          <span className="ml-auto flex gap-2">
            <button type="button" className={toolbarButtonClass} onClick={close}>Close</button>
            <button type="button" className={toolbarButtonClass} disabled={!dirty || saving || hasIssues} onClick={save}>{saving ? "Saving…" : "Save rules"}</button>
          </span>
        </footer>
      </section>
    </div>
  );
}
