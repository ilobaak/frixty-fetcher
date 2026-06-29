// @ts-check

const URL_FIELD_RE = /(^url$|url$|Url$|URL$)/;

export function summarizeUrl(value) {
  if (!value) return "";
  const raw = String(value);
  try {
    const u = new URL(raw);
    const path = u.pathname.length > 72 ? `${u.pathname.slice(0, 72)}...` : u.pathname;
    const query = [];
    for (const key of u.searchParams.keys()) {
      query.push(`${key}=<redacted>`);
    }
    return `${u.origin}${path}${query.length ? `?${query.join("&")}` : ""}`;
  } catch {
    return raw.length > 100 ? `${raw.slice(0, 100)}...` : raw;
  }
}

function sanitizeValue(key, value) {
  if (typeof value === "string" && URL_FIELD_RE.test(key)) return summarizeUrl(value);
  if (Array.isArray(value)) return value.map((v) => sanitizeValue(key, v));
  if (value && typeof value === "object") return sanitizePayload(value);
  return value;
}

export function sanitizePayload(payload) {
  if (!payload || typeof payload !== "object") return payload;
  const out = {};
  for (const [key, value] of Object.entries(payload)) {
    out[key] = sanitizeValue(key, value);
  }
  return out;
}

export function logFetcher(site, step, payload = undefined) {
  const prefix = `[frixty/${site}]`;
  if (payload === undefined) {
    console.log(prefix, step);
    return;
  }
  console.log(prefix, step, sanitizePayload(payload));
}
