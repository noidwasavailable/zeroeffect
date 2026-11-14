import { afterAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { outboundRedirect, resolveTrackedUrl } from "../src/server/linkResolver";
import { isOpaqueTracker, outboundUrl, unwrapTrackedUrl } from "../src/shared/trackers";

describe("click trackers", () => {
  test("pure redirectors unwrap offline, nested ones too; other links stay as they are", () => {
    expect(unwrapTrackedUrl("https://www.google.com/url?q=https://example.com/a%3Fb%3D1&sa=D")).toBe("https://example.com/a?b=1");
    expect(unwrapTrackedUrl("https://www.google.com.au/url?q=https://example.com/")).toBe("https://example.com/");
    expect(unwrapTrackedUrl("https://www.google.co.kr/url?q=https://example.com/")).toBe("https://example.com/");
    expect(unwrapTrackedUrl("https://track-mmp.navercorp.com/link/NzQ0?url=https%3A%2F%2Fwww.naver.com%2F")).toBe("https://www.naver.com/");
    expect(unwrapTrackedUrl("https://l.facebook.com/l.php?u=https%3A%2F%2Fwww.google.com%2Furl%3Fq%3Dhttps%3A%2F%2Fexample.com%2F")).toBe("https://example.com/");
    // Same host, other paths: Maps links and sign-in pages with a return URL are destinations, not redirects.
    expect(unwrapTrackedUrl("https://www.google.com/maps/search/Seoul?entry=x")).toBe("https://www.google.com/maps/search/Seoul?entry=x");
    expect(unwrapTrackedUrl("https://login.aliexpress.com/?url=https%3A%2F%2Fexample.com")).toBe("https://login.aliexpress.com/?url=https%3A%2F%2Fexample.com");
    // A parameter that is not a web URL is left alone.
    expect(unwrapTrackedUrl("https://www.google.com/url?q=javascript:alert(1)")).toBe("https://www.google.com/url?q=javascript:alert(1)");
  });

  test("opaque trackers go through the server; everything else opens directly", () => {
    const sendgrid = "https://u38405118.ct.sendgrid.net/ls/click?upn=abc";
    expect(isOpaqueTracker(sendgrid)).toBe(true);
    expect(isOpaqueTracker("https://u38405118.ct.sendgrid.net/other")).toBe(false);
    expect(outboundUrl(sendgrid)).toBe(`/api/out?url=${encodeURIComponent(sendgrid)}`);
    expect(outboundUrl("https://www.google.com/url?q=https://example.com/")).toBe("https://example.com/");
    expect(outboundUrl("mailto:a@example.com")).toBe("mailto:a@example.com");
  });

  describe("server-side resolution", () => {
    const requests: string[] = [];
    const tracker = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        requests.push(url.pathname);
        if (url.pathname === "/click") return Response.redirect("https://dest.example/magic?token=1", 302);
        if (url.pathname === "/chain") return Response.redirect(new URL("/click", url).href, 302);
        if (url.pathname === "/wrapped") return Response.redirect("https://www.google.com/url?q=https%3A%2F%2Fdest.example%2Fw", 302);
        if (url.pathname === "/script") return Response.redirect("javascript:alert(1)", 302);
        return new Response("<meta http-equiv=refresh>", { status: 200 });
      },
    });
    afterAll(() => tracker.stop(true));
    const options = { isTracker: (url: string) => url.startsWith(tracker.url.origin) };
    const at = (path: string) => new URL(path, tracker.url).href;

    test("follows trackers one hop at a time and never requests the destination", async () => {
      requests.length = 0;
      expect(await Effect.runPromise(resolveTrackedUrl(at("/chain"), options))).toBe("https://dest.example/magic?token=1");
      expect(requests).toEqual(["/chain", "/click"]);
      expect(await Effect.runPromise(resolveTrackedUrl(at("/wrapped"), options))).toBe("https://dest.example/w");
    });

    test("falls back to the tracker link when it does not redirect to a web page", async () => {
      expect(await Effect.runPromise(resolveTrackedUrl(at("/page"), options))).toBe(at("/page"));
      expect(await Effect.runPromise(resolveTrackedUrl(at("/script"), options))).toBe(at("/script"));
      expect(await Effect.runPromise(resolveTrackedUrl("https://unreachable.invalid/x", { isTracker: () => true, timeoutMs: 500 }))).toBe("https://unreachable.invalid/x");
    });

    test("GET /api/out redirects without a referrer and refuses links that are not trackers", async () => {
      const response = await Effect.runPromise(outboundRedirect(new URL(`http://localhost/api/out?url=${encodeURIComponent(at("/click"))}`), options));
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("https://dest.example/magic?token=1");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect((await Effect.runPromise(outboundRedirect(new URL("http://localhost/api/out?url=https%3A%2F%2Fevil.example%2F"), options))).status).toBe(400);
    });
  });
});
