// Per-post "grab" button for TikTok. Two placements:
//
//   - Feed (For You, profile, trending): overlay button ABOVE the
//     author avatar inside the right-side vertical action bar.
//   - Individual video page (/@user/video/<id>): button next to the
//     "..." more-options button. If we can't find one, a fixed-
//     position fallback button lands at top-right so the user
//     always has access.
//
// On click, the button resolves the post's canonical URL via
// extractPostUrl() and dispatches it to the service worker for
// fetching. The SW runs the full listFormats → format-pick → download
// pipeline — the grab button is a one-click shortcut to the same
// flow the extension popup's "Fetch media on this page" button runs.
(function () {
  if (window.__ytdlpTikTokGrabLoaded) return;
  window.__ytdlpTikTokGrabLoaded = true;
  const LOG = (...args) => console.log("[frixty/tt-grab]", ...args);
  const WARN = (...args) => console.warn("[frixty/tt-grab]", ...args);
  LOG("installed at", location.href);

  // Pure helpers come from tiktok-shared.js, which manifest.json
  // loads immediately before this file in the same isolated world.
  const { CACHE_MAX, ABS_VIDEO_URL_RE, VIDEO_PATH_RE, findCanonicalUrlForPost } =
    window.__ytdlpTtShared;

  // ---- Button feedback timings (ms) ----
  // "Pressing" is the instant-click flash so the user sees their
  // click registered before the async work completes; the other
  // states hold long enough to read.
  const PRESSING_FLASH_MS = 240;
  const CAPTURED_FLASH_MS = 1100;
  const ERROR_FLASH_MS = 1500;
  // Click-time diagnostic log caps (keep logs readable when a post
  // has dozens of anchors or when the cache is full).
  const DIAG_ANCHOR_LIMIT = 10;
  const DIAG_IMG_LIMIT = 6;
  const DIAG_CACHE_LIMIT = 10;
  const DIAG_IMG_SRC_LEN = 160;
  const URL_LOG_LEN = 120;

  const FETCH_ICON_SVG =
    '<svg viewBox="0 0 32 32" width="30" height="30" fill="currentColor" ' +
    'aria-hidden="true">' +
    '<polygon points="24 19 21 19 21 16 19 16 19 19 16 19 16 21 19 21 19 24 21 24 21 21 24 21 24 19"/>' +
    '<path d="M31,29.5859l-4.6885-4.6884a8.028,8.028,0,1,0-1.414,1.414L29.5859,31ZM20,26a6,6,0,1,1,6-6A6.0066,6.0066,0,0,1,20,26Z"/>' +
    '<path d="M4,8H2V4A2.0021,2.0021,0,0,1,4,2H8V4H4Z"/>' +
    '<path d="M26,8H24V4H20V2h4a2.0021,2.0021,0,0,1,2,2Z"/>' +
    '<rect x="12" y="2" width="4" height="2"/>' +
    '<path d="M8,26H4a2.0021,2.0021,0,0,1-2-2V20H4v4H8Z"/>' +
    '<rect x="2" y="12" width="2" height="4"/>' +
    "</svg>";

  // ---------------------------------------------------------------------------
  // MAIN-world interceptor integration
  // ---------------------------------------------------------------------------
  //
  // tiktok-interceptor.js (loaded as a MAIN-world content script at
  // document_start) postMessages batches of intercepted video metadata
  // as TikTok's own fetch/XHR calls resolve. We cache them here so
  // findCanonicalUrlForPost can recover the canonical URL for videos
  // whose DOM doesn't carry any /@user/video/<id> anchor — the key
  // gap on the logged-out For You feed.
  //
  // interceptCache: id → {id, authorId, desc, playAddr, downloadAddr, cover}
  const interceptCache = new Map();

  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const data = ev.data;
    if (!data || typeof data !== "object" || !data.__ytdlpTtInterceptor) return;
    if (!Array.isArray(data.items)) return;
    let added = 0;
    for (const item of data.items) {
      if (!item || typeof item !== "object" || !item.id) continue;
      const existing = interceptCache.get(item.id);
      if (!existing || (item.authorId && !existing.authorId)) {
        interceptCache.set(item.id, item);
        added++;
      }
    }
    while (interceptCache.size > CACHE_MAX) {
      interceptCache.delete(interceptCache.keys().next().value);
    }
    if (added > 0) {
      LOG("interceptor cache", {
        source: data.source,
        batch: data.items.length,
        added,
        size: interceptCache.size,
      });
    }
  });

  // Expose the currently-playing-match to the popup via runtime
  // messaging. The popup's "Fetch media on this page" flow (Tier 2.5
  // resolveTikTokUrlFromDom) can't see into our content script from
  // its executeScript-based scraper, so when all of its DOM
  // strategies miss it falls back to asking us via this handler.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== "object") return false;
    if (msg.type !== "tt:get-current-url") return false;
    // Pick the viewport-centered article; findCanonicalUrlForPost
    // runs its three tiers against that.
    let centeredArticle = null;
    try {
      const vh = window.innerHeight || document.documentElement.clientHeight;
      const articleSel =
        'article[id^="one-column-item-"], article[id^="feed-item-"], article[id^="video-item-"]';
      let bestDist = Infinity;
      for (const a of document.querySelectorAll(articleSel)) {
        const r = a.getBoundingClientRect();
        if (r.bottom <= 0 || r.top >= vh) continue;
        const centerY = r.top + r.height / 2;
        const dist = Math.abs(centerY - vh / 2);
        if (dist < bestDist) {
          bestDist = dist;
          centeredArticle = a;
        }
      }
    } catch {}
    const result = findCanonicalUrlForPost(
      centeredArticle,
      Array.from(interceptCache.values()),
      location.href,
    );
    LOG("tt:get-current-url", {
      url: result.url.slice(0, URL_LOG_LEN),
      source: result.tier,
      cacheSize: interceptCache.size,
    });
    sendResponse({
      ok: !!result.url,
      url: result.url,
      source: result.tier,
      cacheSize: interceptCache.size,
    });
    return true;
  });

  // ---------------------------------------------------------------------------
  // Download progress listener
  // ---------------------------------------------------------------------------
  //
  // The SW (see background.js :: ttJobTabs + relayTtJobMessage)
  // forwards host progress / done / error events for
  // grab-button-initiated downloads. We match by dataset.jobId on
  // the button and update its state.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== "object") return false;
    if (msg.type !== "tt:dl-progress" && msg.type !== "tt:dl-done" && msg.type !== "tt:dl-error") {
      return false;
    }
    const btn = document.querySelector(
      `.ytdlp-tt-grab[data-job-id="${CSS.escape(msg.jobId || "")}"]`,
    );
    if (!btn) {
      sendResponse({ ok: false, reason: "no-button" });
      return false;
    }
    if (msg.type === "tt:dl-progress") {
      const pct = Math.max(0, Math.min(100, Number(msg.percent) || 0));
      btn.style.setProperty("--ytdlp-pct", pct.toFixed(1) + "%");
      btn.title = `Downloading… ${pct.toFixed(0)}%`;
    } else if (msg.type === "tt:dl-done") {
      LOG("download done", { jobId: msg.jobId, path: (msg.path || "").slice(0, 200) });
      btn.classList.remove("is-downloading");
      btn.classList.add("is-captured");
      btn.title = "Downloaded";
      btn.removeAttribute("data-job-id");
      btn.dataset.inFlight = "0";
      setTimeout(() => {
        btn.classList.remove("is-captured");
        btn.title = "fetch media";
        btn.style.removeProperty("--ytdlp-pct");
      }, CAPTURED_FLASH_MS * 2);
    } else {
      const canceled = msg.code === "download_canceled";
      if (canceled) {
        LOG("download canceled", { jobId: msg.jobId });
      } else {
        WARN("download error", {
          jobId: msg.jobId,
          code: msg.code,
          message: (msg.message || "").slice(0, 200),
        });
      }
      btn.classList.remove("is-downloading");
      btn.removeAttribute("data-job-id");
      btn.dataset.inFlight = "0";
      btn.style.removeProperty("--ytdlp-pct");
      if (canceled) {
        // User-initiated cancel: just reset silently.
        btn.title = "fetch media";
      } else {
        btn.classList.add("is-error");
        btn.title = msg.message ? `Error: ${String(msg.message).slice(0, 120)}` : "Error";
        setTimeout(() => {
          btn.classList.remove("is-error");
          btn.title = "fetch media";
        }, ERROR_FLASH_MS * 2);
      }
    }
    sendResponse({ ok: true });
    return false;
  });

  // ---------------------------------------------------------------------------
  // URL + metadata extraction
  // ---------------------------------------------------------------------------

  // Thin wrapper around findCanonicalUrlForPost (shared). Logs which
  // tier matched on success, or the full tried[] list plus cache
  // size on failure (useful when a user reports "the button gave
  // me nothing" and we need to tell whether the cache was empty or
  // the post truly had no identifying signal).
  function extractPostUrl(postEl) {
    const { url, tier, tried } = findCanonicalUrlForPost(
      postEl,
      Array.from(interceptCache.values()),
      location.href,
    );
    if (url) {
      LOG("extractPostUrl: hit", { tier, url: url.slice(0, URL_LOG_LEN), tried });
    } else {
      WARN("extractPostUrl: no match", {
        tried,
        locationHref: location.href,
        interceptCacheSize: interceptCache.size,
      });
    }
    return url;
  }

  function extractAuthor(postEl) {
    const handleEl = postEl?.querySelector?.('[data-e2e="video-author-uniqueid"]');
    const handle = handleEl?.textContent?.trim();
    if (handle) return handle.replace(/^@/, "");
    const url = extractPostUrl(postEl);
    // VIDEO_PATH_RE is anchored at start-of-string so it won't match
    // against a full URL — parse the path first.
    try {
      const m = new URL(url).pathname.match(VIDEO_PATH_RE);
      if (m) return m[1];
    } catch {}
    return "";
  }

  function extractTitle(postEl) {
    const descEl =
      postEl?.querySelector?.('[data-e2e="browse-video-desc"]') ||
      postEl?.querySelector?.('[data-e2e="video-desc"]');
    return (descEl?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function extractThumbnail(postEl) {
    const v = postEl?.querySelector?.("video");
    if (v?.poster) return v.poster;
    const img = postEl?.querySelector?.('img[src*="tiktokcdn"], img[src*="tiktok"]');
    return img?.currentSrc || img?.src || "";
  }

  // ---------------------------------------------------------------------------
  // Button element
  // ---------------------------------------------------------------------------

  function makeButton(postEl, variant) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ytdlp-tt-grab" + (variant ? " ytdlp-tt-grab-" + variant : "");
    btn.innerHTML = FETCH_ICON_SVG;
    btn.title = "fetch media";
    btn.setAttribute("aria-label", "yt-dlp download");
    btn.dataset.ytdlpVariant = variant || "";

    const onAct = async (ev) => {
      if (ev) {
        try {
          ev.preventDefault();
        } catch {}
        try {
          ev.stopImmediatePropagation();
        } catch {}
        try {
          ev.stopPropagation();
        } catch {}
      }
      if (btn.dataset.inFlight === "1") return;
      btn.dataset.inFlight = "1";
      btn.classList.add("is-pressing");
      setTimeout(() => btn.classList.remove("is-pressing"), PRESSING_FLASH_MS);
      try {
        LOG("click", variant);
        // Dump everything we can see about the post container so the
        // user's saved page-console log shows enough context to
        // diagnose wrong-video issues. Cheap in dev (one click) and
        // the log noise is worth more than the cost.
        if (postEl) {
          const anchors = Array.from(postEl.querySelectorAll("a[href]"))
            .map((a) => a.getAttribute("href"))
            .filter(Boolean)
            .slice(0, DIAG_ANCHOR_LIMIT);
          const imgSrcs = Array.from(postEl.querySelectorAll("img"))
            .map((i) => i.currentSrc || i.src)
            .filter(Boolean)
            .slice(0, DIAG_IMG_LIMIT);
          const dataAttrs = {};
          for (const attr of postEl.attributes || []) {
            if (attr.name.startsWith("data-")) dataAttrs[attr.name] = attr.value;
          }
          const cacheSummary = Array.from(interceptCache.values())
            .slice(0, DIAG_CACHE_LIMIT)
            .map((it) => `${it.id}/@${it.authorId}`)
            .join(" | ");
          // Serialize arrays as pre-joined strings so they survive
          // console-log saving (the user's previous log files
          // truncated Array(N) contents). Loud but cheap; users can
          // filter by tag if it's too noisy.
          LOG("click: post diag id=" + postEl.id);
          LOG("click: post anchors=" + anchors.join(" | "));
          LOG("click: post imgs=" + imgSrcs.map((s) => s.slice(0, DIAG_IMG_SRC_LEN)).join(" | "));
          LOG("click: post data-attrs=" + JSON.stringify(dataAttrs));
          LOG("click: cache size=" + interceptCache.size + " items=" + cacheSummary);
        }
        const urlResult = findCanonicalUrlForPost(
          postEl,
          Array.from(interceptCache.values()),
          location.href,
        );
        const url = urlResult.url;
        if (!url) {
          WARN("click: no canonical URL for post", {
            variant,
            tried: urlResult.tried,
            cacheSize: interceptCache.size,
          });
          // Forward the diagnostic to the SW so it lands in the
          // extension log (page-console WARNs don't). Include enough
          // context to reproduce: tier attempts, cache, and whether
          // the post had an author anchor at all.
          try {
            chrome.runtime.sendMessage({
              type: "debug:tt-grab-fail",
              stage: "no-url",
              diag: {
                variant,
                location: location.href,
                tried: urlResult.tried,
                interceptCacheSize: interceptCache.size,
                authorFromAnchors: postEl
                  ? window.__ytdlpTtShared.extractAuthorFromAnchors(postEl) || ""
                  : "",
                postId: postEl?.id || "",
                cacheSample: Array.from(interceptCache.values())
                  .slice(0, 5)
                  .map((it) => `${it.id}/@${it.authorId}`),
              },
            });
          } catch {}
          btn.classList.add("is-error");
          setTimeout(() => btn.classList.remove("is-error"), ERROR_FLASH_MS);
          btn.dataset.inFlight = "0";
          return;
        }
        // Send a capture entry so this post shows up in the popup's
        // gallery the same way FB / Twitter / IG grab buttons do.
        // The popup routes URL-shaped captures (no direct media) to
        // yt-dlp on Download, and auto-starts the download if the
        // user unchecked "Prompt each download."
        const cachedItem = (() => {
          for (const it of interceptCache.values()) {
            if (url.endsWith("/" + it.id)) return it;
          }
          return null;
        })();
        const author = cachedItem?.authorId || extractAuthor(postEl) || "";
        const title = cachedItem?.desc || extractTitle(postEl) || "";
        const thumbUrl = cachedItem?.cover || extractThumbnail(postEl) || "";
        const payload = {
          url,
          author,
          thumbUrl,
          title,
          capturedAt: Date.now(),
        };
        LOG("staging capture", { url: url.slice(0, URL_LOG_LEN), author, titleLen: title.length });
        let resp;
        try {
          resp = await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({ type: "capture:add", payload }, (r) => {
              if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
              else resolve(r);
            });
          });
        } catch (err) {
          WARN("sendMessage failed", err?.message || err);
          try {
            chrome.runtime.sendMessage({
              type: "debug:tt-grab-fail",
              stage: "sendmessage-failed",
              diag: { variant, url: url.slice(0, URL_LOG_LEN), error: String(err?.message || err) },
            });
          } catch {}
          btn.classList.add("is-error");
          setTimeout(() => btn.classList.remove("is-error"), ERROR_FLASH_MS);
          btn.dataset.inFlight = "0";
          return;
        }
        if (!resp || !resp.ok) {
          WARN("SW refused capture:add", resp);
          try {
            chrome.runtime.sendMessage({
              type: "debug:tt-grab-fail",
              stage: "sw-refused",
              diag: {
                variant,
                url: url.slice(0, URL_LOG_LEN),
                response: JSON.stringify(resp || null).slice(0, 200),
              },
            });
          } catch {}
          btn.classList.add("is-error");
          setTimeout(() => btn.classList.remove("is-error"), ERROR_FLASH_MS);
          btn.dataset.inFlight = "0";
          return;
        }
        // Brief green-check flash, then back to the default icon.
        btn.classList.add("is-captured");
        btn.title = "Added to gallery";
        setTimeout(() => {
          btn.classList.remove("is-captured");
          btn.title = "fetch media";
        }, CAPTURED_FLASH_MS);
        btn.dataset.inFlight = "0";
      } catch (err) {
        WARN("click handler threw", err?.message || err);
        btn.classList.add("is-error");
        setTimeout(() => btn.classList.remove("is-error"), ERROR_FLASH_MS);
        btn.dataset.inFlight = "0";
      }
    };

    // Primary handler: the window-capture pointerdown delegator
    // (see installGlobalClickDelegator). It runs at the earliest
    // possible dispatch phase and both fires onAct and stops
    // propagation, so TikTok's own window-capture listeners can't
    // swallow our click. btn.onclick is a degraded fallback for
    // the rare case where the window handler doesn't run.
    btn.onclick = onAct;
    btn.__ytdlpTtOnAct = onAct;
    return btn;
  }

  // installGlobalClickDelegator hooks window-capture pointerdown for
  // any grab button, bypassing any stopImmediatePropagation calls
  // TikTok makes at the element level. The capture phase at window is
  // the earliest point in event dispatch: anything TikTok registers
  // runs alongside this at the same phase, and by stopping propagation
  // ourselves here we prevent their subsequent handlers from seeing
  // the pointer event at all.
  let delegatorInstalled = false;
  function installGlobalClickDelegator() {
    if (delegatorInstalled) return;
    delegatorInstalled = true;
    const handler = (ev) => {
      const target = ev.target;
      if (!target || !(target instanceof Element)) return;
      const btn = target.closest(".ytdlp-tt-grab");
      if (!btn) return;
      // Don't double-fire: if the button's own handler (onclick) would
      // also run, we still prefer to trigger here because element-
      // level clicks may never arrive. The inFlight dataset guards
      // against duplicate sends.
      try {
        ev.preventDefault();
      } catch {}
      try {
        ev.stopImmediatePropagation();
      } catch {}
      try {
        ev.stopPropagation();
      } catch {}
      const fn = /** @type {any} */ (btn).__ytdlpTtOnAct;
      if (typeof fn === "function") fn(ev);
    };
    window.addEventListener("pointerdown", handler, true);
    window.addEventListener("click", handler, true);
    LOG("global click delegator installed");
  }

  // ---------------------------------------------------------------------------
  // Detail-page injection
  // ---------------------------------------------------------------------------

  // findNavArrow returns one of TikTok's post-navigation arrow buttons
  // (up = previous post, down = next post). Used as an anchor for the
  // Fetch button so it lands in the same vertical column the user is
  // already scanning for those controls.
  function findNavArrow() {
    const candidates = [
      '[data-e2e="arrow-up"]',
      '[data-e2e="arrow-down"]',
      '[data-e2e="up-arrow"]',
      '[data-e2e="down-arrow"]',
      '[data-e2e="prev-video"]',
      '[data-e2e="next-video"]',
      '[data-e2e="browse-arrow-up"]',
      '[data-e2e="browse-arrow-down"]',
      '[data-e2e="browse-arrow"]',
      '[data-e2e="navigation-up"]',
      '[data-e2e="navigation-down"]',
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    // Heuristic: a fixed-position button whose aria-label / title
    // mentions "next" / "previous" / "up" / "down" combined with
    // "post" / "video".
    for (const b of document.querySelectorAll('button, [role="button"]')) {
      const lbl = (b.getAttribute("aria-label") || b.getAttribute("title") || "").toLowerCase();
      if (!lbl) continue;
      if (/(next|previous|prev|up|down)\b/.test(lbl) && /(post|video|item)\b/.test(lbl)) {
        return b;
      }
    }
    return null;
  }

  function injectDetailVariantFloating() {
    if (document.querySelector(".ytdlp-tt-grab-detail-fallback, .ytdlp-tt-grab-nav-anchor"))
      return "already";
    const postRoot =
      document.querySelector('[data-e2e="browse-video"]') ||
      document.querySelector('[data-e2e="video-detail"]') ||
      document.querySelector("main") ||
      document.body;
    const btn = makeButton(postRoot, "detail");
    const arrow = findNavArrow();
    if (arrow && arrow.parentElement) {
      // Insert as a sibling of the nav arrow so the button inherits
      // whatever fixed/absolute layout TikTok applies to that
      // column. Far more reliable than guessing CSS coordinates.
      btn.classList.add("ytdlp-tt-grab-nav-anchor");
      arrow.parentElement.insertBefore(btn, arrow);
      LOG("detail variant injected as sibling of nav arrow");
    } else {
      // No nav arrow found — fall back to fixed position. CSS
      // .ytdlp-tt-grab-detail-fallback parks the button at bottom-
      // left, clear of the right-side comments column the user
      // reported the previous middle-right placement landed in.
      btn.classList.add("ytdlp-tt-grab-detail-fallback");
      document.body.appendChild(btn);
      LOG("detail variant injected as floating fallback (no nav arrow)");
    }
    return "floating";
  }

  // ---------------------------------------------------------------------------
  // Photo-post injection
  // ---------------------------------------------------------------------------
  //
  // /@user/photo/<id> URLs render TikTok's slideshow viewer. yt-dlp's
  // capture flow used by the video button doesn't apply (the popup
  // scrapes slideshow images out of the DOM via getTikTokPhotoInfo);
  // the on-page button just opens the popup with the auto-fetch flag
  // so the popup runs that scrape and renders a clean gallery picker.

  const PHOTO_PATH_RE = /^\/@[^/]+\/photo\/\d+/i;

  function isPhotoLocation() {
    try {
      return PHOTO_PATH_RE.test(location.pathname);
    } catch {
      return false;
    }
  }

  // findPostModal: detects an OPEN MODAL viewer (a [role="dialog"]
  // containing TikTok media). Distinct from a direct /video/ /photo/
  // page where the post viewer is the page itself, not a modal.
  // Used to decide whether to suppress feed-card injection (modal
  // mode) vs run it (direct mode).
  function findPostModal() {
    for (const dialog of document.querySelectorAll('[role="dialog"]')) {
      if (dialog.querySelector('video, img[src*="tiktokcdn"], img[src*="tiktok"]')) {
        return dialog;
      }
    }
    return null;
  }

  // isPhotoModal: heuristic for whether the open modal is a photo
  // (slideshow) post vs a video. TikTok photo modals contain
  // multiple <img>s and no <video>; video modals contain a <video>.
  function isPhotoModal(root) {
    if (!root) return false;
    if (root.querySelector("video")) return false;
    return !!root.querySelector('img[src*="tiktokcdn"], img[src*="tiktok"]');
  }

  // makePhotoButton mirrors makeButton's shape (.ytdlp-tt-grab class so
  // CSS styling and the global click delegator still apply) but its
  // click handler triggers the popup's auto-fetch flow rather than the
  // SW capture path. Photos route through the popup because the
  // image-set lives in the page DOM and is read via executeScript.
  function makePhotoButton(variant) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className =
      "ytdlp-tt-grab ytdlp-tt-grab-photo" + (variant ? " ytdlp-tt-grab-" + variant : "");
    btn.innerHTML = FETCH_ICON_SVG;
    btn.title = "fetch photos";
    btn.setAttribute("aria-label", "fetch photos");
    btn.dataset.ytdlpVariant = variant || "";

    const onAct = async (ev) => {
      if (ev) {
        try {
          ev.preventDefault();
        } catch {}
        try {
          ev.stopImmediatePropagation();
        } catch {}
        try {
          ev.stopPropagation();
        } catch {}
      }
      if (btn.dataset.inFlight === "1") return;
      btn.dataset.inFlight = "1";
      btn.classList.add("is-pressing");
      setTimeout(() => btn.classList.remove("is-pressing"), PRESSING_FLASH_MS);
      LOG("photo click", variant, location.href.slice(0, URL_LOG_LEN));
      try {
        const resp = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({ type: "yt:trigger-fetch", url: location.href }, (r) => {
            if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
            else resolve(r);
          });
        });
        if (resp?.ok) {
          btn.classList.add("is-captured");
          btn.title = "Opening popup…";
          setTimeout(() => {
            btn.classList.remove("is-captured");
            btn.title = "fetch photos";
          }, CAPTURED_FLASH_MS);
        } else {
          WARN("photo trigger refused", resp);
          btn.classList.add("is-error");
          setTimeout(() => btn.classList.remove("is-error"), ERROR_FLASH_MS);
        }
      } catch (err) {
        WARN("photo trigger sendMessage err", err?.message || err);
        btn.classList.add("is-error");
        setTimeout(() => btn.classList.remove("is-error"), ERROR_FLASH_MS);
      } finally {
        btn.dataset.inFlight = "0";
      }
    };

    btn.onclick = onAct;
    /** @type {any} */ (btn).__ytdlpTtOnAct = onAct;
    return btn;
  }

  function injectPhotoVariantFloating() {
    if (
      document.querySelector(
        ".ytdlp-tt-grab-photo.ytdlp-tt-grab-detail-fallback, .ytdlp-tt-grab-photo.ytdlp-tt-grab-nav-anchor",
      )
    )
      return "already";
    const btn = makePhotoButton("detail");
    const arrow = findNavArrow();
    if (arrow && arrow.parentElement) {
      btn.classList.add("ytdlp-tt-grab-nav-anchor");
      arrow.parentElement.insertBefore(btn, arrow);
      LOG("photo variant injected as sibling of nav arrow");
    } else {
      btn.classList.add("ytdlp-tt-grab-detail-fallback");
      document.body.appendChild(btn);
      LOG("photo variant injected as floating fallback (no nav arrow)");
    }
    return "floating";
  }

  // ---------------------------------------------------------------------------
  // Feed-card injection
  // ---------------------------------------------------------------------------

  function findFeedPosts() {
    const out = new Set();
    for (const sel of [
      '[data-e2e="recommend-list-item-container"]',
      '[data-e2e="user-post-item"]',
      '[data-e2e="feed-video"]',
      '[data-e2e="feed-item-video"]',
      '[data-e2e="video-card"]',
    ]) {
      for (const el of document.querySelectorAll(sel)) out.add(el);
    }
    return out;
  }

  function findFeedAvatar(postEl) {
    return (
      postEl.querySelector('[data-e2e="video-author-avatar"]') ||
      postEl.querySelector('[data-e2e="feed-video-avatar"]') ||
      postEl.querySelector('[data-e2e="avatar"]') ||
      null
    );
  }

  // Returns true if a feed-variant button ended up in the DOM for
  // this post (either freshly injected now or from a previous scan).
  // btnFactory is a function (postEl, variant) → HTMLButtonElement;
  // either makeButton (capture flow, for video) or makePhotoButton
  // (popup-trigger flow, for photo direct pages).
  function injectFeedVariant(postEl, btnFactory) {
    if (postEl.querySelector(":scope .ytdlp-tt-grab-feed")) return true;
    const avatar = findFeedAvatar(postEl);
    if (!avatar) return false;
    const actionBar =
      avatar.closest(
        '[class*="DivActionBar"], [class*="action-bar"], [class*="ActionBar"], [class*="actionBar"]',
      ) ||
      avatar.parentElement?.parentElement ||
      avatar.parentElement;
    if (!actionBar) return false;
    let slot = avatar;
    while (slot && slot.parentElement && slot.parentElement !== actionBar) {
      slot = slot.parentElement;
    }
    const btn = btnFactory(postEl, "feed");
    if (slot && slot.parentElement === actionBar) {
      actionBar.insertBefore(btn, slot);
      LOG("feed variant injected above avatar slot");
    } else {
      actionBar.insertBefore(btn, actionBar.firstChild);
      LOG("feed variant injected at action-bar head (avatar slot not resolved)");
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Scan loop
  // ---------------------------------------------------------------------------

  let scanScheduled = false;
  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    requestAnimationFrame(() => {
      scanScheduled = false;
      try {
        installGlobalClickDelegator();

        // Two distinct single-post layouts on TikTok:
        //   a) Direct page — URL is /@user/video|photo/<id>, no
        //      modal overlay. The active post is rendered directly
        //      in the page and matches the same feed-card selectors
        //      used on /foryou and the profile grid. Feed-card
        //      injection adds a button above the post's profile
        //      avatar, which is the placement the user wants.
        //   b) Modal viewer — a [role="dialog"] with TikTok media
        //      sits on top of an underlying page (typically a
        //      profile grid). The modal's DOM doesn't expose a
        //      feed-card-shaped action column we can anchor to, so
        //      we inject a single floating button instead and
        //      suppress the feed-card pass to avoid double-buttons
        //      on the underlying grid.
        const onPostUrl = ABS_VIDEO_URL_RE.test(location.href);
        const postModal = findPostModal();
        const isPhotoUrl = isPhotoLocation();

        if (!postModal) {
          // Direct page or feed/profile: run feed-card injection.
          // For photo direct pages, swap the click-handler factory
          // so the popup gets the auto-fetch trigger (gallery
          // picker) instead of the capture flow (which doesn't
          // render slideshow images well).
          const useTriggerFactory = onPostUrl && isPhotoUrl;
          const factory = useTriggerFactory
            ? () => makePhotoButton("feed")
            : (post) => makeButton(post, "feed");
          for (const post of findFeedPosts()) {
            injectFeedVariant(post, factory);
          }
        } else {
          // Modal mode: clean up any feed-card buttons that may
          // have been injected on the grid behind the modal.
          for (const stray of document.querySelectorAll(".ytdlp-tt-grab-feed")) {
            stray.remove();
          }
        }

        if (postModal) {
          // Floating button on top of the modal viewer.
          const photo = isPhotoUrl || isPhotoModal(postModal);
          const wrongAnchorSel = photo
            ? ".ytdlp-tt-grab-nav-anchor:not(.ytdlp-tt-grab-photo), .ytdlp-tt-grab-detail-fallback:not(.ytdlp-tt-grab-photo)"
            : ".ytdlp-tt-grab-nav-anchor.ytdlp-tt-grab-photo, .ytdlp-tt-grab-detail-fallback.ytdlp-tt-grab-photo";
          for (const stray of document.querySelectorAll(wrongAnchorSel)) stray.remove();
          for (const stray of document.querySelectorAll(
            ".ytdlp-tt-grab-detail:not(.ytdlp-tt-grab-detail-fallback):not(.ytdlp-tt-grab-nav-anchor)",
          )) {
            stray.remove();
          }
          if (photo) {
            injectPhotoVariantFloating();
          } else {
            injectDetailVariantFloating();
          }
        } else {
          // No modal — clean up any floating / nav-anchored buttons
          // left over from a previous modal-open state.
          for (const stray of document.querySelectorAll(
            ".ytdlp-tt-grab-detail-fallback, .ytdlp-tt-grab-nav-anchor",
          )) {
            stray.remove();
          }
        }
      } catch (err) {
        WARN("scan error", err?.message || err);
      }
    });
  }

  scheduleScan();
  const mo = new MutationObserver(scheduleScan);
  mo.observe(document.body, { childList: true, subtree: true });
  window.addEventListener("scroll", scheduleScan, { passive: true });
  window.addEventListener("popstate", scheduleScan);
  const origPushState = history.pushState;
  history.pushState = function () {
    const ret = origPushState.apply(this, arguments);
    scheduleScan();
    return ret;
  };
})();
