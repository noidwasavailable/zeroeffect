import { useEffect, useRef } from "react";
import { MAX_ATTACHMENT_BYTES, type ForwardDraft, type NewMessageDraft } from "../../shared/api";
import { formatBytes } from "../format";
import { toolbarButtonClass } from "./ActionToolbar";
import { AttachmentField, fileDropHandlers, totalSize, type PickedFile } from "./AttachmentField";
import { Keycap } from "./Keycap";
import { noAutofill } from "../noAutofill";
import { splitAddressList } from "./ReplyComposer";

export interface NewMessageState {
  readonly draft: NewMessageDraft;
  readonly to: string;
  readonly cc: string;
  readonly bcc: string;
  readonly subject: string;
  readonly body: string;
  readonly fromAlias: string;
  readonly attachments: ReadonlyArray<PickedFile>;
  /** Set when forwarding: the thread, its forward defaults and the original attachments left out. */
  readonly forward?: { readonly threadId: string; readonly draft: ForwardDraft; readonly excluded: ReadonlyArray<string> };
  readonly sending: boolean;
  readonly error: string | null;
}

export const emptyNewMessage = (draft: NewMessageDraft): NewMessageState => ({
  draft, to: "", cc: "", bcc: "", subject: "", body: "", attachments: [],
  fromAlias: draft.fromAlias ?? draft.aliases[0]?.sendAsEmail ?? "", sending: false, error: null,
});

export const forwardMessage = (threadId: string, draft: ForwardDraft): NewMessageState => ({
  ...emptyNewMessage(draft),
  subject: draft.subject,
  forward: { threadId, draft, excluded: [] },
});

/** Bytes of the original's attachments that will be forwarded. */
const forwardedBytes = (state: NewMessageState): number =>
  totalSize(state.forward?.draft.attachments.filter((attachment) => !state.forward!.excluded.includes(attachment.partId)) ?? []);

/** A forward may go without a note; a new message needs text. Both need a recipient. */
export const canSendNewMessage = (state: NewMessageState): boolean =>
  !state.sending && Boolean(state.fromAlias) && (state.forward !== undefined || state.body.trim().length > 0) &&
  [state.to, state.cc, state.bcc].some((field) => splitAddressList(field).length > 0) &&
  totalSize(state.attachments) + forwardedBytes(state) <= MAX_ATTACHMENT_BYTES;

const fieldClass = "min-w-0 flex-1 bg-transparent py-1 text-sm outline-none";
const row = "flex items-center gap-2 border-b border-zinc-200 px-3 dark:border-zinc-800";

/** A new message (not a reply), sent from a chosen Send As alias as its own conversation. */
export function NewMessageDialog({ state, onChange, onSend, onDiscard }: {
  readonly state: NewMessageState;
  readonly onChange: (update: Partial<NewMessageState>) => void;
  readonly onSend: () => void;
  readonly onDiscard: () => void;
}) {
  const toRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    toRef.current?.focus();
  }, []);
  const canSend = canSendNewMessage(state);

  return (
    <div className="fixed inset-0 z-20 flex items-start justify-center bg-black/30 p-4 pt-[10vh]" onMouseDown={(event) => { if (event.target === event.currentTarget) onDiscard(); }}>
      <form
        role="dialog"
        aria-modal="true"
        aria-label={state.forward ? "Forward" : "New message"}
        className="flex w-[min(44rem,100%)] flex-col rounded-xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950"
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
        <h2 className="px-3 pb-1 pt-3 text-base font-semibold">{state.forward ? "Forward" : "New message"}</h2>
        <label className={row}>
          <span className="w-14 text-xs text-zinc-500">From</span>
          <select className={`${fieldClass} cursor-pointer`} value={state.fromAlias} onChange={(event) => onChange({ fromAlias: event.target.value })}>
            {state.draft.aliases.length === 0 && <option value="">No alias can send for this account</option>}
            {state.draft.aliases.map((alias) => (
              <option key={alias.sendAsEmail} value={alias.sendAsEmail}>
                {alias.displayName ? `${alias.displayName} <${alias.sendAsEmail}>` : alias.sendAsEmail}
              </option>
            ))}
          </select>
        </label>
        <label className={row}>
          <span className="w-14 text-xs text-zinc-500">To</span>
          <input {...noAutofill} ref={toRef} className={fieldClass} value={state.to} placeholder="name@example.com, …" onChange={(event) => onChange({ to: event.target.value })} />
        </label>
        <label className={row}>
          <span className="w-14 text-xs text-zinc-500">Cc</span>
          <input {...noAutofill} className={fieldClass} value={state.cc} onChange={(event) => onChange({ cc: event.target.value })} />
        </label>
        <label className={row}>
          <span className="w-14 text-xs text-zinc-500">Bcc</span>
          <input {...noAutofill} className={fieldClass} value={state.bcc} onChange={(event) => onChange({ bcc: event.target.value })} />
        </label>
        <label className={row}>
          <span className="w-14 text-xs text-zinc-500">Subject</span>
          <input {...noAutofill} className={fieldClass} value={state.subject} onChange={(event) => onChange({ subject: event.target.value })} />
        </label>
        {state.forward && state.forward.draft.attachments.length > 0 && (
          <fieldset className="flex flex-wrap items-center gap-2 border-b border-zinc-200 px-3 py-1.5 dark:border-zinc-800">
            <legend className="sr-only">Forwarded attachments</legend>
            <span className="text-xs text-zinc-500">Forwarding</span>
            {state.forward.draft.attachments.map((attachment) => {
              const forward = state.forward!;
              const included = !forward.excluded.includes(attachment.partId);
              return (
                <label key={attachment.partId} className="flex max-w-64 items-center gap-1.5 rounded border border-zinc-200 px-1.5 text-xs leading-5 dark:border-zinc-700">
                  <input
                    type="checkbox"
                    checked={included}
                    onChange={() => onChange({
                      forward: {
                        ...forward,
                        excluded: included ? [...forward.excluded, attachment.partId] : forward.excluded.filter((id) => id !== attachment.partId),
                      },
                    })}
                  />
                  <span className="truncate">{attachment.filename}</span>
                  <span className="shrink-0 text-zinc-500">{formatBytes(attachment.size)}</span>
                </label>
              );
            })}
          </fieldset>
        )}
        <AttachmentField files={state.attachments} onChange={(attachments) => onChange({ attachments })} extraBytes={forwardedBytes(state)} />
        <textarea
          aria-label="Message"
          rows={12}
          className="resize-y bg-transparent px-3 py-2 text-sm outline-none"
          placeholder={state.forward ? "Add a note (optional)…" : "Write your message…"}
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
          <span className="text-xs text-zinc-500">
            {state.forward ? "The original message is included below your note." : "The alias's signature is added automatically."}
          </span>
          {state.error && <p role="alert" className="w-full text-xs text-red-600 dark:text-red-400">{state.error}</p>}
        </div>
      </form>
    </div>
  );
}
