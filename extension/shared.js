// @ts-check

// Small helpers shared by popup.js and background.js. Both are ES
// modules, so they can import directly; content scripts (which run in
// an isolated world without module support by default) still have to
// inline these if they need them. Keeping the canonical copy here so
// any future change only has to touch one file — and when a content
// script's copy drifts, we have an obvious source of truth to compare
// against.

// Decode an Instagram post shortcode (from /p/<code>/ or /reel/<code>/)
// into the numeric media_id the /api/v1/media/<id>/info/ endpoint
// wants. The shortcode is base64url-encoded (A-Z a-z 0-9 - _, six bits
// each, big-endian) and the decoded integer IS the media_id. BigInt
// because IDs overflow Number's 53-bit safe-integer range.
//
// Returns "" when the input contains a character outside the alphabet.
export function shortcodeToMediaId(shortcode) {
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let id = 0n;
  for (const ch of shortcode) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) return "";
    id = (id << 6n) + BigInt(idx);
  }
  return id.toString();
}

// Derive the short token Twitter's syndication endpoint expects from a
// tweet ID. Mirrors Twitter's own widget-js derivation: Number(id) /
// 1e15 (yes, lossy for 64-bit IDs, but Twitter uses it both client-
// and server-side so the value matches), × π, toString(36), strip
// zeros and dots. Same algorithm is inlined in twitter-post-grab.js's
// content-script context because content scripts can't import this
// file — keep the two in sync.
export function computeSyndicationToken(tweetId) {
  return ((Number(tweetId) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
}

// Shared ID for Instagram's web frontend. Not a secret — cribbed from
// their public web bundle. Any call to /api/v1/ needs this header OR
// a fresh CSRF token we'd have to extract from the page.
export const IG_APP_ID = "936619743392459";

// ---- URL filename helpers ------------------------------------------
// Tiny pure functions for pulling the last path segment / extension
// off a URL. Used by every site module + the download flow — used to
// live in popup.js but got promoted here so the per-site modules can
// import them without reaching back into the popup.

export function basenameFromUrl(url) {
  try {
    const path = new URL(url).pathname;
    return path.split("/").pop() || "image";
  } catch {
    return "image";
  }
}

export function extensionFromUrl(url) {
  try {
    const path = new URL(url).pathname;
    const m = path.match(/\.([a-zA-Z0-9]{1,5})$/);
    return m ? m[1].toLowerCase() : "";
  } catch {
    return "";
  }
}

// sanitizeFilenameSegment strips the characters Windows/macOS/Linux
// reject in filenames, collapses whitespace, and trims trailing dots
// or spaces (Windows refuses those). Not clipped to a character
// budget — the caller handles that.
export function sanitizeFilenameSegment(s) {
  return String(s)
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "");
}

// WIN_RESERVED matches the Windows reserved device names (CON, PRN,
// AUX, NUL, COM1–9, LPT1–9) plus optional extension. Used by the
// filename builders to prefix an underscore so a literal "con.txt"
// doesn't fail to write on Windows.
export const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

// buildSafeFilename produces a safe-on-every-platform "<name>.<ext>"
// from a user-facing base + extension, optionally suffixing with a
// caller-controlled string (e.g. " 01" for a gallery index) that's
// reserved against the 150-char budget so the suffix survives even
// when the base has to be clipped. Empty input returns "" — callers
// pick how to fall back (URL basename, ID prefix, or letting the
// downloader name the file itself). Reserved Windows names are
// underscore-prefixed.
export function buildSafeFilename(base, ext, suffix = "") {
  const BUDGET = 150;
  let safe = sanitizeFilenameSegment(base ?? "");
  const cleanSuffix = String(suffix)
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/\s+/g, " ");
  const baseBudget = Math.max(1, BUDGET - cleanSuffix.length);
  if (safe.length > baseBudget) {
    safe = safe.slice(0, baseBudget).replace(/[. ]+$/, "");
  }
  safe = (safe + cleanSuffix).replace(/[. ]+$/, "");
  if (!safe) return "";
  if (WIN_RESERVED.test(safe)) safe = "_" + safe;
  return `${safe}.${ext}`;
}

// sanitizeLooseFilename keeps an existing filename (with extension)
// largely intact — it strips the cross-platform reserved chars and
// control codes, collapses whitespace, trims trailing dots/spaces,
// caps at 200 bytes, and prefixes an underscore on Windows-reserved
// names. Used when we want to preserve the caller-supplied filename
// rather than rebuild it from a title + extension.
export function sanitizeLooseFilename(name) {
  let safe = String(name ?? "file")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "");
  if (safe.length > 200) safe = safe.slice(0, 200).replace(/[. ]+$/, "");
  if (!safe) safe = "file";
  if (WIN_RESERVED.test(safe)) safe = "_" + safe;
  return safe;
}

// normalizeHandle prepends "@" when yt-dlp's uploader_id comes back
// without one (Twitter, Instagram, Reddit submitters — basically every
// site except YouTube, which already includes the @). Empty or
// whitespace inputs return "" so callers can use the result as a
// truthy check.
export function normalizeHandle(s) {
  if (!s) return "";
  const t = String(s).trim();
  if (!t) return "";
  return t.startsWith("@") ? t : "@" + t;
}

// pickHandleText picks the better of uploader_id and uploader for
// display + filenames. On YouTube and Twitter uploader_id is the real
// handle ("@RickAstleyYT", "ElonMusk") and wins; on Facebook it's a
// numeric user id ("1234567890") which we reject in favor of the
// display name (uploader = "John Smith").
export function pickHandleText(uploaderId, uploader) {
  const id = normalizeHandle(uploaderId);
  if (id && !/^@\d+$/.test(id)) return id;
  return normalizeHandle(uploader);
}

export const DEFAULT_FILENAME_SCHEME = "title-uploader-source";

export const BUILTIN_FILENAME_SCHEMES = [
  {
    value: "title-uploader-source",
    label: "[Title] -- [@Poster] -- [Source]",
    template: "[Title] -- [@Poster] -- [Source]",
    galleryIndex: true,
  },
  {
    value: "title-uploader",
    label: "[Title] -- [@Poster]",
    template: "[Title] -- [@Poster]",
    galleryIndex: true,
  },
  {
    value: "uploader-title",
    label: "[@Poster] -- [Title]",
    template: "[@Poster] -- [Title]",
    galleryIndex: true,
  },
  {
    value: "title",
    label: "[Title]",
    template: "[Title]",
    galleryIndex: true,
  },
  {
    value: "sequential",
    label: "[Index]",
    template: "[Index]",
    galleryOnly: true,
  },
  {
    value: "original",
    label: "Original filename",
    template: "",
  },
  {
    value: "setEach",
    label: "User set",
    template: "",
  },
];

export function sourceTokenFromUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    if (!host) return "";
    if (
      host === "twitter.com" ||
      host.endsWith(".twitter.com") ||
      host === "x.com" ||
      host.endsWith(".x.com")
    ) {
      return "x.com";
    }
    const parts = host.split(".").filter(Boolean);
    if (parts.length >= 2 && parts[parts.length - 1] === "com") {
      return parts[parts.length - 2];
    }
    return parts[0] || host;
  } catch {
    return "";
  }
}

export function normalizeCustomFilenameSchemes(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const entry of raw) {
    const id = String(entry?.id || "").trim();
    const name = String(entry?.name || "").trim();
    const template = String(entry?.template || "").trim();
    if (!id || !name || !template || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name, template });
  }
  return out;
}

export function filenameSchemeOptions(
  customSchemes = [],
  { includeGalleryOnly = true, includeOriginal = true } = {},
) {
  const builtins = BUILTIN_FILENAME_SCHEMES.filter((s) => {
    if (!includeGalleryOnly && s.galleryOnly) return false;
    if (!includeOriginal && s.value === "original") return false;
    return true;
  });
  return [
    ...builtins,
    ...normalizeCustomFilenameSchemes(customSchemes).map((s) => ({
      value: `custom:${s.id}`,
      label: s.name,
      template: s.template,
      custom: true,
      galleryIndex: true,
    })),
  ];
}

export function filenameTemplateForMode(mode, customSchemes = []) {
  if (typeof mode === "string" && mode.startsWith("custom:")) {
    const id = mode.slice("custom:".length);
    const found = normalizeCustomFilenameSchemes(customSchemes).find((s) => s.id === id);
    return found?.template || "";
  }
  return BUILTIN_FILENAME_SCHEMES.find((s) => s.value === mode)?.template || "";
}

export function applyFilenameTemplate(template, tokens = {}) {
  let out = String(template || "");
  const replacements = {
    "[Title]": tokens.title || "",
    "[@Poster]": tokens.poster || "",
    "[Poster]": tokens.poster || "",
    "[Source]": tokens.source || "",
    "[source]": tokens.source || "",
    "[Site]": tokens.source || "",
    "[site]": tokens.source || "",
    "[Index]": tokens.index || "",
    "[Start]": tokens.start || "",
    "[Start Time]": tokens.start || "",
    "[start time]": tokens.start || "",
    "[End]": tokens.end || "",
    "[End Time]": tokens.end || "",
    "[end time]": tokens.end || "",
  };
  for (const [token, value] of Object.entries(replacements)) {
    out = out.split(token).join(String(value || ""));
  }
  return out
    .replace(/\s+--\s+(?=--|$)/g, " -- ")
    .replace(/(^|\s)--\s*$/g, "")
    .replace(/^\s*--\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// SUPPORTED_HOSTS lists registrable domains the popup auto-probes
// without prompting. Mirror of host/internal/probe/probe.go's
// `Supported` slice — keep in sync. Anything outside this list goes
// through the lazy-verification path (Try Anyway button + per-host
// session cache); see popup.js's runFetchFlow + shouldAutoProbe.
export const SUPPORTED_HOSTS = [
  "youtube.com",
  "youtu.be",
  "reddit.com",
  "redd.it",
  "twitter.com",
  "x.com",
  "instagram.com",
  "facebook.com",
  "fb.watch",
  "tiktok.com",
];

// isKnownHost reports whether url's hostname matches the SUPPORTED_HOSTS
// allowlist (exact match or a subdomain of one). Returns false on
// missing/malformed URLs so callers can use it as a positive guard.
export function isKnownHost(url) {
  if (!url) return false;
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  for (const d of SUPPORTED_HOSTS) {
    if (host === d || host.endsWith("." + d)) return true;
  }
  return false;
}

// resolveFilenameMode picks the active filename mode out of a settings
// blob. New installs read `filenameMode` directly. Old installs may have
// `galleryFilenameMode` (broader of the two old keys, includes
// "sequential") or `imageFilenameMode` instead — we prefer gallery's.
// The legacy "default" sentinel resolves to the modern default.
//
// Valid return values: "uploader-title" | "title-uploader" | "title" |
// "sequential" | "original" | "setEach". The image picker maps "sequential" to
// "uploader-title" at the UI layer since per-item indexing has no
// meaning for a 1-of-1 download.
export function resolveFilenameMode(s) {
  const raw =
    s.filenameMode ?? s.galleryFilenameMode ?? s.imageFilenameMode ?? DEFAULT_FILENAME_SCHEME;
  return raw === "default" || raw === "uploader-title-source" ? DEFAULT_FILENAME_SCHEME : raw;
}

export function resolveRangeFilenameMode(s) {
  const raw = s.rangeFilenameMode ?? s.videoRangeFilenameMode ?? s.filenameMode;
  if (raw === "default" || raw === "uploader-title-source" || raw === undefined) {
    return DEFAULT_FILENAME_SCHEME;
  }
  return raw;
}

// migrateFilenameSettings collapses legacy filename-mode keys into the
// single `filenameMode` and drops the obsolete keys + the very-old
// `useOriginalFilenames` boolean. Returns the new settings object when
// a rewrite is needed, null when storage is already on the new shape so
// the caller can skip the storage write.
export function migrateFilenameSettings(settings) {
  const hasLegacy =
    settings.imageFilenameMode !== undefined ||
    settings.galleryFilenameMode !== undefined ||
    settings.videoRangeFilenameMode !== undefined ||
    settings.useOriginalFilenames !== undefined;
  if (!hasLegacy && settings.filenameMode !== undefined) return null;

  const next = { ...settings };
  if (next.useOriginalFilenames !== undefined && next.galleryFilenameMode === undefined) {
    next.galleryFilenameMode = next.useOriginalFilenames ? "original" : "sequential";
  }
  if (next.filenameMode === undefined) {
    next.filenameMode = resolveFilenameMode(next);
  } else if (next.filenameMode === "uploader-title-source") {
    next.filenameMode = DEFAULT_FILENAME_SCHEME;
  }
  if (next.rangeFilenameMode === undefined && next.videoRangeFilenameMode !== undefined) {
    next.rangeFilenameMode = resolveRangeFilenameMode(next);
  } else if (next.rangeFilenameMode === "uploader-title-source") {
    next.rangeFilenameMode = DEFAULT_FILENAME_SCHEME;
  }
  delete next.imageFilenameMode;
  delete next.galleryFilenameMode;
  delete next.videoRangeFilenameMode;
  delete next.useOriginalFilenames;
  return next;
}
