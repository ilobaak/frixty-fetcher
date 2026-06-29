import { describe, expect, it, vi } from "vitest";
import { logFetcher, summarizeUrl } from "../extension/fetcher-log.js";

describe("summarizeUrl", () => {
  it("keeps origin and path while redacting query values", () => {
    expect(
      summarizeUrl("https://video.twimg.com/ext_tw_video/abc.mp4?token=secret&sig=private"),
    ).toBe("https://video.twimg.com/ext_tw_video/abc.mp4?token=<redacted>&sig=<redacted>");
  });

  it("clips very long paths", () => {
    const longUrl = `https://i.redd.it/${"a".repeat(140)}.jpg`;
    const out = summarizeUrl(longUrl);
    expect(out.startsWith("https://i.redd.it/")).toBe(true);
    expect(out.length).toBeLessThan(120);
    expect(out).toContain("...");
  });

  it("leaves invalid inputs as short strings", () => {
    expect(summarizeUrl("not a url")).toBe("not a url");
    expect(summarizeUrl(null)).toBe("");
  });
});

describe("logFetcher", () => {
  it("prefixes site logs and redacts url-like fields", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logFetcher("reddit", "picked", {
      url: "https://preview.redd.it/photo.jpg?width=960&token=secret",
      count: 2,
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe("[frixty/reddit]");
    expect(spy.mock.calls[0][1]).toBe("picked");
    expect(spy.mock.calls[0][2]).toEqual({
      url: "https://preview.redd.it/photo.jpg?width=<redacted>&token=<redacted>",
      count: 2,
    });
    spy.mockRestore();
  });
});
