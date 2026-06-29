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

export function frameTimestampFilenameSuffix(seconds) {
  return formatTimestamp(seconds).replace(/:/g, "-");
}

export function framePreviewKey(url, seconds) {
  const n = Number(seconds);
  const safeSeconds = Number.isFinite(n) && n > 0 ? n : 0;
  return `${url} @ ${safeSeconds.toFixed(3)}`;
}
