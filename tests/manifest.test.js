import { describe, expect, it } from "vitest";
import manifest from "../extension/manifest.json" with { type: "json" };

describe("extension manifest", () => {
  it("allows Instagram CDN media used for reel thumbnails and size probes", () => {
    expect(manifest.host_permissions).toContain("*://*.cdninstagram.com/*");
  });
});
