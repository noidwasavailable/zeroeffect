import DOMPurify from "dompurify";
import type { AttachmentSummary } from "../shared/api";

/**
 * Sanitizes a message's original HTML for the Shadow DOM reader. Unlike the server's strict copy,
 * it keeps what makes email rich (inline and <style> CSS, images, tables, layout attributes) and
 * drops scripts, event handlers, forms, frames and external stylesheets.
 */
export const sanitizeEmailHtml = (html: string): string => DOMPurify.sanitize(html, {
  // Keep <head><style> blocks, which many newsletters rely on; the shadow root scopes them.
  WHOLE_DOCUMENT: true,
  FORBID_TAGS: [
    "form", "input", "button", "textarea", "select", "option", "link", "meta", "base",
    "iframe", "frame", "frameset", "object", "embed", "audio", "video", "source",
  ],
  FORBID_ATTR: ["autofocus"],
});

/**
 * Points `cid:` references (inline images) at the attachment download route, before sanitizing:
 * DOMPurify drops the cid: scheme. Returns the HTML and the Content-IDs it now displays.
 */
export const resolveInlineImages = (
  html: string,
  attachments: ReadonlyArray<AttachmentSummary>,
  urlFor: (attachment: AttachmentSummary) => string,
): { readonly html: string; readonly referenced: ReadonlySet<string> } => {
  const byContentId = new Map(attachments.flatMap((attachment) => attachment.contentId ? [[attachment.contentId.toLowerCase(), attachment] as const] : []));
  const referenced = new Set<string>();
  const resolved = html.replace(/cid:([^"'()\s>]+)/gi, (match, id: string) => {
    let key = id;
    try {
      key = decodeURIComponent(id);
    } catch {
      // Keep the raw id.
    }
    const attachment = byContentId.get(key.toLowerCase());
    if (!attachment) return match;
    referenced.add(attachment.contentId!);
    return urlFor(attachment);
  });
  return { html: resolved, referenced };
};
