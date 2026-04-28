// Per-post "grab" button. A single floating button attached to
// document.body is shown on hover of any known post / reel / story /
// marketplace-item container. No DOM mutation of Facebook's own
// elements (previously overriding container.style.overflow and
// position broke the Reels viewer entirely and the CometFeedStory
// layout on some posts). Uses fixed positioning so transformed /
// overflow-hidden / otherwise finicky ancestors can't clip it.
//
// Detection runs in two passes each scan:
//   Pass 1: anchors matching post permalink shapes
//   Pass 2: content-size <video> / <img> whose wrapper didn't get
//           picked up by pass 1 (reels, sponsored posts, marketplace
//           grid cards, stories viewer, /watch pages)
//
// Registered containers go into a WeakMap (container → permalink).
// A document-level mouseover delegate walks up from the hovered
// element to find a registered container and shows the button for
// it. Scroll/reflow re-positions the visible button.
(function () {
  if (window.__ytdlpFbGrabLoaded) return;
  window.__ytdlpFbGrabLoaded = true;
  console.log("[frixty/post-grab] installed at", location.href);

  // ---- Post metadata cache (fed by facebook-interceptor.js) -----
  //
  // facebook-interceptor.js runs in MAIN world at document_start,
  // parses every /api/graphql/ response for post-shaped objects,
  // and postMessages each one here. We index them two ways so the
  // grab button can look up by whichever identifier it has from
  // the clicked permalink:
  //   postsById   — postId (story id) → metadata record
  //   postsByMedia — mediaId (photo fbid, video id) → metadata record
  // A capture URL like /photo/?fbid=<id> or /reel/<id>/ resolves via
  // postsByMedia; a /posts/<id> permalink via postsById.
  const postsById = new Map();
  const postsByMedia = new Map();
  const POST_CACHE_MAX = 600;

  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || typeof d !== "object" || !d.__ytdlpFbPost) return;
    const record = {
      postId: d.postId || "",
      creationTime: typeof d.creationTime === "number" ? d.creationTime : 0,
      author: typeof d.author === "string" ? d.author : "",
      authorProfile: typeof d.authorProfile === "string" ? d.authorProfile : "",
      message: typeof d.message === "string" ? d.message : "",
      permalinkUrl: typeof d.permalinkUrl === "string" ? d.permalinkUrl : "",
    };
    if (record.postId) {
      const existing = postsById.get(record.postId);
      if (!existing || mergeScore(record) > mergeScore(existing)) {
        postsById.set(record.postId, record);
      }
    }
    if (Array.isArray(d.mediaIds)) {
      for (const mid of d.mediaIds) {
        if (typeof mid !== "string" || !mid) continue;
        const existing = postsByMedia.get(mid);
        if (!existing || mergeScore(record) > mergeScore(existing)) {
          postsByMedia.set(mid, record);
        }
      }
    }
    // Bound both maps.
    while (postsById.size > POST_CACHE_MAX) {
      postsById.delete(postsById.keys().next().value);
    }
    while (postsByMedia.size > POST_CACHE_MAX) {
      postsByMedia.delete(postsByMedia.keys().next().value);
    }
  });

  // mergeScore ranks two records for the same id by completeness —
  // later captures with MORE data (e.g. a feed graphql that filled
  // in the author the first capture was missing) should win.
  function mergeScore(r) {
    return (r.author ? 2 : 0) + (r.message ? 1 : 0) + (r.creationTime ? 1 : 0);
  }

  // Extract ALL numeric identifiers from a Facebook permalink. A
  // single URL may carry three or four different post-related ids:
  //   /photo/?fbid=<photo_id>&set=pcb.<parent_post_id>  → photo + parent post
  //   /photo/?fbid=<photo_id>&set=a.<album_id>          → photo + album
  //   /permalink.php?story_fbid=<story>&id=<user>       → story + user
  //   /<user>/posts/<post_id>                            → post
  //   /groups/<gid>/posts/<post_id>                     → post
  //   /reel/<id>/  /reels/<id>                           → reel
  //   /<user>/videos/<id>                                → video
  //
  // Any one of these ids might be the key under which the post's
  // metadata was indexed — try them all in priority order.
  function idsFromPermalink(url) {
    const out = { mediaId: "", storyId: "", all: [] };
    if (!url) return out;
    let u;
    try { u = new URL(url, location.href); } catch { return out; }
    const path = u.pathname;
    const search = u.searchParams;
    const push = (v) => { if (v && /^\d+$/.test(v) && !out.all.includes(v)) out.all.push(v); };

    const fbid = search.get("fbid");
    if (fbid) { push(fbid); if (!out.mediaId) out.mediaId = fbid; }
    const set = search.get("set") || "";
    const setMatch = set.match(/(?:pcb|a|t|album)\.(\d+)/);
    if (setMatch) push(setMatch[1]);
    const storyFbid = search.get("story_fbid");
    if (storyFbid) { push(storyFbid); if (!out.storyId) out.storyId = storyFbid; }
    const ownerId = search.get("id");
    if (ownerId) push(ownerId);
    const v = search.get("v");
    if (v) { push(v); if (!out.mediaId) out.mediaId = v; }

    let m = path.match(/^\/reels?\/(\d+)/);
    if (m) { push(m[1]); if (!out.mediaId) out.mediaId = m[1]; }
    m = path.match(/^\/[^/]+\/videos\/(\d+)/);
    if (m) { push(m[1]); if (!out.mediaId) out.mediaId = m[1]; }
    m = path.match(/^\/[^/]+\/posts\/(\d+)/) || path.match(/^\/groups\/[^/]+\/(?:posts|permalink)\/(\d+)/);
    if (m) { push(m[1]); if (!out.storyId) out.storyId = m[1]; }
    m = path.match(/^\/[^/]+\/photos\/[^/]+\/(\d+)/);
    if (m) { push(m[1]); if (!out.mediaId) out.mediaId = m[1]; }
    return out;
  }

  // lookupPostMetadata tries EVERY id extracted from the permalink
  // against both cache maps. Returns the first record with the most
  // useful data (by mergeScore) so a partial hit on one id doesn't
  // shadow a fuller hit on another.
  function lookupPostMetadata(permalink) {
    const ids = idsFromPermalink(permalink);
    let best = null;
    for (const id of ids.all) {
      const fromMedia = postsByMedia.get(id);
      const fromStory = postsById.get(id);
      for (const rec of [fromMedia, fromStory]) {
        if (!rec) continue;
        if (!best || mergeScore(rec) > mergeScore(best)) best = rec;
      }
    }
    return best;
  }

  const PERMALINK_PATTERNS = [
    /^\/[^/?#]+\/posts\/[A-Za-z0-9_\-:.]+/,
    /^\/[^/?#]+\/videos\/[A-Za-z0-9_\-:.]+/,
    /^\/[^/?#]+\/photos\/[A-Za-z0-9_\-:.\/]+/,
    /^\/[^/?#]+\/reels\/[A-Za-z0-9_\-:.]+/,
    /^\/reel\/[A-Za-z0-9_\-:.]+/,
    /^\/reels\/[A-Za-z0-9_\-:.]+/,
    /^\/watch\/?\?v=[A-Za-z0-9_\-:.]+/,
    /^\/story\.php\?/,
    /^\/permalink\.php\?/,
    /^\/photo\/\?fbid=\d+/,
    /^\/photo\.php\?fbid=\d+/,
    /^\/groups\/[^/?#]+\/posts\/\d+/,
    /^\/groups\/[^/?#]+\/permalink\/\d+/,
    /^\/marketplace\/item\/\d+/,
    /^\/stories\/\d+\/[^/?#]+/,
    /^\/share\/[vpr]\/[A-Za-z0-9_\-:.]+/,
  ];
  const matchesPermalink = (href) => {
    if (!href) return null;
    let path;
    if (href[0] === "/") path = href.split("#")[0];
    else {
      try {
        const u = new URL(href, location.origin);
        if (!/(^|\.)facebook\.com$/i.test(u.hostname)) return null;
        path = u.pathname + u.search;
      } catch { return null; }
    }
    for (const re of PERMALINK_PATTERNS) {
      if (re.test(path)) return path;
    }
    return null;
  };
  function pageIsSingleItem() {
    const p = location.pathname + location.search;
    for (const re of PERMALINK_PATTERNS) {
      if (re.test(p)) return true;
    }
    return false;
  }

  const RESERVED = new Set([
    "watch", "reel", "reels", "stories", "photo", "photo.php", "video.php",
    "groups", "events", "pages", "profile.php", "sharer", "login",
    "home.php", "messages", "settings", "help", "privacy", "policies",
    "marketplace", "gaming", "dating", "fundraisers", "jobs", "weather",
    "notes", "live", "search", "friends", "bookmarks",
  ]);
  function firstSegment(href) {
    if (!href) return "";
    let pathname = "";
    if (href[0] === "/" && href[1] !== "/") pathname = href.split(/[?#]/)[0];
    else {
      try {
        const u = new URL(href, location.origin);
        if (!/(^|\.)facebook\.com$/i.test(u.hostname)) return "";
        pathname = u.pathname;
      } catch { return ""; }
    }
    const segs = pathname.split("/").filter(Boolean);
    return segs[0] || "";
  }
  function scoreName(text) {
    if (!text) return -1;
    const len = text.length;
    if (len < 2 || len > 80) return -1;
    if (/\b(like|comment|share|follow|more|see|edit|reply|save|report|hide|show|menu|options)\b/i.test(text)) return -1;
    const words = text.split(/\s+/).filter(Boolean);
    const titleCased = words.filter((w) => /^[\p{Lu}\p{Lt}]/u.test(w)).length;
    return titleCased + (words.length > 1 ? 1 : 0);
  }
  function authorFrom(container) {
    for (const sel of ["h2 a[href]", "h3 a[href]", "strong a[href]", "h4 a[href]"]) {
      for (const a of container.querySelectorAll(sel)) {
        const seg = firstSegment(a.getAttribute("href") || "");
        if (!seg || RESERVED.has(seg)) continue;
        const text = (a.textContent || "").trim().replace(/\s+/g, " ");
        if (text && text.length >= 2 && text.length <= 80) return text;
      }
    }
    const containerRect = container.getBoundingClientRect();
    const headerCut = containerRect.top + containerRect.height * 0.3;
    let best = { score: 0, name: "" };
    for (const a of container.querySelectorAll("a[href]")) {
      const ar = a.getBoundingClientRect();
      if (ar.top > headerCut) continue;
      const seg = firstSegment(a.getAttribute("href") || "");
      if (!seg || RESERVED.has(seg)) continue;
      const text = (a.textContent || "").trim().replace(/\s+/g, " ");
      const s = scoreName(text);
      if (s >= 1 && s > best.score) best = { score: s, name: text };
    }
    if (best.name) return best.name;
    // Fallback: pull the author from accessible-name labels in the
    // surrounding post / photo-viewer scope. FB uses several label
    // shapes depending on layout:
    //   "Red Hot ChiliPeppers, view story"  — feed photo
    //   "Hide post by Red Hot ChiliPeppers" — feed overflow menu
    //   "Latavia Fuller"                     — photo viewer avatar SVG
    //   "Life, Mood and Aesthetics 💎"       — group link in header
    //
    // Search outward from container: first the enclosing
    // [role="article"] (feed), otherwise walk up 6 ancestor levels
    // (photo-viewer / marketplace / group layouts).
    const article = container.closest?.('[role="article"]');
    const scopes = [];
    if (article) scopes.push(article);
    let node = container.parentElement;
    for (let i = 0; i < 6 && node; i++, node = node.parentElement) {
      scopes.push(node);
      if (node.getAttribute?.("role") === "article") break;
    }
    // Labels to reject as "not a person/page name". Three groups:
    //   1. Action buttons & reactions (Like, React, Comment, etc.).
    //   2. Image accessibility text Facebook generates for alt-less
    //      photos ("No photo description available.", "May be an
    //      image of …", "Photo of …"). These aren't authors.
    //   3. Metric/count labels ("17 people", "2 comments").
    const SKIP_LABELS = /^(like|love|care|haha|wow|sad|angry|react|leave a comment|send this|share|save|hide|report|see who|remove|see more|more options|menu|actions for this post|shared with|follow|edit|delete|block|no photo description|may be an? (image|photo)|photo of|image of|view story|view post|verified|suggested for you|private photos|profile picture)/i;
    for (const scope of scopes) {
      for (const el of scope.querySelectorAll("[aria-label]")) {
        const lbl = (el.getAttribute("aria-label") || "").trim();
        if (!lbl) continue;
        // Strong patterns first — most reliable.
        let m = lbl.match(/^Hide post by (.+)$/i);
        if (m && m[1]) return m[1].trim();
        m = lbl.match(/^(.+?),\s*view story$/i);
        if (m && m[1]) return m[1].trim();
        m = lbl.match(/^(.+?)\s+profile picture$/i);
        if (m && m[1]) return m[1].trim();
      }
    }
    // Weaker heuristic: accept any plausible-looking aria-label
    // that isn't an action button / reaction / group-visibility
    // marker. Prefer labels on <svg> (avatars) and <a> elements.
    for (const scope of scopes) {
      for (const el of scope.querySelectorAll("svg[aria-label], a[aria-label]")) {
        const lbl = (el.getAttribute("aria-label") || "").trim();
        if (!lbl || lbl.length < 2 || lbl.length > 80) continue;
        if (SKIP_LABELS.test(lbl)) continue;
        if (/\d/.test(lbl) && !/^[A-Z]/.test(lbl)) continue; // reject counts like "17 people"
        return lbl;
      }
    }
    return "";
  }

  function titleFor(container) {
    const candidates = container.querySelectorAll('div[dir="auto"]');
    for (const d of candidates) {
      if (d.closest("h2, h3, h4, strong")) continue;
      const text = (d.textContent || "").replace(/\s+/g, " ").trim();
      if (text.length >= 8 && text.length <= 240) return text;
      if (text.length > 240) return text.slice(0, 237) + "…";
    }
    return "";
  }

  // dateFor scans a Facebook post for its publish timestamp in unix
  // seconds. FB's visible timestamp is usually relative ("4h ago"),
  // but the absolute datetime is exposed via one of:
  //   1. <abbr data-utime="<unix_sec>">         — older markup
  //   2. <time datetime="<ISO>">                — newer markup
  //   3. Any element with aria-label or title   — accessible tooltip,
  //      text like "Tuesday, April 22, 2026 at 11:30 AM"
  // The accessible tooltip is the reliable modern source because FB
  // React sets aria-label on the link's invisible descendant span.
  //
  // We scan the post container first; if nothing matches, we walk up
  // three ancestor levels because the post header (with the
  // timestamp) can live a DOM level or two above the visual card.
  //
  // Returns 0 when nothing usable was found; callers fall back to
  // capturedAt (click time) and label it "Captured …" in the UI.
  function dateFor(container) {
    const hit = findDateInScope(container);
    if (hit) return hit;
    // Walk up to the nearest <div role="article"> (FB's canonical
    // post wrapper) and scan THAT entire subtree — the post header
    // with the timestamp anchor lives in the article but NOT inside
    // the photo <a> we captured. Fall back to crawling a generous
    // number of parent levels if no article is found.
    const article = container.closest?.('[role="article"]');
    if (article && article !== container) {
      const h = findDateInScope(article);
      if (h) return h;
    }
    let node = container.parentElement;
    for (let i = 0; i < 8 && node; i++) {
      const h = findDateInScope(node);
      if (h) return h;
      if (node.getAttribute?.("role") === "article") break; // already searched above
      node = node.parentElement;
    }
    return 0;
  }

  function findDateInScope(scope) {
    for (const el of scope.querySelectorAll("abbr[data-utime]")) {
      const n = parseInt(el.getAttribute("data-utime") || "", 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
    for (const el of scope.querySelectorAll("time[datetime]")) {
      const dt = el.getAttribute("datetime") || "";
      const ms = Date.parse(dt);
      if (Number.isFinite(ms) && ms > 0) return Math.floor(ms / 1000);
    }
    // aria-label OR title; unified scan. FB React mounts the
    // accessible name on the clickable descendant, not always on
    // the outer anchor, so we accept either attribute on any
    // element type.
    for (const el of scope.querySelectorAll("[aria-label], [title]")) {
      const lbl = (el.getAttribute("aria-label") || el.getAttribute("title") || "").trim();
      const sec = parseAbsoluteDateLabel(lbl);
      if (sec > 0) return sec;
    }
    // Last chance: scan timestamp-looking anchors. The post header
    // has an <a href="…/posts/…|/photo(.php)?…|/videos/…"> whose
    // visible text is the relative time ("4h", "1d", "2w", "Just
    // now", "Yesterday at 5:32 PM"). Modern FB doesn't embed the
    // precise absolute datetime in static DOM for recent posts —
    // hover triggers an async fetch to fill a tooltip. Approximate
    // by parsing the relative text against now() instead.
    for (const a of scope.querySelectorAll("a[href]")) {
      const href = a.getAttribute("href") || "";
      if (!/\/posts\/|\/photos?\/|\/photo\.php|[?&]fbid=\d+|\/videos?\//.test(href)) continue;
      const text = (a.textContent || "").trim();
      if (!text || text.length > 40) continue;
      const sec = parseRelativeTimeLabel(text);
      if (sec > 0) return sec;
    }
    return 0;
  }

  // parseRelativeTimeLabel reads Facebook's short relative-time
  // widgets ("4h", "1 d", "2w", "3 mo", "Just now", "Yesterday at
  // 5:32 PM") and converts them to unix seconds. Returns 0 if the
  // text doesn't match a known shape. Approximation error is within
  // a day for anything past "now" — acceptable for the gallery card
  // which only displays per-day dates.
  function parseRelativeTimeLabel(text) {
    if (!text) return 0;
    const now = Date.now();
    const s = text.trim().toLowerCase();
    if (s === "just now" || s === "now") return Math.floor(now / 1000);
    // "Yesterday at 5:32 PM" style — parseable by Date.parse when
    // we rewrite "Yesterday" as yesterday's ISO date.
    const ymatch = s.match(/^yesterday(?:\s+at\s+(.+))?$/);
    if (ymatch) {
      const d = new Date(now - 24 * 60 * 60 * 1000);
      d.setHours(12, 0, 0, 0); // noon fallback if no time given
      if (ymatch[1]) {
        const ms = Date.parse(`${d.toDateString()} ${ymatch[1]}`);
        if (Number.isFinite(ms) && ms > 0) return Math.floor(ms / 1000);
      }
      return Math.floor(d.getTime() / 1000);
    }
    // Compact "Nunit" or "N unit" forms, optional trailing "ago".
    const m = s.match(/^(\d+)\s*(s|sec|secs|min|mins|m|h|hr|hrs|hour|hours|d|day|days|w|wk|wks|week|weeks|mo|mon|mos|month|months|y|yr|yrs|year|years)(\s*ago)?$/);
    if (!m) return 0;
    const n = parseInt(m[1], 10);
    if (!Number.isFinite(n) || n <= 0) return 0;
    const unit = m[2];
    let deltaMs = 0;
    if (/^s/.test(unit)) deltaMs = n * 1000;
    else if (unit === "m" || unit === "min" || unit === "mins") deltaMs = n * 60 * 1000;
    else if (/^h/.test(unit) || /^hour/.test(unit) || unit === "hr" || unit === "hrs") deltaMs = n * 60 * 60 * 1000;
    else if (/^d/.test(unit) || /^day/.test(unit)) deltaMs = n * 24 * 60 * 60 * 1000;
    else if (/^w/.test(unit) || /^wk/.test(unit) || /^week/.test(unit)) deltaMs = n * 7 * 24 * 60 * 60 * 1000;
    else if (/^mo/.test(unit) || /^month/.test(unit)) deltaMs = n * 30 * 24 * 60 * 60 * 1000;
    else if (/^y/.test(unit) || /^yr/.test(unit) || /^year/.test(unit)) deltaMs = n * 365 * 24 * 60 * 60 * 1000;
    else return 0;
    return Math.floor((now - deltaMs) / 1000);
  }

  // parseAbsoluteDateLabel returns unix seconds if `lbl` looks like
  // an absolute date the browser can parse. Rejects relative text
  // ("4 hours ago", "Yesterday", "just now") and far-future parses
  // (Date.parse sometimes interprets garbage generously — cap the
  // result at now+24h to reject bogus futures).
  function parseAbsoluteDateLabel(lbl) {
    if (!lbl || lbl.length > 120) return 0;
    if (/\bago\b|\bjust\s*now\b|\byesterday\b|\btoday\b/i.test(lbl)) return 0;
    // Need at least one concrete absolute signal: 4-digit year, a
    // HH:MM time, or a month name. Without that, Date.parse produces
    // garbage too often on short strings.
    const hasYear = /\b\d{4}\b/.test(lbl);
    const hasTime = /\b\d{1,2}:\d{2}\b/.test(lbl);
    const hasMonth = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(lbl);
    if (!hasYear && !hasTime && !hasMonth) return 0;
    const ms = Date.parse(lbl);
    if (!Number.isFinite(ms) || ms <= 0) return 0;
    if (ms > Date.now() + 24 * 60 * 60 * 1000) return 0;
    return Math.floor(ms / 1000);
  }

  function thumbFor(container) {
    for (const v of container.querySelectorAll("video")) {
      if (v.poster) return v.poster;
    }
    const imgs = container.querySelectorAll("img");
    for (const img of imgs) {
      const src = img.currentSrc || img.src || img.getAttribute("data-src") || "";
      if (!src) continue;
      if (/\/v\/t(?:39\.30808-[01]|1\.6435-1|1\.30497-1)\//.test(src)) continue;
      if (/\/v\/t(?:39\.30808-6|15\.5256-\d+|51\.[\d.-]+|45\.[\d.-]+|58\.[\d.-]+-6)\//.test(src)) {
        return src;
      }
    }
    for (const img of imgs) {
      const src = img.currentSrc || img.src || img.getAttribute("data-src") || "";
      if (!src) continue;
      if (/\/v\/t(?:39\.30808-[01]|1\.6435-1|1\.30497-1)\//.test(src)) continue;
      const r = img.getBoundingClientRect();
      if (r.width >= 120 && r.height >= 120) return src;
    }
    return "";
  }

  const POST_CONTAINER_MIN_HEIGHT = 140;
  function countPermalinksIn(node) {
    const paths = new Set();
    for (const a of node.querySelectorAll("a[href]")) {
      const p = matchesPermalink(a.getAttribute("href") || "");
      if (p) paths.add(p);
    }
    return paths.size;
  }
  function findPostContainer(anchor) {
    let node = anchor.parentElement;
    let depth = 0;
    let best = null;
    while (node && depth < 15) {
      if (countPermalinksIn(node) > 1) break;
      const rect = node.getBoundingClientRect();
      if (rect.height >= POST_CONTAINER_MIN_HEIGHT && rect.width >= 200) {
        best = node;
        const hasMedia =
          node.querySelector("video") ||
          [...node.querySelectorAll("img")].some((i) => {
            const r = i.getBoundingClientRect();
            return r.width >= 180 && r.height >= 180;
          });
        if (hasMedia) return node;
      }
      node = node.parentElement;
      depth++;
    }
    return best;
  }
  function findMediaWrapper(mediaEl) {
    let node = mediaEl.parentElement;
    let depth = 0;
    let best = null;
    while (node && depth < 15) {
      if (countPermalinksIn(node) > 0) break;
      const rect = node.getBoundingClientRect();
      if (rect.height >= POST_CONTAINER_MIN_HEIGHT && rect.width >= 200) {
        best = node;
      }
      node = node.parentElement;
      depth++;
    }
    return best;
  }

  // ---- Floating button ----------------------------------------------
  // CSS lives in facebook-post-grab.css, loaded by manifest alongside
  // this script. Keeping it in a sibling file means Prettier / linting
  // / IDE tooling all see the styles instead of them being a template
  // literal pasted into JS.

  // Inlined to avoid web_accessible_resources + an extra HTTP round
  // 22px icon from the shared grab-button helper (loaded immediately
  // before this script via manifest.json). The smaller size fits the
  // FB feed's tight action-row chrome.
  const FETCH_ICON_SVG = window.__frixtyGrabButton.fetchIconSvg(22);

  const floatingBtn = document.createElement("div");
  floatingBtn.className = "ytdlp-fb-grab-btn";
  floatingBtn.innerHTML = FETCH_ICON_SVG;
  floatingBtn.title = "fetch media";
  document.body.appendChild(floatingBtn);

  // container → { getPermalink: () => string }
  const hoverData = new WeakMap();
  let activeContainer = null;
  let currentUrl = location.href;

  // URL change hook is kept so other logic that may want to know
  // about SPA navigation can plug in — but the old "persistent
  // captured-urls" green-state tracking is gone. Every successful
  // capture now flashes green briefly and resets to blue, so the
  // user can click the same post again to re-add it after removing
  // it from the popup.
  function handleUrlChange() {
    if (location.href === currentUrl) return;
    currentUrl = location.href;
  }

  // Pages where the middle-right position conflicts with Facebook's
  // own in-viewer controls (navigation arrows, reactions column).
  // Use top-left positioning on these so the button doesn't block
  // anything.
  //   - /reel /reels  — reactions column + up/down arrows on right
  //   - /photo  — photo album viewer has prev/next arrows on sides
  //   - /photo.php — older photo viewer, same layout
  //   - /stories  — story viewer with navigation on right
  //   - /watch  — video player with controls on right
  function isMediaViewerContext() {
    const p = location.pathname;
    if (/^\/(reel|reels|stories|watch)(\/|$)/.test(p)) return true;
    if (p === "/photo" || p === "/photo/") return true;
    if (p === "/photo.php") return true;
    return false;
  }
  // Backwards-compat alias so the position function below doesn't
  // change shape unnecessarily.
  const isReelsContext = isMediaViewerContext;

  // Reset state — clear any flash classes; the SVG icon stays visible.
  function setBtnState() {
    floatingBtn.classList.remove("is-captured");
    floatingBtn.classList.remove("is-error");
  }

  // Transient confirmation flash: green bg for ~1s, then back to the
  // default blue. Icon stays visible the whole time (no textContent
  // swap), matching the TikTok / Twitter / Instagram pattern. The
  // showForContainer hover guard inspects flashTimer to avoid
  // resetting mid-flash.
  let flashTimer = null;
  function flashCaptured() {
    if (flashTimer) clearTimeout(flashTimer);
    floatingBtn.classList.remove("is-error");
    floatingBtn.classList.add("is-captured");
    flashTimer = setTimeout(() => {
      flashTimer = null;
      floatingBtn.classList.remove("is-captured");
    }, 1100);
  }
  // Longer flash (2s) because "nothing happened" is more confusing
  // than "it worked" — user needs time to notice the red flash. The
  // title swap reveals the cause on hover (FB-specific affordance,
  // which is why this isn't migrated to the shared helper).
  function flashError() {
    if (flashTimer) clearTimeout(flashTimer);
    floatingBtn.classList.remove("is-captured");
    floatingBtn.classList.add("is-error");
    floatingBtn.title = "No media found on this page. Wait for the page to finish loading, then try again.";
    flashTimer = setTimeout(() => {
      flashTimer = null;
      floatingBtn.classList.remove("is-error");
      floatingBtn.title = "fetch media";
    }, 2000);
  }

  function positionButtonFor(container) {
    const rect = container.getBoundingClientRect();
    const vw = document.documentElement.clientWidth || window.innerWidth;
    // Marketplace item viewer: the registered "container" may be an
    // ancestor of the hero photo (the dialog or the whole photo-area
    // wrapper), not the photo itself. Use the hero img's rect so the
    // button sits on the photo. Anchor to the bottom-right inside —
    // FB's next/prev arrows sit at middle edges, seller header / X
    // close button sit at the top, so the bottom-right corner is the
    // one part of the photo with nothing else competing.
    if (/^\/marketplace\/item\/\d+/.test(location.pathname) && marketplaceHeroEl) {
      const heroRect = marketplaceHeroEl.getBoundingClientRect();
      const inset = 20;
      floatingBtn.style.bottom = Math.max(inset, window.innerHeight - heroRect.bottom + inset) + "px";
      floatingBtn.style.right = Math.max(inset, vw - heroRect.right + inset) + "px";
      floatingBtn.style.left = "auto";
      floatingBtn.style.top = "auto";
      floatingBtn.classList.add("ytdlp-fb-grab-btn--marketplace");
      return;
    }
    floatingBtn.classList.remove("ytdlp-fb-grab-btn--marketplace");
    if (isMediaViewerContext()) {
      // Media viewers (reels, stories, photo album, watch, photos)
      // don't have a universally-safe corner:
      //   - top-left: photo album's close X button, sometimes story
      //     "back" arrow
      //   - top-right: reels "..." menu, photo viewer's close button
      //     in some variants
      //   - middle-right: reels reactions column + up/down nav arrows
      //   - bottom: captions, comment bars
      // Pin the button to the VIEWPORT (not the media container) at
      // a spot clear of all these controls: top-left of viewport
      // with a 60px offset from each edge. 60px is well past any
      // close button or back arrow (those typically inset ~10-20px).
      floatingBtn.style.top = "60px";
      floatingBtn.style.left = "60px";
      floatingBtn.style.right = "auto";
      floatingBtn.style.bottom = "auto";
      return;
    }
    // Middle-right of the container, INSIDE by 4px so it doesn't
    // need overflow: visible to render. Sits next to the media /
    // content area, away from Facebook's top-right "..." menu and
    // bottom-right reactions bar.
    const top = rect.top + rect.height / 2 - 15;
    const right = Math.max(4, vw - rect.right + 6);
    floatingBtn.style.top = top + "px";
    floatingBtn.style.right = right + "px";
    floatingBtn.style.left = "auto";
  }

  function showForContainer(container) {
    if (activeContainer === container) return;
    const data = hoverData.get(container);
    if (!data) return;
    activeContainer = container;
    // Only reset state if we're NOT in the middle of a flash — the
    // user's most recent capture should remain visible for the full
    // flash duration even if they happened to hover another post.
    if (!flashTimer) setBtnState();
    positionButtonFor(container);
    floatingBtn.style.display = "flex";
  }

  function hideButton() {
    activeContainer = null;
    floatingBtn.style.display = "none";
  }

  // Register a container with a permalink resolver. `permalink` may
  // be a string (for anchor-based registrations where the href is
  // stable) or the literal "__CURRENT__" sentinel indicating the
  // permalink should be read live from location on each click. Reels
  // / stories / marketplace item pages use the live form because
  // Facebook's SPA swaps content inside the same wrapper when the
  // user swipes to the next item, and the permalink must follow.
  function registerContainer(container, permalinkOrSentinel) {
    if (!container || !permalinkOrSentinel) return;
    if (hoverData.has(container)) return;
    let getPermalink;
    if (permalinkOrSentinel === "__CURRENT__") {
      getPermalink = () => location.pathname + location.search;
    } else if (permalinkOrSentinel === "__FB_WHOLEPAGE__") {
      // Sentinel for "don't capture one item — fetch and stage every
      // piece of media on this page." Used on marketplace item viewers
      // (no per-photo permalink to attach). Click handler routes this
      // to the SW's fb:capture-this-page flow.
      getPermalink = () => "__FB_WHOLEPAGE__";
    } else {
      getPermalink = () => permalinkOrSentinel;
    }
    hoverData.set(container, { getPermalink });
  }

  // Hover delegate: walk up from target to find a registered container.
  document.addEventListener("mouseover", (ev) => {
    if (ev.target === floatingBtn) return;
    let node = ev.target;
    let depth = 0;
    while (node && depth < 30 && node !== document.body) {
      if (hoverData.has(node)) {
        showForContainer(node);
        return;
      }
      node = node.parentElement;
      depth++;
    }
    // Marketplace hero is pinned — stay visible regardless of
    // where the cursor moves. The user expects a persistent button
    // on the carousel, not one that disappears when they hover off
    // the photo (especially since the overlay layers they hover can
    // swap in/out as FB's carousel auto-advances).
    if (activeContainer && activeContainer === marketplaceHeroEl) return;
    // Hide if the mouse is outside any registered container AND not
    // on the button itself. Don't hide on mouseleave of the button's
    // own region (stays open until user moves away).
    if (activeContainer) {
      const r = activeContainer.getBoundingClientRect();
      const inContainer =
        ev.clientX >= r.left && ev.clientX <= r.right &&
        ev.clientY >= r.top  && ev.clientY <= r.bottom;
      const bRect = floatingBtn.getBoundingClientRect();
      const onButton =
        ev.clientX >= bRect.left && ev.clientX <= bRect.right &&
        ev.clientY >= bRect.top  && ev.clientY <= bRect.bottom;
      if (!inContainer && !onButton) hideButton();
    }
  }, { passive: true });

  // Scroll/resize: reposition or hide based on container visibility.
  const onReflow = () => {
    if (!activeContainer) return;
    if (!document.body.contains(activeContainer)) { hideButton(); return; }
    const rect = activeContainer.getBoundingClientRect();
    const vh = window.innerHeight;
    if (rect.bottom < 0 || rect.top > vh) { hideButton(); return; }
    positionButtonFor(activeContainer);
  };
  window.addEventListener("scroll", onReflow, { passive: true, capture: true });
  window.addEventListener("resize", onReflow, { passive: true });

  // Click handler: capture the post the button is currently over.
  // Capture-phase on multiple events so Facebook's document-level
  // click delegates (capture:true, preventDefault) can't swallow us.
  let inFlight = false;
  async function doCapture() {
    if (inFlight || !activeContainer) return;
    const data = hoverData.get(activeContainer);
    if (!data) return;
    inFlight = true;
    const permalink = data.getPermalink();

    // Whole-page capture (marketplace item viewer). Ask the SW to run
    // the same interceptor-mining pass the popup's "Fetch media on
    // this page" button uses and batch every photo/video it finds as
    // a capture. Skips the per-post DOM-metadata path below — on
    // marketplace listings the meta fields aren't useful anyway
    // (author/date come from the listing graphql, not the DOM).
    if (permalink === "__FB_WHOLEPAGE__") {
      try {
        const resp = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({ type: "fb:capture-this-page" }, (r) => {
            if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
            else resolve(r);
          });
        });
        if (resp?.ok) {
          console.log("[frixty/post-grab] wholepage capture", { added: resp.added, count: resp.count });
          flashCaptured();
        } else {
          console.warn("[frixty/post-grab] wholepage capture failed", resp?.error);
          flashError();
        }
      } catch (err) {
        console.warn("[frixty/post-grab] wholepage send failed", err?.message || err);
        flashError();
      } finally {
        inFlight = false;
      }
      return;
    }

    const origin = location.origin;
    const absUrl = permalink.startsWith("http") ? permalink : origin + permalink;
    // Interceptor-sourced metadata first — the Facebook graphql
    // responses we've intercepted carry complete, authoritative post
    // data (author, creation_time, caption) regardless of layout.
    // Fall back to DOM scraping only when the cache doesn't have
    // this post yet (first-paint race, or the user navigated from
    // a permalink we haven't fetched graphql for yet).
    const meta = lookupPostMetadata(absUrl);
    const domAuthor = authorFrom(activeContainer);
    const domTitle = titleFor(activeContainer);
    const domDate = dateFor(activeContainer);
    const foundDate = (meta && meta.creationTime) || domDate || 0;
    const payload = {
      url: absUrl,
      author: (meta && meta.author) || domAuthor,
      thumbUrl: thumbFor(activeContainer),
      title: (meta && meta.message) || domTitle,
      postDate: foundDate,                  // unix seconds, 0 if unknown
      capturedAt: Date.now(),               // unix ms (browser clock)
      metaSource: meta
        ? "graphql"
        : (domAuthor || domTitle || domDate ? "dom" : "empty"),
    };
    // Diagnostic: when dateFor can't resolve the post time, dump
    // everything we saw in one structured log entry so "Save as"
    // preserves it intact. Previous per-line logs got collapsed.
    if (foundDate === 0) {
      try {
        const candidates = [];
        let scope = activeContainer;
        for (let i = 0; i < 5 && scope; i++, scope = scope.parentElement) {
          for (const el of scope.querySelectorAll("*")) {
            const tag = el.tagName.toLowerCase();
            const aria = el.getAttribute("aria-label");
            const title = el.getAttribute("title");
            const dt = el.getAttribute("datetime");
            const utime = el.getAttribute("data-utime");
            const dataKeys = Array.from(el.attributes || []).filter((a) => a.name.startsWith("data-"));
            if (!aria && !title && !dt && !utime && dataKeys.length === 0) continue;
            const parts = [];
            if (aria) parts.push(`aria-label="${aria.slice(0, 140)}"`);
            if (title) parts.push(`title="${title.slice(0, 140)}"`);
            if (dt) parts.push(`datetime="${dt}"`);
            if (utime) parts.push(`data-utime="${utime}"`);
            for (const a of dataKeys) {
              if (["data-utime", "data-hovercard", "data-pagelet"].includes(a.name)) continue;
              if (/\btime|date|utime|timestamp\b/i.test(a.name)) {
                parts.push(`${a.name}="${(a.value || "").slice(0, 100)}"`);
              }
            }
            if (parts.length === 0) continue;
            candidates.push(`lvl${i} <${tag}> ${parts.join(" ")}`);
            if (candidates.length >= 40) break;
          }
          if (candidates.length >= 40) break;
        }
        const containerPreview = (activeContainer.outerHTML || "").slice(0, 2500);
        // Also look at sibling / ancestor headers specifically — some
        // FB feeds render the post's header as a DOM SIBLING of the
        // photo wrapper.
        let ancestorPreview = "";
        const parent = activeContainer.parentElement;
        if (parent) {
          ancestorPreview = (parent.outerHTML || "").slice(0, 2500);
        }
        // Also look for any <a> anchor inside the nearest
        // [role="article"] whose href pattern matches a post
        // permalink — its visible text is usually the relative
        // timestamp ("4h", "1d"), which parseRelativeTimeLabel
        // would have consumed. Capture the candidates anyway so we
        // know what we're working with.
        const article = activeContainer.closest?.('[role="article"]');
        const relAnchors = [];
        if (article) {
          for (const a of article.querySelectorAll("a[href]")) {
            const href = a.getAttribute("href") || "";
            if (!/\/posts\/|\/photos?\/|\/photo\.php|[?&]fbid=\d+|\/videos?\/|\/reel\//.test(href)) continue;
            const text = (a.textContent || "").trim().slice(0, 40);
            if (!text) continue;
            relAnchors.push(`"${text}" ← ${href.slice(0, 80)}`);
            if (relAnchors.length >= 10) break;
          }
        }

        // Chrome's saved console-log preview truncates arrays to
        // "Array(N)". Serialize everything into primitive strings
        // (joined) so the full content lands in the log file.
        // Dump the ids we're LOOKING for vs a sample of ids actually
        // indexed. If none match, we know FB used a different id
        // scheme for this post that the interceptor isn't capturing.
        const permalinkIds = idsFromPermalink(absUrl);
        const cacheIdSample = [
          ...Array.from(postsByMedia.keys()).slice(0, 15),
          ...Array.from(postsById.keys()).slice(0, 10),
        ];
        const lookupIdsTried = permalinkIds.all.join(",");
        const cacheAllIds = Array.from(
          new Set([...postsByMedia.keys(), ...postsById.keys()])
        );
        const lookupHitIds = permalinkIds.all.filter((id) => cacheAllIds.includes(id));
        const diagPayload = {
          foundDate,
          metaSource: payload.metaSource,
          graphqlHit: !!meta,
          graphqlAuthor: meta?.author || "(empty)",
          graphqlCreationTime: meta?.creationTime || 0,
          postCacheSize: postsById.size + postsByMedia.size,
          lookupMediaId: permalinkIds.mediaId || "(none)",
          lookupStoryId: permalinkIds.storyId || "(none)",
          lookupIdsTried,
          lookupHitIds: lookupHitIds.join(",") || "(none)",
          cacheIdSample: cacheIdSample.join(",").slice(0, 1500),
          authorFound: payload.author || "(empty)",
          titleFound: payload.title || "(empty)",
          candidatesCount: candidates.length,
          candidates: candidates.join(" || ").slice(0, 3500),
          relAnchorsCount: relAnchors.length,
          relAnchors: relAnchors.join(" || ").slice(0, 2000),
          containerTag: activeContainer.tagName.toLowerCase(),
          containerRectH: Math.round(activeContainer.getBoundingClientRect().height),
          foundArticle: !!article,
          articleRectH: article ? Math.round(article.getBoundingClientRect().height) : 0,
          containerPreview,
          ancestorPreview,
        };
        console.log("[frixty/fb-grab] dateFor diagnostic", diagPayload);
        try {
          chrome.runtime.sendMessage({ type: "debug:fb-dateFor", diag: diagPayload });
        } catch {}
      } catch (err) {
        console.warn("[frixty/fb-grab] diagnostic dump failed", err?.message || err);
      }
    }
    console.log("[frixty/post-grab] capturing", {
      url: payload.url.slice(0, 100),
      author: payload.author || "(empty)",
      thumbUrl: payload.thumbUrl ? payload.thumbUrl.slice(0, 80) : "(empty)",
      title: (payload.title || "").slice(0, 60),
      postDate: payload.postDate,
      metaSource: payload.metaSource,
      postCacheSize: postsById.size + postsByMedia.size,
    });
    try {
      await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: "capture:add", payload }, (resp) => {
          if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
          else resolve(resp);
        });
      });
      flashCaptured();
    } catch (err) {
      console.warn("[frixty/post-grab] send failed", err?.message || err);
    } finally {
      inFlight = false;
    }
  }
  const onBtnAct = (ev) => {
    // Only act on events actually aimed at our button (including the
    // window-level fallback listeners below, which receive ALL events
    // and must filter).
    if (ev.target !== floatingBtn && !floatingBtn.contains(ev.target)) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    ev.stopPropagation();
    // Fire on pointerdown (the earliest pointer event) in addition to
    // click/pointerup. When the extension popup is already open and
    // the user clicks our button on the underlying page, Chrome's
    // popup-dismissal consumes the later `click` event — but the
    // `pointerdown` that started the interaction still reaches the
    // page. The inFlight guard in doCapture prevents the same click
    // from triggering capture twice if both events land.
    if (ev.type === "click" || ev.type === "pointerup" || ev.type === "pointerdown") {
      console.log("[frixty/post-grab] btn act", ev.type, {
        hasActive: !!activeContainer,
        inFlight,
      });
      doCapture();
    }
  };
  // Three tiers of listeners — belt and suspenders so Facebook's
  // document-level capture-phase handlers (which call stopPropagation
  // on some post regions and swallow descendant events) can't prevent
  // us from seeing the click:
  //   1) Direct on the button (normal case)
  //   2) Document capture phase (fires BEFORE any Facebook bubble-
  //      phase handler on the same element)
  //   3) Window capture phase (fires BEFORE document capture-phase
  //      listeners — guarantees we see the event first even if
  //      Facebook registered a document-level capture listener
  //      before our content script loaded)
  for (const evt of ["click", "pointerdown", "pointerup", "mousedown", "mouseup"]) {
    floatingBtn.addEventListener(evt, onBtnAct, true);
    document.addEventListener(evt, onBtnAct, true);
    window.addEventListener(evt, onBtnAct, true);
  }

  // ---- Scan ---------------------------------------------------------
  let lastStats = { anchors: 0, registered: 0, mediaRegistered: 0 };
  // The hero photo's <img> on a marketplace item viewer. Set by
  // Pass 3; positionButtonFor reads it so the button anchors to the
  // hero rect regardless of which ancestor the hover delegate picked.
  let marketplaceHeroEl = null;
  let lastMpScanSummary = "";
  function scan() {
    handleUrlChange();
    let anchorsWithPermalink = 0;
    let registeredFromAnchors = 0;
    // Pass 1: permalink anchors.
    for (const a of document.querySelectorAll("a[href]")) {
      const href = a.getAttribute("href") || "";
      const permalink = matchesPermalink(href);
      if (!permalink) continue;
      anchorsWithPermalink++;
      const container = findPostContainer(a);
      if (!container) continue;
      if (hoverData.has(container)) continue;
      const hasMediaOrText =
        container.querySelector("video") ||
        [...container.querySelectorAll("img")].some((i) => {
          const r = i.getBoundingClientRect();
          return r.width >= 180 && r.height >= 180;
        }) ||
        (container.textContent || "").length > 40;
      if (!hasMediaOrText) continue;
      registerContainer(container, permalink);
      registeredFromAnchors++;
    }

    // Pass 2: content-size media without a pass-1 button. Reels,
    // sponsored posts, stories viewer, watch page. Note: marketplace
    // item viewers are handled by Pass 3 below with a whole-page
    // sentinel — skip them here. Pass 2's findMediaWrapper walks up
    // from the img looking for a reasonably-sized ancestor and would
    // otherwise register the full-screen dialog wrapper
    // ([aria-label="Marketplace Listing Viewer"], ~959px tall). That
    // wrapper sits above Pass 3's hero-img registration in the DOM,
    // so every hover anywhere in the dialog activates the dialog-
    // level container and clicks route the LISTING URL through the
    // per-post capture path (which yt-dlp can't download).
    const onMarketplaceItem = /^\/marketplace\/item\/\d+/.test(location.pathname);
    const onSingle = pageIsSingleItem() && !onMarketplaceItem;
    let mediaRegistered = 0;
    const contentImgs = [];
    if (!onMarketplaceItem) {
      for (const i of document.querySelectorAll("img")) {
        const src = i.currentSrc || i.src || "";
        if (!/\/v\/t(?:39\.30808-6|15\.5256-\d+|51\.[\d.-]+|45\.[\d.-]+|58\.[\d.-]+-6)\//.test(src)) continue;
        const r = i.getBoundingClientRect();
        if (r.width < 200 || r.height < 200) continue;
        contentImgs.push(i);
      }
    }
    const mediaEls = onMarketplaceItem ? [] : [...document.querySelectorAll("video"), ...contentImgs];
    for (const mediaEl of mediaEls) {
      const wrapper = findMediaWrapper(mediaEl);
      if (!wrapper) continue;
      if (hoverData.has(wrapper)) continue;
      let permalink = "";
      if (onSingle) {
        // Live resolver — reels / stories swipes change location
        // but keep the same wrapper element, and a snapshot taken
        // here would go stale on the next item.
        permalink = "__CURRENT__";
      } else {
        let walk = mediaEl.parentElement;
        let depth = 0;
        while (walk && depth < 20 && !permalink) {
          for (const a of walk.querySelectorAll("a[href]")) {
            const p = matchesPermalink(a.getAttribute("href") || "");
            if (p) { permalink = p; break; }
          }
          walk = walk.parentElement;
          depth++;
        }
      }
      if (!permalink) continue;
      registerContainer(wrapper, permalink);
      mediaRegistered++;
    }

    // Pass 3: Marketplace item viewer. The current listing has no
    // self-referential permalink anchor on the page (the user IS on
    // /marketplace/item/<id>, links go to OTHER items in the "related
    // listings" rail). Pass 1 finds nothing for the hero photo, and
    // pass 2's findMediaWrapper walk gets cut off when it reaches an
    // ancestor containing the related-listings anchors. Register ONLY
    // the single biggest fbcdn/scontent img on the page as the hero
    // photo — the sidebar info panel shows smaller preview photos on
    // some layouts (next listing's thumbnail, seller profile strip)
    // that would otherwise catch a second button. Excludes photos
    // nested inside a "related listings" rail (several
    // /marketplace/item/ anchor neighbors).
    let mpRegistered = 0;
    let mpCandidates = 0;
    let mpHero = null;
    let mpHeroRect = { w: 0, h: 0 };
    let mpBiggestSrc = "";
    let mpTotalImgs = 0;
    let mpFbcdnImgs = 0;
    let mpAncestorRects = [];
    // Navigated off the listing? Clear the pinned hero so the button
    // doesn't stay pointing at stale DOM after the modal closes.
    if (!onMarketplaceItem && marketplaceHeroEl) {
      marketplaceHeroEl = null;
      hideButton();
    }
    if (onMarketplaceItem) {
      // "Related listings" rails: scan for small, localized wrappers
      // that group 3+ /marketplace/item/ anchors. Bound the walk-up
      // depth AND require the wrapper to be smaller than 80% of the
      // viewport in at least one dimension — otherwise the walk
      // bubbles to <body> / <main>, which contains the hero too, and
      // excludes EVERY img including the one we want.
      const relatedRails = new Set();
      const vhForRail = window.innerHeight;
      const vwForRail = window.innerWidth;
      for (const a of document.querySelectorAll('a[href^="/marketplace/item/"]')) {
        let n = a.parentElement;
        let depth = 0;
        while (n && depth < 4) {
          const permalinks = n.querySelectorAll?.('a[href^="/marketplace/item/"]');
          if (permalinks && permalinks.length >= 3) {
            const rr = n.getBoundingClientRect();
            if (rr.height < vhForRail * 0.8 || rr.width < vwForRail * 0.8) {
              relatedRails.add(n);
            }
            break;
          }
          n = n.parentElement;
          depth++;
        }
      }
      const inRelatedRail = (el) => {
        for (const rail of relatedRails) if (rail.contains(el)) return true;
        return false;
      };
      for (const i of document.querySelectorAll("img")) {
        mpTotalImgs++;
        const src = i.currentSrc || i.src || "";
        if (!/\bfbcdn\.net\/|^https?:\/\/scontent[\-.]/i.test(src)) continue;
        mpFbcdnImgs++;
        const r = i.getBoundingClientRect();
        // Lowered threshold from 220 to 160 — some marketplace
        // layouts render the hero at ~180×240 when the right sidebar
        // is wide.
        if (r.width < 160 || r.height < 160) continue;
        if (inRelatedRail(i)) continue;
        mpCandidates++;
        const area = r.width * r.height;
        if (area > mpHeroRect.w * mpHeroRect.h) {
          mpHero = i;
          mpHeroRect = { w: Math.round(r.width), h: Math.round(r.height) };
          mpBiggestSrc = src.slice(0, 120);
        }
      }
      if (mpHero) {
        marketplaceHeroEl = mpHero;
        if (!hoverData.has(mpHero)) {
          registerContainer(mpHero, "__FB_WHOLEPAGE__");
          mpRegistered++;
        }
        // Pin the button to the hero without requiring hover. The
        // modal-dialog photo viewer layers transparent overlays
        // (click-to-next, click-to-close) via React portals that
        // create isolated stacking contexts; hovering the hero may
        // never walk up through our registered ancestors, and the
        // button would stay hidden. Explicitly showing it solves
        // that and is consistent with the user's ask ("the fetch
        // button on the carousel"). See below for the hover-delegate
        // override that keeps it pinned.
        if (activeContainer !== mpHero) showForContainer(mpHero);
      } else if (marketplaceHeroEl) {
        // Hero disappeared between scans (user closed the modal,
        // swiped to a different listing, etc.). Unpin.
        marketplaceHeroEl = null;
        hideButton();
      }
      // Always log — an empty scan is the interesting case when the
      // button doesn't appear. Includes the unfiltered img count so
      // we can tell whether the hero hasn't rendered yet vs whether
      // its src/size fell outside our filters. Dedup: only log when
      // the scan summary changes, so MutationObserver re-runs don't
      // spam the console.
      const scanSummary = [
        location.pathname, mpTotalImgs, mpFbcdnImgs, mpCandidates,
        mpRegistered, relatedRails.size, mpHeroRect.w, mpHeroRect.h,
        mpAncestorRects.join(","),
      ].join("|");
      if (scanSummary !== lastMpScanSummary) {
        lastMpScanSummary = scanSummary;
        const payload = {
          path: location.pathname,
          totalImgs: mpTotalImgs,
          fbcdnImgs: mpFbcdnImgs,
          candidates: mpCandidates,
          registered: mpRegistered,
          rails: relatedRails.size,
          heroW: mpHeroRect.w,
          heroH: mpHeroRect.h,
          ancestors: mpAncestorRects.join(","),
          src: mpBiggestSrc,
        };
        console.log("[frixty/post-grab] marketplace scan", payload);
        // Also forward to the SW so it lands in the extension log
        // the user saves (page-console lines don't show up there).
        try {
          chrome.runtime.sendMessage({ type: "debug:fb-mp-scan", diag: payload });
        } catch {}
      }
    }

    lastStats = { anchors: anchorsWithPermalink, registered: registeredFromAnchors, mediaRegistered };
  }

  let scanScheduled = false;
  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    requestAnimationFrame(() => {
      scanScheduled = false;
      try { scan(); } catch (err) {
        console.warn("[frixty/post-grab] scan error", err);
      }
    });
  }

  // Debug helper: open devtools and run window.__ytdlpFbGrabStats()
  // to see how many posts were detected this pass.
  window.__ytdlpFbGrabStats = () => ({ ...lastStats });

  scheduleScan();
  const mo = new MutationObserver(scheduleScan);
  mo.observe(document.body, {
    childList: true,
    subtree: true,
    // Carousels on marketplace item viewers swap <img src> on slide
    // change rather than replacing the node — catch those too so the
    // grab button keeps tracking the visible slide.
    attributes: true,
    attributeFilter: ["src", "style"],
  });
  window.addEventListener("scroll", scheduleScan, { passive: true });
})();
