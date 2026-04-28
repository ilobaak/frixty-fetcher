// Runs in the page's JS world at document_start on Facebook. Facebook
// stories don't embed media data into the initial HTML once the user
// navigates the tray — the data flows over fetch / XHR GraphQL calls
// as they browse. We patch both transports to snapshot any response
// that mentions playable_url / preferred_thumbnail / native_hd_url
// into window.__ytdlpFbCache. The extension popup reads that cache
// via chrome.scripting.executeScript({ world: "MAIN" }) and extracts
// the active story's media from whichever entry matches the visible
// poster token or user id.
//
// Must run in MAIN world at document_start so the patches land
// before Facebook's JS bundles capture references to fetch/XHR.
(function () {
  if (window.__ytdlpFbInterceptorLoaded) return;
  window.__ytdlpFbInterceptorLoaded = true;
  window.__ytdlpFbInterceptorVersion = 2;
  window.__ytdlpFbCache = [];
  window.__ytdlpFbCaptureCount = 0;
  window.__ytdlpFbFetchCount = 0;
  window.__ytdlpFbXhrCount = 0;
  // Loud install marker so the user can see in the page's console
  // that the interceptor is running. Also helps confirm MAIN-world
  // timing (the message shows up before Facebook's bundles log).
  console.log("[frixty/interceptor] installed v2 at", location.href);
  const MAX = 50;

  // Broad capture: any meaningfully-sized response to a Facebook data
  // endpoint (/api/graphql/, /ajax/, /graphql/, /webgraphql/) gets
  // stored. Content-keyword filtering was too lossy — minified
  // responses alias field names, and the keyword we care about
  // ("playable_url") can become just "a" or similar after aliasing.
  // Easier to keep everything sizeable and search at read time.
  function isFbDataUrl(url) {
    if (!url) return false;
    const s = String(url);
    // Only GraphQL endpoints. /ajax/bulk-route-definitions/ and friends
    // are navigation prefetch payloads that flood the cache with
    // thousands of mp4 fragment URLs (from DASH player performance
    // loggers) and zero feed posts — including them here evicts real
    // feed GraphQL responses from the 50-entry ring buffer before we
    // can read them.
    return (
      s.indexOf("/api/graphql/") !== -1 ||
      s.indexOf("/graphql/") !== -1 ||
      s.indexOf("/webgraphql/") !== -1
    );
  }

  function capture(url, text) {
    try {
      if (!text || text.length < 1024) return;
      if (!isFbDataUrl(url)) return;
      window.__ytdlpFbCaptureCount++;
      window.__ytdlpFbCache.push({ url: String(url).slice(0, 500), text, time: Date.now() });
      while (window.__ytdlpFbCache.length > MAX) window.__ytdlpFbCache.shift();
      try {
        const short = String(url).slice(0, 120);
        console.log("[frixty/interceptor] captured", short, "(" + text.length + " bytes)");
      } catch (_) {}
      // NEW: mine this response for post metadata and forward each
      // discovered post to the isolated-world content script. That
      // script indexes them by media id so the grab button can look
      // up author / creation_time / caption by fbid, reliably,
      // across every FB layout (feed, photo viewer, marketplace,
      // groups, reels) — DOM scraping was a losing game.
      try { indexPostsFrom(text); } catch (_) {}
    } catch (_) {}
  }

  // indexPostsFrom: parse a graphql response body, walk the JSON
  // tree, and for every post-shaped object found (has id +
  // creation_time + some media), postMessage a compact record to
  // the isolated world. Fire-and-forget; the isolated world listens
  // via `window.addEventListener("message", …)`.
  function indexPostsFrom(text) {
    if (!text || text.length < 100) return;
    // FB graphql responses often contain multiple JSON objects
    // separated by newlines (streaming / batched). Parse each.
    const lines = text.split(/\r?\n/).filter(Boolean);
    let sent = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) continue;
      let blob;
      try { blob = JSON.parse(trimmed); } catch (_) { continue; }
      sent += walkAndPublishPosts(blob);
      if (sent >= 20) break;  // per-response cap
    }
    if (sent === 0 && text.trim().startsWith("{")) {
      try {
        const blob = JSON.parse(text);
        walkAndPublishPosts(blob);
      } catch (_) {}
    }
  }

  // walkAndPublishPosts indexes every node-with-id in the response
  // by inheriting metadata (creation_time, author, message) from its
  // ancestors as it recurses. Facebook's graphql nests media objects
  // (Photo, Video, Reel) inside story objects — the story has the
  // timestamp, the media has the fbid the user clicks. Propagating
  // the parent's metadata down means a photo's fbid gets indexed
  // with its parent story's creation_time, which is the mapping the
  // grab button actually needs.
  // extractTimestamp pulls a unix-seconds timestamp out of a graphql
  // node by trying FB's many timestamp field names. Returns 0 if
  // none match.
  const TIMESTAMP_FIELDS = [
    "creation_time",
    "created_time",
    "publish_time",
    "timestamp",
    "time_created",
    "modified_time",
    "updated_time",
  ];
  function extractTimestamp(node) {
    for (const f of TIMESTAMP_FIELDS) {
      const v = node[f];
      if (typeof v === "number" && v > 1_000_000_000) return v;
      if (typeof v === "string" && /^\d{10,}$/.test(v)) return parseInt(v, 10);
    }
    // ISO string on uploaded_date (photo nodes).
    if (typeof node.uploaded_date === "string") {
      const ms = Date.parse(node.uploaded_date);
      if (Number.isFinite(ms) && ms > 0) return Math.floor(ms / 1000);
    }
    // story.creation_time — some photo graphql responses carry a
    // {story: {creation_time: N}} reference to the parent story.
    if (node.story && typeof node.story === "object") {
      for (const f of TIMESTAMP_FIELDS) {
        const v = node.story[f];
        if (typeof v === "number" && v > 1_000_000_000) return v;
      }
    }
    return 0;
  }

  function walkAndPublishPosts(root) {
    const published = new Set();
    const EMPTY_META = { creationTime: 0, author: "", authorProfile: "", message: "", permalinkUrl: "" };
    let count = 0;
    function visit(node, depth, inherited) {
      if (count >= 40) return;
      if (depth > 18 || node == null) return;
      if (Array.isArray(node)) {
        for (const item of node) { if (count >= 40) return; visit(item, depth + 1, inherited); }
        return;
      }
      if (typeof node !== "object") return;

      // Pick up metadata from this node. Locals override inherited
      // values (a story node's creation_time wins over its parent's
      // when propagating to nested media).
      //
      // FB graphql sprinkles timestamps across many field names:
      //   creation_time      — post/story publish time (unix sec)
      //   created_time       — legacy alias
      //   publish_time       — shared posts
      //   timestamp          — generic
      //   time_created       — some photo types
      //   modified_time      — updated, close enough for display
      //   uploaded_date      — ISO string on some photo nodes
      //   story.creation_time — nested ref on photo nodes pointing
      //                         at the parent story's time
      const localTime = extractTimestamp(node);
      const actor = node.owner || (Array.isArray(node.actors) ? node.actors[0] : null) || node.author || node.from || null;
      const localAuthor = (actor && typeof actor === "object" && typeof actor.name === "string") ? actor.name : "";
      const localAuthorProfile = (actor && typeof actor === "object" && typeof actor.url === "string") ? actor.url : "";
      let localMessage = "";
      if (node.message && typeof node.message.text === "string") localMessage = node.message.text;
      else if (node.message_preferred_body && typeof node.message_preferred_body.text === "string")
        localMessage = node.message_preferred_body.text;
      else if (typeof node.message === "string") localMessage = node.message;
      if (localMessage.length > 500) localMessage = localMessage.slice(0, 500);
      const localPermalink = typeof node.permalink_url === "string" ? node.permalink_url : "";

      const merged = {
        creationTime: localTime || inherited.creationTime,
        author: localAuthor || inherited.author,
        authorProfile: localAuthorProfile || inherited.authorProfile,
        message: localMessage || inherited.message,
        permalinkUrl: localPermalink || inherited.permalinkUrl,
      };

      // Index this node by every id-looking field. FB's graphql
      // uses MULTIPLE id schemes:
      //   id         — usually the opaque graphql node id (base64ish)
      //   legacy_id  — the numeric fbid that shows up in URLs
      //   pkey       — another numeric id variant
      //   post_id    — story id on some post types
      //   fbid       — explicit fbid field on some photo types
      //   story_fbid — set on some reaction / share objects
      //
      // A photo viewer URL /photo/?fbid=<N> carries the LEGACY_ID;
      // the graphql node has `id: "UzpfS..."` (opaque). So we MUST
      // index by legacy_id too or lookups miss.
      const idCandidates = [];
      for (const key of ["id", "legacy_id", "pkey", "post_id", "fbid", "story_fbid"]) {
        const v = node[key];
        if (typeof v === "string" && /^\d{5,}/.test(v)) idCandidates.push(v);
      }
      // De-dupe within this node's own id set.
      const uniq = Array.from(new Set(idCandidates));
      for (const id of uniq) {
        if (published.has(id)) continue;
        if (!merged.creationTime && !merged.author) continue;
        published.add(id);
        try {
          window.postMessage({
            __ytdlpFbPost: true,
            postId: id,
            creationTime: merged.creationTime,
            author: merged.author,
            authorProfile: merged.authorProfile,
            message: merged.message,
            permalinkUrl: merged.permalinkUrl,
            mediaIds: uniq,   // every sibling id for this node points to the same record
          }, "*");
          count++;
          if (count >= 40) return;
        } catch (_) {}
      }

      for (const k of Object.keys(node)) {
        if (count >= 40) return;
        visit(node[k], depth + 1, merged);
      }
    }
    visit(root, 0, EMPTY_META);
    return count;
  }

  // ---- fetch patch --------------------------------------------------
  const origFetch = window.fetch;
  window.fetch = function patchedFetch() {
    const args = arguments;
    window.__ytdlpFbFetchCount++;
    const prom = origFetch.apply(this, args);
    try {
      prom.then(function (resp) {
        try {
          let url = "";
          const a0 = args[0];
          if (typeof a0 === "string") url = a0;
          else if (a0 && a0.url) url = a0.url;
          resp.clone().text().then(function (t) { capture(url, t); }).catch(function () {});
        } catch (_) {}
      }).catch(function () {});
    } catch (_) {}
    return prom;
  };

  // ---- XHR patch ----------------------------------------------------
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try { this.__ytdlpUrl = url; } catch (_) {}
    return origOpen.apply(this, arguments);
  };
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    try {
      window.__ytdlpFbXhrCount++;
      const self = this;
      this.addEventListener("loadend", function () {
        try {
          const u = self.__ytdlpUrl || "";
          if (self.status >= 200 && self.status < 400 && typeof self.responseText === "string") {
            capture(u, self.responseText);
          }
        } catch (_) {}
      });
    } catch (_) {}
    return origSend.apply(this, arguments);
  };
})();
