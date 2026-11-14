// HTML character references, decoded the same way on the server (MIME parsing) and in shared
// extractors (shared/otp.ts). Only the named entities common in email are known; others stay as is.

export const decodeHtmlEntities = (value: string): string => value.replace(
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
