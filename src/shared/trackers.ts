// Click-tracking redirects in email links. Pure redirectors that carry the destination in a query
// parameter are unwrapped offline, so the tracker never sees the click.

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

/** Where a clicked email link should go: past pure redirectors, and unchanged otherwise (mailto:, ordinary links). */
export const outboundUrl = (value: string): string => unwrapTrackedUrl(value);
