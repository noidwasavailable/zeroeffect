import DOMPurify from "dompurify";

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
