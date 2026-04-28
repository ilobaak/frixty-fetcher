// Runs in the page's JS world at document_start on TikTok. TikTok's
// logged-out feed pages don't embed any canonical /@user/video/<id>
// reference in the DOM — all video metadata arrives over fetch/XHR
// calls to TikTok's private APIs as the user scrolls. We patch both
// transports to snapshot any response that names videos, then forward
// the summaries to the isolated-world content script via postMessage.
// The isolated world uses that cache to identify the canonical URL
// for the visible / playing video when DOM-based extraction fails.
//
// Must run in MAIN world at document_start so the patches land before
// TikTok's JS bundles capture references to fetch / XMLHttpRequest.
(function () {
  if (window.__ytdlpTt && window.__ytdlpTt.loaded) return;
  // Single namespace object: .loaded/.version track install state;
  // .cache mirrors the isolated-world Map for MAIN-world readers
  // (popup's dumpInterceptCache via executeScript); .hits/.misses
  // are diagnostic counters.
  window.__ytdlpTt = {
    loaded: true,
    version: 3,
    cache: [],
    hits: 0,
    misses: 0,
  };
  const STATE = window.__ytdlpTt;
  console.log("[frixty/tt-interceptor] installed v3 at", location.href);

  // Pure helpers from tiktok-shared.js, loaded in the same MAIN-world
  // content-scripts entry just before this file.
  const {
    CACHE_MAX,
    BATCH_MAX,
    MIN_SCRIPT_LEN,
    isTargetUrl,
    toSummary,
    extractItems,
    collectSeedItems,
  } = window.__ytdlpTtShared;

  // Log-only constants that stay local — not relevant to shared-file
  // consumers (the isolated-world content script has its own).
  const URL_LOG_LEN = 120;
  const UNTARGETED_LOG_LEN = 200;

  function parseJson(text) {
    if (typeof text !== "string" || !text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  function publish(items, source) {
    if (!items || items.length === 0) return;
    try {
      // Also stash in page-world globals for debugging: the popup can
      // read these via executeScript({world:"MAIN"}) even when the
      // isolated-world message bridge goes quiet.
      const batch = items.slice(0, BATCH_MAX);
      STATE.hits += batch.length;
      STATE.cache.push(...batch);
      if (STATE.cache.length > CACHE_MAX) {
        STATE.cache.splice(0, STATE.cache.length - CACHE_MAX);
      }
      console.log("[frixty/tt-interceptor] captured", {
        source,
        batch: batch.length,
        total: STATE.hits,
      });
      window.postMessage(
        {
          __ytdlpTtInterceptor: true,
          source,
          items: batch,
        },
        "*",
      );
    } catch (err) {
      console.warn("[frixty/tt-interceptor] publish failed", err?.message || err);
    }
  }

  // Log every outbound fetch to tiktok.com APIs (not just the ones we
  // already target) so we can discover additional data endpoints.
  // Noisy but invaluable for diagnosing wrong-video bugs.
  function maybeLogUntargeted(url) {
    if (!url) return;
    if (!/tiktok\.com\/api\//i.test(url)) return;
    if (isTargetUrl(url)) return; // already logged elsewhere
    console.log("[frixty/tt-interceptor] untargeted api call", url.slice(0, UNTARGETED_LOG_LEN));
  }

  // ---- fetch() hook ----
  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (...args) {
      const promise = origFetch.apply(this, args);
      try {
        let rawUrl = "";
        const first = args[0];
        if (typeof first === "string") rawUrl = first;
        else if (first && typeof first === "object" && typeof first.url === "string")
          rawUrl = first.url;
        maybeLogUntargeted(rawUrl);
        if (isTargetUrl(rawUrl)) {
          const shortUrl = rawUrl.slice(0, URL_LOG_LEN);
          console.log("[frixty/tt-interceptor] target fetch", shortUrl);
          promise
            .then((resp) => {
              if (!resp || !resp.ok) {
                console.log("[frixty/tt-interceptor] fetch resp not ok", {
                  url: shortUrl,
                  status: resp?.status,
                });
                return;
              }
              try {
                const clone = resp.clone();
                clone
                  .text()
                  .then((text) => {
                    const items = extractItems(parseJson(text));
                    if (items.length) {
                      publish(items, "fetch");
                    } else {
                      STATE.misses++;
                      console.log("[frixty/tt-interceptor] fetch parsed, 0 items", {
                        url: shortUrl,
                        bodyLen: text?.length || 0,
                      });
                    }
                  })
                  .catch((e) =>
                    console.warn("[frixty/tt-interceptor] fetch text err", e?.message || e),
                  );
              } catch (err) {
                console.warn("[frixty/tt-interceptor] fetch clone err", err?.message || err);
              }
            })
            .catch(() => {});
        }
      } catch (err) {
        console.warn("[frixty/tt-interceptor] fetch hook err", err?.message || err);
      }
      return promise;
    };
  }

  // ---- Universal-data SSR seed ----
  //
  // TikTok server-renders the initial feed into a <script> tag
  // (historically __UNIVERSAL_DATA_FOR_REHYDRATION__, SIGI_STATE,
  // __NEXT_DATA__ — name drifts across releases). Those items are
  // visible on first paint but NOT in any fetch/XHR we can hook,
  // so we scan every inline application/json script and run
  // collectSeedItems (shared) on each.
  let seeded = false;
  let seededItemsCount = 0;
  function attemptSeed() {
    if (seeded) return;
    const scripts = document.querySelectorAll('script[type="application/json"]');
    if (scripts.length === 0) return;
    seeded = true;
    let totalItems = 0;
    const summaries = [];
    for (const el of scripts) {
      const text = el.textContent || "";
      if (!text || text.length < MIN_SCRIPT_LEN) continue;
      try {
        const blob = parseJson(text);
        if (!blob || typeof blob !== "object") continue;
        const items = collectSeedItems(blob);
        summaries.push({
          id: el.id || "(no-id)",
          bodyLen: text.length,
          topKeys: Object.keys(blob).slice(0, 6),
          items: items.length,
        });
        if (items.length) {
          publish(items, "ssr:" + (el.id || "anon"));
          totalItems += items.length;
        }
      } catch {}
    }
    seededItemsCount = totalItems;
    console.log("[frixty/tt-interceptor] SSR scan", {
      scriptsScanned: scripts.length,
      totalItems,
      summaries,
    });
  }
  // Re-scan inline JSON scripts on DOMContentLoaded and load. The
  // first pass (before any scripts mounted) will find nothing; the
  // later passes pick up SSR blobs that the page writes during
  // parsing. We don't worry about duplicate seeding — publish() adds
  // to the cache with dedup by id.
  function retrySeed() {
    seeded = false;
    attemptSeed();
  }
  if (document.readyState !== "loading") {
    attemptSeed();
  } else {
    const mo = new MutationObserver(() => {
      attemptSeed();
      // Keep watching until either ≥1 item seeded OR DOMContentLoaded.
      if (seededItemsCount > 0) mo.disconnect();
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener(
      "DOMContentLoaded",
      () => {
        retrySeed();
        mo.disconnect();
      },
      { once: true },
    );
    window.addEventListener("load", retrySeed, { once: true });
  }

  // ---- React-fiber fallback --------------------------------------
  //
  // SSR seeds and API intercepts both miss TikTok's "first feed card"
  // scenario: the logged-out For You page lands on a pre-rendered
  // video whose data arrives neither through the inline JSON blobs
  // collectSeedItems scans nor through any fetch/XHR we hook before
  // click time. But the article's React props carry the full item
  // object (id, author, video URLs, cover). Only reachable from MAIN
  // world — isolated-world content scripts can't read the
  // __reactProps$/__reactFiber$ expandos.
  //
  // Walk every on-screen feed article periodically and publish any
  // found items to the same cache the fetch/XHR hooks fill. Cheap:
  // a single loop over ~5-10 articles on each scan, de-duped by id.
  const FEED_ARTICLE_SEL =
    'article[id^="one-column-item-"], article[id^="feed-item-"], article[id^="video-item-"]';
  function readReactProps(el) {
    if (!el) return null;
    for (const k of Object.keys(el)) {
      if (k.startsWith("__reactProps$")) {
        try {
          return el[k];
        } catch {
          return null;
        }
      }
    }
    return null;
  }
  function readReactFiber(el) {
    if (!el) return null;
    for (const k of Object.keys(el)) {
      if (k.startsWith("__reactFiber$")) {
        try {
          return el[k];
        } catch {
          return null;
        }
      }
    }
    return null;
  }
  // Walk up the React fiber tree looking for a memoizedProps.item (or
  // similar) that holds the feed-card data. TikTok's fiber wraps each
  // card in an ArticleItemContainer whose parent List passes item as
  // a prop; the exact depth drifts so walk up to 12 levels.
  function findItemOnFiber(fiber) {
    let n = fiber;
    let depth = 0;
    while (n && depth < 12) {
      const p = n.memoizedProps;
      if (p && typeof p === "object") {
        if (p.item && typeof p.item === "object") return p.item;
        if (p.itemInfo && typeof p.itemInfo === "object" && p.itemInfo.itemStruct) {
          return p.itemInfo.itemStruct;
        }
      }
      n = n.return;
      depth++;
    }
    return null;
  }
  function scanArticleFibers() {
    const articles = document.querySelectorAll(FEED_ARTICLE_SEL);
    if (articles.length === 0) return;
    const items = [];
    for (const art of articles) {
      let item = null;
      const props = readReactProps(art);
      if (props && typeof props === "object" && props.item && typeof props.item === "object") {
        item = props.item;
      }
      if (!item) {
        const fiber = readReactFiber(art);
        if (fiber) item = findItemOnFiber(fiber);
      }
      const s = item ? toSummary(item) : null;
      if (s) items.push(s);
    }
    if (items.length > 0) {
      // dedup against what's already in the cache (same id) before
      // publishing; publish() doesn't dedup by id on its own.
      const known = new Set(STATE.cache.map((it) => it.id));
      const fresh = items.filter((it) => !known.has(it.id));
      if (fresh.length > 0) {
        console.log("[frixty/tt-interceptor] react-fiber scan", {
          articles: articles.length,
          fresh: fresh.length,
          ids: fresh.map((it) => it.id + "/@" + (it.authorId || "?")),
        });
        publish(fresh, "react-fiber");
      }
    }
  }
  // Run the scan periodically — a MutationObserver here would fire on
  // every React re-render (too noisy). A 2s interval catches scroll-
  // advances within one visible frame of the user seeing the new card,
  // which is fast enough for click-time accuracy.
  setInterval(() => {
    try {
      scanArticleFibers();
    } catch (err) {
      console.warn("[frixty/tt-interceptor] fiber scan err", err?.message || err);
    }
  }, 2000);
  // Also run once DOM is ready so the first card is captured before
  // the user has a chance to click.
  if (document.readyState !== "loading") {
    setTimeout(scanArticleFibers, 300);
  } else {
    window.addEventListener(
      "DOMContentLoaded",
      () => {
        setTimeout(scanArticleFibers, 300);
      },
      { once: true },
    );
  }

  // ---- XMLHttpRequest hook ----
  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;
    XHR.prototype.open = function (method, url, ...rest) {
      try {
        this.__ytdlpTtUrl =
          typeof url === "string" ? url : url && url.toString ? url.toString() : "";
      } catch {}
      return origOpen.call(this, method, url, ...rest);
    };
    XHR.prototype.send = function (body) {
      try {
        const u = this.__ytdlpTtUrl || "";
        maybeLogUntargeted(u);
        if (u && isTargetUrl(u)) {
          const shortUrl = u.slice(0, URL_LOG_LEN);
          console.log("[frixty/tt-interceptor] target xhr", shortUrl);
          this.addEventListener("load", function () {
            try {
              if (this.status < 200 || this.status >= 300) {
                console.log("[frixty/tt-interceptor] xhr resp not ok", {
                  url: shortUrl,
                  status: this.status,
                });
                return;
              }
              const items = extractItems(parseJson(this.responseText));
              if (items.length) {
                publish(items, "xhr");
              } else {
                STATE.misses++;
                console.log("[frixty/tt-interceptor] xhr parsed, 0 items", {
                  url: shortUrl,
                  bodyLen: this.responseText?.length || 0,
                });
              }
            } catch (err) {
              console.warn("[frixty/tt-interceptor] xhr load err", err?.message || err);
            }
          });
        }
      } catch (err) {
        console.warn("[frixty/tt-interceptor] xhr hook err", err?.message || err);
      }
      return origSend.call(this, body);
    };
  }
})();
