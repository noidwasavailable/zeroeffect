import { useEffect, useRef, type Ref } from "react";
import { MAX_ATTACHMENT_BYTES, type ReplyDraft } from "../../shared/api";
import { toolbarButtonClass } from "./ActionToolbar";
import { AttachmentField, fileDropHandlers, totalSize, type PickedFile } from "./AttachmentField";
import { noAutofill } from "../noAutofill";
import { Keycap } from "./Keycap";

export interface ComposerState {
  readonly threadId: string;
  readonly draft: ReplyDraft;
  readonly to: string;
  readonly cc: string;
  readonly subject: string;
  readonly body: string;
  readonly fromAlias: string;
  readonly attachments: ReadonlyArray<PickedFile>;
  readonly sending: boolean;
  readonly error: string | null;
}

/** Splits "a@x.com, B <b@y.com>" into addresses, keeping commas inside quoted display names. */
export const splitAddressList = (value: string): string[] =>
  value.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((part) => part.trim()).filter(Boolean);

const MATCH_LABELS: Record<NonNullable<ReplyDraft["aliasMatch"]>, string> = {
  recipient: "matches the address this email was sent to",
  default: "your default alias",
  primary: "your primary address",
  first: "first available alias",
};

const fieldClass = "min-w-0 flex-1 bg-transparent py-1 text-sm outline-none";

/** Inline reply form under the open conversation. The original message is quoted automatically. */
export function ReplyComposer({ state, onChange, onSend, onDiscard, aliasRef }: {
  readonly state: ComposerState;
  readonly onChange: (update: Partial<ComposerState>) => void;
  readonly onSend: () => void;
  readonly onDiscard: () => void;
  readonly aliasRef?: Ref<HTMLSelectElement>;
}) {
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    bodyRef.current?.focus();
  }, [state.threadId]);
  const canSend = !state.sending && Boolean(state.fromAlias) && splitAddressList(state.to).length > 0 && state.body.trim().length > 0
    && totalSize(state.attachments) <= MAX_ATTACHMENT_BYTES;
  const row = "flex items-center gap-2 border-b border-zinc-200 px-3 dark:border-zinc-800";

  return (
    <form
      aria-label="Reply"
      className="mx-4 mb-4 flex flex-col rounded-lg border border-zinc-300 shadow-sm dark:border-zinc-700"
      {...fileDropHandlers(state.attachments, (attachments) => onChange({ attachments }))}
      onSubmit={(event) => {
        event.preventDefault();
        if (canSend) onSend();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onDiscard();
        } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          if (canSend) onSend();
        }
      }}
    >
      <label className={row}>
        <span className="w-14 text-xs text-zinc-500">From</span>
        <select ref={aliasRef} className={`${fieldClass} cursor-pointer`} value={state.fromAlias} onChange={(event) => onChange({ fromAlias: event.target.value })}>
          {state.draft.aliases.length === 0 && <option value="">No alias can send for this account</option>}
          {state.draft.aliases.map((alias) => (
            <option key={alias.sendAsEmail} value={alias.sendAsEmail}>
              {alias.displayName ? `${alias.displayName} <${alias.sendAsEmail}>` : alias.sendAsEmail}
              {alias.sendAsEmail === state.draft.fromAlias && state.draft.aliasMatch ? ` · ${MATCH_LABELS[state.draft.aliasMatch]}` : ""}
            </option>
          ))}
        </select>
      </label>
      <label className={row}>
        <span className="w-14 text-xs text-zinc-500">To</span>
        <input {...noAutofill} className={fieldClass} value={state.to} onChange={(event) => onChange({ to: event.target.value })} />
      </label>
      <label className={row}>
        <span className="w-14 text-xs text-zinc-500">Cc</span>
        <input {...noAutofill} className={fieldClass} value={state.cc} onChange={(event) => onChange({ cc: event.target.value })} />
        {state.draft.replyAllCc.length > 0 && !state.cc && (
          <button type="button" className="shrink-0 text-xs text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200" onClick={() => onChange({ cc: state.draft.replyAllCc.join(", ") })}>
            + everyone ({state.draft.replyAllCc.length})
          </button>
        )}
      </label>
      <label className={row}>
        <span className="w-14 text-xs text-zinc-500">Subject</span>
        <input {...noAutofill} className={fieldClass} value={state.subject} onChange={(event) => onChange({ subject: event.target.value })} />
      </label>
      <AttachmentField files={state.attachments} onChange={(attachments) => onChange({ attachments })} />
      <textarea
        ref={bodyRef}
        aria-label="Message"
        rows={8}
        className="resize-y bg-transparent px-3 py-2 text-sm outline-none"
        placeholder="Write your reply…"
        value={state.body}
        onChange={(event) => onChange({ body: event.target.value })}
      />
      <div className="flex flex-wrap items-center gap-2 border-t border-zinc-200 px-3 py-2 dark:border-zinc-800">
        <button type="submit" className={toolbarButtonClass} disabled={!canSend}>
          {state.sending ? "Sending…" : "Send"}
          <Keycap label="⌘↵" />
        </button>
        <button type="button" className={toolbarButtonClass} onClick={onDiscard}>
          Discard
          <Keycap label="Esc" />
        </button>
        <span className="text-xs text-zinc-500">The original message is quoted below your reply. Signatures come from the alias.</span>
        {state.error && <p role="alert" className="w-full text-xs text-red-600 dark:text-red-400">{state.error}</p>}
      </div>
    </form>
  );
}
