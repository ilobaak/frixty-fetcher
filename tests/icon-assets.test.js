import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

function read(path) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

describe("icon assets", () => {
  it("uses the selected tray f-arrow SVG for the extension icon sources", () => {
    const fetchSvg = read("../extension/icons/fetch.svg");
    const extensionSvg = read("../extension/icons/extension-icon.svg");

    for (const svg of [fetchSvg, extensionSvg]) {
      expect(svg).toContain('id="frixty-tray-f-arrow"');
      expect(svg).toContain('data-part="tray"');
      expect(svg).toContain('data-part="f-arrow"');
    }
  });

  it("uses the selected tray f-arrow SVG for injected fetch buttons", () => {
    const shared = read("../extension/grab-button-shared.js");
    const tiktok = read("../extension/tiktok-post-grab.js");

    for (const source of [shared, tiktok]) {
      expect(source).toContain("FRIXTY_TRAY_F_ARROW_PATHS");
      expect(source).toContain('data-part="tray"');
      expect(source).toContain('data-part="f-arrow"');
    }
  });
});
