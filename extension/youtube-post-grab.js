// YouTube fetch button. Sits:
//   - to the LEFT of the like button on regular watch pages
//   - ABOVE the like button on Shorts (the action column there is
//     vertical, so "previous sibling in the column" = above)
//
// Clicking it just asks the SW to trigger the popup's own "Fetch
// media on this page" flow (via the yt:trigger-fetch relay +
// auto-fetch-pending flag in session storage). No custom media
// discovery — the popup's existing yt-dlp listFormats path already
// handles every YouTube URL shape correctly, so re-using it keeps
// the grab button free of extractor-shape drift.
(function () {
  if (window.__ytdlpYtGrabLoaded) return;
  window.__ytdlpYtGrabLoaded = true;
  const LOG = (...args) => console.log("[frixty/yt-grab]", ...args);
  LOG("installed at", location.href);

  // Pulled from grab-button-shared.js (loaded immediately before this
  // script via manifest.json). Provides the canonical icon SVG +
  // per-button flash helpers used by every grab script.
  const grab = window.__frixtyGrabButton;

  function isShorts() {
    return location.pathname.startsWith("/shorts/");
  }

  // Find the visible like button. YouTube has shipped this under many
  // shapes — aria-label is the most stable signal since the UI copy
  // ("like this video", "I like this", plain "Like") stays close to
  // those words across layouts.
  function findLikeButton() {
    const candidates = document.querySelectorAll(
      'button[aria-label*="like this video" i], ' +
        'button[aria-label*="I like this" i], ' +
        'button[aria-label^="Like " i], ' +
        'button[aria-label="like" i], ' +
        "ytd-toggle-button-renderer[is-paper-button], " +
        '[role="button"][aria-label*="like this video" i], ' +
        '[role="button"][aria-label*="I like this" i]',
    );
    for (const el of candidates) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return el;
    }
    return null;
  }

  function makeButton(variant) {
    return grab.makeButton({
      className: "ytdlp-yt-grab" + (variant ? " ytdlp-yt-grab-" + variant : ""),
      title: "Fetch media — opens Frixty Fetcher",
      ariaLabel: "Frixty Fetcher fetch media",
      onClick,
    });
  }

  async function onClick(ev) {
    const btn = ev.currentTarget;
    try {
      ev.preventDefault();
      ev.stopPropagation();
    } catch {}
    LOG("click", {
      url: location.href,
      variant: btn.classList.contains("ytdlp-yt-grab-shorts") ? "shorts" : "watch",
    });
    try {
      const video = document.querySelector("video");
      const currentTime = Number.isFinite(video?.currentTime) ? video.currentTime : 0;
      const resp = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          { type: "yt:trigger-fetch", url: location.href, currentTime },
          (r) => {
            if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
            else resolve(r);
          },
        );
      });
      if (resp?.ok) grab.flashCaptured(btn);
      else grab.flashError(btn);
    } catch (err) {
      LOG("sendMessage err", err?.message || err);
      grab.flashError(btn);
    }
  }

  // Inject next to the like button. Returns true if a fresh button
  // was placed this call (for diagnostics), false if one already
  // existed or the like button wasn't findable yet.
  function inject() {
    if (document.querySelector(".ytdlp-yt-grab")) return false;
    const like = findLikeButton();
    if (!like) return false;
    const variant = isShorts() ? "shorts" : "watch";
    const btn = makeButton(variant);

    // On regular watch pages YouTube wraps the like / dislike pair in
    // a `segmented-like-dislike-button-view-model` — we want the
    // button positioned BEFORE that whole wrapper (left of the pair)
    // rather than splitting it. On shorts the vertical action column
    // stacks each action's own wrapper, so inserting before the
    // like-button wrapper gives "above the like button" naturally.
    const wrap =
      like.closest("segmented-like-dislike-button-view-model") ||
      like.closest("yt-smartimation") ||
      like.closest("#like-button") ||
      like.closest("ytd-toggle-button-renderer") ||
      like;
    if (wrap && wrap.parentElement) {
      wrap.parentElement.insertBefore(btn, wrap);
      LOG("injected", { variant, wrapTag: wrap.tagName, wrapId: wrap.id });
      return true;
    }
    return false;
  }

  // Run now + on every DOM mutation. YouTube's SPA swaps the watch /
  // shorts content in place without a full page load, so we have to
  // keep watching.
  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      try {
        inject();
      } catch (err) {
        LOG("inject err", err?.message || err);
      }
    });
  }
  schedule();
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  // SPA navigation: same DOM, different URL. Force a fresh inject by
  // removing any existing button (so its variant + placement gets
  // re-decided for the new page type).
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      const stale = document.querySelector(".ytdlp-yt-grab");
      if (stale) stale.remove();
      schedule();
    }
  }, 500);
})();
