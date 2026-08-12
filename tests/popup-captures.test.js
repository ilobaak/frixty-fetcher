import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const popupSource = readFileSync(resolve(here, "../extension/popup.js"), "utf8");

function functionBody(name) {
  const start = popupSource.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThanOrEqual(0);
  const brace = popupSource.indexOf("{", start);
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
    expect(body).toContain("startGallerySingleItem");
    expect(body).toContain("startCaptureListDownload");
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

  it("implements title-poster folder names", () => {
    expect(functionBody("currentAlbumName")).toContain('mode === "title-uploader"');
    expect(functionBody("defaultAlbumName")).toContain('mode === "title-uploader"');
  });
});
