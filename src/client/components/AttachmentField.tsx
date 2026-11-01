import { useRef } from "react";
import { MAX_ATTACHMENT_BYTES, type OutgoingAttachment } from "../../shared/api";
import { formatBytes } from "../format";

/** A file picked in a composer, read into base64 for the JSON send request. */
export interface PickedFile extends OutgoingAttachment {
  readonly id: string;
  readonly size: number;
}

const toBase64 = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  // Chunked: String.fromCharCode(...bytes) overflows the call stack on large files.
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
};

export const readFiles = (files: Iterable<File>): Promise<PickedFile[]> => Promise.all([...files].map(async (file) => ({
  id: crypto.randomUUID(),
  filename: file.name,
  mimeType: file.type || "application/octet-stream",
  size: file.size,
  dataBase64: toBase64(await file.arrayBuffer()),
})));

/** The wire form of picked files (without the client-only id and size). */
export const outgoingAttachments = (files: ReadonlyArray<PickedFile>): OutgoingAttachment[] =>
  files.map(({ filename, mimeType, dataBase64 }) => ({ filename, mimeType, dataBase64 }));

export const totalSize = (files: ReadonlyArray<{ readonly size: number }>): number =>
  files.reduce((total, file) => total + file.size, 0);

/**
 * "Attach files" button plus the picked files, each removable. Files can also be dropped on the
 * composer (see `onDropFiles`). `extraBytes` counts attachments sent alongside (e.g. forwarded ones).
 */
export function AttachmentField({ files, onChange, extraBytes = 0 }: {
  readonly files: ReadonlyArray<PickedFile>;
  readonly onChange: (files: ReadonlyArray<PickedFile>) => void;
  readonly extraBytes?: number;
}) {
  const input = useRef<HTMLInputElement>(null);
  const total = totalSize(files) + extraBytes;
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200 px-3 py-1.5 dark:border-zinc-800">
      <button
        type="button"
        className="text-xs text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
        onClick={() => input.current?.click()}
      >
        📎 Attach files
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={async (event) => {
          const picked = await readFiles(event.target.files ?? []);
          event.target.value = "";
          onChange([...files, ...picked]);
        }}
      />
      {files.map((file) => (
        <span key={file.id} className="flex max-w-64 items-center gap-1.5 rounded border border-zinc-200 px-1.5 text-xs leading-5 dark:border-zinc-700">
          <span className="truncate">{file.filename}</span>
          <span className="shrink-0 text-zinc-500">{formatBytes(file.size)}</span>
          <button type="button" aria-label={`Remove ${file.filename}`} className="text-zinc-500 hover:text-red-600" onClick={() => onChange(files.filter((other) => other.id !== file.id))}>
            ×
          </button>
        </span>
      ))}
      {total > MAX_ATTACHMENT_BYTES && (
        <span role="alert" className="text-xs text-red-600 dark:text-red-400">
          Attachments total {formatBytes(total)}; Gmail allows {formatBytes(MAX_ATTACHMENT_BYTES)}.
        </span>
      )}
    </div>
  );
}

/** Drop handlers for a composer form: dropped files are added as attachments. */
export const fileDropHandlers = (files: ReadonlyArray<PickedFile>, onChange: (files: ReadonlyArray<PickedFile>) => void) => ({
  onDragOver: (event: React.DragEvent) => {
    if (event.dataTransfer.types.includes("Files")) event.preventDefault();
  },
  onDrop: async (event: React.DragEvent) => {
    if (event.dataTransfer.files.length === 0) return;
    event.preventDefault();
    onChange([...files, ...await readFiles(event.dataTransfer.files)]);
  },
});
