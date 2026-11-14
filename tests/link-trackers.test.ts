import { describe, expect, test } from "bun:test";
import { outboundUrl, unwrapTrackedUrl } from "../src/shared/trackers";

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

  test("links open past redirectors; everything else opens unchanged", () => {
    expect(outboundUrl("https://www.google.com/url?q=https://example.com/")).toBe("https://example.com/");
    expect(outboundUrl("mailto:a@example.com")).toBe("mailto:a@example.com");
  });
});
