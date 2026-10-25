export interface GmailMimePart {
  readonly mimeType?: string | null;
  readonly filename?: string | null;
  readonly headers?: ReadonlyArray<{ readonly name?: string | null; readonly value?: string | null }>;
  readonly body?: { readonly data?: string | null; readonly attachmentId?: string | null } | null;
  readonly parts?: ReadonlyArray<GmailMimePart> | null;
}

export interface ParsedMimeBody {
  readonly bodyMarkdown: string;
  readonly bodyHtmlSanitized: string;
}

const allowedTags = new Set([
  "a", "blockquote", "br", "code", "div", "em", "h1", "h2", "h3", "h4", "h5", "h6",
  "hr", "i", "li", "ol", "p", "pre", "s", "span", "strong", "table", "tbody", "td", "th", "thead", "tr", "u", "ul",
]);
const voidTags = new Set(["br", "hr"]);
const dangerousTags = "script|style|iframe|object|embed|svg|math|form|textarea|template|noscript";

export const parseMimeBody = (payload: GmailMimePart | null | undefined): ParsedMimeBody => {
  const collected = collectTextParts(payload);
  const plain = collected.plain.join("\n").trim();
  const html = sanitizeHtml(collected.html.join("\n"));
  return {
    bodyMarkdown: plain || htmlToMarkdown(html),
    bodyHtmlSanitized: html,
  };
};

const collectTextParts = (part: GmailMimePart | null | undefined): { plain: string[]; html: string[] } => {
  if (!part || isAttachment(part)) return { plain: [], html: [] };
  const mimeType = part.mimeType?.toLowerCase() ?? "";
  if (part.parts?.length) {
    const nested = part.parts.map(collectTextParts);
    if (mimeType === "multipart/alternative") {
      const plain = nested.flatMap((item) => item.plain);
      const html = nested.flatMap((item) => item.html);
      return { plain: plain.length ? [plain.at(-1)!] : [], html: html.length ? [html.at(-1)!] : [] };
    }
    return { plain: nested.flatMap((item) => item.plain), html: nested.flatMap((item) => item.html) };
  }
  const data = part.body?.data;
  if (!data) return { plain: [], html: [] };
  const text = Buffer.from(data, "base64url").toString("utf8");
  if (mimeType === "text/plain") return { plain: [text], html: [] };
  if (mimeType === "text/html") return { plain: [], html: [text] };
  return { plain: [], html: [] };
};

const isAttachment = (part: GmailMimePart): boolean => {
  if (part.filename) return true;
  const disposition = part.headers?.find((item) => item.name?.toLowerCase() === "content-disposition")?.value;
  return disposition?.split(";", 1)[0]?.trim().toLowerCase() === "attachment"
    || Boolean(part.body?.attachmentId && !part.body.data);
};

export const sanitizeHtml = (input: string): string => {
  const withoutDangerousBlocks = input.replace(
    new RegExp(`<(${dangerousTags})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`, "gi"),
    "",
  ).replace(new RegExp(`<(${dangerousTags})\\b[^>]*>[\\s\\S]*$`, "gi"), "");

  return withoutDangerousBlocks.replace(
    /<!--[\s\S]*?-->|<![^>]*>|<\/?[a-zA-Z][^>]*>/g,
    (token) => {
      if (token.startsWith("<!--") || token.startsWith("<!")) return "";
      const parsed = /^<\s*(\/?)\s*([a-zA-Z0-9-]+)([^>]*)>$/.exec(token);
      if (!parsed) return "";
      const closing = parsed[1] ?? "";
      const name = (parsed[2] ?? "").toLowerCase();
      const rawAttributes = parsed[3] ?? "";
      if (!allowedTags.has(name)) return "";
      if (closing) return voidTags.has(name) ? "" : `</${name}>`;
      let attributes = "";
      if (name === "a") {
        const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(rawAttributes);
        const title = /\btitle\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(rawAttributes);
        const safeHref = decodeEntities(href?.[1] ?? href?.[2] ?? href?.[3] ?? "").trim();
        if (/^(https?:|mailto:)/i.test(safeHref)) attributes += ` href="${escapeAttribute(safeHref)}" rel="noreferrer noopener"`;
        const safeTitle = title?.[1] ?? title?.[2] ?? title?.[3];
        if (safeTitle) attributes += ` title="${escapeAttribute(safeTitle)}"`;
      }
      return `<${name}${attributes}${voidTags.has(name) || /\/\s*>$/.test(token) ? "/>" : ">"}`;
    },
  );
};

export const htmlToMarkdown = (html: string): string => decodeEntities(
  html
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(?:p|div|h[1-6]|blockquote|pre|ul|ol|li|tr|table)\s*>/gi, "\n")
    .replace(/<h([1-6])\b[^>]*>/gi, (_, level: string) => `${"#".repeat(Number(level))} `)
    .replace(/<blockquote\b[^>]*>/gi, "> ")
    .replace(/<strong\b[^>]*>|<b\b[^>]*>/gi, "**")
    .replace(/<\/(?:strong|b)\s*>/gi, "**")
    .replace(/<em\b[^>]*>|<i\b[^>]*>/gi, "*")
    .replace(/<\/(?:em|i)\s*>/gi, "*")
    .replace(/<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a\s*>/gi, "$2 ($1)")
    .replace(/<[^>]*>/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim(),
);

const decodeEntities = (value: string): string => value.replace(
  /&(#x[\da-f]{1,6}|#\d{1,7}|amp|apos|gt|lt|nbsp|quot);/gi,
  (entity, body: string) => {
    switch (body.toLowerCase()) {
      case "amp": return "&";
      case "apos": return "'";
      case "gt": return ">";
      case "lt": return "<";
      case "nbsp": return " ";
      case "quot": return '"';
      default: {
        const code = body[1]?.toLowerCase() === "x"
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
        return Number.isInteger(code) && code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
          ? String.fromCodePoint(code)
          : entity;
      }
    }
  },
);

const escapeAttribute = (value: string): string => value.replace(/[&"<>]/g, (character) => ({
  "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;",
})[character]!);
