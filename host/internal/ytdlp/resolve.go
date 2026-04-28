// Package ytdlp wraps the yt-dlp binary: locating it, listing formats,
// running downloads, parsing progress.
package ytdlp

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/ilobaak/frixty-fetcher/host/internal/updater"
)

// ErrNotFound is returned when no yt-dlp binary can be located.
var ErrNotFound = errors.New("yt-dlp binary not found")

func binaryName() string {
	if runtime.GOOS == "windows" {
		return "yt-dlp.exe"
	}
	return "yt-dlp"
}

// Resolve returns an absolute path to the yt-dlp binary by checking, in order:
//   1. $YTDLP_BIN environment variable (dev override)
//   2. The extension's managed binary under os.UserConfigDir()
//   3. A binary sitting next to the current executable (installer bundle)
//   4. The system PATH
//
// Order matters: the managed binary wins over PATH because the extension
// owns its update cycle and wants to use a known-good version regardless
// of whatever the user has installed system-wide (pip, scoop, homebrew).
func Resolve() (string, error) {
	if p := os.Getenv("YTDLP_BIN"); p != "" {
		if _, err := os.Stat(p); err == nil {
			return p, nil
		}
	}
	if p, err := updater.ManagedBinaryPath(); err == nil && p != "" {
		if _, err := os.Stat(p); err == nil {
			return p, nil
		}
	}
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

// Version returns the yt-dlp version string (`--version` output, trimmed).
func Version(bin string) (string, error) {
	out, err := exec.Command(bin, "--version").Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}
