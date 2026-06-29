// Popup talks to the service worker (not directly to the native host), so
// downloads survive the popup being closed and reopened.

import { detectRedditCached, looksLikeRedditPost, getRedditDomInfo } from "./reddit.js";
import {
  detectTweetCached,
  looksLikeTweet,
  getTwitterDomInfo,
  pickVariantUrl,
} from "./twitter.js";
import {
  looksLikeInstagram,
  isInstagramStoryUrl,
  getInstagramPostInfo,
  getInstagramStoryInfo,
  getInstagramDomInfo,
} from "./instagram.js";
import {
  looksLikeTikTok,
  isTikTokVideoUrl,
  isTikTokPhotoUrl,
  resolveTikTokUrlFromDom,
  getTikTokPhotoInfo,
} from "./tiktok.js";
import {
  looksLikeFacebook,
  isFacebookVideoUrl,
  getFacebookDomInfo,
  getFacebookStoryFromInterceptor,
  canonicalizeFacebookUrlForYtdlp,
} from "./facebook.js";
import {
  basenameFromUrl,
  extensionFromUrl,
  sanitizeFilenameSegment,
  resolveFilenameMode,
  migrateFilenameSettings,
  WIN_RESERVED,
  buildSafeFilename,
  sanitizeLooseFilename,
  normalizeHandle,
  pickHandleText,
  isKnownHost,
} from "./shared.js";
import { friendlyError } from "./popup-errors.js";
import { formatTimestamp, validateTimestamp } from "./popup-helpers.js";
import { logFetcher } from "./fetcher-log.js";

// errorContext snapshots the popup-side state friendlyError /
// prettifyYtdlpError used to read directly via module globals. Built
// at every call site so the error mapping module can stay pure.
function errorContext() {
  return {
    tabUrl,
    triedCookies: cookiesRetryTried || effectiveUseCookies,
    cookiesMode: cookiesStrategyMode(),
  };
}

const DEFAULT_MODE = "ask";

const el = (id) => document.getElementById(id);
const show = (id) => el(id).hidden = false;
const hide = (id) => el(id).hidden = true;

// dlog is the popup-side verbose trace. Prefixes every line with
// "[frixty/popup]" so it's distinguishable from background.js /
// content-script logs in the same tab's console. Kept chatty on purpose —
// the user asked for end-to-end visibility into the detect/fetch/download
// pipeline. Filter in DevTools with "frixty/popup" if it gets noisy.
function dlog(step, ...args) {
  console.log("[frixty/popup]", step, ...args);
}

// bgRequest sends a one-shot message to the background SW and returns a
// Promise that:
//   - resolves with the response on success,
//   - rejects on chrome.runtime.lastError,
//   - rejects after timeoutMs (default 5s) when no callback fires at all.
//
// MV3 service workers can be killed mid-request — e.g. when a long
// download lets the SW idle past its keepalive window and Chrome unloads
// it. Without this wrapper, the popup's awaiter sits forever in an
// unresolved Promise; with it, the caller gets a deterministic failure
// they can surface or fall back from. Callers should try/catch and
// degrade gracefully rather than letting the rejection propagate to the
// user as a stack trace.
function bgRequest(msg, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn) => (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(val);
    };
    const timer = setTimeout(() => {
      finish(reject)(new Error(`bgRequest timeout: ${msg?.type ?? "unknown"}`));
    }, timeoutMs);
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        const err = chrome.runtime.lastError;
        if (err) {
          finish(reject)(new Error(err.message || "lastError"));
          return;
        }
        finish(resolve)(resp);
      });
    } catch (err) {
      finish(reject)(err);
    }
  });
}

// Persisted picker state — chrome.storage.session keyed by tab id so
// closing+reopening the popup on the same page restores whatever was
// last fetched (formats listing, image, or gallery). The URL is
// stored alongside; on read, if the active tab's URL no longer
// matches, the stored entry is cleared and the user gets a fresh
// fetch prompt — that's the "navigated to a different page" reset.
//
// Captures (per-site grab buttons) have their own per-tab storage
// run by the SW; this code path is for explicit fetches via the
// popup's Fetch button. dismissPicker clears the entry; explicit
// re-fetch overwrites it on success.
async function persistFetchedPicker(kind, payload) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tabUrl) return;
    await chrome.storage.session.set({
      [`fetched:${tab.id}`]: { url: tabUrl, kind, payload },
    });
  } catch {}
}

async function loadFetchedPicker() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return null;
    const key = `fetched:${tab.id}`;
    const obj = await chrome.storage.session.get(key);
    const entry = obj[key];
    if (!entry || typeof entry !== "object") return null;
    if (entry.url !== tabUrl) {
      // URL changed since last fetch — drop the stale entry so the
      // next persist on this tab isn't shadowed by old data.
      await chrome.storage.session.remove(key);
      return null;
    }
    return entry;
  } catch {
    return null;
  }
}

async function clearFetchedPicker() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    await chrome.storage.session.remove(`fetched:${tab.id}`);
  } catch {}
}

let port;
let tabUrl = "";
let activeJobId = null;
let currentFormats = null;
// Set by init() when a per-tab auto-fetch flag is found in session
// storage (e.g. from the YouTube grab button). handleSnapshot reads
// this after the SW responds and, if set, kicks off runFetchFlow so
// the user gets the popup's usual video/gallery picker without a
// manual click.
let autoFetchPending = false;
let currentTitle = "";
let currentUploader = "";
let currentUploaderId = "";
let currentThumbnail = "";
let currentDuration = 0;
// When we branch into the image/gallery flow, galleryState carries the
// detected payload (URL(s), title) so the Download button knows what to do.
let galleryState = null;
const saveSettings = {
  saveMode: DEFAULT_MODE,
  specificDestDir: "",
  lastDir: "",
  // Single filename setting shared across image and gallery pickers.
  // Values: "uploader-title" | "title" | "sequential" | "original" |
  // "setEach". The image picker's per-item dropdown excludes
  // "sequential" (no index for a 1-of-1 download) and falls back to
  // "uploader-title" if the saved default is "sequential". Gallery
  // pickers expose all five.
  //
  // uploader-title is the default because it's the only preset that
  // guarantees unique filenames inside a gallery (title alone collides
  // when every item shares the post title).
  filenameMode: "uploader-title",
  // Shared download-location state applied to every picker (single
  // video, single image, multi-item gallery). Replaces the older
  // gallery-only names; the load path below migrates old values.
  //
  //   downloadAutomatically — when true, downloads land in
  //     destinationDir (+ optional album subfolder) with no Save As
  //     dialog. When false, every file pops the OS Save As dialog so
  //     the user names/places each one manually. Defaults to false so
  //     a fresh install behaves conservatively.
  //   destinationDir — last-picked destination (empty = "use the OS
  //     default download folder").
  //   createFolder / folderMode — matching the previous gallery
  //     controls: optional subfolder + naming template.
  downloadAutomatically: false,
  destinationDir: "",
  createFolder: true,
  folderMode: "uploader-title",
  // Per-site cookies strategies: "auto" | "always" | "never".
  // Cookies default to "always" for every supported site. yt-dlp's
  // extractors need authenticated context for most real content on
  // Twitter/Instagram/Facebook and age-gated YouTube; paying the
  // cookie-attach cost up front saves a failed first attempt.
  twitterCookiesMode: "always",
  youtubeCookiesMode: "always",
  instagramCookiesMode: "always",
  facebookCookiesMode: "always",
  tiktokCookiesMode: "always",
};

// Tracks whether we've already retried the current listFormats request
// with cookies. Prevents infinite loop if both attempts fail.
let cookiesRetryTried = false;
// Which cookies setting actually produced the current listFormats result.
// The subsequent download uses the same setting so it has the same
// authentication context.
let effectiveUseCookies = false;

function connect() {
  port = chrome.runtime.connect({ name: "popup" });
  port.onMessage.addListener(onMessage);
}

async function init() {
  connect();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabUrl = tab?.url ?? "";
  dlog("init", { tabUrl });

  const { settings = {} } = await chrome.storage.local.get("settings");
  const migrated = migrateFilenameSettings(settings);
  if (migrated) {
    await chrome.storage.local.set({ settings: migrated });
  }
  const s = migrated ?? settings;
  saveSettings.saveMode = s.saveMode ?? DEFAULT_MODE;
  saveSettings.specificDestDir = s.specificDestDir ?? "";
  saveSettings.lastDir = s.lastDir ?? "";
  saveSettings.filenameMode = resolveFilenameMode(s);
  // Migration: old gallery-only keys → shared names. The ConfirmEach
  // flag inverts: "confirm-each = true" meant "prompt per file" which
  // maps to "automatic = false" under the new naming. When nothing is
  // saved, automatic defaults to false.
  if (typeof s.downloadAutomatically === "boolean") {
    saveSettings.downloadAutomatically = s.downloadAutomatically;
  } else if (typeof s.galleryConfirmEach === "boolean") {
    saveSettings.downloadAutomatically = !s.galleryConfirmEach;
  } else {
    saveSettings.downloadAutomatically = false;
  }
  saveSettings.destinationDir = s.destinationDir ?? s.galleryDestDir ?? "";
  saveSettings.createFolder = typeof s.createFolder === "boolean"
    ? s.createFolder
    : (typeof s.galleryCreateFolder === "boolean" ? s.galleryCreateFolder : true);
  saveSettings.folderMode = s.folderMode ?? s.galleryFolderMode ?? "uploader-title";
  saveSettings.twitterCookiesMode = s.twitterCookiesMode ?? "always";
  saveSettings.youtubeCookiesMode = s.youtubeCookiesMode ?? "always";
  saveSettings.instagramCookiesMode = s.instagramCookiesMode ?? "always";
  saveSettings.facebookCookiesMode = s.facebookCookiesMode ?? "always";
  saveSettings.tiktokCookiesMode = s.tiktokCookiesMode ?? "always";
  renderSaveModeHint();

  // Render the top-level download-controls section immediately so its
  // checkbox + destination are visible even before anything has been
  // fetched — lets the user configure Prompt-each / destination up
  // front rather than having to trigger a gallery first.
  initDownloadControls();

  // Auto-fetch-on-open: the YouTube grab button (and any future
  // caller that wants the popup's Fetch flow rather than a capture)
  // stamps a per-tab flag in session storage. Check it here; if it
  // was set in the last 10s, consume it and kick off runFetchFlow
  // once the rest of init completes.
  const autoFetchKey = `frixty:auto-fetch:${tab.id}`;
  try {
    const stored = (await chrome.storage.session.get(autoFetchKey))[autoFetchKey];
    // Match stored.url against the current tabUrl before consuming. The
    // grab button captures the URL it was clicked on; if the user
    // navigates to a different video before the popup opens (long SPA
    // route, slow openPopup), running runFetchFlow on the new URL is a
    // bug — we'd fetch media for a page the user never asked about.
    // Drop the flag in that case rather than silently misfire.
    if (stored && typeof stored === "object" && stored.ts && Date.now() - stored.ts < 10_000) {
      if (!stored.url || stored.url === tabUrl) {
        autoFetchPending = true;
        dlog("auto-fetch flag consumed", { key: autoFetchKey, ageMs: Date.now() - stored.ts });
      } else {
        dlog("auto-fetch flag dropped — URL changed", {
          stored: stored.url?.slice(0, 80),
          current: tabUrl?.slice(0, 80),
        });
      }
      await chrome.storage.session.remove(autoFetchKey);
    }
  } catch {}

  // Ask the SW for any running job matching this URL before we hit the host.
  port.postMessage({ cmd: "snapshot" });

  // Live-refresh the capture gallery when the content-script fires
  // another capture while the popup is open. Preserves any
  // already-fetched (non-capture) items currently visible in the
  // gallery — they go under the captures so both coexist.
  //
  // Any site whose grab button pushes a capture:add needs this
  // listener — otherwise captures arriving while the popup is
  // already open (devtools focused, openPopup refused, etc.) land
  // in storage but don't render. Gated only to sites the extension
  // supports so unrelated tabs don't pay for storage-change work.
  const liveRefreshSites =
    looksLikeFacebook(tabUrl) ||
    looksLikeTweet(tabUrl) ||
    looksLikeInstagram(tabUrl) ||
    looksLikeTikTok(tabUrl);
  if (liveRefreshSites) {
    // Hold a reference so we can removeListener on pagehide. Chrome
    // does eventually GC listeners whose registering document is gone,
    // but explicit removal makes the lifetime obvious and avoids ever
    // running a stale closure if the popup is reopened while the prior
    // listener hasn't been cleaned up yet.
    const onStorageChange = async (changes) => {
      const myKey = `capture:list:${tab.id}`;
      if (!changes[myKey]) return;
      const captures = await getCaptures();
      const captureItems = captures.length
        ? buildGalleryFromCaptures(captures).items
        : [];
      const existingFetched = (galleryState?.kind === "gallery" && galleryState.items)
        ? galleryState.items.filter((i) => !i.isCapture)
        : [];
      const seen = new Set(captureItems.map((i) => i.url));
      const keptFetched = existingFetched.filter((i) => !seen.has(i.url));
      const merged = [...captureItems, ...keptFetched];
      dlog("storage refresh", {
        captures: captureItems.length,
        keptFetched: keptFetched.length,
      });
      if (merged.length === 0) return;
      // buildGalleryFromCaptures already picks a site-appropriate
      // title/handle from the captures themselves — reuse that shape
      // instead of hand-rolling a new header here.
      const rendered = captures.length
        ? buildGalleryFromCaptures(captures)
        : null;
      showGalleryPicker({
        kind: "gallery",
        title: rendered?.title || "",
        handle: rendered?.handle || "",
        date: 0,
        items: merged,
        isCaptureList: true,
      });
    };
    chrome.storage?.session?.onChanged?.addListener(onStorageChange);
    window.addEventListener(
      "pagehide",
      () => chrome.storage?.session?.onChanged?.removeListener(onStorageChange),
      { once: true },
    );
  }
}

function onMessage(msg) {
  // Log every message that crosses the popup boundary so the console shows
  // the end-to-end conversation. Progress events are the only thing we
  // downshift to avoid spamming — one line per percentage step is plenty.
  if (msg.type === "progress") {
    if (Math.floor((msg.percent ?? 0) / 10) !== Math.floor((dlogLastPct ?? -10) / 10)) {
      dlog("progress", { jobId: msg.jobId, percent: msg.percent, stage: msg.stage });
      dlogLastPct = msg.percent;
    }
  } else {
    dlog("recv", msg.type, msgSummary(msg));
  }

  switch (msg.type) {
    case "snapshot":
      handleSnapshot(msg.jobs);
      break;
    case "folderPicked":
      handleDestinationPicked(msg);
      break;
    case "formats":
      applyResponseUseCookies(msg);
      handleFormats(msg);
      break;
    case "progress":
      if (msg.jobId === activeJobId) dispatchProgress(msg);
      break;
    case "done":
      if (msg.jobId === activeJobId) dispatchDone(msg);
      break;
    case "error":
      if (!msg.jobId || msg.jobId === activeJobId) {
        if (msg.code === "destdir_canceled" || msg.code === "download_canceled") {
          // User-initiated cancels are a no-op, not a failure.
          // destdir_canceled: they dismissed the Save As dialog.
          // download_canceled: they hit Cancel during yt-dlp run.
          handleCanceled();
          break;
        }
        // Stamp effectiveUseCookies from the response BEFORE consulting
        // shouldRetryWithCookies / shouldRetryWithCookies-dependent
        // logic. Closes the race where two listFormats are in flight
        // and the module-level state lies about which call this error
        // belongs to.
        if (!msg.jobId && (msg.code === "listformats_failed" || msg.code === "no_formats")) {
          applyResponseUseCookies(msg);
        }
        if (!msg.jobId && shouldRetryWithCookies(msg)) {
          // Log the no-cookies failure explicitly — the user asked for
          // verbose tracing, and this is a load-bearing step (the auto
          // fallback to cookies only makes sense once you know the anon
          // attempt failed). Tag it so the follow-up log is obvious.
          dlog("listFormats failed without cookies, retrying with cookies", {
            code: msg.code, message: msg.message,
          });
          cookiesRetryTried = true;
          requestListFormats(true);
          break;
        }
        dlog("host error (final)", { code: msg.code, message: msg.message });
        dispatchError(msg);
      }
      break;
  }
}

let dlogLastPct = -10;

// pendingTerminalStatus holds a done/error from a prior download when the
// popup reopens on the same tab — we render the picker first (so the
// user still sees media info + controls) and overlay this status via
// the inline Saved/Error box once the picker is on screen.
let pendingTerminalStatus = null;

function maybeApplyPendingStatus() {
  const s = pendingTerminalStatus;
  if (!s) return;
  pendingTerminalStatus = null;
  const stub = { jobId: s.jobId };
  if (s.status === "done") {
    inlineRenderDone({ ...stub, path: s.path });
  } else {
    inlineRenderError({ ...stub, code: s.code || "error", message: s.error || "Unknown error" });
  }
}

// msgSummary trims verbose fields so the per-message trace stays readable.
// formats listings in particular can be dozens of objects — we only log
// counts and identifying strings.
function msgSummary(msg) {
  if (msg.type === "formats") {
    return {
      title: msg.title,
      uploaderId: msg.uploaderId,
      uploader: msg.uploader,
      formatsCount: Array.isArray(msg.items) ? msg.items.length : 0,
      duration: msg.duration,
    };
  }
  if (msg.type === "snapshot") {
    return { jobsCount: Array.isArray(msg.jobs) ? msg.jobs.length : 0 };
  }
  if (msg.type === "done") {
    return { jobId: msg.jobId, path: msg.path };
  }
  if (msg.type === "updateProgress") {
    return { downloaded: msg.downloaded, total: msg.total };
  }
  if (msg.type === "updated") {
    return { oldVersion: msg.oldVersion, newVersion: msg.newVersion };
  }
  return msg;
}

// Progress/done/error route to either the inline status inside the current
// picker (in-session downloads, the common case) or to the legacy full-
// screen running/terminal views (popup reopened on a previously-started
// job with no picker context available).
function dispatchProgress(msg) {
  if (activePickerStatusEl()) inlineRenderRunning(msg);
  else renderProgress(msg);
}
function dispatchDone(msg) {
  if (activePickerStatusEl()) inlineRenderDone(msg);
  else renderDone(msg);
}
function dispatchError(msg) {
  if (activePickerStatusEl()) inlineRenderError(msg);
  else renderError(msg);
}

// Returns the inline-status <div> belonging to whichever picker is on
// screen, or null if no picker is currently visible (e.g. snapshot-
// restored running/terminal view).
function activePickerStatusEl() {
  if (!el("picker").hidden) return el("video-status");
  if (!el("image-picker").hidden) return el("image-status");
  if (!el("gallery-picker").hidden) return el("gallery-status");
  return null;
}

async function handleSnapshot(jobList) {
  const running = jobList.find((j) => j.url === tabUrl && j.status === "running");
  if (running) {
    activeJobId = running.id;
    currentTitle = running.title || tabUrl;
    showRunning(running.progress);
    return;
  }
  // Finished jobs no longer short-circuit into the full-screen terminal
  // view — the user wants the picker to stay visible with the inline
  // Saved/Error status overlaid. Stash the status and let each picker's
  // show-path apply it once the picker is on screen.
  const finished = jobList.find((j) => j.url === tabUrl && (j.status === "done" || j.status === "error"));
  if (finished) {
    activeJobId = finished.id;
    pendingTerminalStatus = {
      status: finished.status,
      jobId: finished.id,
      path: finished.path,
      error: finished.error,
      code: finished.code,
    };
  }

  // Always expose the fetch button — users can re-scan the current
  // page at any time (e.g. after swiping to a new reel), even with
  // an already-populated gallery on screen.
  showFetchPrompt();

  // Captures from any page-injected grab button take priority. Storage
  // is keyed by tabId, not by site — so a Twitter tab's captures and
  // a Facebook tab's captures don't mix. Check unconditionally.
  const captures = await getCaptures();
  if (captures.length > 0) {
    const info = buildGalleryFromCaptures(captures);
    showGalleryPicker(info);
    return;
  }

  // No captures and no running job — try to restore the last
  // explicit fetch result on this tab. URL match is the gate; if the
  // user navigated to a different page since the previous fetch,
  // loadFetchedPicker drops the stale entry and returns null, so the
  // user lands on a fresh fetch prompt as expected.
  const restored = await loadFetchedPicker();
  if (restored) {
    if (restored.kind === "formats") {
      handleFormats(restored.payload);
      return;
    }
    if (restored.kind === "image") {
      showImagePicker(restored.payload);
      return;
    }
    if (restored.kind === "gallery") {
      showGalleryPicker(restored.payload);
      return;
    }
  }

  // Auto-fetch pending from a page-side trigger (YouTube grab
  // button, etc). No captures, no running/finished job, nothing to
  // restore — kick off runFetchFlow so the user sees the same picker
  // the popup's own Fetch button produces, without having to click it.
  if (autoFetchPending) {
    autoFetchPending = false;
    dlog("auto-fetch: triggering runFetchFlow");
    // requestAnimationFrame (not setTimeout 50): wait for the snapshot
    // render to commit, then fire on the next paint frame. Faster
    // (~16ms vs 50ms) and not a magic number.
    requestAnimationFrame(() => {
      try { runFetchFlow(); } catch (err) { dlog("auto-fetch threw", err?.message || err); }
    });
  }
}

// Runs the site-specific media fetch flow. Called from the "Fetch
// media on this page" button. On Facebook, any existing captures
// (built via the page ⬇ grab button) are preserved and placed at
// the top of the resulting gallery; newly-fetched items append after
// them. Everywhere else behaves like before — just shows whatever
// the fetcher returned.
async function runFetchFlow(opts) {
  // The lazy-probe gate at the bottom of this function blocks
  // auto-fetch on unknown hosts. When the user clicks the Fetch
  // button on the prompt, that's an explicit opt-in — bypass the
  // gate and call listFormats unconditionally. Without this flag the
  // click handler re-runs runFetchFlow with no signal and the gate
  // re-blocks, making the button look broken.
  //
  // The click handler passes a click Event as opts; auto-fetch
  // callers pass nothing or a {explicit:true} object. Coerce to a
  // boolean explicitly so future EventTarget shapes don't break this.
  const explicit = opts && (opts.explicit === true || opts instanceof Event);
  // Re-read the active tab URL at click time so a tab-nav (reel
  // swipe, carousel advance) since popup open doesn't point at the
  // previous item.
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url) tabUrl = tab.url;
  } catch {}
  logFetcher("popup", "fetch-flow:start", { url: tabUrl, explicit });
  show("loading");
  hide("picker");
  hide("image-picker");
  hide("gallery-picker");

  const onFacebook = looksLikeFacebook(tabUrl);

  // Facebook branch: fetch, persist the fetched items alongside the
  // arrow-button captures in the same session-storage list, then
  // render from storage so everything round-trips across popup close.
  if (onFacebook) {
    logFetcher("facebook", "route", { url: tabUrl, path: isFacebookVideoUrl(tabUrl) ? "yt-dlp-video" : "interceptor-dom" });
    let fetchedInfo = null;
    if (!isFacebookVideoUrl(tabUrl)) {
      fetchedInfo = await getFacebookStoryFromInterceptor();
      if (!fetchedInfo) fetchedInfo = await getFacebookDomInfo();
    }
    const fetchedItems = infoToItems(fetchedInfo);
    logFetcher("facebook", "scrape-result", {
      url: tabUrl,
      kind: fetchedInfo?.kind || "",
      itemCount: fetchedItems.length,
    });
    if (fetchedItems.length > 0) {
      await persistFetchedItems(fetchedItems);
    }
    const captures = await getCaptures();
    if (captures.length > 0) {
      showGalleryPicker(buildGalleryFromCaptures(captures));
      return;
    }
    // Nothing in storage and nothing fetched — /reel/, /watch/,
    // /<user>/videos/ URLs: hand off to yt-dlp.
    requestListFormats();
    return;
  }

  // Non-Facebook sites — unchanged behavior, no capture merging.
  if (looksLikeRedditPost(tabUrl)) {
    logFetcher("reddit", "route", { url: tabUrl, path: "detector" });
    const info = await detectRedditCached(tabUrl);
    logFetcher("reddit", "detector-result", {
      url: tabUrl,
      kind: info?.kind || "",
      itemCount: info?.items?.length || (info?.kind === "image" ? 1 : 0),
    });
    if (info?.kind === "image")   { showImagePicker(info);   return; }
    if (info?.kind === "gallery") { showGalleryPicker(info); return; }
    if (info?.kind === "domFallback") {
      logFetcher("reddit", "dom-fallback:start", { url: tabUrl });
      const domInfo = await getRedditDomInfo();
      logFetcher("reddit", "dom-fallback:result", {
        url: tabUrl,
        kind: domInfo?.kind || "",
        itemCount: domInfo?.items?.length || (domInfo?.kind === "image" ? 1 : 0),
      });
      if (domInfo?.kind === "image")   { showImagePicker(domInfo);   return; }
      if (domInfo?.kind === "gallery") { showGalleryPicker(domInfo); return; }
    }
  } else if (looksLikeTweet(tabUrl)) {
    logFetcher("twitter", "route", { url: tabUrl, path: "syndication-dom" });
    const info = await detectTweetCached(tabUrl);
    logFetcher("twitter", "detector-result", {
      url: tabUrl,
      kind: info?.kind || "",
      itemCount: info?.items?.length || (info?.kind === "image" ? 1 : 0),
    });
    if (info?.kind === "image")   { showImagePicker(info);   return; }
    if (info?.kind === "gallery") { showGalleryPicker(info); return; }
    const domInfo = await getTwitterDomInfo();
    logFetcher("twitter", "dom-result", {
      url: tabUrl,
      kind: domInfo?.kind || "",
      itemCount: domInfo?.items?.length || (domInfo?.kind === "image" ? 1 : 0),
    });
    if (domInfo?.kind === "image")   { showImagePicker(domInfo);   return; }
    if (domInfo?.kind === "gallery") { showGalleryPicker(domInfo); return; }
  } else if (looksLikeInstagram(tabUrl)) {
    logFetcher("instagram", "route", {
      url: tabUrl,
      path: isInstagramStoryUrl(tabUrl) ? "story-api-dom" : "post-api-dom",
    });
    if (isInstagramStoryUrl(tabUrl)) {
      const storyInfo = await getInstagramStoryInfo(tabUrl);
      logFetcher("instagram", "story-result", {
        url: tabUrl,
        kind: storyInfo?.kind || "",
        itemCount: storyInfo?.items?.length || (storyInfo?.kind === "image" ? 1 : 0),
      });
      if (storyInfo?.kind === "gallery") { showGalleryPicker(storyInfo); return; }
      if (storyInfo?.kind === "image")   { showImagePicker(storyInfo);   return; }
    } else {
      const apiInfo = await getInstagramPostInfo(tabUrl);
      logFetcher("instagram", "api-result", {
        url: tabUrl,
        kind: apiInfo?.kind || "",
        itemCount: apiInfo?.items?.length || (apiInfo?.kind === "image" ? 1 : 0),
      });
      if (apiInfo?.kind === "gallery") { showGalleryPicker(apiInfo); return; }
      if (apiInfo?.kind === "image")   { showImagePicker(apiInfo);   return; }
      const domInfo = await getInstagramDomInfo();
      logFetcher("instagram", "dom-result", {
        url: tabUrl,
        kind: domInfo?.kind || "",
        itemCount: domInfo?.items?.length || (domInfo?.kind === "image" ? 1 : 0),
      });
      if (domInfo?.kind === "image")   { showImagePicker(domInfo);   return; }
      if (domInfo?.kind === "gallery") { showGalleryPicker(domInfo); return; }
    }
    // Reddit/Twitter/Instagram fall through here when their site-
    // specific extractors didn't recognise the URL shape — yt-dlp can
    // still handle them, so let them through to listFormats below.
  } else if (looksLikeTikTok(tabUrl) && isTikTokPhotoUrl(tabUrl)) {
    logFetcher("tiktok", "route", { url: tabUrl, path: "photo-dom" });
    // TikTok photo (slideshow) post. yt-dlp's photo-mode extractor
    // exists but its format listing — one entry per slide plus the
    // background-music audio track — doesn't render cleanly in the
    // video picker. Scrape the slideshow images out of the DOM
    // instead and route through the gallery picker. Falls through
    // to listFormats only if the DOM scrape comes back empty
    // (logged-out, slow-loading page, etc.).
    const photoInfo = await getTikTokPhotoInfo(tabUrl);
    logFetcher("tiktok", "photo-result", {
      url: tabUrl,
      kind: photoInfo?.kind || "",
      itemCount: photoInfo?.items?.length || (photoInfo?.kind === "image" ? 1 : 0),
    });
    if (photoInfo?.kind === "image")   { showImagePicker(photoInfo);   return; }
    if (photoInfo?.kind === "gallery") { showGalleryPicker(photoInfo); return; }
    dlog("tiktok photo scrape: nothing visible, falling back to listFormats", {
      url: tabUrl,
    });
  } else if (looksLikeTikTok(tabUrl) && !isTikTokVideoUrl(tabUrl)) {
    logFetcher("tiktok", "route", { url: tabUrl, path: "dom-resolve" });
    // TikTok's SPA keeps the address bar on the feed URL (`/`, `/foryou`,
    // `/en/`) while a post plays, so yt-dlp sees "https://tiktok.com/" and
    // errors with "Unsupported URL". Scrape the currently-visible post's
    // canonical link and retarget. When nothing matches (e.g. the
    // logged-out landing page at /en/ which is a marketing page, not a
    // feed) short-circuit with a friendly "open a specific video" hint
    // instead of forwarding a doomed URL to yt-dlp.
    const resolved = await resolveTikTokUrlFromDom();
    if (resolved && resolved.url) {
      logFetcher("tiktok", "dom-resolve:result", { url: tabUrl, resolvedUrl: resolved.url, source: resolved.source });
      dlog("tiktok DOM resolve", { from: tabUrl, to: resolved.url, source: resolved.source });
      tabUrl = resolved.url;
    } else if (resolved) {
      dlog("tiktok DOM resolve: no match", {
        from: tabUrl,
        tried: resolved.tried,
        interceptorStats: resolved.interceptorStats,
      });
      renderError({ code: "tiktok_no_video_in_url" });
      return;
    } else {
      dlog("tiktok DOM resolve: scraper did not run (executeScript failed)", { from: tabUrl });
      renderError({ code: "tiktok_no_video_in_url" });
      return;
    }
  }
  // Lazy verification gate: known supported hosts go straight to
  // yt-dlp listFormats. Unknown hosts only get probed if we've seen
  // them succeed earlier in this session — otherwise show the prompt
  // and let the user opt in. Saves the multi-second yt-dlp call on
  // arbitrary pages (a news article, a blog post, etc.) where the
  // extractor will just fail anyway. The `explicit` flag bypasses
  // the gate when the user clicked Fetch on the prompt.
  if (explicit || await shouldAutoProbe(tabUrl)) {
    logFetcher("popup", "list-formats:route", { url: tabUrl, explicit });
    show("loading");
    hide("fetch-prompt");
    requestListFormats();
    return;
  }
  hide("loading");
  logFetcher("popup", "fetch-prompt", { url: tabUrl });
  showFetchPrompt({
    hint: "This site isn't a known media source. Click to ask yt-dlp anyway — most other sites work.",
  });
}

// shouldAutoProbe decides whether runFetchFlow is allowed to call
// listFormats without an explicit user click. Two paths return true:
//   - the URL's host is in shared.SUPPORTED_HOSTS (the static
//     allowlist), or
//   - we already saw listFormats succeed on this host earlier in the
//     session (positive cache).
// Anything else falls through to the Fetch-prompt + Try-anyway flow,
// so a random non-media page doesn't waste several seconds in yt-dlp
// every popup open.
async function shouldAutoProbe(url) {
  if (isKnownHost(url)) return true;
  const host = hostnameOf(url);
  if (!host) return true; // can't classify; fall through to listFormats
  try {
    const key = probeCacheKey(host);
    const obj = await chrome.storage.session.get(key);
    return obj[key] === true;
  } catch {
    return true; // session storage unavailable — be permissive
  }
}

// rememberHostSupported writes a positive entry into chrome.storage.
// session keyed by the URL's hostname so subsequent popup opens on
// that host skip the prompt. We deliberately do NOT cache negatives —
// listformats_failed / no_formats can be transient (the page hadn't
// rendered media yet, the extractor was rate-limited), and a wrong
// negative would hide the Fetch button on a site that does work.
async function rememberHostSupported(url) {
  const host = hostnameOf(url);
  if (!host) return;
  try {
    await chrome.storage.session.set({ [probeCacheKey(host)]: true });
  } catch {}
}

function hostnameOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
}
function probeCacheKey(host) { return `probe:${host}`; }

// Normalize a site-detection result (`null` | image | gallery) into
// a flat items[] array. Image kind becomes a single-item array so it
// can be merged with other items.
function infoToItems(info) {
  if (!info) return [];
  if (info.kind === "gallery") return (info.items || []).map((i) => ({ ...i, isCapture: false }));
  if (info.kind === "image") {
    const ext = extensionFromUrl(info.imageUrl) || "jpg";
    return [{
      url: info.imageUrl,
      ext,
      width: info.width || 0,
      height: info.height || 0,
      thumbUrl: info.imageUrl,
      mime: `image/${ext === "jpg" ? "jpeg" : ext}`,
      basename: info.basename || `image.${ext}`,
      handle: info.handle || "",
      isCapture: false,
    }];
  }
  return [];
}
// requestListFormats picks the cookies flag based on the site and the
// user's saved strategy, then sends the listFormats request. forceCookies
// (true/false) lets the auto-retry path override the default. Starting a
// fresh attempt (forceCookies undefined) resets the retry bookkeeping.
function requestListFormats(forceCookies) {
  if (forceCookies === undefined) {
    cookiesRetryTried = false;
  }
  const useCookies = forceCookies === undefined ? cookiesStrategyInitial() : !!forceCookies;
  // Don't write effectiveUseCookies here. The SW stamps useCookies onto
  // the response message it relays back; we read it off the response
  // when it arrives. Setting it pre-flight creates a race: if a second
  // request lands before the first response, the first response's
  // handler reads the second's value. See onMessage for the consumer.
  dlog("listFormats -> host", {
    url: tabUrl,
    useCookies,
    cookiesStrategy: cookiesStrategyMode(),
    attempt: forceCookies === undefined ? "initial" : "retry-with-cookies",
  });
  logFetcher("popup", "list-formats:send", { url: tabUrl, useCookies });
  port.postMessage({ cmd: "listFormats", url: tabUrl, useCookies });
}

// applyResponseUseCookies updates the module-level effectiveUseCookies
// from the SW-stamped field on a listFormats response. Called from both
// the formats and the listformats-error branches of onMessage so every
// path through the response resets state from the message rather than
// from whatever requestListFormats most recently set.
function applyResponseUseCookies(msg) {
  if (typeof msg.useCookies === "boolean") {
    effectiveUseCookies = msg.useCookies;
  }
}

function cookiesStrategyInitial() {
  return cookiesStrategyMode() === "always";
}

function cookiesStrategyMode() {
  if (!tabUrl) return "never";
  try {
    const host = new URL(tabUrl).hostname.toLowerCase();
    if (host === "twitter.com" || host.endsWith(".twitter.com") ||
        host === "x.com" || host.endsWith(".x.com")) {
      return saveSettings.twitterCookiesMode;
    }
    if (host === "youtube.com" || host.endsWith(".youtube.com") ||
        host === "youtu.be" || host.endsWith(".youtu.be")) {
      return saveSettings.youtubeCookiesMode;
    }
    if (host === "instagram.com" || host.endsWith(".instagram.com")) {
      return saveSettings.instagramCookiesMode;
    }
    if (host === "facebook.com" || host.endsWith(".facebook.com") ||
        host === "fb.watch" || host.endsWith(".fb.watch")) {
      return saveSettings.facebookCookiesMode;
    }
    if (host === "tiktok.com" || host.endsWith(".tiktok.com")) {
      return saveSettings.tiktokCookiesMode;
    }
  } catch {}
  // Unrecognized sites: "auto" so the fetch flow tries anonymously first,
  // then retries with cookies on the host's behalf if it fails. Lets the
  // "fetch all media on this page" button work on any yt-dlp-supported
  // site without hardcoding each one.
  return "auto";
}

// shouldRetryWithCookies returns true when an auto-mode listFormats error
// warrants a second attempt with cookies. We avoid retrying errors that
// cookies wouldn't fix (e.g. user cancels).
function shouldRetryWithCookies(msg) {
  if (cookiesRetryTried) return false;
  if (effectiveUseCookies) return false;
  if (cookiesStrategyMode() !== "auto") return false;
  return msg.code === "listformats_failed" || msg.code === "no_formats";
}
// getCaptures reads the per-post grab-button capture list the
// content script builds in chrome.storage.session. Each entry is
// {url, author, thumbUrl, capturedAt}. Empty array when there are
// no captures or the active tab isn't a Facebook tab.
async function getCaptures() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return [];
  try {
    const resp = await bgRequest({ type: "capture:list", tabId: tab.id });
    return resp?.items || [];
  } catch (err) {
    dlog("getCaptures failed", err.message);
    return [];
  }
}

async function clearCaptures() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  try {
    await bgRequest({ type: "capture:clear", tabId: tab.id });
  } catch (err) {
    dlog("clearCaptures failed", err.message);
  }
}

// Persist items fetched via "Fetch media on this page" in the same
// session storage key the arrow-button captures use, so they survive
// popup close. Each stored record wraps the full item so buildGallery
// FromCaptures can round-trip its fields (ext, mime, thumbUrl, etc.)
// back into the renderer without lossy conversion.
async function persistFetchedItems(items) {
  if (!items || items.length === 0) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  const payloads = items.map((it) => ({
    url: it.url,
    item: it,
    capturedAt: Date.now(),
  }));
  try {
    await bgRequest({ type: "capture:add-batch", tabId: tab.id, items: payloads });
  } catch (err) {
    dlog("persistFetchedItems failed", err.message);
  }
}

// showFetchPrompt renders the "Fetch media on this page" button. The
// user clicks it to run the site-specific fetch flow (runFetchFlow).
// This replaces the previous auto-fetch-on-popup-open behavior for
// every site. On Facebook, the on-page ⬇ grab button is an
// alternate path that bypasses this prompt and builds captures
// directly.
// The fetch button is always visible (including alongside a gallery
// or image picker once media has been fetched) so the user can
// re-scan the current page at any time — e.g. after swiping to a new
// reel. The button works on any URL: recognized first-class sites
// use their bespoke scrapers; everything else falls through to
// yt-dlp's generic listFormats path. This function is idempotent:
// safe to call as many times as needed.
function showFetchPrompt(opts = {}) {
  hide("loading");
  show("fetch-prompt");
  // Optional hint above the button, used by the lazy-verification path
  // (runFetchFlow → shouldAutoProbe = false). Hidden when no hint is
  // passed so the prompt looks the same as before for all the existing
  // call sites (post-download re-scan, dismissPicker, etc.).
  const hintEl = el("fetch-hint");
  if (hintEl) {
    if (opts.hint) {
      hintEl.textContent = opts.hint;
      hintEl.hidden = false;
    } else {
      hintEl.hidden = true;
      hintEl.textContent = "";
    }
  }
  const btn = el("fetch-btn");
  if (btn && !btn.dataset.wired) {
    btn.dataset.wired = "1";
    btn.addEventListener("click", runFetchFlow);
  }
  // Wire the per-card dismiss buttons once. They hide the single-item
  // pickers and return to the fetch-prompt screen, giving the user a
  // way to clear an unwanted result (wrong video, stale state, etc.)
  // without having to close the popup entirely.
  const dismissVideo = el("video-dismiss");
  if (dismissVideo && !dismissVideo.dataset.wired) {
    dismissVideo.dataset.wired = "1";
    dismissVideo.addEventListener("click", dismissPicker);
  }
  const dismissImage = el("image-dismiss");
  if (dismissImage && !dismissImage.dataset.wired) {
    dismissImage.dataset.wired = "1";
    dismissImage.addEventListener("click", dismissPicker);
  }
}

// dismissPicker hides whichever single-item picker is active and
// returns to the fetch-prompt state. Safe to call even if nothing
// is on screen. Clears the in-memory format/item state AND the
// persisted picker entry — without the latter, a popup re-open
// would re-render the dismissed picker, defeating the dismiss.
function dismissPicker() {
  hide("picker");
  hide("image-picker");
  hide("gallery-picker");
  clearFetchedPicker();
  currentFormats = null;
  activeJobId = null;
  pendingTerminalStatus = null;
  showFetchPrompt();
}

// Universal per-card remove. For capture-list galleries, also
// persists via capture:remove so the item doesn't come back next popup
// open. For any other gallery (Reddit / Twitter / Facebook DOM or
// interceptor), just drops from the in-memory list and re-renders.
async function removeGalleryItemByUrl(url) {
  if (!galleryState || galleryState.kind !== "gallery") return;
  const item = (galleryState.items || []).find((i) => i.url === url);
  if (!item) return;
  dlog("removeGalleryItem", {
    url: url?.slice(0, 80),
    isCapture: !!item.isCapture,
    totalItems: galleryState.items?.length,
  });
  // Capture-backed items need to leave session storage as well as
  // the in-memory list; fetched items are pure client-side state.
  if (item.isCapture) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      try {
        await bgRequest({ type: "capture:remove", tabId: tab.id, url });
      } catch (err) {
        dlog("capture:remove failed", err.message);
      }
    }
  }
  galleryState.items = (galleryState.items || []).filter((i) => i.url !== url);
  if (galleryState.items.length === 0) {
    // The persisted picker still holds the pre-removal item list. If
    // we let snapshot run with that in place, handleSnapshot's restore
    // branch finds it and re-renders the gallery the user JUST cleared
    // — looks like the list refills itself. Clear first, then snapshot.
    await clearFetchedPicker();
    hide("gallery-picker");
    galleryState = null;
    activeJobId = null;
    port.postMessage({ cmd: "snapshot" });
    return;
  }
  // Mid-edit: persist the trimmed list so close+reopen restores the
  // user's new state (not the original pre-edit one).
  persistFetchedPicker("gallery", galleryState);
  renderGalleryItems(galleryState.items);
  updateGalleryCount();
}

// "Remove selected" toolbar button handler. Collects every checked
// card's URL and removes them one by one through the same path the
// single × uses.
async function removeSelectedGalleryItems() {
  if (!galleryState || galleryState.kind !== "gallery") return;
  const checks = document.querySelectorAll("#gallery-items .card-check:checked");
  const selected = [];
  for (const cb of checks) {
    const idx = Number(cb.dataset.idx);
    const item = galleryState.items?.[idx];
    if (item?.url) selected.push(item);
  }
  if (selected.length === 0) return;
  const urls = selected.map((i) => i.url);
  const captureUrls = selected.filter((i) => i.isCapture).map((i) => i.url);
  dlog("removeSelected", { total: selected.length, captures: captureUrls.length });
  // Persist removals for capture items in ONE batch call — sending
  // individual capture:remove messages in parallel raced the storage
  // read/write (each handler read the same pre-remove snapshot,
  // filtered out its one url, wrote back; last write won, only one
  // item actually got removed from storage). capture:remove-batch reads
  // once, filters all, writes once.
  if (captureUrls.length > 0) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      try {
        await bgRequest({ type: "capture:remove-batch", tabId: tab.id, urls: captureUrls });
      } catch (err) {
        dlog("capture:remove-batch failed", err.message);
      }
    }
  }
  galleryState.items = (galleryState.items || []).filter((i) => !urls.includes(i.url));
  if (galleryState.items.length === 0) {
    // See removeGalleryItemByUrl — clear the persisted picker before
    // the snapshot or the cleared list comes right back.
    await clearFetchedPicker();
    hide("gallery-picker");
    galleryState = null;
    activeJobId = null;
    port.postMessage({ cmd: "snapshot" });
    return;
  }
  // Mid-edit persist so close+reopen restores the trimmed list.
  persistFetchedPicker("gallery", galleryState);
  renderGalleryItems(galleryState.items);
  updateGalleryCount();
}

// Convert the per-tab capture list into a gallery-info shape the
// picker already knows how to render. Each item is marked viaYtDlp
// so startGalleryDownload routes it through a single-URL yt-dlp call
// rather than the direct-download gallery path (the captured URLs
// are post permalinks, not direct media URLs).
function buildGalleryFromCaptures(captures) {
  const items = captures.map((c, idx) => {
    // Modern storage record: persists the full renderable item (from
    // the Fetch media button flow). Round-trips through storage
    // without losing ext / mime / width / height / handle etc.
    // Forward capturedAt so the gallery card can show the capture
    // time when the post itself doesn't carry a date (rare on FB,
    // common on TikTok).
    if (c.item) return { ...c.item, isCapture: true, capturedAt: c.capturedAt || c.item.capturedAt || 0 };
    // Legacy arrow-button capture. Two sub-shapes:
    //   textOnly: no images/video on the tweet — treat as a .txt
    //             that saves c.content directly via chrome.downloads.
    //   default:  a post-permalink item routed through yt-dlp.
    const fallbackName = `post-${idx + 1}`;
    const baseName = c.author
      ? sanitizeFilenameSegment(c.author).slice(0, 40) || fallbackName
      : fallbackName;
    const display = (c.title || c.author || fallbackName).slice(0, 80);
    if (c.textOnly) {
      const fileLabel = display || baseName;
      return {
        url: c.url,                  // kept as a provenance link; download uses content
        viaTextDownload: true,
        content: c.content || c.title || "",
        ext: "txt",
        width: 0,
        height: 0,
        thumbUrl: "",
        mime: "text/plain",
        basename: fileLabel,
        handle: c.author || "",
        capturedTitle: c.title || "",
        isCapture: true,
      };
    }
    // URL-shape hint for the kind of media. The legacy capture
    // payload doesn't carry an explicit kind, but some permalinks
    // are unambiguous: Facebook /photo/?fbid= is always a still
    // image, so hand it to the image-download path directly (skip
    // yt-dlp — it just wastes a spawn on a URL that resolves to
    // an image CDN link anyway and historically mislabelled them
    // as .mp4). Other URLs stay on the yt-dlp path.
    const isImagePermalink = /\/photo(\.php)?\/?\?[^#]*\bfbid=\d+/.test(c.url || "");
    if (isImagePermalink) {
      return {
        url: c.url,
        viaYtDlp: false,      // direct download via thumbUrl; yt-dlp has no FB photo extractor
        ext: "jpg",
        mime: "image/jpeg",
        width: c.width || 0,
        height: c.height || 0,
        thumbUrl: c.thumbUrl || "",
        basename: display,
        handle: c.author || "",
        capturedTitle: c.title || "",
        postDate: c.postDate || 0,
        capturedAt: c.capturedAt || 0,
        isCapture: true,
      };
    }
    return {
      url: c.url,
      viaYtDlp: true,
      ext: "mp4",
      width: c.width || 0,
      height: c.height || 0,
      thumbUrl: c.thumbUrl || "",
      mime: "video/mp4",
      basename: display,
      handle: c.author || "",
      capturedTitle: c.title || "",
      postDate: c.postDate || 0,
      capturedAt: c.capturedAt || 0,
      isCapture: true,
    };
  });
  dlog("captures gallery", "count=" + items.length,
    "withAuthor=" + items.filter((i) => i.handle).length,
    "withThumb=" + items.filter((i) => i.thumbUrl).length);
  const siteLabel = looksLikeTweet(tabUrl)
    ? "Twitter"
    : looksLikeInstagram(tabUrl)
      ? "Instagram"
      : looksLikeTikTok(tabUrl)
        ? "TikTok"
        : "Facebook";
  // Folder naming reads galleryState.title when the user picks the
  // "Title" / "@Poster - Title" folder mode. The old synthetic header
  // ("Facebook captures (1)") leaked into the folder name. For a
  // single-item capture use the actual post title; for multi-item
  // stick with the site label so the folder identifies the batch.
  const title = captures.length === 1
    ? ((captures[0].title || captures[0].item?.capturedTitle || captures[0].item?.basename || `${siteLabel} capture`).toString().trim()
        || `${siteLabel} capture`)
    : `${siteLabel} captures (${captures.length})`;
  const handle = captures.length === 1
    ? (captures[0].author || captures[0].item?.handle || "")
    : "";
  return {
    kind: "gallery",
    title,
    handle,
    date: 0,
    items,
    isCaptureList: true,
  };
}


// getInstagramDomInfo runs a scraper in the active tab to pull the
// currently-visible post/story media. Returns null for "scraper found
// nothing useful" so the caller can fall through to yt-dlp (works for
// reels). Posts and stories return an image/gallery info object shaped
// the same way reddit.js / twitter.js do.
// getTwitterDomInfo, scrapeTwitterMedia, parseTwitterVideoUrl,
// safePathname, withTwitterName, and pickVariantUrl moved to
// twitter.js (imported above). Removed from popup.js below.


// ---------------------------------------------------------------------------
// Video picker
// ---------------------------------------------------------------------------

function handleFormats(msg) {
  hide("loading");
  dlog("formats received", {
    title: msg.title,
    uploaderId: msg.uploaderId,
    uploader: msg.uploader,
    formats: (msg.items ?? []).length,
  });
  logFetcher("youtube", "formats-result", {
    url: tabUrl,
    title: msg.title,
    thumbnailUrl: msg.thumbnail || "",
    duration: msg.duration || 0,
    formatCount: (msg.items ?? []).length,
  });
  // Persist the formats payload so closing+reopening the popup on
  // the same URL restores this picker instead of the empty fetch
  // prompt. Cleared by dismissPicker, by URL change, or by tab close.
  persistFetchedPicker("formats", msg);
  // Lazy-verification cache: yt-dlp accepted this host, so future
  // popup opens on it can skip the Try-anyway prompt. We only cache
  // positives — see rememberHostSupported for why negatives are
  // intentionally not cached.
  rememberHostSupported(tabUrl);
  if (!msg.items || msg.items.length === 0) {
    renderError({ message: "No downloadable formats found." });
    return;
  }
  currentFormats = msg.items;
  currentTitle = msg.title || tabUrl;
  currentUploader = msg.uploader || "";
  currentUploaderId = msg.uploaderId || "";
  currentThumbnail = msg.thumbnail || "";
  currentDuration = Number(msg.duration) || 0;
  el("title").textContent = currentTitle;
  renderVideoCard(msg);
  populateQualityOptions(msg.items);
  wireKindSwitch();
  wireVideoFilenameMode();
  wireYouTubeImageActions();
  initDownloadControls("#picker");
  el("download").addEventListener("click", startDownload);
  show("picker");
  maybeApplyPendingStatus();
}

// wireVideoFilenameMode reveals/hides the user-set text input based on
// the filename dropdown, and seeds the input with the handle-based
// default the first time it's shown so the user isn't starting empty.
function wireVideoFilenameMode() {
  const sel = el("video-filename-mode");
  const input = el("video-filename-custom");
  if (!sel || !input) return;
  const refresh = () => {
    input.hidden = sel.value !== "set";
    if (sel.value === "set" && !input.value.trim()) {
      const handle = pickHandleText(currentUploaderId, currentUploader);
      const base = handle ? `${handle} - ${currentTitle}` : currentTitle;
      input.value = sanitizeFilenameSegment(base);
    }
  };
  refresh();
  sel.onchange = refresh;
}

function wireYouTubeImageActions() {
  const isYoutube = (() => {
    try {
      const host = new URL(tabUrl).hostname.toLowerCase();
      return host === "youtube.com" || host.endsWith(".youtube.com") ||
        host === "youtu.be" || host.endsWith(".youtu.be");
    } catch {
      return false;
    }
  })();
  const box = el("youtube-image-actions");
  if (!box) return;
  box.hidden = !isYoutube;
  if (!isYoutube) return;
  const slider = el("yt-frame-slider");
  const input = el("yt-frame-time");
  if (slider) {
    slider.max = String(Math.max(0, Math.floor(currentDuration)));
    slider.value = "0";
  }
  if (input) input.value = "0:00";
  slider.oninput = () => {
    input.value = formatTimestamp(Number(slider.value) || 0);
  };
  input.onchange = () => {
    const v = validateTimestamp(input.value, currentDuration);
    if (v.ok) slider.value = String(Math.floor(v.seconds));
  };
  el("yt-save-thumb").onclick = startThumbnailDownload;
  el("yt-save-current-frame").onclick = startCurrentFrameDownload;
  el("yt-save-timestamp-frame").onclick = () => {
    const v = validateTimestamp(input.value, currentDuration);
    if (!v.ok) {
      inlineRenderError({ code: "bad_request", message: "Enter a timestamp within the video duration." });
      return;
    }
    startFrameDownload(v.seconds);
  };
}

function renderVideoCard(msg) {
  const thumb = el("video-thumb");
  if (msg.thumbnail) {
    thumb.src = msg.thumbnail;
    thumb.style.display = "";
  } else {
    thumb.removeAttribute("src");
  }
  const uploader = el("video-uploader");
  const handle = pickHandleText(msg.uploaderId, msg.uploader);
  if (handle) {
    uploader.textContent = handle;
    uploader.hidden = false;
  } else {
    uploader.hidden = true;
    uploader.textContent = "";
  }
  const meta = el("video-meta");
  const parts = [];
  const date = formatDate(msg.date);
  if (date) parts.push(date);
  if (typeof msg.duration === "number" && msg.duration > 0) {
    parts.push(formatDuration(msg.duration));
  }
  // Show the biggest filesize yt-dlp reported across all formats so the
  // user gets a sense of how large the best-quality download will be.
  // Missing sizes are skipped (filesize is often null for HLS segments).
  let maxSize = 0;
  for (const f of msg.items || []) {
    if (f.filesize && f.filesize > maxSize) maxSize = f.filesize;
  }
  if (maxSize > 0) parts.push(formatBytes(maxSize));
  meta.textContent = parts.join(" · ");
}

function populateQualityOptions(items) {
  const heights = new Set();
  for (const f of items) {
    if ((f.kind === "video" || f.kind === "combined") && f.height) {
      heights.add(f.height);
    }
  }
  const sorted = Array.from(heights).sort((a, b) => b - a);
  const sel = el("quality");
  sel.innerHTML = "";
  const best = document.createElement("option");
  best.value = "0";
  best.textContent = "Best available";
  sel.appendChild(best);
  for (const h of sorted) {
    const o = document.createElement("option");
    o.value = String(h);
    o.textContent = `${h}p`;
    sel.appendChild(o);
  }
}

function wireKindSwitch() {
  el("kind").addEventListener("change", () => {
    el("quality-group").hidden = (currentKind() === "audio");
  });
}

function currentKind() {
  return el("kind").value;
}

function renderSaveModeHint(targetId = "save-mode-hint") {
  const hint = el(targetId);
  if (!hint) return;
  const mode = resolveEffectiveMode();
  // In ask mode there's nothing useful to preview — the Save As dialog
  // will tell the user everything when it opens. Hide the hint so it
  // doesn't add noise.
  if (mode === "ask") {
    hint.innerHTML = "";
    hint.hidden = true;
    return;
  }
  hint.hidden = false;
  if (mode === "lastLocation") {
    hint.innerHTML = `<span class="mode">Save to last location:</span><span class="path">${escapeHtml(saveSettings.lastDir)}</span>`;
  } else if (mode === "specific") {
    hint.innerHTML = `<span class="mode">Save to:</span><span class="path">${escapeHtml(saveSettings.specificDestDir)}</span>`;
  } else {
    hint.innerHTML = `<span class="mode">Save to your default download folder.</span>`;
  }
}

function resolveEffectiveMode() {
  if (saveSettings.saveMode === "specific" && !saveSettings.specificDestDir) return "ask";
  if (saveSettings.saveMode === "lastLocation" && !saveSettings.lastDir) return "ask";
  return saveSettings.saveMode;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}

function startDownload() {
  const kind = currentKind();
  const height = parseInt(el("quality").value, 10) || 0;
  const includeSubs = el("include-subs")?.checked === true;
  const fnMode = selectedVideoFilenameMode();
  const customName = fnMode === "set" ? (el("video-filename-custom")?.value || "").trim() : "";
  const handle = pickHandleText(currentUploaderId, currentUploader);

  // Subtitles are off by default; when the user explicitly checks the
  // box we ask yt-dlp for both explicit + auto-generated tracks. yt-
  // dlp on a video with no subs available skips silently — no error,
  // no .vtt — so the "should not crash" promise is upheld for sources
  // without caption support.
  if (includeSubs) {
    dlog("download: subtitles requested", { url: tabUrl });
  }

  const msg = {
    cmd: "download",
    jobId: crypto.randomUUID(),
    url: tabUrl,
    selection: { kind, height, includeSubs },
    useCookies: effectiveUseCookies,
    filenameTemplate: customName
      ? ytdlpEscapeTemplate(buildSafeFilename(customName, "__EXT__").replace(/\.__EXT__$/, "")) + ".%(ext)s"
      : videoFilenameTemplate(fnMode),
  };

  // Download-routing precedence (shared across every picker):
  //   1. downloadAutomatically = false → Save As dialog, ignore
  //      destination / album-folder for the location.
  //   2. automatic + destinationDir set → save into destinationDir
  //      (+ optional subfolder from currentAlbumName).
  //   3. automatic + no destinationDir → host writes to the user's
  //      default downloads folder (empty destDir).
  if (!saveSettings.downloadAutomatically) {
    msg.askPath = true;
    msg.defaultFileName = customName
      ? buildSafeFilename(customName, kind === "audio" ? "m4a" : "mp4")
      : guessDefaultName(currentTitle, kind, fnMode);
    msg.startDir = saveSettings.destinationDir || saveSettings.lastDir || saveSettings.specificDestDir || "";
    msg.dialogTitle = "Save as…";
  } else {
    msg.destDir = saveSettings.destinationDir || "";
    const album = currentAlbumName(handle);
    if (album) msg.albumName = album;
  }

  dlog("download video -> host", {
    jobId: msg.jobId,
    kind,
    height,
    saveMode: resolveEffectiveMode(),
    filenameMode: fnMode,
    filenameTemplate: msg.filenameTemplate,
    useCookies: msg.useCookies,
    askPath: !!msg.askPath,
    destDir: msg.destDir,
  });
  logFetcher("popup", "download:send", {
    url: tabUrl,
    kind,
    height,
    useCookies: msg.useCookies,
    askPath: !!msg.askPath,
  });
  dlogLastPct = -10;
  activeJobId = msg.jobId;
  clearInlineStatus();
  disableActivePrimary();
  port.postMessage(msg);
  inlineRenderRunning({ percent: 0 });
}

function youtubeBaseName(kind, seconds = 0) {
  const handle = pickHandleText(currentUploaderId, currentUploader);
  const base = handle ? `${handle} - ${currentTitle}` : currentTitle;
  if (kind === "thumbnail") return buildSafeFilename(`${base} thumbnail`, "jpg");
  return buildSafeFilename(`${base} frame ${formatTimestamp(seconds).replace(/:/g, "-")}`, "png");
}

function startThumbnailDownload() {
  if (!currentThumbnail) {
    inlineRenderError({ code: "bad_request", message: "No thumbnail URL was reported for this video." });
    return;
  }
  const handle = pickHandleText(currentUploaderId, currentUploader);
  const msg = {
    cmd: "downloadUrl",
    jobId: crypto.randomUUID(),
    url: currentThumbnail,
    pageUrl: tabUrl,
    defaultFileName: youtubeBaseName("thumbnail"),
  };
  if (!saveSettings.downloadAutomatically) {
    msg.askPath = true;
    msg.startDir = saveSettings.destinationDir || saveSettings.lastDir || saveSettings.specificDestDir || "";
    msg.dialogTitle = "Save thumbnail as...";
  } else {
    msg.destDir = saveSettings.destinationDir || "";
    const album = currentAlbumName(handle);
    if (album) msg.albumName = album;
  }
  activeJobId = msg.jobId;
  logFetcher("youtube", "thumbnail-download:send", { url: currentThumbnail, pageUrl: tabUrl, askPath: !!msg.askPath });
  clearInlineStatus();
  disableActivePrimary();
  port.postMessage(msg);
  inlineRenderRunning({ percent: 0 });
}

async function startCurrentFrameDownload() {
  let seconds = 0;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      const result = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => document.querySelector("video")?.currentTime ?? 0,
      });
      seconds = Number(result?.[0]?.result) || 0;
    }
  } catch {}
  logFetcher("youtube", "current-frame:timestamp", { url: tabUrl, timestamp: seconds });
  startFrameDownload(seconds);
}

function startFrameDownload(seconds) {
  const handle = pickHandleText(currentUploaderId, currentUploader);
  const msg = {
    cmd: "extractFrame",
    jobId: crypto.randomUUID(),
    url: tabUrl,
    pageUrl: tabUrl,
    timestamp: seconds,
    useCookies: effectiveUseCookies,
    defaultFileName: youtubeBaseName("frame", seconds),
  };
  if (!saveSettings.downloadAutomatically) {
    msg.askPath = true;
    msg.startDir = saveSettings.destinationDir || saveSettings.lastDir || saveSettings.specificDestDir || "";
    msg.dialogTitle = "Save frame as...";
  } else {
    msg.destDir = saveSettings.destinationDir || "";
    const album = currentAlbumName(handle);
    if (album) msg.albumName = album;
  }
  activeJobId = msg.jobId;
  logFetcher("youtube", "frame-extract:send", { url: tabUrl, timestamp: seconds, askPath: !!msg.askPath });
  clearInlineStatus();
  disableActivePrimary();
  port.postMessage(msg);
  inlineRenderRunning({ percent: 0 });
}

// ---------------------------------------------------------------------------
// Image picker
// ---------------------------------------------------------------------------

function showImagePicker(info) {
  hide("loading");
  // Persist so popup close+reopen on the same URL restores this picker.
  // Captures-derived re-renders also pass through here, but their
  // restore path is handled by getCaptures on snapshot — the URL-match
  // gate in loadFetchedPicker prevents a stale captures-derived entry
  // from confusing the next open.
  persistFetchedPicker("image", info);
  galleryState = info;
  currentTitle = info.title;
  el("image-title").textContent = info.title;

  const uploader = el("image-uploader");
  const handle = normalizeHandle(info.handle);
  if (handle) {
    uploader.textContent = handle;
    uploader.hidden = false;
  } else {
    uploader.hidden = true;
    uploader.textContent = "";
  }

  const thumb = el("image-thumb");
  thumb.src = info.thumbUrl || info.imageUrl;
  thumb.alt = "";

  // Filename is the URL basename — same thing the gallery rows show.
  const filename = el("image-filename");
  filename.textContent = info.basename || extensionFromUrl(info.imageUrl);

  el("image-meta").textContent = imageMetaText(info);
  // Pre-select the user's saved mode. The image picker doesn't expose
  // "sequential" (per-item indexing is meaningless for a 1-of-1
  // download) so map that case to "uploader-title".
  const savedMode = saveSettings.filenameMode === "sequential"
    ? "uploader-title"
    : saveSettings.filenameMode;
  const imgSel = el("image-filename-mode");
  if (imgSel) imgSel.value = savedMode;
  wireImageFilenameMode(info);
  initDownloadControls("#image-picker");
  el("image-download").addEventListener("click", startImageDownload);
  show("image-picker");
  maybeApplyPendingStatus();
  fetchImageSize(info);
}

// wireImageFilenameMode mirrors the video picker: reveal the user-set
// text input when the mode dropdown lands on "User set", seeded with a
// handle-aware default the first time.
function wireImageFilenameMode(info) {
  const sel = el("image-filename-mode");
  const input = el("image-filename-custom");
  if (!sel || !input) return;
  const refresh = () => {
    input.hidden = sel.value !== "setEach";
    if (sel.value === "setEach" && !input.value.trim()) {
      const handle = normalizeHandle(info.handle);
      const base = handle ? `${handle} - ${info.title}` : info.title;
      input.value = sanitizeFilenameSegment(base);
    }
  };
  refresh();
  sel.onchange = refresh;
}

function imageMetaText(info) {
  const parts = [];
  const date = formatDate(info.date);
  if (date) parts.push(date);
  const typeLabel = prettyMime(info.mime) || extensionFromUrl(info.imageUrl).toUpperCase();
  if (typeLabel) parts.push(typeLabel);
  if (info.width && info.height) parts.push(`${info.width} × ${info.height}`);
  if (info.bytes) parts.push(formatBytes(info.bytes));
  return parts.join(" · ");
}

// formatDate renders a unix-second timestamp as YYYY-MM-DD (ISO 8601
// date, unambiguous across locales). Returns "" for 0 / missing /
// malformed values so callers can use `if (date) parts.push(date)`.
function formatDate(unixSec) {
  const n = Number(unixSec) || 0;
  if (n <= 0) return "";
  const d = new Date(n * 1000);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function fetchImageSize(info) {
  if (info.bytes) return;
  try {
    const resp = await fetch(info.imageUrl, { method: "HEAD", credentials: "omit" });
    if (!resp.ok) return;
    const len = resp.headers.get("Content-Length");
    const mime = resp.headers.get("Content-Type");
    if (len) info.bytes = parseInt(len, 10);
    if (mime) info.mime = mime.split(";")[0].trim();
    el("image-meta").textContent = imageMetaText(info);
  } catch {}
}

function prettyMime(mime) {
  if (!mime) return "";
  switch (mime) {
    case "image/jpeg":
    case "image/jpg":
      return "JPEG";
    case "image/png":
      return "PNG";
    case "image/gif":
      return "GIF";
    case "image/webp":
      return "WEBP";
    case "video/mp4":
      return "MP4";
    default:
      return mime.replace(/^(image|video)\//, "").toUpperCase();
  }
}

async function startImageDownload() {
  if (!galleryState || galleryState.kind !== "image") return;
  let filenameMode = el("image-filename-mode")?.value ?? "uploader-title";
  if (filenameMode === "default") filenameMode = "uploader-title";
  await persistSetting("filenameMode", filenameMode);

  const ext = extensionFromUrl(galleryState.imageUrl) || "jpg";
  const handle = normalizeHandle(galleryState.handle);
  const customName = filenameMode === "setEach"
    ? (el("image-filename-custom")?.value || "").trim()
    : "";
  let fileName;
  if (customName) {
    fileName = buildSafeFilename(customName, ext);
  } else if (filenameMode === "original") {
    fileName = sanitizeLooseFilename(galleryState.basename || buildSafeFilename(galleryState.title, ext));
  } else if (filenameMode === "uploader-title" && handle) {
    fileName = buildSafeFilename(`${handle} - ${galleryState.title}`, ext);
  } else {
    fileName = buildSafeFilename(galleryState.title, ext);
  }

  const msg = {
    cmd: "downloadUrl",
    jobId: crypto.randomUUID(),
    url: galleryState.imageUrl,
    pageUrl: tabUrl,
    defaultFileName: fileName,
  };
  if (!saveSettings.downloadAutomatically) {
    msg.askPath = true;
    msg.startDir = saveSettings.destinationDir || saveSettings.lastDir || saveSettings.specificDestDir || "";
    msg.dialogTitle = "Save image as…";
  } else {
    msg.destDir = saveSettings.destinationDir || "";
    const album = currentAlbumName(handle);
    if (album) msg.albumName = album;
  }

  activeJobId = msg.jobId;
  clearInlineStatus();
  disableActivePrimary();
  port.postMessage(msg);
  inlineRenderRunning({ percent: 0 });
}


// ---------------------------------------------------------------------------
// Gallery picker
// ---------------------------------------------------------------------------

function showGalleryPicker(info) {
  hide("loading");
  // Persist for popup-reopen restore. See showImagePicker for the
  // captures-vs-fetched-flow note.
  persistFetchedPicker("gallery", info);
  galleryState = info;
  currentTitle = info.title;
  initDownloadControls("#gallery-picker");
  renderGalleryItems(info.items);
  updateGalleryCount();
  el("gallery-download").addEventListener("click", startGalleryDownload);
  el("select-all").addEventListener("click", () => setAllGallerySelected(true));
  el("select-none").addEventListener("click", () => setAllGallerySelected(false));
  const removeSelBtn = el("gallery-remove-selected");
  if (removeSelBtn && !removeSelBtn.dataset.wired) {
    removeSelBtn.dataset.wired = "1";
    removeSelBtn.addEventListener("click", removeSelectedGalleryItems);
  }
  show("gallery-picker");
  maybeApplyPendingStatus();
  fetchGalleryItemSizes(info.items);

  // Auto-start the download when the user has "Prompt each download"
  // UNchecked (saveSettings.downloadAutomatically === true). Gated on
  // a fresh-capture timestamp so popping the popup open to review
  // stale captures doesn't suddenly fire a download: if the newest
  // item's capturedAt is older than ~6s we treat the gallery as a
  // review session, not a just-fetched one. 6s covers the grab-button
  // → openPopup → init roundtrip on slow machines. Skip when there's
  // already an active download in flight (inline Running state).
  if (saveSettings.downloadAutomatically && !activeJobId && Array.isArray(info.items) && info.items.length > 0) {
    const now = Date.now();
    const newestCapturedAt = info.items.reduce((acc, i) => Math.max(acc, i.capturedAt || 0), 0);
    if (newestCapturedAt > 0 && now - newestCapturedAt < 6000) {
      dlog("auto-download: prompt-each unchecked, fresh capture", {
        newestCapturedAt, ageMs: now - newestCapturedAt, items: info.items.length,
      });
      // Defer to the next paint frame so renderGalleryItems /
      // updateGalleryCount have committed before startGalleryDownload
      // reads selectedGalleryItems. requestAnimationFrame is the
      // semantic match here (not a magic 150ms).
      requestAnimationFrame(() => {
        try { startGalleryDownload(); } catch (err) { dlog("auto-download threw", err?.message || err); }
      });
    }
  }
}

// initDownloadControls clones the shared <template> into the single
// top-level .download-controls-slot and wires every control against
// the shared saveSettings state. Lives above every picker so its
// position and visibility don't shift depending on which picker
// happens to be on screen — or whether any picker is visible at all.
//
// Idempotent: safe to call multiple times. The `pickerSelector` arg
// is accepted for callers that predate the top-level layout and is
// ignored (kept so renames aren't load-bearing).
function initDownloadControls(_pickerSelector) {
  let slot = document.querySelector(".download-controls-slot.top-level");
  if (!slot) slot = document.querySelector(".download-controls-slot");
  if (!slot) return;
  if (!slot.firstElementChild) {
    const tmpl = document.getElementById("download-controls-tmpl");
    slot.appendChild(tmpl.content.firstElementChild.cloneNode(true));
  }

  const promptToggle = slot.querySelector(".dl-prompt-each");
  const autoBody = slot.querySelector(".dl-auto-body");
  const destPick = slot.querySelector(".dl-pick");
  const destPath = slot.querySelector(".dl-path");
  const folderToggle = slot.querySelector(".dl-create-folder");
  const folderBody = slot.querySelector(".dl-folder-body");
  const folderMode = slot.querySelector(".dl-folder-mode");
  const folderCustom = slot.querySelector(".dl-folder-custom");

  // "Prompt each download" inverts downloadAutomatically: when the
  // user CHECKS it they're asking for a Save As dialog per file, so
  // downloadAutomatically becomes false and the destination / folder
  // controls are hidden (they don't apply when every file prompts).
  // When UNchecked, files land in the configured destination without
  // a dialog, and those controls need to be visible.
  promptToggle.checked = !saveSettings.downloadAutomatically;
  autoBody.hidden = promptToggle.checked;
  renderDestinationPath(destPath);
  promptToggle.onchange = () => {
    autoBody.hidden = promptToggle.checked;
    // Let persistSetting do the memory + storage update. Pre-setting
    // saveSettings.downloadAutomatically here would trip its
    // equality guard and skip the storage write, so the next popup
    // open would re-load the stale persisted value.
    persistSetting("downloadAutomatically", !promptToggle.checked);
  };

  // Destination folder picker — same SW relay options.js uses.
  destPick.onclick = () => {
    destPick.disabled = true;
    port.postMessage({ cmd: "pickFolder", dialogTitle: "Choose download destination" });
  };

  // "Download to new folder" + folder-name mode.
  folderToggle.checked = !!saveSettings.createFolder;
  folderBody.hidden = !folderToggle.checked;
  folderMode.value = saveSettings.folderMode;
  folderCustom.value = defaultAlbumName("uploader-title");
  folderCustom.hidden = folderMode.value !== "set";

  folderToggle.onchange = () => {
    folderBody.hidden = !folderToggle.checked;
    persistSetting("createFolder", folderToggle.checked);
  };
  folderMode.onchange = () => {
    folderCustom.hidden = folderMode.value !== "set";
    if (folderMode.value === "set" && !folderCustom.value.trim()) {
      folderCustom.value = defaultAlbumName("uploader-title");
    }
    persistSetting("folderMode", folderMode.value);
  };
}

function renderDestinationPath(node) {
  const target = node || document.querySelector(".download-controls:not([hidden]) .dl-path");
  if (!target) return;
  const dir = saveSettings.destinationDir;
  if (dir) {
    target.textContent = dir;
    target.classList.remove("empty");
  } else {
    target.textContent = "Using default save location";
    target.classList.add("empty");
  }
}

// handleDestinationPicked catches the SW's folderPicked response when
// the user clicked "Choose folder…" on whichever picker's controls are
// visible. Re-enables the picker button(s) and refreshes the path row.
function handleDestinationPicked(msg) {
  // Re-enable every .dl-pick on the page — only one is visible at a
  // time anyway, and this saves us from tracking which picker fired it.
  document.querySelectorAll(".dl-pick").forEach((b) => { b.disabled = false; });
  if (msg.canceled || !msg.path) return;
  persistSetting("destinationDir", msg.path);
  // Update every path node so the right one lights up no matter which
  // picker surfaced the dialog.
  document.querySelectorAll(".dl-path").forEach((n) => renderDestinationPath(n));
}

// currentAlbumName returns the folder the user wants for this session
// ("" when the Download-to-new-folder toggle is off). Reads directly
// from the visible picker's DOM so ad-hoc edits to the custom input
// apply at dispatch time without a round-trip through storage.
function currentAlbumName(preferredHandle) {
  if (!saveSettings.createFolder) return "";
  const slot = document.querySelector(".download-controls");
  if (!slot) return "";
  const mode = slot.querySelector(".dl-folder-mode")?.value || "uploader-title";
  const title = (galleryState?.title || currentTitle || "").toString().trim();
  if (mode === "set") {
    const custom = (slot.querySelector(".dl-folder-custom")?.value || "").trim();
    return buildSafeFolderName(custom || title);
  }
  const handle = normalizeHandle(preferredHandle || "");
  // Combine only what's present — empty title with a handle should not
  // leave a trailing " - "; missing both drops the folder entirely.
  if (mode === "uploader-title") {
    if (handle && title) return buildSafeFolderName(`${handle} - ${title}`);
    if (handle) return buildSafeFolderName(handle);
    return buildSafeFolderName(title);
  }
  return buildSafeFolderName(title);
}

// defaultAlbumName builds the folder name the download controls should
// suggest for the current picker. Works across video / image / gallery
// — picks the handle from whichever source the active picker populated.
function defaultAlbumName(mode) {
  const handleSrc = galleryState?.handle || currentUploaderId || currentUploader || "";
  const handle = normalizeHandle(handleSrc);
  const title = (galleryState?.title || currentTitle || "").toString().trim();
  if (mode === "uploader-title") {
    if (handle && title) return buildSafeFolderName(`${handle} - ${title}`);
    if (handle) return buildSafeFolderName(handle);
    return buildSafeFolderName(title);
  }
  return buildSafeFolderName(title);
}

// Thin wrapper around the shared helper so the gallery call-site reads
// the same way all three pickers do.
function pickAlbumName(handle) {
  return currentAlbumName(handle);
}

function renderGalleryItems(items) {
  const list = el("gallery-items");
  list.innerHTML = "";
  const total = items.length;
  const defaultFilename = saveSettings.filenameMode || "uploader-title";

  items.forEach((item, idx) => {
    const row = document.createElement("label");
    row.className = "media-card selectable";
    row.dataset.idx = String(idx);

    const top = document.createElement("div");
    top.className = "card-top";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "card-check";
    cb.dataset.idx = String(idx);
    cb.checked = true;
    // aria-label so a screen reader announces "checkbox, checked, item
    // 3 of 8: <title>" instead of a contextless "checkbox, checked".
    // basename is a sensible fallback when the post has no title (raw
    // image gallery on Reddit, captures with no metadata).
    const itemHint = (item.title || item.basename || `item ${idx + 1}`).slice(0, 80);
    cb.setAttribute("aria-label", `Select ${idx + 1} of ${total}: ${itemHint}`);
    cb.addEventListener("change", updateGalleryCount);

    const thumb = document.createElement("img");
    thumb.className = "card-thumb";
    thumb.src = item.thumbUrl || item.url;
    thumb.loading = "lazy";
    thumb.alt = "";
    // Fill in width/height from the thumb once it decodes, then
    // refresh the meta line so the user sees dimensions on the card
    // even when the capture payload didn't include them (common on
    // grab-button captures — we only learn the real dimensions once
    // the <img> is laid out).
    thumb.addEventListener(
      "load",
      () => {
        if (!item.width && thumb.naturalWidth) item.width = thumb.naturalWidth;
        if (!item.height && thumb.naturalHeight) item.height = thumb.naturalHeight;
        if (meta && (item.width || item.height)) {
          meta.textContent = galleryItemMetaText(item);
        }
      },
      { once: true },
    );

    // Videos render with a play-icon overlay so it's visually obvious that
    // the card's JPG-looking poster is really a video. No overlay for
    // image items.
    let thumbNode;
    if (item.mime && item.mime.startsWith("video/")) {
      const wrap = document.createElement("div");
      wrap.className = "card-thumb-wrap";
      const badge = document.createElement("div");
      badge.className = "card-play-badge";
      wrap.append(thumb, badge);
      thumbNode = wrap;
    } else {
      thumbNode = thumb;
    }

    const info = document.createElement("div");
    info.className = "card-info";

    // Uploader handle goes first to match the single-video/single-image
    // card layout — poster info above the filename/meta.
    const handle = normalizeHandle(item.handle);
    if (handle) {
      const uploader = document.createElement("div");
      uploader.className = "card-uploader";
      uploader.textContent = handle;
      info.append(uploader);
    }

    const filename = document.createElement("div");
    filename.className = "card-filename";
    filename.textContent = item.basename;
    info.append(filename);

    // Captured post title — what the user saw as the post body, not
    // a filename. Shown when it differs from the derived basename so
    // we don't duplicate info on posts whose filename already IS the
    // title. Truncated visually via CSS; full text in tooltip.
    if (item.capturedTitle && item.capturedTitle.trim() && item.capturedTitle.trim() !== item.basename) {
      const capTitle = document.createElement("div");
      capTitle.className = "card-capturedtitle";
      capTitle.textContent = item.capturedTitle.trim();
      capTitle.title = item.capturedTitle.trim();
      info.append(capTitle);
    }

    const meta = document.createElement("div");
    meta.className = "card-meta";
    meta.textContent = galleryItemMetaText(item);
    info.append(meta);

    // Every card shows the N/M position badge at top-right, plus a
    // × remove-from-list button. Removing from a capture gallery
    // persists (sends capture:remove to the background); removing from
    // other galleries (Reddit, Twitter, Facebook DOM/interceptor)
    // just drops the item from the in-memory list and re-renders,
    // which is sufficient — the user can always re-fetch.
    const pos = document.createElement("span");
    pos.className = "card-position";
    pos.textContent = `${idx + 1}/${total}`;

    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "card-remove";
    rm.textContent = "×";
    rm.title = "Remove from list";
    // The row is a <label>, which turns every click inside it into
    // a click on the associated checkbox by default. Cancel on both
    // mousedown (earliest) AND click so the label activation doesn't
    // fire, then invoke the remove. Without mousedown-level cancel
    // the label's associated input captures focus first on some
    // platforms and swallows the click.
    const stop = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
    rm.addEventListener("mousedown", stop, true);
    rm.addEventListener("pointerdown", stop, true);
    rm.addEventListener("click", (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      dlog("× clicked", { url: item.url?.slice(0, 60) });
      removeGalleryItemByUrl(item.url);
    }, true);

    row.classList.add("has-remove");
    top.append(cb, thumbNode, info, pos, rm);
    row.append(top);

    // Controls row spans the full card width (sits below card-top).
    // Filename goes first — it's the decision users tweak most often,
    // and putting it at the top matches the single-video picker layout.
    // Kind + Quality follow, and only render for video items.
    const controls = document.createElement("div");
    controls.className = "card-controls";
    const isVideo = item.mime && item.mime.startsWith("video/");

    // Per-item Filename dropdown — mirrors the single pickers so every
    // card has its own stack. [@Poster] - [Title] [Index] is the default
    // first option because it's the only preset that guarantees unique
    // filenames within a gallery (the index disambiguates collisions
    // when the post title is the same across items).
    const fLabel = document.createElement("label");
    fLabel.className = "card-control";
    const fSpan = document.createElement("span");
    fSpan.textContent = "Filename";
    const fSel = document.createElement("select");
    fSel.className = "gallery-item-filename";
    // A 1-item "gallery" (e.g. a Twitter tweet with a single video) never
    // appends an index — the label should reflect that, otherwise the
    // user sees "[Index]" even though no index shows up in the filename.
    const indexSuffix = total > 1 ? " [Index]" : "";
    fSel.add(new Option(`[@Poster] - [Title]${indexSuffix}`, "uploader-title"));
    fSel.add(new Option(`[Title]${indexSuffix}`, "title"));
    fSel.add(new Option("Index", "sequential"));
    fSel.add(new Option("Original filename", "original"));
    fSel.add(new Option("User set", "setEach"));
    fSel.value = defaultFilename;
    fLabel.append(fSpan, fSel);
    controls.append(fLabel);

    // Per-item user-set text input — revealed when the mode is setEach,
    // pre-filled with a handle-aware default (including the 1-based
    // index for multi-item galleries) on first show. The index is part
    // of the pre-fill rather than auto-appended at build time so the
    // user sees the exact final name up front and can edit it.
    const fCustom = document.createElement("input");
    fCustom.type = "text";
    fCustom.className = "card-custom-input gallery-item-filename-custom";
    fCustom.placeholder = "Filename (no extension)";
    fCustom.hidden = fSel.value !== "setEach";
    const digits = String(total).length;
    const seedCustom = () => {
      if (fCustom.value.trim()) return;
      const handleStr = normalizeHandle(item.handle) ||
        normalizeHandle(galleryState?.handle || "");
      const titleStr = galleryState?.title || item.basename || "download";
      const base = handleStr ? `${handleStr} - ${titleStr}` : titleStr;
      const indexed = total > 1
        ? `${base} ${String(idx + 1).padStart(digits, "0")}`
        : base;
      fCustom.value = sanitizeFilenameSegment(indexed);
    };
    if (!fCustom.hidden) seedCustom();
    fSel.addEventListener("change", () => {
      fCustom.hidden = fSel.value !== "setEach";
      if (!fCustom.hidden) seedCustom();
    });
    controls.append(fCustom);

    let kSel = null;
    let qSel = null;
    if (isVideo) {
      const kLabel = document.createElement("label");
      kLabel.className = "card-control";
      const kSpan = document.createElement("span");
      kSpan.textContent = "Kind";
      kSel = document.createElement("select");
      kSel.className = "gallery-item-kind";
      kSel.add(new Option("Video + Audio", "combined"));
      kSel.add(new Option("Video only", "video"));
      kSel.add(new Option("Audio only", "audio"));
      kLabel.append(kSpan, kSel);
      controls.append(kLabel);

      if (Array.isArray(item.variants) && item.variants.length > 1) {
        const qLabel = document.createElement("label");
        qLabel.className = "card-control";
        const qSpan = document.createElement("span");
        qSpan.textContent = "Quality";
        qSel = document.createElement("select");
        qSel.className = "gallery-item-quality";
        qSel.add(new Option("Best available", "0"));
        for (const v of item.variants) {
          if (v.height > 0) qSel.add(new Option(`${v.height}p`, String(v.height)));
        }
        qLabel.append(qSpan, qSel);
        controls.append(qLabel);
        // Audio-only discards video, so Quality is meaningless then.
        kSel.addEventListener("change", () => {
          qSel.disabled = kSel.value === "audio";
        });
      }
    }

    row.append(controls);
    list.appendChild(row);
  });
}

function galleryItemMetaText(item) {
  const parts = [];
  // Date precedence:
  //   1. galleryState.date — whole-post publish time from a live fetch
  //      (Twitter/Reddit syndication APIs, in unix seconds).
  //   2. item.postDate — publish time the grab button scraped from
  //      the post DOM or the graphql interceptor (unix seconds).
  //
  // When neither is available we omit the date entirely — showing
  // the user's capture time would be misleading (it's not the post
  // date), and "unknown" text is clutter.
  if (galleryState?.date) {
    const d = formatDate(galleryState.date);
    if (d) parts.push(d);
  } else if (item.postDate) {
    const d = formatDate(item.postDate);
    if (d) parts.push(d);
  }
  const typeLabel = prettyMime(item.mime) || (item.ext || "").toUpperCase();
  if (typeLabel) parts.push(typeLabel);
  if (item.width && item.height) parts.push(`${item.width} × ${item.height}`);
  if (item.bytes) parts.push(formatBytes(item.bytes));
  return parts.join(" · ");
}

function setAllGallerySelected(checked) {
  document.querySelectorAll("#gallery-items .card-check").forEach((c) => {
    c.checked = checked;
  });
  updateGalleryCount();
}

function updateGalleryCount() {
  const selected = document.querySelectorAll("#gallery-items .card-check:checked").length;
  el("gallery-download-count").textContent = String(selected);
  // Don't re-enable while a download is still running — activeJobId lingers
  // until done/error. No active job means we're free to start a new one.
  el("gallery-download").disabled = selected === 0 || activeJobId !== null;
}

function selectedGalleryItems() {
  const out = [];
  document.querySelectorAll("#gallery-items .card-check:checked").forEach((c) => {
    const idx = parseInt(c.dataset.idx, 10);
    const item = galleryState?.items?.[idx];
    if (!item) return;
    const row = c.closest(".media-card");
    const kSel = row?.querySelector(".gallery-item-kind");
    const qSel = row?.querySelector(".gallery-item-quality");
    const fSel = row?.querySelector(".gallery-item-filename");
    const fCustom = row?.querySelector(".gallery-item-filename-custom");
    const kind = kSel?.value || "combined";
    const maxHeight = qSel ? (parseInt(qSel.value, 10) || 0) : 0;
    const filenameMode = fSel?.value || "uploader-title";
    // Only read the custom input when the mode is actually "setEach" —
    // stale text from earlier mode toggles is ignored.
    const customName = filenameMode === "setEach"
      ? (fCustom?.value || "").trim()
      : "";
    out.push({ item, maxHeight, kind, filenameMode, customName });
  });
  return out;
}

async function fetchGalleryItemSizes(items) {
  await Promise.all(items.map(async (item, idx) => {
    if (item.bytes) return;
    try {
      const resp = await fetch(item.url, { method: "HEAD", credentials: "omit" });
      if (!resp.ok) return;
      const len = resp.headers.get("Content-Length");
      if (!len) return;
      item.bytes = parseInt(len, 10);
      const row = document.querySelector(`#gallery-items .media-card[data-idx="${idx}"]`);
      const meta = row?.querySelector(".card-meta");
      if (meta) meta.textContent = galleryItemMetaText(item);
    } catch {}
  }));
}

async function startGalleryDownload() {
  if (!galleryState || galleryState.kind !== "gallery") return;
  const selected = selectedGalleryItems();
  if (selected.length === 0) return;

  // Capture-list galleries (post-grab button) hold Facebook permalinks,
  // not direct media URLs. Each item gets its own single-URL yt-dlp
  // invocation; fan them out sequentially so the host doesn't spawn
  // N concurrent yt-dlp processes. Only the FIRST job becomes the
  // activeJobId the popup tracks inline; the rest queue via the
  // background's jobs map and complete on their own.
  if (galleryState.isCaptureList) {
    await startCaptureListDownload(selected);
    return;
  }

  // Remember the *majority* filename mode the user picked so the default
  // in the next gallery session matches. Not load-bearing — per-item
  // selects always win at download time.
  const modeCounts = {};
  for (const s of selected) modeCounts[s.filenameMode] = (modeCounts[s.filenameMode] || 0) + 1;
  const dominantMode = Object.entries(modeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "uploader-title";
  await persistSetting("filenameMode", dominantMode);

  // Single-item selection: route through the single-file downloadUrl path
  // so the file lands directly in the chosen folder (no album subfolder,
  // no "01.ext" sequential name). The item's own filenameMode still picks
  // between title-based, original basename, or a Save As dialog.
  if (selected.length === 1) {
    const { item, maxHeight, kind, filenameMode } = selected[0];
    await startGallerySingleItem(item, filenameMode, maxHeight, kind, selected[0].customName);
    return;
  }

  // Galleries derive the handle from the post (galleryState.handle) when
  // set; Twitter galleries instead stash it per-item, so fall through to
  // the first selected item's handle so the uploader-title mode still has
  // something to work with.
  const handle = normalizeHandle(galleryState.handle || selected[0]?.item?.handle || "");
  const albumName = pickAlbumName(handle);
  const total = selected.length;
  // Pad exactly to the number of digits in `total` so every index in a
  // given batch stays the same width.
  const digits = String(total).length;

  const msg = {
    cmd: "downloadGallery",
    jobId: crypto.randomUUID(),
    pageUrl: tabUrl,
    items: selected.map(({ item, maxHeight, kind, filenameMode, customName }, idx) => {
      // When the user picks Kind=audio for a video item the final file
      // ends up as .m4a. Tell the host the right extension up front so
      // the pre-baked filename matches what actually gets written.
      const effectiveExt = kind === "audio" ? "m4a" : item.ext;
      const itemForName = kind === "audio" ? { ...item, ext: "m4a" } : item;
      return {
        url: pickVariantUrl(item, maxHeight),
        ext: effectiveExt,
        name: buildGalleryItemName(itemForName, idx, total, digits, filenameMode, handle, customName),
        kind: kind || "combined",
      };
    }),
  };

  if (!saveSettings.downloadAutomatically) {
    // Prompt per item — OS Save As dialog for each file.
    msg.askPerItem = true;
    msg.startDir = saveSettings.destinationDir || saveSettings.lastDir || saveSettings.specificDestDir || "";
  } else {
    msg.destDir = saveSettings.destinationDir || "";
    msg.albumName = albumName;
  }

  activeJobId = msg.jobId;
  clearInlineStatus();
  disableActivePrimary();
  port.postMessage(msg);
  inlineRenderRunning({ percent: 0 });
}

// startCaptureListDownload fans a capture-list gallery (per-post grab
// button) into N single-URL yt-dlp invocations, one per selected
// permalink. The background's jobs map tracks each independently; the
// popup shows the FIRST as its inline status, and subsequent jobs run
// silently and finish on their own. Captures are cleared after firing
// so the next popup open doesn't resurface posts the user already
// acted on.
async function startCaptureListDownload(selected) {
  if (selected.length === 0) return;
  const handle = normalizeHandle(selected[0]?.item?.handle || "");
  const albumName = pickAlbumName(handle) || "";
  let firstJobId = null;
  for (const { item, maxHeight, kind, filenameMode, customName } of selected) {
    // Text-only captures (from text-only tweets) bypass yt-dlp —
    // there's no media to extract, only the tweet's body content,
    // which we save directly via chrome.downloads as a .txt file.
    if (item.viaTextDownload) {
      await downloadTextCapture(item, filenameMode, customName);
      continue;
    }
    const jobId = crypto.randomUUID();
    if (!firstJobId) firstJobId = jobId;
    const typed = (customName || "").trim();

    // Captures are POST PERMALINKS (e.g. /photo/?fbid=123,
    // /status/123, /p/XYZ) — not direct media CDN URLs. Route them
    // through the yt-dlp path so the extractor resolves the actual
    // media + picks the correct extension (jpg for photos, mp4 for
    // videos). The old downloadUrl path did a plain HTTP GET, which
    // for an FB permalink returned the HTML page source — writing a
    // 400KB .html blob to the user's chosen filename. cmd:"download"
    // fixes that by handing the URL off to yt-dlp on the host side.
    const effectiveExt = kind === "audio" ? "m4a" : (item.ext || "mp4");
    const defaultBase = buildCaptureDefaultBase(item, typed, filenameMode);

    // Image and other direct-downloadable captures skip yt-dlp.
    // Reasons this matters per site:
    //   - Facebook: no photo extractor at all, so yt-dlp returns
    //     "Unsupported URL" on /photo/?fbid=. Direct download only.
    //   - Twitter/Instagram: item.url is already the pbs.twimg.com /
    //     scontent.cdninstagram.com image URL from the grab button,
    //     so routing through yt-dlp is pure waste (spawn, extractor
    //     run, redirect, same final URL we already had).
    //   - Reddit photos: same pattern as Twitter — direct i.redd.it
    //     URL in item.url.
    // pickDirectMediaUrl picks the best available: item.url when it
    // points at a media file directly, else thumbUrl.
    const isImage = typeof item.mime === "string" && item.mime.startsWith("image/");
    const directUrl = pickDirectMediaUrl(item);
    // Only set filename hints when we actually have a base. Empty
    // base (no handle AND no title) means "let the downloader derive
    // the name from the URL" — yt-dlp uses its default template, the
    // direct-download path falls back to the URL's basename.
    const safeFileName = defaultBase ? buildSafeFilename(defaultBase, effectiveExt) : "";
    if (isImage && directUrl) {
      const imgMsg = {
        cmd: "downloadUrl",
        jobId,
        url: directUrl,
        pageUrl: item.url,
        kind: "combined",     // plain HTTP GET path; kind unused for images
      };
      if (!saveSettings.downloadAutomatically) {
        imgMsg.askPath = true;
        if (safeFileName) imgMsg.defaultFileName = safeFileName;
        imgMsg.startDir = saveSettings.destinationDir || saveSettings.lastDir || saveSettings.specificDestDir || "";
        imgMsg.dialogTitle = "Save as…";
      } else {
        imgMsg.destDir = saveSettings.destinationDir || "";
        // Auto-download requires a filename. Prefer title/handle-based,
        // then fall back to the URL's own basename. Never inject a
        // placeholder like "download.mp4".
        let fname = safeFileName;
        if (!fname) {
          const urlBase = basenameFromUrl(directUrl).replace(/\.[^.]+$/, "");
          if (urlBase) fname = buildSafeFilename(urlBase, effectiveExt);
        }
        if (fname) imgMsg.defaultFileName = fname;
        if (albumName) imgMsg.albumName = albumName;
      }
      port.postMessage(imgMsg);
      continue;
    }

    // Video captures: yt-dlp extractor handles Facebook videos /
    // reels / watch URLs. Canonicalize to the shape yt-dlp accepts
    // (/photo/ → /photo.php, strip __cft__ tracking).
    const ytdlpUrl = canonicalizeFacebookUrlForYtdlp(item.url);
    const msg = {
      cmd: "download",
      jobId,
      url: ytdlpUrl,
      selection: { kind: kind || "combined", height: maxHeight || 0 },
      useCookies: true,  // captures come from FB/Twitter/IG, all need auth
    };
    if (!saveSettings.downloadAutomatically) {
      msg.askPath = true;
      if (safeFileName) msg.defaultFileName = safeFileName;
      msg.startDir = saveSettings.destinationDir || saveSettings.lastDir || saveSettings.specificDestDir || "";
      msg.dialogTitle = "Save as…";
    } else {
      msg.destDir = saveSettings.destinationDir || "";
      if (defaultBase) {
        const baseNoExt = buildSafeFilename(defaultBase, "__EXT__").replace(/\.__EXT__$/, "");
        if (baseNoExt) msg.filenameTemplate = ytdlpEscapeTemplate(baseNoExt) + ".%(ext)s";
      }
      if (albumName) msg.albumName = albumName;
    }
    port.postMessage(msg);
  }
  activeJobId = firstJobId;
  clearInlineStatus();
  disableActivePrimary();
  inlineRenderRunning({ percent: 0 });
  // Clear the capture list so re-opening the popup doesn't resurface
  // already-queued posts. Fire-and-forget — the popup doesn't need to
  // block on this.
  clearCaptures().catch(() => {});
}

// pickDirectMediaUrl: return the best direct-download URL for a
// capture item, or "" if none is usable (forces yt-dlp fallback).
//
// Precedence:
//   1. item.mediaUrl (explicit, set by any grab button that wants to
//      override the heuristics — reserved for future use).
//   2. item.url when it looks like a direct media URL (extension-
//      based heuristic: jpg/png/gif/webp/mp4/webm/mov). This is the
//      Twitter / Instagram / Reddit shape — their grab buttons put
//      the CDN URL directly into item.url.
//   3. item.thumbUrl when it's an http(s) URL. This is the Facebook
//      legacy-capture shape built in buildGalleryFromCaptures —
//      item.url holds the permalink and the CDN URL is in thumbUrl.
function pickDirectMediaUrl(item) {
  if (!item) return "";
  if (typeof item.mediaUrl === "string" && /^https?:\/\//.test(item.mediaUrl)) {
    return item.mediaUrl;
  }
  if (typeof item.url === "string" && /^https?:\/\//.test(item.url)) {
    const path = item.url.split("?")[0].split("#")[0];
    if (/\.(jpe?g|png|gif|webp|mp4|webm|mov|m4a|mp3)$/i.test(path)) return item.url;
  }
  if (typeof item.thumbUrl === "string" && /^https?:\/\//.test(item.thumbUrl)) {
    return item.thumbUrl;
  }
  return "";
}

// buildCaptureDefaultBase: derive a filename stem for a capture item.
// Precedence:
//   "setEach" + typed → the user's explicit input
//   otherwise         → "@handle - title" (falling back as either part
//                        is missing).
// Returns "" when neither handle nor title is known; the caller skips
// the filename hint so the downloader picks a sensible default instead
// of writing "post.mp4" onto disk.
function buildCaptureDefaultBase(item, typed, filenameMode) {
  if (filenameMode === "setEach" && typed) return typed;
  const handle = normalizeHandle(item.handle || "");
  const title = (item.capturedTitle || "").replace(/\s+/g, " ").trim();
  if (handle && title) return `${handle} - ${title}`.slice(0, 150);
  if (handle) return handle;
  if (title) return title.slice(0, 150);
  return "";
}

// Save a text-only capture (e.g. a text tweet) to disk. Uses
// chrome.downloads with a blob URL so the file hits disk without
// going through the native host. Filename follows the same "setEach
// wins, else uploader-title, else title" rules the media downloads
// use, but always with a .txt extension.
async function downloadTextCapture(item, filenameMode, customName = "") {
  const body = item.content || item.capturedTitle || item.basename || "";
  // Always include the source permalink as the first line for
  // provenance; useful when the tweet text alone wouldn't
  // disambiguate the file.
  const payload = item.url ? `${item.url}\n\n${body}` : body;
  const handle = normalizeHandle(item.handle || "");
  const typed = (customName || "").trim();
  let fileName;
  if (filenameMode === "setEach" && typed) {
    fileName = buildSafeFilename(typed, "txt");
  } else if (filenameMode === "original") {
    fileName = sanitizeLooseFilename((item.basename || "tweet") + ".txt");
  } else if (filenameMode === "uploader-title" && handle) {
    fileName = buildSafeFilename(`${handle} - ${item.basename || "tweet"}`, "txt");
  } else {
    fileName = buildSafeFilename(item.basename || "tweet", "txt");
  }
  try {
    const blob = new Blob([payload], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    await chrome.downloads.download({
      url,
      filename: fileName,
      saveAs: !saveSettings.downloadAutomatically,
    });
    // Revoke after the download starts — Chrome's downloads API
    // holds the blob internally once it begins writing.
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch {} }, 60_000);
  } catch (err) {
    dlog("text download failed", err?.message || err);
  }
}

// startGallerySingleItem runs the single-file download path (downloadUrl)
// for a gallery with exactly one item selected. Same saveMode rules as the
// image picker; filename follows the gallery's mode (sequential → title
// with ext, original → URL basename, setEach → Save As).
async function startGallerySingleItem(item, filenameMode, maxHeight, kind, customName = "") {
  // Audio-only ends up as .m4a regardless of the source container.
  const rawExt = item.ext || extensionFromUrl(item.url) || "jpg";
  const ext = kind === "audio" ? "m4a" : rawExt;
  const handle = normalizeHandle(galleryState.handle || item?.handle || "");
  const typed = (customName || "").trim();
  let fileName;
  if (filenameMode === "setEach" && typed) {
    fileName = buildSafeFilename(typed, ext);
  } else if (filenameMode === "original") {
    fileName = sanitizeLooseFilename(
      kind === "audio"
        ? item.basename.replace(/\.[^.]+$/, "") + ".m4a"
        : item.basename
    );
  } else if (filenameMode === "uploader-title" && handle) {
    fileName = buildSafeFilename(`${handle} - ${galleryState.title}`, ext);
  } else {
    fileName = buildSafeFilename(galleryState.title, ext);
  }

  const msg = {
    cmd: "downloadUrl",
    jobId: crypto.randomUUID(),
    url: pickVariantUrl(item, maxHeight || 0),
    pageUrl: tabUrl,
    defaultFileName: fileName,
    kind: kind || "combined",
  };
  if (!saveSettings.downloadAutomatically) {
    msg.askPath = true;
    msg.startDir = saveSettings.destinationDir || saveSettings.lastDir || saveSettings.specificDestDir || "";
    msg.dialogTitle = "Save as…";
  } else {
    msg.destDir = saveSettings.destinationDir || "";
    const album = currentAlbumName(handle);
    if (album) msg.albumName = album;
  }

  activeJobId = msg.jobId;
  clearInlineStatus();
  disableActivePrimary();
  port.postMessage(msg);
  inlineRenderRunning({ percent: 0 });
}

// persistSetting writes a single key into chrome.storage.local.settings if
// the value changed. Keeps the popup's in-memory mirror in sync.
async function persistSetting(key, value) {
  if (saveSettings[key] === value) return;
  saveSettings[key] = value;
  const { settings = {} } = await chrome.storage.local.get("settings");
  settings[key] = value;
  await chrome.storage.local.set({ settings });
}

// ---------------------------------------------------------------------------
// Filename sanitizers
// ---------------------------------------------------------------------------
//
// WIN_RESERVED, buildSafeFilename, sanitizeLooseFilename, normalizeHandle,
// and pickHandleText now live in shared.js so options.js + tests can
// reuse them. Folder-naming and the few remaining popup-specific
// builders stay here.

function guessDefaultName(title, kind, fnMode) {
  const ext = kind === "audio" ? "m4a" : "mp4";
  const handle = pickHandleText(currentUploaderId, currentUploader);
  if ((fnMode === "uploader-title" || fnMode === "set") && handle) {
    return buildSafeFilename(`${handle} - ${title}`, ext);
  }
  return buildSafeFilename(title, ext);
}

function selectedVideoFilenameMode() {
  return el("video-filename-mode")?.value ?? "uploader-title";
}

// ytdlpEscapeTemplate escapes the one character yt-dlp's output template
// language treats as special (%) so free-form user input ends up as a
// literal filename. "My 50%" becomes "My 50%%" which yt-dlp emits as
// "My 50%".
function ytdlpEscapeTemplate(s) {
  return String(s).replace(/%/g, "%%");
}

// prettifyYtdlpError turns the raw host message (shape is now
// "ERROR: <yt-dlp text> (exit status N)" — see host/cmd/frixtyhost/
// download.go :: formatDownloadErr) into a human-friendly sentence.
// Recognizes a few common yt-dlp failure modes and rewrites them;
// for anything else, returns the raw yt-dlp ERROR line trimmed of
// the "ERROR:" prefix and the trailing exit-status noise.
// prettifyYtdlpError + friendlyError + ageRestrictedError +
// detectCurrentSite all moved to popup-errors.js (imported above).
// Pass errorContext() at every call site so the module stays pure.

// buildGalleryItemName produces a per-item filename for the gallery
// "title" and "uploader-title" modes. For sequential we return "" so
// the host falls back to numbered items; "original" uses the URL
// basename; "setEach" reads the inline text input (plus the standard
// index suffix when multiple items share the same typed name).
function buildGalleryItemName(item, idx, total, digits, filenameMode, handle, customName = "") {
  const ext = item.ext || "jpg";
  if (filenameMode === "original") {
    return sanitizeLooseFilename(item.basename);
  }
  if (filenameMode === "setEach") {
    const typed = (customName || "").trim();
    if (!typed) return ""; // empty input → let host number this item
    // The index is baked into the pre-filled text (seedCustom) so the
    // user sees the final name in the input. Don't also append it here
    // or we'd end up with " 01 01" when the user leaves the default.
    return buildSafeFilename(typed, ext);
  }
  if (filenameMode === "title" || filenameMode === "uploader-title") {
    const prefix = (filenameMode === "uploader-title" && handle)
      ? `${handle} - ${galleryState.title}`
      : galleryState.title;
    // Pass the index as a suffix so long titles get clipped without
    // eating the " NN" — the index is what guarantees uniqueness inside
    // the gallery, so it must survive truncation.
    if (total > 1) {
      const suffix = " " + String(idx + 1).padStart(digits, "0");
      return buildSafeFilename(prefix, ext, suffix);
    }
    return buildSafeFilename(prefix, ext);
  }
  return ""; // sequential → host-default per-item numbering
}

// videoFilenameTemplate maps the UI choice to a yt-dlp -o template string.
// Used only for direct-save paths (when we don't open Save As) — the Save
// As path builds the default name in JS via guessDefaultName so we don't
// have to keep identical logic in two places.
//
// uploader_id is YouTube's "@handle" (already includes the @); on sites
// without uploader_id we fall through to the display name. No "@" is
// prepended by yt-dlp — if a site's uploader field lacks it, the file name
// just lacks it too rather than mixing two different conventions.
function videoFilenameTemplate(fnMode) {
  if (fnMode !== "uploader-title") return "%(title)s.%(ext)s";
  // When the current listing returned a purely-numeric uploader_id
  // (Facebook), the yt-dlp template should prefer the human display
  // name. For sites where uploader_id is a proper handle (@channel on
  // YouTube, username on Twitter), uploader_id wins and uploader is
  // the fallback.
  const id = currentUploaderId || "";
  if (id && /^\d+$/.test(id)) {
    return "%(uploader,uploader_id|unknown)s - %(title)s.%(ext)s";
  }
  return "%(uploader_id,uploader|unknown)s - %(title)s.%(ext)s";
}

// buildSafeFolderName sanitizes `base` into something every major
// filesystem accepts as a folder name:
//   - replaces the reserved / platform-special chars with "_"
//   - strips control characters and zero-width marks
//   - collapses whitespace runs to a single space
//   - strips leading dots (hidden on Unix; also invalid on some cloud
//     sync tools) and leading / trailing whitespace
//   - trims trailing "." / " " which Windows silently drops
//   - collapses consecutive "_" runs that the replacements created
//   - rejects the Windows-reserved device names (CON/PRN/…) by
//     prepending an underscore
//   - clips to 150 chars so a deeply-nested destination path doesn't
//     overrun the filesystem's max path length
function buildSafeFolderName(base) {
  let safe = String(base ?? "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .replace(/[. ]+$/, "")
    .replace(/_{2,}/g, "_")
    .trim();
  if (safe.length > 150) safe = safe.slice(0, 150).replace(/[. ]+$/, "");
  // Empty in → empty out. Callers decide whether to fall back to a
  // default name or skip the folder entirely. A blanket "gallery"
  // fallback leaked placeholder folder names into the user's file
  // system when title and handle were both unknown.
  if (!safe) return "";
  if (WIN_RESERVED.test(safe)) safe = "_" + safe;
  return safe;
}

// ---------------------------------------------------------------------------
// Running / terminal UI
// ---------------------------------------------------------------------------

function showRunning(progress) {
  show("running");
  hide("loading");
  el("cancel").onclick = cancelDownload;
  if (progress) renderProgress(progress);
}

// --------- inline status rendering (picker stays visible) ------------------

function inlineRenderRunning(p) {
  const e = activePickerStatusEl();
  if (!e) return;
  const pct = Math.max(0, Math.min(100, p.percent ?? 0));
  e.hidden = false;
  e.className = "inline-status running";
  e.innerHTML = `
    <div class="status-head">Downloading…</div>
    <div class="progress"><div class="bar" style="width:${pct.toFixed(1)}%"></div></div>
    <div class="stats">
      <span>${pct.toFixed(1)}%</span>
      <span>${p.speed ? formatBytes(p.speed) + "/s" : "—"}</span>
      <span>${p.eta ? "ETA " + formatEta(p.eta) : "—"}</span>
    </div>
    ${p.stage ? `<div class="stats"><span>${escapeHtml(p.stage)}</span></div>` : ""}
    <div class="actions"><button class="danger" id="inline-cancel">Cancel</button></div>
  `;
  const cancelBtn = document.getElementById("inline-cancel");
  if (cancelBtn) cancelBtn.onclick = cancelDownload;
}

function inlineRenderDone(msg) {
  const e = activePickerStatusEl();
  if (!e) return;
  e.hidden = false;
  e.className = "inline-status done";
  e.innerHTML = `
    <button class="close" aria-label="Dismiss" title="Dismiss">×</button>
    <div class="status-head">✓ Saved</div>
    ${msg.path ? `<div class="path">${escapeHtml(msg.path)}</div>` : ""}
    ${msg.path ? `<div class="actions"><button class="inline-open">Open folder</button></div>` : ""}
  `;
  // Scope the lookup to the status element that just got its innerHTML
  // replaced. document.getElementById would return the first matching
  // node in document order — if an earlier picker's hidden status still
  // holds a stale button with the same id, the onclick wire-up lands on
  // that hidden node and the visible button has no handler.
  const openBtn = e.querySelector(".inline-open");
  if (openBtn && msg.path) {
    openBtn.onclick = (ev) => {
      try { ev.preventDefault(); ev.stopPropagation(); } catch {}
      dlog("Open folder clicked", { path: msg.path });
      // Use runtime.sendMessage so the SW is woken even if the popup's
      // persistent port has been torn down (long-running downloads can
      // let the SW idle-shut-down between done and click). The SW still
      // has a port-cmd handler as a fallback path. bgRequest's timeout
      // also covers the case where the SW accepts the message and dies
      // before responding — without it, we'd never reach the fallback.
      bgRequest({ type: "revealInFileManager", path: msg.path }).then(
        (resp) => dlog("Open folder sendMessage ok", resp),
        (err) => {
          dlog("Open folder sendMessage err", err.message);
          try { port.postMessage({ cmd: "revealInFileManager", path: msg.path }); } catch {}
        },
      );
    };
  }
  const closeBtn = e.querySelector(".close");
  if (closeBtn) closeBtn.onclick = () => { e.hidden = true; e.innerHTML = ""; };
  reEnablePrimary();
  // The job finished; clear activeJobId so late progress events from a new
  // download don't get confused with the old one's tail.
  activeJobId = null;
}

function inlineRenderError(msg) {
  const e = activePickerStatusEl();
  if (!e) return;
  const friendly = friendlyError(msg, errorContext());
  e.hidden = false;
  e.className = friendly.severity === "info" ? "inline-status info" : "inline-status err";
  e.innerHTML = `
    <button class="close" aria-label="Dismiss" title="Dismiss">×</button>
    <div class="status-head">${friendly.severity === "info" ? "" : "✗ "}${escapeHtml(friendly.title)}</div>
    ${friendly.detail ? `<div class="detail">${escapeHtml(friendly.detail)}</div>` : ""}
  `;
  const closeBtn = e.querySelector(".close");
  if (closeBtn) closeBtn.onclick = () => { e.hidden = true; e.innerHTML = ""; };
  reEnablePrimary();
  activeJobId = null;
}

function clearInlineStatus() {
  for (const id of ["video-status", "image-status", "gallery-status"]) {
    const e = el(id);
    if (e) {
      e.hidden = true;
      e.innerHTML = "";
      e.className = "inline-status";
    }
  }
}

function disableActivePrimary() {
  if (!el("picker").hidden) el("download").disabled = true;
  if (!el("image-picker").hidden) el("image-download").disabled = true;
  if (!el("gallery-picker").hidden) el("gallery-download").disabled = true;
}

function reEnablePrimary() {
  if (!el("picker").hidden) el("download").disabled = false;
  if (!el("image-picker").hidden) el("image-download").disabled = false;
  // Gallery button re-enables only if something's still selected.
  if (!el("gallery-picker").hidden) updateGalleryCount();
}

function renderProgress(p) {
  const pct = Math.max(0, Math.min(100, p.percent ?? 0));
  el("bar").style.width = `${pct}%`;
  el("percent").textContent = `${pct.toFixed(1)}%`;
  el("speed").textContent = p.speed ? `${formatBytes(p.speed)}/s` : "—";
  el("eta").textContent = p.eta ? `ETA ${formatEta(p.eta)}` : "—";
  el("stage").textContent = p.stage ?? "download";
}

function cancelDownload() {
  if (!activeJobId) return;
  port.postMessage({ cmd: "cancel", jobId: activeJobId });
}

function renderDone(msg) {
  hide("running");
  hide("picker");
  hide("image-picker");
  hide("gallery-picker");
  hide("loading");
  show("terminal");
  const s = el("status-line");
  s.textContent = "✓ Saved";
  s.className = "status ok";
  el("result-path").textContent = msg.path || "";
  el("result-err").hidden = true;
  el("reset").onclick = reset;
  el("reset").textContent = "Download another";

  const open = el("open-folder");
  if (msg.path) {
    open.hidden = false;
    open.onclick = () => port.postMessage({ cmd: "revealInFileManager", path: msg.path });
  } else {
    open.hidden = true;
  }
}

function handleCanceled() {
  if (activeJobId) {
    port.postMessage({ cmd: "forget", jobId: activeJobId });
    activeJobId = null;
  }
  // In-session inline flow: picker is already visible. Reset its inline
  // status block and re-enable the primary button.
  if (activePickerStatusEl()) {
    clearInlineStatus();
    reEnablePrimary();
    return;
  }
  // Legacy snapshot-restore flow (no picker, full-screen running/terminal).
  hide("running");
  hide("terminal");
  if (galleryState && galleryState.kind === "image") {
    show("image-picker");
  } else if (galleryState && galleryState.kind === "gallery") {
    show("gallery-picker");
  } else if (currentFormats) {
    show("picker");
  } else {
    show("loading");
    requestListFormats();
  }
}

function renderError(msg) {
  const friendly = friendlyError(msg, errorContext());

  hide("running");
  hide("picker");
  hide("image-picker");
  hide("gallery-picker");
  hide("loading");
  show("terminal");

  const s = el("status-line");
  if (friendly.severity === "info") {
    s.textContent = friendly.title;
    s.className = "status info";
  } else {
    s.textContent = `✗ ${friendly.title}`;
    s.className = "status err";
  }

  el("result-path").textContent = "";
  const e = el("result-err");
  if (friendly.detail) {
    e.hidden = false;
    e.textContent = friendly.detail;
    e.className = friendly.severity === "info" ? "err-text info" : "err-text";
  } else {
    e.hidden = true;
  }
  el("open-folder").hidden = true;
  el("reset").onclick = reset;
  el("reset").textContent = friendly.severity === "info" ? "Try again" : "Download another";
}

function reset() {
  if (activeJobId) {
    port.postMessage({ cmd: "forget", jobId: activeJobId });
    activeJobId = null;
  }
  hide("terminal");
  if (galleryState && galleryState.kind === "image") {
    show("image-picker");
    return;
  }
  if (galleryState && galleryState.kind === "gallery") {
    show("gallery-picker");
    return;
  }
  show("loading");
  requestListFormats();
}

// ---------------------------------------------------------------------------
// Shared formatters
// ---------------------------------------------------------------------------

function formatBytes(b) {
  if (b < 1024) return `${b.toFixed(0)} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatEta(s) {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function formatDuration(s) {
  const total = Math.round(s);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

init();
