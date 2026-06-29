// @ts-check

import { logFetcher } from "./fetcher-log.js";

// Reddit post detection. yt-dlp's reddit extractor only surfaces video
// content; for static images and galleries we fetch Reddit's own JSON
// representation of the post and drive the download ourselves.
//
// Exports:
//   looksLikeRedditPost(url)   — cheap URL-shape check
//   detectReddit(url)          — network fetch, always hits the wire
//   detectRedditCached(url)    — caches detection results by URL in
//                                chrome.storage.session so closing +
//                                reopening the popup reuses the data.
//
// detectReddit returns one of:
//   null                       — not a Reddit post URL at all
//   { kind: "video" }          — a reddit video post; caller falls through
//                                to the existing yt-dlp flow
//   { kind: "image",  title, imageUrl, width, height, bytes?, mime? }
//   { kind: "gallery", title, items: [{url, ext}] }
//
// Anything unsupported (unknown post_hint, deleted post, etc.) resolves to
// { kind: "video" } so yt-dlp still gets a shot at it.

const CACHE_TTL_MS = 10 * 60 * 1000;

const POST_URL_RE = /^https?:\/\/(?:[^.]+\.)?reddit\.com\/r\/[^/]+\/comments\/[^/]+/i;
const SHORT_URL_RE = /^https?:\/\/redd\.it\/[a-z0-9]+/i;
const DIRECT_IMAGE_RE =
  /^https?:\/\/(?:i|preview)\.redd\.it\/[^?#]+\.(?:jpe?g|png|gif|webp)(?:[?#].*)?$/i;
const DIRECT_VIDEO_RE = /^https?:\/\/v\.redd\.it\/[a-z0-9]+/i;

// Reddit's standalone media viewer ("open image in new tab" from a post or
// a gallery). Shape: https://www.reddit.com/media?url=<url-encoded media URL>.
const MEDIA_VIEWER_RE = /^https?:\/\/(?:[^.]+\.)?reddit\.com\/media\b/i;

export function looksLikeRedditPost(url) {
  return (
    typeof url === "string" &&
    (POST_URL_RE.test(url) ||
      MEDIA_VIEWER_RE.test(url) ||
      SHORT_URL_RE.test(url) ||
      DIRECT_IMAGE_RE.test(url) ||
      DIRECT_VIDEO_RE.test(url))
  );
}

export async function detectReddit(url) {
  if (!looksLikeRedditPost(url)) return null;
  logFetcher("reddit", "detect:start", { url });

  if (DIRECT_IMAGE_RE.test(url)) {
    logFetcher("reddit", "detect:direct-image", { url });
    return detectDirectImage(url);
  }
  if (DIRECT_VIDEO_RE.test(url)) {
    logFetcher("reddit", "detect:direct-video", { url });
    return { kind: "video" };
  }

  // The standalone media viewer doesn't have its own JSON endpoint — the
  // actual media URL is embedded in the query string. Handle that path
  // separately so we don't fall through into the post-JSON flow below.
  if (MEDIA_VIEWER_RE.test(url)) {
    logFetcher("reddit", "detect:media-viewer", { url });
    return detectMediaViewer(url);
  }

  // Strip any #fragment and trailing slash/querystring then append .json.
  // raw_json=1 asks Reddit not to HTML-escape string fields in the payload.
  const base = url.split(/[?#]/, 1)[0].replace(/\/$/, "");
  const apiUrl = `${base}.json?raw_json=1`;
  logFetcher("reddit", "json:fetch", { url: apiUrl });

  let data;
  try {
    const resp = await fetch(apiUrl, { credentials: "omit" });
    if (!resp.ok) {
      logFetcher("reddit", "json:error", { url: apiUrl, status: resp.status });
      if (resp.status === 403 || resp.status === 429) return { kind: "domFallback" };
      throw new Error(`HTTP ${resp.status}`);
    }
    data = await resp.json();
  } catch (e) {
    logFetcher("reddit", "json:exception", { url: apiUrl, error: e?.message || String(e) });
    // Network, access, or parse failures are common on Reddit's JSON
    // endpoint; let the popup try rendered-page media before yt-dlp.
    return { kind: "domFallback" };
  }

  const post = data?.[0]?.data?.children?.[0]?.data;
  if (!post) {
    logFetcher("reddit", "json:empty", { url: apiUrl });
    return { kind: "video" };
  }

  const title = post.title ?? "reddit post";
  // created_utc is already unix seconds — no conversion needed. 0 when
  // the field is missing (rare) signals "unknown date" to the popup.
  const date = Math.floor(Number(post.created_utc) || 0);
  // Reddit's "author" field is the submitter's username (no u/ prefix).
  const handle = typeof post.author === "string" ? post.author : "";

  if (post.is_gallery && post.gallery_data?.items && post.media_metadata) {
    const items = [];
    for (const entry of post.gallery_data.items) {
      const meta = post.media_metadata[entry.media_id];
      if (!meta || meta.status !== "valid") continue;
      const item = extractGalleryItem(meta);
      if (item) items.push(item);
    }
    if (items.length === 0) return { kind: "video" };
    logFetcher("reddit", "gallery:result", { url, itemCount: items.length });
    return { kind: "gallery", title, handle, date, items };
  }

  if (post.post_hint === "image" && typeof post.url === "string") {
    const firstPreview = post.preview?.images?.[0];
    const info = {
      kind: "image",
      title,
      handle,
      date,
      imageUrl: post.url,
      width: firstPreview?.source?.width ?? 0,
      height: firstPreview?.source?.height ?? 0,
      thumbUrl: pickPreviewUrl(firstPreview) || post.url,
      basename: basenameFromUrl(post.url),
    };
    // Ask the image host directly for a Content-Length and Content-Type so
    // the popup can show a real file size and confirmed MIME. Failures are
    // non-fatal — if the HEAD is blocked we just omit size/mime.
    try {
      logFetcher("reddit", "image-head:fetch", { url: post.url });
      const head = await fetch(post.url, { method: "HEAD", credentials: "omit" });
      if (head.ok) {
        const len = head.headers.get("Content-Length");
        const mime = head.headers.get("Content-Type");
        if (len) info.bytes = parseInt(len, 10);
        if (mime) info.mime = mime.split(";")[0].trim();
      }
    } catch {}
    logFetcher("reddit", "image:result", { url: post.url, width: info.width, height: info.height });
    return info;
  }

  // hosted:video, rich:video, self-text, links, etc. — defer to yt-dlp.
  return { kind: "video" };
}

// detectRedditCached is the same as detectReddit but consults and writes
// through chrome.storage.session, so closing and reopening the popup
// doesn't re-fetch the Reddit JSON + HEAD. The {kind:"video"} sentinel is
// not cached — it just tells the caller to fall through to yt-dlp, and
// re-running the check is nearly free (JSON parse of a small payload).
export async function detectRedditCached(url) {
  const key = `reddit:${url}`;
  try {
    const { [key]: entry } = await chrome.storage.session.get(key);
    if (entry && Date.now() - entry.at < CACHE_TTL_MS) {
      return entry.info;
    }
  } catch {}
  const info = await detectReddit(url);
  if (info && (info.kind === "image" || info.kind === "gallery")) {
    try {
      await chrome.storage.session.set({ [key]: { info, at: Date.now() } });
    } catch {}
  }
  return info;
}

export async function getRedditDomInfo(tabId) {
  try {
    let targetTabId = tabId;
    if (!targetTabId) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      targetTabId = tab?.id;
    }
    if (!targetTabId) return null;
    const results = await chrome.scripting.executeScript({
      target: { tabId: targetTabId },
      func: scrapeRedditDom,
    });
    const raw = results?.[0]?.result;
    if (!raw) return null;
    logFetcher("reddit", "dom:result", {
      kind: raw.kind || "",
      itemCount: raw.items?.length || (raw.kind === "image" ? 1 : 0),
    });
    if (raw.kind === "image" && raw.imageUrl) return raw;
    if (raw.kind === "gallery" && raw.items?.length) return raw;
    if (raw.kind === "video") return raw;
  } catch {}
  return null;
}

// detectMediaViewer handles https://www.reddit.com/media?url=... URLs that
// Reddit uses when you open an image from a gallery or post in its own tab.
// There's no post JSON to consult — the media URL is embedded in the query
// string. We decode it, HEAD it for size/MIME, and expose it as an image
// info object shaped identically to the post-based single-image path, so
// the popup's image picker handles both with one code path.
async function detectMediaViewer(url) {
  let imageUrl;
  try {
    const parsed = new URL(url);
    const raw = parsed.searchParams.get("url");
    if (!raw) return { kind: "video" };
    imageUrl = decodeURIComponent(raw);
  } catch {
    return { kind: "video" };
  }

  const basename = basenameFromUrl(imageUrl);
  const title = (basename.replace(/\.[^.]+$/, "") || "Reddit image").trim();

  const info = {
    kind: "image",
    title,
    imageUrl,
    width: 0,
    height: 0,
    thumbUrl: imageUrl, // no separate preview; browser caches the fetch.
    basename,
  };

  // Preview URLs often carry a `width=` hint even when we can't know the
  // height without loading the pixels. Showing just width/height when both
  // are known, per renderImageMeta, so we try for both.
  try {
    const w = parseInt(new URL(imageUrl).searchParams.get("width") ?? "", 10);
    if (!Number.isNaN(w) && w > 0) info.width = w;
  } catch {}

  try {
    const head = await fetch(imageUrl, { method: "HEAD", credentials: "omit" });
    if (head.ok) {
      const len = head.headers.get("Content-Length");
      const mime = head.headers.get("Content-Type");
      if (len) info.bytes = parseInt(len, 10);
      if (mime) info.mime = mime.split(";")[0].trim();
    }
  } catch {}
  return info;
}

async function detectDirectImage(imageUrl) {
  const basename = basenameFromUrl(imageUrl);
  const title = (basename.replace(/\.[^.]+$/, "") || "Reddit image").trim();
  const info = {
    kind: "image",
    title,
    imageUrl,
    width: 0,
    height: 0,
    thumbUrl: imageUrl,
    basename,
  };
  try {
    logFetcher("reddit", "direct-image-head:fetch", { url: imageUrl });
    const head = await fetch(imageUrl, { method: "HEAD", credentials: "omit" });
    if (head.ok) {
      const len = head.headers.get("Content-Length");
      const mime = head.headers.get("Content-Type");
      if (len) info.bytes = parseInt(len, 10);
      if (mime) info.mime = mime.split(";")[0].trim();
    }
  } catch {}
  logFetcher("reddit", "direct-image:result", {
    url: imageUrl,
    bytes: info.bytes || 0,
    mime: info.mime || "",
  });
  return info;
}

function scrapeRedditDom() {
  function findRedditMediaRoots() {
    const roots = [
      ...document.querySelectorAll(
        [
          "shreddit-post",
          '[id^="media-preview-"]',
          ".media-preview",
          "gallery-carousel",
          "faceplate-carousel",
          "[data-testid='post-container']",
        ].join(", "),
      ),
    ];
    const unique = [];
    const rootSeen = new Set();
    for (const root of roots) {
      if (!root || rootSeen.has(root)) continue;
      rootSeen.add(root);
      unique.push(root);
    }
    return unique.length > 0 ? unique : [document.body];
  }

  const title =
    document.querySelector('meta[property="og:title"]')?.getAttribute("content") ||
    document.querySelector('meta[name="twitter:title"]')?.getAttribute("content") ||
    document.querySelector("shreddit-post")?.getAttribute("post-title") ||
    document.querySelector("a.title")?.textContent?.trim() ||
    document.querySelector("h1")?.textContent?.trim() ||
    "reddit post";
  const handle =
    document.querySelector("shreddit-post")?.getAttribute("author") ||
    document.querySelector(".tagline .author")?.textContent?.trim()?.replace(/^u\//, "") ||
    document.querySelector('[slot="authorName"]')?.textContent?.trim()?.replace(/^u\//, "") ||
    "";
  const seen = new Set();
  const items = [];
  const mediaRoots = findRedditMediaRoots();
  const hasPostVideo = mediaRoots.some((root) => {
    return (
      root.querySelector("video") ||
      root.querySelector("[data-hls-url], [data-mpd-url]") ||
      root.getAttribute?.("data-hls-url") ||
      root.getAttribute?.("data-mpd-url")
    );
  });
  const add = (src, width = 0, height = 0) => {
    if (!src || seen.has(src)) return;
    let u;
    try {
      u = new URL(src, location.href);
    } catch {
      return;
    }
    if (!/^(?:i|preview)\.redd\.it$/i.test(u.hostname)) return;
    if (!/\.(?:jpe?g|png|gif|webp)$/i.test(u.pathname)) return;
    const hintedWidth = Number(u.searchParams.get("width")) || 0;
    const hintedHeight = Number(u.searchParams.get("height")) || 0;
    const w = Number(width) || hintedWidth || 0;
    const h = Number(height) || hintedHeight || 0;
    const isSquareThumb =
      u.searchParams.get("crop")?.startsWith("1:1") ||
      (hintedWidth > 0 && hintedHeight > 0 && hintedWidth <= 200 && hintedHeight <= 200);
    if (isSquareThumb) return;
    if (w > 0 && h > 0 && w <= 200 && h <= 200) return;
    seen.add(u.href);
    const basename = u.pathname.split("/").pop() || "image.jpg";
    const ext = (basename.match(/\.([^.]+)$/)?.[1] || "jpg").toLowerCase();
    items.push({
      url: u.href,
      ext,
      width: w,
      height: h,
      thumbUrl: u.href,
      mime: `image/${ext === "jpg" ? "jpeg" : ext}`,
      basename,
    });
  };
  for (const root of mediaRoots) {
    for (const img of root.querySelectorAll("img")) {
      add(
        img.currentSrc || img.src,
        img.naturalWidth || img.width,
        img.naturalHeight || img.height,
      );
    }
  }
  if (items.length === 0) {
    add(
      document.querySelector('meta[property="og:image"]')?.getAttribute("content"),
      Number(document.querySelector('meta[property="og:image:width"]')?.getAttribute("content")) ||
        0,
      Number(document.querySelector('meta[property="og:image:height"]')?.getAttribute("content")) ||
        0,
    );
  }
  if (items.length === 0 && hasPostVideo) return { kind: "video" };
  if (items.length === 1) {
    return {
      kind: "image",
      title,
      handle,
      imageUrl: items[0].url,
      width: items[0].width,
      height: items[0].height,
      thumbUrl: items[0].thumbUrl,
      mime: items[0].mime,
      basename: items[0].basename,
    };
  }
  if (items.length > 1) return { kind: "gallery", title, handle, items };
  return null;
}

export const __test = { scrapeRedditDom };

// extractGalleryItem turns one media_metadata entry into the per-item shape
// the popup's gallery picker consumes. Handles both static Image entries
// and AnimatedImage entries (which Reddit ships as both a GIF and an MP4 —
// MP4 is preferred: smaller, sharper, same content). RedditVideo gallery
// entries are rare; we treat their source URL best-effort if one is there.
function extractGalleryItem(meta) {
  const width = meta.s?.x ?? 0;
  const height = meta.s?.y ?? 0;
  const thumbUrl = pickThumbnailUrl(meta);

  let url;
  let ext;
  let mime;
  if (meta.e === "AnimatedImage" && meta.s?.mp4) {
    url = meta.s.mp4;
    ext = "mp4";
    mime = "video/mp4";
  } else if (meta.s?.u) {
    url = meta.s.u;
    ext = mimeToExt(meta.m);
    mime = meta.m;
  } else if (meta.s?.gif) {
    url = meta.s.gif;
    ext = "gif";
    mime = "image/gif";
  } else {
    return null;
  }
  return {
    url,
    ext,
    width,
    height,
    thumbUrl,
    mime,
    entryType: meta.e,
    basename: basenameFromUrl(url),
  };
}

// pickThumbnailUrl picks the preview closest to 216px wide from Reddit's
// sorted `p[]` array. Falls back to the source URL. 216px is chosen to fit
// comfortably at ~2x on a 48px-wide thumbnail without wasting bandwidth.
function pickThumbnailUrl(meta) {
  if (meta.p && meta.p.length > 0) {
    for (const p of meta.p) {
      if (p.x >= 216) return p.u;
    }
    const largest = meta.p[meta.p.length - 1];
    if (largest?.u) return largest.u;
  }
  return meta.s?.u ?? "";
}

// pickPreviewUrl grabs the "close to 320px wide" entry from Reddit's single-
// post preview resolutions array (the single-image equivalent of
// pickThumbnailUrl). Reddit serves these with query strings baked in; the
// extension has host_permissions so the <img src> loads without issue.
function pickPreviewUrl(image) {
  if (!image) return "";
  if (Array.isArray(image.resolutions)) {
    for (const r of image.resolutions) {
      if (r.width >= 320) return r.url;
    }
    const largest = image.resolutions[image.resolutions.length - 1];
    if (largest?.url) return largest.url;
  }
  return image.source?.url ?? "";
}

function basenameFromUrl(url) {
  try {
    const path = new URL(url).pathname;
    return path.split("/").pop() || "file";
  } catch {
    return "file";
  }
}

function mimeToExt(mime) {
  switch (mime) {
    case "image/jpg":
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    default:
      // Best-effort fallback; the host will verify by content if needed.
      return "jpg";
  }
}
