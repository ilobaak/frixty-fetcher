// Tests for TikTok pure helpers + API shape handling.
// The source file has no import/export — it's a classic script
// loaded via manifest.json content_scripts in production. Here we
// import it as a side-effect ESM module; it assigns to globalThis.
// happy-dom is activated per-test (via `// @vitest-environment happy-dom`)
// for the DOM-touching helper; the rest run in Node.

import { describe, it, expect, beforeEach } from "vitest";
import "../extension/tiktok-shared.js";

const shared = globalThis.__ytdlpTtShared;

describe("isTargetUrl", () => {
  it("accepts /api/recommend/item_list/", () => {
    expect(shared.isTargetUrl("https://www.tiktok.com/api/recommend/item_list/?aid=1988")).toBe(true);
  });
  it("accepts /api/preload/item_list/", () => {
    expect(shared.isTargetUrl("https://www.tiktok.com/api/preload/item_list/?x=y")).toBe(true);
  });
  it("accepts /api/item/detail/", () => {
    expect(shared.isTargetUrl("https://www.tiktok.com/api/item/detail/?itemId=123")).toBe(true);
  });
  it("accepts /api/post/item_list/", () => {
    expect(shared.isTargetUrl("https://www.tiktok.com/api/post/item_list/?userId=x")).toBe(true);
  });
  it("rejects analytics / non-item endpoints", () => {
    expect(shared.isTargetUrl("https://www.tiktok.com/api/share/settings/?foo=bar")).toBe(false);
    expect(shared.isTargetUrl("https://www.tiktok.com/api/inbox/notice_count/")).toBe(false);
    expect(shared.isTargetUrl("https://mon16-normal-useast5.tiktokv.us/monitor_browser/collect/batch/")).toBe(false);
  });
  it("rejects non-tiktok hosts", () => {
    expect(shared.isTargetUrl("https://example.com/api/recommend/item_list/")).toBe(false);
  });
  it("rejects garbage", () => {
    expect(shared.isTargetUrl("")).toBe(false);
    expect(shared.isTargetUrl(null)).toBe(false);
    expect(shared.isTargetUrl(42)).toBe(false);
  });
});

describe("canonicalPostUrl", () => {
  it("canonicalizes an absolute URL with query + hash", () => {
    const out = shared.canonicalPostUrl("https://www.tiktok.com/@user/video/123456789012?is_from_webapp=1#x");
    expect(out).toBe("https://www.tiktok.com/@user/video/123456789012");
  });
  it("canonicalizes a photo permalink", () => {
    expect(shared.canonicalPostUrl("/@user/photo/7000000000000000000")).toBe(
      "https://www.tiktok.com/@user/photo/7000000000000000000",
    );
  });
  it("returns '' for non-canonical paths", () => {
    expect(shared.canonicalPostUrl("/@user")).toBe("");
    expect(shared.canonicalPostUrl("/tag/fyp")).toBe("");
    expect(shared.canonicalPostUrl("/music/original-sound-123")).toBe("");
  });
  it("handles malformed input safely", () => {
    expect(shared.canonicalPostUrl("")).toBe("");
    expect(shared.canonicalPostUrl(null)).toBe("");
    expect(shared.canonicalPostUrl("https://[invalid]")).toBe("");
  });
});

describe("cdnUrlKey", () => {
  it("returns the mp4 path basename", () => {
    const u = "https://v16-webapp.tiktok.com/abc123def456.mp4?a=1988&br=3402";
    expect(shared.cdnUrlKey(u)).toBe("/abc123def456.mp4");
  });
  it("is stable across sibling CDN hosts", () => {
    const a = "https://v16-webapp.tiktok.com/abc.mp4?a=1";
    const b = "https://v19-webapp-prime.tiktok.com/abc.mp4?a=2";
    expect(shared.cdnUrlKey(a)).toBe(shared.cdnUrlKey(b));
  });
  it("strips trailing query on the filename", () => {
    expect(shared.cdnUrlKey("https://cdn.example.com/a/b/abc.mp4?token=xyz")).toBe("/abc.mp4");
  });
  it("returns '' for non-strings", () => {
    expect(shared.cdnUrlKey(null)).toBe("");
    expect(shared.cdnUrlKey("")).toBe("");
  });
});

describe("posterKey", () => {
  it("strips the tplv suffix and extension", () => {
    const img = "https://p16-common-sign.tiktokcdn-us.com/tos-useast5-p-0068-tx/o86vfeHASH~tplv-tiktokx-origin.image?dr=9636";
    expect(shared.posterKey(img)).toBe("o86vfeHASH");
  });
  it("handles renditions with different tplv suffixes", () => {
    const a = "https://p16.tiktokcdn-us.com/obj/path/hashval~tplv-photomode-image.jpeg?x=1";
    const b = "https://p16.tiktokcdn-us.com/obj/path/hashval~tplv-tiktokx-cropcenter:100:100.jpeg?x=2";
    expect(shared.posterKey(a)).toBe(shared.posterKey(b));
    expect(shared.posterKey(a)).toBe("hashval");
  });
  it("returns '' for URLs without a ~ separator", () => {
    expect(shared.posterKey("https://cdn.example.com/image.jpg")).toBe("image");
  });
  it("handles malformed input", () => {
    expect(shared.posterKey(null)).toBe("");
    expect(shared.posterKey("")).toBe("");
  });
});

describe("toSummary", () => {
  it("normalizes a well-formed item", () => {
    const item = {
      id: "7626497491805998367",
      author: { uniqueId: "certified.angelei", nickname: "Angelei" },
      desc: "some caption",
      video: {
        playAddr: "https://cdn/play.mp4",
        downloadAddr: "https://cdn/dl.mp4",
        cover: "https://cdn/cover.jpeg",
        duration: 42,
      },
    };
    expect(shared.toSummary(item)).toEqual({
      id: "7626497491805998367",
      authorId: "certified.angelei",
      authorNickname: "Angelei",
      desc: "some caption",
      playAddr: "https://cdn/play.mp4",
      downloadAddr: "https://cdn/dl.mp4",
      cover: "https://cdn/cover.jpeg",
      duration: 42,
    });
  });
  it("coerces numeric ids to strings", () => {
    expect(shared.toSummary({ id: 7626497491805998367, author: {}, video: {} })?.id).toMatch(/^\d+$/);
  });
  it("rejects items without a numeric id", () => {
    expect(shared.toSummary({ id: "abc", author: {}, video: {} })).toBe(null);
    expect(shared.toSummary({ author: {}, video: {} })).toBe(null);
    expect(shared.toSummary(null)).toBe(null);
  });
  it("falls back to originCover when cover is empty", () => {
    const item = { id: "1234567890", author: {}, video: { originCover: "https://cdn/orig.jpg" } };
    expect(shared.toSummary(item).cover).toBe("https://cdn/orig.jpg");
  });
});

describe("extractItems", () => {
  it("pulls from itemList", () => {
    const payload = {
      itemList: [
        { id: "1111111111", author: { uniqueId: "a" }, video: {} },
        { id: "2222222222", author: { uniqueId: "b" }, video: {} },
      ],
    };
    const items = shared.extractItems(payload);
    expect(items.map((i) => i.id)).toEqual(["1111111111", "2222222222"]);
  });
  it("pulls from items (alt key)", () => {
    const payload = { items: [{ id: "3333333333", author: { uniqueId: "c" }, video: {} }] };
    expect(shared.extractItems(payload).map((i) => i.id)).toEqual(["3333333333"]);
  });
  it("pulls from itemInfo.itemStruct (single-video detail endpoint)", () => {
    const payload = {
      itemInfo: {
        itemStruct: { id: "4444444444", author: { uniqueId: "d" }, video: {} },
      },
    };
    expect(shared.extractItems(payload).map((i) => i.id)).toEqual(["4444444444"]);
  });
  it("dedupes items repeated across shapes", () => {
    const dup = { id: "5555555555", author: { uniqueId: "e" }, video: {} };
    const payload = { itemList: [dup], itemInfo: { itemStruct: dup } };
    expect(shared.extractItems(payload)).toHaveLength(1);
  });
  it("returns [] for malformed payloads", () => {
    expect(shared.extractItems(null)).toEqual([]);
    expect(shared.extractItems({})).toEqual([]);
    expect(shared.extractItems({ itemList: "nope" })).toEqual([]);
  });
});

describe("collectSeedItems", () => {
  it("extracts items from webapp.reflow.itemList", () => {
    const blob = {
      __DEFAULT_SCOPE__: {
        "webapp.reflow": {
          itemList: [
            { id: "7000000000000000001", author: { uniqueId: "x" }, video: {} },
            { id: "7000000000000000002", author: { uniqueId: "y" }, video: {} },
          ],
        },
      },
    };
    expect(shared.collectSeedItems(blob).map((i) => i.id)).toEqual([
      "7000000000000000001",
      "7000000000000000002",
    ]);
  });
  it("picks up single-video detail layout", () => {
    const blob = {
      __DEFAULT_SCOPE__: {
        "webapp.video-detail": {
          itemInfo: { itemStruct: { id: "7000000000000000003", author: { uniqueId: "z" }, video: {} } },
        },
      },
    };
    expect(shared.collectSeedItems(blob).map((i) => i.id)).toEqual(["7000000000000000003"]);
  });
  it("dedupes items shared between known keys and the recursive walk", () => {
    const dup = { id: "7000000000000000004", author: { uniqueId: "w" }, video: {} };
    const blob = {
      __DEFAULT_SCOPE__: {
        "webapp.reflow": { itemList: [dup] },
        "other.random.key": { nested: { deep: dup } },
      },
    };
    expect(shared.collectSeedItems(blob)).toHaveLength(1);
  });
  it("handles a blob with no __DEFAULT_SCOPE__", () => {
    expect(shared.collectSeedItems({ random: "data" })).toEqual([]);
  });
  it("returns [] for null / non-object input", () => {
    expect(shared.collectSeedItems(null)).toEqual([]);
    expect(shared.collectSeedItems("string")).toEqual([]);
  });
});

describe("findCanonicalUrlForPost", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  const cache = [
    { id: "7000000000000000001", authorId: "alice", video: {} },
    { id: "7000000000000000002", authorId: "bob", video: {} },
    { id: "7000000000000000003", authorId: "carol", video: {} },
  ];

  it("tier 1: author-match hits when the post has a single /@user anchor matching a unique cache entry", () => {
    document.body.innerHTML = `
      <article>
        <a href="/@bob">avatar</a>
        <a href="/tag/fyp">tag</a>
        <a href="/@bob">handle</a>
      </article>
    `;
    const post = document.querySelector("article");
    const result = shared.findCanonicalUrlForPost(post, cache, "https://www.tiktok.com/");
    expect(result.url).toBe("https://www.tiktok.com/@bob/video/7000000000000000002");
    expect(result.tier).toBe("author-match");
  });

  it("tier 2: location-href wins when author-match misses but URL is canonical", () => {
    document.body.innerHTML = `<article><a href="/tag/fyp">only tags</a></article>`;
    const post = document.querySelector("article");
    const result = shared.findCanonicalUrlForPost(
      post,
      cache,
      "https://www.tiktok.com/@otheruser/video/7999999999999999999?foo=bar",
    );
    expect(result.url).toBe("https://www.tiktok.com/@otheruser/video/7999999999999999999");
    expect(result.tier).toBe("location-href");
  });

  it("tier 3: post-bulk-regex finds a URL embedded in the post's outerHTML", () => {
    document.body.innerHTML = `
      <article>
        <span data-share-url="https://www.tiktok.com/@hidden/video/7111111111111111111?x=1">share</span>
      </article>
    `;
    const post = document.querySelector("article");
    const result = shared.findCanonicalUrlForPost(post, cache, "https://www.tiktok.com/");
    expect(result.tier).toBe("post-bulk-regex");
    expect(result.url).toMatch(/\/video\/7111111111111111111/);
  });

  it("author-match beats location-href when both would fire", () => {
    // If the URL is canonical AND the post has a unique author in
    // cache, author-match (the more specific signal) wins.
    document.body.innerHTML = `<article><a href="/@alice">avatar</a></article>`;
    const post = document.querySelector("article");
    const result = shared.findCanonicalUrlForPost(
      post,
      cache,
      "https://www.tiktok.com/@bob/video/7000000000000000002",
    );
    expect(result.tier).toBe("author-match");
    expect(result.url).toContain("@alice/video/7000000000000000001");
  });

  it("returns no match when every tier misses", () => {
    document.body.innerHTML = `<article><a href="/tag/fyp">t</a></article>`;
    const post = document.querySelector("article");
    const result = shared.findCanonicalUrlForPost(post, cache, "https://www.tiktok.com/");
    expect(result.url).toBe("");
    expect(result.tier).toBe("");
    expect(result.tried).toEqual(["author-match", "location-href", "post-bulk-regex"]);
  });

  it("author-match refuses to guess when the cache has multiple entries for the same author", () => {
    const ambiguousCache = [
      { id: "7000000000000000010", authorId: "dan", video: {} },
      { id: "7000000000000000011", authorId: "dan", video: {} },
    ];
    document.body.innerHTML = `<article><a href="/@dan">x</a></article>`;
    const post = document.querySelector("article");
    const result = shared.findCanonicalUrlForPost(
      post,
      ambiguousCache,
      "https://www.tiktok.com/",
    );
    // Author-match refuses, no location-href match, no URL in HTML.
    expect(result.url).toBe("");
    expect(result.tried).toContain("author-match");
  });

  it("tolerates a null post element (popup path with no viewport article)", () => {
    const result = shared.findCanonicalUrlForPost(
      null,
      cache,
      "https://www.tiktok.com/@bob/video/7000000000000000002",
    );
    expect(result.tier).toBe("location-href");
    expect(result.url).toBe("https://www.tiktok.com/@bob/video/7000000000000000002");
  });

  it("tolerates an empty / missing cache", () => {
    document.body.innerHTML = `<article><a href="/@bob">x</a></article>`;
    const post = document.querySelector("article");
    const result = shared.findCanonicalUrlForPost(post, [], "https://www.tiktok.com/");
    expect(result.url).toBe("");
    const result2 = shared.findCanonicalUrlForPost(post, undefined, "https://www.tiktok.com/");
    expect(result2.url).toBe("");
  });
});

// Requires DOM for querySelectorAll / getAttribute on real elements.
describe("extractAuthorFromAnchors", () => {
  // @vitest-environment happy-dom — declared per-file via config.
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("returns the single author from a feed-card-shaped post", () => {
    document.body.innerHTML = `
      <article>
        <a href="/@certified.angelei">avatar</a>
        <a href="/tag/fyp">tag</a>
        <a href="/music/original-sound-123">music</a>
        <a href="/@certified.angelei">handle</a>
      </article>
    `;
    const post = document.querySelector("article");
    expect(shared.extractAuthorFromAnchors(post)).toBe("certified.angelei");
  });
  it("returns '' when multiple distinct authors appear (duet or related-post prefetch)", () => {
    document.body.innerHTML = `
      <article>
        <a href="/@author1">one</a>
        <a href="/@author2">two</a>
      </article>
    `;
    expect(shared.extractAuthorFromAnchors(document.querySelector("article"))).toBe("");
  });
  it("returns '' when there are no /@ anchors", () => {
    document.body.innerHTML = `<article><a href="/tag/x">t</a></article>`;
    expect(shared.extractAuthorFromAnchors(document.querySelector("article"))).toBe("");
  });
  it("excludes /@user/video/<id> permalinks from the author list", () => {
    document.body.innerHTML = `
      <article>
        <a href="/@realauthor">profile</a>
        <a href="/@otheruser/video/12345">related video</a>
      </article>
    `;
    expect(shared.extractAuthorFromAnchors(document.querySelector("article"))).toBe("realauthor");
  });
  it("accepts a query/hash on the profile anchor", () => {
    document.body.innerHTML = `
      <article><a href="/@user?lang=en">x</a></article>
    `;
    expect(shared.extractAuthorFromAnchors(document.querySelector("article"))).toBe("user");
  });
  it("returns '' for non-element input without throwing", () => {
    expect(shared.extractAuthorFromAnchors(null)).toBe("");
    expect(shared.extractAuthorFromAnchors({})).toBe("");
  });
});
