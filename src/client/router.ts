import { useCallback, useEffect, useState } from "react";

/** `/a/:accountId/views/:viewId` with an optional `/t/:threadId` for the open thread. */
export interface Route {
  readonly accountId: string;
  readonly viewId: string;
  readonly threadId: string | null;
}

export const parseRoute = (pathname: string): Route | null => {
  const match = /^\/a\/([^/]+)\/views\/([^/]+)(?:\/t\/([^/]+))?\/?$/.exec(pathname);
  if (!match) return null;
  return {
    accountId: decodeURIComponent(match[1]!),
    viewId: decodeURIComponent(match[2]!),
    threadId: match[3] ? decodeURIComponent(match[3]) : null,
  };
};

export const routePath = (route: Route): string =>
  `/a/${encodeURIComponent(route.accountId)}/views/${encodeURIComponent(route.viewId)}` +
  (route.threadId ? `/t/${encodeURIComponent(route.threadId)}` : "");

export const useRoute = (): readonly [Route | null, (route: Route, options?: { readonly replace?: boolean }) => void] => {
  const [route, setRoute] = useState(() => parseRoute(location.pathname));

  useEffect(() => {
    const onPopState = () => setRoute(parseRoute(location.pathname));
    addEventListener("popstate", onPopState);
    return () => removeEventListener("popstate", onPopState);
  }, []);

  const navigate = useCallback((next: Route, options: { readonly replace?: boolean } = {}) => {
    const path = routePath(next);
    if (path !== location.pathname) {
      if (options.replace) history.replaceState(null, "", path);
      else history.pushState(null, "", path);
    }
    setRoute(next);
  }, []);

  return [route, navigate] as const;
};
