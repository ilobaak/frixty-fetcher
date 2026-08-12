import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const popupHtml = readFileSync(new URL("../extension/popup.html", import.meta.url), "utf8");
const optionsHtml = readFileSync(new URL("../extension/options.html", import.meta.url), "utf8");
const popupCss = readFileSync(new URL("../extension/popup.css", import.meta.url), "utf8");

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
    expect(popupHtml).toContain("video-range-actions-body");
    expect(popupHtml).toContain("range-preview-grid");
    expect(popupHtml).toContain('id="range-start-preview"');
    expect(popupHtml).toContain('id="range-end-preview"');
    expect(popupHtml).toContain('class="dual-range" id="range-dual-slider"');
    expect(popupHtml).toContain('id="range-start-slider"');
    expect(popupHtml).toContain('id="range-end-slider"');
    expect(popupHtml).toContain("Set start to current video time");
    expect(popupHtml).toContain("Set end to current video time");
    expect(popupHtml).toContain("Download selected range");
    expect(popupCss).toContain(".range-preview-grid");
    expect(popupCss).toContain(".dual-range::before");
    expect(popupCss).toContain(".video-range-actions > summary");
    expect(popupCss).toContain("cursor: pointer");
    expect(popupCss).toContain("background: var(--brand)");
    expect(popupCss).toContain("accent-color: var(--brand)");
    expect(popupCss).toContain("grid-template-columns: 54px minmax(0, 1fr) 54px");
    expect(popupCss).toContain("linear-gradient(");
    expect(popupCss).toContain("--range-start-pct");
  });

  it("places the gallery card save button left of the index badge", () => {
    expect(popupCss).toContain(".media-card .card-save");
    expect(popupCss).toContain("right: 66px");
    expect(popupCss).toContain(".media-card.has-remove .card-position");
    expect(popupCss).toContain("right: 30px");
  });

  it("adds save icon buttons to single media cards", () => {
    expect(popupHtml).toContain('id="video-card-save"');
    expect(popupHtml).toContain('id="image-card-save"');
    expect(popupHtml).toContain("card-save-single");
    expect(popupCss).toContain(".media-card .card-save-single");
  });

  it("adds options for integrated buttons and custom filename schemes", () => {
    expect(optionsHtml).toContain('id="integrated-categories"');
    expect(optionsHtml).toContain('id="range-filename-mode"');
    expect(optionsHtml).toContain('id="custom-schemes"');
    expect(optionsHtml).toContain('id="custom-scheme-template"');
    expect(optionsHtml).toContain("[Start]");
    expect(optionsHtml).toContain("[End]");
  });
});
