// Click-tracking redirects in email links. Pure redirectors that carry the destination in a query
// parameter are unwrapped offline, so the tracker never sees the click. Opaque ones (SendGrid's
// signed `upn`) can only be read by asking the tracker: the server resolves those one hop when the
// link is clicked (GET /api/out), never ahead of time.

/** Redirectors whose only job is to forward to the URL in one of `params`; matched on host and path. */
const REDIRECTORS: ReadonlyArray<{ readonly host: RegExp; readonly path: RegExp; readonly params: ReadonlyArray<string> }> = [
  { host: /^(?:www\.)?google\.(?:com\.[a-z]{2}|co\.[a-z]{2}|[a-z]{2,3})$/, path: /^\/url$/, params: ["q", "url"] },
  { host: /^track-mmp\.navercorp\.com$/, path: /^\/link\//, params: ["url"] },
  { host: /^l\.(?:facebook|instagram|messenger)\.com$/, path: /^\/(?:l\.php)?$/, params: ["u"] },
  { host: /\.safelinks\.protection\.outlook\.com$/, path: /^\/?$/, params: ["url"] },
  { host: /^(?:www\.)?youtube\.com$/, path: /^\/redirect$/, params: ["q"] },
  { host: /^(?:www\.)?linkedin\.com$/, path: /^\/redir\/redirect\/?$/, params: ["url"] },
  { host: /^slack-redir\.net$/, path: /^\/link$/, params: ["url"] },
];

/** Click trackers with an opaque destination, resolved by the server on click. */
const OPAQUE_TRACKERS: ReadonlyArray<{ readonly host: RegExp; readonly path: RegExp }> = [
  { host: /\.ct\.sendgrid\.net$/, path: /^\/ls\/click$/ },
  { host: /(?:^|\.)list-manage\.com$/, path: /^\/track\/click$/ },
  { host: /^mandrillapp\.com$/, path: /^\/track\/click\// },
  { host: /\.hubspotlinks\.com$/, path: /^\// },
];

const parseWebUrl = (value: string): URL | null => {
  if (!URL.canParse(value)) return null;
  const url = new URL(value);
  return url.protocol === "https:" || url.protocol === "http:" ? url : null;
};

/** The destination behind pure redirectors (nested ones too); other links come back unchanged. */
export const unwrapTrackedUrl = (value: string): string => {
  let current = value;
  for (let hop = 0; hop < 5; hop += 1) {
    const url = parseWebUrl(current);
    const redirector = url && REDIRECTORS.find((rule) => rule.host.test(url.hostname) && rule.path.test(url.pathname));
    const target = redirector && redirector.params.map((param) => url.searchParams.get(param)).find((candidate) => candidate && parseWebUrl(candidate));
    if (!target) return current;
    current = target;
  }
  return current;
};

/** Whether a link goes through a tracker whose destination only the tracker knows. */
export const isOpaqueTracker = (value: string): boolean => {
  const url = parseWebUrl(value);
  return url?.protocol === "https:" && OPAQUE_TRACKERS.some((rule) => rule.host.test(url.hostname) && rule.path.test(url.pathname));
};

export const OUTBOUND_PATH = "/api/out";

/**
 * Where a clicked email link should go: unwrapped offline when possible, through the server's
 * one-hop resolver for opaque trackers, and unchanged otherwise (mailto:, ordinary links).
 */
export const outboundUrl = (value: string): string => {
  const unwrapped = unwrapTrackedUrl(value);
  return isOpaqueTracker(unwrapped) ? `${OUTBOUND_PATH}?url=${encodeURIComponent(unwrapped)}` : unwrapped;
};
