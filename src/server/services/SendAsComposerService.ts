import { Context, Effect, Layer } from "effect";
import { AccountDb } from "./AccountDb";
import type { SendAsAliasRecord } from "./AccountDb";
import { GmailClient } from "./GmailClient";
import { SendAsComposeError } from "../../shared/errors";

export interface ComposeReplyInput {
  readonly to: ReadonlyArray<string>;
  readonly cc?: ReadonlyArray<string>;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
  readonly deliveredTo?: string | null;
  readonly fromAlias?: string;
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

export const SendAsComposerServiceLive: Layer.Layer<SendAsComposerService, never, AccountDb | GmailClient> =
  Layer.effect(SendAsComposerService, Effect.gen(function* () {
    const accountDb = yield* AccountDb;
    const gmail = yield* GmailClient;

    const compose = (input: ComposeReplyInput) => Effect.gen(function* () {
      const aliases = yield* accountDb.listSendAsAliases();
      const alias = chooseAlias(aliases, input);
      if (!alias) return yield* Effect.fail(new SendAsComposeError({ message: "No verified Send As alias is configured for this account." }));
      return yield* Effect.try({
        try: () => {
          const from = formatAddress(alias.displayName, alias.sendAsEmail);
          const to = input.to.map((address) => safeHeader(address, "To address")).join(", ");
          const cc = input.cc?.map((address) => safeHeader(address, "Cc address")).join(", ");
          const subject = encodeHeader(safeHeader(input.subject, "Subject"));
          const bodyText = [input.text.trim(), htmlToText(alias.signatureHtml ?? "")].filter(Boolean).join("\n\n");
          const bodyHtml = input.html
            ? appendSignature(input.html, alias.signatureHtml ?? "")
            : escapeHtml(bodyText).replace(/\n/g, "<br>\n");
          const boundary = `zeroeffect_${crypto.randomUUID().replaceAll("-", "")}`;
          const headers = [
            `From: ${from}`,
            `To: ${to}`,
            ...(cc ? [`Cc: ${cc}`] : []),
            ...(alias.replyToAddress ? [`Reply-To: ${safeHeader(alias.replyToAddress, "Reply-To")}`] : []),
            `Subject: ${subject}`,
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
      return yield* gmail.sendRaw(message.raw);
    });
    return { compose, send };
  }));

const chooseAlias = (aliases: ReadonlyArray<SendAsAliasRecord>, input: ComposeReplyInput): SendAsAliasRecord | undefined => {
  const verified = aliases.filter((alias) => alias.verificationStatus.toLowerCase() === "accepted");
  if (input.fromAlias) {
    return verified.find((alias) => alias.sendAsEmail.toLowerCase() === input.fromAlias!.trim().toLowerCase());
  }
  const recipientAddresses = [input.deliveredTo, ...input.to, ...(input.cc ?? [])]
    .filter((value): value is string => Boolean(value))
    .map((value) => extractAddress(value).toLowerCase());
  const matched = recipientAddresses
    .map((address) => verified.find((alias) => alias.sendAsEmail.toLowerCase() === address))
    .find((alias): alias is SendAsAliasRecord => alias !== undefined);
  return matched ?? verified.find((alias) => alias.isDefault) ?? verified.find((alias) => alias.isPrimary) ?? verified[0];
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
