/**
 * Copies text to the clipboard. Call it directly from the click / key handler: browsers only allow
 * clipboard writes during a user gesture. Falls back to execCommand where the async Clipboard API
 * is unavailable (non-secure origins).
 */
export const copyText = async (text: string): Promise<void> => {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.append(field);
  field.select();
  const copied = document.execCommand("copy");
  field.remove();
  if (!copied) throw new Error("The browser blocked clipboard access.");
};
