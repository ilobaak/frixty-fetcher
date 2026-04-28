package ytdlp

import (
	"strings"
	"testing"
)

func TestBuildFormatExpr(t *testing.T) {
	cases := []struct {
		sel  Selection
		want string
	}{
		{Selection{Kind: "combined"}, "bestvideo+bestaudio/best"},
		{Selection{Kind: "combined", Height: 720}, "bestvideo[height<=720]+bestaudio/best[height<=720]"},
		{Selection{Kind: "video"}, "bestvideo/best"},
		{Selection{Kind: "video", Height: 1080}, "bestvideo[height<=1080]/best[height<=1080]"},
		{Selection{Kind: "audio"}, "bestaudio/best"},
		{Selection{}, "bestvideo+bestaudio/best"}, // default = combined
	}
	for _, c := range cases {
		if got := buildFormatExpr(c.sel); got != c.want {
			t.Errorf("buildFormatExpr(%+v) = %q, want %q", c.sel, got, c.want)
		}
	}
}

func TestBuildArgsDirMode(t *testing.T) {
	args := BuildArgs(Selection{Kind: "combined"}, "C:\\tmp", "", "https://youtu.be/x", "", "")
	joined := strings.Join(args, " ")
	for _, must := range []string{
		"--progress-template",
		"[YTDP]",
		"after_move:[YTDP-DONE]",
		"-f",
		"-P",
		"C:\\tmp",
		"-o",
		"%(title)s.%(ext)s",
		"https://youtu.be/x",
	} {
		if !strings.Contains(joined, must) {
			t.Errorf("BuildArgs dir mode missing %q in: %v", must, args)
		}
	}
}

func TestBuildArgsOutputModeOverridesDestDir(t *testing.T) {
	// When the user picked a full path via Save As, -P must not be emitted;
	// destDir is ignored in favor of the absolute -o path.
	args := BuildArgs(Selection{Kind: "combined"}, "C:\\ignored", "C:\\Users\\x\\Videos\\My Vid.mp4", "https://youtu.be/x", "", "")
	joined := strings.Join(args, " ")
	if strings.Contains(joined, "-P") {
		t.Errorf("expected no -P when output is set: %v", args)
	}
	// The user's ".mp4" extension is replaced with "%(ext)s" so yt-dlp
	// writes the file with whatever container the merger actually
	// produced — single clean extension, no "My Vid.mp4.mkv" double-
	// extension surprise. The directory + stem must round-trip intact.
	if !strings.Contains(joined, "-o C:\\Users\\x\\Videos\\My Vid.%(ext)s") {
		t.Errorf("expected user's .mp4 ext stripped + %%(ext)s template: %v", args)
	}
	if strings.Contains(joined, "My Vid.mp4") {
		t.Errorf("user's literal .mp4 must not survive in the -o argument: %v", args)
	}
}

// TestBuildArgsStripsKnownContainerExt covers the "Video.mp4.mkv" fix.
// When the user's Save As path ends in a video container yt-dlp would
// recognise as a literal template suffix (mp4 / mkv / webm / mov),
// strip it and replace with %(ext)s so yt-dlp picks the actual
// container ext for the file. The user's quality / codec preference
// is NOT constrained — yt-dlp keeps best-quality stream selection;
// the rule is purely about producing a single clean extension.
//
// Path-internal dots ("my.folder") and unrecognised extensions
// ("v.foo") pass through unchanged so the user's literal request
// reaches yt-dlp.
func TestBuildArgsStripsKnownContainerExt(t *testing.T) {
	cases := []struct {
		name     string
		output   string
		wantTmpl string
	}{
		{"mp4 path", "C:\\Users\\x\\v.mp4", "C:\\Users\\x\\v.%(ext)s"},
		{"mkv path", "/home/x/v.mkv", "/home/x/v.%(ext)s"},
		{"webm path", "/home/x/v.webm", "/home/x/v.%(ext)s"},
		{"upper-case ext", "C:\\Users\\x\\v.MP4", "C:\\Users\\x\\v.%(ext)s"},
		{"unknown ext passes through", "/home/x/v.foo", "/home/x/v.foo"},
		{"no ext passes through", "/home/x/v", "/home/x/v"},
		{"path-internal dots only", "C:\\my.folder\\subdir\\video", "C:\\my.folder\\subdir\\video"},
		{"trailing dot", "/home/x/v.", "/home/x/v."},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			args := BuildArgs(Selection{Kind: "combined"}, "", tc.output, "https://x", "", "")
			joined := strings.Join(args, " ")
			if !strings.Contains(joined, "-o "+tc.wantTmpl+" ") {
				t.Errorf("for input %q, expected -o %q in args: %v", tc.output, tc.wantTmpl, args)
			}
			// The fix should NOT pull in --merge-output-format any
			// more — that path was the v1 attempt that lost top
			// quality on YouTube. Make sure we don't regress.
			if strings.Contains(joined, "--merge-output-format") {
				t.Errorf("--merge-output-format should not be set for %q: %v", tc.output, args)
			}
		})
	}
}

func TestBuildArgsCookiesFlag(t *testing.T) {
	args := BuildArgs(Selection{Kind: "combined"}, "C:\\tmp", "", "https://youtu.be/x", "C:\\tmp\\cookies.txt", "")
	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "--cookies C:\\tmp\\cookies.txt") {
		t.Errorf("non-empty cookiesFile should inject --cookies <path>: %v", args)
	}
	// Empty cookiesFile = no flag.
	args = BuildArgs(Selection{Kind: "combined"}, "C:\\tmp", "", "https://youtu.be/x", "", "")
	if strings.Contains(strings.Join(args, " "), "--cookies") {
		t.Errorf("empty cookiesFile should NOT inject cookies flag: %v", args)
	}
}

// TestBuildArgsIncludeSubs covers the explicit on/off subtitle behaviour.
// Default (IncludeSubs false) MUST emit --no-write-subs so a system-
// level yt-dlp config can't sneak captions into the download. The user
// only ever gets a .vtt when they tick the box.
func TestBuildArgsIncludeSubs(t *testing.T) {
	defaultSel := Selection{Kind: "combined"}
	args := BuildArgs(defaultSel, "C:\\tmp", "", "https://youtu.be/x", "", "")
	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "--no-write-subs") {
		t.Errorf("default selection must include --no-write-subs to suppress config defaults: %v", args)
	}
	if !strings.Contains(joined, "--no-write-auto-subs") {
		t.Errorf("default selection must include --no-write-auto-subs: %v", args)
	}
	if strings.Contains(joined, "--write-subs ") || strings.HasSuffix(joined, "--write-subs") {
		t.Errorf("default selection must NOT include affirmative --write-subs: %v", args)
	}

	withSubs := Selection{Kind: "combined", IncludeSubs: true}
	args = BuildArgs(withSubs, "C:\\tmp", "", "https://youtu.be/x", "", "")
	joined = strings.Join(args, " ")
	if !strings.Contains(joined, "--write-subs") || strings.Contains(joined, "--no-write-subs") {
		t.Errorf("IncludeSubs=true must enable --write-subs (without --no-): %v", args)
	}
	if !strings.Contains(joined, "--write-auto-subs") || strings.Contains(joined, "--no-write-auto-subs") {
		t.Errorf("IncludeSubs=true must enable --write-auto-subs: %v", args)
	}
}
