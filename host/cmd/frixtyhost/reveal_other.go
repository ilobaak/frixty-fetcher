//go:build !windows

package main

import "errors"

// revealSelectWindows is a no-op stub on non-Windows platforms.
// revealInFileManager's switch only invokes it under runtime.GOOS ==
// "windows", so this branch is never actually executed on darwin or
// linux — but the symbol must exist for the cross-compile to succeed.
// macOS uses `open -R` and Linux uses `xdg-open` on the parent dir
// (no system-wide "select file" convention) handled inline in
// revealInFileManager.
func revealSelectWindows(string) error {
	return errors.New("revealSelectWindows: only implemented on Windows")
}
