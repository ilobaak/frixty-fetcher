// Path-safety helpers shared across download handlers. Extracted from
// main.go in the sprint-2 decomposition pass.
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const maxPathComponentChars = 150

// joinAlbumDir joins baseDir + user-supplied albumName and guarantees the
// result stays underneath baseDir. Defends against path traversal via
// ../ sequences, absolute paths (Windows drive letters or POSIX roots),
// and NUL-byte injection. Returns (clean joined path, error) — an error
// indicates a rejected name that the caller should refuse (bad_request).
//
// The DESIGN doc has said "host must refuse writes outside destDir" since
// v0, but nobody actually wrote the check until Sprint 0.
func joinAlbumDir(baseDir, albumName string) (string, error) {
	if albumName == "" {
		return baseDir, nil
	}
	if strings.ContainsRune(albumName, 0) {
		return "", fmt.Errorf("albumName contains NUL byte")
	}
	// Reject absolute paths outright — they'd trivially escape baseDir.
	if filepath.IsAbs(albumName) {
		return "", fmt.Errorf("albumName must be relative, got %q", albumName)
	}
	// Clean the baseDir side so the HasPrefix check below isn't fooled
	// by "/home/x/" vs "/home/x" or by "/home/x/." etc.
	cleanBase, err := filepath.Abs(baseDir)
	if err != nil {
		return "", fmt.Errorf("resolve baseDir: %w", err)
	}
	joined := filepath.Clean(filepath.Join(cleanBase, albumName))
	// HasPrefix alone would accept "/home/x-evil" as a prefix of "/home/x" —
	// append the separator to force a real subdirectory relationship.
	sep := string(filepath.Separator)
	if !strings.HasPrefix(joined+sep, cleanBase+sep) {
		return "", fmt.Errorf("albumName %q escapes destDir", albumName)
	}
	rel, err := filepath.Rel(cleanBase, joined)
	if err != nil {
		return "", fmt.Errorf("resolve albumName: %w", err)
	}
	clipped := cleanBase
	for _, part := range splitPathComponents(rel) {
		part = safePathComponent(part, "", false)
		if part == "" {
			continue
		}
		clipped = filepath.Join(clipped, part)
	}
	return clipped, nil
}

func splitPathComponents(path string) []string {
	return strings.FieldsFunc(path, func(r rune) bool {
		return r == '/' || r == '\\'
	})
}

func safeDownloadFilename(name, fallbackExt string) string {
	fallbackExt = strings.TrimPrefix(fallbackExt, ".")
	if fallbackExt != "" {
		fallbackExt = "." + fallbackExt
	}
	return safePathComponent(name, fallbackExt, true)
}

func safePathComponent(name, fallbackExt string, preserveExt bool) string {
	safe := strings.Map(func(r rune) rune {
		switch {
		case r == 0 || r < 32 || r == 127:
			return -1
		case strings.ContainsRune(`\/:*?"<>|`, r):
			return '_'
		default:
			return r
		}
	}, strings.TrimSpace(name))
	safe = strings.Join(strings.Fields(safe), " ")
	safe = strings.TrimRight(safe, ". ")
	if safe == "" {
		safe = "file"
	}

	ext := ""
	stem := safe
	if preserveExt {
		ext = filepath.Ext(safe)
		if ext == "" {
			ext = fallbackExt
		}
		if ext != "" {
			stem = strings.TrimSuffix(safe, filepath.Ext(safe))
		}
	}
	if ext != "" && runeLen(ext) >= maxPathComponentChars {
		ext = ""
	}
	budget := maxPathComponentChars - runeLen(ext)
	if budget < 1 {
		budget = maxPathComponentChars
	}
	if runeLen(stem) > budget {
		stem = strings.TrimRight(clipRunes(stem, budget), ". ")
	}
	if stem == "" {
		stem = "file"
	}
	out := stem + ext
	if isWindowsReservedName(out) {
		out = "_" + out
	}
	if runeLen(out) > maxPathComponentChars {
		if ext != "" && runeLen(ext) < maxPathComponentChars {
			stemBudget := maxPathComponentChars - runeLen(ext)
			out = strings.TrimRight(clipRunes(strings.TrimSuffix(out, ext), stemBudget), ". ") + ext
		} else {
			out = strings.TrimRight(clipRunes(out, maxPathComponentChars), ". ")
		}
	}
	return out
}

func runeLen(s string) int {
	return len([]rune(s))
}

func clipRunes(s string, max int) string {
	rs := []rune(s)
	if len(rs) <= max {
		return s
	}
	return string(rs[:max])
}

func isWindowsReservedName(name string) bool {
	base := strings.TrimSuffix(name, filepath.Ext(name))
	switch strings.ToUpper(base) {
	case "CON", "PRN", "AUX", "NUL",
		"COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
		"LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9":
		return true
	default:
		return false
	}
}

// uniquePath appends "-2", "-3", ... to the stem if the target path is
// already taken, so two gallery items that happen to share a basename
// (rare, but possible with use-original-filenames mode) don't clobber each
// other. Returns the original path when no collision exists.
//
// Two bounded-safety rules:
//
//  1. Only IsNotExist errors mean "this path is available." A permission
//     denied / I/O error surfacing through os.Stat previously looked
//     like "not found" here, and uniquePath would happily return a path
//     the caller can't actually write. Bubble the error up instead.
//  2. Hard cap of uniquePathMaxAttempts so a pathological directory
//     (read-locked, full, or with a million collisions) can't spin the
//     host forever. We give up with an error and the caller sends
//     a download_failed.
const uniquePathMaxAttempts = 10_000

func uniquePath(p string) (string, error) {
	if _, err := os.Stat(p); err != nil {
		if os.IsNotExist(err) {
			return p, nil
		}
		return "", fmt.Errorf("stat %s: %w", p, err)
	}
	dir := filepath.Dir(p)
	base := filepath.Base(p)
	ext := filepath.Ext(base)
	stem := strings.TrimSuffix(base, ext)
	for n := 2; n <= uniquePathMaxAttempts; n++ {
		candidate := filepath.Join(dir, fmt.Sprintf("%s-%d%s", stem, n, ext))
		_, err := os.Stat(candidate)
		if os.IsNotExist(err) {
			return candidate, nil
		}
		if err != nil {
			return "", fmt.Errorf("stat %s: %w", candidate, err)
		}
	}
	return "", fmt.Errorf("uniquePath: gave up after %d attempts at %s", uniquePathMaxAttempts, p)
}
