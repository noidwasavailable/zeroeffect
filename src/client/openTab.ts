/**
 * Opens `url` in a new tab with no opener and no referrer, and reports whether the browser allowed
 * the tab. `window.open(url, "_blank", "noopener")` returns null even when it succeeds, so a
 * blocked popup cannot be told apart; this opens a blank tab instead, cuts its opener, and
 * navigates it from a no-referrer link inside it (a navigation started by this page would send
 * this page's address as the referrer).
 */
export const openInNewTab = (url: string): boolean => {
  const tab = window.open("", "_blank");
  if (!tab) return false;
  tab.opener = null;
  const link = tab.document.createElement("a");
  link.href = url;
  link.rel = "noreferrer";
  tab.document.body.append(link);
  link.click();
  return true;
};
