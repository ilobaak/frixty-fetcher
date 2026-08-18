import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const popupSource = readFileSync(resolve(here, "../extension/popup.js"), "utf8");
const optionsSource = readFileSync(resolve(here, "../extension/options.js"), "utf8");
const backgroundSource = readFileSync(resolve(here, "../extension/background.js"), "utf8");

function functionBody(name) {
  const start = popupSource.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThanOrEqual(0);
  let parenDepth = 0;
  let brace = -1;
  for (let i = popupSource.indexOf("(", start); i < popupSource.length; i += 1) {
    if (popupSource[i] === "(") parenDepth += 1;
    if (popupSource[i] === ")") parenDepth -= 1;
    if (parenDepth === 0 && popupSource[i] === "{") {
      brace = i;
      break;
    }
  }
  expect(brace).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = brace; i < popupSource.length; i += 1) {
    if (popupSource[i] === "{") depth += 1;
    if (popupSource[i] === "}") depth -= 1;
    if (depth === 0) return popupSource.slice(brace + 1, i);
  }
  throw new Error(`Could not parse ${name}`);
}

describe("capture-list downloads", () => {
  it("keeps captured media available after starting a download", () => {
    expect(functionBody("startCaptureListDownload")).not.toContain("clearCaptures()");
  });

  it("routes direct captured videos through downloadUrl", () => {
    const body = functionBody("startCaptureListDownload");
    expect(body).toContain('mime.startsWith("image/") || mime.startsWith("video/")');
    expect(body).toContain('cmd: "downloadUrl"');
    expect(body).toContain('kind: kind || "combined"');
  });

  it("falls back to ranged GET when gallery HEAD size probing is insufficient", () => {
    const body = functionBody("fetchMediaSize");
    expect(body).toContain('method: "HEAD"');
    expect(body).toContain('Range: "bytes=0-0"');
    expect(body).toContain("Content-Range");
  });

  it("implements gallery video and image selection filters", () => {
    const body = functionBody("setGallerySelectedByType");
    expect(body).toContain('kind === "video"');
    expect(body).toContain('mime.startsWith("video/")');
    expect(body).toContain('kind === "image"');
    expect(body).toContain('mime.startsWith("image/")');
  });

  it("adds a per-card gallery save icon button", () => {
    const body = functionBody("renderGalleryItems");
    expect(body).toContain('saveBtn.className = "card-save"');
    expect(body).toContain('saveBtn.title = "Download item"');
    expect(body).toContain("<svg");
    expect(body).toContain("startGallerySingleItem");
    expect(body).toContain("startCaptureListDownload");
  });

  it("wires single media card save buttons to their download handlers", () => {
    expect(popupSource).toContain('el("video-card-save").onclick = startDownload');
    expect(popupSource).toContain('el("image-card-save").onclick = startImageDownload');
  });

  it("clears active job before re-enabling selected gallery downloads", () => {
    for (const name of ["inlineRenderDone", "inlineRenderError"]) {
      const body = functionBody(name);
      const clearIdx = body.indexOf("activeJobId = null");
      const reEnableIdx = body.indexOf("reEnablePrimary()");
      expect(clearIdx, `${name} should clear activeJobId`).toBeGreaterThanOrEqual(0);
      expect(reEnableIdx, `${name} should re-enable primary controls`).toBeGreaterThanOrEqual(0);
      expect(clearIdx, `${name} must clear activeJobId before reEnablePrimary`).toBeLessThan(
        reEnableIdx,
      );
    }
  });
});

describe("popup naming modes", () => {
  it("implements title-poster filenames across popup download paths", () => {
    expect(functionBody("guessDefaultName")).toContain("filenameBaseFromMode");
    expect(functionBody("videoFilenameTemplate")).toContain('fnMode === "title-uploader"');
    expect(functionBody("buildGalleryItemName")).toContain('filenameMode === "title-uploader"');
    expect(functionBody("buildCaptureDefaultBase")).toContain("filenameBaseFromMode");
    expect(functionBody("startImageDownload")).toContain("filenameBaseFromMode");
    expect(functionBody("downloadTextCapture")).toContain("filenameBaseFromMode");
    expect(functionBody("startGallerySingleItem")).toContain("filenameBaseFromMode");
  });

  it("uses range filename tokens without appending an extra suffix", () => {
    const body = functionBody("startRangeDownload");
    expect(body).toContain("saveSettings.rangeFilenameMode");
    expect(body).toContain("startTime: filenameTimeToken(");
    expect(body).toContain("endTime: filenameTimeToken(");
    expect(body).toContain("saveSettings.customTimeTokenFormats");
    expect(body).toContain("startHours: startParts.hours");
    expect(body).toContain("endHours: endParts.hours");
    expect(body).not.toContain("rangeSuffix");
    expect(body).not.toContain("suffixAlreadyPresent");
  });

  it("uses separate thumbnail and frame filename defaults", () => {
    const body = functionBody("videoToolBaseName");
    expect(body).toContain("saveSettings.thumbnailFilenameMode");
    expect(body).toContain("saveSettings.frameFilenameMode");
    expect(body).toContain("saveSettings.customTimeTokenFormats");
    expect(body).toContain("hours: parts.hours");
    expect(functionBody("startThumbnailDownload")).toContain('videoToolBaseName("thumbnail")');
    expect(functionBody("startFrameDownload")).toContain('videoToolBaseName("frame", seconds)');
  });

  it("uses bounded timestamps for range preview requests", () => {
    expect(functionBody("scheduleRangePreview")).toContain("rangePreviewTimestamp");
  });

  it("caps Best available downloads with the saved max-quality setting", () => {
    expect(functionBody("effectiveBestAvailableHeight")).toContain(
      "saveSettings.bestAvailableMaxHeight",
    );
    expect(functionBody("startDownload")).toContain("effectiveBestAvailableHeight");
    expect(functionBody("startRangeDownload")).toContain("effectiveBestAvailableHeight");
    expect(functionBody("startGalleryDownload")).toContain(
      "pickVariantUrl(item, effectiveBestAvailableHeight(maxHeight))",
    );
    expect(functionBody("startGallerySingleItem")).toContain(
      "pickVariantUrl(item, effectiveBestAvailableHeight(maxHeight || 0))",
    );
    expect(backgroundSource).toContain(
      'selection: { kind: "combined", height: setting.bestAvailableMaxHeight || 0 }',
    );
    expect(backgroundSource).toContain("readBestAvailableMaxHeight");
  });

  it("implements title-poster folder names", () => {
    expect(functionBody("currentAlbumName")).toContain('mode === "title-uploader"');
    expect(functionBody("defaultAlbumName")).toContain('mode === "title-uploader"');
  });
});

describe("options filename controls", () => {
  it("renders filename defaults and integrated rows as dropdown controls", () => {
    expect(optionsSource).toContain('const filenameModeEl = el("filename-mode")');
    expect(optionsSource).toContain('const multipleFilenameModeEl = el("multiple-filename-mode")');
    expect(optionsSource).toContain(
      'const thumbnailFilenameModeEl = el("thumbnail-filename-mode")',
    );
    expect(optionsSource).toContain('const frameFilenameModeEl = el("frame-filename-mode")');
    expect(optionsSource).toContain('const timeTokenFormatEl = el("time-token-format")');
    expect(optionsSource).toContain('const customTimeFormatsEl = el("custom-time-formats")');
    expect(optionsSource).toContain('const bestQualityCapEl = el("best-quality-cap")');
    expect(optionsSource).toContain("function renderFilenameMode()");
    expect(optionsSource).toContain("function renderTimeTokenFormat()");
    expect(optionsSource).not.toContain(' - example "');
    expect(optionsSource).toContain("function addCustomTimeFormat()");
    expect(optionsSource).toContain("function renderBestAvailableQualityCap()");
    expect(optionsSource).toContain("bestAvailableMaxHeight");
    expect(optionsSource).toContain('new Option("Downloads media", "download")');
    expect(optionsSource).toContain('new Option("Fetches to extension", "fetch")');
    expect(optionsSource).toContain("integrated-button-image");
    expect(optionsSource).toContain("function resetOptionsToDefaults()");
    expect(optionsSource).toContain("confirm(");
    expect(optionsSource).toContain("filenameSchemeNameTaken");
    expect(optionsSource).toContain('remove.className = "danger"');
  });
});
