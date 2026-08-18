// Unit tests for the pure helpers in extension/shared.js.
// These functions have been in production for months without any
// coverage; the CODE_REVIEW called them out as the first thing to
// seed (§6). Each test is round-trip against known inputs — no
// DOM, no fetch, no mocks.

import { describe, it, expect } from "vitest";
import {
  shortcodeToMediaId,
  computeSyndicationToken,
  basenameFromUrl,
  extensionFromUrl,
  sanitizeFilenameSegment,
  resolveFilenameMode,
  resolveMultipleFilenameMode,
  resolveRangeFilenameMode,
  resolveThumbnailFilenameMode,
  resolveFrameFilenameMode,
  migrateFilenameSettings,
  buildSafeFilename,
  sanitizeLooseFilename,
  normalizeHandle,
  pickHandleText,
  DEFAULT_FILENAME_SCHEME,
  DEFAULT_MULTIPLE_FILENAME_SCHEME,
  DEFAULT_RANGE_FILENAME_SCHEME,
  DEFAULT_THUMBNAIL_FILENAME_SCHEME,
  DEFAULT_FRAME_FILENAME_SCHEME,
  DEFAULT_BEST_AVAILABLE_MAX_HEIGHT,
  BEST_AVAILABLE_MAX_HEIGHT_OPTIONS,
  filenameSchemeOptions,
  applyFilenameTemplate,
  sourceTokenFromUrl,
  resolveBestAvailableMaxHeight,
  WIN_RESERVED,
  isKnownHost,
  SUPPORTED_HOSTS,
  IG_APP_ID,
} from "../extension/shared.js";

describe("shortcodeToMediaId", () => {
  it("decodes a known Instagram shortcode to its media_id", () => {
    // Instagram's canonical test case: shortcode "B" → BigInt(1).
    expect(shortcodeToMediaId("B")).toBe("1");
    // "BA" → (0 << 6) + 0 then (0 << 6) + 26 = 26 — wait, "B" is
    // index 1, "A" is index 0 → 1<<6 + 0 = 64.
    expect(shortcodeToMediaId("BA")).toBe("64");
    // Longer shortcode; verify it stays positive and numeric.
    const result = shortcodeToMediaId("BL_NjLgA_Iy");
    expect(result).toMatch(/^\d+$/);
    expect(BigInt(result) > 0n).toBe(true);
  });

  it("returns empty string for characters outside the alphabet", () => {
    expect(shortcodeToMediaId("B!")).toBe("");
    expect(shortcodeToMediaId("B#foo")).toBe("");
  });

  it("handles empty input as BigInt 0", () => {
    expect(shortcodeToMediaId("")).toBe("0");
  });

  it("overflows Number's safe-integer range cleanly via BigInt", () => {
    // A 12-character shortcode encodes 72 bits — well past 2^53.
    const result = shortcodeToMediaId("CzAbCdEfGhIj");
    expect(result).toMatch(/^\d+$/);
    expect(BigInt(result) > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
  });
});

describe("computeSyndicationToken", () => {
  it("derives a short lowercase-ish token from a tweet id", () => {
    const token = computeSyndicationToken("1234567890123456789");
    expect(typeof token).toBe("string");
    // The algorithm strips "0" and "." from the base-36 encoding, so
    // the result must never contain either.
    expect(token).not.toMatch(/[0.]/);
    expect(token.length).toBeGreaterThan(0);
  });

  it("is deterministic for the same id", () => {
    const a = computeSyndicationToken("1576615422987685888");
    const b = computeSyndicationToken("1576615422987685888");
    expect(a).toBe(b);
  });

  it("differs between different ids", () => {
    const a = computeSyndicationToken("1576615422987685888");
    const b = computeSyndicationToken("2034068093295575098");
    expect(a).not.toBe(b);
  });
});

describe("basenameFromUrl", () => {
  it("returns the last path segment", () => {
    expect(basenameFromUrl("https://cdn.example.com/path/to/photo.jpg")).toBe("photo.jpg");
    expect(basenameFromUrl("https://cdn.example.com/a/b/c/d.mp4?q=1")).toBe("d.mp4");
  });

  it("falls back to 'image' for root / malformed URLs", () => {
    expect(basenameFromUrl("https://cdn.example.com/")).toBe("image");
    expect(basenameFromUrl("not a url")).toBe("image");
    expect(basenameFromUrl("")).toBe("image");
  });
});

describe("extensionFromUrl", () => {
  it("returns the lowercased extension", () => {
    expect(extensionFromUrl("https://example.com/a.JPG")).toBe("jpg");
    expect(extensionFromUrl("https://example.com/a.jpeg")).toBe("jpeg");
    expect(extensionFromUrl("https://example.com/a.mp4?q=x")).toBe("mp4");
  });

  it("returns empty string when there's no extension", () => {
    expect(extensionFromUrl("https://example.com/no-ext")).toBe("");
    expect(extensionFromUrl("https://example.com/")).toBe("");
    expect(extensionFromUrl("malformed")).toBe("");
  });

  it("caps at 5 chars so query strings full of dots don't match", () => {
    expect(extensionFromUrl("https://x.y/a.toolongext")).toBe("");
  });
});

describe("sanitizeFilenameSegment", () => {
  it("replaces Windows-reserved characters with underscore", () => {
    expect(sanitizeFilenameSegment('a/b\\c:d*e?f"g<h>i|j')).toBe("a_b_c_d_e_f_g_h_i_j");
  });

  it("drops control characters entirely", () => {
    expect(sanitizeFilenameSegment("foo\x00bar\x1fbaz")).toBe("foobarbaz");
  });

  it("collapses space runs, drops control-char whitespace", () => {
    // Tabs and newlines are in the \x00–\x1f control-char range, so
    // they're stripped outright (not folded into a space). Runs of
    // literal spaces then collapse to one.
    expect(sanitizeFilenameSegment("hello    world\n\ttest")).toBe("hello worldtest");
    expect(sanitizeFilenameSegment("a   b")).toBe("a b");
  });

  it("trims leading / trailing spaces and trailing dots", () => {
    expect(sanitizeFilenameSegment("  hello  ")).toBe("hello");
    expect(sanitizeFilenameSegment("file.name...")).toBe("file.name");
  });

  it("stringifies non-string input so .replace doesn't throw", () => {
    // @ts-ignore — intentionally calling with a number.
    expect(sanitizeFilenameSegment(42)).toBe("42");
  });
});

describe("IG_APP_ID constant", () => {
  it("is the numeric Instagram-web client ID", () => {
    expect(IG_APP_ID).toBe("936619743392459");
  });
});

describe("resolveFilenameMode", () => {
  it("uses filenameMode when present", () => {
    expect(resolveFilenameMode({ filenameMode: "title" })).toBe("title");
  });
  it("falls back to galleryFilenameMode when filenameMode is missing", () => {
    expect(resolveFilenameMode({ galleryFilenameMode: "sequential" })).toBe("sequential");
  });
  it("falls back to imageFilenameMode last (gallery wins over image)", () => {
    expect(
      resolveFilenameMode({ imageFilenameMode: "title", galleryFilenameMode: "original" }),
    ).toBe("original");
    expect(resolveFilenameMode({ imageFilenameMode: "original" })).toBe("original");
  });
  it("returns the modern default when nothing is set", () => {
    expect(resolveFilenameMode({})).toBe(DEFAULT_FILENAME_SCHEME);
  });
  it("translates the legacy 'default' sentinel to the modern default", () => {
    expect(resolveFilenameMode({ filenameMode: "default" })).toBe(DEFAULT_FILENAME_SCHEME);
    expect(resolveFilenameMode({ galleryFilenameMode: "default" })).toBe(DEFAULT_FILENAME_SCHEME);
  });
});

describe("resolveRangeFilenameMode", () => {
  it("uses the range filename mode when present", () => {
    expect(resolveRangeFilenameMode({ filenameMode: "title", rangeFilenameMode: "custom:a" })).toBe(
      "custom:a",
    );
  });

  it("uses the range default instead of the shared filename mode", () => {
    expect(resolveRangeFilenameMode({ filenameMode: "title" })).toBe(DEFAULT_RANGE_FILENAME_SCHEME);
  });
});

describe("filename mode defaults", () => {
  it("resolves separate default modes by download type", () => {
    expect(resolveFilenameMode({})).toBe(DEFAULT_FILENAME_SCHEME);
    expect(resolveMultipleFilenameMode({})).toBe(DEFAULT_MULTIPLE_FILENAME_SCHEME);
    expect(resolveThumbnailFilenameMode({})).toBe(DEFAULT_THUMBNAIL_FILENAME_SCHEME);
    expect(resolveFrameFilenameMode({})).toBe(DEFAULT_FRAME_FILENAME_SCHEME);
  });

  it("scopes range and video-image presets to their own dropdowns", () => {
    const normal = filenameSchemeOptions([], {
      includeGalleryOnly: false,
      includeOriginal: false,
    }).map((o) => o.value);
    expect(normal).not.toContain(DEFAULT_RANGE_FILENAME_SCHEME);
    expect(normal).not.toContain(DEFAULT_THUMBNAIL_FILENAME_SCHEME);
    expect(normal).not.toContain(DEFAULT_FRAME_FILENAME_SCHEME);

    const range = filenameSchemeOptions([], {
      includeGalleryOnly: false,
      includeOriginal: false,
      includeRangeOnly: true,
    }).map((o) => o.value);
    expect(range).toContain(DEFAULT_RANGE_FILENAME_SCHEME);

    const videoImage = filenameSchemeOptions([], {
      includeGalleryOnly: false,
      includeOriginal: false,
      includeVideoImageOnly: true,
    }).map((o) => o.value);
    expect(videoImage).toContain(DEFAULT_THUMBNAIL_FILENAME_SCHEME);
    expect(videoImage).toContain(DEFAULT_FRAME_FILENAME_SCHEME);
  });
});

describe("best available quality limits", () => {
  it("defaults to no cap and accepts only supported slider stops", () => {
    expect(DEFAULT_BEST_AVAILABLE_MAX_HEIGHT).toBe(0);
    expect(BEST_AVAILABLE_MAX_HEIGHT_OPTIONS.map((o) => o.value)).toEqual([
      0, 480, 720, 1080, 1440, 2160, 4320,
    ]);
    expect(resolveBestAvailableMaxHeight(1080)).toBe(1080);
    expect(resolveBestAvailableMaxHeight("2160")).toBe(2160);
    expect(resolveBestAvailableMaxHeight(999)).toBe(DEFAULT_BEST_AVAILABLE_MAX_HEIGHT);
  });
});

describe("filename source tokens", () => {
  it("uses x.com for Twitter/X URLs", () => {
    expect(sourceTokenFromUrl("https://twitter.com/user/status/1")).toBe("x.com");
    expect(sourceTokenFromUrl("https://x.com/user/status/1")).toBe("x.com");
  });

  it("uses the site name without .com for other .com hosts", () => {
    expect(sourceTokenFromUrl("https://www.reddit.com/r/test")).toBe("reddit");
    expect(sourceTokenFromUrl("https://facebook.com/watch/1")).toBe("facebook");
  });

  it("applies title, poster, source, index, range time, and frame tokens", () => {
    expect(
      applyFilenameTemplate(
        "[@Poster] -- [Title] -- [Source] - [Index] -- S([Start Time]) -- E([End Time]) -- FRAME([Frame Time]) -- [Frame Number]",
        {
          title: "Post",
          poster: "@user",
          source: "x.com",
          index: "02",
          startTime: "00.00.10.000",
          endTime: "00.00.30.000",
          frameTime: "00.00.15.500",
          frameNumber: "465",
        },
      ),
    ).toBe(
      "@user -- Post -- x.com - 02 -- S(00.00.10.000) -- E(00.00.30.000) -- FRAME(00.00.15.500) -- 465",
    );
  });

  it("applies time-segment tokens and falls back to empty values", () => {
    expect(
      applyFilenameTemplate(
        "[Title] -- H[Hours] M[Minutes] S[Seconds] MS[Milliseconds] -- S([Start Hours].[Start Minutes].[Start Seconds]) -- E([End Hours].[End Minutes].[End Seconds])",
        {
          title: "Post",
          hours: "00",
          minutes: "01",
          seconds: "23",
          milliseconds: "500",
          startHours: "00",
          startMinutes: "00",
          startSeconds: "10",
          endHours: "00",
          endMinutes: "00",
          endSeconds: "30",
        },
      ),
    ).toBe("Post -- H00 M01 S23 MS500 -- S(00.00.10) -- E(00.00.30)");
  });

  it("drops unresolved bracket tokens instead of leaving them in filenames", () => {
    expect(
      applyFilenameTemplate("[Title] -- [Missing Token] -- FRAME[Frame Number]", {
        title: "Post",
      }),
    ).toBe("Post -- FRAME");
  });
});

describe("buildSafeFilename", () => {
  it("composes a base + ext into a safe filename", () => {
    expect(buildSafeFilename("My Video", "mp4")).toBe("My Video.mp4");
  });
  it("strips reserved chars before composing", () => {
    expect(buildSafeFilename("a/b:c", "jpg")).toBe("a_b_c.jpg");
  });
  it("appends a suffix that survives base clipping at the 150-char budget", () => {
    const longBase = "x".repeat(200);
    const out = buildSafeFilename(longBase, "jpg", " 01");
    // "x"*147 + " 01" + ".jpg" — the last visible chars must be the index.
    expect(out.endsWith(" 01.jpg")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(150 + ".jpg".length);
  });
  it("returns empty string for empty input — callers pick their fallback", () => {
    expect(buildSafeFilename("", "jpg")).toBe("");
    expect(buildSafeFilename(null, "jpg")).toBe("");
  });
  it("prefixes underscore on Windows-reserved device names", () => {
    expect(buildSafeFilename("CON", "txt")).toBe("_CON.txt");
    expect(buildSafeFilename("aux", "log")).toBe("_aux.log");
  });
});

describe("sanitizeLooseFilename", () => {
  it("returns the cleaned filename intact when safe", () => {
    expect(sanitizeLooseFilename("photo.jpg")).toBe("photo.jpg");
  });
  it("replaces reserved chars with underscores", () => {
    expect(sanitizeLooseFilename("a*b?c.jpg")).toBe("a_b_c.jpg");
  });
  it("falls back to 'file' on empty input", () => {
    expect(sanitizeLooseFilename("")).toBe("file");
    expect(sanitizeLooseFilename(null)).toBe("file");
  });
  it("clips to 200 chars", () => {
    const out = sanitizeLooseFilename("x".repeat(300));
    expect(out.length).toBeLessThanOrEqual(200);
  });
  it("prefixes underscore on Windows-reserved device names", () => {
    expect(sanitizeLooseFilename("nul.txt")).toBe("_nul.txt");
  });
});

describe("normalizeHandle", () => {
  it("prepends @ when missing", () => {
    expect(normalizeHandle("user")).toBe("@user");
  });
  it("preserves @ when already present", () => {
    expect(normalizeHandle("@user")).toBe("@user");
  });
  it("returns empty string on empty / whitespace input", () => {
    expect(normalizeHandle("")).toBe("");
    expect(normalizeHandle("   ")).toBe("");
    expect(normalizeHandle(null)).toBe("");
  });
});

describe("pickHandleText", () => {
  it("prefers uploader_id when it's a real handle", () => {
    expect(pickHandleText("RickAstleyYT", "Rick Astley")).toBe("@RickAstleyYT");
  });
  it("rejects purely-numeric uploader_id and falls back to uploader", () => {
    expect(pickHandleText("1234567890", "John Smith")).toBe("@John Smith");
  });
  it("returns empty when both are missing", () => {
    expect(pickHandleText("", "")).toBe("");
  });
});

describe("isKnownHost", () => {
  it("matches every entry in SUPPORTED_HOSTS exactly", () => {
    for (const host of SUPPORTED_HOSTS) {
      expect(isKnownHost(`https://${host}/foo`)).toBe(true);
    }
  });
  it("matches subdomains of supported hosts", () => {
    expect(isKnownHost("https://www.youtube.com/watch?v=x")).toBe(true);
    expect(isKnownHost("https://m.facebook.com/123")).toBe(true);
    expect(isKnownHost("https://i.redd.it/abc.jpg")).toBe(true);
  });
  it("rejects unrelated hosts", () => {
    expect(isKnownHost("https://news.ycombinator.com/")).toBe(false);
    expect(isKnownHost("https://example.com/page")).toBe(false);
  });
  it("does NOT match mere suffix overlaps (no dot boundary)", () => {
    // "evilyoutube.com" is not a subdomain of youtube.com.
    expect(isKnownHost("https://evilyoutube.com/x")).toBe(false);
    expect(isKnownHost("https://nottiktok.com/x")).toBe(false);
  });
  it("returns false on empty / invalid input", () => {
    expect(isKnownHost("")).toBe(false);
    expect(isKnownHost(null)).toBe(false);
    expect(isKnownHost("not a url")).toBe(false);
  });
});

describe("WIN_RESERVED", () => {
  it("matches the canonical reserved names with optional ext", () => {
    expect(WIN_RESERVED.test("CON")).toBe(true);
    expect(WIN_RESERVED.test("con.txt")).toBe(true);
    expect(WIN_RESERVED.test("LPT1")).toBe(true);
    expect(WIN_RESERVED.test("com5.log")).toBe(true);
  });
  it("does not match safe names", () => {
    expect(WIN_RESERVED.test("connie")).toBe(false);
    expect(WIN_RESERVED.test("auxiliary")).toBe(false);
    expect(WIN_RESERVED.test("photo.jpg")).toBe(false);
  });
});

describe("migrateFilenameSettings", () => {
  it("returns null when storage is already on the modern shape", () => {
    expect(migrateFilenameSettings({ filenameMode: "title" })).toBeNull();
  });

  it("collapses split image+gallery keys into the unified key, preferring gallery", () => {
    const out = migrateFilenameSettings({
      imageFilenameMode: "title",
      galleryFilenameMode: "original",
      saveMode: "ask",
    });
    expect(out).toEqual({
      filenameMode: "original",
      multipleFilenameMode: "original",
      saveMode: "ask",
    });
    expect(out.imageFilenameMode).toBeUndefined();
    expect(out.galleryFilenameMode).toBeUndefined();
  });

  it("migrates the very-old useOriginalFilenames boolean (true → original)", () => {
    expect(migrateFilenameSettings({ useOriginalFilenames: true })).toEqual({
      filenameMode: "original",
      multipleFilenameMode: "original",
    });
  });

  it("migrates the very-old useOriginalFilenames boolean (false → sequential)", () => {
    expect(migrateFilenameSettings({ useOriginalFilenames: false })).toEqual({
      filenameMode: "sequential",
      multipleFilenameMode: "sequential",
    });
  });

  it("seeds filenameMode on a fresh install (empty settings)", () => {
    expect(migrateFilenameSettings({})).toEqual({ filenameMode: DEFAULT_FILENAME_SCHEME });
  });

  it("migrates the legacy video range filename setting", () => {
    expect(migrateFilenameSettings({ videoRangeFilenameMode: "title" })).toEqual({
      filenameMode: DEFAULT_FILENAME_SCHEME,
      rangeFilenameMode: "title",
    });
  });

  it("preserves unrelated settings keys", () => {
    const out = migrateFilenameSettings({
      imageFilenameMode: "title",
      twitterCookiesMode: "always",
      destinationDir: "/foo",
    });
    expect(out.twitterCookiesMode).toBe("always");
    expect(out.destinationDir).toBe("/foo");
    expect(out.filenameMode).toBe("title");
  });
});
