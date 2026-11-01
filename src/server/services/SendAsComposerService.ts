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
}

export interface ComposedMessage {
  readonly from: string;
  readonly raw: string;
  readonly alias: SendAsAliasRecord;
}

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
          const bodyText = input.quote
            ? `${ownText}\n\n${quoteHeader}\n${input.quote.text.trim().split("\n").map((line) => `> ${line}`).join("\n")}`
            : ownText;
          const ownHtml = input.html
            ? appendSignature(input.html, alias.signatureHtml ?? "")
            : escapeHtml(ownText).replace(/\n/g, "<br>\n");
          const bodyHtml = input.quote
            ? `${ownHtml}<br><br><div>${escapeHtml(quoteHeader!)}</div><blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${escapeHtml(input.quote.text.trim()).replace(/\n/g, "<br>\n")}</blockquote>`
            : ownHtml;
          const boundary = `zeroeffect_${crypto.randomUUID().replaceAll("-", "")}`;
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
            `Content-Type: multipart/alternative; boundary="${boundary}"`,
          ];
          const raw = [
            ...headers,
            "",
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
            "",
          ].join("\r\n");
          return { from, raw: Buffer.from(raw, "utf8").toString("base64url"), alias };
        },
        catch: (cause) => new SendAsComposeError({ message: String(cause) }),
      });
    });

    const send = (input: ComposeReplyInput) => Effect.gen(function* () {
      const message = yield* compose(input);
      return yield* gmail.sendRaw(message.raw, input.threadId);
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

const appendSignature = (html: string, signature: string): string =>
  `${html}${signature ? `<br><br>${signature}` : ""}`;

const escapeHtml = (value: string): string => value.replace(/[&<>\"]/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;",
})[character]!);
