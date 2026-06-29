import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

function read(path) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

describe("icon assets", () => {
  it("uses a centered plain download icon for the extension icon sources", () => {
    const fetchSvg = read("../extension/icons/fetch.svg");
    const extensionSvg = read("../extension/icons/extension-icon.svg");

    for (const svg of [fetchSvg, extensionSvg]) {
      expect(svg).toContain('id="frixty-download-tray"');
      expect(svg).toContain('stroke-width="2.6"');
      expect(svg).toContain('data-part="tray"');
      expect(svg).toContain('data-part="arrow"');
      expect(svg).toContain('d="M16 5.5v17"');
      expect(svg).toContain('d="M9.8 17.2 16 23.4l6.2-6.2"');
      expect(svg).not.toContain("f-arrow");
    }
  });

  it("uses a centered plain download icon for injected fetch buttons", () => {
    const shared = read("../extension/grab-button-shared.js");
    const tiktok = read("../extension/tiktok-post-grab.js");

    for (const source of [shared, tiktok]) {
      expect(source).toContain("FRIXTY_DOWNLOAD_TRAY_PATHS");
      expect(source).toContain('id="frixty-download-tray"');
      expect(source).toContain('stroke-width="2.6"');
      expect(source).toContain('data-part="tray"');
      expect(source).toContain('data-part="arrow"');
      expect(source).toContain('d="M16 5.5v17"');
      expect(source).toContain('d="M9.8 17.2 16 23.4l6.2-6.2"');
      expect(source).not.toContain("f-arrow");
    }
  });
});
