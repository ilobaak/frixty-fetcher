// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { __test, detectReddit } from "../extension/reddit.js";

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map(),
    async json() {
      return body;
    },
  };
}

function headResponse(headers) {
  return {
    ok: true,
    headers: {
      get(name) {
        return headers[name] ?? headers[name.toLowerCase()] ?? null;
      },
    },
  };
}

function redditListing(post) {
  return [{ data: { children: [{ data: post }] } }];
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  document.head.innerHTML = "";
});

describe("detectReddit", () => {
  it("detects direct i.redd.it image URLs without calling post JSON", async () => {
    const fetch = vi.fn(async () =>
      headResponse({
        "Content-Length": "1234",
        "Content-Type": "image/jpeg",
      }),
    );
    vi.stubGlobal("fetch", fetch);

    const info = await detectReddit("https://i.redd.it/photo.jpg");

    expect(info.kind).toBe("image");
    expect(info.imageUrl).toBe("https://i.redd.it/photo.jpg");
    expect(info.bytes).toBe(1234);
    expect(info.mime).toBe("image/jpeg");
    expect(fetch).toHaveBeenCalledWith("https://i.redd.it/photo.jpg", {
      method: "HEAD",
      credentials: "omit",
    });
  });

  it("detects a JSON image post", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, opts) => {
        if (opts?.method === "HEAD") return headResponse({ "Content-Type": "image/png" });
        expect(url).toContain(".json?raw_json=1");
        return jsonResponse(
          redditListing({
            title: "A picture",
            author: "poster",
            created_utc: 1710000000,
            post_hint: "image",
            url: "https://i.redd.it/photo.png",
            preview: { images: [{ source: { width: 1200, height: 800 }, resolutions: [] }] },
          }),
        );
      }),
    );

    const info = await detectReddit("https://www.reddit.com/r/pics/comments/abc123/a_picture/");

    expect(info).toMatchObject({
      kind: "image",
      title: "A picture",
      handle: "poster",
      imageUrl: "https://i.redd.it/photo.png",
      width: 1200,
      height: 800,
      mime: "image/png",
    });
  });

  it("detects a JSON gallery post", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          redditListing({
            title: "Gallery",
            author: "poster",
            is_gallery: true,
            gallery_data: { items: [{ media_id: "a" }, { media_id: "b" }] },
            media_metadata: {
              a: {
                status: "valid",
                e: "Image",
                m: "image/jpeg",
                s: { u: "https://i.redd.it/a.jpg", x: 640, y: 480 },
              },
              b: {
                status: "valid",
                e: "AnimatedImage",
                m: "image/gif",
                s: { mp4: "https://i.redd.it/b.mp4", x: 320, y: 240 },
              },
            },
          }),
        ),
      ),
    );

    const info = await detectReddit("https://old.reddit.com/r/pics/comments/abc123/gallery/");

    expect(info.kind).toBe("gallery");
    expect(info.items).toHaveLength(2);
    expect(info.items[0]).toMatchObject({ url: "https://i.redd.it/a.jpg", ext: "jpg" });
    expect(info.items[1]).toMatchObject({ url: "https://i.redd.it/b.mp4", ext: "mp4" });
  });

  it("returns a domFallback sentinel for JSON 403 on reddit post URLs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({}, 403)),
    );

    const info = await detectReddit("https://www.reddit.com/r/pics/comments/abc123/a_picture/");

    expect(info).toEqual({ kind: "domFallback" });
  });
});

describe("scrapeRedditDom", () => {
  it("scrapes old reddit single-image media without sidebar thumbnails", () => {
    document.head.innerHTML = `
      <meta property="og:title" content="38 and finished HS!">
      <meta property="og:image" content="https://preview.redd.it/hk3zag5eyb6h1.jpeg?overlay-align=bottom,left&width=1200&height=628&auto=webp">
      <meta property="og:image:width" content="1200">
      <meta property="og:image:height" content="628">
    `;
    document.body.innerHTML = `
      <h1>justgalsbeingchicks</h1>
      <a class="thumbnail"><img src="https://preview.redd.it/hk3zag5eyb6h1.jpeg?width=140&height=140&crop=1:1,smart&auto=webp"></a>
      <div id="media-preview-1u1jfaf" class="media-preview">
        <img src="https://preview.redd.it/hk3zag5eyb6h1.jpeg?width=576&auto=webp&s=main" width="576" height="768">
      </div>
      <img src="https://external-preview.redd.it/sidebar.gif?width=200&height=200&s=ignore">
    `;

    const info = __test.scrapeRedditDom();

    expect(info).toMatchObject({
      kind: "image",
      title: "38 and finished HS!",
      imageUrl: "https://preview.redd.it/hk3zag5eyb6h1.jpeg?width=576&auto=webp&s=main",
      width: 576,
      height: 768,
    });
  });

  it("returns video for old reddit video media instead of preview images", () => {
    document.head.innerHTML = `
      <meta property="og:title" content="Video post">
      <meta property="og:type" content="video">
      <meta property="og:image" content="https://external-preview.redd.it/poster.png?width=720&height=376&auto=webp">
    `;
    document.body.innerHTML = `
      <div id="media-preview-abc" class="media-preview">
        <div id="video-abc" class="reddit-video-player-root" data-hls-url="https://v.redd.it/abc/HLSPlaylist.m3u8">
          <video src="blob:https://www.reddit.com/example"></video>
        </div>
      </div>
    `;

    expect(__test.scrapeRedditDom()).toEqual({ kind: "video" });
  });

  it("ignores old reddit external-link thumbnail-only posts", () => {
    document.head.innerHTML = `
      <meta property="og:title" content="External link">
      <meta property="og:image" content="https://preview.redd.it/thumb.png?width=140&height=140&crop=1:1,smart&auto=webp">
      <meta property="og:image:width" content="140">
      <meta property="og:image:height" content="140">
    `;
    document.body.innerHTML = `
      <a class="thumbnail" href="https://mangadex.org/chapter/example">
        <img src="https://preview.redd.it/thumb.png?width=140&height=140&crop=1:1,smart&auto=webp" width="140" height="140">
      </a>
    `;

    expect(__test.scrapeRedditDom()).toBeNull();
  });
});
