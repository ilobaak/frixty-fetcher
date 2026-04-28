// Vitest config. Default environment is "node" for cheap pure-
// function tests. Individual files can opt into happy-dom for DOM
// helpers via a `// @vitest-environment happy-dom` pragma at the
// top of the file; alternatively, environmentMatchGlobs picks it
// automatically for test files whose name suggests DOM need.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.js"],
    globals: false, // tests explicitly import { describe, it, expect }
    environment: "node",
    environmentMatchGlobs: [
      ["tests/tiktok.test.js", "happy-dom"],
    ],
    reporters: ["default"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: [
        "extension/shared.js",
        "extension/twitter.js",
        "extension/reddit.js",
        "extension/instagram.js",
        "extension/tiktok-shared.js",
        "extension/tiktok.js",
      ],
    },
  },
});
