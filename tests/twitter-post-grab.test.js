// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const script = readFileSync(resolve(here, "../extension/twitter-post-grab.js"), "utf8");

function installGrabScript() {
  window.__frixtyGrabButton = {
    fetchIconSvg: () => "<span>fetch</span>",
    flashCaptured: vi.fn(),
    flashError: vi.fn(),
  };
  window.chrome = {
    runtime: {
      lastError: null,
      sendMessage: vi.fn((msg, cb) => {
        if (msg.type === "tw:fetch-media") cb({ ok: true, mediaDetails: [] });
        else if (msg.type === "capture:add-batch") cb({ ok: true });
      }),
    },
  };
  window.console.warn = vi.fn();
  window.console.log = vi.fn();
  window.eval(script);
}

function twitterMessages(type) {
  return window.chrome.runtime.sendMessage.mock.calls
    .map(([msg]) => msg)
    .filter((msg) => msg.type === type);
}

async function waitForInjection() {
  await new Promise((resolve) => window.requestAnimationFrame(resolve));
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  delete window.__ytdlpTwitterGrabLoaded;
  delete window.__frixtyGrabButton;
  delete window.chrome;
});

describe("twitter-post-grab author extraction", () => {
  it("uses the @username, not the visible display name, for capture @Poster metadata", async () => {
    window.history.replaceState({}, "", "/flexiblenatalie/status/2074168924103491666");
    document.body.innerHTML = `
      <article data-testid="tweet">
        <div data-testid="User-Name">
          <span>Flexible Natalie</span>
          <a role="link" href="/flexiblenatalie"><span>@flexiblenatalie</span></a>
        </div>
        <a href="/flexiblenatalie/status/2074168924103491666"><time datetime="2026-07-21T00:00:00Z"></time></a>
        <div data-testid="tweetText">video post</div>
        <div data-testid="videoPlayer"><video poster="https://pbs.twimg.com/ext_tw_video_thumb/poster.jpg"></video></div>
        <div role="group">
          <button data-testid="reply">Reply</button>
          <button data-testid="like">Like</button>
          <button data-testid="share">Share</button>
        </div>
      </article>
    `;

    installGrabScript();
    await waitForInjection();
    document.querySelector(".ytdlp-tw-grab").click();
    await Promise.resolve();
    await Promise.resolve();

    const captures = twitterMessages("capture:add-batch");
    expect(captures).toHaveLength(1);
    expect(captures[0].items[0].item.handle).toBe("flexiblenatalie");
    expect(captures[0].items[0].item.basename).toBe("flexiblenatalie.mp4");
  });

  it("falls back to the profile href when the visible @username text is absent", async () => {
    window.history.replaceState({}, "", "/flexiblenatalie/status/2074168924103491666");
    document.body.innerHTML = `
      <article data-testid="tweet">
        <div data-testid="User-Name">
          <span>Flexible Natalie</span>
          <a role="link" href="/flexiblenatalie"><span>Flexible Natalie</span></a>
        </div>
        <a href="/flexiblenatalie/status/2074168924103491666"><time datetime="2026-07-21T00:00:00Z"></time></a>
        <div data-testid="tweetText">photo post</div>
        <div data-testid="tweetPhoto">
          <img src="https://pbs.twimg.com/media/photo.jpg?format=jpg&name=small" width="100" height="100">
        </div>
        <div role="group">
          <button data-testid="reply">Reply</button>
          <button data-testid="like">Like</button>
          <button data-testid="share">Share</button>
        </div>
      </article>
    `;

    installGrabScript();
    await waitForInjection();
    document.querySelector(".ytdlp-tw-grab").click();
    await Promise.resolve();
    await Promise.resolve();

    const captures = twitterMessages("capture:add-batch");
    expect(captures).toHaveLength(1);
    expect(captures[0].items[0].item.handle).toBe("flexiblenatalie");
  });
});
