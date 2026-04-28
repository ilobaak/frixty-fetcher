// ESLint flat config for the Frixty Fetcher JS surface. We don't
// ship a bundler — popup.js + the per-site modules run as raw ES
// modules in the Chrome extension context, and the three content
// scripts run in their target pages' isolated worlds. The config
// reflects that by scoping globals per file group.

import globals from "globals";

export default [
  {
    // Default for everything under extension/*.js — the popup and its
    // ES-module neighbors.
    files: ["extension/**/*.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        chrome: "readonly",
      },
    },
    rules: {
      // --- errors you'd want a CI to scream about --------------------
      "no-undef": "error",
      "no-unused-vars": [
        "warn",
        {
          args: "after-used",
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "none",
        },
      ],
      "no-unreachable": "error",
      "no-duplicate-imports": "error",
      "no-constant-condition": ["error", { checkLoops: false }],
      "no-empty": ["warn", { allowEmptyCatch: true }],

      // --- small quality nudges --------------------------------------
      "prefer-const": "warn",
      eqeqeq: ["warn", "always", { null: "ignore" }],
      "no-var": "error",
      "no-implicit-globals": "error",
    },
  },
  {
    // Content scripts run in the target page's isolated world. They
    // still see chrome.runtime (ISOLATED lets chrome.* through) and
    // the usual browser globals, but not ES-module imports — they're
    // IIFEs. sourceType:"script" means every top-level binding would
    // otherwise trip no-implicit-globals; disable that rule here
    // since the IIFE wrapper keeps the top-level clean and we don't
    // actually leak globals.
    files: [
      "extension/facebook-interceptor.js",
      "extension/facebook-post-grab.js",
      "extension/twitter-post-grab.js",
      "extension/instagram-post-grab.js",
    ],
    languageOptions: {
      sourceType: "script",
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        chrome: "readonly",
      },
    },
    rules: {
      "no-implicit-globals": "off",
    },
  },
  {
    // Vitest test files. Add the vitest globals so describe/it/expect
    // resolve without explicit imports (tests still import from the
    // modules under test).
    files: ["tests/**/*.js", "**/*.test.js"],
    languageOptions: {
      sourceType: "module",
      globals: {
        ...globals.node,
        describe: "readonly",
        it: "readonly",
        test: "readonly",
        expect: "readonly",
        beforeAll: "readonly",
        beforeEach: "readonly",
        afterAll: "readonly",
        afterEach: "readonly",
        vi: "readonly",
      },
    },
  },
  {
    ignores: ["bin/**", "logs/**", "host/**", "node_modules/**"],
  },
];
