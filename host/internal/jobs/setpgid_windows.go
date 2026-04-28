//go:build windows

package jobs

import (
	"os/exec"
	"strconv"
)

// SetProcessGroup is a no-op on Windows. Windows already kills child
// processes via the Job Object machinery when KillFunc invokes
// `taskkill /F /T`, which walks the process tree by parent-PID.
// Provided as a stub so callers can use the same call site
// cross-platform without build tags.
func SetProcessGroup(cmd *exec.Cmd) {}

// killTree on Windows shells out to taskkill /T which kills the whole
// process tree by parent-PID. Same end-state as the unix sibling that
// uses negative-PID kill.
func killTree(cmd *exec.Cmd) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	_ = exec.Command("taskkill", "/F", "/T", "/PID", strconv.Itoa(cmd.Process.Pid)).Run()
}
