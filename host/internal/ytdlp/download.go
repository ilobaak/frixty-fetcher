package ytdlp

import (
	"context"
	"fmt"
	"os/exec"
	"strconv"
	"strings"

	"github.com/ilobaak/frixty-fetcher/host/internal/jobs"
	"github.com/ilobaak/frixty-fetcher/host/internal/runproc"
)

// Selection is the format choice the extension sends with a download request.
type Selection struct {
	Kind      string `json:"kind"`                // "video" | "audio" | "combined"
	Height    int    `json:"height,omitempty"`    // max height for video/combined; 0 = no cap
	Container string `json:"container,omitempty"` // future: "mp4", "mkv", ...
	// IncludeSubs requests yt-dlp to write subtitle / caption files
	// (.vtt) alongside the video. False (default) explicitly suppresses
	// subs via --no-write-subs so a yt-dlp config or extractor default
	// can't sneak a .vtt past the user. When the source has no
	// subtitles, yt-dlp skips silently — no error, no crash.
	IncludeSubs bool `json:"includeSubs,omitempty"`
}

// BuildArgs returns the yt-dlp argv for a given selection, destination, and URL.
// It does NOT invoke yt-dlp — it just decides the flags, making the logic
// unit-testable without a yt-dlp binary.
//
// When output is empty, yt-dlp's output filename is the default
// %(title)s.%(ext)s template inside destDir. When output is non-empty (e.g.
// an absolute path the user typed into a Save As dialog), it is passed to
// yt-dlp's -o verbatim and destDir is ignored — yt-dlp writes exactly there.
//
// When cookiesFile is a non-empty path, --cookies <path> is injected so
// yt-dlp runs as the authenticated session whose cookies the extension
// exported via chrome.cookies.getAll.
func BuildArgs(sel Selection, destDir, output, url, cookiesFile, filenameTemplate string) []string {
	format := buildFormatExpr(sel)
	args := []string{
		// --progress is load-bearing: without it, --progress-template's
		// output is suppressed, so our parser never sees intermediate
		// frames and the popup's bar only moves to 100 % when the download
		// finishes (via the done line). --newline makes each frame a
		// complete line rather than a \r-overwritten one so bufio.Scanner
		// can pick them up.
		"--progress",
		"--newline",
		"--no-colors",
		"--no-warnings",
		"--no-playlist",
		"--progress-template", progressPrefix + "%(progress)j",
		"--print", "after_move:" + donePrefix + "%(filepath)s",
		"-f", format,
	}
	// Subtitles: explicit on/off, never default. If the user opted in
	// we ask for both explicit + auto-generated tracks; if they didn't
	// we pass the negative form so a system-level yt-dlp config can't
	// override it. yt-dlp's behaviour on a video with no subs available
	// is to skip silently (no error) — that's the no-crash promise.
	if sel.IncludeSubs {
		args = append(args, "--write-subs", "--write-auto-subs")
	} else {
		args = append(args, "--no-write-subs", "--no-write-auto-subs")
	}
	args = append(args, youtubeExtractorArgs()...)
	if cookiesFile != "" {
		args = append(args, "--cookies", cookiesFile)
	}
	if output != "" {
		// User-supplied output path (Save As dialog) may carry an
		// extension like ".mp4". yt-dlp would treat that as literal
		// text in the output template and APPEND its merger's chosen
		// container, producing "Video.mp4.mkv" when separate streams
		// merge into mkv. Strip any recognised video container
		// extension and replace with "%(ext)s" so yt-dlp emits a
		// single clean extension that reflects the actual container.
		// The user's chosen extension is treated as a hint, not a
		// constraint — yt-dlp keeps free rein to pick the best
		// quality streams (which may land in webm/mkv for VP9/AV1
		// or mp4 for h264) and the file is named accordingly.
		args = append(args, "-o", outputTemplate(output), url)
		return args
	}
	if destDir != "" {
		args = append(args, "-P", destDir)
	}
	tmpl := filenameTemplate
	if tmpl == "" {
		tmpl = "%(title)s.%(ext)s"
	}
	args = append(args, "-o", tmpl, url)
	return args
}

// outputTemplate prepares the user's Save As path for yt-dlp's -o
// flag. When the path ends in a recognised video-container extension
// (mp4, mkv, webm, mov), the extension is stripped and replaced with
// "%(ext)s" so yt-dlp's template engine writes the actual container
// extension instead of appending one. Anything else passes through
// unchanged — yt-dlp will treat it as a literal template and the
// caller decides whether that's appropriate.
//
// Path-internal dots (e.g. "C:\my.folder\subdir\video") are not
// mistaken for an extension because we only look past the last path
// separator.
func outputTemplate(p string) string {
	sep := strings.LastIndexAny(p, `/\`)
	dot := strings.LastIndex(p, ".")
	if dot <= sep || dot == len(p)-1 {
		return p
	}
	ext := strings.ToLower(p[dot+1:])
	switch ext {
	case "mp4", "mkv", "webm", "mov":
		return p[:dot] + ".%(ext)s"
	}
	return p
}

func buildFormatExpr(sel Selection) string {
	switch sel.Kind {
	case "audio":
		return "bestaudio/best"
	case "video":
		if sel.Height > 0 {
			return fmt.Sprintf("bestvideo[height<=%d]/best[height<=%d]", sel.Height, sel.Height)
		}
		return "bestvideo/best"
	case "combined":
		fallthrough
	default:
		if sel.Height > 0 {
			h := strconv.Itoa(sel.Height)
			return "bestvideo[height<=" + h + "]+bestaudio/best[height<=" + h + "]"
		}
		return "bestvideo+bestaudio/best"
	}
}

// Run starts yt-dlp with the given argv and streams progress via onProgress.
// The returned *exec.Cmd is already started; callers should Wait() on it and
// may Kill() to cancel. finalPath is available after Wait() returns.
//
// On Unix the spawned process is placed in its own process group so a
// cancel reaches the whole tree (yt-dlp + the ffmpeg children it spawns
// for muxing). On Windows the same intent is honored by jobs.KillTree
// (taskkill /T). cmd.Cancel hooks the ctx-cancel path through the same
// killer so context-driven shutdowns reach children too.
func Run(ctx context.Context, bin string, args []string, onProgress func(Progress)) (*exec.Cmd, *DownloadResult, error) {
	cmd := exec.CommandContext(ctx, bin, args...)
	jobs.SetProcessGroup(cmd)
	cmd.Cancel = func() error { jobs.KillTree(cmd); return nil }
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, nil, err
	}
	// Capture stderr into a bounded ring buffer so we can surface the
	// actual ERROR line on failure. yt-dlp's --no-warnings keeps noise
	// down already; the remainder is almost always signal.
	tail := runproc.NewTailBuffer(0) // 0 = DefaultStderrCap (8 KiB)
	cmd.Stderr = tail
	if err := cmd.Start(); err != nil {
		return nil, nil, err
	}
	result := &DownloadResult{stderr: tail, parseDone: make(chan struct{})}
	go func() {
		defer close(result.parseDone)
		result.FinalPath, result.StdoutLeftover, result.ParseErr = ParseStream(stdout, onProgress)
	}()
	return cmd, result, nil
}

// DownloadResult is populated by the goroutine parsing yt-dlp's stdout.
// Callers MUST invoke Wait() (or block on ParseDone) after the cmd's own
// Wait returns; cmd.Wait() only synchronizes with the process, not with the
// parser goroutine, so reading FinalPath/ParseErr/StdoutLeftover before the
// parser drains stdout is a data race even if it happens to work because
// the kernel closes the pipe before the goroutine returns.
type DownloadResult struct {
	FinalPath      string
	ParseErr       error
	StdoutLeftover string // non-progress stdout lines, bounded
	stderr         *runproc.TailBuffer
	parseDone      chan struct{}
}

// Wait blocks until the stdout-parser goroutine spawned by Run has stored
// its final values. After Wait returns, FinalPath/ParseErr/StdoutLeftover
// are safe to read. Idempotent — additional calls are no-ops because the
// parseDone channel stays closed.
func (r *DownloadResult) Wait() {
	if r == nil || r.parseDone == nil {
		return
	}
	<-r.parseDone
}

// Stderr returns the tail of yt-dlp's stderr captured during the run.
// Safe to call after Wait().
func (r *DownloadResult) Stderr() string {
	if r == nil || r.stderr == nil {
		return ""
	}
	return r.stderr.String()
}

