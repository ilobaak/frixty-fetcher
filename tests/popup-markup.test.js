import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const popupHtml = readFileSync(new URL("../extension/popup.html", import.meta.url), "utf8");

describe("popup markup", () => {
  it("groups YouTube image tools in one collapsed section", () => {
    expect(popupHtml).toContain('<details class="youtube-image-actions" id="youtube-image-actions" hidden>');
    expect(popupHtml).toContain("<summary>Video image tools</summary>");
    expect(popupHtml).toContain('id="yt-thumbnail-preview"');
    expect(popupHtml).toContain('id="yt-frame-preview"');
    expect(popupHtml).toContain('id="yt-frame-slider"');
    expect(popupHtml).toContain('id="yt-save-timestamp-frame" type="button" class="primary"');
    expect(popupHtml).toContain("Download frame at timestamp");
  });
});
