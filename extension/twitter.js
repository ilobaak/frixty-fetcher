// @ts-check

// Twitter/X post detection. yt-dlp's Twitter extractor handles video tweets
// cleanly, but photo-only tweets (1–4 still images) don't surface as
// downloadable formats. For those we fetch the public tweet JSON from the
// syndication endpoint (same API Twitter's own embed widgets use; no auth
// required) and drive image/gallery downloads ourselves.
//
// Exports:
//   looksLikeTweet(url)      — cheap URL-shape check
//   detectTweet(url)         — network fetch, always hits the wire
//   detectTweetCached(url)   — session-cached wrapper
//
// Return shape matches reddit.js:
//   null                         — not a tweet URL
//   { kind: "video" }            — tweet contains video/gif; fall through to yt-dlp
//   { kind: "image", ... }       — single photo tweet
//   { kind: "gallery", items }   — multi-photo tweet

import { computeSyndicationToken } from "./shared.js";
import { logFetcher } from "./fetcher-log.js";

const TWEET_URL_RE = /^https?:\/\/(?:[^.]+\.)?(?:twitter\.com|x\.com)\/[^/]+\/status\/(\d+)/i;
const CACHE_TTL_MS = 10 * 60 * 1000;

export function looksLikeTweet(url) {
  return typeof url === "string" && TWEET_URL_RE.test(url);
}

export async function detectTweetCached(url) {
  const key = `twitter:${url}`;
  try {
    const { [key]: entry } = await chrome.storage.session.get(key);
    if (entry && Date.now() - entry.at < CACHE_TTL_MS) {
      return entry.info;
    }
  } catch {}
  const info = await detectTweet(url);
  if (info && (info.kind === "image" || info.kind === "gallery")) {
    try {
      await chrome.storage.session.set({ [key]: { info, at: Date.now() } });
    } catch {}
  }
  return info;
}

export async function detectTweet(url) {
  const match = url.match(TWEET_URL_RE);
  if (!match) return null;
  const tweetId = match[1];
  logFetcher("twitter", "detect:start", { url, tweetId });

  const token = computeSyndicationToken(tweetId);
  const api = `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&token=${token}&lang=en`;
  logFetcher("twitter", "syndication:fetch", { url: api, tweetId });

  let data;
  try {
    const resp = await fetch(api, { credentials: "omit" });
    if (!resp.ok) {
      logFetcher("twitter", "syndication:error", { url: api, status: resp.status });
      throw new Error(`HTTP ${resp.status}`);
    }
    data = await resp.json();
  } catch (e) {
    logFetcher("twitter", "syndication:exception", { url: api, error: e?.message || String(e) });
    // Syndication can refuse (deleted tweet, NSFW that needs login, etc.).
    // Let yt-dlp have a go — its Twitter extractor has authenticated fall-
    // backs for video tweets and will error cleanly on bad URLs.
    return { kind: "video" };
  }

  const media = Array.isArray(data?.mediaDetails) ? data.mediaDetails : [];
  logFetcher("twitter", "syndication:result", { tweetId, itemCount: media.length });
  if (media.length === 0) {
    return { kind: "video" };
  }

  const handle = data?.user?.screen_name?.trim() ?? "";
  const title = deriveTweetTitle(data, tweetId);
  // created_at on the syndication endpoint is ISO 8601. Date.parse
  // handles the rare fallback to the legacy "Mon Jan 15 12:34:56 +0000"
  // format too; NaN sinks back to 0 which the popup renders as "no date".
  const dateMs = Date.parse(data?.created_at ?? "");
  const date = Number.isFinite(dateMs) ? Math.floor(dateMs / 1000) : 0;

  const photos = media
    .filter((m) => m.type === "photo" && typeof m.media_url_https === "string")
    .map((m) => {
      const origUrl = withTwitterSize(m.media_url_https, "orig");
      const ext = extFromUrl(origUrl) || "jpg";
      return {
        url: origUrl,
        ext,
        width: m.original_info?.width ?? 0,
        height: m.original_info?.height ?? 0,
        thumbUrl: withTwitterSize(m.media_url_https, "small"),
        mime: `image/${ext === "jpg" ? "jpeg" : ext}`,
        basename: basenameFromUrl(origUrl),
        handle,
      };
    });

  const videos = [];
  for (const m of media) {
    if (m.type !== "video" && m.type !== "animated_gif") continue;
    const item = videoItemFromApi(m, handle);
    if (item) videos.push(item);
  }

  // No usable media in either track — bail so the caller can fall through
  // to the DOM scrape / yt-dlp path.
  if (photos.length === 0 && videos.length === 0) {
    logFetcher("twitter", "detect:no-media", { url, mediaCount: media.length });
    return { kind: "video" };
  }

  // Single-photo tweets keep the image picker for its nicer single-item UI.
  if (photos.length === 1 && videos.length === 0) {
    const p = photos[0];
    logFetcher("twitter", "detect:image", { url, imageUrl: p.url });
    return {
      kind: "image",
      title,
      handle,
      date,
      imageUrl: p.url,
      thumbUrl: p.thumbUrl,
      width: p.width,
      height: p.height,
      mime: p.mime,
      basename: p.basename,
    };
  }

  // Everything else (multi-photo, single-or-multi-video, or mixed) routes
  // through the gallery picker. Its single-item code path handles 1-video
  // tweets cleanly (no album folder, quality dropdown when variants exist).
  logFetcher("twitter", "detect:gallery", {
    url,
    photoCount: photos.length,
    videoCount: videos.length,
  });
  return { kind: "gallery", title, handle, date, items: [...photos, ...videos] };
}

// videoItemFromApi turns a mediaDetails video/animated_gif entry into the
// gallery-item shape. Twitter exposes multiple mp4 variants per video via
// video_info.variants — we pick the highest resolution as the default and
// attach the rest as `variants` so the gallery's quality dropdown works.
function videoItemFromApi(m, handle) {
  const variants = Array.isArray(m.video_info?.variants) ? m.video_info.variants : [];
  const mp4s = variants
    .filter((v) => v.content_type === "video/mp4" && typeof v.url === "string")
    .map((v) => {
      const { width, height } = parseVideoResolution(v.url);
      return { url: v.url, width, height, bitrate: v.bitrate || 0 };
    })
    .sort((a, b) => {
      if (b.height !== a.height) return b.height - a.height;
      return b.bitrate - a.bitrate;
    });
  if (mp4s.length === 0) return null;
  const best = mp4s[0];
  return {
    url: best.url,
    ext: "mp4",
    width: best.width || m.original_info?.width || 0,
    height: best.height || m.original_info?.height || 0,
    thumbUrl: m.media_url_https || "",
    mime: "video/mp4",
    basename: basenameFromUrl(best.url),
    handle,
    variants: mp4s.length > 1 ? mp4s : [],
  };
}

function parseVideoResolution(url) {
  try {
    const path = new URL(url).pathname;
    const m = path.match(/\/(\d+)x(\d+)\//);
    return {
      width: m ? parseInt(m[1], 10) : 0,
      height: m ? parseInt(m[2], 10) : 0,
    };
  } catch {
    return { width: 0, height: 0 };
  }
}

// deriveTweetTitle returns just the tweet text (trimmed to 80 chars).
// The handle is rendered separately in the card's uploader row and
// again in the @Poster filename mode, so including it here would cause
// double-prefixing in filenames like "@user - @user - text". Falls
// back to "Tweet <id>" when the tweet has no body (quote-only tweets).
function deriveTweetTitle(data, tweetId) {
  const text = decodeHtmlEntities(data?.text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const short = text.length > 80 ? text.slice(0, 80) + "…" : text;
  if (short) return short;
  return `Tweet ${tweetId}`;
}

// decodeHtmlEntities turns "&gt;" into ">", "&amp;" into "&", numeric
// entities into their character, etc. Twitter's syndication endpoint
// ignores raw_json and returns entity-encoded tweet text, which rendered
// literally in the popup (e.g. "&gt; 11 years…").
function decodeHtmlEntities(str) {
  if (!str) return "";
  const ta = document.createElement("textarea");
  ta.innerHTML = String(str);
  return ta.value;
}

// withTwitterSize sets the pbs.twimg.com ?name= parameter so we control
// which rendition we fetch: "orig" for the full image we save, "small" for
// a lightweight thumbnail.
export function withTwitterSize(url, sizeLabel) {
  try {
    const u = new URL(url);
    u.searchParams.set("name", sizeLabel);
    return u.toString();
  } catch {
    return url;
  }
}

// getTwitterDomInfo runs scrapeTwitterMedia in the active tab via
// chrome.scripting.executeScript and reshapes the raw JSON into the
// info object the popup's pickers expect. Called from runFetchFlow as
// a fallback after detectTweet (the syndication-API path) returns
// null. Returns null if the scrape finds nothing — caller falls
// through to yt-dlp.
export async function getTwitterDomInfo() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id === undefined) return null;

  let scraped;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scrapeTwitterMedia,
    });
    scraped = results?.[0]?.result;
  } catch (e) {
    logFetcher("twitter", "dom:exception", { error: e?.message || String(e) });
    return null;
  }
  logFetcher("twitter", "dom:scraped", {
    imageCount: scraped?.images?.length || 0,
    videoCount: scraped?.videos?.length || 0,
  });

  const items = [];
  const seen = new Set();

  for (const img of scraped?.images ?? []) {
    if (!img?.src) continue;
    let path;
    try {
      path = new URL(img.src).pathname;
    } catch {
      continue;
    }
    const key = "img:" + path;
    if (seen.has(key)) continue;
    seen.add(key);
    const origUrl = withTwitterSize(img.src, "orig");
    const ext = extFromUrl(origUrl) || "jpg";
    items.push({
      url: origUrl,
      ext,
      width: img.width || 0,
      height: img.height || 0,
      thumbUrl: withTwitterSize(img.src, "small"),
      mime: `image/${ext === "jpg" ? "jpeg" : ext}`,
      basename: basenameFromUrl(origUrl),
      handle: img.handle || "",
    });
  }

  // Group video URLs by their underlying video ID so multiple quality
  // variants of the same tweet video collapse into a single item with a
  // variants[] list. The quality dropdown later picks between them.
  const videoGroups = new Map();
  for (const vid of scraped?.videos ?? []) {
    if (!vid?.src) continue;
    const parsed = parseTwitterVideoUrl(vid.src);
    const key = parsed.videoId || "path:" + safePathname(vid.src);
    if (!key) continue;
    if (!videoGroups.has(key)) {
      videoGroups.set(key, { urls: [], posterUrl: vid.posterUrl || "", handle: vid.handle || "" });
    }
    const g = videoGroups.get(key);
    if (!g.urls.some((v) => v.url === vid.src)) {
      g.urls.push({ url: vid.src, width: parsed.width, height: parsed.height });
    }
    if (!g.posterUrl && vid.posterUrl) g.posterUrl = vid.posterUrl;
    if (!g.handle && vid.handle) g.handle = vid.handle;
  }
  for (const group of videoGroups.values()) {
    const variants = group.urls.slice().sort((a, b) => (b.height || 0) - (a.height || 0));
    const best = variants[0];
    const ext = extFromUrl(best.url) || "mp4";
    items.push({
      url: best.url,
      ext,
      width: best.width || 0,
      height: best.height || 0,
      thumbUrl: group.posterUrl,
      mime: "video/mp4",
      basename: basenameFromUrl(best.url),
      handle: group.handle || "",
      // Only attach variants when >1 so UI only shows the dropdown for
      // genuinely multi-quality videos (GIFs tend to be single-quality).
      variants: variants.length > 1 ? variants : [],
    });
  }

  if (items.length === 0) {
    logFetcher("twitter", "dom:no-media");
    return null;
  }
  logFetcher("twitter", "dom:result", { itemCount: items.length });

  const rawText = (scraped?.text ?? "").replace(/\s+/g, " ").trim();
  const title = rawText.length > 80 ? rawText.slice(0, 80) + "…" : rawText || "Tweet";

  if (items.length === 1 && items[0].mime?.startsWith("image/")) {
    const i = items[0];
    return {
      kind: "image",
      title,
      imageUrl: i.url,
      thumbUrl: i.thumbUrl || i.url,
      width: i.width,
      height: i.height,
      mime: i.mime,
      basename: i.basename,
    };
  }
  return { kind: "gallery", title, items };
}

// parseTwitterVideoUrl pulls the stable video ID (for grouping variants
// of the same underlying clip) and the resolution (from the "/WxH/"
// path segment) out of a video.twimg.com URL. Returns zeros when fields
// are missing, so callers can fall back to treating the URL as a
// single-variant item.
function parseTwitterVideoUrl(url) {
  try {
    const path = new URL(url).pathname;
    let videoId = "";
    const idMatch = path.match(/\/(tweet_video|ext_tw_video|amplify_video)\/([^/]+)/);
    if (idMatch) videoId = idMatch[1] + "/" + idMatch[2];
    const resMatch = path.match(/\/(\d+)x(\d+)\//);
    const width = resMatch ? parseInt(resMatch[1], 10) : 0;
    const height = resMatch ? parseInt(resMatch[2], 10) : 0;
    return { videoId, width, height };
  } catch {
    return { videoId: "", width: 0, height: 0 };
  }
}

function safePathname(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

// pickVariantUrl picks the best variant URL from a Twitter video item
// for the given height cap:
//   - no variants or only one → just item.url
//   - maxHeight <= 0 → top variant (highest resolution)
//   - otherwise → the largest variant whose height fits under the cap;
//     falls back to the smallest variant if the cap is below everything.
export function pickVariantUrl(item, maxHeight) {
  if (!Array.isArray(item.variants) || item.variants.length === 0) return item.url;
  if (maxHeight <= 0) return item.variants[0].url;
  for (const v of item.variants) {
    if ((v.height || 0) <= maxHeight) return v.url;
  }
  return item.variants[item.variants.length - 1].url;
}

// scrapeTwitterMedia is serialized into the active tab via
// chrome.scripting.executeScript. No access to extension globals —
// everything it returns is raw JSON shuttled back to the popup.
//
// Covers both photo tweets (pbs.twimg.com/media/... <img> tags) and
// video tweets (video.twimg.com ... <video>/<source src> plus a regex
// scan of the rendered HTML as a safety net for Twitter's SPA where
// the URL is sometimes embedded in inline script blocks but not in a
// DOM src). Also walks up from each media element to find the @handle
// of the tweet that contains it, so gallery cards can show who each
// item came from.
function scrapeTwitterMedia() {
  // Scope the scan to the focused tweet's <article> so replies and
  // quoted content on the same page don't leak into the result. The
  // focused tweet is the one whose time-link href matches the status
  // ID in the current URL. On pages without a tweet status in the
  // path (or if we can't find a matching article), fall back to the
  // whole document.
  const statusMatch = location.pathname.match(/\/status\/(\d+)/);
  const mainId = statusMatch ? statusMatch[1] : "";
  let root = null;
  if (mainId) {
    for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
      const link = article.querySelector('a[href*="/status/"]');
      if (!link) continue;
      const href = link.getAttribute("href") || "";
      const m = href.match(/\/status\/(\d+)/);
      if (m && m[1] === mainId) {
        root = article;
        break;
      }
    }
  }
  const scopeDoc = root || document;
  const scopeHtml = root ? root.outerHTML : document.documentElement.outerHTML;

  const findHandle = (el) => {
    let node = el;
    while (node && node !== document.body) {
      if (node.matches && node.matches('article[data-testid="tweet"]')) {
        const u = node.querySelector('[data-testid="User-Name"]');
        if (u) {
          const m = (u.textContent || "").match(/@([A-Za-z0-9_]+)/);
          if (m) return m[1];
        }
        break;
      }
      node = node.parentElement;
    }
    return "";
  };

  // Exclude media inside quote / article / link cards (e.g. Twitter
  // Articles whose cover image lives under [data-testid="card.layout..."])
  // and media inside a *nested* tweet article (the quoted tweet sits
  // inside the main tweet's article, so query results leak otherwise).
  const isBelongingToFocusedTweet = (el) => {
    let node = el.parentElement;
    while (node && node !== document.body) {
      if (node.getAttribute) {
        const testid = node.getAttribute("data-testid") || "";
        if (testid.startsWith("card.")) return false;
      }
      if (node.matches && node.matches('article[data-testid="tweet"]')) {
        return root ? node === root : true;
      }
      node = node.parentElement;
    }
    return true;
  };

  const images = Array.from(
    /** @type {NodeListOf<HTMLImageElement>} */ (
      scopeDoc.querySelectorAll('img[src*="pbs.twimg.com/media/"]')
    ),
  )
    .filter(isBelongingToFocusedTweet)
    .map((img) => ({
      src: img.src,
      width: img.naturalWidth,
      height: img.naturalHeight,
      alt: img.alt || "",
      handle: findHandle(img),
    }));

  const videoUrlToInfo = new Map();
  scopeDoc.querySelectorAll("video").forEach((vid) => {
    if (!isBelongingToFocusedTweet(vid)) return;
    const poster = vid.getAttribute("poster") || "";
    const handle = findHandle(vid);
    if (vid.src && vid.src.indexOf("video.twimg.com") !== -1 && !videoUrlToInfo.has(vid.src)) {
      videoUrlToInfo.set(vid.src, { poster, handle });
    }
    vid.querySelectorAll("source").forEach((src) => {
      if (src.src && src.src.indexOf("video.twimg.com") !== -1 && !videoUrlToInfo.has(src.src)) {
        videoUrlToInfo.set(src.src, { poster, handle });
      }
    });
  });

  try {
    const rx = /https?:\/\/video\.twimg\.com\/[^"'\s<>)\\]+?\.mp4[^"'\s<>)\\]*/g;
    let m;
    while ((m = rx.exec(scopeHtml)) !== null) {
      if (!videoUrlToInfo.has(m[0])) videoUrlToInfo.set(m[0], { poster: "", handle: "" });
    }
  } catch {}

  const videos = [];
  for (const [url, info] of videoUrlToInfo) {
    videos.push({ src: url, posterUrl: info.poster, handle: info.handle });
  }

  const textEl = scopeDoc.querySelector('[data-testid="tweetText"]');
  return {
    images,
    videos,
    text: textEl ? textEl.textContent || "" : "",
  };
}

function extFromUrl(url) {
  try {
    const path = new URL(url).pathname;
    const m = path.match(/\.([a-zA-Z0-9]{1,5})$/);
    return m ? m[1].toLowerCase() : "";
  } catch {
    return "";
  }
}

function basenameFromUrl(url) {
  try {
    const path = new URL(url).pathname;
    return path.split("/").pop() || "image";
  } catch {
    return "image";
  }
}
