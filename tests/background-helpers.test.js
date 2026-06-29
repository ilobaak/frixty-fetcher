// Unit tests for the pure helpers extracted from background.js into
// extension/background-helpers.js. Backgrounds.js itself is the
// service-worker entry and side-effects everywhere on import — these
// helpers were lifted out specifically so they could be tested without
// mocking chrome.* / DOM / network.

import { describe, it, expect } from "vitest";
import {
  captureKey,
  isCacheable,
  sectionOf,
  topLevelSiteFor,
  siteCookieDomains,
  formatNetscapeCookie,
  buildPersistentFetchSnapshot,
  buildTtRelayMessage,
} from "../extension/background-helpers.js";

describe("captureKey", () => {
  it("formats per-tab capture key", () => {
    expect(captureKey(42)).toBe("capture:list:42");
    expect(captureKey(0)).toBe("capture:list:0");
  });
});

describe("isCacheable", () => {
  it("caches successful formats responses", () => {
    expect(isCacheable({ type: "formats", items: [] })).toBe(true);
  });
  it("does NOT cache progress / done / error / null / undefined", () => {
    expect(isCacheable({ type: "progress" })).toBe(false);
    expect(isCacheable({ type: "done" })).toBe(false);
    expect(isCacheable({ type: "error", code: "x" })).toBe(false);
    expect(isCacheable(null)).toBe(false);
    expect(isCacheable(undefined)).toBe(false);
    expect(isCacheable({})).toBe(false);
  });
});

describe("sectionOf", () => {
  it("returns the first non-empty path segment", () => {
    expect(sectionOf("https://www.facebook.com/watch/?v=1")).toBe("watch");
    expect(sectionOf("https://www.facebook.com/marketplace/item/123")).toBe("marketplace");
    expect(sectionOf("https://www.facebook.com/reel/456")).toBe("reel");
  });
  it("returns empty string for root path", () => {
    expect(sectionOf("https://www.facebook.com/")).toBe("");
  });
  it("returns empty string for unparseable input", () => {
    expect(sectionOf("not a url")).toBe("");
    expect(sectionOf("")).toBe("");
  });
});

describe("topLevelSiteFor", () => {
  it("returns scheme://hostname for valid URLs", () => {
    expect(topLevelSiteFor("https://x.com/elon/status/1")).toBe("https://x.com");
    expect(topLevelSiteFor("http://example.com/x?y=z")).toBe("http://example.com");
  });
  it("returns empty string for missing or invalid input", () => {
    expect(topLevelSiteFor("")).toBe("");
    expect(topLevelSiteFor(null)).toBe("");
    expect(topLevelSiteFor("not a url")).toBe("");
  });
});

describe("siteCookieDomains", () => {
  it("maps twitter / x to both registrable domains", () => {
    expect(siteCookieDomains("https://twitter.com/x")).toEqual(["twitter.com", "x.com"]);
    expect(siteCookieDomains("https://x.com/x")).toEqual(["twitter.com", "x.com"]);
    expect(siteCookieDomains("https://mobile.x.com/x")).toEqual(["twitter.com", "x.com"]);
  });

  it("maps youtube to youtube.com + google.com (login on accounts.google)", () => {
    expect(siteCookieDomains("https://www.youtube.com/watch?v=x")).toEqual([
      "youtube.com",
      "google.com",
    ]);
    expect(siteCookieDomains("https://youtu.be/x")).toEqual([
      "youtube.com",
      "google.com",
    ]);
  });

  it("maps single-domain sites to one entry each", () => {
    expect(siteCookieDomains("https://www.instagram.com/p/x/")).toEqual(["instagram.com"]);
    expect(siteCookieDomains("https://www.facebook.com/x")).toEqual(["facebook.com"]);
    expect(siteCookieDomains("https://fb.watch/x")).toEqual(["facebook.com"]);
    expect(siteCookieDomains("https://www.tiktok.com/@x/video/1")).toEqual(["tiktok.com"]);
  });

  it("returns [] for unknown hosts and bad input", () => {
    expect(siteCookieDomains("https://reddit.com/")).toEqual([]);
    expect(siteCookieDomains("https://example.com/")).toEqual([]);
    expect(siteCookieDomains("not a url")).toEqual([]);
    expect(siteCookieDomains("")).toEqual([]);
    expect(siteCookieDomains(null)).toEqual([]);
  });

  it("does NOT match suffix-overlap hostnames (no dot boundary)", () => {
    expect(siteCookieDomains("https://evilyoutube.com/x")).toEqual([]);
    expect(siteCookieDomains("https://nottiktok.com/x")).toEqual([]);
  });
});

describe("formatNetscapeCookie", () => {
  // Format: domain TAB include TAB path TAB secure TAB expires TAB name TAB value
  // (with optional #HttpOnly_ prefix on the domain field).
  it("renders a normal logged-in cookie", () => {
    const got = formatNetscapeCookie({
      domain: "twitter.com",
      hostOnly: false,
      path: "/",
      secure: true,
      session: false,
      expirationDate: 1700000000.5,
      httpOnly: false,
      name: "auth_token",
      value: "abc123",
    });
    expect(got).toBe(".twitter.com\tTRUE\t/\tTRUE\t1700000000\tauth_token\tabc123");
  });

  it("preserves a leading dot when domain already has one", () => {
    const got = formatNetscapeCookie({
      domain: ".twitter.com",
      hostOnly: false,
      path: "/api",
      secure: false,
      session: false,
      expirationDate: 1700000000,
      name: "n",
      value: "v",
    });
    expect(got).toBe(".twitter.com\tTRUE\t/api\tFALSE\t1700000000\tn\tv");
  });

  it("hostOnly cookies render the bare domain with FALSE", () => {
    const got = formatNetscapeCookie({
      domain: "twitter.com",
      hostOnly: true,
      path: "/",
      secure: true,
      session: false,
      expirationDate: 1700000000,
      name: "n",
      value: "v",
    });
    expect(got).toBe("twitter.com\tFALSE\t/\tTRUE\t1700000000\tn\tv");
  });

  it("session cookies use 0 for the expires field", () => {
    const got = formatNetscapeCookie({
      domain: "x.com",
      hostOnly: false,
      path: "/",
      secure: true,
      session: true,
      expirationDate: undefined,
      name: "n",
      value: "v",
    });
    expect(got).toBe(".x.com\tTRUE\t/\tTRUE\t0\tn\tv");
  });

  it("HttpOnly cookies are prefixed with #HttpOnly_", () => {
    const got = formatNetscapeCookie({
      domain: "twitter.com",
      hostOnly: false,
      path: "/",
      secure: true,
      session: false,
      expirationDate: 1700000000,
      httpOnly: true,
      name: "n",
      value: "v",
    });
    expect(got.startsWith("#HttpOnly_.twitter.com\t")).toBe(true);
  });

  it("defaults missing path to '/'", () => {
    const got = formatNetscapeCookie({
      domain: "x.com",
      hostOnly: true,
      secure: false,
      session: true,
      name: "n",
      value: "v",
    });
    // The 3rd field (after domain TAB include TAB) should be "/"
    expect(got.split("\t")[2]).toBe("/");
  });
});

describe("buildPersistentFetchSnapshot", () => {
  it("serializes active and completed fetch records for popup snapshots", () => {
    const fetches = new Map([
      [
        "r1",
        {
          url: "https://www.youtube.com/watch?v=abc",
          status: "running",
          useCookies: true,
          startedAt: 100,
        },
      ],
      [
        "r2",
        {
          url: "https://www.youtube.com/watch?v=done",
          status: "done",
          useCookies: false,
          startedAt: 50,
          completedAt: 120,
          response: { type: "formats", title: "done" },
        },
      ],
    ]);

    expect(buildPersistentFetchSnapshot(fetches)).toEqual([
      {
        id: "r1",
        url: "https://www.youtube.com/watch?v=abc",
        status: "running",
        useCookies: true,
        startedAt: 100,
      },
      {
        id: "r2",
        url: "https://www.youtube.com/watch?v=done",
        status: "done",
        useCookies: false,
        startedAt: 50,
        completedAt: 120,
        response: { type: "formats", title: "done" },
      },
    ]);
  });

  it("keeps newest fetch first for a URL when snapshots are searched", () => {
    const fetches = new Map([
      ["old", { url: "https://x.test/video", status: "done", startedAt: 10 }],
      ["new", { url: "https://x.test/video", status: "running", startedAt: 20 }],
    ]);

    expect(buildPersistentFetchSnapshot(fetches).map((f) => f.id)).toEqual(["new", "old"]);
  });
});

describe("buildTtRelayMessage", () => {
  it("transforms progress events", () => {
    expect(
      buildTtRelayMessage({
        type: "progress",
        jobId: "j1",
        percent: 42.5,
        speed: 1024,
        eta: 30,
      }),
    ).toEqual({
      type: "tt:dl-progress",
      jobId: "j1",
      percent: 42.5,
      speed: 1024,
      eta: 30,
    });
  });

  it("substitutes 0 for missing numeric fields on progress", () => {
    expect(buildTtRelayMessage({ type: "progress", jobId: "j1" })).toEqual({
      type: "tt:dl-progress",
      jobId: "j1",
      percent: 0,
      speed: 0,
      eta: 0,
    });
  });

  it("transforms done events with empty path fallback", () => {
    expect(buildTtRelayMessage({ type: "done", jobId: "j2" })).toEqual({
      type: "tt:dl-done",
      jobId: "j2",
      path: "",
    });
    expect(
      buildTtRelayMessage({ type: "done", jobId: "j2", path: "/foo.mp4" }),
    ).toEqual({
      type: "tt:dl-done",
      jobId: "j2",
      path: "/foo.mp4",
    });
  });

  it("transforms error events with code/message fallbacks", () => {
    expect(
      buildTtRelayMessage({
        type: "error",
        jobId: "j3",
        code: "download_failed",
        message: "boom",
      }),
    ).toEqual({
      type: "tt:dl-error",
      jobId: "j3",
      code: "download_failed",
      message: "boom",
    });
  });

  it("returns null for unrelated message types", () => {
    expect(buildTtRelayMessage({ type: "formats" })).toBeNull();
    expect(buildTtRelayMessage({ type: "snapshot" })).toBeNull();
    expect(buildTtRelayMessage(null)).toBeNull();
    expect(buildTtRelayMessage(undefined)).toBeNull();
    expect(buildTtRelayMessage({})).toBeNull();
  });
});
