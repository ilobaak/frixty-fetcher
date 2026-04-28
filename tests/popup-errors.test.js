// Unit tests for the pure-ish error-mapping helpers in
// extension/popup-errors.js. These functions previously lived in
// popup.js's module-level scope, reading tabUrl and cookies state
// directly — now they take an explicit context object so they can
// be exercised here without mocking chrome.* or DOM.

import { describe, it, expect } from "vitest";
import {
  detectCurrentSite,
  friendlyError,
  prettifyYtdlpError,
} from "../extension/popup-errors.js";

describe("detectCurrentSite", () => {
  it("classifies x.com / twitter.com hosts as twitter", () => {
    expect(detectCurrentSite("https://x.com/elon/status/1")).toBe("twitter");
    expect(detectCurrentSite("https://twitter.com/elon/status/1")).toBe("twitter");
    expect(detectCurrentSite("https://mobile.x.com/elon/status/1")).toBe("twitter");
  });
  it("classifies youtube hosts as youtube", () => {
    expect(detectCurrentSite("https://www.youtube.com/watch?v=abc")).toBe("youtube");
    expect(detectCurrentSite("https://m.youtube.com/watch?v=abc")).toBe("youtube");
    expect(detectCurrentSite("https://youtu.be/abc")).toBe("youtube");
  });
  it("returns empty for unrecognized sites", () => {
    expect(detectCurrentSite("https://reddit.com/r/x")).toBe("");
    expect(detectCurrentSite("https://example.com/page")).toBe("");
  });
  it("returns empty on missing or malformed URL", () => {
    expect(detectCurrentSite("")).toBe("");
    expect(detectCurrentSite(null)).toBe("");
    expect(detectCurrentSite("not a url")).toBe("");
  });
});

describe("prettifyYtdlpError", () => {
  it("returns the canonical fallback for empty input", () => {
    expect(prettifyYtdlpError("")).toMatch(/yt-dlp reported an error/);
    expect(prettifyYtdlpError(null)).toMatch(/yt-dlp reported an error/);
  });

  it("strips trailing exit-status noise", () => {
    const out = prettifyYtdlpError("ERROR: video unavailable (exit status 1)");
    expect(out).not.toMatch(/exit status/);
    expect(out).toMatch(/private, removed, or unavailable/);
  });

  it("strips ERROR: prefix and extractor tag", () => {
    const out = prettifyYtdlpError("ERROR: [twitter] private video");
    expect(out).not.toMatch(/^ERROR:/);
    expect(out).toMatch(/private, removed, or unavailable/);
  });

  it("rewrites login-required errors into actionable advice", () => {
    const out = prettifyYtdlpError("ERROR: Login required to view content", {
      tabUrl: "https://twitter.com/x/status/1",
    });
    expect(out).toMatch(/Login required/i);
    expect(out).toMatch(/twitter/);
  });

  it("rewrites rate-limit errors", () => {
    expect(prettifyYtdlpError("HTTP Error 429 Too Many Requests")).toMatch(/rate-limited/);
  });

  it("rewrites unsupported-URL errors", () => {
    expect(prettifyYtdlpError("Unsupported URL: https://foo")).toMatch(
      /doesn't recognize this URL/,
    );
  });

  it("recognizes the silent-failure invocation shape", () => {
    const raw = "exit status 1 — yt-dlp emitted no diagnostic. Invocation: yt-dlp -f best https://x";
    const out = prettifyYtdlpError(raw);
    expect(out).toMatch(/didn't say why/);
    expect(out).toMatch(/yt-dlp -f best/);
  });

  it("falls back to the verbatim body when nothing matches", () => {
    expect(prettifyYtdlpError("ERROR: weird new failure mode (exit status 7)")).toBe(
      "weird new failure mode",
    );
  });

  it("translates a bare exit-status into a rebuild hint", () => {
    expect(prettifyYtdlpError("exit status 1")).toMatch(/Rebuild the native host/);
  });
});

describe("friendlyError", () => {
  it("maps ytdlp_missing to a clear install hint", () => {
    const out = friendlyError({ code: "ytdlp_missing" });
    expect(out.severity).toBe("error");
    expect(out.title).toBe("yt-dlp not found");
    expect(out.detail).toMatch(/PATH/);
  });

  it("maps download_canceled to an info-tier blank detail", () => {
    const out = friendlyError({ code: "download_canceled" });
    expect(out.severity).toBe("info");
    expect(out.title).toBe("Download canceled");
    expect(out.detail).toBe("");
  });

  it("maps download_failed through prettifyYtdlpError", () => {
    const out = friendlyError({
      code: "download_failed",
      message: "ERROR: HTTP Error 429",
    });
    expect(out.severity).toBe("error");
    expect(out.title).toBe("Download failed");
    expect(out.detail).toMatch(/rate-limited/);
  });

  it("specializes listformats_failed for Twitter when no cookies tried yet", () => {
    const out = friendlyError(
      { code: "listformats_failed" },
      { tabUrl: "https://x.com/elon/status/1", triedCookies: false, cookiesMode: "auto" },
    );
    expect(out.severity).toBe("info");
    expect(out.title).toBe("Unable to download");
    expect(out.detail).toMatch(/Twitter/);
    expect(out.detail).toMatch(/age-restricted|private/);
  });

  it("specializes listformats_failed for YouTube + cookies disabled", () => {
    const out = friendlyError(
      { code: "no_formats" },
      {
        tabUrl: "https://www.youtube.com/watch?v=x",
        triedCookies: false,
        cookiesMode: "never",
      },
    );
    expect(out.detail).toMatch(/YouTube/);
    expect(out.detail).toMatch(/cookies setting/);
  });

  it("after both auto + cookies retry exhausted, surfaces the deleted/expired hint", () => {
    const out = friendlyError(
      { code: "listformats_failed" },
      { tabUrl: "https://x.com/x/status/1", triedCookies: true, cookiesMode: "auto" },
    );
    expect(out.detail).toMatch(/even using your browser cookies/);
  });

  it("falls back to the generic 'Unable to download' for unrecognized sites", () => {
    const out = friendlyError(
      { code: "listformats_failed" },
      { tabUrl: "https://reddit.com/r/x", triedCookies: false, cookiesMode: "auto" },
    );
    expect(out.detail).toBe(
      "Unable to download media on this page. Try a different page or double-check the URL.",
    );
  });

  it("uses the raw host message when the code carries one (bad_destdir)", () => {
    const out = friendlyError({ code: "bad_destdir", message: "/nope: not writable" });
    expect(out.detail).toBe("/nope: not writable");
  });

  it("falls back to a default branch for unknown codes", () => {
    const out = friendlyError({ code: "totally_made_up", message: "boom" });
    expect(out.title).toBe("Something went wrong");
    expect(out.detail).toBe("boom");
  });
});
