//go:build !windows

package jobs

import (
	"os/exec"
	"syscall"
)

// SetProcessGroup makes cmd start its own process group on Unix. yt-dlp
// spawns ffmpeg as a child; without this, killing the yt-dlp PID leaves
// ffmpeg orphaned. With Setpgid set we can later kill -<pgid> to take
// down the whole tree.
//
// Must be called BEFORE cmd.Start(). Idempotent — overwriting an
// existing SysProcAttr would clobber other settings, so we set fields
// individually instead of replacing the struct.
func SetProcessGroup(cmd *exec.Cmd) {
	if cmd == nil {
		return
	}
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setpgid = true
}

// killTree kills the entire process group started by cmd. On Unix this
// is a SIGKILL to -<pgid>; on Windows it falls back to taskkill /T (in
// the windows-build sibling of this file).
func killTree(cmd *exec.Cmd) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	// Negative PID = kill the whole group with that PGID. Setpgid
	// above made the child its own group leader, so PID == PGID.
	if err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL); err != nil {
		// Fall back to killing just the parent — better than nothing
		// if the group syscall failed (process already exited, etc.).
		_ = cmd.Process.Kill()
	}
}
