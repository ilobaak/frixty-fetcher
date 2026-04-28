//go:build windows

package main

import (
	"fmt"
	"strings"

	"golang.org/x/sys/windows"
)

// revealSelectWindows opens Explorer at the parent folder with the target
// file highlighted, and gives the new window focus.
//
// Why not exec.Command("explorer", "/select,"+path)? Two problems:
//
//  1. Go's os/exec quotes arguments containing spaces. Explorer's /select,
//     prefix is parsed as part of a single argument token, so the quoting
//     breaks it and Explorer silently opens the user's default folder
//     instead of selecting the target.
//  2. Even with the argument fixed (via SysProcAttr.CmdLine), the spawned
//     explorer.exe hands its request to the already-running Explorer
//     broker process over IPC. The new window belongs to that broker, not
//     our process, so we have no foreground-window right to hand off — the
//     window opens behind whatever the user was looking at.
//
// ShellExecute routes through the shell API, which applies the normal
// focus rules the user expects when opening something from a shortcut or
// Run dialog. We still pass the /select,<path> argv because Explorer
// itself is what interprets that flag.
func revealSelectWindows(path string) error {
	// Refuse path values that would break /select,"<path>" parsing:
	// embedded quotes have no safe escape (Explorer's argv parser is
	// not the same as cmd's), and embedded NULs are unrepresentable in
	// the UTF-16 string we hand to ShellExecute. yt-dlp output paths
	// are filesystem-sanitized so neither character should appear in
	// practice; this is defense in depth.
	if strings.ContainsAny(path, "\"\x00") {
		return fmt.Errorf("path contains characters unsafe for Explorer argv: %q", path)
	}
	verb, err := windows.UTF16PtrFromString("open")
	if err != nil {
		return err
	}
	file, err := windows.UTF16PtrFromString("explorer.exe")
	if err != nil {
		return err
	}
	// Quotes go around the path so Explorer handles spaces; /select, sits
	// outside them so Explorer recognises the flag.
	args, err := windows.UTF16PtrFromString(`/select,"` + path + `"`)
	if err != nil {
		return err
	}
	return windows.ShellExecute(0, verb, file, args, nil, windows.SW_SHOWNORMAL)
}
