// Package ffmpeg locates the ffmpeg binary and runs the small post-
// processing steps we need for gallery items when yt-dlp isn't involved
// (video-only extraction from a direct mp4 URL).
package ffmpeg

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"

	"github.com/ilobaak/frixty-fetcher/host/internal/runproc"
)

// ErrNotFound is returned when no ffmpeg binary can be located.
var ErrNotFound = errors.New("ffmpeg binary not found")

func binaryName() string {
	if runtime.GOOS == "windows" {
		return "ffmpeg.exe"
	}
	return "ffmpeg"
}

// Resolve returns an absolute path to ffmpeg. Order of preference:
//  1. $FFMPEG_BIN (dev override)
//  2. A sibling of the current executable (installer bundles ffmpeg next
//     to frixtyhost)
//  3. The system PATH
//
// PATH is last so the installer's pinned ffmpeg wins over whatever the
// user may have dragged onto PATH with a different, incompatible version.
func Resolve() (string, error) {
	// Intentionally no env-var plumbing yet — add if needed.
	if self, err := os.Executable(); err == nil {
		sibling := filepath.Join(filepath.Dir(self), binaryName())
		if _, err := os.Stat(sibling); err == nil {
			return sibling, nil
		}
	}
	if p, err := exec.LookPath(binaryName()); err == nil {
		return p, nil
	}
	return "", ErrNotFound
}

// StripAudio runs `ffmpeg -i in -c copy -an out` — no re-encode, just
// drops the audio track(s). Used for the Kind=video path on items we
// already downloaded directly.
//
// -y overwrites the target if it already exists (our caller writes to
// a .partial path; overwriting a stale one is fine). -hide_banner +
// -loglevel error keep stderr short for error surfacing.
func StripAudio(ctx context.Context, bin, in, out string) error {
	return runproc.RunCaptureTail(ctx, bin,
		"-y", "-hide_banner", "-loglevel", "error",
		"-i", in,
		"-c", "copy", "-an",
		out,
	)
}

// ExtractAudio runs `ffmpeg -i in -vn -c:a copy out` — lossless audio
// extraction when the container already holds m4a-compatible audio
// (AAC). Used only in the "no yt-dlp support" fallback; the normal
// Kind=audio path routes through yt-dlp -x so we get format coercion
// for free.
func ExtractAudio(ctx context.Context, bin, in, out string) error {
	return runproc.RunCaptureTail(ctx, bin,
		"-y", "-hide_banner", "-loglevel", "error",
		"-i", in,
		"-vn", "-c:a", "copy",
		out,
	)
}

func BuildExtractFrameArgs(timestamp float64, in, out string) []string {
	return []string{
		"-y", "-hide_banner", "-loglevel", "error",
		"-ss", fmt.Sprintf("%.3f", timestamp),
		"-i", in,
		"-frames:v", "1",
		out,
	}
}

func ExtractFrame(ctx context.Context, bin string, timestamp float64, in, out string) error {
	if timestamp < 0 {
		return fmt.Errorf("timestamp must be non-negative")
	}
	return runproc.RunCaptureTail(ctx, bin, BuildExtractFrameArgs(timestamp, in, out)...)
}
