import { describe, expect, it } from "vitest";
import {
  DATETIME_TOKEN_FORMAT_OPTIONS,
  DEFAULT_DATETIME_TOKEN_FORMAT,
  DEFAULT_TIME_TOKEN_FORMAT,
  TIME_TOKEN_FORMAT_OPTIONS,
  filenameDatetimeParts,
  filenameDatetimeToken,
  filenameTimeParts,
  filenameTimeToken,
  framePreviewKey,
  frameTimestampFilenameSuffix,
  frameTimestampPrefill,
  formatTimestamp,
  frameTimestampSelection,
  parseTimestamp,
  rangePreviewTimestamp,
  normalizeCustomTimeTokenFormats,
  resolveFrameTimestampPrefill,
  thumbnailPreviewState,
  validateTimestamp,
} from "../extension/popup-helpers.js";

describe("timestamp helpers", () => {
  it("parses numeric seconds", () => {
    expect(parseTimestamp("90")).toBe(90);
  });

  it("parses mm:ss", () => {
    expect(parseTimestamp("1:30")).toBe(90);
  });

  it("parses hh:mm:ss with milliseconds", () => {
    expect(parseTimestamp("01:02:03.500")).toBe(3723.5);
  });

  it("rejects invalid, negative, and out-of-duration values", () => {
    expect(validateTimestamp("nope", 120).ok).toBe(false);
    expect(validateTimestamp("-1", 120).ok).toBe(false);
    expect(validateTimestamp("121", 120).ok).toBe(false);
  });

  it("formats seconds for filenames and inputs", () => {
    expect(formatTimestamp(90)).toBe("1:30");
    expect(formatTimestamp(3723.5)).toBe("1:02:03.500");
  });

  it("prefills frame timestamps from bounded video time", () => {
    expect(frameTimestampPrefill(42.25, 120)).toEqual({
      seconds: 42.25,
      label: "0:42.250",
      sliderValue: "42",
    });
    expect(frameTimestampPrefill(150, 120)).toEqual({
      seconds: 120,
      label: "2:00",
      sliderValue: "120",
    });
    expect(frameTimestampPrefill(-1, 120)).toEqual({
      seconds: 0,
      label: "0:00",
      sliderValue: "0",
    });
  });

  it("formats frame filename suffixes from timestamps", () => {
    expect(frameTimestampFilenameSuffix(0)).toBe("0-00");
    expect(frameTimestampFilenameSuffix(83.5)).toBe("1-23.500");
    expect(frameTimestampFilenameSuffix(3723.25)).toBe("1-02-03.250");
  });

  it("formats filename time tokens as [hh].[mm].[ss].[ms]", () => {
    expect(filenameTimeToken(0)).toBe("00.00.00.000");
    expect(filenameTimeToken(83.5)).toBe("00.01.23.500");
    expect(filenameTimeToken(3723.25)).toBe("01.02.03.250");
    expect(DEFAULT_TIME_TOKEN_FORMAT).toBe("[hh].[mm].[ss].[ms]");
  });

  it("formats filename time tokens with the selected format", () => {
    expect(TIME_TOKEN_FORMAT_OPTIONS.map((o) => o.value)).toContain('[hh]:[mm]"[ss]');
    expect(filenameTimeToken(3723.25, "[hh]-[mm]-[ss]-[ms]")).toBe("01-02-03-250");
    expect(filenameTimeToken(3723.25, "[hh]:[mm]:[ss].[ms]")).toBe("01:02:03.250");
    expect(filenameTimeToken(3723.25, '[hh]:[mm]"[ss]')).toBe('01:02"03');
    expect(filenameTimeToken(3723.25, "[hh].[mm].[ss]")).toBe("01.02.03");
  });

  it("formats filename time tokens with custom patterns", () => {
    const custom = [{ id: "compact", name: "Compact", pattern: "[hh]_[mm]_[ss]_[ms]" }];
    expect(filenameTimeToken(3723.25, "custom:compact", custom)).toBe("01_02_03_250");
    expect(filenameTimeToken(3723.25, "custom:missing", custom)).toBe("01.02.03.250");
  });

  it("normalizes custom time token formats", () => {
    expect(
      normalizeCustomTimeTokenFormats([
        { id: "a", name: "Readable", pattern: '[HH].[MM]"[SS]' },
        { id: "a", name: "Duplicate", pattern: "[HH]" },
        { id: "b", name: "", pattern: "[MM]" },
      ]),
    ).toEqual([{ id: "a", name: "Readable", pattern: '[HH].[MM]"[SS]' }]);
  });

  it("formats datetime tokens with local datetime parts", () => {
    const date = new Date(2026, 7, 18, 17, 49, 4, 125);
    expect(filenameDatetimeParts(date)).toEqual({
      year: "2026",
      shortYear: "26",
      month: "08",
      day: "18",
      hours: "17",
      minutes: "49",
      seconds: "04",
      milliseconds: "125",
      timezoneOffset: "-04:00",
      timezoneOffsetSafe: "-04.00",
    });
    expect(DEFAULT_DATETIME_TOKEN_FORMAT).toBe("[yyyy]-[MM]-[dd]T[hh].[mm].[ss].[ms][tzSafe]");
    expect(filenameDatetimeToken(date)).toBe("2026-08-18T17.49.04.125-04.00");
  });

  it("formats datetime tokens with selected and custom formats", () => {
    const date = new Date(2026, 7, 18, 17, 49, 4, 125);
    const custom = [
      {
        id: "readable",
        name: "Readable",
        pattern: "[yyyy]-[MM]-[dd] [hh]-[mm]-[ss]-[ms]",
      },
      {
        id: "removed-tz",
        name: "Removed timezone",
        pattern: "[yyyy]-[MM]-[dd]T[hh].[mm].[ss].[ms][tz]",
      },
    ];
    expect(DATETIME_TOKEN_FORMAT_OPTIONS.map((o) => o.value)).toContain(
      "[yyyy][MM][dd]-[hh][mm][ss]",
    );
    expect(DATETIME_TOKEN_FORMAT_OPTIONS.map((o) => o.value)).not.toContain(
      "[yyyy]-[MM]-[dd]T[hh]:[mm]:[ss].[ms][tz]",
    );
    expect(filenameDatetimeToken(date, "[yyyy]-[MM]-[dd]-[hh].[mm].[ss]")).toBe(
      "2026-08-18-17.49.04",
    );
    expect(filenameDatetimeToken(date, "custom:removed-tz", custom)).toBe(
      "2026-08-18T17.49.04.125",
    );
    expect(filenameDatetimeToken(date, "[yyyy][MM][dd]-[hh][mm][ss]")).toBe("20260818-174904");
    expect(filenameDatetimeToken(date, "custom:readable", custom)).toBe("2026-08-18 17-49-04-125");
    expect(filenameDatetimeToken(date, "custom:missing", custom)).toBe(
      "2026-08-18T17.49.04.125-04.00",
    );
  });

  it("returns filename time segments for custom tokens", () => {
    expect(filenameTimeParts(3723.25)).toEqual({
      hours: "01",
      minutes: "02",
      seconds: "03",
      milliseconds: "250",
    });
    expect(filenameTimeParts(-1)).toBeNull();
  });

  it("keys frame previews by url and timestamp", () => {
    expect(framePreviewKey("https://youtu.be/abc", 12.4)).toBe("https://youtu.be/abc @ 12.400");
  });

  it("seeks range end previews just before the video duration", () => {
    expect(rangePreviewTimestamp(120, 120)).toBeCloseTo(119.95);
    expect(rangePreviewTimestamp(60, 120)).toBe(60);
  });

  it("prefers a valid saved frame timestamp over the auto-fetch timestamp", () => {
    expect(
      resolveFrameTimestampPrefill({ savedSeconds: 12.5, fallbackSeconds: 42, duration: 120 }),
    ).toEqual({
      seconds: 12.5,
      label: "0:12.500",
      sliderValue: "12",
    });
  });

  it("falls back when the saved frame timestamp is invalid for the video", () => {
    expect(
      resolveFrameTimestampPrefill({ savedSeconds: 150, fallbackSeconds: 42, duration: 120 }),
    ).toEqual({
      seconds: 42,
      label: "0:42",
      sliderValue: "42",
    });
  });

  it("builds slider and input values for a current video frame", () => {
    expect(frameTimestampSelection(83.5, 120)).toEqual({
      seconds: 83.5,
      label: "1:23.500",
      sliderValue: "83",
    });
    expect(frameTimestampSelection(130, 120)).toEqual({
      seconds: 120,
      label: "2:00",
      sliderValue: "120",
    });
  });
});

describe("thumbnail preview helpers", () => {
  it("renders a collapsed YouTube thumbnail preview when a thumbnail is available", () => {
    expect(thumbnailPreviewState("https://i.ytimg.com/vi/abc/maxresdefault.jpg", true)).toEqual({
      hidden: false,
      open: false,
      src: "https://i.ytimg.com/vi/abc/maxresdefault.jpg",
    });
  });

  it("hides the thumbnail preview only without a thumbnail", () => {
    expect(thumbnailPreviewState("", true).hidden).toBe(true);
    expect(thumbnailPreviewState("https://example.test/thumb.jpg", false).hidden).toBe(false);
  });
});
