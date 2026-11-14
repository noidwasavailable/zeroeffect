// Resolves opaque click trackers for GET /api/out (see shared/trackers.ts): asks the tracker where
// it redirects without following the redirect, so the destination itself (often a single-use
// sign-in link) is only ever opened by the browser.

import { Effect } from "effect";
import { TrackerRequestError } from "../shared/errors";
import { isOpaqueTracker, unwrapTrackedUrl } from "../shared/trackers";

export interface LinkResolverOptions {
  readonly fetch?: typeof fetch;
  /** Which URLs to resolve; tests point it at a local mock tracker. */
  readonly isTracker?: (url: string) => boolean;
  readonly timeoutMs?: number;
}

/** Trackers chained behind each other are followed this far; the destination is never requested. */
const MAX_HOPS = 3;

/** Where a tracker redirects, or null when it answers with anything but a redirect to a web page. */
const nextHop = (url: string, options: LinkResolverOptions): Effect.Effect<string | null, TrackerRequestError> =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await (options.fetch ?? fetch)(url, {
        redirect: "manual",
        signal: AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs ?? 3_000)]),
      });
      await response.body?.cancel();
      return response;
    },
    catch: (cause) => new TrackerRequestError({ message: `Could not reach the click tracker at ${new URL(url).host}.`, url, cause }),
  }).pipe(Effect.map((response) => {
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location || !URL.canParse(location, url)) return null;
    const next = new URL(location, url);
    return next.protocol === "https:" || next.protocol === "http:" ? unwrapTrackedUrl(next.href) : null;
  }));

/** The link's destination, or the furthest tracker URL reached when a tracker fails or does not redirect. */
export const resolveTrackedUrl = (url: string, options: LinkResolverOptions = {}): Effect.Effect<string> =>
  Effect.gen(function* () {
    const isTracker = options.isTracker ?? isOpaqueTracker;
    let current = unwrapTrackedUrl(url);
    for (let hop = 0; hop < MAX_HOPS && isTracker(current); hop += 1) {
      const next = yield* nextHop(current, options).pipe(
        Effect.tapError((error) => Effect.logWarning(error.message, error.cause)),
        Effect.orElseSucceed(() => null),
      );
      if (!next) break;
      current = next;
    }
    return current;
  });

/** GET /api/out?url=…: redirects to the tracker's destination, falling back to the tracker link itself. */
export const outboundRedirect = (url: URL, options: LinkResolverOptions = {}): Effect.Effect<Response> => {
  const target = url.searchParams.get("url") ?? "";
  // Only trackers are accepted, so this route is not an open redirect to arbitrary sites.
  if (!(options.isTracker ?? isOpaqueTracker)(target)) return Effect.succeed(new Response("Not a known click-tracking link.", { status: 400 }));
  return resolveTrackedUrl(target, options).pipe(Effect.map((location) => new Response(null, {
    status: 302,
    headers: { location, "referrer-policy": "no-referrer", "cache-control": "no-store" },
  })));
};
