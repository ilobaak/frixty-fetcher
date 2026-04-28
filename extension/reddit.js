// @ts-check

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

// Reddit's standalone media viewer ("open image in new tab" from a post or
// a gallery). Shape: https://www.reddit.com/media?url=<url-encoded media URL>.
const MEDIA_VIEWER_RE = /^https?:\/\/(?:[^.]+\.)?reddit\.com\/media\b/i;

export function looksLikeRedditPost(url) {
  return typeof url === "string" && (POST_URL_RE.test(url) || MEDIA_VIEWER_RE.test(url));
}

export async function detectReddit(url) {
  if (!looksLikeRedditPost(url)) return null;

  // The standalone media viewer doesn't have its own JSON endpoint — the
  // actual media URL is embedded in the query string. Handle that path
  // separately so we don't fall through into the post-JSON flow below.
  if (MEDIA_VIEWER_RE.test(url)) {
    return detectMediaViewer(url);
  }

  // Strip any #fragment and trailing slash/querystring then append .json.
  // raw_json=1 asks Reddit not to HTML-escape string fields in the payload.
  const base = url.split(/[?#]/, 1)[0].replace(/\/$/, "");
  const apiUrl = `${base}.json?raw_json=1`;

  let data;
  try {
    const resp = await fetch(apiUrl, { credentials: "omit" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    data = await resp.json();
  } catch (e) {
    // Network or parse failure — let yt-dlp have a go. It'll error cleanly
    // if the URL is truly unusable.
    return { kind: "video" };
  }

  const post = data?.[0]?.data?.children?.[0]?.data;
  if (!post) return { kind: "video" };

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
      const head = await fetch(post.url, { method: "HEAD", credentials: "omit" });
      if (head.ok) {
        const len = head.headers.get("Content-Length");
        const mime = head.headers.get("Content-Type");
        if (len) info.bytes = parseInt(len, 10);
        if (mime) info.mime = mime.split(";")[0].trim();
      }
    } catch {}
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
