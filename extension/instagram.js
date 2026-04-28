// Instagram detection + media resolution for the popup. Extracted
// from popup.js in the sprint-2 decomposition pass. Keeps popup.js
// focused on orchestration + rendering rather than per-site scraping.
//
// Exports:
//   looksLikeInstagram(url)     — cheap URL-shape check
//   isInstagramStoryUrl(url)    — narrower: /stories/... only
//   getInstagramPostInfo(url)   — /api/v1/media/<id>/info/ → image|gallery|null
//   getInstagramStoryInfo(url)  — reels_media endpoint → image|gallery|null
//   getInstagramDomInfo()       — DOM-scrape fallback for when the API
//                                 refuses (not logged in, rate limit, etc.)
//
// Everything that was scoped to popup.js (dlog, filename helpers, the
// ID decoder) now comes in via shared.js OR is passed in at call time.
//
// Returns the same {kind, title, handle, ...} shape the other site
// modules use so the popup's pickers don't need a new code path.

import { shortcodeToMediaId, IG_APP_ID, basenameFromUrl, extensionFromUrl } from "./shared.js";

const dlog = (step, ...args) => console.log("[frixty/ig]", step, ...args);

// ---- URL helpers ----------------------------------------------------

export function looksLikeInstagram(url) {
  if (typeof url !== "string") return false;
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith("instagram.com")) return false;
    return /^\/(p|reel|reels|stories)\//.test(u.pathname);
  } catch {
    return false;
  }
}

export function isInstagramStoryUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname.endsWith("instagram.com") && u.pathname.startsWith("/stories/");
  } catch {
    return false;
  }
}

function instagramStoryUsername(url) {
  try {
    const seg = new URL(url).pathname.split("/").filter(Boolean);
    if (seg[0] === "stories" && seg[1]) return seg[1];
  } catch {}
  return "";
}

// instagramPostShortcode pulls the base64url-ish shortcode out of a
// /p/<code>/ or /reel/<code>/ URL. Returns "" when the URL doesn't
// match either shape.
function instagramPostShortcode(url) {
  try {
    const seg = new URL(url).pathname.split("/").filter(Boolean);
    if (seg.length >= 2 && ["p", "reel", "reels"].includes(seg[0])) {
      return seg[1];
    }
  } catch {}
  return "";
}

// ---- API-driven detection ------------------------------------------

// getInstagramPostInfo hits Instagram's /api/v1/media/<id>/info/ with
// the media_id derived from the shortcode in the URL. This is the
// source of truth for how many slides a carousel has (the DOM only
// renders whatever's currently on-screen + lazy-load buffer) and what
// post they belong to (the page can contain suggested / related posts
// whose images our DOM scraper can't distinguish from the real thing).
//
// Returns null on any failure so the caller can fall back to DOM
// scraping / yt-dlp.
export async function getInstagramPostInfo(url) {
  const shortcode = instagramPostShortcode(url);
  if (!shortcode) return null;
  const mediaId = shortcodeToMediaId(shortcode);
  if (!mediaId) return null;

  let payload;
  try {
    const resp = await fetch(`https://www.instagram.com/api/v1/media/${mediaId}/info/`, {
      headers: { "X-IG-App-ID": IG_APP_ID },
      credentials: "include",
    });
    if (!resp.ok) {
      dlog("media info failed", { shortcode, status: resp.status });
      return null;
    }
    payload = await resp.json();
  } catch (err) {
    dlog("media info error", err?.message);
    return null;
  }

  const media = payload?.items?.[0];
  if (!media) {
    dlog("media info: empty items");
    return null;
  }

  const handle = media.user?.username || media.owner?.username || "";
  const caption = media.caption?.text ?? "";
  const title = caption ? caption.replace(/\s+/g, " ").trim().slice(0, 80) : `@${handle} post`;
  const date = typeof media.taken_at === "number" ? media.taken_at : 0;

  // media_type: 1=image, 2=video, 8=carousel. For carousels, walk
  // carousel_media and turn each into its own gallery item. For single
  // image/video, wrap in a one-item list and route through the image
  // picker (single image) or gallery (single video).
  const slides =
    Array.isArray(media.carousel_media) && media.carousel_media.length > 0
      ? media.carousel_media
      : [media];

  const items = [];
  for (const slide of slides) {
    items.push(instagramSlideToItem(slide, handle));
  }
  const cleaned = items.filter(Boolean);
  if (cleaned.length === 0) return null;

  if (cleaned.length === 1 && cleaned[0].mime?.startsWith("image/")) {
    const i = cleaned[0];
    return {
      kind: "image",
      title,
      handle,
      date,
      imageUrl: i.url,
      thumbUrl: i.thumbUrl,
      width: i.width,
      height: i.height,
      mime: i.mime,
      basename: i.basename,
    };
  }
  return { kind: "gallery", title, handle, date, items: cleaned };
}

// instagramSlideToItem maps one media record (top-level for a single
// post, or a carousel_media entry for multi-slide posts) into the
// gallery-item shape the picker expects.
function instagramSlideToItem(slide, handle) {
  if (!slide) return null;
  const isVideo =
    slide.media_type === 2 &&
    Array.isArray(slide.video_versions) &&
    slide.video_versions.length > 0;
  const poster = pickInstagramCandidate(slide.image_versions2?.candidates);
  if (isVideo) {
    const vv = slide.video_versions[0];
    return {
      url: vv.url,
      ext: "mp4",
      width: vv.width || 0,
      height: vv.height || 0,
      thumbUrl: poster || "",
      mime: "video/mp4",
      basename: basenameFromUrl(vv.url) || "video.mp4",
      handle,
    };
  }
  const best = bestInstagramCandidate(slide.image_versions2?.candidates);
  if (!best?.url) return null;
  const ext = extensionFromUrl(best.url) || "jpg";
  return {
    url: best.url,
    ext,
    width: best.width || 0,
    height: best.height || 0,
    thumbUrl: poster || best.url,
    mime: `image/${ext === "jpg" ? "jpeg" : ext}`,
    basename: basenameFromUrl(best.url) || `image.${ext}`,
    handle,
  };
}

// getInstagramStoryInfo hits Instagram's private reels_media endpoint
// to pull *every* story part for the current user — not just the one
// the viewer happens to be on. Requires the user to be logged into
// Instagram in the browser so their cookies authenticate the call.
export async function getInstagramStoryInfo(url) {
  const username = instagramStoryUsername(url);
  if (!username) {
    dlog("story: no username in path");
    return null;
  }

  let userId = "";
  try {
    const resp = await fetch(
      `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`,
      { headers: { "X-IG-App-ID": IG_APP_ID }, credentials: "include" },
    );
    if (!resp.ok) {
      dlog("profile fetch failed", { status: resp.status });
      return null;
    }
    const data = await resp.json();
    userId = data?.data?.user?.id ?? "";
  } catch (err) {
    dlog("profile fetch error", err?.message);
    return null;
  }
  if (!userId) {
    dlog("story: no user_id for", username);
    return null;
  }

  let reel;
  try {
    const resp = await fetch(
      `https://www.instagram.com/api/v1/feed/reels_media/?reel_ids=${userId}`,
      { headers: { "X-IG-App-ID": IG_APP_ID }, credentials: "include" },
    );
    if (!resp.ok) {
      dlog("reels_media fetch failed", { status: resp.status });
      return null;
    }
    const data = await resp.json();
    // The response wraps stories under reels[<user_id>]. Earlier API
    // versions used reels_media[0], but the reel_ids variant nests.
    reel = data?.reels?.[userId] ?? data?.reels_media?.[0] ?? null;
  } catch (err) {
    dlog("reels_media fetch error", err?.message);
    return null;
  }
  if (!reel) {
    dlog("story: user has no active story");
    return null;
  }

  const rawItems = Array.isArray(reel.items) ? reel.items : [];
  if (rawItems.length === 0) return null;

  const items = [];
  let storyDate = 0;
  for (const it of rawItems) {
    const isVideo = Array.isArray(it.video_versions) && it.video_versions.length > 0;
    const posterUrl = pickInstagramCandidate(it.image_versions2?.candidates);
    if (isVideo) {
      const vv = it.video_versions[0];
      const ext = "mp4";
      items.push({
        url: vv.url,
        ext,
        width: vv.width || 0,
        height: vv.height || 0,
        thumbUrl: posterUrl || "",
        mime: "video/mp4",
        basename: basenameFromUrl(vv.url) || `story.${ext}`,
        handle: username,
      });
    } else if (posterUrl) {
      const ext = extensionFromUrl(posterUrl) || "jpg";
      const biggest = bestInstagramCandidate(it.image_versions2?.candidates);
      items.push({
        url: biggest?.url || posterUrl,
        ext,
        width: biggest?.width || 0,
        height: biggest?.height || 0,
        thumbUrl: posterUrl,
        mime: `image/${ext === "jpg" ? "jpeg" : ext}`,
        basename: basenameFromUrl(biggest?.url || posterUrl) || `story.${ext}`,
        handle: username,
      });
    }
    if (typeof it.taken_at === "number" && (!storyDate || it.taken_at < storyDate)) {
      storyDate = it.taken_at;
    }
  }
  if (items.length === 0) return null;

  const title = `@${username} stories`;
  if (items.length === 1) {
    const i = items[0];
    if (i.mime.startsWith("image/")) {
      return {
        kind: "image",
        title,
        handle: username,
        date: storyDate,
        imageUrl: i.url,
        thumbUrl: i.thumbUrl,
        width: i.width,
        height: i.height,
        mime: i.mime,
        basename: i.basename,
      };
    }
  }
  return { kind: "gallery", title, handle: username, date: storyDate, items };
}

// pickInstagramCandidate returns the first candidate URL (smallest, good
// for thumbnails). bestInstagramCandidate returns the largest by area
// (best for the actual download).
function pickInstagramCandidate(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return "";
  // The last entry is typically the smallest / most compressed.
  return candidates[candidates.length - 1]?.url || candidates[0]?.url || "";
}

function bestInstagramCandidate(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  let best = null;
  let bestArea = 0;
  for (const c of candidates) {
    const area = (c?.width || 0) * (c?.height || 0);
    if (area > bestArea) {
      best = c;
      bestArea = area;
    }
  }
  return best || candidates[0];
}

// getInstagramDomInfo is the DOM-scrape fallback used when neither the
// API path (getInstagramPostInfo) nor the story path (getInstagramStory
// Info) produced a result — typically when the user opened the popup on
// an Instagram URL we don't have an API extractor for, or when the API
// is rate-limiting us. It serializes scrapeInstagramMedia into the page
// via chrome.scripting.executeScript and reshapes the raw JSON into the
// info object the popup's pickers expect.
export async function getInstagramDomInfo() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id === undefined) return null;

  let scraped;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scrapeInstagramMedia,
    });
    scraped = results?.[0]?.result;
  } catch (err) {
    dlog("scrape failed", err?.message);
    return null;
  }
  if (!scraped) return null;
  dlog("scrape", {
    images: scraped.images?.length ?? 0,
    videos: scraped.videos?.length ?? 0,
    handle: scraped.handle,
  });

  const images = (scraped.images ?? []).map((i) => {
    const ext = extensionFromUrl(i.src) || "jpg";
    return {
      url: i.src,
      ext,
      width: i.width || 0,
      height: i.height || 0,
      thumbUrl: i.src,
      mime: `image/${ext === "jpg" ? "jpeg" : ext}`,
      basename: basenameFromUrl(i.src) || `image.${ext}`,
      handle: scraped.handle || "",
    };
  });
  const videos = (scraped.videos ?? []).map((v) => {
    const ext = extensionFromUrl(v.src) || "mp4";
    return {
      url: v.src,
      ext,
      width: 0,
      height: 0,
      thumbUrl: v.poster || "",
      mime: "video/mp4",
      basename: basenameFromUrl(v.src) || `video.${ext}`,
      handle: scraped.handle || "",
    };
  });

  const items = [...images, ...videos];
  if (items.length === 0) return null;

  const title = scraped.title || "Instagram post";
  const handle = scraped.handle || "";
  const date = scraped.date || 0;

  if (items.length === 1 && images.length === 1) {
    const i = items[0];
    return {
      kind: "image",
      title,
      handle,
      date,
      imageUrl: i.url,
      thumbUrl: i.thumbUrl,
      width: i.width,
      height: i.height,
      mime: i.mime,
      basename: i.basename,
    };
  }
  return { kind: "gallery", title, handle, date, items };
}

// scrapeInstagramMedia is serialized into the active tab via
// chrome.scripting.executeScript, so it cannot reference extension-side
// imports — only plain JSON comes back. Covers:
//
//  - /p/<shortcode>/ posts: single image, carousel (multi-image), or
//    single video. Pulls <img>/<video> inside the <article> element.
//  - /stories/<user>/: one story at a time, rendered inside
//    section[role="presentation"]. Same approach.
//  - /reel/<shortcode>/: would also match but reels are best handled by
//    yt-dlp (picks correct variant + audio track); we still scrape but
//    if there are no images the outer code returns null and yt-dlp
//    takes over anyway.
//
// Filters out profile pictures, tiny thumbnails, sprite/emoji icons.
function scrapeInstagramMedia() {
  const result = { images: [], videos: [], title: "", handle: "", date: 0 };

  // Handle resolution, in preference order:
  //  1. /stories/<user>/ URLs put the user right in the path.
  //  2. /profile/<user>/ same.
  //  3. Post/reel URLs don't carry the uploader — scan the article's
  //     header for an <a href="/<user>/"> link (that's Instagram's
  //     profile link pattern). Walking hrefs is more reliable than
  //     textContent because the header often renders the display name
  //     (with spaces / emoji) rather than the handle.
  const RESERVED_IG_SEGMENTS = new Set([
    "p",
    "reel",
    "reels",
    "stories",
    "explore",
    "accounts",
    "direct",
    "challenge",
    "tv",
    "about",
    "privacy",
    "terms",
    "press",
  ]);
  const ogUrl = document.querySelector('meta[property="og:url"]')?.content || location.href;
  try {
    const u = new URL(ogUrl);
    const seg = u.pathname.split("/").filter(Boolean);
    if (seg.length >= 2 && seg[0] === "stories") {
      result.handle = seg[1];
    } else if (seg.length >= 1 && !RESERVED_IG_SEGMENTS.has(seg[0])) {
      result.handle = seg[0];
    }
  } catch {}

  if (!result.handle) {
    const header = document.querySelector("article header");
    if (header) {
      // Find all profile-looking links. Skip the current post's /p/...
      // href, skip /explore/, /reels/, etc.
      for (const a of header.querySelectorAll("a[href]")) {
        const href = a.getAttribute("href") || "";
        const m = href.match(/^\/([^/?#]+)\/?$/);
        if (!m) continue;
        const name = m[1];
        if (RESERVED_IG_SEGMENTS.has(name)) continue;
        // Instagram usernames: letters, digits, dots, underscores.
        if (/^[\w.]+$/.test(name)) {
          result.handle = name;
          break;
        }
      }
    }
  }

  // Title: og:title usually reads "<user> on Instagram: \"caption\"".
  // Extract just the caption where possible.
  const ogTitle = document.querySelector('meta[property="og:title"]')?.content || "";
  let caption = "";
  const quoted = ogTitle.match(/"([^"]+)"/);
  if (quoted) caption = quoted[1];
  else caption = ogTitle.replace(/ on Instagram.*$/, "").trim();
  result.title = caption || "Instagram post";

  // Date: Instagram embeds publish times in <time datetime="..."> tags
  // inside the post article. Pick the first one.
  const timeEl = document.querySelector("article time[datetime], section time[datetime]");
  const dt = timeEl?.getAttribute("datetime");
  if (dt) {
    const ms = Date.parse(dt);
    if (Number.isFinite(ms)) result.date = Math.floor(ms / 1000);
  }

  // Media: scope to the article (posts/reels) or presentation section
  // (stories). Fall back to document if neither is present.
  const scope =
    document.querySelector("article") ||
    document.querySelector('section[role="presentation"]') ||
    document.body;

  for (const img of scope.querySelectorAll("img")) {
    const src = img.currentSrc || img.src;
    if (!src) continue;
    // Instagram's CDN paths all contain /v/t51 or /v/t39; profile_pic
    // thumbnails go under /v/t51.2885-19/ which we explicitly drop.
    if (src.includes("/profile_pic/") || /\/t51\.2885-19\//.test(src)) continue;
    // Skip sprite/icon-sized images.
    if ((img.naturalWidth || img.width || 0) < 150) continue;
    result.images.push({
      src,
      width: img.naturalWidth || img.width || 0,
      height: img.naturalHeight || img.height || 0,
    });
  }

  for (const video of scope.querySelectorAll("video")) {
    const src = video.currentSrc || video.src;
    if (!src) continue;
    result.videos.push({ src, poster: video.poster || "" });
  }

  return result;
}
