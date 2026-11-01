import { Context, Effect, Layer } from "effect";
import { AccountDb } from "./AccountDb";
import type { SendAsAliasRecord } from "./AccountDb";
import { GmailClient } from "./GmailClient";
import { SendAsComposeError } from "../../shared/errors";

export interface ComposeReplyInput {
  readonly to: ReadonlyArray<string>;
  readonly cc?: ReadonlyArray<string>;
  /** Gmail delivers to Bcc recipients and strips the header from what others receive. */
  readonly bcc?: ReadonlyArray<string>;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
  readonly deliveredTo?: string | null;
  /** Addresses the replied-to message was sent to; used to pick the matching alias (defaults to to + cc). */
  readonly matchAddresses?: ReadonlyArray<string>;
  readonly fromAlias?: string;
  /** Threading: Gmail thread id plus the RFC 2822 headers that tie the reply to the original. */
  readonly threadId?: string;
  readonly inReplyTo?: string | null;
  readonly references?: string | null;
  /** The message being answered, quoted below the reply as Gmail does. */
  readonly quote?: { readonly from: string; readonly dateTs: number; readonly text: string };
  /** The message being forwarded, included below the text with Gmail's "Forwarded message" header. */
  readonly forward?: ForwardedMessage;
  readonly attachments?: ReadonlyArray<OutgoingFile>;
}

export interface ForwardedMessage {
  readonly from: string;
  readonly dateTs: number;
  readonly subject: string;
  readonly to: ReadonlyArray<string>;
  readonly cc: ReadonlyArray<string>;
  readonly text: string;
  /** The original HTML, when it had any; the text is used otherwise. */
  readonly html: string | null;
}

export interface OutgoingFile {
  readonly filename: string;
  readonly mimeType: string;
  readonly data: Uint8Array;
  /** Kept for forwarded inline images, so the forwarded HTML's `cid:` references still resolve. */
  readonly contentId?: string | null;
}

export interface ComposedMessage {
  readonly from: string;
  /** The RFC 2822 message, base64url-encoded for Gmail's `raw` field. */
  readonly raw: string;
  /** The same message as bytes, for the upload endpoint. */
  readonly mime: Uint8Array;
  readonly alias: SendAsAliasRecord;
}

/** Above this size (or with attachments) messages go through Gmail's upload endpoint rather than JSON `raw`. */
const MAX_RAW_JSON_BYTES = 4 * 1024 * 1024;

export interface SendAsComposerServiceApi {
  readonly compose: (input: ComposeReplyInput) => Effect.Effect<ComposedMessage, import("../../shared/errors").DatabaseError | SendAsComposeError>;
  readonly send: (input: ComposeReplyInput) => Effect.Effect<{ readonly id: string; readonly threadId: string }, import("../../shared/errors").DatabaseError | import("../../shared/errors").GmailApiError | SendAsComposeError>;
}

export class SendAsComposerService extends Context.Service<SendAsComposerService, SendAsComposerServiceApi>()(
  "zeroeffect/SendAsComposerService",
) {}

export type AliasMatch = "requested" | "recipient" | "default" | "primary" | "first";

/** Gmail reports no verificationStatus for the primary address; it can always send. */
export const isSendableAlias = (alias: SendAsAliasRecord): boolean =>
  alias.isPrimary || alias.verificationStatus.toLowerCase() === "accepted";

export const SendAsComposerServiceLive: Layer.Layer<SendAsComposerService, never, AccountDb | GmailClient> =
  Layer.effect(SendAsComposerService, Effect.gen(function* () {
    const accountDb = yield* AccountDb;
    const gmail = yield* GmailClient;

    const compose = (input: ComposeReplyInput) => Effect.gen(function* () {
      const aliases = yield* accountDb.listSendAsAliases();
      const alias = chooseAlias(aliases, input)?.alias;
      if (!alias) return yield* Effect.fail(new SendAsComposeError({ message: "No verified Send As alias is configured for this account." }));
      return yield* Effect.try({
        try: () => {
          const from = formatAddress(alias.displayName, alias.sendAsEmail);
          const to = input.to.map((address) => safeHeader(address, "To address")).join(", ");
          const cc = input.cc?.map((address) => safeHeader(address, "Cc address")).join(", ");
          const bcc = input.bcc?.map((address) => safeHeader(address, "Bcc address")).join(", ");
          const subject = encodeHeader(safeHeader(input.subject, "Subject"));
          const quoteHeader = input.quote
            ? `On ${new Date(input.quote.dateTs).toUTCString()}, ${input.quote.from} wrote:`
            : null;
          const ownText = [input.text.trim(), htmlToText(alias.signatureHtml ?? "")].filter(Boolean).join("\n\n");
          const forwardHeaderLines = input.forward ? [
            "---------- Forwarded message ---------",
            `From: ${input.forward.from}`,
            `Date: ${new Date(input.forward.dateTs).toUTCString()}`,
            `Subject: ${input.forward.subject}`,
            `To: ${input.forward.to.join(", ")}`,
            ...(input.forward.cc.length > 0 ? [`Cc: ${input.forward.cc.join(", ")}`] : []),
          ] : [];
          const bodyText = input.quote
            ? `${ownText}\n\n${quoteHeader}\n${input.quote.text.trim().split("\n").map((line) => `> ${line}`).join("\n")}`
            : input.forward
              ? `${ownText}${ownText ? "\n\n" : ""}${forwardHeaderLines.join("\n")}\n\n${input.forward.text.trim()}`
              : ownText;
          const ownHtml = input.html
            ? appendSignature(input.html, alias.signatureHtml ?? "")
            : escapeHtml(ownText).replace(/\n/g, "<br>\n");
          const bodyHtml = input.quote
            ? `${ownHtml}<br><br><div>${escapeHtml(quoteHeader!)}</div><blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${escapeHtml(input.quote.text.trim()).replace(/\n/g, "<br>\n")}</blockquote>`
            : input.forward
              ? `${ownHtml}${ownText ? "<br><br>" : ""}<div>${forwardHeaderLines.map(escapeHtml).join("<br>\n")}</div><br>\n${
                input.forward.html ? htmlBodyContent(input.forward.html) : escapeHtml(input.forward.text.trim()).replace(/\n/g, "<br>\n")}`
              : ownHtml;
          const boundary = `zeroeffect_${crypto.randomUUID().replaceAll("-", "")}`;
          const attachments = input.attachments ?? [];
          const mixedBoundary = `zeroeffect_mixed_${crypto.randomUUID().replaceAll("-", "")}`;
          const headers = [
            `From: ${from}`,
            `To: ${to}`,
            ...(cc ? [`Cc: ${cc}`] : []),
            ...(bcc ? [`Bcc: ${bcc}`] : []),
            ...(alias.replyToAddress ? [`Reply-To: ${safeHeader(alias.replyToAddress, "Reply-To")}`] : []),
            `Subject: ${subject}`,
            ...(input.inReplyTo ? [`In-Reply-To: ${safeHeader(input.inReplyTo, "In-Reply-To")}`] : []),
            ...(input.references ? [`References: ${safeHeader(input.references, "References")}`] : []),
            "MIME-Version: 1.0",
            attachments.length > 0
              ? `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`
              : `Content-Type: multipart/alternative; boundary="${boundary}"`,
          ];
          const alternative = [
            `--${boundary}`,
            'Content-Type: text/plain; charset="UTF-8"',
            "Content-Transfer-Encoding: base64",
            "",
            Buffer.from(bodyText, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n"),
            `--${boundary}`,
            'Content-Type: text/html; charset="UTF-8"',
            "Content-Transfer-Encoding: base64",
            "",
            Buffer.from(bodyHtml, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n"),
            `--${boundary}--`,
          ];
          const body = attachments.length === 0 ? alternative : [
            `--${mixedBoundary}`,
            `Content-Type: multipart/alternative; boundary="${boundary}"`,
            "",
            ...alternative,
            ...attachments.flatMap((file) => attachmentPart(mixedBoundary, file)),
            `--${mixedBoundary}--`,
          ];
          const mime = Buffer.from([...headers, "", ...body, ""].join("\r\n"), "utf8");
          return { from, raw: mime.toString("base64url"), mime, alias };
        },
        catch: (cause) => new SendAsComposeError({ message: String(cause) }),
      });
    });

    const send = (input: ComposeReplyInput) => Effect.gen(function* () {
      const message = yield* compose(input);
      return (input.attachments?.length ?? 0) > 0 || message.mime.byteLength > MAX_RAW_JSON_BYTES
        ? yield* gmail.sendMime(message.mime, input.threadId)
        : yield* gmail.sendRaw(message.raw, input.threadId);
    });
    return { compose, send };
  }));

/**
 * Picks the sending alias: an explicitly requested one, else the alias the original message was
 * delivered to (Delivered-To, To, Cc), else the default, primary or first sendable alias.
 */
export const chooseAlias = (
  aliases: ReadonlyArray<SendAsAliasRecord>,
  input: Pick<ComposeReplyInput, "fromAlias" | "deliveredTo" | "matchAddresses" | "to" | "cc">,
): { readonly alias: SendAsAliasRecord; readonly match: AliasMatch } | undefined => {
  const sendable = aliases.filter(isSendableAlias);
  if (input.fromAlias) {
    const requested = sendable.find((alias) => alias.sendAsEmail.toLowerCase() === input.fromAlias!.trim().toLowerCase());
    return requested ? { alias: requested, match: "requested" } : undefined;
  }
  const recipientAddresses = [input.deliveredTo, ...(input.matchAddresses ?? [...input.to, ...(input.cc ?? [])])]
    .filter((value): value is string => Boolean(value))
    .map((value) => extractAddress(value).toLowerCase());
  const matched = recipientAddresses
    .map((address) => sendable.find((alias) => alias.sendAsEmail.toLowerCase() === address))
    .find((alias): alias is SendAsAliasRecord => alias !== undefined);
  if (matched) return { alias: matched, match: "recipient" };
  const fallback = sendable.find((alias) => alias.isDefault);
  if (fallback) return { alias: fallback, match: "default" };
  const primary = sendable.find((alias) => alias.isPrimary);
  if (primary) return { alias: primary, match: "primary" };
  return sendable[0] ? { alias: sendable[0], match: "first" } : undefined;
};

const safeHeader = (value: string, name: string): string => {
  if (/[\r\n]/.test(value)) throw new Error(`${name} must not contain line breaks.`);
  return value.trim();
};

const formatAddress = (displayName: string, address: string): string => {
  safeHeader(address, "From address");
  const name = safeHeader(displayName, "Display name");
  return name ? `${encodeHeader(name)} <${address}>` : address;
};

const encodeHeader = (value: string): string => /^[\x20-\x7e]*$/.test(value)
  ? value
  : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;

const extractAddress = (value: string): string => /<([^<>]+)>/.exec(value)?.[1]?.trim() ?? value.trim();

const htmlToText = (html: string): string => html
  .replace(/<\s*(br|\/p|\/div|\/li)\b[^>]*>/gi, "\n")
  .replace(/<[^>]*>/g, "")
  .replace(/&nbsp;/gi, " ")
  .replace(/&amp;/gi, "&")
  .replace(/&lt;/gi, "<")
  .replace(/&gt;/gi, ">")
  .trim();

/** One attachment of a multipart/mixed message (RFC 2183 / RFC 2231 file names). */
const attachmentPart = (boundary: string, file: OutgoingFile): string[] => {
  const filename = file.filename.replace(/[\r\n"\\]/g, "_").trim() || "attachment";
  const mimeType = /^[\w.+-]+\/[\w.+-]+$/.test(file.mimeType) ? file.mimeType : "application/octet-stream";
  const asciiName = /^[\x20-\x7e]*$/.test(filename);
  const contentId = file.contentId?.replace(/[\r\n<>]/g, "");
  return [
    `--${boundary}`,
    `Content-Type: ${mimeType}; name="${asciiName ? filename : encodeHeader(filename)}"`,
    `Content-Disposition: ${contentId ? "inline" : "attachment"}; ${asciiName ? `filename="${filename}"` : `filename*=UTF-8''${encodeURIComponent(filename)}`}`,
    "Content-Transfer-Encoding: base64",
    ...(contentId ? [`Content-ID: <${contentId}>`] : []),
    "",
    Buffer.from(file.data).toString("base64").replace(/.{76}/g, "$&\r\n"),
  ];
};

/** The inside of an HTML document's <body> (the whole input when it has none), for embedding. */
const htmlBodyContent = (html: string): string => /<body\b[^>]*>([\s\S]*)<\/body\s*>/i.exec(html)?.[1] ?? html;

const appendSignature = (html: string, signature: string): string =>
  `${html}${signature ? `<br><br>${signature}` : ""}`;

const escapeHtml = (value: string): string => value.replace(/[&<>\"]/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;",
})[character]!);
