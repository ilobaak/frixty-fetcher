import { describe, expect, it } from "vitest";
import {
  filenameTimeToken,
  framePreviewKey,
  frameTimestampFilenameSuffix,
  frameTimestampPrefill,
  formatTimestamp,
  frameTimestampSelection,
  parseTimestamp,
  rangePreviewTimestamp,
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

  it("formats filename time tokens as HH.MM.SS.milliseconds", () => {
    expect(filenameTimeToken(0)).toBe("00.00.00.000");
    expect(filenameTimeToken(83.5)).toBe("00.01.23.500");
    expect(filenameTimeToken(3723.25)).toBe("01.02.03.250");
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
