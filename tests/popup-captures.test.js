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
});

describe("popup naming modes", () => {
  it("implements title-poster filenames across popup download paths", () => {
    expect(functionBody("guessDefaultName")).toContain('fnMode === "title-uploader"');
    expect(functionBody("videoFilenameTemplate")).toContain('fnMode === "title-uploader"');
    expect(functionBody("buildGalleryItemName")).toContain('filenameMode === "title-uploader"');
    expect(functionBody("buildCaptureDefaultBase")).toContain('filenameMode === "title-uploader"');
    expect(functionBody("startImageDownload")).toContain('filenameMode === "title-uploader"');
    expect(functionBody("downloadTextCapture")).toContain('filenameMode === "title-uploader"');
    expect(functionBody("startGallerySingleItem")).toContain('filenameMode === "title-uploader"');
  });

  it("implements title-poster folder names", () => {
    expect(functionBody("currentAlbumName")).toContain('mode === "title-uploader"');
    expect(functionBody("defaultAlbumName")).toContain('mode === "title-uploader"');
  });
});
