// Service worker owns the native messaging port and tracks running jobs.
// Putting this here (not in the popup) means a download survives the popup
// being closed — Chrome keeps the worker alive while the native port is open.

import { shortcodeToMediaId, computeSyndicationToken, IG_APP_ID } from "./shared.js";
import { getFacebookStoryFromInterceptor, getFacebookDomInfo } from "./facebook.js";
import {
  captureKey,
  isCacheable,
  sectionOf,
  topLevelSiteFor,
  siteCookieDomains,
  formatNetscapeCookie,
  buildTtRelayMessage,
} from "./background-helpers.js";
import { logFetcher } from "./fetcher-log.js";

const HOST_NAME = "com.frixty.fetcher";
const CACHE_TTL_MS = 10 * 60 * 1000;

// dlog tags SW-side trace lines so they stand apart from popup traces in a
// shared console filter. Progress events are downsampled to keep the log
// readable when a long download is running.
function dlog(step, ...args) {
  console.log("[frixty/sw]", step, ...args);
}
let lastLoggedPct = -10;

let hostPort = null;
const jobs = new Map(); // jobId -> { url, selection, status, progress, path, error }
const popupPorts = new Set(); // all currently-open popup connections
const pendingRequests = new Map(); // reqId -> { port, cacheKey? }
// Maps TikTok grab-button-initiated jobs to the tab whose content
// script should receive progress/done/error updates. Populated by
// the tiktok:fetch-and-download handler; cleared on terminal events.
const ttJobTabs = new Map(); // jobId -> tabId

function ensureHostPort() {
  if (hostPort) return hostPort;
  dlog("connectNative", HOST_NAME);
  hostPort = chrome.runtime.connectNative(HOST_NAME);
  hostPort.onMessage.addListener(onHostMessage);
  hostPort.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError;
    dlog("host disconnected", { error: err?.message });
    // Fail every in-flight job and pending request so popups aren't stuck.
    for (const [id, j] of jobs) {
      if (j.status === "running") {
        j.status = "error";
        j.error = err?.message ?? "native host disconnected";
        broadcast({ type: "error", jobId: id, code: "host_disconnected", message: j.error });
      }
    }
    for (const [reqId, entry] of pendingRequests) {
      try {
        entry.port.postMessage({
          type: "error",
          reqId,
          code: "host_disconnected",
          message: err?.message ?? "native host disconnected",
        });
      } catch {}
    }
    pendingRequests.clear();
    hostPort = null;
  });
  return hostPort;
}

async function onHostMessage(msg) {
  if (msg.type === "progress") {
    const pct = Math.floor((msg.percent ?? 0) / 10);
    if (pct !== lastLoggedPct) {
      dlog("host -> progress", {
        jobId: msg.jobId,
        percent: msg.percent,
        stage: msg.stage,
        speed: msg.speed,
      });
      lastLoggedPct = pct;
    }
  } else {
    dlog("host ->", msg.type, {
      jobId: msg.jobId,
      reqId: msg.reqId,
      code: msg.code,
      path: msg.path,
    });
  }

  // 1. Job-scoped events: fold into jobs map, broadcast to all popups so any
  //    popup watching this job (even one that just opened) sees the update.
  if (msg.jobId && jobs.has(msg.jobId)) {
    const j = jobs.get(msg.jobId);
    if (msg.type === "progress") {
      j.status = "running";
      j.progress = msg;
    } else if (msg.type === "done") {
      j.status = "done";
      j.path = msg.path;
    } else if (msg.type === "error") {
      if (msg.code === "destdir_canceled") {
        // User dismissed the Save As dialog — treat as a no-op, not a job
        // failure. Forget the job so a popup reopen doesn't resurrect it.
        jobs.delete(msg.jobId);
      } else {
        j.status = "error";
        j.error = msg.message;
      }
    } else if (msg.type === "pathPicked" && msg.path) {
      persistLastDir(msg.path);
    }
    // Content-script-initiated jobs (TikTok grab button) also want the
    // progress / done / error updates routed back to the originating
    // tab so the button can show a spinner and finish cleanly.
    if (ttJobTabs.has(msg.jobId)) {
      const tabId = ttJobTabs.get(msg.jobId);
      relayTtJobMessage(tabId, msg);
      if (msg.type === "done" || msg.type === "error") {
        ttJobTabs.delete(msg.jobId);
      }
    }
    broadcast(msg);
    return;
  }

  // 2. Broadcast events that aren't tied to a single request: updateProgress
  //    streams from the self-update download. Any open options page that
  //    cares can render it; the final {type:"updated"} reply still goes via
  //    the reqId route below.
  if (msg.type === "updateProgress") {
    broadcast(msg);
    return;
  }

  // 3. Request-correlated responses (listFormats, version, etc.): route to
  //    the exact popup that asked. No FIFO, no broadcast fallback — a stale
  //    response for a closed popup is simply dropped. Responses with a
  //    cacheKey are saved in storage.session before forwarding.
  if (msg.reqId && pendingRequests.has(msg.reqId)) {
    const entry = pendingRequests.get(msg.reqId);
    pendingRequests.delete(msg.reqId);
    // Stamp request-bound context onto the relayed message so the popup
    // can read per-request state from the response itself rather than a
    // module-level variable. Without this, two listFormats calls in
    // flight (auto-retry path, button mash) would race and the second
    // response would clobber the first's effectiveUseCookies decision.
    let stamped = msg;
    if (entry.useCookies !== undefined) {
      stamped = { ...msg, useCookies: entry.useCookies };
    }
    if (entry.cacheKey && isCacheable(stamped)) {
      await cachePut(entry.cacheKey, stamped);
    }
    try {
      entry.port.postMessage(stamped);
    } catch {}
    return;
  }

  // 4. Everything else is unroutable — ignore.
}

function broadcast(msg) {
  // Drop any port that throws on postMessage — those are disconnected
  // ones whose onDisconnect handler hasn't run yet (or never ran due to
  // a Chrome bug), and keeping them in the set means broadcast becomes
  // O(stale) over an extension's session.
  let dead;
  for (const p of popupPorts) {
    try {
      p.postMessage(msg);
    } catch {
      (dead ??= []).push(p);
    }
  }
  if (dead) for (const p of dead) popupPorts.delete(p);
}

// relayTtJobMessage forwards a host-originated job event to the
// originating tab's content script for grab-button-initiated
// downloads. The content script listens on chrome.runtime.onMessage
// for these and updates the in-flight button's state (spinner
// percentage, ✓, error flash).
function relayTtJobMessage(tabId, msg) {
  const relay = buildTtRelayMessage(msg);
  if (!relay) return;
  try {
    chrome.tabs.sendMessage(tabId, relay).catch(() => {});
  } catch {}
}

// Decides whether the TikTok grab-button headless download should
// attach cookies on first attempt, using the user's saved per-site
// preference (options page). "always" is the default — TikTok
// videos are increasingly login-gated and cookies rarely hurt.
async function tiktokUseCookiesInitial() {
  try {
    const { settings = {} } = await chrome.storage.local.get("settings");
    const mode = settings.tiktokCookiesMode || "always";
    // "always" and "auto" both attach cookies on first attempt; only
    // "never" skips them outright. (The retry-on-anon-failure path
    // the popup uses doesn't exist for headless grabs — a single
    // attempt is all we get, so default to attaching.)
    return mode !== "never";
  } catch {
    return true;
  }
}

// Only successful responses go into the cache. Errors and non-results
// shouldn't stick around and mask a later successful attempt.
async function cacheGet(key) {
  try {
    const obj = await chrome.storage.session.get(key);
    const entry = obj[key];
    if (!entry || Date.now() - entry.at > CACHE_TTL_MS) return null;
    return entry.data;
  } catch {
    return null;
  }
}

async function cachePut(key, data) {
  try {
    await chrome.storage.session.set({ [key]: { at: Date.now(), data } });
  } catch {}
}

// readSiteCookiesText pulls the logged-in cookies for the given URL's site
// and formats them as a Netscape-style cookies.txt blob that the host can
// hand to yt-dlp via --cookies <file>.
//
// This replaces yt-dlp's --cookies-from-browser, which fails on Windows
// Chrome 127+ due to app-bound DPAPI. The chrome.cookies API is our
// privileged way to read the cookies the user is already using in this
// browser; host_permissions scopes what we can see to the three media
// sites we support.
//
// Chrome 124+ aggressively partitions third-party cookies (CHIPS / 3PCD).
// chrome.cookies.getAll without a partitionKey returns ONLY unpartitioned
// cookies — meaning sites that started using `Partitioned;` for their
// auth cookies would silently disappear from the export and yt-dlp would
// see "logged out". For each cookie domain we additionally pull the
// partition keyed by the URL's top-level site (the partition that would
// be sent on a top-level request to it) and de-dupe by cookie name with
// the partitioned copy winning on conflict (it's the one active in the
// current top-level context).
async function readSiteCookiesText(url) {
  const domains = siteCookieDomains(url);
  if (domains.length === 0) return "";
  const topLevelSite = topLevelSiteFor(url);
  const lines = [];
  const countsByDomain = {};
  for (const domain of domains) {
    const unpartitioned = await safeGetCookies({ domain }, domain);
    const partitioned = topLevelSite
      ? await safeGetCookies({ domain, partitionKey: { topLevelSite } }, domain)
      : [];
    // Cookie identity for de-duping is (name, path) per RFC 6265 — paths
    // matter when a site sets both /api/auth and /web/auth cookies under
    // the same name. Partitioned wins on a (name, path) collision.
    const merged = new Map();
    for (const c of unpartitioned) merged.set(`${c.name}\t${c.path || "/"}`, c);
    for (const c of partitioned) merged.set(`${c.name}\t${c.path || "/"}`, c);
    countsByDomain[domain] = {
      unpartitioned: unpartitioned.length,
      partitioned: partitioned.length,
      merged: merged.size,
    };
    for (const c of merged.values()) {
      lines.push(formatNetscapeCookie(c));
    }
  }
  dlog("cookies exported", { url, totalLines: lines.length, countsByDomain });
  if (lines.length === 0) return "";
  return "# Netscape HTTP Cookie File\n# Generated by Frixty Fetcher\n\n" + lines.join("\n") + "\n";
}

// safeGetCookies wraps chrome.cookies.getAll in try/catch and dlog. The
// partitionKey field is rejected as "Unrecognized arguments" on Chrome
// older than 119; treat that as "no partitioned cookies" rather than a
// hard failure so the unpartitioned export still goes through.
async function safeGetCookies(query, domainForLog) {
  try {
    return await chrome.cookies.getAll(query);
  } catch (err) {
    dlog("cookies.getAll error", {
      domain: domainForLog,
      partitioned: !!query.partitionKey,
      error: err?.message,
    });
    return [];
  }
}

// topLevelSiteFor returns the partitionKey.topLevelSite string for the
// URL the user is downloading from. The CookiePartitionKey spec defines
// it as "scheme://eTLD+1"; we approximate eTLD+1 with the URL's
// hostname, which is correct for every site siteCookieDomains() recognizes
// (twitter.com, x.com, youtube.com, instagram.com, facebook.com,
// tiktok.com, youtu.be) since none of them sit on a multi-level public
// suffix. If chrome.cookies later rejects the value, safeGetCookies
// catches it and falls back to unpartitioned-only.
// persistLastDir captures the folder the user most recently saved into so we
// can pre-open the dialog there next time, and so the "Save to last used
// location" setting has something to use.
async function persistLastDir(fullPath) {
  // Split on whichever separator the OS returned (Windows uses \, POSIX /).
  const sepIdx = Math.max(fullPath.lastIndexOf("\\"), fullPath.lastIndexOf("/"));
  if (sepIdx <= 0) return;
  const dir = fullPath.slice(0, sepIdx);
  const { settings = {} } = await chrome.storage.local.get("settings");
  if (settings.lastDir === dir) return;
  settings.lastDir = dir;
  await chrome.storage.local.set({ settings });
  // Let any open settings/popup pages refresh the displayed value.
  broadcast({ type: "settingsUpdated", settings });
}

// Per-tab capture list for the Facebook post-grab button. The content
// script posts `{type: "capture:add", payload}` each time the user
// clicks a post's grab button; we accumulate in chrome.storage.session
// (scoped by tabId) so the popup can read and present the collection
// as a gallery. Cleared when the tab is closed to avoid leaking old
// captures into new sessions at the same URL.
// One-shot migration for users upgrading from a build that stored the
// capture list under `fb:captures:<tabId>`. Runs on SW startup; copies
// any old-prefix entries under the new prefix and drops the old ones.
// chrome.storage.session is already tab-session-scoped so this only
// matters for the first popup open after reload, but leaving stale
// keys around would trip the next migration when more keys move.
(async function migrateCaptureKeysOnce() {
  try {
    const all = await chrome.storage.session.get(null);
    const renames = {};
    const drops = [];
    for (const k of Object.keys(all)) {
      if (!k.startsWith("fb:captures:")) continue;
      const newKey = k.replace(/^fb:captures:/, "capture:list:");
      if (all[newKey] == null) renames[newKey] = all[k];
      drops.push(k);
    }
    if (drops.length === 0) return;
    if (Object.keys(renames).length > 0) {
      await chrome.storage.session.set(renames);
    }
    await chrome.storage.session.remove(drops);
    dlog("capture-key migration", { migrated: Object.keys(renames).length, dropped: drops.length });
  } catch (err) {
    dlog("capture-key migration failed", err?.message || err);
  }
})();

async function appendCapture(tabId, payload) {
  const key = captureKey(tabId);
  const { [key]: existing = [] } = await chrome.storage.session.get(key);
  // Dedup on URL so rapid double-clicks don't create duplicates.
  if (existing.some((e) => e.url === payload.url)) {
    return { count: existing.length, added: false };
  }
  const next = [...existing, payload];
  await chrome.storage.session.set({ [key]: next });
  return { count: next.length, added: true };
}
async function getCaptures(tabId) {
  const key = captureKey(tabId);
  const { [key]: existing = [] } = await chrome.storage.session.get(key);
  return existing;
}
async function clearCaptures(tabId) {
  await chrome.storage.session.remove(captureKey(tabId));
}
async function removeCapture(tabId, url) {
  const key = captureKey(tabId);
  const { [key]: existing = [] } = await chrome.storage.session.get(key);
  const next = existing.filter((e) => e.url !== url);
  if (next.length === existing.length) return { count: existing.length, removed: false };
  if (next.length === 0) await chrome.storage.session.remove(key);
  else await chrome.storage.session.set({ [key]: next });
  return { count: next.length, removed: true };
}
// Batched remove. Filters ALL urls in one storage read+write so
// concurrent popup-side calls don't race (each individual capture:remove
// would read the same `existing` snapshot, filter out its one url,
// and write back — last-write-wins, N-1 of the removals get lost).
async function removeCapturesBatch(tabId, urls) {
  if (!urls || urls.length === 0) return { count: 0, removed: 0 };
  const key = captureKey(tabId);
  const { [key]: existing = [] } = await chrome.storage.session.get(key);
  const toRemove = new Set(urls);
  const next = existing.filter((e) => !toRemove.has(e.url));
  if (next.length === existing.length) return { count: existing.length, removed: 0 };
  if (next.length === 0) await chrome.storage.session.remove(key);
  else await chrome.storage.session.set({ [key]: next });
  return { count: next.length, removed: existing.length - next.length };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return false;
  if (msg.type === "capture:add") {
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, error: "no-tab" });
      return false;
    }
    // Best-effort popup reopen. Chrome's action popup dismisses on
    // click-away and subsequent openPopup() calls can fail if the
    // user-activation state has shifted — but the badge below is the
    // reliable fallback: the user sees the new capture count on the
    // action icon and can click to open manually.
    try {
      if (chrome.action?.openPopup) {
        chrome.action.openPopup().catch((e) => {
          dlog("openPopup failed", e?.message || e);
        });
      }
    } catch (e) {
      dlog("openPopup threw", e?.message || e);
    }
    appendCapture(tabId, msg.payload || {}).then((r) => {
      dlog("capture:add stored", {
        tabId,
        count: r.count,
        added: r.added,
        url: (msg.payload?.url || "").slice(0, 80),
      });
      // Always paint a badge too — this is a reliable fallback when
      // openPopup fails (popup just dismissed, activation consumed,
      // etc.). The user sees the capture count on the action icon
      // and knows to click it. Badge clears when the popup reads
      // the list.
      try {
        chrome.action.setBadgeText({ text: String(r.count || 0), tabId });
        chrome.action.setBadgeBackgroundColor({ color: "#1e90ff", tabId });
      } catch {}
      sendResponse({ ok: true, ...r });
    });
    return true; // async sendResponse
  }
  if (msg.type === "capture:list") {
    const tabId = msg.tabId ?? sender.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, error: "no-tab" });
      return false;
    }
    getCaptures(tabId).then((items) => {
      dlog("capture:list served", { tabId, count: items.length });
      // User has seen the list — clear the badge so it doesn't stay
      // sticky. Repaint by capture:add happens on the next grab.
      try {
        chrome.action.setBadgeText({ text: "", tabId });
      } catch {}
      sendResponse({ ok: true, items });
    });
    return true;
  }
  if (msg.type === "capture:clear") {
    const tabId = msg.tabId ?? sender.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, error: "no-tab" });
      return false;
    }
    clearCaptures(tabId).then(() => {
      try {
        chrome.action.setBadgeText({ text: "", tabId });
      } catch {}
      sendResponse({ ok: true });
    });
    return true;
  }
  if (msg.type === "yt:trigger-fetch") {
    // YouTube grab button: stamp a per-tab "auto-fetch pending" flag
    // in session storage, then try to open the popup. When the popup
    // inits it checks the flag for its tab and, if recent, invokes
    // runFetchFlow automatically — so the user gets the same video
    // / gallery picker the popup's own Fetch button produces. No
    // custom media discovery here; reusing the popup's path keeps
    // YouTube extractor drift contained to the yt-dlp side.
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, error: "no-tab" });
      return false;
    }
    const url = typeof msg.url === "string" ? msg.url : "";
    const currentTime =
      Number.isFinite(msg.currentTime) && msg.currentTime > 0 ? msg.currentTime : 0;
    const key = `frixty:auto-fetch:${tabId}`;
    chrome.storage.session
      .set({ [key]: { url, ts: Date.now(), currentTime } })
      .then(() => {
        try {
          chrome.action.openPopup?.().catch(() => {});
        } catch {}
        try {
          chrome.action.setBadgeText({ text: "▶", tabId });
          chrome.action.setBadgeBackgroundColor({ color: "#1e90ff", tabId });
        } catch {}
        dlog("yt:trigger-fetch", { tabId, url: url.slice(0, 120), currentTime });
        sendResponse({ ok: true });
      })
      .catch((err) => {
        dlog("yt:trigger-fetch store err", err?.message || err);
        sendResponse({ ok: false, error: String(err?.message || err) });
      });
    return true;
  }
  if (msg.type === "revealInFileManager") {
    // Popup's "Open folder" button routes here. Duplicates the port
    // path (handlePopupMessage case "revealInFileManager") but doesn't
    // depend on a live port — sendMessage wakes the SW and the host
    // stays alive long enough to fire the reveal.
    const path = typeof msg.path === "string" ? msg.path : "";
    if (!path) {
      sendResponse({ ok: false, error: "empty-path" });
      return false;
    }
    try {
      ensureHostPort().postMessage({ action: "revealInFileManager", path });
      dlog("revealInFileManager (runtime)", { path });
      sendResponse({ ok: true });
    } catch (err) {
      dlog("revealInFileManager err", err?.message || err);
      sendResponse({ ok: false, error: String(err?.message || err) });
    }
    return false;
  }
  if (msg.type === "debug:tt-grab-fail") {
    // Forwarded by tiktok-post-grab.js on any click-time failure
    // (no URL / sendMessage failed / SW refused). Echoing here makes
    // the diagnostic visible in the extension log users save (the
    // TikTok page console output doesn't land there).
    dlog("debug:tt-grab-fail", { stage: msg.stage || "?", diag: msg.diag || {} });
    return false;
  }
  if (msg.type === "debug:fb-mp-scan") {
    // Forwarded by facebook-post-grab.js whenever its marketplace
    // Pass 3 scan produces a new summary. Echoing it here ensures it
    // lands in the extension log users already know to save
    // (page-console output doesn't appear there).
    dlog("debug:fb-mp-scan", msg.diag || {});
    return false;
  }
  if (msg.type === "debug:fb-dateFor") {
    // Forwarded by the Facebook grab button when dateFor() can't
    // resolve a post timestamp. Echo the full diagnostic payload to
    // the SW console so the extension log (which users already know
    // to save) captures it without a separate page-console save.
    dlog("debug:fb-dateFor", msg.diag || {});
    return false;
  }
  if (msg.type === "tiktok:fetch-and-download") {
    // Content-script grab-button flow: start a headless download
    // directly from the SW, skipping the popup entirely. yt-dlp's
    // default format selection (kind: "combined", height: 0 → best
    // available mp4) gives us one-click-best-quality with no picker
    // UI. Progress/done/error events land in onHostMessage and get
    // relayed to the originating tab via chrome.tabs.sendMessage so
    // the grab button can render its own spinner + result state.
    const url = typeof msg.url === "string" ? msg.url : "";
    const tabId = sender.tab?.id;
    if (!url || !tabId) {
      sendResponse({ ok: false, error: "bad-args" });
      return false;
    }
    (async () => {
      const jobId = crypto.randomUUID();
      ttJobTabs.set(jobId, tabId);
      jobs.set(jobId, {
        url,
        kind: "tiktok-grab",
        status: "running",
        progress: null,
        path: null,
        error: null,
      });
      const useCookies = await tiktokUseCookiesInitial();
      const cookiesText = useCookies ? await readSiteCookiesText(url) : "";
      ensureHostPort().postMessage({
        action: "download",
        jobId,
        url,
        selection: { kind: "combined", height: 0 },
        destDir: "",
        askPath: false,
        defaultFileName: "",
        cookiesText,
        filenameTemplate: "%(uploader_id,uploader|unknown)s - %(title).80B.%(ext)s",
      });
      dlog("tiktok:fetch-and-download", { jobId, tabId, url: url.slice(0, 120), useCookies });
      sendResponse({ ok: true, jobId });
    })();
    return true;
  }
  if (msg.type === "fb:capture-this-page") {
    // Grab-button flow for pages that don't have one stable
    // per-post permalink (marketplace item viewer: the hero photo
    // isn't wrapped in an anchor pointing to the current listing).
    // Runs the same interceptor-mining pass the popup's "Fetch
    // media on this page" button uses, batches each resulting
    // photo/video as a capture, and nudges the popup so the user
    // sees their staged media immediately.
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, error: "no-tab" });
      return false;
    }
    (async () => {
      try {
        // Interceptor first — it has the richest data (listing id,
        // author, graphql-sourced titles). If the cache is empty (page
        // was already loaded when extension installed, or user clicked
        // before graphql fired), fall back to DOM scraping the hero +
        // carousel imgs so the user gets SOMETHING for a listing whose
        // graphql responses we missed. Matches the popup's
        // runFetchFlow chain.
        let gallery = await getFacebookStoryFromInterceptor();
        if (!gallery || !Array.isArray(gallery.items) || gallery.items.length === 0) {
          dlog("fb:capture-this-page interceptor empty; trying DOM scrape");
          gallery = await getFacebookDomInfo();
        }
        // DOM scrape sometimes returns {kind: "image", imageUrl: ...}
        // for a single-photo post — normalize to gallery shape so the
        // downstream mapping handles both uniformly.
        if (gallery && gallery.kind === "image" && gallery.imageUrl) {
          gallery = {
            kind: "gallery",
            title: gallery.title,
            handle: gallery.handle,
            date: gallery.date,
            items: [
              {
                url: gallery.imageUrl,
                ext: gallery.basename?.split(".").pop() || "jpg",
                width: gallery.width || 0,
                height: gallery.height || 0,
                thumbUrl: gallery.thumbUrl || gallery.imageUrl,
                mime: gallery.mime || "image/jpeg",
                basename: gallery.basename || "photo.jpg",
                handle: gallery.handle || "",
              },
            ],
          };
        }
        if (!gallery || !Array.isArray(gallery.items) || gallery.items.length === 0) {
          sendResponse({ ok: false, error: "no-media" });
          return;
        }
        const now = Date.now();
        // Mirror popup.js's persistFetchedItems shape so both paths
        // (popup "Fetch media on this page" and grab-button wholepage)
        // produce identical capture records. Spread the entire item
        // the interceptor returned; stamp the gallery-level date as
        // postDate per item so the gallery card can show it.
        const items = gallery.items.map((it) => ({
          url: it.url,
          item: { ...it, postDate: gallery.date || 0 },
          capturedAt: now,
        }));
        const key = captureKey(tabId);
        const { [key]: existing = [] } = await chrome.storage.session.get(key);
        const existingUrls = new Set(existing.map((e) => e.url));
        const toAdd = items.filter((it) => !existingUrls.has(it.url));
        const next = toAdd.length > 0 ? [...existing, ...toAdd] : existing;
        if (toAdd.length > 0) {
          await chrome.storage.session.set({ [key]: next });
        }
        try {
          chrome.action.setBadgeText({ text: String(next.length), tabId });
          chrome.action.setBadgeBackgroundColor({ color: "#1e90ff", tabId });
        } catch {}
        try {
          chrome.action.openPopup?.().catch(() => {});
        } catch {}
        dlog("fb:capture-this-page", {
          tabId,
          found: items.length,
          added: toAdd.length,
          count: next.length,
        });
        sendResponse({ ok: true, added: toAdd.length, count: next.length });
      } catch (err) {
        dlog("fb:capture-this-page failed", err?.message || err);
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();
    return true;
  }
  if (msg.type === "capture:add-batch") {
    const tabId = msg.tabId ?? sender.tab?.id;
    if (!tabId || !Array.isArray(msg.items)) {
      sendResponse({ ok: false, error: "bad-args" });
      return false;
    }
    (async () => {
      const key = captureKey(tabId);
      const { [key]: existing = [] } = await chrome.storage.session.get(key);
      const existingUrls = new Set(existing.map((e) => e.url));
      const toAdd = msg.items.filter((it) => it?.url && !existingUrls.has(it.url));
      if (toAdd.length === 0) {
        sendResponse({ ok: true, added: 0, count: existing.length });
        return;
      }
      const next = [...existing, ...toAdd];
      await chrome.storage.session.set({ [key]: next });
      try {
        chrome.action.setBadgeText({ text: String(next.length), tabId });
        chrome.action.setBadgeBackgroundColor({ color: "#1e90ff", tabId });
      } catch {}
      dlog("capture:add-batch", { tabId, added: toAdd.length, count: next.length });
      sendResponse({ ok: true, added: toAdd.length, count: next.length });
    })();
    return true;
  }
  if (msg.type === "capture:remove") {
    const tabId = msg.tabId ?? sender.tab?.id;
    if (!tabId || !msg.url) {
      sendResponse({ ok: false, error: "bad-args" });
      return false;
    }
    removeCapture(tabId, msg.url).then((r) => {
      dlog("capture:remove", { tabId, removed: r.removed, remaining: r.count });
      try {
        chrome.action.setBadgeText({ text: r.count > 0 ? String(r.count) : "", tabId });
      } catch {}
      sendResponse({ ok: true, ...r });
    });
    return true;
  }
  // Twitter syndication API proxy. The content script can't always
  // fetch cdn.syndication.twimg.com directly (cross-origin from
  // x.com's context unless the CDN returns explicit
  // Access-Control-Allow-Origin headers, which it doesn't reliably
  // do for this endpoint). Background service workers have full
  // fetch access for hosts in host_permissions, so we do the call
  // here and hand the parsed mediaDetails[] back.
  if (msg.type === "tw:fetch-media") {
    const tweetId = msg.tweetId;
    if (!tweetId || !/^\d+$/.test(tweetId)) {
      sendResponse({ ok: false, error: "bad-id" });
      return false;
    }
    (async () => {
      try {
        const token = computeSyndicationToken(tweetId);
        const api = `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&token=${token}&lang=en`;
        logFetcher("twitter", "syndication:fetch", { url: api, tweetId });
        const resp = await fetch(api, { credentials: "omit" });
        if (!resp.ok) {
          logFetcher("twitter", "syndication:error", { url: api, status: resp.status });
          sendResponse({ ok: false, error: `http-${resp.status}` });
          return;
        }
        const data = await resp.json();
        const media = Array.isArray(data?.mediaDetails) ? data.mediaDetails : [];
        logFetcher("twitter", "syndication:result", { tweetId, itemCount: media.length });
        dlog("tw:fetch-media", { tweetId, mediaCount: media.length });
        sendResponse({ ok: true, mediaDetails: media });
      } catch (err) {
        dlog("tw:fetch-media failed", err?.message || err);
        sendResponse({ ok: false, error: err?.message || "fetch-failed" });
      }
    })();
    return true;
  }
  // Instagram API proxies. Content scripts on instagram.com CAN
  // hit these endpoints directly, but the background version is
  // more reliable: it carries the extension's host_permissions
  // (no CORS surprises) and consolidates the credentials +
  // X-IG-App-ID header in one place.
  if (msg.type === "ig:fetch-post-media") {
    const shortcode = msg.shortcode;
    if (!shortcode) {
      sendResponse({ ok: false, error: "bad-shortcode" });
      return false;
    }
    (async () => {
      try {
        const mediaId = shortcodeToMediaId(shortcode);
        if (!mediaId) {
          sendResponse({ ok: false, error: "bad-shortcode-encoding" });
          return;
        }
        const apiUrl = `https://www.instagram.com/api/v1/media/${mediaId}/info/`;
        logFetcher("instagram", "post-api:fetch", { url: apiUrl, shortcode });
        const resp = await fetch(apiUrl, {
          headers: { "X-IG-App-ID": IG_APP_ID },
          credentials: "include",
        });
        if (!resp.ok) {
          logFetcher("instagram", "post-api:error", { url: apiUrl, status: resp.status });
          sendResponse({ ok: false, error: `http-${resp.status}` });
          return;
        }
        const data = await resp.json();
        const media = data?.items?.[0];
        if (!media) {
          sendResponse({ ok: false, error: "empty-items" });
          return;
        }
        dlog("ig:fetch-post-media", {
          shortcode,
          type: media.media_type,
          slides: media.carousel_media?.length || 1,
        });
        logFetcher("instagram", "post-api:result", {
          shortcode,
          mediaType: media.media_type,
          itemCount: media.carousel_media?.length || 1,
        });
        sendResponse({ ok: true, media });
      } catch (err) {
        dlog("ig:fetch-post-media failed", err?.message || err);
        sendResponse({ ok: false, error: err?.message || "fetch-failed" });
      }
    })();
    return true;
  }
  if (msg.type === "ig:fetch-story-media") {
    const username = msg.username;
    if (!username) {
      sendResponse({ ok: false, error: "bad-username" });
      return false;
    }
    (async () => {
      try {
        const profileUrl = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
        logFetcher("instagram", "story-profile-api:fetch", { url: profileUrl, username });
        const profResp = await fetch(profileUrl, {
          headers: { "X-IG-App-ID": IG_APP_ID },
          credentials: "include",
        });
        if (!profResp.ok) {
          logFetcher("instagram", "story-profile-api:error", {
            url: profileUrl,
            status: profResp.status,
          });
          sendResponse({ ok: false, error: `profile-http-${profResp.status}` });
          return;
        }
        const profData = await profResp.json();
        const userId = profData?.data?.user?.id;
        if (!userId) {
          sendResponse({ ok: false, error: "no-user-id" });
          return;
        }
        const reelUrl = `https://www.instagram.com/api/v1/feed/reels_media/?reel_ids=${userId}`;
        logFetcher("instagram", "story-reels-api:fetch", { url: reelUrl, username });
        const reelResp = await fetch(reelUrl, {
          headers: { "X-IG-App-ID": IG_APP_ID },
          credentials: "include",
        });
        if (!reelResp.ok) {
          logFetcher("instagram", "story-reels-api:error", {
            url: reelUrl,
            status: reelResp.status,
          });
          sendResponse({ ok: false, error: `reels-http-${reelResp.status}` });
          return;
        }
        const reelData = await reelResp.json();
        const reel = reelData?.reels?.[userId] ?? reelData?.reels_media?.[0] ?? null;
        if (!reel) {
          sendResponse({ ok: false, error: "no-reel" });
          return;
        }
        const items = Array.isArray(reel.items) ? reel.items : [];
        dlog("ig:fetch-story-media", { username, userId, storyCount: items.length });
        logFetcher("instagram", "story-api:result", { username, itemCount: items.length });
        sendResponse({ ok: true, username, items });
      } catch (err) {
        dlog("ig:fetch-story-media failed", err?.message || err);
        sendResponse({ ok: false, error: err?.message || "fetch-failed" });
      }
    })();
    return true;
  }
  if (msg.type === "capture:remove-batch") {
    const tabId = msg.tabId ?? sender.tab?.id;
    if (!tabId || !Array.isArray(msg.urls)) {
      sendResponse({ ok: false, error: "bad-args" });
      return false;
    }
    removeCapturesBatch(tabId, msg.urls).then((r) => {
      dlog("capture:remove-batch", { tabId, removed: r.removed, remaining: r.count });
      try {
        chrome.action.setBadgeText({ text: r.count > 0 ? String(r.count) : "", tabId });
      } catch {}
      sendResponse({ ok: true, ...r });
    });
    return true;
  }
  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  clearCaptures(tabId).catch(() => {});
  // Drop any persisted picker state the popup wrote for this tab.
  // The popup normally URL-checks on read so a stale entry is
  // harmless until the next popup open, but a tab close is the
  // natural moment to reclaim the bytes.
  chrome.storage.session.remove(`fetched:${tabId}`).catch(() => {});
});

// Track the "section" (first URL path segment) per tab so we only
// clear captures when the user moves to a DIFFERENT section. Reels
// swipes are /reel/<a> → /reel/<b> — same section, captures must
// persist. Going from feed (/) → /marketplace/... IS a section
// change and should clear so the marketplace flow runs its own
// scraping. Same for stories-to-stories (same bucket section).
const lastSectionByTab = new Map();
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url) return;
  try {
    const h = new URL(changeInfo.url).hostname;
    if (!/(^|\.)facebook\.com$|(^|\.)fb\.watch$/i.test(h)) return;
  } catch {
    return;
  }
  const nextSection = sectionOf(changeInfo.url);
  const prevSection = lastSectionByTab.get(tabId);
  lastSectionByTab.set(tabId, nextSection);
  if (prevSection !== undefined && prevSection !== nextSection) {
    clearCaptures(tabId).catch(() => {});
  }
});
// Drop the section record when the tab is gone.
chrome.tabs.onRemoved.addListener((tabId) => {
  lastSectionByTab.delete(tabId);
});

chrome.runtime.onConnect.addListener((port) => {
  // Both the popup and the options page use the SW the same way: connect,
  // send cmds, receive correlated replies. We keep "popup" as the name for
  // backwards compatibility with broadcast events like progress.
  if (port.name !== "popup" && port.name !== "settings") return;
  popupPorts.add(port);
  port.onMessage.addListener((m) => handlePopupMessage(m, port));
  port.onDisconnect.addListener(() => {
    popupPorts.delete(port);
    // Drop any pending requests owned by this popup so their eventual
    // responses are discarded rather than mis-routed.
    for (const [reqId, entry] of pendingRequests) {
      if (entry.port === port) pendingRequests.delete(reqId);
    }
  });
});

async function handlePopupMessage(m, port) {
  switch (m.cmd) {
    case "snapshot":
      port.postMessage({
        type: "snapshot",
        jobs: Array.from(jobs.entries()).map(([id, j]) => ({ id, ...j })),
      });
      break;
    case "listFormats": {
      // Cache key distinguishes with/without cookies because the same URL
      // can produce different listings under different auth.
      const cacheKey = `formats:${m.useCookies ? "c" : "n"}:${m.url}`;
      const cached = await cacheGet(cacheKey);
      if (cached) {
        try {
          port.postMessage(cached);
        } catch {}
        break;
      }
      const reqId = crypto.randomUUID();
      // useCookies travels with the pendingRequests entry so the
      // response gets stamped with the same value when it arrives —
      // see the relay branch above for why this matters.
      pendingRequests.set(reqId, { port, cacheKey, useCookies: !!m.useCookies });
      const cookiesText = m.useCookies ? await readSiteCookiesText(m.url) : "";
      logFetcher("sw", "host:listFormats", { url: m.url, useCookies: !!m.useCookies });
      ensureHostPort().postMessage({
        action: "listFormats",
        reqId,
        url: m.url,
        cookiesText,
      });
      break;
    }
    case "download": {
      jobs.set(m.jobId, {
        url: m.url,
        selection: m.selection,
        status: "running",
        progress: null,
        path: null,
        error: null,
      });
      const cookiesText = m.useCookies ? await readSiteCookiesText(m.url) : "";
      logFetcher("sw", "host:download", {
        url: m.url,
        kind: m.selection?.kind || "",
        height: m.selection?.height || 0,
        useCookies: !!m.useCookies,
        askPath: !!m.askPath,
      });
      ensureHostPort().postMessage({
        action: "download",
        jobId: m.jobId,
        url: m.url,
        selection: m.selection,
        destDir: m.destDir ?? "",
        askPath: !!m.askPath,
        defaultFileName: m.defaultFileName ?? "",
        startDir: m.startDir ?? "",
        dialogTitle: m.dialogTitle ?? "",
        filenameTemplate: m.filenameTemplate ?? "",
        albumName: m.albumName ?? "",
        cookiesText,
      });
      break;
    }
    case "downloadUrl":
      // Image/gallery-item downloads route through the host too so the
      // saveMode behavior (Save As dialog vs specific folder) stays
      // consistent with the video flow. pageUrl lets popup snapshot
      // recovery key by the tab, not the media URL.
      jobs.set(m.jobId, {
        url: m.pageUrl ?? m.url,
        kind: "url",
        status: "running",
        progress: null,
        path: null,
        error: null,
      });
      logFetcher("sw", "host:downloadUrl", {
        url: m.url,
        pageUrl: m.pageUrl ?? "",
        kind: m.kind ?? "combined",
        askPath: !!m.askPath,
      });
      ensureHostPort().postMessage({
        action: "downloadUrl",
        jobId: m.jobId,
        url: m.url,
        destDir: m.destDir ?? "",
        askPath: !!m.askPath,
        defaultFileName: m.defaultFileName ?? "",
        startDir: m.startDir ?? "",
        dialogTitle: m.dialogTitle ?? "",
        kind: m.kind ?? "combined",
        albumName: m.albumName ?? "",
      });
      break;
    case "extractFrame": {
      jobs.set(m.jobId, {
        url: m.pageUrl ?? m.url,
        kind: "frame",
        status: "running",
        progress: null,
        path: null,
        error: null,
      });
      const cookiesText = m.useCookies ? await readSiteCookiesText(m.url) : "";
      logFetcher("sw", "host:extractFrame", {
        url: m.url,
        timestamp: m.timestamp ?? 0,
        useCookies: !!m.useCookies,
        askPath: !!m.askPath,
      });
      ensureHostPort().postMessage({
        action: "extractFrame",
        jobId: m.jobId,
        url: m.url,
        timestamp: m.timestamp ?? 0,
        destDir: m.destDir ?? "",
        askPath: !!m.askPath,
        defaultFileName: m.defaultFileName ?? "",
        startDir: m.startDir ?? "",
        dialogTitle: m.dialogTitle ?? "",
        albumName: m.albumName ?? "",
        cookiesText,
      });
      break;
    }
    case "downloadGallery":
      jobs.set(m.jobId, {
        url: m.pageUrl ?? "gallery",
        kind: "gallery",
        status: "running",
        progress: null,
        path: null,
        error: null,
      });
      logFetcher("sw", "host:downloadGallery", {
        pageUrl: m.pageUrl ?? "",
        itemCount: Array.isArray(m.items) ? m.items.length : 0,
        askDir: !!m.askDir,
        askPerItem: !!m.askPerItem,
      });
      ensureHostPort().postMessage({
        action: "downloadGallery",
        jobId: m.jobId,
        items: m.items,
        albumName: m.albumName ?? "",
        destDir: m.destDir ?? "",
        askDir: !!m.askDir,
        askPerItem: !!m.askPerItem,
        startDir: m.startDir ?? "",
        dialogTitle: m.dialogTitle ?? "",
      });
      break;
    case "cancel":
      ensureHostPort().postMessage({ action: "cancel", jobId: m.jobId });
      break;
    case "pickFolder": {
      const reqId = crypto.randomUUID();
      pendingRequests.set(reqId, { port });
      ensureHostPort().postMessage({
        action: "pickFolder",
        reqId,
        dialogTitle: m.dialogTitle ?? "",
      });
      break;
    }
    case "version": {
      const reqId = crypto.randomUUID();
      pendingRequests.set(reqId, { port });
      ensureHostPort().postMessage({ action: "version", reqId });
      break;
    }
    case "selfUpdate": {
      const reqId = crypto.randomUUID();
      pendingRequests.set(reqId, { port });
      ensureHostPort().postMessage({ action: "selfUpdate", reqId });
      break;
    }
    case "selfHostUpdate": {
      // Frixty Fetcher native-host self-update — separate from the
      // yt-dlp self-update above. Same reqId-correlated pattern; the
      // host replies with type:"hostUpdated" or type:"error" code
      // host_update_failed.
      const reqId = crypto.randomUUID();
      pendingRequests.set(reqId, { port });
      ensureHostPort().postMessage({ action: "selfHostUpdate", reqId });
      break;
    }
    case "forget":
      jobs.delete(m.jobId);
      break;
    case "revealInFileManager":
      // Fire-and-forget — the host opens the OS file manager. Errors land
      // in the host's stderr log; they're not worth surfacing in the UI.
      ensureHostPort().postMessage({ action: "revealInFileManager", path: m.path ?? "" });
      break;
  }
}

chrome.runtime.onInstalled.addListener(() => {
  console.log("Frixty Fetcher installed");
});
