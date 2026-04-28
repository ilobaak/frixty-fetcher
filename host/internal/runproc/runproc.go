// Package runproc runs subprocesses with bounded stderr/stdout capture.
// Used by the short fire-and-forget invocations (yt-dlp -x, ffmpeg audio
// strip, etc.) that previously hand-rolled three slightly different
// versions of the same "spawn, capture output, format ExitError" loop.
//
// Streaming consumers (yt-dlp's progress parser) still need their own
// setup — see internal/ytdlp.Run for that path.
package runproc

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"sync"

	"github.com/ilobaak/frixty-fetcher/host/internal/jobs"
)

// DefaultStderrCap is enough for the closing ERROR / traceback lines
// from the subprocesses we run. A chatty retry loop can't blow past it
// because TailBuffer drops everything but the last cap bytes.
const DefaultStderrCap = 8 * 1024

// TailBuffer is an io.Writer that retains only the LAST cap bytes
// written. Safe for concurrent writes — both stdout and stderr can be
// wired to the same instance.
type TailBuffer struct {
	mu  sync.Mutex
	cap int
	buf []byte
}

// NewTailBuffer constructs a TailBuffer; cap <= 0 falls back to
// DefaultStderrCap.
func NewTailBuffer(cap int) *TailBuffer {
	if cap <= 0 {
		cap = DefaultStderrCap
	}
	return &TailBuffer{cap: cap}
}

func (t *TailBuffer) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.buf = append(t.buf, p...)
	if over := len(t.buf) - t.cap; over > 0 {
		t.buf = t.buf[over:]
	}
	return len(p), nil
}

// String returns the currently-buffered tail.
func (t *TailBuffer) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return string(t.buf)
}

// RunCaptureTail spawns bin with args under ctx, capturing combined
// stdout+stderr into a tail-bounded buffer (DefaultStderrCap). On
// failure it returns the underlying exec error wrapped with the
// captured tail so callers can surface a meaningful diagnostic instead
// of "exit status 1".
//
// On Unix the spawned process is placed in its own process group so
// ctx-cancel kills the whole tree (ffmpeg children that yt-dlp / our
// own ffmpeg invocations spawn). On Windows the cmd's Process.Kill
// already terminates the tree, so the no-op SetProcessGroup is harmless.
func RunCaptureTail(ctx context.Context, bin string, args ...string) error {
	cmd := exec.CommandContext(ctx, bin, args...)
	jobs.SetProcessGroup(cmd)
	cmd.Cancel = func() error { jobs.KillTree(cmd); return nil }
	tail := NewTailBuffer(DefaultStderrCap)
	cmd.Stdout = tail
	cmd.Stderr = tail
	if err := cmd.Run(); err != nil {
		if t := strings.TrimSpace(tail.String()); t != "" {
			return fmt.Errorf("%w: %s", err, t)
		}
		return err
	}
	return nil
}
