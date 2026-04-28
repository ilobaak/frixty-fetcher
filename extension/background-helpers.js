// Pure helpers extracted from background.js so they're testable without
// the service-worker environment. Functions in this module:
//   - take plain inputs and return plain outputs,
//   - never call chrome.* APIs,
//   - never read or write module-level state.
//
// The SW imports them; the test suite imports them too. Keep additions
// here narrow to that contract — anything that touches storage, cookies,
// ports, or runtime listeners stays in background.js where it belongs.

// captureKey produces the chrome.storage.session key the per-tab
// grab-button capture list lives under.
export function captureKey(tabId) {
  return `capture:list:${tabId}`;
}

// isCacheable reports whether a host response is worth caching.
// Currently only successful "formats" replies — error / progress /
// done events change every call and are useless to cache.
export function isCacheable(msg) {
  return Boolean(msg && msg.type === "formats");
}

// sectionOf returns the first non-empty path segment of url's pathname,
// or "" on parse failure. Used to detect Facebook navigation between
// sections (watch/reel/marketplace/etc.) so capture lists scoped to the
// previous section don't bleed into the next one.
export function sectionOf(url) {
  try {
    const u = new URL(url);
    return u.pathname.split("/").filter(Boolean)[0] || "";
  } catch {
    return "";
  }
}

// topLevelSiteFor returns the partitionKey.topLevelSite value to pass
// to chrome.cookies.getAll for the URL the popup is downloading from.
// The CookiePartitionKey spec defines it as "scheme://eTLD+1"; we use
// the URL's hostname since none of the supported sites sit on a
// multi-level public suffix.
export function topLevelSiteFor(url) {
  if (!url) return "";
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}`;
  } catch {
    return "";
  }
}

// siteCookieDomains returns the cookie domains that need to be exported
// for a download from `url`. Hosts the extension recognizes map to a
// canonical 1- or 2-element list:
//   - twitter / x: ["twitter.com", "x.com"] — the rebrand split tokens
//     across both registrable domains.
//   - youtube: ["youtube.com", "google.com"] — login lives on
//     accounts.google.com; without those SAPISID/HSID/SSID cookies,
//     authenticated requests fail even when youtube.com cookies are
//     attached.
//   - instagram, facebook, tiktok: single registrable domain each.
// Unrecognized hosts return [] so the host-side cookies path is a
// no-op (caller falls through to anonymous yt-dlp).
export function siteCookieDomains(url) {
  if (!url) return [];
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return [];
  }
  if (
    host === "twitter.com" ||
    host.endsWith(".twitter.com") ||
    host === "x.com" ||
    host.endsWith(".x.com")
  ) {
    return ["twitter.com", "x.com"];
  }
  if (
    host === "youtube.com" ||
    host.endsWith(".youtube.com") ||
    host === "youtu.be" ||
    host.endsWith(".youtu.be")
  ) {
    return ["youtube.com", "google.com"];
  }
  if (host === "instagram.com" || host.endsWith(".instagram.com")) {
    return ["instagram.com"];
  }
  if (
    host === "facebook.com" ||
    host.endsWith(".facebook.com") ||
    host === "fb.watch" ||
    host.endsWith(".fb.watch")
  ) {
    return ["facebook.com"];
  }
  if (host === "tiktok.com" || host.endsWith(".tiktok.com")) {
    return ["tiktok.com"];
  }
  return [];
}

// formatNetscapeCookie renders a chrome.cookies.Cookie object into a
// single Netscape-format cookies.txt line. yt-dlp parses this format
// when --cookies <file> is set.
//
// Format: domain TAB includeSubdomains TAB path TAB secure TAB expires
//   TAB name TAB value
// Lines for HttpOnly cookies are prefixed with "#HttpOnly_" — yt-dlp's
// tolerance for the convention; without it some downloaders drop the
// cookie thinking it's a comment.
export function formatNetscapeCookie(c) {
  let domain = c.domain || "";
  const includeSubdomains = c.hostOnly ? "FALSE" : "TRUE";
  if (!c.hostOnly && !domain.startsWith(".")) domain = "." + domain;
  const secure = c.secure ? "TRUE" : "FALSE";
  const expires = c.session ? "0" : String(Math.floor(c.expirationDate ?? 0));
  const prefix = c.httpOnly ? "#HttpOnly_" : "";
  return `${prefix}${domain}\t${includeSubdomains}\t${c.path || "/"}\t${secure}\t${expires}\t${c.name}\t${c.value}`;
}

// buildTtRelayMessage transforms a host-side TikTok job event into the
// shape the per-tab content script expects (`tt:dl-progress` /
// `tt:dl-done` / `tt:dl-error`). Returns null for any other message
// type so the caller can short-circuit. The actual chrome.tabs.
// sendMessage dispatch lives in background.js.
export function buildTtRelayMessage(msg) {
  if (!msg) return null;
  if (msg.type === "progress") {
    return {
      type: "tt:dl-progress",
      jobId: msg.jobId,
      percent: msg.percent ?? 0,
      speed: msg.speed ?? 0,
      eta: msg.eta ?? 0,
    };
  }
  if (msg.type === "done") {
    return { type: "tt:dl-done", jobId: msg.jobId, path: msg.path ?? "" };
  }
  if (msg.type === "error") {
    return {
      type: "tt:dl-error",
      jobId: msg.jobId,
      code: msg.code ?? "",
      message: msg.message ?? "",
    };
  }
  return null;
}
