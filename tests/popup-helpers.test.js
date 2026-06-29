import { describe, expect, it } from "vitest";
import { formatTimestamp, parseTimestamp, validateTimestamp } from "../extension/popup-helpers.js";

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
});
