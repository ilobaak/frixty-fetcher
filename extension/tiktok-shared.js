// Shared pure helpers used across TikTok content scripts (isolated
// world: tiktok-post-grab.js; MAIN world: tiktok-interceptor.js) AND
// the test suite. The file deliberately uses NO `import`/`export`
// syntax so it's valid as both a classic browser script (loaded via
// manifest.json content_scripts[].js) and a vitest side-effect
// import. Functions are exposed as `(window||globalThis).__ytdlpTtShared`.
//
// Keep this file free of DOM access beyond what's strictly needed
// for a given helper's contract — easier to unit-test, and some
// helpers are called from MAIN world where the DOM they see differs
// from the isolated world's.
(function () {
  "use strict";

  // ---- Constants shared between worlds ----
  // Both caches (MAIN-world window.__ytdlpTt.cache array + isolated-
  // world interceptCache Map) should cap at the same number so the
  // two views of cache state stay in lockstep.
  const CACHE_MAX = 400;
  // Max items TikTok interceptor publishes per postMessage batch.
  const BATCH_MAX = 50;
  // Skip inline JSON scripts shorter than this when seeding from SSR;
  // page-config flags are too small to be the feed payload.
  const MIN_SCRIPT_LEN = 50;
  // Depth cap for the recursive SSR tree walk; TikTok's blob nests
  // under ~5-8 levels in practice, 12 is defensive.
  const WALK_MAX_DEPTH = 12;

  // ---- Regexes ----
  // Matches a canonical TikTok video/photo URL anywhere inside a
  // string. Used for bulk-regex tier of extractPostUrl and when
  // sanity-checking anchor hrefs.
  const BULK_URL_RE = /https?:\/\/(?:[^.]+\.)?tiktok\.com\/@[^/"'\s<>]+\/(?:video|photo)\/\d+/i;
  // Tests whether a URL *is* a canonical TikTok post URL (anchored).
  const ABS_VIDEO_URL_RE = /^https?:\/\/(?:[^.]+\.)?tiktok\.com\/@[^/]+\/(?:video|photo)\/\d+/i;
  // Matches /@user/video/<id> or /@user/photo/<id> relative paths
  // (e.g. href values).
  const VIDEO_PATH_RE = /^\/@([^/]+)\/(?:video|photo)\/(\d+)/i;

  // ---- URL normalization ----

  // Canonicalize "/@user/video/123?foo=bar" or
  // "https://www.tiktok.com/@user/video/123/?…" to
  // "https://www.tiktok.com/@user/video/123". Returns "" if the input
  // doesn't contain a canonical video path at all.
  function canonicalPostUrl(href) {
    if (typeof href !== "string" || !href) return "";
    try {
      const base = typeof location !== "undefined" ? location.origin : "https://www.tiktok.com";
      const u = new URL(href, base);
      const m = u.pathname.match(/^\/@[^/]+\/(?:video|photo)\/\d+/);
      if (!m) return "";
      const clean = new URL("https://www.tiktok.com");
      clean.pathname = m[0];
      return clean.toString();
    } catch {
      return "";
    }
  }

  // cdnUrlKey: stable fragment identifying a TikTok video CDN URL
  // across sibling CDN nodes. Paths look like
  // "/aaaaa/bbbbb.mp4?..." — basename-without-query is the video id.
  function cdnUrlKey(url) {
    if (typeof url !== "string" || !url) return "";
    try {
      const base = typeof location !== "undefined" ? location.href : "https://www.tiktok.com";
      const u = new URL(url, base);
      const path = u.pathname || "";
      return path.slice(path.lastIndexOf("/")).replace(/\.mp4.*$/i, ".mp4");
    } catch {
      return "";
    }
  }

  // posterKey: part of a TikTok poster-image URL shared between the
  // <img> src in the DOM and the API's video.cover / originCover.
  //   img:    https://<cdn>/.../<hash>~tplv-tiktokx-origin.image?...
  //   cache:  https://<cdn>/.../<hash>~tplv-photomode-image.jpeg?...
  // Strip query + everything after the "~" separator, drop the
  // file extension. What remains is the per-video media id.
  //
  // NOTE: in practice TikTok serves different <hash> segments for
  // different renditions of the "same" video, so this strategy is
  // less reliable than author-match. Kept because it does hit when
  // both sides happen to pick the same rendition.
  function posterKey(url) {
    if (typeof url !== "string" || !url) return "";
    try {
      const base = typeof location !== "undefined" ? location.href : "https://www.tiktok.com";
      const u = new URL(url, base);
      const path = u.pathname || "";
      const last = path.slice(path.lastIndexOf("/") + 1);
      return last.split("~")[0].replace(/\.[a-z]+$/i, "");
    } catch {
      return "";
    }
  }

  // ---- DOM extraction ----

  // Scan a post container for its profile anchor `<a href="/@<user>">`
  // (NOT a /@<user>/video/<id> permalink) and return the username.
  // Each feed card has exactly one such anchor — wrapping the avatar
  // and the handle. Returns "" if zero or multiple distinct authors
  // appear, so downstream tiers can try instead of guessing.
  function extractAuthorFromAnchors(postEl) {
    if (!postEl || typeof postEl.querySelectorAll !== "function") return "";
    const seen = new Set();
    const authors = [];
    for (const a of postEl.querySelectorAll('a[href^="/@"]')) {
      const href = (a.getAttribute && a.getAttribute("href")) || "";
      const m = href.match(/^\/@([^/?#]+)(\/?|\/?\?.*|\/?#.*)$/);
      if (!m) continue;
      const author = m[1];
      if (!author || seen.has(author)) continue;
      seen.add(author);
      authors.push(author);
    }
    return authors.length === 1 ? authors[0] : "";
  }

  // ---- API payload shapes ----

  // Normalize a raw TikTok API item into the compact cache shape.
  // Returns null for malformed items so Array.filter can drop them.
  function toSummary(it) {
    if (!it || typeof it !== "object") return null;
    const id = typeof it.id === "string" ? it.id : it.id != null ? String(it.id) : "";
    if (!/^\d{10,}$/.test(id)) return null;
    const author = it.author || {};
    const video = it.video || {};
    return {
      id,
      authorId: author.uniqueId || "",
      authorNickname: author.nickname || "",
      desc: typeof it.desc === "string" ? it.desc.slice(0, 240) : "",
      playAddr: typeof video.playAddr === "string" ? video.playAddr : "",
      downloadAddr: typeof video.downloadAddr === "string" ? video.downloadAddr : "",
      cover: video.cover || video.originCover || "",
      duration: typeof video.duration === "number" ? video.duration : 0,
    };
  }

  // Extract items from a TikTok API response body. Handles several
  // payload shapes:
  //   /api/recommend/item_list/ · /api/post/item_list/ → {itemList: [...]}
  //   /api/item/detail/                                 → {itemInfo: {itemStruct: {...}}}
  //   /api/item/list/                                   → {items: [...]}
  function extractItems(payload) {
    if (!payload || typeof payload !== "object") return [];
    const out = [];
    const arrays = [payload.itemList, payload.items, payload.aweme_list];
    for (const list of arrays) {
      if (!Array.isArray(list)) continue;
      for (const it of list) {
        const s = toSummary(it);
        if (s) out.push(s);
      }
    }
    const single = toSummary(payload.itemInfo && payload.itemInfo.itemStruct);
    if (single && !out.some((o) => o.id === single.id)) out.push(single);
    return out;
  }

  // Walk a TikTok SSR blob looking for embedded video items. Tries
  // well-known route keys first (so items land in feed-render order),
  // then does a depth-limited recursive sweep for anything missed.
  // De-dupes by id.
  function collectSeedItems(blob) {
    if (!blob || typeof blob !== "object") return [];
    const scope = blob.__DEFAULT_SCOPE__ || {};
    const seen = new Set();
    const out = [];
    function push(rawItem) {
      const s = toSummary(rawItem);
      if (!s || seen.has(s.id)) return;
      seen.add(s.id);
      out.push(s);
    }
    const orderedKeys = [
      "webapp.reflow",
      "webapp.trending",
      "webapp.explore",
      "webapp.recommend",
      "webapp.video-list",
      "webapp.user-list",
    ];
    for (const key of orderedKeys) {
      const sub = scope[key];
      if (sub && Array.isArray(sub.itemList)) {
        for (const it of sub.itemList) push(it);
      }
    }
    const detail = scope["webapp.video-detail"];
    if (detail && detail.itemInfo && detail.itemInfo.itemStruct) push(detail.itemInfo.itemStruct);
    function walk(node, depth) {
      if (depth > WALK_MAX_DEPTH || !node) return;
      if (Array.isArray(node)) {
        for (const it of node) walk(it, depth + 1);
        return;
      }
      if (typeof node !== "object") return;
      if (
        typeof node.id === "string" &&
        /^\d{10,}$/.test(node.id) &&
        node.author &&
        typeof node.author.uniqueId === "string"
      ) {
        push(node);
        return;
      }
      for (const k of Object.keys(node)) walk(node[k], depth + 1);
    }
    walk(scope, 0);
    return out;
  }

  // ---- API endpoint targeting ----

  // Does this URL look like a TikTok API response that might carry
  // video items? Prefix+suffix match rather than a closed list of
  // regexes so newly-introduced endpoints (e.g. /api/preload/item_list/)
  // get captured without code changes.
  function isTargetUrl(url) {
    if (typeof url !== "string" || !url) return false;
    if (!/tiktok\.com\/api\//i.test(url)) return false;
    const pathOnly = url.split("?")[0].replace(/\/$/, "");
    return /\/(item_list|item\/list|item\/detail|item\/feed|init_page)$/i.test(pathOnly);
  }

  // ---- Strategy: resolve a post's canonical URL ----
  //
  // Shared between the content-script click handler and the
  // tt:get-current-url message handler. Three tiers, each returning
  // a result only when it can identify the post with confidence.
  // Tiers that returned wrong answers in prior iterations (article-
  // index, document-bulk-regex, post-anchors on prefetch links,
  // poster-match across image renditions) are deliberately absent.
  //
  // Inputs:
  //   postEl       — post container element (feed card OR detail
  //                  layout root). May be null when called from the
  //                  popup without a specific post.
  //   cacheItems   — array of cached API items (from the interceptor).
  //                  Passed in so the function stays pure and the
  //                  caller owns cache-lifetime concerns.
  //   locationHref — window.location.href (injected for testability;
  //                  callers pass location.href or a stub).
  //
  // Returns `{url, tier, tried}`. `url` is "" and `tier` is "" when
  // every tier missed; `tried` is the ordered list of tier names
  // actually attempted — useful for diagnostics on failure.
  function findCanonicalUrlForPost(postEl, cacheItems, locationHref) {
    const tried = [];
    const items = Array.isArray(cacheItems) ? cacheItems : [];

    // Tier 1 — author-match. Each feed card has exactly one
    // /@<username> profile anchor. If the cache contains exactly one
    // item with that authorId, we've pinpointed the visible video.
    if (postEl) {
      tried.push("author-match");
      const author = extractAuthorFromAnchors(postEl);
      if (author) {
        const matches = [];
        for (const it of items) {
          if (it && it.authorId === author && it.id) matches.push(it);
        }
        if (matches.length === 1) {
          return {
            url: `https://www.tiktok.com/@${matches[0].authorId}/video/${matches[0].id}`,
            tier: "author-match",
            tried,
          };
        }
        // Multiple cache entries share the author — ambiguous.
        // Fall through; the bulk-regex tier may narrow it down.
      }
    }

    // Tier 2 — location.href. Trust the URL bar when it carries a
    // canonical /@user/video/<id> (TikTok updates it as the user
    // scrolls the For You feed and whenever a profile-modal opens).
    tried.push("location-href");
    if (ABS_VIDEO_URL_RE.test(locationHref || "")) {
      return {
        url: canonicalPostUrl(locationHref),
        tier: "location-href",
        tried,
      };
    }

    // Tier 3 — post-bulk-regex. Regex sweep of postEl.outerHTML for
    // any canonical URL. Scoped to the post container so it can't
    // pick up an unrelated sibling-card or sidebar URL.
    if (postEl && typeof postEl.outerHTML === "string") {
      tried.push("post-bulk-regex");
      const hit = BULK_URL_RE.exec(postEl.outerHTML);
      if (hit && hit[0]) {
        return { url: hit[0], tier: "post-bulk-regex", tried };
      }
    }

    return { url: "", tier: "", tried };
  }

  // ---- Export ----
  const g = typeof window !== "undefined" ? window : globalThis;
  g.__ytdlpTtShared = {
    // constants
    CACHE_MAX,
    BATCH_MAX,
    MIN_SCRIPT_LEN,
    WALK_MAX_DEPTH,
    // regexes
    BULK_URL_RE,
    ABS_VIDEO_URL_RE,
    VIDEO_PATH_RE,
    // fns
    canonicalPostUrl,
    cdnUrlKey,
    posterKey,
    extractAuthorFromAnchors,
    toSummary,
    extractItems,
    collectSeedItems,
    isTargetUrl,
    findCanonicalUrlForPost,
  };
})();
