// Per-post "grab" button for Instagram. Same storage model as the
// Facebook and Twitter grab buttons — captures round-trip through
// chrome.storage.session's capture:list:<tabId> list, rendered by the
// popup's buildGalleryFromCaptures path, downloaded via the capture-
// gallery flow.
//
// Button placement differs by context so it sits near the UI the
// user naturally reaches for:
//   - Feed / post-detail / explore → next to the Share button in
//     the post's action row
//   - Reels (feed and detail) → ABOVE the Like/heart button in the
//     vertical action column
//   - Stories viewer → next to the mute button
//
// All three contexts resolve through the API (via background
// ig:fetch-* messages) so multi-slide carousels come back complete
// even when the DOM only has the currently-visible slide rendered.
(function () {
  if (window.__ytdlpIgGrabLoaded) return;
  window.__ytdlpIgGrabLoaded = true;
  console.log("[frixty/ig-grab] installed at", location.href);

  // ---- shared helpers ---------------------------------------------
  // Loaded by manifest.json's grab-button-shared.js before this
  // script. Provides the canonical icon, makeButton factory, and
  // per-button flash with WeakMap-tracked timers.
  const grab = window.__frixtyGrabButton;

  // ---- styles -----------------------------------------------------
  // Styles live in instagram-post-grab.css, loaded by manifest
  // alongside this script.

  // ---- helpers ----------------------------------------------------
  function sanitize(raw) {
    if (!raw) return "";
    return raw.replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, " ").trim();
  }
  function basenameFromUrl(url) {
    try { return new URL(url).pathname.split("/").pop() || ""; } catch { return ""; }
  }
  function extFromUrl(url) {
    try {
      const m = new URL(url).pathname.match(/\.([a-zA-Z0-9]{1,5})$/);
      return m ? m[1].toLowerCase() : "";
    } catch { return ""; }
  }

  // Extract the shortcode from an Instagram post/reel URL or an
  // in-page anchor href. Accepts `/p/<code>/`, `/reel/<code>/`, and
  // `/reels/<code>/` shapes. Returns "" when the href doesn't look
  // like a post URL.
  function shortcodeFromHref(href) {
    if (!href) return "";
    let path;
    try { path = new URL(href, location.origin).pathname; }
    catch { path = href; }
    const m = path.match(/^\/(?:p|reel|reels)\/([A-Za-z0-9_\-]+)\/?/);
    return m ? m[1] : "";
  }

  // Current page's shortcode (post / reel detail view). Empty on
  // feed / explore / stories / anything else.
  function currentPageShortcode() {
    return shortcodeFromHref(location.pathname);
  }

  // Username the story viewer is showing. /stories/<user>/<id>/
  function currentStoryUsername() {
    const seg = location.pathname.split("/").filter(Boolean);
    if (seg[0] === "stories" && seg[1]) return seg[1];
    return "";
  }

  function isStoryViewer() {
    return location.pathname.startsWith("/stories/");
  }

  // ---- button construction ----------------------------------------
  // Flash is the shared per-button (WeakMap-tracked) helper. CSS at
  // .ytdlp-ig-grab.is-captured / .is-error swaps the background to
  // green / red and inverts the icon colour — matches the TikTok
  // grab button feedback pattern.
  const flashCaptured = grab.flashCaptured;
  const flashError = grab.flashError;

  function makeButton() {
    return grab.makeButton({
      className: "ytdlp-ig-grab",
      title: "fetch media",
      ariaLabel: "yt-dlp download",
    });
  }

  function bindButton(btn, handler) {
    let inFlight = false;
    const onAct = async (ev) => {
      if (ev.target !== btn && !btn.contains(ev.target)) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      ev.stopPropagation();
      if (ev.type !== "click" && ev.type !== "pointerup") return;
      if (inFlight) return;
      inFlight = true;
      try {
        const ok = await handler();
        if (ok) flashCaptured(btn);
        else flashError(btn);
      } catch (err) {
        console.warn("[frixty/ig-grab] capture failed", err?.message || err);
        flashError(btn);
      } finally {
        inFlight = false;
      }
    };
    for (const evt of ["click", "pointerdown", "pointerup", "mousedown", "mouseup"]) {
      btn.addEventListener(evt, (ev) => {
        if (ev.target !== btn && !btn.contains(ev.target)) return;
        if (evt === "click" || evt === "pointerup") onAct(ev);
        else { ev.preventDefault(); ev.stopPropagation(); }
      }, true);
    }
  }

  // ---- media mapping ----------------------------------------------
  // Pick the highest-res candidate from Instagram's image_versions2,
  // and a lightweight one for the card thumbnail.
  function bestCandidate(list) {
    if (!Array.isArray(list) || list.length === 0) return null;
    return [...list].sort((a, b) => (b.width || 0) - (a.width || 0))[0];
  }
  function smallCandidate(list) {
    if (!Array.isArray(list) || list.length === 0) return null;
    const sorted = [...list].sort((a, b) => (a.width || 9999) - (b.width || 9999));
    return sorted[0]?.url || "";
  }

  // Turn one API media entry (or carousel_media entry) into a
  // gallery-item shape. Mirrors popup.js::instagramSlideToItem.
  function slideToItem(slide, handle) {
    if (!slide) return null;
    const isVideo = slide.media_type === 2 && Array.isArray(slide.video_versions) && slide.video_versions.length > 0;
    const thumb = smallCandidate(slide.image_versions2?.candidates);
    if (isVideo) {
      const vv = slide.video_versions[0];
      return {
        url: vv.url,
        ext: "mp4",
        width: vv.width || 0,
        height: vv.height || 0,
        thumbUrl: thumb || "",
        mime: "video/mp4",
        basename: basenameFromUrl(vv.url) || "video.mp4",
        handle,
      };
    }
    const best = bestCandidate(slide.image_versions2?.candidates);
    if (!best?.url) return null;
    const ext = extFromUrl(best.url) || "jpg";
    return {
      url: best.url,
      ext,
      width: best.width || 0,
      height: best.height || 0,
      thumbUrl: thumb || best.url,
      mime: `image/${ext === "jpg" ? "jpeg" : ext}`,
      basename: basenameFromUrl(best.url) || `image.${ext}`,
      handle,
    };
  }

  function buildPostPayloads(media, handle, sourceUrl) {
    const slides = Array.isArray(media.carousel_media) && media.carousel_media.length > 0
      ? media.carousel_media
      : [media];
    const captionText = (media.caption?.text || "").replace(/\s+/g, " ").trim();
    const payloads = [];
    const handleSlug = sanitize(handle || "post").slice(0, 40) || "post";
    let i = 0;
    for (const slide of slides) {
      const item = slideToItem(slide, handle);
      if (!item) continue;
      i++;
      // Give carousels indexed filenames so the N slides don't
      // collide (they'd otherwise all be basenamed off the slide's
      // cdn URL, which IS unique — but "user-1", "user-2" reads
      // better when the user's saving the set).
      if (slides.length > 1) {
        item.basename = `${handleSlug}-${i}.${item.ext}`;
      } else {
        item.basename = `${handleSlug}.${item.ext}`;
      }
      item.capturedTitle = captionText;
      item.sourceTweetUrl = sourceUrl; // reusing field — just a source link label
      payloads.push({ url: item.url, item, capturedAt: Date.now() });
    }
    return payloads;
  }

  function buildStoryPayloads(items, username, sourceUrl) {
    const payloads = [];
    const handleSlug = sanitize(username || "story").slice(0, 40) || "story";
    let i = 0;
    for (const it of items) {
      const slide = slideToItem(it, username);
      if (!slide) continue;
      i++;
      slide.basename = items.length > 1
        ? `${handleSlug}-story-${i}.${slide.ext}`
        : `${handleSlug}-story.${slide.ext}`;
      slide.sourceTweetUrl = sourceUrl;
      payloads.push({ url: slide.url, item: slide, capturedAt: Date.now() });
    }
    return payloads;
  }

  async function sendCaptures(payloads) {
    if (!payloads || payloads.length === 0) return false;
    const resp = await new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: "capture:add-batch", items: payloads },
        (r) => resolve(r || { ok: false }),
      );
    });
    console.log("[frixty/ig-grab] captured", { sent: payloads.length, resp });
    return !!resp?.ok;
  }

  // ---- per-context handlers ---------------------------------------
  async function capturePost(shortcode, dfaultHandle = "") {
    const resp = await new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: "ig:fetch-post-media", shortcode },
        (r) => resolve(r || { ok: false }),
      );
    });
    if (!resp?.ok || !resp.media) {
      console.warn("[frixty/ig-grab] post api failed", resp?.error);
      return false;
    }
    const handle = resp.media.user?.username || resp.media.owner?.username || dfaultHandle || "";
    const sourceUrl = `https://www.instagram.com/p/${shortcode}/`;
    const payloads = buildPostPayloads(resp.media, handle, sourceUrl);
    return sendCaptures(payloads);
  }

  async function captureStory(username) {
    const resp = await new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: "ig:fetch-story-media", username },
        (r) => resolve(r || { ok: false }),
      );
    });
    if (!resp?.ok || !Array.isArray(resp.items) || resp.items.length === 0) {
      console.warn("[frixty/ig-grab] story api failed", resp?.error);
      return false;
    }
    const sourceUrl = location.href;
    const payloads = buildStoryPayloads(resp.items, username, sourceUrl);
    return sendCaptures(payloads);
  }

  // ---- DOM injection ----------------------------------------------
  // Post action row: Instagram's action section has Like / Comment /
  // Share aligned left, Save aligned right. The share affordance
  // carries aria-label="Share" OR "Send post" OR (rarely) "Send"
  // on EITHER the SVG itself or the wrapping button, depending on
  // which Instagram UI variant the page is running. Check a few
  // shapes and walk up to the clickable wrapper.
  function findPostShare(root) {
    const labels = ["Share", "Send post", "Send Post", "Send"];
    // SVG-labelled variants first (most common).
    for (const label of labels) {
      const svg = root.querySelector(`svg[aria-label="${label}"]`);
      if (svg) {
        return svg.closest('button, [role="button"], div[role="button"]') || svg.parentElement;
      }
    }
    // Button/link-labelled variants (some experiments attach the
    // label to the button instead of the SVG).
    for (const label of labels) {
      const b = root.querySelector(
        `button[aria-label="${label}"], [role="button"][aria-label="${label}"]`,
      );
      if (b) return b;
    }
    // Case-insensitive catch-all — handles "share", localized
    // variants that include "share" or "send" as substrings, etc.
    for (const svg of root.querySelectorAll("svg[aria-label]")) {
      const label = (svg.getAttribute("aria-label") || "").toLowerCase();
      if (label === "share" || label === "send" || label.startsWith("send post") ||
          (label.includes("share") && !label.includes("saved"))) {
        return svg.closest('button, [role="button"], div[role="button"]') || svg.parentElement;
      }
    }
    return null;
  }

  // The Like button on reel viewers is the first SVG with
  // aria-label="Like" inside the reel's vertical action column.
  function findReelLike(root) {
    const svg =
      root.querySelector('svg[aria-label="Like"]') ||
      root.querySelector('svg[aria-label="Unlike"]');
    if (svg) return svg.closest('button, [role="button"], div[role="button"]') || svg.parentElement;
    return null;
  }

  // NOTE: findStoryMute / scanStory were previously used to inject
  // the button next to the story mute button. The user asked for
  // it to stay near the heart (same as reels), so scanReels now
  // handles the story case too and these helpers are retired.

  function scanPosts() {
    // scanReels / scanStory handle their own page kinds. Bail out
    // early so we don't double-inject on /reel, /reels, /stories
    // — those have <article>-like wrappers too on some variants.
    if (/^\/(reel|reels)\//.test(location.pathname)) return;
    if (location.pathname.startsWith("/stories/")) return;
    // Articles cover the home feed, explore, and MOST post-detail
    // layouts.
    for (const post of document.querySelectorAll("article")) {
      tryInjectPost(post);
    }
    // Post-detail fallback. If the URL is /p/<code>/ and NO article
    // wrapping produced a button, scan the document as the scope.
    // Some post-detail layouts render the post outside an <article>
    // (e.g. when IG ships a variant that wraps the dialog in a
    // plain <div role="dialog"> without an article inside).
    if (/^\/p\//.test(location.pathname) && !document.querySelector(".ytdlp-ig-grab")) {
      tryInjectPost(document.body);
    }
  }

  function tryInjectPost(root) {
    if (root.querySelector(":scope .ytdlp-ig-grab") || root.querySelector(".ytdlp-ig-grab")) return;
    const share = findPostShare(root);
    if (!share) return;
    // Shortcode: first a[href*="/p/"] or a[href*="/reel/"] inside
    // the scope. Falls back to the current page's shortcode (works
    // when the user's on the post-detail view).
    let shortcode = "";
    for (const a of root.querySelectorAll('a[href]')) {
      const code = shortcodeFromHref(a.getAttribute("href"));
      if (code) { shortcode = code; break; }
    }
    if (!shortcode) shortcode = currentPageShortcode();
    if (!shortcode) return;
    // Handle from a header anchor inside the scope, if visible.
    const handleAnchor = root.querySelector('header a[href^="/"]');
    const handle = handleAnchor?.getAttribute("href")?.split("/").filter(Boolean)[0] || "";
    const btn = makeButton();
    bindButton(btn, () => capturePost(shortcode, handle));
    // Insert AFTER share so visual order matches other action
    // buttons. Share's parent is the flex container for the left-
    // side action group.
    share.parentNode.insertBefore(btn, share.nextSibling);
  }

  function scanReels() {
    // Reels feed, reel-detail, and the story viewer ALL render a
    // vertical action column with a Like button at the bottom. The
    // column-width heuristic I used before (width < 80) matched
    // both the reel column AND each feed-post's button-wrapper div
    // (which is also narrow because it only wraps one button), so
    // the feed was getting a duplicate button above the heart.
    //
    // Fix: only run this scan on URLs that actually show a reel or
    // a story. Feed (/) and post-detail (/p/<code>/) are handled
    // exclusively by scanPosts.
    const isReels = /^\/(reel|reels)\//.test(location.pathname);
    const isStory = location.pathname.startsWith("/stories/");
    if (!isReels && !isStory) return;

    const likes = new Set();
    const svgs = document.querySelectorAll('svg[aria-label="Like"], svg[aria-label="Unlike"]');
    for (const svg of svgs) {
      const likeBtn = svg.closest('button, [role="button"], div[role="button"]') || svg.parentElement;
      if (!likeBtn) continue;
      const column = likeBtn.parentElement;
      if (!column) continue;
      if (column.querySelector(":scope .ytdlp-ig-grab")) continue;
      if (likes.has(column)) continue;
      likes.add(column);

      const btn = makeButton();
      if (isStory) {
        // White opaque circle behind the icon so it reads against
        // bright / dark / video story backgrounds.
        btn.classList.add("overlay");
        const username = currentStoryUsername();
        if (!username) continue;
        bindButton(btn, () => captureStory(username));
      } else {
        // Reel viewer. Find the reel's own shortcode, either from
        // a visible permalink anchor in the main area or from the
        // page URL (reel-detail path).
        let shortcode = "";
        const root = column.closest("[role=main]") || document.body;
        for (const a of root.querySelectorAll('a[href]')) {
          const code = shortcodeFromHref(a.getAttribute("href"));
          if (code) { shortcode = code; break; }
        }
        if (!shortcode) shortcode = currentPageShortcode();
        if (!shortcode) continue;
        bindButton(btn, () => capturePost(shortcode));
      }
      // Insert BEFORE like button so it appears ABOVE in the column.
      column.insertBefore(btn, likeBtn);
    }
  }

  let scanScheduled = false;
  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    requestAnimationFrame(() => {
      scanScheduled = false;
      try {
        scanPosts();
        scanReels();
      } catch (err) {
        console.warn("[frixty/ig-grab] scan error", err);
      }
    });
  }

  scheduleScan();
  const mo = new MutationObserver(scheduleScan);
  mo.observe(document.body, { childList: true, subtree: true });
  window.addEventListener("scroll", scheduleScan, { passive: true });
})();
