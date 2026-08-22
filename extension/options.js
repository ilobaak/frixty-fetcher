// The options page talks to the service worker just like the popup does —
// we need the SW to relay pickFolder to the native host so the native OS
// folder dialog opens. The browser can't open it directly from an options
// page.

import {
  DATETIME_TOKEN_FORMAT_OPTIONS,
  DEFAULT_DATETIME_TOKEN_FORMAT,
  DEFAULT_TIME_TOKEN_FORMAT,
  filenameDatetimeToken,
  filenameTimeToken,
  normalizeCustomDatetimeTokenFormats,
  normalizeCustomTimeTokenFormats,
  TIME_TOKEN_FORMAT_OPTIONS,
} from "./popup-helpers.js";

import {
  BEST_AVAILABLE_MAX_HEIGHT_OPTIONS,
  BUILTIN_FILENAME_SCHEMES,
  DEFAULT_BEST_AVAILABLE_MAX_HEIGHT,
  DEFAULT_FRAME_FILENAME_SCHEME,
  DEFAULT_FILENAME_SCHEME,
  DEFAULT_MULTIPLE_FILENAME_SCHEME,
  DEFAULT_RANGE_FILENAME_SCHEME,
  DEFAULT_THUMBNAIL_FILENAME_SCHEME,
  FILENAME_DEFAULTS_VERSION,
  filenameSchemeOptions,
  migrateFilenameSettings,
  normalizeCustomFilenameSchemes,
  resolveBestAvailableMaxHeight,
  resolveFrameFilenameMode,
  resolveFilenameMode,
  resolveMultipleFilenameMode,
  resolveRangeFilenameMode,
  resolveThumbnailFilenameMode,
} from "./shared.js";

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
const bestQualityCapEl = el("best-quality-cap");
const bestQualityCapLabelEl = el("best-quality-cap-label");
const qualityCapMarksEl = el("quality-cap-marks");
const versionEl = el("ytdlp-version");
const checkUpdatesBtn = el("check-updates");
const updateResultEl = el("update-result");
const hostVersionEl = el("host-version");
const checkHostUpdatesBtn = el("check-host-updates");
const hostUpdateResultEl = el("host-update-result");
const integratedCategoriesEl = el("integrated-categories");
const filenameModeEl = el("filename-mode");
const multipleFilenameModeEl = el("multiple-filename-mode");
const rangeFilenameModeEl = el("range-filename-mode");
const thumbnailFilenameModeEl = el("thumbnail-filename-mode");
const frameFilenameModeEl = el("frame-filename-mode");
const timeTokenFormatEl = el("time-token-format");
const customTimeFormatsEl = el("custom-time-formats");
const customTimeFormatNameEl = el("custom-time-format-name");
const customTimeFormatPatternEl = el("custom-time-format-pattern");
const addCustomTimeFormatBtn = el("add-custom-time-format");
const customTimeFormatErrorEl = el("custom-time-format-error");
const datetimeTokenFormatEl = el("datetime-token-format");
const customDatetimeFormatsEl = el("custom-datetime-formats");
const customDatetimeFormatNameEl = el("custom-datetime-format-name");
const customDatetimeFormatPatternEl = el("custom-datetime-format-pattern");
const addCustomDatetimeFormatBtn = el("add-custom-datetime-format");
const customDatetimeFormatErrorEl = el("custom-datetime-format-error");
const customSchemesEl = el("custom-schemes");
const customSchemeNameEl = el("custom-scheme-name");
const customSchemeTemplateEl = el("custom-scheme-template");
const addCustomSchemeBtn = el("add-custom-scheme");
const customSchemeErrorEl = el("custom-scheme-error");
const resetOptionsBtn = el("reset-options");

const INTEGRATED_CATEGORIES = [
  ["reddit", "Reddit", true],
  ["facebook", "Facebook", true],
  ["twitter", "Twitter / X", true],
  ["youtube", "YouTube", true],
  ["other", "Other sites", false],
];

const LEGACY_TIME_TOKEN_FORMATS = {
  "hh.mm.ss.mmm": "[hh].[mm].[ss].[ms]",
  "[HH].[MM].[SS].[milliseconds]": "[hh].[mm].[ss].[ms]",
  "hh-mm-ss-mmm": "[hh]-[mm]-[ss]-[ms]",
  "[HH]-[MM]-[SS]-[milliseconds]": "[hh]-[mm]-[ss]-[ms]",
  "hh:mm:ss.mmm": "[hh]:[mm]:[ss].[ms]",
  "[HH]:[MM]:[SS].[milliseconds]": "[hh]:[mm]:[ss].[ms]",
  'hh:mm"ss': '[hh]:[mm]"[ss]',
  '[HH]:[MM]"[SS]': '[hh]:[mm]"[ss]',
  "hh.mm.ss": "[hh].[mm].[ss]",
  "[HH].[MM].[SS]": "[hh].[mm].[ss]",
};

const LEGACY_DATETIME_TOKEN_FORMATS = {
  "yyyy.mm.dd-hh.mm.ss": "[yyyy]-[MM]-[dd]T[hh].[mm].[ss].[ms][tzSafe]",
  "[YYYY].[MM].[DD]-[HH].[mm].[SS]": "[yyyy]-[MM]-[dd]T[hh].[mm].[ss].[ms][tzSafe]",
  "yyyy-mm-dd-hh.mm.ss": "[yyyy]-[MM]-[dd]-[hh].[mm].[ss]",
  "[YYYY]-[MM]-[DD]-[HH].[mm].[SS]": "[yyyy]-[MM]-[dd]-[hh].[mm].[ss]",
  "yyyy.mm.dd": "[yyyy].[MM].[dd]",
  "[YYYY].[MM].[DD]": "[yyyy].[MM].[dd]",
  "yyyy-mm-dd": "[yyyy]-[MM]-[dd]",
  "[YYYY]-[MM]-[DD]": "[yyyy]-[MM]-[dd]",
  "yyyymmdd-hhmmss": "[yyyy][MM][dd]-[hh][mm][ss]",
  "[YYYY][MM][DD]-[HH][mm][SS]": "[yyyy][MM][dd]-[hh][mm][ss]",
};

let current = {
  saveMode: DEFAULT_MODE,
  specificDestDir: "",
  lastDir: "",
  // Single filename setting shared across image and gallery pickers.
  // Values: "uploader-title" | "title-uploader" | "title" | "sequential" | "original" | "setEach".
  // The image picker maps "sequential" to "uploader-title" since per-item
  // indexing is meaningless for a 1-of-1 download.
  filenameMode: DEFAULT_FILENAME_SCHEME,
  filenameDefaultsVersion: FILENAME_DEFAULTS_VERSION,
  multipleFilenameMode: DEFAULT_MULTIPLE_FILENAME_SCHEME,
  rangeFilenameMode: DEFAULT_RANGE_FILENAME_SCHEME,
  thumbnailFilenameMode: DEFAULT_THUMBNAIL_FILENAME_SCHEME,
  frameFilenameMode: DEFAULT_FRAME_FILENAME_SCHEME,
  timeTokenFormat: DEFAULT_TIME_TOKEN_FORMAT,
  customTimeTokenFormats: [],
  datetimeTokenFormat: DEFAULT_DATETIME_TOKEN_FORMAT,
  customDatetimeTokenFormats: [],
  bestAvailableMaxHeight: DEFAULT_BEST_AVAILABLE_MAX_HEIGHT,
  customFilenameSchemes: [],
  integratedButtonSettings: {},
  twitterCookiesMode: "always",
  youtubeCookiesMode: "always",
  instagramCookiesMode: "always",
  facebookCookiesMode: "always",
  tiktokCookiesMode: "always",
};
let port;
const sectionErrorTimers = new WeakMap();

function defaultIntegratedButtonSettings() {
  return migrateIntegratedButtonSettings({});
}

function defaultOptionsSettings() {
  return {
    saveMode: DEFAULT_MODE,
    specificDestDir: "",
    lastDir: "",
    filenameMode: DEFAULT_FILENAME_SCHEME,
    filenameDefaultsVersion: FILENAME_DEFAULTS_VERSION,
    multipleFilenameMode: DEFAULT_MULTIPLE_FILENAME_SCHEME,
    rangeFilenameMode: DEFAULT_RANGE_FILENAME_SCHEME,
    thumbnailFilenameMode: DEFAULT_THUMBNAIL_FILENAME_SCHEME,
    frameFilenameMode: DEFAULT_FRAME_FILENAME_SCHEME,
    timeTokenFormat: DEFAULT_TIME_TOKEN_FORMAT,
    customTimeTokenFormats: [],
    datetimeTokenFormat: DEFAULT_DATETIME_TOKEN_FORMAT,
    customDatetimeTokenFormats: [],
    bestAvailableMaxHeight: DEFAULT_BEST_AVAILABLE_MAX_HEIGHT,
    customFilenameSchemes: [],
    integratedButtonSettings: defaultIntegratedButtonSettings(),
    downloadAutomatically: false,
    destinationDir: "",
    createFolder: true,
    folderMode: DEFAULT_FILENAME_SCHEME,
    twitterCookiesMode: "always",
    youtubeCookiesMode: "always",
    instagramCookiesMode: "always",
    facebookCookiesMode: "always",
    tiktokCookiesMode: "always",
  };
}

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
  current.multipleFilenameMode = resolveMultipleFilenameMode(s);
  current.rangeFilenameMode = resolveRangeFilenameMode(s);
  current.thumbnailFilenameMode = resolveThumbnailFilenameMode(s);
  current.frameFilenameMode = resolveFrameFilenameMode(s);
  current.customTimeTokenFormats = normalizeCustomTimeTokenFormats(s.customTimeTokenFormats);
  current.timeTokenFormat = resolveTimeTokenFormat(s.timeTokenFormat);
  current.customDatetimeTokenFormats = normalizeCustomDatetimeTokenFormats(s.customDatetimeTokenFormats);
  current.datetimeTokenFormat = resolveDatetimeTokenFormat(s.datetimeTokenFormat);
  current.bestAvailableMaxHeight = resolveBestAvailableMaxHeight(s.bestAvailableMaxHeight);
  current.customFilenameSchemes = normalizeCustomFilenameSchemes(s.customFilenameSchemes);
  current.integratedButtonSettings = migrateIntegratedButtonSettings(s.integratedButtonSettings || {});
  current.twitterCookiesMode = s.twitterCookiesMode ?? "always";
  current.youtubeCookiesMode = s.youtubeCookiesMode ?? "always";
  current.instagramCookiesMode = s.instagramCookiesMode ?? "always";
  current.facebookCookiesMode = s.facebookCookiesMode ?? "always";
  current.tiktokCookiesMode = s.tiktokCookiesMode ?? "always";

  const modeRadio = document.querySelector(`input[name="saveMode"][value="${current.saveMode}"]`);
  if (modeRadio) modeRadio.checked = true;
  renderRangeFilenameMode();
  renderVideoImageFilenameModes();
  renderTimeTokenFormat();
  renderCustomTimeFormats();
  renderDatetimeTokenFormat();
  renderCustomDatetimeFormats();
  renderBestAvailableQualityCap();
  renderFilenameMode();
  renderCustomSchemes();
  renderIntegratedCategories();
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
  current.filenameMode = filenameModeEl?.value || DEFAULT_FILENAME_SCHEME;
  current.multipleFilenameMode = multipleFilenameModeEl?.value || DEFAULT_MULTIPLE_FILENAME_SCHEME;
  current.rangeFilenameMode = rangeFilenameModeEl?.value || DEFAULT_RANGE_FILENAME_SCHEME;
  current.thumbnailFilenameMode = thumbnailFilenameModeEl?.value || DEFAULT_THUMBNAIL_FILENAME_SCHEME;
  current.frameFilenameMode = frameFilenameModeEl?.value || DEFAULT_FRAME_FILENAME_SCHEME;
  current.timeTokenFormat = resolveTimeTokenFormat(timeTokenFormatEl?.value);
  current.customTimeTokenFormats = normalizeCustomTimeTokenFormats(current.customTimeTokenFormats);
  current.datetimeTokenFormat = resolveDatetimeTokenFormat(datetimeTokenFormatEl?.value);
  current.customDatetimeTokenFormats = normalizeCustomDatetimeTokenFormats(current.customDatetimeTokenFormats);
  current.bestAvailableMaxHeight = readBestAvailableQualityCap();
  current.integratedButtonSettings = readIntegratedButtonSettings();
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
      filenameDefaultsVersion: FILENAME_DEFAULTS_VERSION,
      multipleFilenameMode: current.multipleFilenameMode,
      rangeFilenameMode: current.rangeFilenameMode,
      thumbnailFilenameMode: current.thumbnailFilenameMode,
      frameFilenameMode: current.frameFilenameMode,
      timeTokenFormat: current.timeTokenFormat,
      customTimeTokenFormats: current.customTimeTokenFormats,
      datetimeTokenFormat: current.datetimeTokenFormat,
      customDatetimeTokenFormats: current.customDatetimeTokenFormats,
      bestAvailableMaxHeight: current.bestAvailableMaxHeight,
      customFilenameSchemes: current.customFilenameSchemes,
      integratedButtonSettings: current.integratedButtonSettings,
      twitterCookiesMode: current.twitterCookiesMode,
      youtubeCookiesMode: current.youtubeCookiesMode,
      instagramCookiesMode: current.instagramCookiesMode,
      facebookCookiesMode: current.facebookCookiesMode,
      tiktokCookiesMode: current.tiktokCookiesMode,
    },
  });
  flashSaved();
}

function renderFilenameMode() {
  current.filenameMode = renderFilenameSelect(filenameModeEl, current.filenameMode, DEFAULT_FILENAME_SCHEME, {
    includeGalleryOnly: false,
    includeOriginal: true,
  });
  current.multipleFilenameMode = renderFilenameSelect(
    multipleFilenameModeEl,
    current.multipleFilenameMode,
    DEFAULT_MULTIPLE_FILENAME_SCHEME,
    { includeGalleryOnly: true, includeOriginal: false },
  );
}

function renderFilenameSelect(sel, currentValue, fallback, options = {}) {
  if (!sel) return fallback;
  const previous = sel.value || currentValue;
  sel.innerHTML = "";
  for (const opt of filenameSchemeOptions(current.customFilenameSchemes, options)) {
    if (opt.value === "setEach") continue;
    sel.add(new Option(opt.label, opt.value));
  }
  sel.value = [...sel.options].some((o) => o.value === previous) ? previous : fallback;
  return sel.value;
}

function renderRangeFilenameMode() {
  current.rangeFilenameMode = renderFilenameSelect(
    rangeFilenameModeEl,
    current.rangeFilenameMode,
    DEFAULT_RANGE_FILENAME_SCHEME,
    { includeGalleryOnly: false, includeOriginal: false, includeRangeOnly: true },
  );
}

function renderVideoImageFilenameModes() {
  current.thumbnailFilenameMode = renderFilenameSelect(
    thumbnailFilenameModeEl,
    current.thumbnailFilenameMode,
    DEFAULT_THUMBNAIL_FILENAME_SCHEME,
    { includeGalleryOnly: false, includeOriginal: false, includeVideoImageOnly: true },
  );
  current.frameFilenameMode = renderFilenameSelect(
    frameFilenameModeEl,
    current.frameFilenameMode,
    DEFAULT_FRAME_FILENAME_SCHEME,
    { includeGalleryOnly: false, includeOriginal: false, includeVideoImageOnly: true },
  );
}

function resolveTimeTokenFormat(value) {
  if (Object.hasOwn(LEGACY_TIME_TOKEN_FORMATS, value)) return LEGACY_TIME_TOKEN_FORMATS[value];
  if (TIME_TOKEN_FORMAT_OPTIONS.some((opt) => opt.value === value)) return value;
  if (
    typeof value === "string" &&
    value.startsWith("custom:") &&
    current.customTimeTokenFormats.some((fmt) => `custom:${fmt.id}` === value)
  ) {
    return value;
  }
  return DEFAULT_TIME_TOKEN_FORMAT;
}

function renderTimeTokenFormat() {
  if (!timeTokenFormatEl) return;
  const previous = resolveTimeTokenFormat(timeTokenFormatEl.value || current.timeTokenFormat);
  timeTokenFormatEl.innerHTML = "";
  for (const opt of TIME_TOKEN_FORMAT_OPTIONS) {
    timeTokenFormatEl.add(new Option(opt.label, opt.value));
  }
  for (const fmt of current.customTimeTokenFormats) {
    timeTokenFormatEl.add(new Option(fmt.name, `custom:${fmt.id}`));
  }
  timeTokenFormatEl.value = previous;
  current.timeTokenFormat = timeTokenFormatEl.value;
}

function showSectionError(target, message, { alertUser = false } = {}) {
  if (!target) return;
  target.hidden = false;
  target.textContent = message;
  const existing = sectionErrorTimers.get(target);
  if (existing) clearTimeout(existing);
  sectionErrorTimers.set(
    target,
    setTimeout(() => {
      target.hidden = true;
      target.textContent = "";
      sectionErrorTimers.delete(target);
    }, 9000),
  );
  if (alertUser) alert(message);
}

function hideSectionError(target) {
  if (!target) return;
  const existing = sectionErrorTimers.get(target);
  if (existing) clearTimeout(existing);
  sectionErrorTimers.delete(target);
  target.hidden = true;
  target.textContent = "";
}

function renderCustomTimeFormats() {
  if (!customTimeFormatsEl) return;
  customTimeFormatsEl.innerHTML = "";
  if (current.customTimeTokenFormats.length === 0) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "No custom time formats saved.";
    customTimeFormatsEl.append(p);
    return;
  }
  for (const fmt of current.customTimeTokenFormats) {
    const row = document.createElement("div");
    row.className = "specific-body custom-time-format-row";
    const name = document.createElement("span");
    name.textContent = `${fmt.name}: ${fmt.pattern} (${filenameTimeToken(3723.25, `custom:${fmt.id}`, [fmt])})`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger";
    remove.textContent = "Remove";
    remove.onclick = () => {
      current.customTimeTokenFormats = current.customTimeTokenFormats.filter((entry) => entry.id !== fmt.id);
      if (current.timeTokenFormat === `custom:${fmt.id}`) current.timeTokenFormat = DEFAULT_TIME_TOKEN_FORMAT;
      renderTimeTokenFormat();
      renderCustomTimeFormats();
    };
    row.append(name, remove);
    customTimeFormatsEl.append(row);
  }
}

function customTimeFormatNameTaken(name) {
  const target = name.trim().toLowerCase();
  if (!target) return false;
  return (
    TIME_TOKEN_FORMAT_OPTIONS.some((opt) => opt.label.toLowerCase() === target) ||
    current.customTimeTokenFormats.some((fmt) => fmt.name.toLowerCase() === target)
  );
}

function addCustomTimeFormat() {
  const name = String(customTimeFormatNameEl?.value || "").trim();
  const pattern = String(customTimeFormatPatternEl?.value || "").trim();
  if (!name || !pattern) {
    showSectionError(customTimeFormatErrorEl, "Enter a name and time format.");
    return;
  }
  if (customTimeFormatNameTaken(name)) {
    showSectionError(customTimeFormatErrorEl, "Cannot save: that name is already taken.", {
      alertUser: true,
    });
    return;
  }
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  current.customTimeTokenFormats = normalizeCustomTimeTokenFormats([
    ...current.customTimeTokenFormats,
    { id, name, pattern },
  ]);
  customTimeFormatNameEl.value = "";
  customTimeFormatPatternEl.value = "";
  hideSectionError(customTimeFormatErrorEl);
  hideError();
  renderTimeTokenFormat();
  renderCustomTimeFormats();
}

function resolveDatetimeTokenFormat(value) {
  if (Object.hasOwn(LEGACY_DATETIME_TOKEN_FORMATS, value)) {
    return LEGACY_DATETIME_TOKEN_FORMATS[value];
  }
  if (DATETIME_TOKEN_FORMAT_OPTIONS.some((opt) => opt.value === value)) return value;
  if (
    typeof value === "string" &&
    value.startsWith("custom:") &&
    current.customDatetimeTokenFormats.some((fmt) => `custom:${fmt.id}` === value)
  ) {
    return value;
  }
  return DEFAULT_DATETIME_TOKEN_FORMAT;
}

function renderDatetimeTokenFormat() {
  if (!datetimeTokenFormatEl) return;
  const previous = resolveDatetimeTokenFormat(datetimeTokenFormatEl.value || current.datetimeTokenFormat);
  datetimeTokenFormatEl.innerHTML = "";
  for (const opt of DATETIME_TOKEN_FORMAT_OPTIONS) {
    datetimeTokenFormatEl.add(new Option(opt.label, opt.value));
  }
  for (const fmt of current.customDatetimeTokenFormats) {
    datetimeTokenFormatEl.add(new Option(fmt.name, `custom:${fmt.id}`));
  }
  datetimeTokenFormatEl.value = previous;
  current.datetimeTokenFormat = datetimeTokenFormatEl.value;
}

function renderCustomDatetimeFormats() {
  if (!customDatetimeFormatsEl) return;
  customDatetimeFormatsEl.innerHTML = "";
  if (current.customDatetimeTokenFormats.length === 0) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "No custom datetime formats saved.";
    customDatetimeFormatsEl.append(p);
    return;
  }
  const sample = new Date(2026, 7, 18, 17, 49, 4, 125);
  for (const fmt of current.customDatetimeTokenFormats) {
    const row = document.createElement("div");
    row.className = "specific-body custom-time-format-row";
    const name = document.createElement("span");
    name.textContent = `${fmt.name}: ${fmt.pattern} (${filenameDatetimeToken(sample, `custom:${fmt.id}`, [fmt])})`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger";
    remove.textContent = "Remove";
    remove.onclick = () => {
      current.customDatetimeTokenFormats = current.customDatetimeTokenFormats.filter((entry) => entry.id !== fmt.id);
      if (current.datetimeTokenFormat === `custom:${fmt.id}`) {
        current.datetimeTokenFormat = DEFAULT_DATETIME_TOKEN_FORMAT;
      }
      renderDatetimeTokenFormat();
      renderCustomDatetimeFormats();
    };
    row.append(name, remove);
    customDatetimeFormatsEl.append(row);
  }
}

function customDatetimeFormatNameTaken(name) {
  const target = name.trim().toLowerCase();
  if (!target) return false;
  return (
    DATETIME_TOKEN_FORMAT_OPTIONS.some((opt) => opt.label.toLowerCase() === target) ||
    current.customDatetimeTokenFormats.some((fmt) => fmt.name.toLowerCase() === target)
  );
}

function addCustomDatetimeFormat() {
  const name = String(customDatetimeFormatNameEl?.value || "").trim();
  const pattern = String(customDatetimeFormatPatternEl?.value || "").trim();
  if (!name || !pattern) {
    showSectionError(customDatetimeFormatErrorEl, "Enter a name and datetime format.");
    return;
  }
  if (customDatetimeFormatNameTaken(name)) {
    showSectionError(customDatetimeFormatErrorEl, "Cannot save: that name is already taken.", {
      alertUser: true,
    });
    return;
  }
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  current.customDatetimeTokenFormats = normalizeCustomDatetimeTokenFormats([
    ...current.customDatetimeTokenFormats,
    { id, name, pattern },
  ]);
  customDatetimeFormatNameEl.value = "";
  customDatetimeFormatPatternEl.value = "";
  hideSectionError(customDatetimeFormatErrorEl);
  hideError();
  renderDatetimeTokenFormat();
  renderCustomDatetimeFormats();
}

function qualityCapIndexForHeight(height) {
  const resolved = resolveBestAvailableMaxHeight(height);
  return Math.max(
    0,
    BEST_AVAILABLE_MAX_HEIGHT_OPTIONS.findIndex((opt) => opt.value === resolved),
  );
}

function qualityCapLabelForIndex(index) {
  return BEST_AVAILABLE_MAX_HEIGHT_OPTIONS[index]?.label || BEST_AVAILABLE_MAX_HEIGHT_OPTIONS[0].label;
}

function renderBestAvailableQualityCap() {
  if (!bestQualityCapEl || !bestQualityCapLabelEl) return;
  bestQualityCapEl.min = "0";
  bestQualityCapEl.max = String(BEST_AVAILABLE_MAX_HEIGHT_OPTIONS.length - 1);
  bestQualityCapEl.step = "1";
  if (qualityCapMarksEl && qualityCapMarksEl.childElementCount === 0) {
    for (const [idx, opt] of BEST_AVAILABLE_MAX_HEIGHT_OPTIONS.entries()) {
      const option = document.createElement("option");
      option.value = String(idx);
      option.label = opt.label;
      qualityCapMarksEl.append(option);
    }
  }
  bestQualityCapEl.value = String(qualityCapIndexForHeight(current.bestAvailableMaxHeight));
  const update = () => {
    bestQualityCapLabelEl.textContent = qualityCapLabelForIndex(Number(bestQualityCapEl.value));
  };
  update();
  bestQualityCapEl.oninput = update;
}

function readBestAvailableQualityCap() {
  if (!bestQualityCapEl) return DEFAULT_BEST_AVAILABLE_MAX_HEIGHT;
  const idx = Number(bestQualityCapEl.value);
  return resolveBestAvailableMaxHeight(BEST_AVAILABLE_MAX_HEIGHT_OPTIONS[idx]?.value);
}

function migrateIntegratedButtonSettings(raw) {
  const out = {};
  for (const [key, , defaultDownload] of INTEGRATED_CATEGORIES) {
    const entry = raw?.[key] || {};
    out[key] = {
      behavior: entry.behavior || (defaultDownload ? "download" : "fetch"),
      filenameMode: entry.filenameMode || DEFAULT_FILENAME_SCHEME,
    };
  }
  return out;
}

function renderIntegratedCategories() {
  if (!integratedCategoriesEl) return;
  integratedCategoriesEl.innerHTML = "";
  for (const [key, label] of INTEGRATED_CATEGORIES) {
    const settings = current.integratedButtonSettings[key] || {};
    const box = document.createElement("div");
    box.className = "specific-body integrated-category";
    box.dataset.category = key;

    const heading = document.createElement("h3");
    heading.textContent = label;
    box.append(heading);

    const behavior = document.createElement("select");
    behavior.className = "integrated-behavior";
    behavior.add(new Option("Downloads media", "download"));
    behavior.add(new Option("Fetches to extension", "fetch"));
    behavior.value = settings.behavior || "download";

    const scheme = document.createElement("select");
    scheme.className = "integrated-filename-mode";
    for (const opt of filenameSchemeOptions(current.customFilenameSchemes, { includeGalleryOnly: false, includeOriginal: false })) {
      if (opt.value === "setEach") continue;
      scheme.add(new Option(opt.label, opt.value));
    }
    scheme.value = settings.filenameMode || DEFAULT_FILENAME_SCHEME;

    const behaviorLabel = document.createElement("label");
    behaviorLabel.className = "card-control integrated-control";
    const behaviorText = document.createElement("span");
    behaviorText.className = "integrated-action-label";
    const icon = document.createElement("span");
    icon.className = "integrated-button-image";
    icon.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11m0 0 4-4m-4 4-4-4M5 19h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    behaviorText.append(icon, document.createTextNode("Button action"));
    behaviorLabel.append(behaviorText, behavior);

    const schemeLabel = document.createElement("label");
    schemeLabel.className = "card-control integrated-control";
    schemeLabel.append(document.createElement("span"), scheme);
    schemeLabel.firstElementChild.textContent = "Filename";

    box.append(behaviorLabel, schemeLabel);
    integratedCategoriesEl.append(box);
  }
}

function readIntegratedButtonSettings() {
  const out = {};
  for (const box of document.querySelectorAll(".integrated-category")) {
    const key = box.dataset.category;
    out[key] = {
      behavior: box.querySelector(".integrated-behavior")?.value || "download",
      filenameMode: box.querySelector(".integrated-filename-mode")?.value || DEFAULT_FILENAME_SCHEME,
    };
  }
  return migrateIntegratedButtonSettings(out);
}

function renderCustomSchemes() {
  if (!customSchemesEl) return;
  customSchemesEl.innerHTML = "";
  if (current.customFilenameSchemes.length === 0) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "No custom schemes saved.";
    customSchemesEl.append(p);
    return;
  }
  for (const scheme of current.customFilenameSchemes) {
    const row = document.createElement("div");
    row.className = "specific-body custom-scheme-row";
    const name = document.createElement("span");
    name.textContent = `${scheme.name}: ${scheme.template}`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger";
    remove.textContent = "Remove";
    remove.onclick = () => {
      current.customFilenameSchemes = current.customFilenameSchemes.filter((s) => s.id !== scheme.id);
      renderRangeFilenameMode();
      renderVideoImageFilenameModes();
      renderFilenameMode();
      renderCustomSchemes();
      renderIntegratedCategories();
    };
    row.append(name, remove);
    customSchemesEl.append(row);
  }
}

function filenameSchemeNameTaken(name) {
  const target = name.trim().toLowerCase();
  if (!target) return false;
  return (
    BUILTIN_FILENAME_SCHEMES.some((scheme) => scheme.label.toLowerCase() === target) ||
    current.customFilenameSchemes.some((scheme) => scheme.name.toLowerCase() === target)
  );
}

function addCustomScheme() {
  const name = String(customSchemeNameEl?.value || "").trim();
  const template = String(customSchemeTemplateEl?.value || "").trim();
  if (!name || !template) {
    showSectionError(customSchemeErrorEl, "Enter a name and filename scheme.");
    return;
  }
  if (filenameSchemeNameTaken(name)) {
    showSectionError(customSchemeErrorEl, "Cannot save: that name is already taken.", {
      alertUser: true,
    });
    return;
  }
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  current.customFilenameSchemes = normalizeCustomFilenameSchemes([
    ...current.customFilenameSchemes,
    { id, name, template },
  ]);
  customSchemeNameEl.value = "";
  customSchemeTemplateEl.value = "";
  hideSectionError(customSchemeErrorEl);
  hideError();
  renderRangeFilenameMode();
  renderVideoImageFilenameModes();
  renderFilenameMode();
  renderCustomSchemes();
  renderIntegratedCategories();
}

async function resetOptionsToDefaults() {
  const ok = confirm("Reset all options to their defaults? This cannot be undone.");
  if (!ok) return;
  const defaults = defaultOptionsSettings();
  await chrome.storage.local.set({ settings: defaults });
  Object.assign(current, defaults);
  const modeRadio = document.querySelector(`input[name="saveMode"][value="${current.saveMode}"]`);
  if (modeRadio) modeRadio.checked = true;
  for (const [group, value] of [
    ["twitter-cookies-mode", current.twitterCookiesMode],
    ["youtube-cookies-mode", current.youtubeCookiesMode],
    ["instagram-cookies-mode", current.instagramCookiesMode],
    ["facebook-cookies-mode", current.facebookCookiesMode],
    ["tiktok-cookies-mode", current.tiktokCookiesMode],
  ]) {
    const radio = document.querySelector(`input[name="${group}"][value="${value}"]`);
    if (radio) radio.checked = true;
  }
  renderPaths();
  updateDisabledState();
  renderRangeFilenameMode();
  renderVideoImageFilenameModes();
  renderTimeTokenFormat();
  renderCustomTimeFormats();
  renderDatetimeTokenFormat();
  renderCustomDatetimeFormats();
  renderBestAvailableQualityCap();
  renderFilenameMode();
  renderCustomSchemes();
  renderIntegratedCategories();
  hideSectionError(customTimeFormatErrorEl);
  hideSectionError(customDatetimeFormatErrorEl);
  hideSectionError(customSchemeErrorEl);
  hideError();
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

if (addCustomSchemeBtn) addCustomSchemeBtn.addEventListener("click", addCustomScheme);
if (addCustomTimeFormatBtn) addCustomTimeFormatBtn.addEventListener("click", addCustomTimeFormat);
if (addCustomDatetimeFormatBtn) {
  addCustomDatetimeFormatBtn.addEventListener("click", addCustomDatetimeFormat);
}
if (resetOptionsBtn) resetOptionsBtn.addEventListener("click", resetOptionsToDefaults);

connect();
load();
// Fetch the current yt-dlp version once the SW port is established.
queueMicrotask(() => port.postMessage({ cmd: "version" }));
