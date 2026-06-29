// Facebook / fb.watch detection + media resolution for the popup.
// Extracted from popup.js in the sprint-2 decomposition pass. Holds
// the interceptor-mining, DOM-scraping, and story/feed heuristics
// that together do the job the popup's "Fetch media on this page"
// button runs on Facebook tabs.
//
// Contains the 670-line scrapeFacebookMedia monster — serialized
// verbatim by chrome.scripting.executeScript and executed in the
// Facebook page's world, so it's intentionally self-contained with
// all its helpers nested inside. The other exported async functions
// (getFacebookDomInfo, getFacebookStoryFromInterceptor, etc.) are
// popup-world wrappers that coordinate executeScript calls and
// filter the returned data.

import { basenameFromUrl, extensionFromUrl, sanitizeFilenameSegment } from "./shared.js";
import { logFetcher } from "./fetcher-log.js";

const dlog = (step, ...args) => console.log("[frixty/fb]", step, ...args);

export function looksLikeFacebook(url) {
  if (typeof url !== "string") return false;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    return host === "facebook.com" || host.endsWith(".facebook.com") ||
           host === "fb.watch" || host.endsWith(".fb.watch");
  } catch {
    return false;
  }
}

// canonicalizeFacebookUrlForYtdlp rewrites a Facebook permalink into
// a shape yt-dlp's extractor recognizes:
//
//   - /photo/?fbid=<id>    → /photo.php?fbid=<id>
//     (yt-dlp's FacebookIE regex requires `photo.php?fbid=`; the
//     shorter `/photo/` variant Facebook serves in click targets is
//     rejected with "Unsupported URL".)
//
//   - strips Facebook's tracking-only query params (__cft__[*],
//     __tn__, __xts__[*]) that don't affect routing but do confuse
//     some extractors and bloat the visible URL in error messages.
//
// Pass-through for URLs that don't need rewriting, including
// non-Facebook hosts (caller should only use this for FB URLs but
// the guard lets us call it uniformly).
export function canonicalizeFacebookUrlForYtdlp(url) {
  if (typeof url !== "string" || !url) return url;
  let u;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  const host = u.hostname.toLowerCase();
  if (host !== "facebook.com" && !host.endsWith(".facebook.com")) {
    return url;
  }
  // Strip Facebook tracking params. Known prefixes: __cft__, __tn__,
  // __xts__, __eep__, comment_tracking. These are routing-neutral.
  for (const key of Array.from(u.searchParams.keys())) {
    if (/^(__cft__|__tn__|__xts__|__eep__|comment_tracking|_rdr$|notif_t$)/i.test(key)) {
      u.searchParams.delete(key);
    }
  }
  // /photo/?fbid=<id> → /photo.php?fbid=<id>. Match /photo alone or
  // /photo/ (trailing slash), both with and without a trailing query.
  if (/^\/photo\/?$/.test(u.pathname) && u.searchParams.has("fbid")) {
    u.pathname = "/photo.php";
  }
  return u.toString();
}

// isFacebookVideoUrl matches the URL shapes Facebook uses for native
// video content. For these we skip DOM scraping and hand off to yt-dlp
// directly because its Facebook extractor handles them well (with
// cookies). Non-video shapes (photos, posts, stories) route through
// the scraper because yt-dlp can't surface static images.
export function isFacebookVideoUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const p = u.pathname;
    if (host === "fb.watch" || host.endsWith(".fb.watch")) return true;
    if (p.startsWith("/watch/") || p.startsWith("/watch")) return true;
    if (p.startsWith("/reel/")) return true;
    // /<user-or-page>/videos/<id>/
    if (/^\/[^/]+\/videos\//.test(p)) return true;
    return false;
  } catch {
    return false;
  }
}



// readFacebookInterceptorCache pulls whatever window.__ytdlpFbCache
// has accumulated on the active tab. The cache is filled by
// facebook-interceptor.js (MAIN world, document_start) — it snapshots
// every fetch/XHR response whose body mentions playable_url /
// preferred_thumbnail / native_hd_url / creation_story. Story
// navigation triggers GraphQL calls that never land in the initial
// HTML, so this cache is the only way to observe them client-side.
export async function readFacebookInterceptorCache() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return { loaded: false, version: 0, fetchCount: 0, xhrCount: 0, captureCount: 0, cache: [] };
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: () => ({
        loaded: !!window.__ytdlpFbInterceptorLoaded,
        version: window.__ytdlpFbInterceptorVersion || 0,
        fetchCount: window.__ytdlpFbFetchCount || 0,
        xhrCount: window.__ytdlpFbXhrCount || 0,
        captureCount: window.__ytdlpFbCaptureCount || 0,
        cache: (window.__ytdlpFbCache || []).map((e) => ({
          url: String(e.url || ""),
          text: String(e.text || ""),
          time: e.time || 0,
        })),
      }),
    });
    return results?.[0]?.result || { loaded: false, version: 0, fetchCount: 0, xhrCount: 0, captureCount: 0, cache: [] };
  } catch (err) {
    dlog("facebook interceptor read failed", err?.message);
    return { loaded: false, version: 0, fetchCount: 0, xhrCount: 0, captureCount: 0, cache: [] };
  }
}

// visibleFacebookStoryPosterToken reads the active story's visible
// thumbnail URL off the DOM and extracts its unique ~24-char path
// token. Used to select the matching GraphQL response out of the
// interceptor cache.
export async function visibleFacebookStoryPosterToken() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return "";
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        for (const img of document.querySelectorAll("img")) {
          const src = img.currentSrc || img.src || "";
          const m = /\/m1\/v\/t0\.65075-6\/([A-Za-z0-9_\-]{16,})/.exec(src);
          if (!m) continue;
          const rect = img.getBoundingClientRect();
          if (rect.width >= 200 || rect.height >= 200 ||
              (img.naturalWidth || 0) >= 400) {
            return m[1].slice(0, 24);
          }
        }
        return "";
      },
    });
    return results?.[0]?.result || "";
  } catch { return ""; }
}

// getFacebookStoryFromInterceptor mines every cached GraphQL response
// for both image and video media. Each unique media URL becomes one
// gallery item, tagged with the post's author + creation time as they
// appear in the Relay payload (so per-item handles are correct even
// on the home feed where the DOM uses no stable post-wrapper). Returns
// a gallery-info object or null if the cache is empty or installed-
// but-no-captures.
export async function getFacebookStoryFromInterceptor() {
  const status = await readFacebookInterceptorCache();
  logFetcher("facebook", "interceptor:status", {
    loaded: !!status.loaded,
    fetchCount: status.fetchCount,
    xhrCount: status.xhrCount,
    captureCount: status.captureCount,
    cacheCount: status.cache.length,
  });
  dlog(
    "facebook interceptor status",
    "loaded=" + (status.loaded ? "y" : "n"),
    "v=" + status.version,
    "fetches=" + status.fetchCount,
    "xhrs=" + status.xhrCount,
    "captures=" + status.captureCount,
    "cache=" + status.cache.length,
  );
  const cache = status.cache;
  if (!status.loaded) {
    dlog("facebook interceptor NOT INSTALLED — did you refresh the Facebook tab after reloading the extension?");
    return null;
  }
  if (cache.length === 0) return null;

  const posterToken = await visibleFacebookStoryPosterToken();
  dlog("facebook interceptor token", "token=" + (posterToken || "-"));

  // On /marketplace/item/<id> we're looking at ONE specific listing,
  // not a feed. The graphql cache mixes that listing's photos with
  // sidebar "related listings" responses, and the feed-style date
  // gate (require a creation_time/publish_time nearby) selects the
  // sidebar photos (those sit next to post timestamps) and misses
  // the listing's own photos (those are nested under a
  // GroupCommerceProductItem node that doesn't keep a timestamp
  // adjacent to each CatalogMarketplaceEnhancementTransformedImage
  // uri). Instead, scope by the numeric listing id from the URL —
  // it reliably appears as "id":"<N>" or "legacy_id":"<N>" on the
  // listing node within ±12KB of its photos.
  let marketplaceItemId = "";
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const pathname = tab?.url ? new URL(tab.url).pathname : "";
    const mm = /^\/marketplace\/item\/(\d+)/.exec(pathname);
    if (mm) marketplaceItemId = mm[1];
  } catch {}
  if (marketplaceItemId) {
    dlog("facebook interceptor marketplace scope", "itemId=" + marketplaceItemId);
  }

  const unesc = (s) => s.replace(/\\u0026/g, "&").replace(/\\\//g, "/");

  // Author + creation time from a window of the response text. The
  // Relay payload wraps every post in a node that carries one of
  // owner/actors/message_sender.name plus creation_time/publish_time
  // — we grab whichever form appears first in the local window. Any
  // numeric-only name is rejected since those are raw profile IDs.
  const extractMeta = (win) => {
    let name = "";
    for (const p of [
      /"owner":\{[^}]*?"name":"([^"]+)"/,
      /"actors":\[\{[^}]*?"name":"([^"]+)"/,
      /"message_sender":\{[^}]*?"name":"([^"]+)"/,
      /"story_card_info":\{[^}]*?"name":"([^"]+)"/,
    ]) {
      const nm = p.exec(win);
      if (nm && nm[1]) {
        const candidate = unesc(nm[1]).trim();
        if (candidate && !/^\d+$/.test(candidate)) { name = candidate; break; }
      }
    }
    let date = 0;
    for (const p of [/"creation_time":(\d+)/, /"publish_time":(\d+)/]) {
      const dm = p.exec(win);
      if (dm && dm[1]) { date = parseInt(dm[1], 10) || 0; break; }
    }
    return { name, date };
  };

  // isContentPhotoUrl filters candidate photo URIs down to real post
  // media. Facebook's CDN path segments encode the bucket:
  //  - t39.30808-6  feed / album photo (content)
  //  - t39.84726-6  marketplace CatalogMarketplaceEnhancementTransformedImage
  //  - t15.5256-*   video thumbnails
  //  - t51.*        stories, reels thumbs, public profile posts
  //  - t45.*        sponsored / ad creative
  //  - t58.*-6      some newer feed posts
  //  - t39.30808-0/1, t1.6435-1, t1.30497-1  PROFILE photos (avatars)
  // Keep content buckets, drop avatar buckets. FB mints new "t39.<N>-6"
  // bucket numbers for each product area (marketplace uses 84726,
  // groups used 46305, etc.), so match any t39.*-6 variant.
  const isContentPhotoUrl = (url) => {
    try {
      const u = new URL(url);
      const host = u.hostname.toLowerCase();
      if (!/(^|\.)fbcdn\.net$|(^|\.)fbsbx\.com$|^scontent[\-.]/.test(host)) return false;
      const path = u.pathname;
      if (/\/v\/t(?:39\.30808-[01]|1\.6435-1|1\.30497-1)\//.test(path)) return false;
      if (/\/v\/t(?:39\.\d+-6|15\.5256-\d+|51\.[\d.-]+|45\.[\d.-]+|58\.[\d.-]+-6)\//.test(path)) return true;
      return false;
    } catch { return false; }
  };

  const byKey = new Map(); // dedup key → item
  // Facebook serves the same video at multiple bitrates from filenames
  // like "<someId>_<videoId>_<variantId>_n.mp4". The middle underscored
  // number is the stable per-video id; collapse bitrate variants into
  // one gallery item by keying on it when present. Fall back to the
  // URL pathname so images (which lack that structure) still dedup.
  const keyFor = (url) => {
    try {
      const path = new URL(url).pathname;
      const m = /\/(\d+)_(\d+)_(\d+)_[a-z]\.[a-z0-9]+$/i.exec(path);
      if (m) return "v:" + m[2];
      return path;
    } catch { return url; }
  };
  // scopeGate: is this local graphql window part of the page's "main"
  // content? Feed pages identify main posts by a creation_time /
  // publish_time nearby (sidebar rails don't have those). Marketplace
  // item pages identify the main listing by its numeric id; feed-style
  // timestamp proximity doesn't work there. Match the item id as a
  // bare substring — FB's graphql encodes the same listing id in
  // several shapes ("id":"<N>", "legacy_id":"<N>", "pkey":<N>, bare
  // numeric values inside storage paths, etc.) and requiring one
  // specific quoted form misses the others. The id itself is a
  // 16–17-digit number, long enough that accidental collisions are
  // negligible.
  const scopeGate = marketplaceItemId
    ? (win) => win.includes(marketplaceItemId)
    : (win) => /"(?:creation_time|publish_time)":\d+/.test(win);

  // Pass 1: videos. Scan for any quoted URL value ending in .mp4/.m4v
  // in the cache — catches playable_url, browser_native_*,
  // playable_url_quality_hd, and any newer field name Facebook may
  // alias to. Each unique URL becomes one item.
  //
  // Note: Facebook's feed GraphQL doesn't include playable_url until
  // a video actually starts playing (autoplay or user click). If the
  // user's autoplay is disabled and they only scrolled past videos
  // without letting them play, the cache will contain Video *nodes*
  // (thumbnails, IDs, author) but no playable URL — videoCount will
  // be 0 even though videoNodeCount is non-zero. Diagnostic below.
  const videoUrlRe = /"(?:https?:\\\/\\\/[^"\s]+\.(?:mp4|m4v)(?:\?[^"]*)?)"/g;
  let mp4TotalMatches = 0;
  let mp4AfterScopeGate = 0;
  for (const entry of cache) {
    videoUrlRe.lastIndex = 0;
    let m;
    while ((m = videoUrlRe.exec(entry.text)) !== null) {
      mp4TotalMatches++;
      const rawWithQuotes = m[0];
      const videoUrl = unesc(rawWithQuotes.slice(1, -1));
      if (!videoUrl.startsWith("https://")) continue;
      const key = keyFor(videoUrl);
      if (byKey.has(key)) continue;
      const start = Math.max(0, m.index - 6000);
      const end = Math.min(entry.text.length, m.index + 12000);
      const win = entry.text.slice(start, end);
      // Require a creation_time / publish_time in the local window —
      // same gate images use. Drops story rail preloaded previews
      // (they sit in story-card nodes without post timestamps) while
      // keeping feed post videos. Author name is often missing for
      // group / page posts, so don't require it.
      if (!scopeGate(win)) continue;
      mp4AfterScopeGate++;
      const meta = extractMeta(win);
      let poster = "";
      const pm = /"uri":"(https:[^"]+)"/.exec(win.slice(m.index - start));
      if (pm) poster = unesc(pm[1]);
      let score = 0;
      if (posterToken && win.includes(posterToken)) score += 100;
      byKey.set(key, {
        kind: "video",
        url: videoUrl,
        name: meta.name,
        date: meta.date,
        poster,
        score,
      });
    }
  }
  // Diagnostic: how many Video nodes are in the cache regardless of
  // whether they had direct URLs? Helps disambiguate "no videos in
  // feed" vs "videos are there but autoplay never triggered so their
  // mp4 URLs never loaded."
  let videoNodeCount = 0;
  for (const entry of cache) {
    const matches = entry.text.match(/"__typename":"(?:Video|Reel)"/g);
    if (matches) videoNodeCount += matches.length;
  }

  // Pass 2: images. Scan every "uri":"..." in the cached text, unescape,
  // filter to Facebook content CDN paths, dedup by pathname. Require a
  // creation_time / publish_time to be nearby so we don't pick up
  // sidebar suggestion thumbnails that appear without a post date
  // (the user wants what they scrolled past, not Facebook's "Suggested
  // for you" rail).
  const uriRe = /"uri":"(https?:\\\/\\\/[^"]+)"/g;
  let uriTotalMatches = 0;
  let contentPhotoMatches = 0;
  let contentPhotoAfterScopeGate = 0;
  for (const entry of cache) {
    uriRe.lastIndex = 0;
    let m;
    while ((m = uriRe.exec(entry.text)) !== null) {
      uriTotalMatches++;
      const url = unesc(m[1]);
      if (!isContentPhotoUrl(url)) continue;
      contentPhotoMatches++;
      const key = keyFor(url);
      if (byKey.has(key)) continue;
      const start = Math.max(0, m.index - 6000);
      const end = Math.min(entry.text.length, m.index + 12000);
      const win = entry.text.slice(start, end);
      if (!scopeGate(win)) continue;
      contentPhotoAfterScopeGate++;
      const meta = extractMeta(win);
      byKey.set(key, {
        kind: "image",
        url,
        name: meta.name,
        date: meta.date,
        poster: url,
        score: posterToken && win.includes(posterToken) ? 100 : 0,
      });
    }
  }

  // Pre-filter counters so we can see, when items is 0, WHERE the
  // drop happened — too few mp4 URLs, URLs not passing content-path
  // filter, or metadata-gate filtering everything out. Also sample
  // typename frequency to check whether feed-post nodes are present.
  let creationTimeCount = 0;
  const typenameCounts = {};
  for (const entry of cache) {
    const ct = entry.text.match(/"(?:creation_time|publish_time)":\d+/g);
    if (ct) creationTimeCount += ct.length;
    const tn = entry.text.match(/"__typename":"([A-Za-z]+)"/g) || [];
    for (const t of tn) {
      const name = t.slice(13, -1);
      typenameCounts[name] = (typenameCounts[name] || 0) + 1;
    }
  }
  const topTypenames = Object.entries(typenameCounts)
    .sort((a, b) => b[1] - a[1]).slice(0, 10);
  dlog(
    "facebook interceptor cache stats",
    "mp4Total=" + mp4TotalMatches,
    "mp4AfterScopeGate=" + mp4AfterScopeGate,
    "uriTotal=" + uriTotalMatches,
    "contentPhotoMatches=" + contentPhotoMatches,
    "contentPhotoAfterScopeGate=" + contentPhotoAfterScopeGate,
    "scopeMode=" + (marketplaceItemId ? "marketplace:" + marketplaceItemId : "feed:date"),
    "creationTimes=" + creationTimeCount,
    "videoNodes=" + videoNodeCount,
    "topTypenames=" + JSON.stringify(topTypenames),
    "cacheUrls=" + JSON.stringify(cache.slice(0, 3).map((e) => (e.url || "").slice(0, 80))),
  );

  const items = [...byKey.values()];
  if (items.length === 0) {
    dlog("facebook interceptor: no media URLs passed filters");
    return null;
  }

  // Order: poster-token matches first (story scope), then newest first
  // by creation_time so the most recently-scrolled posts surface at the
  // top of the gallery. Items with no date sink to the bottom.
  items.sort((a, b) => (b.score - a.score) || ((b.date || 0) - (a.date || 0)));

  const videoCount = items.filter((i) => i.kind === "video").length;
  const imageCount = items.length - videoCount;
  dlog(
    "facebook interceptor media found",
    "total=" + items.length,
    "images=" + imageCount,
    "videos=" + videoCount,
    "videoNodesInCache=" + videoNodeCount,
  );
  if (videoNodeCount > 0 && videoCount === 0) {
    dlog(
      "facebook interceptor: cache has video nodes but no playable URLs — " +
      "autoplay probably didn't trigger. Let videos play (or click them) " +
      "before opening the popup."
    );
  }

  return {
    kind: "gallery",
    title: `Facebook feed (${items.length})`,
    handle: "",
    date: items[0].date,
    items: items.map((i) => {
      const isVideo = i.kind === "video";
      const ext = isVideo ? "mp4" : (extensionFromUrl(i.url) || "jpg");
      return {
        url: i.url,
        ext,
        width: 0,
        height: 0,
        thumbUrl: i.poster || (isVideo ? "" : i.url),
        mime: isVideo ? "video/mp4" : `image/${ext === "jpg" ? "jpeg" : ext}`,
        basename: isVideo
          ? (i.name
              ? safeBasenameFromName(i.name) + ".mp4"
              : (basenameFromUrl(i.url) || "video.mp4"))
          : (basenameFromUrl(i.url) || `photo.${ext}`),
        handle: i.name,
      };
    }),
  };
}

export function safeBasenameFromName(name) {
  if (!name) return "story";
  return sanitizeFilenameSegment(name).slice(0, 60) || "story";
}


// getFacebookDomInfo runs a scraper in the active tab to extract the
// images (and optionally videos) Facebook rendered on the page. Facebook
// has no stable public API like Instagram's reels_media, so DOM scraping
// is the baseline. Returns null when nothing usable is found so the
// caller can fall through to yt-dlp.
export async function getFacebookDomInfo() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id === undefined) return null;

  let scraped;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scrapeFacebookMedia,
    });
    scraped = results?.[0]?.result;
  } catch (err) {
    dlog("facebook scrape failed", err?.message);
    logFetcher("facebook", "dom:exception", { error: err?.message || String(err) });
    return null;
  }
  if (!scraped) return null;
  // Log each field as a separate argument so they're readable inline in
  // DevTools (even when the user pastes a collapsed dump).
  dlog(
    "facebook scrape",
    "scope=" + (scraped.scope || "none"),
    "raw=" + (scraped.rawImgCount ?? 0),
    "kept=" + (scraped.images?.length ?? 0),
    "bg=" + (scraped.bgFound ?? 0),
    "videos=" + (scraped.videos?.length ?? 0),
    "hasVideoEl=" + (scraped.hasVideoElement ? "y" : "n"),
    "inlineVideos=" + (scraped.inlineVideoCount ?? 0),
    "storyKeys=" + JSON.stringify(scraped.currentStoryKeys || []),
    "avatarKeys=" + JSON.stringify(scraped.avatarKeys || []),
    "pass1Scripts=" + (scraped.pass1ScriptCount ?? 0),
    "needleHit=" + (scraped.pass1NeedleHit ? "y" : "n"),
    "needleUsed=" + (scraped.pass1NeedleUsed || "-"),
    "needles=" + JSON.stringify(scraped.needleCandidates || []),
    "handle=" + (scraped.handle || "-"),
    "date=" + (scraped.date || 0),
    "og=" + (scraped.ogImage || "-"),
    "perArticle=" + JSON.stringify(scraped.perArticle || {}),
    "handleCandidates=" + JSON.stringify(scraped.handleCandidates || []),
    "rawSamples=" + JSON.stringify(scraped.rawSamples || []),
    "bgSamples=" + JSON.stringify(scraped.bgSamples || []),
    "kept=" + JSON.stringify((scraped.images ?? []).slice(0, 3).map((i) => i.src)),
  );
  logFetcher("facebook", "dom:scraped", {
    scope: scraped.scope || "",
    rawImageCount: scraped.rawImgCount || 0,
    imageCount: scraped.images?.length || 0,
    videoCount: scraped.videos?.length || 0,
    hasVideoElement: !!scraped.hasVideoElement,
  });

  const items = [];
  const seen = new Set();
  for (const i of scraped.images ?? []) {
    if (!i?.src) continue;
    // Collapse URL variations that serve the same photo at different
    // resolutions (fbcdn URLs carry stp= / efg= tokens). Use pathname
    // as the dedup key so each photo appears once even if multiple
    // resolutions are in the DOM.
    let key;
    try { key = new URL(i.src).pathname; } catch { key = i.src; }
    if (seen.has(key)) continue;
    seen.add(key);
    const ext = extensionFromUrl(i.src) || "jpg";
    items.push({
      url: i.src,
      ext,
      width: i.width || 0,
      height: i.height || 0,
      thumbUrl: i.src,
      mime: `image/${ext === "jpg" ? "jpeg" : ext}`,
      basename: basenameFromUrl(i.src) || `photo.${ext}`,
      handle: i.handle || scraped.handle || "",
    });
  }
  for (const v of scraped.videos ?? []) {
    if (!v?.src) continue;
    if (seen.has(v.src)) continue;
    seen.add(v.src);
    const ext = extensionFromUrl(v.src) || "mp4";
    items.push({
      url: v.src,
      ext,
      width: 0,
      height: 0,
      thumbUrl: v.poster || "",
      mime: "video/mp4",
      basename: basenameFromUrl(v.src) || `video.${ext}`,
      handle: v.handle || scraped.handle || "",
    });
  }
  // Hand off to yt-dlp when the page has a <video> element we
  // couldn't extract a src for (Facebook renders feed videos via
  // MSE/blob URLs that don't show up in our scrape). Returning null
  // from the Facebook path lets the outer code fall through to
  // listFormats, which handles Facebook videos through its Facebook
  // extractor. The small "(items <= 1)" guard keeps mixed
  // photo+video posts with multiple images from being over-eagerly
  // redirected — if we already have several photos, show them.
  // `items` contains both image and video entries we built above;
  // (scraped.videos ?? []) is the raw count of video <src>s we could
  // extract. Fall through to yt-dlp ONLY when:
  //   - the page has a <video> element we couldn't src-extract, and
  //   - items is empty or holds just the poster frame, and
  //   - the URL isn't a story (yt-dlp rejects those — we'd throw
  //     away the one real story image we did find).
  const extractedVideoCount = (scraped.videos ?? []).length;
  if (
    !scraped.isStoryUrl &&
    !scraped.isFeedRoot &&
    scraped.hasVideoElement &&
    extractedVideoCount === 0 &&
    items.length <= 1
  ) {
    dlog("facebook scrape: page has <video> but no src — routing to yt-dlp");
    return null;
  }
  if (items.length === 0) return null;

  const title = scraped.title || "Facebook post";
  const handle = scraped.handle || "";
  const date = scraped.date || 0;

  if (items.length === 1 && items[0].mime?.startsWith("image/")) {
    const i = items[0];
    logFetcher("facebook", "dom:image", { imageUrl: i.url });
    return {
      kind: "image", title, handle, date,
      imageUrl: i.url, thumbUrl: i.thumbUrl, width: i.width, height: i.height,
      mime: i.mime, basename: i.basename,
    };
  }
  logFetcher("facebook", "dom:gallery", { itemCount: items.length });
  return { kind: "gallery", title, handle, date, items };
}

// scrapeFacebookMedia runs page-scoped (no extension globals). Returns
// plain JSON. Pulls images from the visible DOM filtered to fbcdn.net
// photo URLs of reasonable size, and videos similarly. Uses meta tags
// (og:title/og:description/og:url) for the caption and uploader, and a
// <abbr data-utime> / <time datetime> scan for the post time.
export function scrapeFacebookMedia() {
  const result = { images: [], videos: [], title: "", handle: "", date: 0 };

  const ogUrl = document.querySelector('meta[property="og:url"]')?.content || location.href;
  const ogTitle = document.querySelector('meta[property="og:title"]')?.content || "";
  const ogDescription = document.querySelector('meta[property="og:description"]')?.content || "";

  // Handle resolution, in preference order:
  //  1. og:url's first path segment (profile URLs: /<user>/).
  //  2. "/<user>/posts/<id>" → <user>.
  //  3. "/<page>/photos/a.<set>/<id>" → <page>.
  //  4. og:title formatted as "<Name> | Facebook" gives the display
  //     name (not the handle, but still useful to show).
  const RESERVED_FB = new Set([
    "watch", "reel", "reels", "stories", "photo", "photo.php", "video.php",
    "groups", "events", "pages", "profile.php", "sharer", "login",
    "home.php", "messages", "settings", "help", "privacy", "policies",
    "marketplace", "gaming", "dating", "fundraisers", "jobs", "weather",
    "notes", "live", "search", "friends", "bookmarks",
    // Footer / chrome links that otherwise win the document-wide
    // handle scorer on feed pages.
    "advertising", "ads", "ad_campaign", "business", "create",
    "developers", "careers", "about", "terms", "cookies", "support",
    "safety", "community", "mobile", "language", "payments_terms",
    "directory", "public-figures", "lite",
  ]);
  const path = (() => {
    try { return new URL(ogUrl).pathname; } catch { return location.pathname || ""; }
  })();
  const isMarketplaceListing = path.startsWith("/marketplace/item/");
  // Home-feed / section-index URLs: we can scrape whatever is rendered,
  // but there's no single-item permalink to hand to yt-dlp if our
  // scrape comes up short. The caller uses this flag to suppress the
  // "<video> element present → fall through to yt-dlp" path, which
  // otherwise ends up sending `https://www.facebook.com/` to yt-dlp
  // and getting "Unsupported URL" back.
  const isFeedRoot = path === "" || path === "/" || path === "/home" || path === "/home.php";
  result.isFeedRoot = isFeedRoot;
  try {
    const u = new URL(ogUrl);
    const seg = u.pathname.split("/").filter(Boolean);
    if (seg.length >= 1 && !RESERVED_FB.has(seg[0])) {
      result.handle = seg[0];
    } else if (seg.length >= 2 && seg[0] === "groups" && seg[1]) {
      result.handle = seg[1];
    }
  } catch {}

  // Marketplace listings don't carry the uploader in the URL. The page
  // renders a "Seller information" block whose link points to either
  // /marketplace/profile/<id>/ or a regular profile URL; the visible
  // text on that link is the seller's display name.
  //
  // Facebook also renders a sibling button ("Seller details") under
  // the same selector. Rather than hard-listing every UI string, score
  // each candidate: drop anything containing common UI words, and
  // prefer text that looks like a proper name (multi-word, each word
  // title-cased). Best scorer wins.
  const scoreSellerName = (text) => {
    if (!text) return -1;
    const len = text.length;
    if (len < 2 || len > 80) return -1;
    if (/\b(details|profile|seller|view|edit|message|share|more|save|see|report|hide|reply|menu|options|contact|about|info)\b/i.test(text)) return -1;
    const words = text.split(/\s+/).filter(Boolean);
    const titleCased = words.filter((w) => /^[\p{Lu}\p{Lt}]/u.test(w)).length;
    // One point per title-cased word; bonus for multi-word names (a
    // single word like "Marketplace" still scores but multi-word names
    // outrank it, which is what we want).
    return titleCased + (words.length > 1 ? 1 : 0);
  };
  if (!result.handle && isMarketplaceListing) {
    const sellerSelectors = [
      'a[href^="/marketplace/profile/"]',
      'a[href*="/marketplace/profile/"]',
      'a[href^="/profile.php"]',
      'a[href^="/people/"]',
    ];
    let best = { score: 0, name: "" };
    for (const sel of sellerSelectors) {
      for (const a of document.querySelectorAll(sel)) {
        const name = (a.textContent || "").trim().replace(/\s+/g, " ");
        const score = scoreSellerName(name);
        if (score > best.score) best = { score, name };
      }
    }
    if (best.name) result.handle = best.name;
  }

  // Handle fallback for every post shape the URL doesn't carry. The
  // loop runs on whichever scope is available: first the post's
  // article wrapper (tight scope, preferred when present), then the
  // whole document (stories, pages with no article wrapper, search-
  // result views, etc.). Same scorer as the marketplace seller path
  // so "Like"/"Comment"/"Share" anchors don't win.
  //
  // Regex takes only the first path segment and allows a trailing /,
  // ?, #, or end — covers /username/, /username, /username?ref=…,
  // and /username#frag without also matching multi-segment paths
  // like /username/posts/id.
  //
  // pickHandleFrom scores every profile-shaped anchor in `root`,
  // recording the top candidates into result.handleCandidates for
  // diagnostic logs. Only names scoring at or above `minScore` are
  // eligible to win. Hoisted so the per-article pass below (which
  // binds each image to its own post's author) can reuse it.
  // Extract the leading path segment from any Facebook profile link.
  // Facebook's modern feed uses absolute URLs ("https://www.facebook.com/…")
  // on post-author anchors, while the nav chrome uses relative ("/friends")
  // — accept both, plus "/username?ref=…" and "/username/posts/id" shapes.
  // Returns "" when the href isn't a Facebook profile link we can parse.
  const firstFbSegment = (href) => {
    if (!href) return "";
    let pathname = "";
    if (href[0] === "/" && href[1] !== "/") {
      pathname = href.split(/[?#]/)[0];
    } else {
      try {
        const u = new URL(href, location.origin);
        if (!/(^|\.)facebook\.com$/i.test(u.hostname)) return "";
        pathname = u.pathname;
      } catch { return ""; }
    }
    const segs = pathname.split("/").filter(Boolean);
    return segs[0] || "";
  };
  const pickHandleFrom = (root, minScore, bucket) => {
    let best = { score: 0, name: "" };
    const rows = [];
    for (const a of root.querySelectorAll("a[href]")) {
      const href = a.getAttribute("href") || "";
      const seg = firstFbSegment(href);
      if (!seg) continue;
      const reserved = RESERVED_FB.has(seg);
      const text = (a.textContent || "").trim().replace(/\s+/g, " ");
      const score = scoreSellerName(text);
      if (rows.length < 5) rows.push({ seg, text: text.slice(0, 60), score, reserved });
      if (reserved) continue;
      if (score >= minScore && score > best.score) best = { score, name: text };
    }
    if (bucket) {
      result.handleCandidates = (result.handleCandidates || []).concat({
        scope: bucket,
        picked: best.name,
        rows,
      });
    }
    return best.name;
  };
  if (!result.handle && !isFeedRoot) {
    const article =
      document.querySelector("div[role='article']") ||
      document.querySelector("article");
    // Inside the post's own article we trust single-word names (a
    // page called "Nike" or a user who goes by "Andrew" is valid).
    // Document-wide we require multi-word (score ≥ 2) because
    // single-word matches there tend to be footer labels like
    // "Advertising", "Careers", "Marketplace" that slip through the
    // reserved-set and look name-like to the scorer.
    // Skipped entirely on feed-root: there are many posts and the
    // document-wide scan always picks one of them as "the" handle,
    // which would tag every item with that one author. Per-item
    // handles come from the interceptor path or stay empty.
    if (article) result.handle = pickHandleFrom(article, 1, "article");
    if (!result.handle) result.handle = pickHandleFrom(document, 2, "document");
  }

  // Per-article handle resolver. The feed renders several posts on
  // one page — each wrapped in its own `div[role="article"]`. The
  // single `result.handle` above reflects whichever article happened
  // to resolve first, which means every image in the gallery gets
  // mislabeled as the first post's author. Walk each media element's
  // ancestors to find its enclosing article, then score handles
  // within THAT article's subtree so every photo carries its own
  // post's author. Cached by article element so the same walk
  // doesn't repeat for sibling photos in the same post.
  const perArticleHandleCache = new WeakMap();
  let perArticleHits = 0;
  let perArticleMisses = 0;
  // Modern Facebook feed wraps each post in `div[data-pagelet^="FeedUnit"]`
  // (sometimes with a role="article" descendant, sometimes without).
  // Match both so per-post handle binding works on the home feed and
  // on single-post permalink pages.
  const isPostWrapper = (node) => {
    if (!node || node.nodeType !== 1 || !node.getAttribute) return false;
    if (node.tagName === "ARTICLE") return true;
    if (node.getAttribute("role") === "article") return true;
    const pagelet = node.getAttribute("data-pagelet") || "";
    return /^(FeedUnit|CometFeed|CometPermalink|Group|Reels|StoriesPage)/i.test(pagelet);
  };
  // Returns { wrapper, handle }. wrapper is the enclosing post element
  // (or null); handle is the author name scored from anchors inside
  // that wrapper (or "" if nothing good was found). Callers use the
  // wrapper to decide "is this an in-post image" (vs UI chrome) and
  // the handle to tag the item with its own author.
  const handleForElement = (el) => {
    if (!el) return { wrapper: null, handle: "" };
    let node = el;
    let hops = 0;
    let wrapper = null;
    while (node && hops < 30) {
      if (isPostWrapper(node)) { wrapper = node; break; }
      node = node.parentNode;
      hops++;
    }
    if (!wrapper) { perArticleMisses++; return { wrapper: null, handle: "" }; }
    if (perArticleHandleCache.has(wrapper)) {
      return { wrapper, handle: perArticleHandleCache.get(wrapper) };
    }
    const name = pickHandleFrom(wrapper, 1, "");
    perArticleHandleCache.set(wrapper, name);
    if (name) perArticleHits++; else perArticleMisses++;
    return { wrapper, handle: name };
  };

  // Title: strip Facebook's " | Facebook" suffix and fall back to
  // og:description if og:title is generic.
  let title = ogTitle.replace(/\s*\|\s*Facebook\s*$/i, "").trim();
  if (/^(Facebook|Log in or sign up)$/i.test(title) || !title) {
    title = (ogDescription || "").replace(/\s+/g, " ").trim();
  }
  if (title.length > 80) title = title.slice(0, 80) + "…";
  result.title = title || "Facebook post";

  // Date: Facebook renders <abbr data-utime="<unix>"> on older markup
  // and <time datetime="…"> on newer Profile/Page views.
  const abbr = document.querySelector("abbr[data-utime]");
  const utime = abbr?.getAttribute("data-utime");
  if (utime) {
    const n = parseInt(utime, 10);
    if (Number.isFinite(n)) result.date = n;
  }
  if (!result.date) {
    const timeEl = document.querySelector("time[datetime]");
    const dt = timeEl?.getAttribute("datetime");
    if (dt) {
      const ms = Date.parse(dt);
      if (Number.isFinite(ms)) result.date = Math.floor(ms / 1000);
    }
  }

  // Image pickup. Strategy:
  //   1. og:image seeded first. It may not be present for client-side-
  //      routed pages (logged-in marketplace/feed), but when it is, it
  //      names the canonical hero photo — trust it regardless of host.
  //   2. Walk the narrowest reasonable scope: article → main → body.
  //      Inside article we accept any content-sized <img>; outside we
  //      additionally require the image to be inside a clickable
  //      (<a>/<button>/[role=button]) so UI chrome is excluded.
  //   3. Accept images whose hostname hints at Facebook media. The
  //      full list varies (fbcdn.net, fbsbx.com, xx.fbcdn.net, scontent
  //      subdomains, lookaside.instagram.com, external-*.fna.fbcdn.net);
  //      match "fbcdn", "fbsbx", or any host beginning with "scontent"
  //      so marketplace's CDN quirks don't shut us out.
  const og = document.querySelector('meta[property="og:image"]')?.content || "";
  result.ogImage = og;
  const seen = new Set();
  const isFbMediaHost = (src) => {
    try {
      const h = new URL(src).hostname.toLowerCase();
      return /(^|\.)fbcdn\.net$|(^|\.)fbsbx\.com$|^scontent[\-.]/.test(h);
    } catch { return false; }
  };
  const pushImage = (src, w, h, trustHost, elementHandle) => {
    if (!src) return;
    if (!trustHost && !isFbMediaHost(src)) return;
    let key;
    try { key = new URL(src).pathname; } catch { key = src; }
    if (seen.has(key)) return;
    seen.add(key);
    result.images.push({
      src,
      width: w || 0,
      height: h || 0,
      handle: elementHandle || "",
    });
  };

  // Seed with og:image; accept its host verbatim (meta tags are
  // Facebook-controlled by definition). og:image has no DOM element
  // context, so fall back to the page-level handle (resolved above).
  if (og) pushImage(og, 0, 0, true, result.handle);

  // Search the whole document. Facebook marketplace renders the
  // listing's own photos in a detached dialog / portal that isn't
  // always inside role="article" or role="main", so scoping tighter
  // drops the signal. The host + size + path filters below keep
  // unrelated <img> elements out.
  result.scope = "document";
  const imgs = document.querySelectorAll("img");
  result.rawImgCount = imgs.length;
  result.rawSamples = [];
  // Pre-pass: does the page have any *content-sized* rendered image?
  // Facebook's story viewer lives in a hidden container that leaves
  // every content <img> with rw=rh=0 — but the page still has tiny
  // avatars (40x40) rendered in the top bar, so a bare "anything
  // non-zero" check misclassifies the page as visible and re-enables
  // the filter that wipes the actual story frames. Require ≥100 px
  // on a side so only content-sized renderings count.
  let anyVisible = false;
  for (const img of imgs) {
    const r = img.getBoundingClientRect();
    if (r.width >= 100 && r.height >= 100) { anyVisible = true; break; }
  }
  result.anyVisible = anyVisible;
  for (const img of imgs) {
    // Facebook sometimes sets src/srcset before the decoder has run,
    // so currentSrc can be empty even when a URL is available on the
    // element. data-src is a common lazy-load attribute too.
    const src = img.currentSrc || img.src || img.getAttribute("data-src") || "";
    const w = img.naturalWidth || img.width || 0;
    const h = img.naturalHeight || img.height || 0;
    const rect = img.getBoundingClientRect();
    const rw = Math.round(rect.width);
    const rh = Math.round(rect.height);
    if (src) {
      result.rawSamples.push({
        src: src.slice(0, 160),
        w, h, rw, rh,
        vc: img.getAttribute("data-visualcompletion") || "",
      });
    }
    if (!src) continue;
    const { wrapper: imgWrapper, handle: articleHandle } = handleForElement(img);
    const insideArticle = !!imgWrapper;
    const vc = img.getAttribute("data-visualcompletion");
    if (vc === "media-vc-image") {
      pushImage(src, w, h, true, articleHandle || result.handle);
      continue;
    }
    if (!isFbMediaHost(src)) continue;
    // Visibility filter: reject offscreen / preloaded images (rw=rh=0),
    // but only when the page has *some* rendered content. If every img
    // on the page is offscreen (story viewer inside a hidden modal),
    // trust the size gate alone so we don't zero-out the whole list.
    if (anyVisible && rw === 0 && rh === 0) continue;
    // Content-sized gate on natural size when loaded, rendered size
    // when not. The listing hero + carousel photos have natural
    // 960x… (the CDN serves a 960-ish rendition), and even their
    // tiny nav-thumb DOM instances stay long-side ≥ 500 via the
    // natural dimension. "Top picks" suggestions are 261x261.
    //
    // Inside a `role="article"` wrapper we relax to 200 so feed post
    // thumbnails (Facebook renders them ~280x200 unless clicked) come
    // through. Article scope excludes UI chrome by construction, so
    // the 500-px guard isn't needed there. Skip the profile-photo
    // CDN buckets (t39.30808-1, t1.6435-1, t1.30497-1, t39.30808-0)
    // explicitly since the avatar for the post author sits inside
    // the article too and would otherwise slip through.
    const longSide = Math.max(w, h, rw, rh);
    const minLongSide = insideArticle ? 200 : 500;
    if (longSide > 0 && longSide < minLongSide) continue;
    if (insideArticle && /\/t(?:39\.30808-[01]|1\.6435-1|1\.30497-1)\//.test(src)) continue;
    pushImage(src, w, h, true, articleHandle || result.handle);
  }

  // Facebook marketplace and some profile carousels render photos as
  // CSS background-image on nested <div> elements rather than <img>.
  // Walk every element in the document so the dialog / detached
  // containers come through too.
  const bgAll = document.querySelectorAll("*");
  let bgFound = 0;
  const bgSamples = [];
  for (const el2 of bgAll) {
    const cs = window.getComputedStyle(el2);
    const bg = cs?.backgroundImage;
    if (!bg || bg === "none") continue;
    const m = /url\(["']?(https?:\/\/[^"')]+)["']?\)/.exec(bg);
    if (!m) continue;
    bgFound++;
    const src = m[1];
    if (bgSamples.length < 5) bgSamples.push(src.slice(0, 140));
    const rect = el2.getBoundingClientRect();
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    if (w === 0 && h === 0) continue; // offscreen / preloaded
    const longSide = Math.max(w, h);
    if (longSide > 0 && longSide < 500) continue;
    pushImage(src, w, h, false, handleForElement(el2).handle || result.handle);
  }
  result.bgFound = bgFound;
  result.bgSamples = bgSamples;
  result.perArticle = { hits: perArticleHits, misses: perArticleMisses };

  // Record whether the page has ANY <video> element so the caller can
  // decide whether to fall through to yt-dlp even when our scrape
  // returned a clean image-only gallery. Facebook feed posts with
  // video content render the video via MSE (blob: URLs), so our <video
  // src> extraction above finds nothing — but yt-dlp does handle the
  // URL when we hand off.
  result.hasVideoElement = document.querySelectorAll("video").length > 0;
  result.isStoryUrl = (location.pathname || "").startsWith("/stories/");
  for (const v of document.querySelectorAll("video")) {
    const src = v.currentSrc || v.src || "";
    if (!src || !isFbMediaHost(src)) continue;
    result.videos.push({
      src,
      poster: v.poster || "",
      handle: handleForElement(v).handle || result.handle,
    });
  }

  // Inline-script scan for Facebook's embedded playable URLs. Story
  // videos (and many feed videos) render via MSE with a blob: src on
  // <video>, so the <video> loop above catches nothing. But the real
  // MP4 URL ships with the page as part of a serialized Relay payload
  // inside a <script> tag under keys like browser_native_hd_url /
  // browser_native_sd_url / playable_url. Unescape JSON-style URL
  // encoding (\u0026 → &, \/ → /), and pair each video URL with the
  // nearest image URI that follows it in the same JSON block — that's
  // preferred_thumbnail.image.uri in Facebook's Relay schema.
  const inlineSeen = new Set();
  const unescapeJson = (s) => s.replace(/\\u0026/g, "&").replace(/\\\//g, "/");
  // Story URL: /stories/<user_id>/<bucket_id>/ — the bucket id is a
  // base64 blob that Facebook atob-decodes into "S:_ISC:<numeric_id>"
  // before embedding into the Relay JSON. Try multiple forms (raw
  // bucket, padded-less, decoded string, decoded numeric) so at least
  // one of them lands inside the currently-viewed story's JSON node
  // and not an adjacent tray story.
  const currentStoryKeys = [];
  if (result.isStoryUrl) {
    const parts = (location.pathname || "").split("/").filter(Boolean);
    if (parts.length >= 3 && parts[2]) {
      const raw = parts[2];
      currentStoryKeys.push(raw);
      currentStoryKeys.push(raw.replace(/=+$/, ""));
      try {
        // Bucket IDs use URL-safe base64 — translate "-" → "+" and
        // "_" → "/" so atob() can parse them.
        const padded = raw.replace(/-/g, "+").replace(/_/g, "/");
        const decoded = atob(padded);
        if (decoded) {
          currentStoryKeys.push(decoded);
          const numeric = /(\d{10,})/.exec(decoded);
          if (numeric) currentStoryKeys.push(numeric[1]);
        }
      } catch {}
    }
  }
  result.currentStoryKeys = currentStoryKeys;
  // Story / feed post blocks carry metadata we want: the author
  // name ("owner"/"actors"/"message_sender".name) and the publish
  // time ("creation_time"/"publish_time"). Scanning the same script
  // lets us fill handle + date for story pages (where the DOM is
  // otherwise empty) and for feed posts whose <abbr>/< time> tags
  // weren't picked up by the earlier pass.
  const scanInlineMeta = (text) => {
    const meta = { name: "", date: 0 };
    const namePatterns = [
      /"owner":\{[^}]*?"name":"([^"]+)"/,
      /"actors":\[\{[^}]*?"name":"([^"]+)"/,
      /"message_sender":\{[^}]*?"name":"([^"]+)"/,
      /"story_card_info":\{[^}]*?"name":"([^"]+)"/,
    ];
    for (const pat of namePatterns) {
      const m2 = pat.exec(text);
      if (m2 && m2[1]) {
        const candidate = unescapeJson(m2[1]).trim();
        if (candidate && !/^[\d]+$/.test(candidate)) { meta.name = candidate; break; }
      }
    }
    const datePatterns = [
      /"creation_time":(\d+)/,
      /"publish_time":(\d+)/,
    ];
    for (const pat of datePatterns) {
      const m2 = pat.exec(text);
      if (m2 && m2[1]) {
        const n = parseInt(m2[1], 10);
        if (Number.isFinite(n) && n > 0) { meta.date = n; break; }
      }
    }
    return meta;
  };
  // Combined pattern captures the video URL and the search window
  // lets us locate the closest image URI forward. Same regex family
  // as before, joined into one so we can iterate with .index.
  const videoUrlRe = /"(?:browser_native_hd_url|browser_native_sd_url|playable_url_quality_hd|playable_url)":"([^"]+)"/g;
  // Two passes: first only the scripts that mention the current story
  // bucket (so an adjacent tray story can't win), then a fallback
  // across every post-bearing script. Feed pages skip the first pass
  // (no currentStoryKey) and go straight to the broad scan.
  const scripts = [...document.querySelectorAll("script")];
  const isPostBearing = (text) =>
    text.includes("native_hd_url") || text.includes("playable_url") ||
    text.includes("creation_time") || text.includes("publish_time");
  // The currently-visible story has exactly one small avatar rendered
  // in the viewer's top bar (every other <img> is offscreen). Parse
  // that image's file-id segments — they appear inside the active
  // story's Relay node's profile_picture.uri, giving us a
  // DOM-grounded scope key even when the URL hasn't been updated by
  // Facebook's SPA as the user advanced through the tray.
  const avatarKeys = [];
  for (const img of imgs) {
    const r = img.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (r.width > 80 || r.height > 80) continue;
    const src = img.currentSrc || img.src || "";
    if (!src) continue;
    try {
      const base = new URL(src).pathname.split("/").pop() || "";
      const idm = /^(\d+)_(\d+)_(\d+)_n\./.exec(base);
      if (idm) {
        avatarKeys.push(idm[1]); // image ID (most specific)
        avatarKeys.push(idm[2]); // user/album ID
      }
    } catch {}
  }
  result.avatarKeys = avatarKeys;
  const allScopeKeys = [...currentStoryKeys, ...avatarKeys];

  // For story pages, use the VISIBLE story poster as a needle into
  // the Relay JSON. Facebook's tray payload typically contains
  // several stories' data in one script, but each story's block
  // references its own preferred_thumbnail.image.uri — and the
  // visible <img> on the page points at that same URL. Its unique
  // ~32-char path token (/m1/v/t0.65075-6/<token>-...) appears
  // literally inside the active story's JSON block and nowhere
  // else. Locate that token → extract video/name/date from a 20 kB
  // window around it.
  //
  // Also try the S:_ISC:<numeric> and numeric-only forms as
  // fallbacks; some layouts store the token differently.
  result.pass1NeedleHit = false;
  const needleCandidates = [];
  // Extract the story-bucket poster from what DOM scan already kept.
  let storyPosterToken = "";
  if (result.isStoryUrl) {
    for (const img of result.images) {
      const src = img.src || "";
      const m1 = /\/m1\/v\/t0\.65075-6\/([A-Za-z0-9_\-]{16,})/.exec(src);
      if (m1 && m1[1]) { storyPosterToken = m1[1].slice(0, 32); break; }
    }
  }
  if (storyPosterToken) needleCandidates.push(storyPosterToken);
  const specificKey = currentStoryKeys.find((k) => k.startsWith("S:_ISC:"));
  if (specificKey) needleCandidates.push(specificKey);
  const numericKey = currentStoryKeys.find((k) => /^\d{10,}$/.test(k));
  if (numericKey) needleCandidates.push(numericKey);
  result.needleCandidates = needleCandidates;

  for (const needle of needleCandidates) {
    if (result.pass1NeedleHit) break;
    for (const script of scripts) {
      const text = script.textContent || "";
      const idx = text.indexOf(needle);
      if (idx < 0) continue;
      // Expand window around hit: 5 kB back, 20 kB forward. The video
      // URL often precedes the thumbnail in the JSON node, so a little
      // backward coverage matters.
      const winStart = Math.max(0, idx - 5000);
      const winEnd = Math.min(text.length, idx + 20000);
      const win = text.slice(winStart, winEnd);
      const vMatch = /"(?:browser_native_hd_url|browser_native_sd_url|playable_url_quality_hd|playable_url)":"([^"]+)"/.exec(win);
      if (!vMatch) continue;
      const videoUrl = unescapeJson(vMatch[1]);
      if (!videoUrl.startsWith("https://")) continue;
      const meta = scanInlineMeta(win);
      if (meta.name) result.handle = meta.name;
      if (meta.date) result.date = meta.date;
      let poster = "";
      const posterWin = win.slice(vMatch.index);
      const uriRe = /"uri":"([^"]+)"/g;
      let pm;
      while ((pm = uriRe.exec(posterWin)) !== null) {
        const candidate = unescapeJson(pm[1]);
        if (candidate.startsWith("http")) { poster = candidate; break; }
      }
      if (!inlineSeen.has(videoUrl)) {
        inlineSeen.add(videoUrl);
        result.videos.push({ src: videoUrl, poster });
      }
      result.pass1NeedleHit = true;
      result.pass1NeedleUsed = needle.slice(0, 40);
      break;
    }
  }

  const candidateLists = [];
  if (result.pass1NeedleHit) {
    // Scoped needle scan already gave us the right story's video +
    // metadata. Skip pass 1 / broad scans entirely so neighbouring
    // stories can't leak in.
    result.pass1ScriptCount = 0;
  } else if (allScopeKeys.length > 0) {
    const matching = scripts.filter((s) => {
      const t = s.textContent || "";
      return allScopeKeys.some((k) => t.includes(k));
    });
    candidateLists.push(matching);
    result.pass1ScriptCount = matching.length;
    candidateLists.push(scripts);
  } else {
    result.pass1ScriptCount = 0;
    candidateLists.push(scripts);
  }
  // Run each pass; stop once any pass produced a handle + at least one
  // video (or we've consumed the fallback pass).
  let passCompleted = false;
  for (const list of candidateLists) {
    if (passCompleted) break;
    let producedVideo = false;
    for (const script of list) {
      const text = script.textContent || "";
      if (!text || !isPostBearing(text)) continue;
      // Harvest name + date from this script once.
      const meta = scanInlineMeta(text);
      // On feed-root the script scan finds names from arbitrary posts
      // in the Relay payload — whichever post's JSON happens to be
      // first in the text wins, and every item gets tagged with that
      // one author. Per-article binding is the correct mechanism on
      // the feed; leave result.handle empty there so items fall back
      // to "" rather than the wrong name.
      if (!result.handle && meta.name && !isFeedRoot) result.handle = meta.name;
      if (!result.date && meta.date) result.date = meta.date;
      videoUrlRe.lastIndex = 0;
      let m;
      while ((m = videoUrlRe.exec(text)) !== null) {
      const url = unescapeJson(m[1]);
      if (!url.startsWith("https://") || inlineSeen.has(url)) continue;
      inlineSeen.add(url);
      // Look forward 2 kB for the nearest "uri":"..." — that's
      // Facebook's preferred_thumbnail.image.uri that sits next to the
      // video URL inside the same story/post node. Source text has
      // JSON-escaped slashes ("https:\/\/..."), so we capture up to
      // the next quote and unescape after matching. Falls back to a
      // backward search when nothing forward (some blocks put the
      // thumbnail first in the JSON).
      let poster = "";
      const windowSize = 2000;
      const fwd = text.slice(m.index, Math.min(text.length, m.index + windowSize));
      const uriPat = /"uri":"([^"]+)"/g;
      let pm;
      while ((pm = uriPat.exec(fwd)) !== null) {
        const candidate = unescapeJson(pm[1]);
        if (candidate.startsWith("http")) { poster = candidate; break; }
      }
      if (!poster) {
        const back = text.slice(Math.max(0, m.index - windowSize), m.index);
        // Scan all matches and take the last one — that's the nearest
        // preceding URI to the video URL.
        const allBack = [...back.matchAll(/"uri":"([^"]+)"/g)];
        for (let i = allBack.length - 1; i >= 0; i--) {
          const candidate = unescapeJson(allBack[i][1]);
          if (candidate.startsWith("http")) { poster = candidate; break; }
        }
      }
      result.videos.push({ src: url, poster });
      producedVideo = true;
    }
    }
    // First pass (current-story-scoped) succeeded if we pulled any
    // video from it. Don't re-run the global fallback in that case —
    // otherwise we'd pull adjacent tray stories back in.
    if (producedVideo) { passCompleted = true; }
  }
  result.inlineVideoCount = inlineSeen.size;

  // When the inline scan yielded playable videos AND the only image
  // we kept is the poster frame sitting on the same story-bucket
  // path, drop the poster from images — it's the video's thumbnail,
  // not a separate piece of content the user wants.
  if (inlineSeen.size > 0 && result.images.length === 1) {
    const imgUrl = result.images[0].src || "";
    if (/\/m1\/v\/t0\.65075-6\//.test(imgUrl)) {
      result.images = [];
    }
  }

  return result;
}
