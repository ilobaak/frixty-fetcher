// Pure helpers from extension/twitter.js. The async DOM-walking
// functions (getTwitterDomInfo, detectTweet) need a chrome runtime
// mock; this file covers only the synchronous, network-free helpers
// that drive URL rewriting and variant selection.

import { describe, it, expect } from "vitest";
import { withTwitterSize, pickVariantUrl } from "../extension/twitter.js";

describe("withTwitterSize", () => {
  it("sets ?name=orig on a clean pbs.twimg.com URL", () => {
    const out = withTwitterSize("https://pbs.twimg.com/media/abc.jpg", "orig");
    expect(out).toBe("https://pbs.twimg.com/media/abc.jpg?name=orig");
  });
  it("replaces an existing name= parameter rather than duplicating", () => {
    const out = withTwitterSize(
      "https://pbs.twimg.com/media/abc.jpg?name=small",
      "orig",
    );
    expect(out).toBe("https://pbs.twimg.com/media/abc.jpg?name=orig");
  });
  it("preserves unrelated query parameters", () => {
    const out = withTwitterSize(
      "https://pbs.twimg.com/media/abc.jpg?format=jpg&name=small",
      "orig",
    );
    // searchParams.set keeps original ordering, so `format=jpg&name=orig`.
    expect(out.includes("format=jpg")).toBe(true);
    expect(out.includes("name=orig")).toBe(true);
    expect(out.includes("name=small")).toBe(false);
  });
  it("accepts the small size label too (used for thumbnails)", () => {
    const out = withTwitterSize(
      "https://pbs.twimg.com/media/abc.jpg?name=orig",
      "small",
    );
    expect(out.includes("name=small")).toBe(true);
  });
  it("returns the input unchanged on an unparseable URL", () => {
    expect(withTwitterSize("not a url", "orig")).toBe("not a url");
    expect(withTwitterSize("", "orig")).toBe("");
  });
});

describe("pickVariantUrl", () => {
  // Variants are pre-sorted highest-resolution-first by Twitter's
  // syndication API; pickVariantUrl trusts that ordering.
  const item = {
    url: "https://video.twimg.com/ext_tw_video/123/pu/vid/1280x720/fallback.mp4",
    variants: [
      { height: 1080, url: "https://example.com/1080.mp4" },
      { height: 720, url: "https://example.com/720.mp4" },
      { height: 480, url: "https://example.com/480.mp4" },
      { height: 240, url: "https://example.com/240.mp4" },
    ],
  };

  it("returns the top variant when maxHeight is 0 (= unlimited)", () => {
    expect(pickVariantUrl(item, 0)).toBe("https://example.com/1080.mp4");
  });
  it("returns the top variant for a negative maxHeight (= unlimited)", () => {
    expect(pickVariantUrl(item, -1)).toBe("https://example.com/1080.mp4");
  });
  it("picks the largest variant under the cap", () => {
    expect(pickVariantUrl(item, 720)).toBe("https://example.com/720.mp4");
    expect(pickVariantUrl(item, 1000)).toBe("https://example.com/720.mp4");
    expect(pickVariantUrl(item, 480)).toBe("https://example.com/480.mp4");
  });
  it("falls back to the smallest variant when cap is below all", () => {
    expect(pickVariantUrl(item, 100)).toBe("https://example.com/240.mp4");
  });
  it("returns item.url when there are no variants", () => {
    const noVariants = { url: "https://video.twimg.com/fallback.mp4" };
    expect(pickVariantUrl(noVariants, 0)).toBe(noVariants.url);
    expect(pickVariantUrl(noVariants, 720)).toBe(noVariants.url);
  });
  it("returns item.url for an empty variants array", () => {
    const emptyVariants = { url: "https://video.twimg.com/fallback.mp4", variants: [] };
    expect(pickVariantUrl(emptyVariants, 0)).toBe(emptyVariants.url);
  });
  it("treats a missing variant.height as 0 (always under any positive cap)", () => {
    const item = {
      url: "fallback",
      variants: [
        { url: "no-height-1.mp4" },
        { height: 480, url: "480.mp4" },
      ],
    };
    // First variant has height 0 ≤ 480, so it wins by DOM order.
    expect(pickVariantUrl(item, 480)).toBe("no-height-1.mp4");
  });
});
