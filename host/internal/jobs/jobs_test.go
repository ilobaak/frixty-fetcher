package jobs

import (
	"sync"
	"testing"
	"time"
)

func TestCancelFlagsAndInvokes(t *testing.T) {
	tr := New()
	called := 0
	tr.Add("j1", func() { called++ })

	if tr.WasCanceled("j1") {
		t.Fatal("job should not be flagged canceled before Cancel()")
	}
	if !tr.Cancel("j1") {
		t.Fatal("Cancel(known) returned false")
	}
	if called != 1 {
		t.Errorf("cancel func invoked %d times, want 1", called)
	}
	if !tr.WasCanceled("j1") {
		t.Error("WasCanceled(j1) false after Cancel")
	}
}

func TestCancelUnknownJob(t *testing.T) {
	tr := New()
	if tr.Cancel("ghost") {
		t.Error("Cancel(unknown) returned true")
	}
	if tr.WasCanceled("ghost") {
		t.Error("WasCanceled(unknown) true — nothing was ever flagged")
	}
}

// Remove clears both the cancel-func entry AND the canceled flag so a
// reused jobId in a later test run isn't reported as pre-canceled.
func TestRemoveClearsCanceledFlag(t *testing.T) {
	tr := New()
	tr.Add("j2", func() {})
	tr.Cancel("j2")
	if !tr.WasCanceled("j2") {
		t.Fatal("setup: expected j2 to be canceled")
	}
	tr.Remove("j2")
	if tr.WasCanceled("j2") {
		t.Error("WasCanceled(j2) still true after Remove")
	}
}

func TestCancelAllFlagsAllIDs(t *testing.T) {
	tr := New()
	tr.Add("a", func() {})
	tr.Add("b", func() {})
	tr.CancelAll()
	if !tr.WasCanceled("a") || !tr.WasCanceled("b") {
		t.Error("CancelAll should flag every tracked id as canceled")
	}
}

// TestCancelAllReleasesLockBeforeCallback regression-tests the deadlock
// where CancelAll invoked stored cancel funcs while still holding the
// tracker's mutex — any cancel func that called back into Tracker would
// deadlock. We register a cancel func that itself takes the lock (via
// Add) and assert the call returns within a small budget. Pre-fix, this
// hangs forever; post-fix, it completes in microseconds.
func TestCancelAllReleasesLockBeforeCallback(t *testing.T) {
	tr := New()
	var wg sync.WaitGroup
	wg.Add(1)
	tr.Add("a", func() {
		defer wg.Done()
		// Re-enter Tracker from inside the cancel callback. Pre-fix this
		// would block forever because CancelAll still held tr.mu.
		tr.Add("late-arrival", func() {})
	})

	done := make(chan struct{})
	go func() {
		tr.CancelAll()
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("CancelAll deadlocked when a cancel callback re-entered Tracker")
	}
	wg.Wait()
}
