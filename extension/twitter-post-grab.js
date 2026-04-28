// Per-tweet "grab" button. Injects a small ⬇ button at the right
// end of every tweet's action bar (next to the share / bookmark
// icons). Clicking it captures the tweet's permalink into the same
// session-storage list Facebook captures go into, so the popup
// renders a unified gallery regardless of source.
//
// The tweet URL (the permalink on status/<id>) is handed to yt-dlp
// via viaYtDlp:true at download time, so the Twitter extractor
// resolves the actual media — same pipeline captures use on Facebook.
(function () {
  if (window.__ytdlpTwitterGrabLoaded) return;
  window.__ytdlpTwitterGrabLoaded = true;
  console.log("[frixty/tw-grab] installed at", location.href);

  // ---- selectors ----
  function findTweets() {
    // Timeline + detail view both use article[data-testid="tweet"].
    // Some variants use "tweetDetail" on the focal tweet.
    return document.querySelectorAll(
      'article[data-testid="tweet"], article[data-testid="tweetDetail"]'
    );
  }

  function findActionBar(tweet) {
    // Twitter wraps the reply/retweet/like/share action bar in
    // role="group". Pick the one that actually contains action
    // buttons (a tweet's media carousel ALSO uses role=group for
    // slide navigation, so filter by presence of reply/like).
    for (const bar of tweet.querySelectorAll('[role="group"]')) {
      if (
        bar.querySelector('[data-testid="reply"]') ||
        bar.querySelector('[data-testid="like"]') ||
        bar.querySelector('[data-testid="retweet"]')
      ) {
        return bar;
      }
    }
    return null;
  }

  function findShareAnchor(tweet) {
    // Inject NEXT TO the share button so our ⬇ sits at the visual
    // end of the action bar. Twitter has rotated the share button's
    // attributes over time — test multiple shapes.
    const byTestId = tweet.querySelector('[data-testid="share"]');
    if (byTestId) return byTestId.closest('[role="button"], button') || byTestId;
    for (const b of tweet.querySelectorAll('button, [role="button"]')) {
      const label = (b.getAttribute("aria-label") || "").toLowerCase();
      if (label.includes("share")) return b;
    }
    return null;
  }

  // ---- helpers ----
  function sanitize(raw) {
    if (!raw) return "";
    return raw.replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, " ").trim();
  }

  // Twitter syndication API — same endpoint used by Twitter's own
  // tweet-embed widgets. No auth, but requires a derived token —
  // computed in the background's tw:fetch-media handler (see
  // extension/shared.js::computeSyndicationToken for the canonical
  // copy). The content script never builds the token itself.
  function withTwitterSize(url, sizeLabel) {
    try {
      const u = new URL(url);
      u.searchParams.set("name", sizeLabel);
      return u.toString();
    } catch { return url; }
  }
  function extFromUrl(url) {
    try {
      const path = new URL(url).pathname;
      const m = path.match(/\.([a-zA-Z0-9]{1,5})$/);
      return m ? m[1].toLowerCase() : "";
    } catch { return ""; }
  }
  function basenameFromUrl(url) {
    try {
      const path = new URL(url).pathname;
      return path.split("/").pop() || "";
    } catch { return ""; }
  }
  async function fetchSyndicationMedia(tweetUrl) {
    const m = tweetUrl.match(/\/status\/(\d+)/);
    if (!m) return null;
    const tweetId = m[1];
    // Route through background so the fetch runs from the extension's
    // origin with host_permissions. A direct fetch from this content
    // script runs in x.com's origin and is blocked by CORS because
    // cdn.syndication.twimg.com doesn't return a wildcard
    // Access-Control-Allow-Origin for this endpoint.
    try {
      const resp = await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { type: "tw:fetch-media", tweetId },
          (r) => resolve(r || { ok: false, error: "no-response" }),
        );
      });
      if (!resp?.ok) {
        console.warn("[frixty/tw-grab] tw:fetch-media failed", resp?.error);
        return null;
      }
      return Array.isArray(resp.mediaDetails) ? resp.mediaDetails : [];
    } catch (err) {
      console.warn("[frixty/tw-grab] tw:fetch-media threw", err?.message || err);
      return null;
    }
  }

  // Turn the API's mediaDetails[] into capture payloads (one per
  // photo / video). Returns [] when there's nothing downloadable.
  function payloadsFromApiMedia(mediaDetails, tweetUrl, author, fullText) {
    const out = [];
    const handleSlug = sanitize(author || "tweet").slice(0, 40) || "tweet";
    const photos = mediaDetails.filter((m) => m.type === "photo" && typeof m.media_url_https === "string");
    const photoCount = photos.length;
    let photoIdx = 0;
    for (const m of photos) {
      photoIdx++;
      const origUrl = withTwitterSize(m.media_url_https, "orig");
      const ext = extFromUrl(origUrl) || "jpg";
      const basename = photoCount > 1
        ? `${handleSlug}-${photoIdx}.${ext}`
        : `${handleSlug}.${ext}`;
      out.push({
        url: origUrl,
        item: {
          url: origUrl,
          ext,
          mime: `image/${ext === "jpg" ? "jpeg" : ext}`,
          width: m.original_info?.width || 0,
          height: m.original_info?.height || 0,
          thumbUrl: withTwitterSize(m.media_url_https, "small"),
          basename,
          handle: author || "",
          capturedTitle: fullText,
          sourceTweetUrl: tweetUrl,
        },
        capturedAt: Date.now(),
      });
    }
    let videoIdx = 0;
    const videoEntries = mediaDetails.filter((m) => m.type === "video" || m.type === "animated_gif");
    for (const m of videoEntries) {
      videoIdx++;
      const variants = Array.isArray(m.video_info?.variants) ? m.video_info.variants : [];
      const mp4s = variants
        .filter((v) => v.content_type === "video/mp4" && typeof v.url === "string")
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      if (mp4s.length === 0) continue;
      const best = mp4s[0];
      const basename = videoEntries.length > 1
        ? `${handleSlug}-v${videoIdx}.mp4`
        : `${handleSlug}.mp4`;
      out.push({
        url: best.url,
        item: {
          url: best.url,
          ext: "mp4",
          mime: "video/mp4",
          width: m.original_info?.width || 0,
          height: m.original_info?.height || 0,
          thumbUrl: m.media_url_https || "",
          basename,
          handle: author || "",
          capturedTitle: fullText,
          sourceTweetUrl: tweetUrl,
        },
        capturedAt: Date.now(),
      });
    }
    return out;
  }

  // ---- metadata extraction ----
  // A node is "inside a quoted tweet" when one of its ancestors
  // (inside the outer tweet article) carries role="link" — that's
  // the clickable wrapper Twitter uses for the embedded quote. The
  // outer tweet's own timestamp anchor is a plain <a>, not wrapped
  // in a role="link" container, so the check cleanly distinguishes
  // them.
  function isInsideQuote(node, tweet) {
    let cur = node.parentElement;
    while (cur && cur !== tweet) {
      if (cur.getAttribute && cur.getAttribute("role") === "link") return true;
      cur = cur.parentElement;
    }
    return false;
  }

  // Canonicalize a tweet URL to /<handle>/status/<id> — stripping
  // /photo/N, /video/N, /analytics, /retweets, any query string, etc.
  // Twitter's photo/video detail views keep the tweet URL on the
  // status anchor but append the media-index suffix; yt-dlp handles
  // either, but a clean permalink is nicer and avoids drift when
  // the user captures from the photo view vs the tweet timeline.
  function canonicalTweetUrl(href) {
    try {
      const u = new URL(href, location.origin);
      const m = u.pathname.match(/^\/[^/]+\/status\/\d+/);
      if (m) {
        u.pathname = m[0];
        u.search = "";
        u.hash = "";
        return u.toString();
      }
      return u.toString();
    } catch { return href; }
  }

  function extractTweetPermalink(tweet) {
    // Prefer a <time> that's NOT inside a quoted-tweet embed —
    // otherwise the quote's timestamp would win over the outer
    // tweet's, sending the user to the wrong /status/ URL.
    for (const t of tweet.querySelectorAll("time")) {
      if (isInsideQuote(t, tweet)) continue;
      const a = t.closest("a[href*='/status/']");
      if (a?.href) return canonicalTweetUrl(a.href);
    }
    // Fallback: any /status/ anchor outside a quote embed.
    for (const a of tweet.querySelectorAll("a[href*='/status/']")) {
      if (isInsideQuote(a, tweet)) continue;
      const hrefAttr = a.getAttribute("href") || "";
      if (/\/status\/\d+/.test(hrefAttr) || /\/status\/\d+/.test(a.href)) {
        return canonicalTweetUrl(a.href);
      }
    }
    // Last resort: use the current page URL if it's a status page.
    // Happens when a tweet article is rendered on a photo detail
    // page but its own timestamp anchor got swapped out by the
    // overlay UI.
    if (/\/status\/\d+/.test(location.pathname)) {
      return canonicalTweetUrl(location.href);
    }
    return "";
  }

  function extractAuthor(tweet) {
    // The OUTER User-Name block comes first in DOM order. Quoted
    // tweet embeds get their own nested User-Name block. Pick the
    // first that isn't inside a quote.
    const headers = tweet.querySelectorAll('[data-testid="User-Name"]');
    for (const h of headers) {
      if (isInsideQuote(h, tweet)) continue;
      const nameSpan = h.querySelector("span");
      const name = nameSpan?.textContent?.trim();
      if (name && !name.startsWith("@")) return name;
      const handle = h.querySelector('a[role="link"]');
      const text = handle?.textContent?.trim();
      if (text) return text;
    }
    return "";
  }

  function extractThumbnail(tweet) {
    // Content image from the OUTER tweet only — quoted-tweet media
    // would misattribute. Prefer imgs inside [data-testid="tweetPhoto"]
    // since that's Twitter's canonical photo wrapper; fall back to
    // any recognizable content-CDN img, then to <video>.poster.
    const photoContainers = tweet.querySelectorAll('[data-testid="tweetPhoto"]');
    for (const container of photoContainers) {
      if (isInsideQuote(container, tweet)) continue;
      const img = container.querySelector("img");
      const src = img?.currentSrc || img?.src || "";
      if (src) return src;
    }
    for (const img of tweet.querySelectorAll("img")) {
      if (isInsideQuote(img, tweet)) continue;
      const src = img.currentSrc || img.src || "";
      if (!src) continue;
      if (/pbs\.twimg\.com\/(media|tweet_video_thumb|amplify_video_thumb|ext_tw_video_thumb|card_img)\//.test(src)) {
        return src;
      }
    }
    for (const v of tweet.querySelectorAll("video")) {
      if (isInsideQuote(v, tweet)) continue;
      if (v.poster) return v.poster;
    }
    return "";
  }

  // Full text for text-only captures (no truncation). The outer
  // tweet's body is under [data-testid="tweetText"]; quoted tweets
  // have their own, which we skip.
  function extractTweetFullText(tweet) {
    for (const node of tweet.querySelectorAll('[data-testid="tweetText"]')) {
      if (isInsideQuote(node, tweet)) continue;
      return (node.textContent || "").replace(/\s+/g, " ").trim();
    }
    return "";
  }

  function extractTweetText(tweet) {
    const text = extractTweetFullText(tweet);
    return text.length > 240 ? text.slice(0, 237) + "…" : text;
  }

  // Avatars / emoji / hashflag paths on pbs.twimg.com that must
  // NEVER be mistaken for tweet media. Everything else on the
  // twimg CDN is treated as content (photos, card previews, video
  // thumbnails).
  const NON_MEDIA_TWIMG = /pbs\.twimg\.com\/(profile_images|profile_banners|emoji|hashflags|semantic_core_img)\//;

  function isTweetContentImg(imgEl, tweet) {
    if (isInsideQuote(imgEl, tweet)) return false;
    const src = imgEl.currentSrc || imgEl.src || "";
    if (!src || !src.includes("pbs.twimg.com/")) return false;
    if (NON_MEDIA_TWIMG.test(src)) return false;
    return true;
  }

  // Collect every outer-tweet photo URL, upgraded to name=orig for
  // best quality. Each tweet photo lives inside a
  // [data-testid="tweetPhoto"] container OR (fallback) as a bare
  // <img> on pbs.twimg.com that isn't an avatar/emoji.
  function extractPhotoUrls(tweet) {
    const urls = new Set();
    // tweetPhoto-scoped imgs first (most reliable marker).
    for (const container of tweet.querySelectorAll('[data-testid="tweetPhoto"]')) {
      if (isInsideQuote(container, tweet)) continue;
      const img = container.querySelector("img");
      const src = img?.currentSrc || img?.src || "";
      if (src && !NON_MEDIA_TWIMG.test(src)) urls.add(canonicalPhotoUrl(src));
    }
    // Fallback: any pbs.twimg.com img on the outer tweet. Picks up
    // photos on tweet variants that don't use tweetPhoto.
    for (const img of tweet.querySelectorAll("img")) {
      if (!isTweetContentImg(img, tweet)) continue;
      // Skip video-thumb paths — those are posters, not photos to
      // download directly.
      const src = img.currentSrc || img.src || "";
      if (/\/(tweet_video_thumb|amplify_video_thumb|ext_tw_video_thumb)\//.test(src)) continue;
      urls.add(canonicalPhotoUrl(src));
    }
    return [...urls];
  }

  // Normalize a pbs.twimg.com photo URL to the largest variant. The
  // `name` param controls size (small/medium/large/orig); pick orig.
  function canonicalPhotoUrl(url) {
    try {
      const u = new URL(url);
      if (u.hostname !== "pbs.twimg.com") return url;
      u.searchParams.set("name", "orig");
      if (!u.searchParams.has("format")) u.searchParams.set("format", "jpg");
      return u.toString();
    } catch { return url; }
  }

  function tweetHasVideo(tweet) {
    for (const el of tweet.querySelectorAll('[data-testid="videoPlayer"], [data-testid="videoComponent"]')) {
      if (!isInsideQuote(el, tweet)) return true;
    }
    for (const v of tweet.querySelectorAll("video")) {
      if (!isInsideQuote(v, tweet)) return true;
    }
    return false;
  }

  function extractVideoPoster(tweet) {
    for (const v of tweet.querySelectorAll("video")) {
      if (isInsideQuote(v, tweet)) continue;
      if (v.poster) return v.poster;
    }
    for (const img of tweet.querySelectorAll("img")) {
      if (isInsideQuote(img, tweet)) continue;
      const src = img.currentSrc || img.src || "";
      if (/\/(tweet_video_thumb|amplify_video_thumb|ext_tw_video_thumb)\//.test(src)) {
        return src;
      }
    }
    return "";
  }

  // Does the OUTER tweet carry any downloadable media? Union of
  // photos + videos + the /photo|video/ URL shortcut.
  function tweetHasMedia(tweet) {
    if (/\/status\/\d+\/(photo|video)\/\d+/.test(location.pathname)) return true;
    if (tweetHasVideo(tweet)) return true;
    return extractPhotoUrls(tweet).length > 0;
  }

  // ---- button ----
  // Styles live in twitter-post-grab.css, loaded by manifest alongside
  // this script.

  // 26px icon from the shared grab-button helper (loaded immediately
  // before this script via manifest.json). fits Twitter's tweet
  // action-bar density.
  const FETCH_ICON_SVG = window.__frixtyGrabButton.fetchIconSvg(26);
  const flashCaptured = window.__frixtyGrabButton.flashCaptured;
  const flashError = window.__frixtyGrabButton.flashError;

  function makeButton(tweet) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ytdlp-tw-grab";
    btn.innerHTML = FETCH_ICON_SVG;
    btn.title = "fetch media";
    btn.setAttribute("aria-label", "yt-dlp download");

    let inFlight = false;
    const onAct = async (ev) => {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      ev.stopPropagation();
      if (inFlight) return;
      inFlight = true;
      const url = extractTweetPermalink(tweet);
      if (!url) {
        console.warn("[frixty/tw-grab] no permalink for tweet", tweet);
        inFlight = false;
        return;
      }
      const author = extractAuthor(tweet);
      const title = extractTweetText(tweet);
      const fullText = extractTweetFullText(tweet);

      // Primary: call the Twitter syndication API for an
      // authoritative list of the tweet's media. Mixed-media tweets
      // (e.g. 1 photo + 1 video) reliably round-trip through this
      // endpoint but don't always expose every item in the DOM
      // — the video's slot can hide the companion photo from the
      // scraper when Twitter decides to use a different layout for
      // the mixed case.
      let payloads = null;
      const apiMedia = await fetchSyndicationMedia(url);
      if (apiMedia && apiMedia.length > 0) {
        payloads = payloadsFromApiMedia(apiMedia, url, author, fullText || title);
      }

      // Fallback: DOM scrape (the previous behaviour). Used when the
      // syndication endpoint refused / errored / returned empty
      // mediaDetails (deleted tweets, some NSFW, rate limit).
      if (!payloads || payloads.length === 0) {
        const photos = extractPhotoUrls(tweet);
        const hasVideo = tweetHasVideo(tweet);
        const handleSlug = sanitize(author || "tweet").slice(0, 40) || "tweet";
        const dom = [];
        photos.forEach((photoUrl, i) => {
          const basename = photos.length > 1
            ? `${handleSlug}-${i + 1}.jpg`
            : `${handleSlug}.jpg`;
          dom.push({
            url: photoUrl,
            item: {
              url: photoUrl,
              ext: "jpg",
              mime: "image/jpeg",
              width: 0, height: 0,
              thumbUrl: photoUrl,
              basename,
              handle: author || "",
              capturedTitle: fullText || title,
              sourceTweetUrl: url,
            },
            capturedAt: Date.now(),
          });
        });
        if (hasVideo) {
          const posterUrl = extractVideoPoster(tweet);
          dom.push({
            url,
            item: {
              url,
              viaYtDlp: true,
              ext: "mp4",
              mime: "video/mp4",
              width: 0, height: 0,
              thumbUrl: posterUrl,
              basename: `${handleSlug}.mp4`,
              handle: author || "",
              capturedTitle: fullText || title,
            },
            capturedAt: Date.now(),
          });
        }
        payloads = dom;
      }

      // Last resort: text-only capture (saves as .txt via the popup's
      // downloadTextCapture path).
      if (!payloads || payloads.length === 0) {
        payloads = [{
          url,
          author,
          thumbUrl: "",
          title,
          capturedAt: Date.now(),
          textOnly: true,
          content: fullText,
        }];
      }

      console.log("[frixty/tw-grab] capturing", {
        url: url.slice(0, 100),
        author: author || "(empty)",
        mediaCount: payloads.length,
        source: apiMedia && apiMedia.length > 0 ? "api" : "dom-or-text",
      });

      try {
        await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage(
            { type: "capture:add-batch", items: payloads },
            (resp) => {
              if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
              else resolve(resp);
            },
          );
        });
        flashCaptured(btn);
      } catch (err) {
        console.warn("[frixty/tw-grab] send failed", err?.message || err);
        flashError(btn);
      } finally {
        inFlight = false;
      }
    };
    // Capture-phase + multi-event listener set so the tweet's own
    // click delegation (opens tweet-detail view) doesn't swallow us.
    for (const evt of ["click", "pointerdown", "pointerup", "mousedown", "mouseup"]) {
      btn.addEventListener(evt, (ev) => {
        if (ev.type === "click" || ev.type === "pointerup" || ev.type === "pointerdown") {
          onAct(ev);
        } else {
          ev.stopPropagation();
        }
      }, true);
    }
    return btn;
  }

  // Walk up from the share button to the div the action bar uses to
  // space each action apart. Twitter wraps every action (reply,
  // retweet, like, bookmark, share) in its own flex container so the
  // gaps between them stay even. If we insert next to the raw share
  // button element, our button ends up crammed against share without
  // the surrounding margin. Instead, find share's SPACER parent (the
  // nearest ancestor whose sibling is the next action's spacer) and
  // insert our wrapper right after it.
  function shareSpacerOf(share, actionBar) {
    let node = share;
    while (node && node.parentElement && node.parentElement !== actionBar) {
      node = node.parentElement;
    }
    return node && node.parentElement === actionBar ? node : null;
  }

  function injectInto(tweet) {
    if (tweet.querySelector(":scope .ytdlp-tw-grab")) return;
    const share = findShareAnchor(tweet);
    const actionBar = findActionBar(tweet);
    const btn = makeButton(tweet);
    const wrap = document.createElement("div");
    wrap.className = "ytdlp-tw-grab-wrap";
    wrap.appendChild(btn);
    if (share && actionBar) {
      const spacer = shareSpacerOf(share, actionBar);
      if (spacer) {
        spacer.parentNode.insertBefore(wrap, spacer.nextSibling);
        return;
      }
      share.parentNode.insertBefore(wrap, share.nextSibling);
      return;
    }
    if (actionBar) {
      actionBar.appendChild(wrap);
      return;
    }
  }

  let scanScheduled = false;
  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    requestAnimationFrame(() => {
      scanScheduled = false;
      try {
        for (const tweet of findTweets()) injectInto(tweet);
      } catch (err) {
        console.warn("[frixty/tw-grab] scan error", err);
      }
    });
  }

  scheduleScan();
  const mo = new MutationObserver(scheduleScan);
  mo.observe(document.body, { childList: true, subtree: true });
  window.addEventListener("scroll", scheduleScan, { passive: true });
})();
