import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const popupHtml = readFileSync(new URL("../extension/popup.html", import.meta.url), "utf8");
const optionsHtml = readFileSync(new URL("../extension/options.html", import.meta.url), "utf8");

describe("popup markup", () => {
  it("offers title-poster naming and updated download control labels", () => {
    expect(popupHtml).toContain("Individual downloads - prompt each");
    expect(popupHtml).toContain("Download to a new folder in destination");
    expect(popupHtml).toContain("<span>New folder name</span>");
    expect(popupHtml).toContain('placeholder="New folder name"');
    expect(popupHtml).toContain('value="title-uploader-source" selected');
    expect(popupHtml).toContain("[Title] -- [@Poster] -- [Source]");
    expect(popupHtml).toContain('<option value="title-uploader">[Title] -- [@Poster]</option>');
    expect(popupHtml).toContain('<option value="uploader-title">[@Poster] -- [Title]</option>');
    expect(optionsHtml).toContain('name="filename-mode" value="title-uploader"');
    expect(optionsHtml).toContain("[Title] -- [@Poster]");
    expect(optionsHtml).toContain("[Title] -- [@Poster] -- [Source]");
  });

  it("offers gallery media-type selection controls", () => {
    expect(popupHtml).toContain('id="select-videos"');
    expect(popupHtml).toContain("Select Videos");
    expect(popupHtml).toContain('id="select-images"');
    expect(popupHtml).toContain("Select Images");
  });

  it("groups YouTube image tools in one collapsed section", () => {
    expect(popupHtml).toContain(
      '<details class="youtube-image-actions" id="youtube-image-actions" hidden>',
    );
    expect(popupHtml).toContain("<summary>Video image tools</summary>");
    expect(popupHtml).toContain(
      '<section class="youtube-image-section" aria-labelledby="yt-thumbnail-section-title">',
    );
    expect(popupHtml).toContain('id="yt-thumbnail-section-title"');
    expect(popupHtml).toContain("Thumbnail");
    expect(popupHtml).toContain(
      '<section class="youtube-image-section" aria-labelledby="yt-frame-section-title">',
    );
    expect(popupHtml).toContain('id="yt-frame-section-title"');
    expect(popupHtml).toContain("Frames");
    expect(popupHtml).toContain('id="yt-thumbnail-preview"');
    expect(popupHtml).toContain('id="yt-frame-preview"');
    expect(popupHtml).toContain('id="yt-frame-slider"');
    expect(popupHtml).toContain("Download video's current frame");
    expect(popupHtml).toContain('id="yt-save-timestamp-frame" type="button" class="primary"');
    expect(popupHtml).toContain("Download frame at timestamp");
  });

  it("offers a video range download section", () => {
    expect(popupHtml).toContain('class="video-range-actions" id="video-range-actions"');
    expect(popupHtml).toContain("<summary>Video range download</summary>");
    expect(popupHtml).toContain('id="range-start-slider"');
    expect(popupHtml).toContain('id="range-end-slider"');
    expect(popupHtml).toContain("Set start to current");
    expect(popupHtml).toContain("Set end to current");
    expect(popupHtml).toContain("Download selected range");
  });

  it("adds options for integrated buttons and custom filename schemes", () => {
    expect(optionsHtml).toContain('id="integrated-categories"');
    expect(optionsHtml).toContain('id="custom-schemes"');
    expect(optionsHtml).toContain('id="custom-scheme-template"');
  });
});
