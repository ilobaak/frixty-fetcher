// URL-shape predicates — the cheap, no-network checks each per-site
// module exposes. These are the front door every handler goes
// through; a regression here silently routes users to the wrong site
// detector.

import { describe, it, expect } from "vitest";
import { looksLikeTweet } from "../extension/twitter.js";
import { looksLikeRedditPost } from "../extension/reddit.js";
import { looksLikeInstagram, isInstagramStoryUrl } from "../extension/instagram.js";
import { looksLikeTikTok, isTikTokVideoUrl, isTikTokPhotoUrl } from "../extension/tiktok.js";
import {
  canonicalizeFacebookUrlForYtdlp,
  looksLikeFacebook,
  isFacebookVideoUrl,
} from "../extension/facebook.js";

describe("looksLikeTweet", () => {
  it("matches twitter.com + x.com status URLs", () => {
    expect(looksLikeTweet("https://twitter.com/jack/status/20")).toBe(true);
    expect(looksLikeTweet("https://x.com/askperp/status/2034068093295575098")).toBe(true);
    expect(looksLikeTweet("https://mobile.twitter.com/user/status/123")).toBe(true);
  });
  it("rejects non-status URLs", () => {
    expect(looksLikeTweet("https://x.com/askperp")).toBe(false);
    expect(looksLikeTweet("https://x.com/askperp/photo")).toBe(false);
    expect(looksLikeTweet("https://example.com/status/123")).toBe(false);
  });
  it("rejects garbage input without throwing", () => {
    expect(looksLikeTweet("")).toBe(false);
    // @ts-ignore — intentionally passing non-string.
    expect(looksLikeTweet(null)).toBe(false);
    // @ts-ignore
    expect(looksLikeTweet(42)).toBe(false);
  });
});

describe("looksLikeRedditPost", () => {
  it("matches reddit permalinks", () => {
    expect(looksLikeRedditPost("https://www.reddit.com/r/pics/comments/abc123/title/")).toBe(true);
    expect(looksLikeRedditPost("https://old.reddit.com/r/pics/comments/abc123/title/")).toBe(true);
    expect(looksLikeRedditPost("https://sh.reddit.com/r/pics/comments/abc123/title/")).toBe(true);
    expect(looksLikeRedditPost("https://reddit.com/r/videos/comments/xyz/")).toBe(true);
  });
  it("matches reddit direct media and short links", () => {
    expect(looksLikeRedditPost("https://i.redd.it/abc123.jpg")).toBe(true);
    expect(looksLikeRedditPost("https://preview.redd.it/abc123.png?width=960")).toBe(true);
    expect(looksLikeRedditPost("https://v.redd.it/abc123")).toBe(true);
    expect(looksLikeRedditPost("https://redd.it/abc123")).toBe(true);
    expect(
      looksLikeRedditPost("https://www.reddit.com/media?url=https%3A%2F%2Fi.redd.it%2Fx.jpg"),
    ).toBe(true);
  });
  it("rejects subreddit / user / frontpage URLs", () => {
    expect(looksLikeRedditPost("https://www.reddit.com/r/pics/")).toBe(false);
    expect(looksLikeRedditPost("https://www.reddit.com/u/someone")).toBe(false);
    expect(looksLikeRedditPost("https://www.reddit.com/")).toBe(false);
  });
});

describe("looksLikeInstagram", () => {
  it("matches /p/, /reel/, /reels/, /stories/ paths", () => {
    expect(looksLikeInstagram("https://www.instagram.com/p/DXBdUUODY0w/")).toBe(true);
    expect(looksLikeInstagram("https://www.instagram.com/reel/abc/")).toBe(true);
    expect(looksLikeInstagram("https://www.instagram.com/reels/xyz/")).toBe(true);
    expect(looksLikeInstagram("https://www.instagram.com/stories/user/123/")).toBe(true);
  });
  it("rejects home / profile / explore URLs", () => {
    expect(looksLikeInstagram("https://www.instagram.com/")).toBe(false);
    expect(looksLikeInstagram("https://www.instagram.com/askperp/")).toBe(false);
    expect(looksLikeInstagram("https://www.instagram.com/explore/")).toBe(false);
  });
  it("rejects other hostnames", () => {
    expect(looksLikeInstagram("https://x.com/p/fake/")).toBe(false);
    // @ts-ignore
    expect(looksLikeInstagram(null)).toBe(false);
  });
});

describe("isInstagramStoryUrl", () => {
  it("matches /stories/ paths only", () => {
    expect(isInstagramStoryUrl("https://www.instagram.com/stories/user/")).toBe(true);
    expect(isInstagramStoryUrl("https://www.instagram.com/stories/user/12345/")).toBe(true);
  });
  it("does NOT match /p/ or /reel/ URLs", () => {
    expect(isInstagramStoryUrl("https://www.instagram.com/p/abc/")).toBe(false);
    expect(isInstagramStoryUrl("https://www.instagram.com/reel/xyz/")).toBe(false);
  });
});

describe("looksLikeTikTok", () => {
  it("matches tiktok.com + subdomains", () => {
    expect(looksLikeTikTok("https://www.tiktok.com/")).toBe(true);
    expect(looksLikeTikTok("https://www.tiktok.com/en/")).toBe(true);
    expect(looksLikeTikTok("https://www.tiktok.com/@user/video/123")).toBe(true);
    expect(looksLikeTikTok("https://vm.tiktok.com/shortcode/")).toBe(true);
    expect(looksLikeTikTok("https://tiktok.com/foryou")).toBe(true);
  });
  it("rejects non-tiktok hosts", () => {
    expect(looksLikeTikTok("https://example.com/@user/video/1")).toBe(false);
    expect(looksLikeTikTok("https://nottiktok.com/")).toBe(false);
    expect(looksLikeTikTok("")).toBe(false);
    // @ts-ignore
    expect(looksLikeTikTok(null)).toBe(false);
  });
});

describe("isTikTokVideoUrl", () => {
  it("matches /@user/video/<id> and /@user/photo/<id>", () => {
    expect(
      isTikTokVideoUrl("https://www.tiktok.com/@charlidamelio/video/7394058290123456789"),
    ).toBe(true);
    expect(isTikTokVideoUrl("https://www.tiktok.com/@user/photo/123")).toBe(true);
  });
  it("rejects feed / homepage / profile URLs", () => {
    expect(isTikTokVideoUrl("https://www.tiktok.com/")).toBe(false);
    expect(isTikTokVideoUrl("https://www.tiktok.com/en/")).toBe(false);
    expect(isTikTokVideoUrl("https://www.tiktok.com/foryou")).toBe(false);
    expect(isTikTokVideoUrl("https://www.tiktok.com/@charlidamelio")).toBe(false);
  });
  it("rejects short-link hosts (no canonical path yet)", () => {
    // vm.tiktok.com/<code>/ is a redirect; pre-redirect it's not a video path.
    expect(isTikTokVideoUrl("https://vm.tiktok.com/shortcode/")).toBe(false);
  });
});

describe("isTikTokPhotoUrl", () => {
  it("matches /@user/photo/<id> only", () => {
    expect(isTikTokPhotoUrl("https://www.tiktok.com/@user/photo/7591694470211472653")).toBe(true);
    expect(isTikTokPhotoUrl("https://m.tiktok.com/@a/photo/12345")).toBe(true);
  });
  it("does NOT match /@user/video/<id>", () => {
    expect(isTikTokPhotoUrl("https://www.tiktok.com/@user/video/123")).toBe(false);
  });
  it("does NOT match feed / profile / unrelated URLs", () => {
    expect(isTikTokPhotoUrl("https://www.tiktok.com/")).toBe(false);
    expect(isTikTokPhotoUrl("https://www.tiktok.com/@user")).toBe(false);
    expect(isTikTokPhotoUrl("https://example.com/@user/photo/1")).toBe(false);
    expect(isTikTokPhotoUrl("")).toBe(false);
    // @ts-ignore
    expect(isTikTokPhotoUrl(null)).toBe(false);
  });
});

describe("looksLikeFacebook", () => {
  it("matches www.facebook.com / m.facebook.com / fb.watch", () => {
    expect(looksLikeFacebook("https://www.facebook.com/")).toBe(true);
    expect(looksLikeFacebook("https://m.facebook.com/watch/?v=1")).toBe(true);
    expect(looksLikeFacebook("https://fb.watch/abc/")).toBe(true);
    expect(looksLikeFacebook("https://web.facebook.com/photo.php?fbid=1")).toBe(true);
  });
  it("rejects unrelated hosts", () => {
    expect(looksLikeFacebook("https://www.example.com/")).toBe(false);
    expect(looksLikeFacebook("https://notfacebook.com/")).toBe(false);
    expect(looksLikeFacebook("")).toBe(false);
    // @ts-ignore
    expect(looksLikeFacebook(null)).toBe(false);
  });
});

describe("isFacebookVideoUrl", () => {
  it("matches fb.watch and any subdomain of fb.watch", () => {
    expect(isFacebookVideoUrl("https://fb.watch/abc123/")).toBe(true);
    expect(isFacebookVideoUrl("https://m.fb.watch/abc/")).toBe(true);
  });
  it("matches /watch and /watch/", () => {
    expect(isFacebookVideoUrl("https://www.facebook.com/watch/?v=123")).toBe(true);
    expect(isFacebookVideoUrl("https://www.facebook.com/watch")).toBe(true);
  });
  it("matches /reel/ paths", () => {
    expect(isFacebookVideoUrl("https://www.facebook.com/reel/12345/")).toBe(true);
  });
  it("matches /<user>/videos/<id>/", () => {
    expect(isFacebookVideoUrl("https://www.facebook.com/zuck/videos/9999/")).toBe(true);
    expect(isFacebookVideoUrl("https://www.facebook.com/some.page/videos/1/")).toBe(true);
  });
  it("rejects photos / posts / profile pages", () => {
    expect(isFacebookVideoUrl("https://www.facebook.com/photo/?fbid=1")).toBe(false);
    expect(isFacebookVideoUrl("https://www.facebook.com/zuck/posts/abc")).toBe(false);
    expect(isFacebookVideoUrl("https://www.facebook.com/zuck")).toBe(false);
  });
  it("rejects garbage input", () => {
    expect(isFacebookVideoUrl("")).toBe(false);
    expect(isFacebookVideoUrl("not a url")).toBe(false);
    // @ts-ignore
    expect(isFacebookVideoUrl(null)).toBe(false);
  });
});

describe("canonicalizeFacebookUrlForYtdlp", () => {
  it("rewrites /photo/?fbid= → /photo.php?fbid=", () => {
    const out = canonicalizeFacebookUrlForYtdlp(
      "https://www.facebook.com/photo/?fbid=1234567890&set=a.999",
    );
    expect(out).toBe("https://www.facebook.com/photo.php?fbid=1234567890&set=a.999");
  });
  it("strips __cft__[n] tracking params", () => {
    const out = canonicalizeFacebookUrlForYtdlp(
      "https://www.facebook.com/photo/?fbid=1&__cft__%5B0%5D=AZ...&foo=bar",
    );
    expect(out).toBe("https://www.facebook.com/photo.php?fbid=1&foo=bar");
  });
  it("strips __tn__ and __xts__[n] params", () => {
    const out = canonicalizeFacebookUrlForYtdlp(
      "https://www.facebook.com/x/?fbid=1&__tn__=EH-R&__xts__%5B0%5D=68.ARBc",
    );
    expect(out).not.toMatch(/__tn__|__xts__/);
  });
  it("passes through a non-Facebook URL", () => {
    const u = "https://www.tiktok.com/@user/video/123";
    expect(canonicalizeFacebookUrlForYtdlp(u)).toBe(u);
  });
  it("passes through FB watch / videos URLs unchanged", () => {
    const a = "https://www.facebook.com/watch/?v=123456";
    expect(canonicalizeFacebookUrlForYtdlp(a)).toBe(a);
    const b = "https://www.facebook.com/user/videos/123456/";
    expect(canonicalizeFacebookUrlForYtdlp(b)).toBe(b);
  });
  it("handles malformed input safely", () => {
    expect(canonicalizeFacebookUrlForYtdlp("")).toBe("");
    // @ts-ignore
    expect(canonicalizeFacebookUrlForYtdlp(null)).toBe(null);
    expect(canonicalizeFacebookUrlForYtdlp("not a url")).toBe("not a url");
  });
  it("only rewrites /photo/ when fbid is present (don't mangle user profiles)", () => {
    // A path like /photo/ without fbid isn't a photo-viewer link.
    const u = "https://www.facebook.com/photo/";
    expect(canonicalizeFacebookUrlForYtdlp(u)).toBe(u);
  });
});
