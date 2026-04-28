// User-facing error mapping for the popup. Pure functions: take a host
// error message + a context object, return {severity, title, detail}
// for the inline status renderer or a plain string for the yt-dlp
// prettifier.
//
// The context object holds everything that used to be read from
// popup.js's module-level state (tabUrl, cookies retry / mode flags) —
// this keeps the module testable and lets popup.js remain the single
// place that knows about its own state.

// detectCurrentSite returns a short site key ("twitter" | "youtube" | "")
// for the URL the popup is acting on. Currently only Twitter and
// YouTube produce special error copy; other sites fall through to the
// generic "unable to download" message.
export function detectCurrentSite(tabUrl) {
  if (!tabUrl) return "";
  try {
    const host = new URL(tabUrl).hostname.toLowerCase();
    if (
      host === "twitter.com" ||
      host.endsWith(".twitter.com") ||
      host === "x.com" ||
      host.endsWith(".x.com")
    )
      return "twitter";
    if (host.endsWith("youtube.com") || host === "youtu.be" || host.endsWith(".youtu.be"))
      return "youtube";
  } catch {}
  return "";
}

// ageRestrictedError builds the listformats_failed / no_formats response
// for sites where age-gated content is the most likely cause. Tailors
// the wording based on whether the user's cookies setting has already
// been tried or is currently disabled.
//
// ctx fields used: triedCookies, cookiesMode.
function ageRestrictedError(site, ctx) {
  const siteName = site === "twitter" ? "Twitter / X" : "YouTube";
  let detail;
  if (ctx.triedCookies) {
    detail = `We couldn't fetch this ${siteName} media even using your browser cookies. The content may be age-restricted, deleted, or from a suspended/private account — or your ${siteName} session has expired. Try reloading ${siteName}, signing in again, then retry.`;
  } else if (ctx.cookiesMode === "never") {
    detail = `This ${siteName} media wouldn't load without authentication. If you're logged into ${siteName} in this browser, change the ${siteName} cookies setting to "Auto" or "Always" in Options.`;
  } else {
    detail = `This ${siteName} media may be age-restricted or private. Check that you can view it in this tab while logged in.`;
  }
  return { severity: "info", title: "Unable to download", detail };
}

// prettifyYtdlpError turns the raw host message (shape is now
// "ERROR: <yt-dlp text> (exit status N)" — see host/cmd/frixtyhost/
// download.go :: formatDownloadErr) into a human-friendly sentence.
// Recognizes a few common yt-dlp failure modes and rewrites them; for
// anything else, returns the raw yt-dlp ERROR line trimmed of the
// noisy bits.
//
// ctx fields used: tabUrl (only when the body matches login_required so
// the message can name the site).
export function prettifyYtdlpError(raw, ctx = {}) {
  const s = String(raw || "").trim();
  if (!s) return "yt-dlp reported an error during the download.";
  // Strip trailing "(exit status N)" for display; the user doesn't
  // benefit from seeing it inline unless nothing else was captured.
  let body = s.replace(/\s*\(exit status \d+\)\s*$/i, "").trim();
  // Also strip leading "ERROR:" / "ERROR: [extractor]" if present —
  // the title already says "Download failed".
  body = body.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/i, "").trim();
  // Canonicalize some common cases so users get advice, not jargon.
  if (/login required|only available for registered users|cookies/i.test(body)) {
    return `Login required. Open the site's options page and set cookies to "Always" for ${detectCurrentSite(ctx.tabUrl) || "this site"}, then retry. (${body})`;
  }
  if (/video unavailable|private video|this video has been removed/i.test(body)) {
    return `The post is private, removed, or unavailable. (${body})`;
  }
  if (/unsupported url/i.test(body)) {
    return "yt-dlp doesn't recognize this URL as a video/photo page. Try opening the media directly on the site.";
  }
  if (/http error 429|rate.?limit/i.test(body)) {
    return "The site rate-limited us. Wait a minute and try again.";
  }
  if (/unable to extract/i.test(body)) {
    return `The site's page layout changed and yt-dlp couldn't find the media. The extractor likely needs updating. (${body})`;
  }
  // "Silent failure" path (host: formatDownloadErr with no stderr AND
  // no stdout leftover): message has the shape
  //   "exit status N — yt-dlp emitted no diagnostic. Invocation: yt-dlp …"
  // Render it as a clear "yt-dlp didn't say why; here's what we ran"
  // so the user can paste the invocation into a shell and see the
  // real error.
  if (/yt-dlp emitted no diagnostic/i.test(body)) {
    return `yt-dlp exited with a non-zero status and didn't say why. Try running the command below in a terminal — the terminal output will show the actual error.\n\n${body.replace(/^.*?Invocation:\s*/i, "")}`;
  }
  // Default: show the yt-dlp error text verbatim.
  if (body === "") {
    return "yt-dlp reported an error during the download.";
  }
  if (/^exit status \d+$/i.test(body)) {
    return `yt-dlp exited with ${body.toLowerCase()} without emitting a diagnostic. Rebuild the native host (go build ./host/cmd/frixtyhost) and retry — the newer build captures stderr and shows the actual error.`;
  }
  return body;
}

// friendlyError translates the host's terse error codes into plain-English
// messages the popup can surface without leaking "exit status 1"-style
// internals. Codes that indicate "there's nothing on this page to
// download" render as informational (blue ℹ) rather than an alarming
// red ✗.
//
// ctx fields used: tabUrl, triedCookies, cookiesMode.
export function friendlyError(msg, ctx = {}) {
  const code = msg.code ?? "";
  const raw = (msg.message ?? "").trim();
  switch (code) {
    case "ytdlp_missing":
      return {
        severity: "error",
        title: "yt-dlp not found",
        detail:
          "The native helper couldn't locate yt-dlp on your system. Reinstall the downloader or make sure yt-dlp is available in your PATH.",
      };
    case "listformats_failed":
    case "no_formats": {
      const site = detectCurrentSite(ctx.tabUrl);
      if (site === "twitter" || site === "youtube") {
        return ageRestrictedError(site, ctx);
      }
      return {
        severity: "info",
        title: "Unable to download",
        detail:
          "Unable to download media on this page. Try a different page or double-check the URL.",
      };
    }
    case "tiktok_no_video_in_url":
      return {
        severity: "err",
        title: "Couldn't identify the video",
        detail:
          "Something went wrong reading the current TikTok post. Refresh the page and try again.",
      };
    case "listformats_timeout":
      return {
        severity: "info",
        title: "Fetching took too long",
        detail:
          "We gave up after 30 seconds waiting for yt-dlp to respond. Check your connection and try again.",
      };
    case "bad_destdir":
      return {
        severity: "error",
        title: "Destination folder issue",
        detail: raw || "The chosen folder is missing or isn't writable.",
      };
    case "picker_failed":
      return {
        severity: "error",
        title: "Couldn't open the Save dialog",
        detail: raw || "The system file dialog failed to open.",
      };
    case "download_failed":
      return {
        severity: "error",
        title: "Download failed",
        detail: prettifyYtdlpError(raw, ctx),
      };
    case "download_canceled":
      return {
        severity: "info",
        title: "Download canceled",
        detail: "",
      };
    case "host_disconnected":
      return {
        severity: "error",
        title: "Native helper disconnected",
        detail: "The background helper quit unexpectedly. Reload the extension and try again.",
      };
    case "update_failed":
      return {
        severity: "error",
        title: "Update failed",
        detail: raw || "yt-dlp couldn't update itself.",
      };
    case "write_failed":
      return {
        severity: "error",
        title: "Couldn't write the file",
        detail: raw || "The file system rejected the write.",
      };
    case "spawn_failed":
      return {
        severity: "error",
        title: "Couldn't start yt-dlp",
        detail: raw || "Launching yt-dlp failed.",
      };
    case "parse_failed":
      return {
        severity: "error",
        title: "Couldn't read yt-dlp output",
        detail: raw || "yt-dlp's output didn't look as expected.",
      };
    case "unknown_job":
      return {
        severity: "error",
        title: "That download is no longer tracked",
        detail: "The job has already finished or was canceled.",
      };
    case "unknown_action":
    case "bad_request":
      return {
        severity: "error",
        title: "Internal error",
        detail: raw || "The popup and the native helper disagree about what to do.",
      };
    default:
      return {
        severity: "error",
        title: "Something went wrong",
        detail: raw || code || "Unknown error.",
      };
  }
}
