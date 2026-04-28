package runproc

import (
	"strings"
	"sync"
	"testing"
)

func TestTailBufferKeepsTailUnderCap(t *testing.T) {
	t.Parallel()
	tb := NewTailBuffer(16)
	tb.Write([]byte("hello "))
	tb.Write([]byte("world"))
	if got := tb.String(); got != "hello world" {
		t.Errorf("under-cap Write lost content: %q", got)
	}
}

func TestTailBufferTrimsHeadOverCap(t *testing.T) {
	t.Parallel()
	tb := NewTailBuffer(10)
	tb.Write([]byte("0123456789abcdef"))
	if got := tb.String(); got != "6789abcdef" {
		t.Errorf("over-cap Write kept wrong tail: %q", got)
	}
}

func TestTailBufferMultiWriteCrossesCap(t *testing.T) {
	t.Parallel()
	tb := NewTailBuffer(5)
	tb.Write([]byte("abc"))
	tb.Write([]byte("de"))
	tb.Write([]byte("fgh"))
	if got := tb.String(); got != "defgh" {
		t.Errorf("multi-write tail wrong: %q", got)
	}
}

// Concurrent writes shouldn't race or corrupt the buffer. Only checks
// the final length lies in the expected range — ordering across the
// 20 goroutines is undefined.
func TestTailBufferConcurrentSafe(t *testing.T) {
	t.Parallel()
	tb := NewTailBuffer(4096)
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			tb.Write([]byte(strings.Repeat("x", 50)))
		}()
	}
	wg.Wait()
	if got := tb.String(); len(got) == 0 || len(got) > 4096 {
		t.Errorf("len out of range after concurrent writes: %d", len(got))
	}
}

// NewTailBuffer with cap <= 0 should fall back to the default.
func TestTailBufferDefaultsCap(t *testing.T) {
	t.Parallel()
	tb := NewTailBuffer(0)
	if tb.cap != DefaultStderrCap {
		t.Errorf("expected default cap %d, got %d", DefaultStderrCap, tb.cap)
	}
	tbNeg := NewTailBuffer(-1)
	if tbNeg.cap != DefaultStderrCap {
		t.Errorf("negative cap should fall back to default, got %d", tbNeg.cap)
	}
}
