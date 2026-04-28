package ytdlp

import (
	"os/exec"
	"sync"
)

// youtubeExtractorArgs returns yt-dlp flags needed to extract YouTube videos
// reliably against current anti-bot measures:
//
//   - a JavaScript runtime (deno or node) is required by modern yt-dlp to
//     decipher signatures and mint PO tokens; without one YouTube fails
//     with "Sign in to confirm you're not a bot" and "Requested format is
//     not available". We auto-detect whichever runtime is on PATH.
//   - the YouTube extractor is nudged to prefer clients that don't need a
//     PO token for mainstream content (tv/tv_embedded/web_safari), with
//     formats=missing_pot as a safety net so yt-dlp still reports formats
//     it suspects might be gated rather than filtering them out entirely.
//
// The extractor-args are scoped to `youtube:...` so they're no-ops for
// Twitter, Reddit, and every other extractor — safe to include on every
// invocation.
func youtubeExtractorArgs() []string {
	args := []string{
		"--extractor-args",
		"youtube:player_client=default,tv_embedded,tv,web_safari,mweb;formats=missing_pot",
	}
	if rt := detectJSRuntime(); rt != "" {
		args = append(args, "--js-runtimes", rt)
	}
	return args
}

var (
	jsRuntimeOnce sync.Once
	jsRuntime     string
)

// detectJSRuntime picks a JS runtime yt-dlp can use, preferring deno
// (yt-dlp's default) and falling back to node. Resolves once per process —
// PATH changes during a host's lifetime are rare enough not to warrant
// repeated lookups.
func detectJSRuntime() string {
	jsRuntimeOnce.Do(func() {
		for _, name := range []string{"deno", "node"} {
			if _, err := exec.LookPath(name); err == nil {
				jsRuntime = name
				return
			}
		}
	})
	return jsRuntime
}
