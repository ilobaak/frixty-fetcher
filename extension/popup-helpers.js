// @ts-check

export function parseTimestamp(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return NaN;
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return Number(s);
  const parts = s.split(":");
  if (parts.length < 2 || parts.length > 3) return NaN;
  let total = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!/^\d+(?:\.\d+)?$/.test(part)) return NaN;
    if (i < parts.length - 1 && part.includes(".")) return NaN;
    const n = Number(part);
    if (!Number.isFinite(n)) return NaN;
    total = total * 60 + n;
  }
  return total;
}

export function validateTimestamp(raw, duration = 0) {
  const seconds = parseTimestamp(raw);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return { ok: false, seconds: 0, error: "invalid" };
  }
  if (duration > 0 && seconds > duration) {
    return { ok: false, seconds, error: "out-of-range" };
  }
  return { ok: true, seconds, error: "" };
}

export function formatTimestamp(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n < 0) return "0:00";
  const whole = Math.floor(n);
  const frac = n - whole;
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const suffix = frac > 0 ? frac.toFixed(3).slice(1) : "";
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}${suffix}`;
  return `${m}:${String(s).padStart(2, "0")}${suffix}`;
}

export function frameTimestampPrefill(seconds, duration = 0) {
  const raw = Number(seconds);
  let bounded = Number.isFinite(raw) && raw > 0 ? raw : 0;
  if (duration > 0 && bounded > duration) bounded = duration;
  return {
    seconds: bounded,
    label: formatTimestamp(bounded),
    sliderValue: String(Math.floor(bounded)),
  };
}

export function frameTimestampSelection(seconds, duration = 0) {
  return frameTimestampPrefill(seconds, duration);
}

export function frameTimestampFilenameSuffix(seconds) {
  return formatTimestamp(seconds).replace(/:/g, "-");
}

export const DEFAULT_TIME_TOKEN_FORMAT = "[hh].[mm].[ss].[ms]";

export const TIME_TOKEN_FORMAT_OPTIONS = [
  {
    value: "[hh].[mm].[ss].[ms]",
    label: "[hh].[mm].[ss].[ms]",
    example: "01.02.03.250",
  },
  {
    value: "[hh]-[mm]-[ss]-[ms]",
    label: "[hh]-[mm]-[ss]-[ms]",
    example: "01-02-03-250",
  },
  {
    value: "[hh]:[mm]:[ss].[ms]",
    label: "[hh]:[mm]:[ss].[ms]",
    example: "01:02:03.250",
  },
  { value: '[hh]:[mm]"[ss]', label: '[hh]:[mm]"[ss]', example: '01:02"03' },
  { value: "[hh].[mm].[ss]", label: "[hh].[mm].[ss]", example: "01.02.03" },
];

export const DEFAULT_DATETIME_TOKEN_FORMAT = "[yyyy]-[MM]-[dd]T[hh].[mm].[ss].[ms][tzSafe]";

export const DATETIME_TOKEN_FORMAT_OPTIONS = [
  {
    value: "[yyyy]-[MM]-[dd]T[hh].[mm].[ss].[ms][tzSafe]",
    label: "[yyyy]-[MM]-[dd]T[hh].[mm].[ss].[ms][tzSafe]",
    example: "2026-08-18T17.49.04.125-04.00",
  },
  {
    value: "[yyyy]-[MM]-[dd]-[hh].[mm].[ss]",
    label: "[yyyy]-[MM]-[dd]-[hh].[mm].[ss]",
    example: "2026-08-18-17.49.04",
  },
  { value: "[yyyy].[MM].[dd]", label: "[yyyy].[MM].[dd]", example: "2026.08.18" },
  { value: "[yyyy]-[MM]-[dd]", label: "[yyyy]-[MM]-[dd]", example: "2026-08-18" },
  {
    value: "[yyyy][MM][dd]-[hh][mm][ss]",
    label: "[yyyy][MM][dd]-[hh][mm][ss]",
    example: "20260818-174904",
  },
];

export function normalizeCustomTimeTokenFormats(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const entry of raw) {
    const id = String(entry?.id || "").trim();
    const name = String(entry?.name || "").trim();
    const pattern = String(entry?.pattern || "").trim();
    if (!id || !name || !pattern || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name, pattern });
  }
  return out;
}

export function normalizeCustomDatetimeTokenFormats(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const entry of raw) {
    const id = String(entry?.id || "").trim();
    const name = String(entry?.name || "").trim();
    const pattern = String(entry?.pattern || "").trim();
    if (!id || !name || !pattern || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name, pattern });
  }
  return out;
}

export function filenameTimeParts(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n < 0) return null;
  const whole = Math.floor(n);
  const ms = Math.floor((n - whole) * 1000);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  return {
    hours: String(h).padStart(2, "0"),
    minutes: String(m).padStart(2, "0"),
    seconds: String(s).padStart(2, "0"),
    milliseconds: String(ms).padStart(3, "0"),
  };
}

export function filenameTimeToken(seconds, format = DEFAULT_TIME_TOKEN_FORMAT, customFormats = []) {
  const parts = filenameTimeParts(seconds);
  if (!parts) return "";
  const { hours, minutes, seconds: secs, milliseconds } = parts;
  if (typeof format === "string" && format.startsWith("custom:")) {
    const id = format.slice("custom:".length);
    const custom = normalizeCustomTimeTokenFormats(customFormats).find((entry) => entry.id === id);
    if (custom) {
      return custom.pattern
        .replace(/\[ms\]/g, milliseconds)
        .replace(/\[hh\]/g, hours)
        .replace(/\[mm\]/g, minutes)
        .replace(/\[ss\]/g, secs)
        .replace(/\[milliseconds\]/g, milliseconds)
        .replace(/\[HH\]/g, hours)
        .replace(/\[MM\]/g, minutes)
        .replace(/\[SS\]/g, secs)
        .replace(/milliseconds/g, milliseconds)
        .replace(/HH/g, hours)
        .replace(/MM/g, minutes)
        .replace(/SS/g, secs);
    }
  }
  if (
    format === "[hh]-[mm]-[ss]-[ms]" ||
    format === "[HH]-[MM]-[SS]-[milliseconds]" ||
    format === "hh-mm-ss-mmm"
  ) {
    return `${hours}-${minutes}-${secs}-${milliseconds}`;
  }
  if (
    format === "[hh]:[mm]:[ss].[ms]" ||
    format === "[HH]:[MM]:[SS].[milliseconds]" ||
    format === "hh:mm:ss.mmm"
  ) {
    return `${hours}:${minutes}:${secs}.${milliseconds}`;
  }
  if (format === '[hh]:[mm]"[ss]' || format === '[HH]:[MM]"[SS]' || format === 'hh:mm"ss') {
    return `${hours}:${minutes}"${secs}`;
  }
  if (format === "[hh].[mm].[ss]" || format === "[HH].[MM].[SS]" || format === "hh.mm.ss") {
    return `${hours}.${minutes}.${secs}`;
  }
  return `${hours}.${minutes}.${secs}.${milliseconds}`;
}

export function filenameDatetimeParts(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  const year = String(d.getFullYear()).padStart(4, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");
  const seconds = String(d.getSeconds()).padStart(2, "0");
  const milliseconds = String(d.getMilliseconds()).padStart(3, "0");
  const offsetMinutes = -d.getTimezoneOffset();
  const offsetSign = offsetMinutes >= 0 ? "+" : "-";
  const offsetAbs = Math.abs(offsetMinutes);
  const offsetHours = String(Math.floor(offsetAbs / 60)).padStart(2, "0");
  const offsetMins = String(offsetAbs % 60).padStart(2, "0");
  const timezoneOffset = `${offsetSign}${offsetHours}:${offsetMins}`;
  const timezoneOffsetSafe = `${offsetSign}${offsetHours}.${offsetMins}`;
  return {
    year,
    shortYear: year.slice(-2),
    month,
    day,
    hours,
    minutes,
    seconds,
    milliseconds,
    timezoneOffset,
    timezoneOffsetSafe,
  };
}

function applyDatetimePattern(pattern, parts) {
  return String(pattern || "")
    .replace(/\[tzSafe\]/g, parts.timezoneOffsetSafe)
    .replace(/\[ms\]/g, parts.milliseconds)
    .replace(/\[yyyy\]/g, parts.year)
    .replace(/\[yy\]/g, parts.shortYear)
    .replace(/\[dd\]/g, parts.day)
    .replace(/\[hh\]/g, parts.hours)
    .replace(/\[ss\]/g, parts.seconds)
    .replace(/\[milliseconds\]/g, parts.milliseconds)
    .replace(/\[YYYY\]/g, parts.year)
    .replace(/\[YY\]/g, parts.shortYear)
    .replace(/\[MM\]/g, parts.month)
    .replace(/\[DD\]/g, parts.day)
    .replace(/\[HH\]/g, parts.hours)
    .replace(/\[mm\]/g, parts.minutes)
    .replace(/\[SS\]/g, parts.seconds)
    .replace(/milliseconds/g, parts.milliseconds)
    .replace(/YYYY/g, parts.year)
    .replace(/YY/g, parts.shortYear)
    .replace(/DD/g, parts.day)
    .replace(/HH/g, parts.hours)
    .replace(/SS/g, parts.seconds)
    .replace(/MM/g, parts.month)
    .replace(/mm/g, parts.minutes)
    .replace(/\[[^\]]+\]/g, "");
}

export function filenameDatetimeToken(
  date = new Date(),
  format = DEFAULT_DATETIME_TOKEN_FORMAT,
  customFormats = [],
) {
  const parts = filenameDatetimeParts(date);
  if (!parts) return "";
  if (typeof format === "string" && format.startsWith("custom:")) {
    const id = format.slice("custom:".length);
    const custom = normalizeCustomDatetimeTokenFormats(customFormats).find(
      (entry) => entry.id === id,
    );
    if (custom) return applyDatetimePattern(custom.pattern, parts);
  }
  if (
    format === "[yyyy]-[MM]-[dd]-[hh].[mm].[ss]" ||
    format === "[YYYY]-[MM]-[DD]-[HH].[mm].[SS]" ||
    format === "yyyy-mm-dd-hh.mm.ss"
  ) {
    return `${parts.year}-${parts.month}-${parts.day}-${parts.hours}.${parts.minutes}.${parts.seconds}`;
  }
  if (format === "[yyyy].[MM].[dd]" || format === "[YYYY].[MM].[DD]" || format === "yyyy.mm.dd") {
    return `${parts.year}.${parts.month}.${parts.day}`;
  }
  if (format === "[yyyy]-[MM]-[dd]" || format === "[YYYY]-[MM]-[DD]" || format === "yyyy-mm-dd") {
    return `${parts.year}-${parts.month}-${parts.day}`;
  }
  if (
    format === "[yyyy][MM][dd]-[hh][mm][ss]" ||
    format === "[YYYY][MM][DD]-[HH][mm][SS]" ||
    format === "yyyymmdd-hhmmss"
  ) {
    return `${parts.year}${parts.month}${parts.day}-${parts.hours}${parts.minutes}${parts.seconds}`;
  }
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hours}.${parts.minutes}.${parts.seconds}.${parts.milliseconds}${parts.timezoneOffsetSafe}`;
}

export function framePreviewKey(url, seconds) {
  const n = Number(seconds);
  const safeSeconds = Number.isFinite(n) && n > 0 ? n : 0;
  return `${url} @ ${safeSeconds.toFixed(3)}`;
}

export function rangePreviewTimestamp(seconds, duration = 0) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const d = Number(duration);
  if (Number.isFinite(d) && d > 0 && n >= d) {
    return Math.max(0, d - 0.05);
  }
  return n;
}

/**
 * @param {{ savedSeconds?: unknown, fallbackSeconds?: unknown, duration?: number }} opts
 */
export function resolveFrameTimestampPrefill({ savedSeconds, fallbackSeconds, duration = 0 } = {}) {
  if (savedSeconds !== null && savedSeconds !== undefined && savedSeconds !== "") {
    const saved = validateTimestamp(String(savedSeconds), duration);
    if (saved.ok) return frameTimestampPrefill(saved.seconds, duration);
  }
  return frameTimestampPrefill(fallbackSeconds, duration);
}

export function thumbnailPreviewState(thumbnailUrl, isYoutube, open = false) {
  const src = String(thumbnailUrl || "").trim();
  if (!src) {
    return { hidden: true, open: false, src: "" };
  }
  return { hidden: false, open: !!open, src };
}
