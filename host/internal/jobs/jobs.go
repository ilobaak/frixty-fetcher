// Package jobs tracks in-flight download work by extension-supplied jobId
// so a cancel request can tear the right one down. The tracker is
// deliberately untyped about *what* it's cancelling: yt-dlp subprocesses
// pass a function that kills the process tree; gallery loops pass a
// context.CancelFunc. Either way Tracker just invokes the stored func.
package jobs

import (
	"os/exec"
	"sync"
)

type Tracker struct {
	mu       sync.Mutex
	m        map[string]func()
	canceled map[string]bool
}

func New() *Tracker {
	return &Tracker{
		m:        make(map[string]func()),
		canceled: make(map[string]bool),
	}
}

// Add registers a cancel function under id. If id already exists, the
// previous entry is replaced (last-writer-wins), which matches the
// "jobId is extension-generated and unique per request" contract.
func (t *Tracker) Add(id string, cancel func()) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.m[id] = cancel
}

func (t *Tracker) Remove(id string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.m, id)
	delete(t.canceled, id)
}

// Cancel invokes the stored cancel func and records that the job was
// cancelled by user request. Returns true if the job was tracked,
// false if no such id exists. Consumers can later call WasCanceled(id)
// to distinguish a user-initiated kill from a natural process failure
// — cmd.Wait() returns an error in both cases.
func (t *Tracker) Cancel(id string) bool {
	t.mu.Lock()
	cancel, ok := t.m[id]
	if ok {
		t.canceled[id] = true
	}
	t.mu.Unlock()
	if !ok {
		return false
	}
	cancel()
	return true
}

// WasCanceled reports whether Cancel was called for this id. Useful
// for distinguishing user-requested kills from real download errors
// in the post-Wait() error-handling path.
func (t *Tracker) WasCanceled(id string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.canceled[id]
}

// CancelAll is called on host shutdown to stop every in-flight job.
//
// Snapshots the cancel funcs under the mutex and invokes them after
// releasing — calling user-supplied callbacks while holding our lock is
// a deadlock waiting to happen. Cancel() got this right (drop the lock
// before the call); CancelAll has to follow the same rule even though
// it's iterating.
func (t *Tracker) CancelAll() {
	t.mu.Lock()
	cancels := make([]func(), 0, len(t.m))
	for id, cancel := range t.m {
		t.canceled[id] = true
		cancels = append(cancels, cancel)
	}
	t.mu.Unlock()
	for _, cancel := range cancels {
		cancel()
	}
}

// KillFunc produces the standard "kill this process tree" callback for
// yt-dlp invocations. yt-dlp spawns ffmpeg as a child; killing only the
// yt-dlp PID would leave ffmpeg orphaned. KillTree reaches the whole
// tree:
//   - Unix: sends SIGKILL to -<pgid>, which requires SetProcessGroup
//     to have run on the cmd before Start() so the child is its own
//     group leader.
//   - Windows: shells out to `taskkill /F /T` which walks the
//     parent-PID tree.
func KillFunc(c *exec.Cmd) func() {
	return func() { KillTree(c) }
}

// KillTree is the exported entry point that other packages call from
// `cmd.Cancel` hooks (so ctx cancellation also kills the subtree, not
// just the parent process).
func KillTree(c *exec.Cmd) { killTree(c) }
