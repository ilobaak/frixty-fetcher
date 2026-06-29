// @ts-check

// TikTok helpers. yt-dlp's TikTok extractor handles `/@<user>/video/<id>`
// and `/@<user>/photo/<id>` URLs cleanly, but tiktok.com's SPA keeps the
// address bar on the feed URL (`/`, `/foryou`, `/en/`) even while a video
// is playing. To make "Fetch media on this page" work from the feed we
// inject a tiny page-world scraper that returns the currently-visible
// post's canonical URL.
//
// Exports:
//   looksLikeTikTok(url)         — hostname check (tiktok.com + any subdomain)
//   isTikTokVideoUrl(url)        — pathname is a specific video or photo post
//   isTikTokPhotoUrl(url)        — narrower: pathname is /@user/photo/<id>
//   resolveTikTokUrlFromDom()    — scrape active tab for visible post URL
//   getTikTokPhotoInfo(tabUrl)   — DOM-scrape image URLs out of a photo post

import { basenameFromUrl, extensionFromUrl } from "./shared.js";
import { logFetcher } from "./fetcher-log.js";

const HOST_RE = /(^|\.)tiktok\.com$/i;
const VIDEO_PATH_RE = /^\/@[^/]+\/(?:video|photo)\/\d+/i;
const PHOTO_PATH_RE = /^\/@[^/]+\/photo\/\d+/i;

export function looksLikeTikTok(url) {
  if (typeof url !== "string") return false;
  try {
    return HOST_RE.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

export function isTikTokVideoUrl(url) {
  if (typeof url !== "string") return false;
  try {
    const u = new URL(url);
    if (!HOST_RE.test(u.hostname)) return false;
    return VIDEO_PATH_RE.test(u.pathname);
  } catch {
    return false;
  }
}

// isTikTokPhotoUrl reports whether the URL specifically names a TikTok
// photo (slideshow) post — distinct from videos because photo posts
// render image carousels, not video, and the popup needs a different
// flow to download them as a gallery rather than via yt-dlp's
// (incomplete-for-the-popup-UI) format listing.
export function isTikTokPhotoUrl(url) {
  if (typeof url !== "string") return false;
  try {
    const u = new URL(url);
    if (!HOST_RE.test(u.hostname)) return false;
    return PHOTO_PATH_RE.test(u.pathname);
  } catch {
    return false;
  }
}

// resolveTikTokUrlFromDom runs a page-world scraper that tries to find
// the currently-visible post's canonical URL. Always returns the
// scraper's full result shape `{url, source, tried}` (url is "" when
// no strategy matched) so the caller can log which strategies ran
// regardless of success. Returns null only when executeScript itself
// threw (missing host permission, closed tab, etc.).
//
// If the DOM scrape comes up empty, we also query the tiktok-post-grab
// content script — it maintains a cache of video metadata intercepted
// from TikTok's private APIs via the MAIN-world tiktok-interceptor.js,
// which is the only reliable signal on logged-out feed pages.
export async function resolveTikTokUrlFromDom() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id === undefined) return null;
  logFetcher("tiktok", "dom-resolve:start", { tabUrl: tab.url || "" });
  let out = null;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scrapeVisiblePostUrl,
    });
    out = results?.[0]?.result;
    if (!out || typeof out !== "object") out = null;
  } catch (e) {
    logFetcher("tiktok", "dom-resolve:exception", { error: e?.message || String(e) });
    out = null;
  }
  if (out && out.url) {
    logFetcher("tiktok", "dom-resolve:result", { resolvedUrl: out.url, source: out.source || "" });
    return out;
  }
  // DOM scrape missed — ask the content script's interceptor cache.
  try {
    const resp = await new Promise((resolve) => {
      chrome.tabs.sendMessage(tab.id, { type: "tt:get-current-url" }, (r) => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(r || null);
      });
    });
    if (resp && resp.url) {
      const tried = out && out.tried ? [...out.tried, "interceptor-cache"] : ["interceptor-cache"];
      logFetcher("tiktok", "dom-resolve:result", {
        resolvedUrl: resp.url,
        source: "interceptor-cache",
      });
      return { url: resp.url, source: "interceptor-cache", tried };
    }
  } catch {}
  // Still nothing — peek at the page-world cache directly via MAIN-
  // world executeScript. This bypasses the isolated-world message
  // bridge entirely; if the interceptor is running at all, its
  // cache lives in window.__ytdlpTtCache.
  try {
    const mainResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: dumpInterceptCache,
    });
    const dump = mainResults?.[0]?.result;
    if (dump) {
      const tried =
        out && out.tried
          ? [...out.tried, "interceptor-cache", "main-world-cache"]
          : ["main-world-cache"];
      if (dump.url) {
        logFetcher("tiktok", "dom-resolve:result", {
          resolvedUrl: dump.url,
          source: "main-world-cache",
        });
        return { url: dump.url, source: "main-world-cache", tried };
      }
      // No URL but cache info — surface it in tried-array for
      // diagnostics even on the no-match return.
      if (out) out.tried = tried;
      if (out) {
        out.interceptorStats = {
          installed: !!dump.installed,
          hits: dump.hits,
          misses: dump.misses,
          cacheSize: dump.cacheSize,
        };
      }
    }
  } catch {}
  logFetcher("tiktok", "dom-resolve:no-match", { tried: out?.tried || [] });
  return out;
}

// Runs in MAIN world. Checks the interceptor's page-world cache and
// picks the canonical URL for whichever post is currently centered
// in the viewport. Self-contained — must not close over any bindings
// from tiktok.js.
function dumpInterceptCache() {
  // window.__ytdlpTt is set by tiktok-interceptor.js (MAIN-world).
  // Cast through any since it's not a standard Window property.
  const state = /** @type {any} */ (window).__ytdlpTt || {};
  const installed = !!state.loaded;
  const cache = Array.isArray(state.cache) ? state.cache : [];
  const hits = state.hits || 0;
  const misses = state.misses || 0;
  let url = "";
  let pick = null;
  let source = "";

  function poster(u) {
    if (typeof u !== "string" || !u) return "";
    try {
      const pp = new URL(u, location.href).pathname || "";
      const last = pp.slice(pp.lastIndexOf("/") + 1);
      return last.split("~")[0].replace(/\.[a-z]+$/i, "");
    } catch {
      return "";
    }
  }
  function videoKey(u) {
    if (typeof u !== "string" || !u) return "";
    try {
      const pp = new URL(u, location.href).pathname || "";
      return pp.slice(pp.lastIndexOf("/")).replace(/\.mp4.*$/i, ".mp4");
    } catch {
      return "";
    }
  }

  // Find the viewport-centered article.
  let centered = null;
  try {
    const vh = window.innerHeight || document.documentElement.clientHeight;
    let bestDist = Infinity;
    const articleSel =
      'article[id^="one-column-item-"], article[id^="feed-item-"], article[id^="video-item-"]';
    for (const a of document.querySelectorAll(articleSel)) {
      const r = a.getBoundingClientRect();
      if (r.bottom <= 0 || r.top >= vh) continue;
      const centerY = r.top + r.height / 2;
      const dist = Math.abs(centerY - vh / 2);
      if (dist < bestDist) {
        bestDist = dist;
        centered = a;
      }
    }
  } catch {}

  // Strategy A — author-match. Each card has exactly one plain
  // /@<username> profile anchor (not a /@user/video/<id> permalink)
  // pointing to the displayed video's author. Find it, then look
  // up cache entries where authorId matches. One match = we win.
  if (centered) {
    try {
      const seen = new Set();
      const authors = [];
      for (const a of centered.querySelectorAll('a[href^="/@"]')) {
        const href = a.getAttribute("href") || "";
        const m = href.match(/^\/@([^/?#]+)(\/?|\/?\?.*|\/?#.*)$/);
        if (!m || !m[1] || seen.has(m[1])) continue;
        seen.add(m[1]);
        authors.push(m[1]);
      }
      if (authors.length === 1) {
        const author = authors[0];
        const matches = cache.filter((it) => it.authorId === author && it.id);
        if (matches.length === 1) {
          pick = matches[0];
          source = "author-match";
        }
      }
    } catch {}
  }

  // Strategy B — poster-hash match. Shared CDN image hash between the
  // article's <img> src and the cached item's video.cover / video.
  // originCover. Runs after author-match because the hash extraction
  // is fragile across TikTok's image renditions.
  if (!pick && centered) {
    try {
      for (const img of centered.querySelectorAll("img")) {
        const src = img.currentSrc || img.src || "";
        if (!src || !/tiktok/.test(src)) continue;
        const key = poster(src);
        if (!key) continue;
        for (const it of cache) {
          if (poster(it.cover) === key || poster(it.originCover) === key) {
            pick = it;
            source = "poster-match";
            break;
          }
        }
        if (pick) break;
      }
    } catch {}
  }

  // Strategy C — <video>.src CDN-URL key match (plain CDN only).
  if (!pick && centered) {
    try {
      for (const v of centered.querySelectorAll("video")) {
        const key = videoKey(v.currentSrc || v.src || "");
        if (!key) continue;
        for (const it of cache) {
          if (videoKey(it.playAddr) === key || videoKey(it.downloadAddr) === key) {
            pick = it;
            source = "video-src";
            break;
          }
        }
        if (pick) break;
      }
    } catch {}
  }

  // article-index was deliberately removed — it silently returned
  // wrong videos when the cache didn't align with article render
  // order (the common case on logged-out feed pages).

  // NOTE: deliberately no "most-recent-cached" fallback. Picking an
  // arbitrary entry causes the popup to fetch the WRONG video
  // silently, which the user then has to notice and cancel. Better
  // to return no url and let the popup surface a clear error.

  if (pick && pick.id && pick.authorId) {
    url = `https://www.tiktok.com/@${pick.authorId}/video/${pick.id}`;
  }
  return { installed, hits, misses, cacheSize: cache.length, url, source };
}

// Runs in the page's isolated world. Must be self-contained — no imports,
// no closures. Returns {url, source, tried} where tried[] lists which
// strategies were attempted (for diagnostics when none find a match).
function scrapeVisiblePostUrl() {
  const linkRe = /^\/@[^/]+\/(?:video|photo)\/\d+/i;
  const absLinkRe = /^https?:\/\/(?:[^.]+\.)?tiktok\.com\/@[^/]+\/(?:video|photo)\/\d+/i;
  const tried = [];

  // Strategy 1: viewport-centered <a> whose href matches /@user/video/<id>.
  // On logged-in feeds TikTok wraps each post in an anchor.
  tried.push("anchor-viewport");
  const anchors = Array.from(document.querySelectorAll("a[href]"));
  const viewportH = window.innerHeight || document.documentElement.clientHeight;
  const viewportW = window.innerWidth || document.documentElement.clientWidth;
  const viewportCenterY = viewportH / 2;
  const candidates = [];
  for (const a of anchors) {
    const href = a.getAttribute("href") || "";
    if (!linkRe.test(href) && !absLinkRe.test(href)) continue;
    const rect = a.getBoundingClientRect();
    if (rect.bottom <= 0 || rect.top >= viewportH) continue;
    if (rect.right <= 0 || rect.left >= viewportW) continue;
    const linkCenterY = rect.top + rect.height / 2;
    const distance = Math.abs(linkCenterY - viewportCenterY);
    const area = Math.max(0, rect.width) * Math.max(0, rect.height);
    candidates.push({ href, distance, area });
  }
  if (candidates.length > 0) {
    candidates.sort((a, b) => {
      if (a.distance !== b.distance) return a.distance - b.distance;
      return b.area - a.area;
    });
    try {
      return {
        url: new URL(candidates[0].href, location.href).toString(),
        source: "anchor-viewport",
        tried,
      };
    } catch {}
  }

  // Strategy 2: <link rel="canonical"> — TikTok's SPA updates this as
  // the user scrolls through the feed. Works for logged-out trending
  // views where anchors aren't rendered.
  tried.push("canonical");
  const canonical = document.querySelector('link[rel="canonical"]');
  const canonicalHref = canonical && canonical.getAttribute("href");
  if (canonicalHref && absLinkRe.test(canonicalHref)) {
    return { url: canonicalHref, source: "canonical", tried };
  }

  // Strategy 3: <meta property="og:url"> — Open Graph mirror of the
  // canonical URL, also SPA-updated.
  tried.push("og-url");
  const og = document.querySelector('meta[property="og:url"]');
  const ogContent = og && og.getAttribute("content");
  if (ogContent && absLinkRe.test(ogContent)) {
    return { url: ogContent, source: "og-url", tried };
  }

  // Strategy 4: __UNIVERSAL_DATA_FOR_REHYDRATION__ — the giant JSON
  // blob TikTok inlines on every page. Walk it recursively looking for
  // any object with the post shape {id, author:{uniqueId}}; that covers
  // both single-post routes (itemStruct) and feed routes (list items).
  tried.push("universal-data");
  const dataScript = document.querySelector(
    'script#__UNIVERSAL_DATA_FOR_REHYDRATION__[type="application/json"]',
  );
  if (dataScript && dataScript.textContent) {
    try {
      const blob = JSON.parse(dataScript.textContent);
      const found = findPostInTree(blob);
      if (found) {
        return {
          url: `https://www.tiktok.com/@${found.author}/video/${found.id}`,
          source: "universal-data",
          tried,
        };
      }
    } catch {}
  }

  // Strategy 5: any matching anchor, even offscreen.
  tried.push("anchor-first");
  for (const a of anchors) {
    const href = a.getAttribute("href") || "";
    if (!linkRe.test(href) && !absLinkRe.test(href)) continue;
    try {
      return { url: new URL(href, location.href).toString(), source: "anchor-first", tried };
    } catch {}
  }

  // Strategy 6: last-resort bulk regex over every inline <script> and
  // the document's outerHTML. TikTok seeds the current video URL into
  // multiple places (share links, embed fallbacks, preload hints) — if
  // ANY of them name a canonical video URL we'll take it. Can pick a
  // "wrong" video on feed pages, but "probably-correct-video" beats
  // "Unsupported URL".
  tried.push("bulk-regex");
  const bulkRe = /https?:\/\/(?:[^.]+\.)?tiktok\.com\/@[^/"'\s]+\/(?:video|photo)\/\d+/gi;
  const scanSources = [];
  for (const script of document.querySelectorAll("script")) {
    if (script.textContent) scanSources.push(script.textContent);
  }
  scanSources.push(document.documentElement.outerHTML || "");
  for (const src of scanSources) {
    bulkRe.lastIndex = 0;
    const match = bulkRe.exec(src);
    if (match && match[0]) {
      return { url: match[0], source: "bulk-regex", tried };
    }
  }

  return { url: "", source: "none", tried };
}

// findPostInTree walks a parsed JSON structure looking for the first
// object that looks like a TikTok post: has a string `id` and an
// `author.uniqueId` string. Returns {id, author} or null. Depth-capped
// so a pathological blob can't hang the scraper.
function findPostInTree(node, depth) {
  const d = depth || 0;
  if (d > 20 || node == null) return null;
  if (typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findPostInTree(item, d + 1);
      if (hit) return hit;
    }
    return null;
  }
  const id = node.id;
  const author = node.author && typeof node.author === "object" ? node.author.uniqueId : null;
  if (typeof id === "string" && /^\d{10,}$/.test(id) && typeof author === "string" && author) {
    return { id, author };
  }
  for (const key of Object.keys(node)) {
    const hit = findPostInTree(node[key], d + 1);
    if (hit) return hit;
  }
  return null;
}

// getTikTokPhotoInfo runs a DOM scraper in the active tab and reshapes
// what comes back into the {kind, title, handle, items|imageUrl}
// object the popup's image / gallery pickers expect. Used by the
// runFetchFlow TikTok branch when the URL is /@user/photo/<id> —
// yt-dlp's photo-mode extractor exists but its format listing
// (one entry per slide, plus an audio track) doesn't render cleanly
// in the video picker; scraping the slideshow images gives a clean
// gallery picker instead.
//
// Returns null when the scraper finds nothing (e.g. logged-out,
// images haven't loaded yet, page has shifted to a different post)
// so the caller can fall through to listFormats as a last resort.
export async function getTikTokPhotoInfo(tabUrl) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id === undefined) return null;
  logFetcher("tiktok", "photo-dom:start", { url: tabUrl });
  let scraped;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scrapeTikTokPhotoMedia,
    });
    scraped = results?.[0]?.result;
  } catch (e) {
    logFetcher("tiktok", "photo-dom:exception", { url: tabUrl, error: e?.message || String(e) });
    return null;
  }
  if (!scraped || !Array.isArray(scraped.images) || scraped.images.length === 0) {
    logFetcher("tiktok", "photo-dom:no-media", { url: tabUrl });
    return null;
  }
  logFetcher("tiktok", "photo-dom:scraped", {
    url: tabUrl,
    imageCount: scraped.images.length,
    handle: scraped.handle || "",
  });
  // Author handle: prefer DOM, fall back to URL path /@<handle>/photo/<id>.
  let handle = scraped.handle || "";
  if (!handle) {
    try {
      const m = new URL(tabUrl).pathname.match(/^\/@([^/]+)\/photo\//);
      if (m) handle = m[1];
    } catch {}
  }
  const items = scraped.images.map((i) => {
    const ext = extensionFromUrl(i.src) || "jpg";
    return {
      url: i.src,
      ext,
      width: i.width || 0,
      height: i.height || 0,
      thumbUrl: i.src,
      mime: ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "image/" + ext,
      basename: basenameFromUrl(i.src) || "image." + ext,
      handle,
    };
  });
  const title = scraped.title || "TikTok photo post";
  if (items.length === 1) {
    const i = items[0];
    logFetcher("tiktok", "photo-dom:image", { url: tabUrl, imageUrl: i.url });
    return {
      kind: "image",
      title,
      handle,
      imageUrl: i.url,
      thumbUrl: i.thumbUrl,
      width: i.width,
      height: i.height,
      mime: i.mime,
      basename: i.basename,
    };
  }
  logFetcher("tiktok", "photo-dom:gallery", { url: tabUrl, itemCount: items.length });
  return { kind: "gallery", title, handle, items };
}

// scrapeTikTokPhotoMedia is serialized into the active tab via
// chrome.scripting.executeScript — no extension-side imports, only
// plain JSON comes back. Walks the rendered DOM for slideshow images.
//
// TikTok's photo post layout puts slide images inside a swiper
// container; each <img> carries the post's TikTokCDN URL. Filtering
// rules:
//   - host on tiktokcdn.com / tiktokv.com (or contains "tiktok"; some
//     CDN edges use other hostnames)
//   - dimensions >= 200px on either axis (skips avatars, icons, the
//     sound-disc thumbnail, and other chrome)
//   - dedup by URL pathname so the same image at multiple sizes
//     collapses to one entry
function scrapeTikTokPhotoMedia() {
  const result = { images: [], handle: "", title: "" };
  // Pick the smallest container that actually represents the active
  // photo post. ORDER MATTERS:
  //   1. role="dialog" — TikTok's SPA opens a photo in a modal
  //      overlay when the user navigates from a profile/feed. Other
  //      content (the profile grid, chat sidebar, recommendation
  //      column) is still present in the DOM behind it. If we don't
  //      scope to the modal we grab dozens of unrelated images.
  //   2. [data-e2e="browse-video"] — the existing photo-as-route
  //      container TikTok uses when you navigate to /photo/<id>
  //      directly.
  //   3. <article> — last resort. ONLY pick the first one; falling
  //      through to all-articles or body re-introduces the cross-
  //      post leak.
  // No body fallback: if none of these match, return empty and let
  // the caller fall through to listFormats. Better to show "nothing"
  // than to show 95 unrelated images.
  const root =
    document.querySelector('[role="dialog"]') ||
    document.querySelector('[data-e2e="photo-detail-root"]') ||
    document.querySelector('[data-e2e="browse-video"]') ||
    document.querySelector("article");
  if (!root) return result;

  // Caption / desc — search inside the chosen scope only so a
  // background-page caption doesn't leak in.
  const descEl =
    root.querySelector('[data-e2e="browse-video-desc"]') ||
    root.querySelector('[data-e2e="video-desc"]') ||
    root.querySelector('[data-e2e="photo-desc"]');
  if (descEl) {
    result.title = (descEl.textContent || "").replace(/\s+/g, " ").trim();
  }
  const handleEl =
    root.querySelector('[data-e2e="browse-username"]') ||
    root.querySelector('[data-e2e="video-author-uniqueid"]');
  if (handleEl) {
    const t = (handleEl.textContent || "").trim().replace(/^@/, "");
    if (t) result.handle = t;
  }

  // Image filter:
  //   - hostname must be a TikTok CDN (rejects unrelated 3rd-party
  //     images that may bleed in via embeds)
  //   - dimensions must be substantial. Slideshow photos are
  //     ~720x1280+; profile-grid thumbnails are ~150-300; avatars
  //     are <100. 500px on either axis cuts the chrome cleanly.
  //   - dedup by URL pathname so the same photo at multiple sizes
  //     collapses to one entry.
  const seen = new Set();
  // Comments-section selectors. Comments render inside the modal scope
  // and any image attached to a comment (user avatar large variant,
  // image replies, sticker reactions) trips the size filter and leaks
  // into the gallery if not explicitly excluded.
  const commentSel =
    '[data-e2e="comment-list"], [data-e2e="comment-item"], ' +
    '[data-e2e="comment-list-item"], [data-e2e="search-comment-container"], ' +
    '[class*="CommentList"], [class*="CommentItem"]';
  for (const img of root.querySelectorAll("img")) {
    if (img.closest(commentSel)) continue;
    const src = img.currentSrc || img.src;
    if (!src) continue;
    if (!/tiktokcdn|tiktokv|tiktok\.com/i.test(src)) continue;
    const w = img.naturalWidth || img.width || 0;
    const h = img.naturalHeight || img.height || 0;
    if (w < 500 && h < 500) continue;
    let key;
    try {
      key = new URL(src).pathname;
    } catch {
      key = src;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    result.images.push({ src, width: w, height: h, alt: img.alt || "" });
  }
  return result;
}
