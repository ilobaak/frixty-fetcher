// The options page talks to the service worker just like the popup does —
// we need the SW to relay pickFolder to the native host so the native OS
// folder dialog opens. The browser can't open it directly from an options
// page.

import { resolveFilenameMode, migrateFilenameSettings } from "./shared.js";

const DEFAULT_MODE = "ask";

const el = (id) => document.getElementById(id);
const pathEl = el("specific-path");
const lastPathEl = el("last-path");
const chooseBtn = el("choose");
const saveBtn = el("save");
const status = el("status");
const errEl = el("err");
const specificBody = el("specific-body");
const lastBody = el("last-body");
const versionEl = el("ytdlp-version");
const checkUpdatesBtn = el("check-updates");
const updateResultEl = el("update-result");
const hostVersionEl = el("host-version");
const checkHostUpdatesBtn = el("check-host-updates");
const hostUpdateResultEl = el("host-update-result");

let current = {
  saveMode: DEFAULT_MODE,
  specificDestDir: "",
  lastDir: "",
  // Single filename setting shared across image and gallery pickers.
  // Values: "uploader-title" | "title" | "sequential" | "original" | "setEach".
  // The image picker maps "sequential" to "uploader-title" since per-item
  // indexing is meaningless for a 1-of-1 download.
  filenameMode: "uploader-title",
  twitterCookiesMode: "always",
  youtubeCookiesMode: "always",
  instagramCookiesMode: "always",
  facebookCookiesMode: "always",
  tiktokCookiesMode: "always",
};
let port;

function connect() {
  port = chrome.runtime.connect({ name: "settings" });
  port.onMessage.addListener(onMessage);
}

function onMessage(msg) {
  if (msg.type === "folderPicked") {
    chooseBtn.disabled = false;
    if (msg.canceled) return;
    current.specificDestDir = msg.path;
    renderPaths();
  } else if (msg.type === "version") {
    renderVersion(msg);
  } else if (msg.type === "updateProgress") {
    renderUpdateProgress(msg);
  } else if (msg.type === "updated") {
    renderUpdateResult(msg);
  } else if (msg.type === "hostUpdated") {
    renderHostUpdateResult(msg);
  } else if (msg.type === "error") {
    // Errors can come from pickFolder, version, selfUpdate, or
    // selfHostUpdate. Re-enable any button that might have been
    // disabled; the right banner picks itself based on the code.
    chooseBtn.disabled = false;
    checkUpdatesBtn.disabled = false;
    checkHostUpdatesBtn.disabled = false;
    if (msg.code === "update_failed" || msg.code === "update_pip_install") {
      showUpdateResult(msg.message ?? "Update failed", "err");
    } else if (msg.code === "host_update_failed") {
      showHostUpdateResult(msg.message ?? "Host update failed", "err");
    } else {
      showError(msg.message ?? "Request failed");
    }
  } else if (msg.type === "settingsUpdated" && msg.settings) {
    // SW broadcasts this when it persists a new lastDir after a download.
    current.lastDir = msg.settings.lastDir ?? current.lastDir;
    renderPaths();
  }
}

function renderVersion(msg) {
  if (msg.ytDlp) {
    versionEl.textContent = `yt-dlp ${msg.ytDlp}`;
    versionEl.classList.remove("empty");
  } else {
    versionEl.textContent = "yt-dlp not found on this system";
    versionEl.classList.add("empty");
  }
  if (msg.host) {
    hostVersionEl.textContent = `Frixty Fetcher ${msg.host}`;
    hostVersionEl.classList.remove("empty");
  }
}

// renderHostUpdateResult mirrors renderUpdateResult but for the
// frixtyhost self-update path. The "replaced" flag is what tells us
// whether anything actually changed on disk: handleSelfHostUpdate
// returns false for "already up to date" and true once the new binary
// has been swapped in. The new binary takes effect on the next host
// launch (Chrome respawns frixtyhost on the next download), so the
// success message says "next launch" rather than "now".
function renderHostUpdateResult(msg) {
  checkHostUpdatesBtn.disabled = false;
  if (msg.replaced) {
    showHostUpdateResult(
      `Updated ${msg.oldVersion} → ${msg.newVersion}. Restart Chrome (or reload the extension) for the new build to take effect.`,
      "ok",
    );
    hostVersionEl.textContent = `Frixty Fetcher ${msg.newVersion} (pending restart)`;
  } else {
    showHostUpdateResult(`Already up to date (${msg.newVersion || msg.oldVersion || "?"})`, "ok");
  }
}

function showHostUpdateResult(text, kind) {
  hostUpdateResultEl.hidden = false;
  hostUpdateResultEl.textContent = text;
  hostUpdateResultEl.className = "muted" + (kind ? " " + kind : "");
}

// renderUpdateProgress shows live byte counts during the GitHub download.
// Total is 0 if the server didn't send Content-Length; in that case show
// just the downloaded count so the user still sees activity.
function renderUpdateProgress(msg) {
  const done = Number(msg.downloaded) || 0;
  const total = Number(msg.total) || 0;
  if (total > 0) {
    const pct = Math.min(100, Math.round((done / total) * 100));
    showUpdateResult(`Downloading yt-dlp… ${pct}% (${formatBytes(done)} / ${formatBytes(total)})`, "");
  } else {
    showUpdateResult(`Downloading yt-dlp… ${formatBytes(done)}`, "");
  }
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function renderUpdateResult(msg) {
  checkUpdatesBtn.disabled = false;
  if (msg.newVersion && msg.oldVersion && msg.newVersion !== msg.oldVersion) {
    showUpdateResult(`Updated ${msg.oldVersion} → ${msg.newVersion}`, "ok");
    versionEl.textContent = `yt-dlp ${msg.newVersion}`;
    versionEl.classList.remove("empty");
  } else {
    showUpdateResult(`Already up to date (${msg.newVersion || msg.oldVersion || "?"})`, "ok");
  }
}

function showUpdateResult(text, kind) {
  updateResultEl.hidden = false;
  updateResultEl.textContent = text;
  updateResultEl.className = "muted" + (kind ? " " + kind : "");
}

async function load() {
  const { settings = {} } = await chrome.storage.local.get("settings");
  const migrated = migrateFilenameSettings(settings);
  if (migrated) {
    await chrome.storage.local.set({ settings: migrated });
  }
  const s = migrated ?? settings;
  current.saveMode = s.saveMode ?? DEFAULT_MODE;
  current.specificDestDir = s.specificDestDir ?? "";
  current.lastDir = s.lastDir ?? "";
  current.filenameMode = resolveFilenameMode(s);
  current.twitterCookiesMode = s.twitterCookiesMode ?? "always";
  current.youtubeCookiesMode = s.youtubeCookiesMode ?? "always";
  current.instagramCookiesMode = s.instagramCookiesMode ?? "always";
  current.facebookCookiesMode = s.facebookCookiesMode ?? "always";
  current.tiktokCookiesMode = s.tiktokCookiesMode ?? "always";

  const modeRadio = document.querySelector(`input[name="saveMode"][value="${current.saveMode}"]`);
  if (modeRadio) modeRadio.checked = true;
  const fnRadio = document.querySelector(`input[name="filename-mode"][value="${current.filenameMode}"]`);
  if (fnRadio) fnRadio.checked = true;
  const twtRadio = document.querySelector(`input[name="twitter-cookies-mode"][value="${current.twitterCookiesMode}"]`);
  if (twtRadio) twtRadio.checked = true;
  const ytRadio = document.querySelector(`input[name="youtube-cookies-mode"][value="${current.youtubeCookiesMode}"]`);
  if (ytRadio) ytRadio.checked = true;
  const igRadio = document.querySelector(`input[name="instagram-cookies-mode"][value="${current.instagramCookiesMode}"]`);
  if (igRadio) igRadio.checked = true;
  const fbRadio = document.querySelector(`input[name="facebook-cookies-mode"][value="${current.facebookCookiesMode}"]`);
  if (fbRadio) fbRadio.checked = true;
  const ttRadio = document.querySelector(`input[name="tiktok-cookies-mode"][value="${current.tiktokCookiesMode}"]`);
  if (ttRadio) ttRadio.checked = true;

  renderPaths();
  updateDisabledState();
}

function renderPaths() {
  if (current.specificDestDir) {
    pathEl.textContent = current.specificDestDir;
    pathEl.classList.remove("empty");
  } else {
    pathEl.textContent = "No folder selected";
    pathEl.classList.add("empty");
  }
  if (current.lastDir) {
    lastPathEl.textContent = current.lastDir;
    lastPathEl.classList.remove("empty");
  } else {
    lastPathEl.textContent = "No downloads yet — falls back to Save As";
    lastPathEl.classList.add("empty");
  }
}

function updateDisabledState() {
  specificBody.setAttribute("aria-disabled", String(current.saveMode !== "specific"));
  lastBody.setAttribute("aria-disabled", String(current.saveMode !== "lastLocation"));
}

function selectedMode() {
  const r = document.querySelector('input[name="saveMode"]:checked');
  return r ? r.value : DEFAULT_MODE;
}

async function save() {
  current.saveMode = selectedMode();
  if (current.saveMode === "specific" && !current.specificDestDir) {
    showError("Pick a folder before choosing “Save to:”.");
    return;
  }
  current.filenameMode = document.querySelector('input[name="filename-mode"]:checked')?.value ?? "uploader-title";
  current.twitterCookiesMode = document.querySelector('input[name="twitter-cookies-mode"]:checked')?.value ?? "always";
  current.youtubeCookiesMode = document.querySelector('input[name="youtube-cookies-mode"]:checked')?.value ?? "always";
  current.instagramCookiesMode = document.querySelector('input[name="instagram-cookies-mode"]:checked')?.value ?? "always";
  current.facebookCookiesMode = document.querySelector('input[name="facebook-cookies-mode"]:checked')?.value ?? "always";
  current.tiktokCookiesMode = document.querySelector('input[name="tiktok-cookies-mode"]:checked')?.value ?? "always";
  hideError();
  // Preserve lastDir in storage — it's updated by the SW on each save and
  // shouldn't get stomped on here.
  const { settings = {} } = await chrome.storage.local.get("settings");
  await chrome.storage.local.set({
    settings: {
      ...settings,
      saveMode: current.saveMode,
      specificDestDir: current.specificDestDir,
      filenameMode: current.filenameMode,
      twitterCookiesMode: current.twitterCookiesMode,
      youtubeCookiesMode: current.youtubeCookiesMode,
      instagramCookiesMode: current.instagramCookiesMode,
      facebookCookiesMode: current.facebookCookiesMode,
      tiktokCookiesMode: current.tiktokCookiesMode,
    },
  });
  flashSaved();
}

function flashSaved() {
  status.classList.add("visible");
  clearTimeout(flashSaved._t);
  flashSaved._t = setTimeout(() => status.classList.remove("visible"), 1500);
}

function showError(msg) {
  errEl.hidden = false;
  errEl.textContent = msg;
}

function hideError() {
  errEl.hidden = true;
}

for (const r of document.querySelectorAll('input[name="saveMode"]')) {
  r.addEventListener("change", () => {
    current.saveMode = selectedMode();
    updateDisabledState();
    hideError();
  });
}

chooseBtn.addEventListener("click", () => {
  chooseBtn.disabled = true;
  hideError();
  port.postMessage({ cmd: "pickFolder", dialogTitle: "Choose default download folder" });
});

saveBtn.addEventListener("click", save);
checkUpdatesBtn.addEventListener("click", () => {
  checkUpdatesBtn.disabled = true;
  showUpdateResult("Checking…", "");
  port.postMessage({ cmd: "selfUpdate" });
});
checkHostUpdatesBtn.addEventListener("click", () => {
  checkHostUpdatesBtn.disabled = true;
  showHostUpdateResult("Checking…", "");
  port.postMessage({ cmd: "selfHostUpdate" });
});

connect();
load();
// Fetch the current yt-dlp version once the SW port is established.
queueMicrotask(() => port.postMessage({ cmd: "version" }));
