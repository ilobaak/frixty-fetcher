// Package hostlog routes the host's log output to a file alongside its
// stderr. Chrome captures stderr from native messaging hosts, but Chrome
// hides it behind a developer flag the user shouldn't have to learn —
// when a user reports "it doesn't work", we want them to attach a log
// file they can find on disk.
//
// Path: <UserConfigDir>/frixty-fetcher/frixtyhost.log. Same directory
// as updater.json so all of the host's per-user state lives together.
//
// Size discipline: the file is allowed to grow up to MaxBytes; once it
// exceeds that, the next Open call truncates to the LAST KeepBytes by
// rewriting the file. Simple, no separate rotation files, no rename
// dance, no third-party dependency. KeepBytes < MaxBytes by design so
// repeated trims don't immediately re-trim.
package hostlog

import (
	"io"
	"log"
	"os"
	"path/filepath"
)

const (
	// MaxBytes — when the log file's pre-write size is above this,
	// trim before opening for append. 1 MiB is enough for thousands of
	// download events; the host is not chatty.
	MaxBytes = 1 << 20
	// KeepBytes — bytes retained after a trim. Must be strictly less
	// than MaxBytes so a single trim drops repeated overhead.
	KeepBytes = 512 << 10
)

// Open returns a writer that fans log lines to both the OS stderr (so
// `chrome://extensions` → Inspect service worker still shows them) and
// to the on-disk log file. The returned closer should be deferred from
// main() so the file handle is released on host shutdown.
//
// If the on-disk file can't be opened (rare — disk full, dir unwritable),
// Open falls back to stderr-only and returns a no-op closer plus the
// underlying error so main() can decide whether to surface it. The host
// stays usable either way.
func Open() (io.Writer, io.Closer, error) {
	path, err := defaultLogPath()
	if err != nil {
		return os.Stderr, noopCloser{}, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return os.Stderr, noopCloser{}, err
	}
	if info, err := os.Stat(path); err == nil && info.Size() > MaxBytes {
		_ = trimToTail(path, KeepBytes)
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return os.Stderr, noopCloser{}, err
	}
	return io.MultiWriter(os.Stderr, f), f, nil
}

// Wire installs the writer Open returned as log's default destination.
// Convenience wrapper for callers that just want "log.Printf goes to
// the file too" without managing the writer themselves.
func Wire() io.Closer {
	w, c, err := Open()
	if err != nil {
		// Fall back to stderr-only on disk failure; report once so the
		// problem is visible in the SW console.
		log.SetOutput(os.Stderr)
		log.Printf("hostlog: file unavailable, stderr-only: %v", err)
		return c
	}
	log.SetOutput(w)
	return c
}

func defaultLogPath() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil || base == "" {
		return "", err
	}
	return filepath.Join(base, "frixty-fetcher", "frixtyhost.log"), nil
}

// trimToTail rewrites path with the LAST keep bytes of its content,
// dropping anything earlier. Used to bound log growth without keeping
// rotated files around. Best-effort: any error leaves the original
// file untouched so callers can still append.
func trimToTail(path string, keep int) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	size := info.Size()
	if size <= int64(keep) {
		return nil
	}
	if _, err := f.Seek(size-int64(keep), io.SeekStart); err != nil {
		return err
	}
	tail, err := io.ReadAll(f)
	if err != nil {
		return err
	}
	// O_TRUNC writes the new content from byte 0; the old prefix is
	// dropped. Close the read handle first so Windows lets us overwrite.
	f.Close()
	return os.WriteFile(path, tail, 0o644)
}

type noopCloser struct{}

func (noopCloser) Close() error { return nil }
