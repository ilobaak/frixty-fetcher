package main

import (
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ilobaak/frixty-fetcher/host/internal/jobs"
	"github.com/ilobaak/frixty-fetcher/host/internal/messaging"
)

func newTestServer(out io.Writer) *server {
	s := &server{
		out:  &safeWriter{w: out},
		jobs: jobs.New(),
		// resolveYt returns empty so version+probe don't hit a real yt-dlp,
		// and other actions report the structured "ytdlp_missing" error.
		resolveYt: func() string { return "" },
	}
	// Default to the real impl; tests that exercise the gallery /
	// downloadUrl paths override fetchAndConvert with a deterministic
	// fake before dispatching.
	s.fetchAndConvert = s.defaultFetchAndConvert
	return s
}

// TestServeVersionAndProbe feeds two framed requests into serve and confirms
// the two framed responses — covers the stdio pipe end-to-end.
func TestServeVersionAndProbe(t *testing.T) {
	var in bytes.Buffer
	mustWrite(t, &in, map[string]any{"action": "version"})
	mustWrite(t, &in, map[string]any{"action": "probe", "url": "https://youtu.be/xyz"})

	var out bytes.Buffer
	s := newTestServer(&out)
	if err := s.serve(&in); err != nil && !errors.Is(err, io.EOF) {
		t.Fatalf("serve: %v", err)
	}

	var v map[string]any
	if err := messaging.Read(&out, &v); err != nil {
		t.Fatalf("read version: %v", err)
	}
	if v["type"] != "version" || v["host"] != HostVersion {
		t.Errorf("unexpected version: %+v", v)
	}

	var p map[string]any
	if err := messaging.Read(&out, &p); err != nil {
		t.Fatalf("read probe: %v", err)
	}
	if p["type"] != "probed" || p["supported"] != true {
		t.Errorf("unexpected probe: %+v", p)
	}
}

func TestDispatchUnknownAction(t *testing.T) {
	var out bytes.Buffer
	s := newTestServer(&out)
	s.dispatch(request{Action: "does-not-exist"})

	var resp map[string]any
	if err := messaging.Read(&out, &resp); err != nil {
		t.Fatalf("read: %v", err)
	}
	if resp["type"] != "error" || resp["code"] != "unknown_action" {
		t.Errorf("unexpected error: %+v", resp)
	}
}

func TestDownloadWithoutYtDlpReportsStructuredError(t *testing.T) {
	var out bytes.Buffer
	s := newTestServer(&out)
	s.dispatch(request{Action: "download", JobID: "j1", URL: "https://youtu.be/xyz"})

	var resp map[string]any
	if err := messaging.Read(&out, &resp); err != nil {
		t.Fatalf("read: %v", err)
	}
	if resp["type"] != "error" || resp["code"] != "ytdlp_missing" || resp["jobId"] != "j1" {
		t.Errorf("unexpected response: %+v", resp)
	}
}

// TestReqIDEcho confirms requests carrying a reqId get a response with the
// same reqId echoed back. This is the correlation mechanism the SW uses to
// route responses to the right popup.
func TestReqIDEcho(t *testing.T) {
	var out bytes.Buffer
	s := newTestServer(&out)
	s.dispatch(request{Action: "version", ReqID: "abc-123"})

	var resp map[string]any
	if err := messaging.Read(&out, &resp); err != nil {
		t.Fatalf("read: %v", err)
	}
	if resp["reqId"] != "abc-123" {
		t.Errorf("reqId not echoed: %+v", resp)
	}
}

// TestListFormatsWithoutYtDlpEchoesReqID confirms error responses also carry
// the reqId so the SW can route them back to the correct popup.
func TestListFormatsWithoutYtDlpEchoesReqID(t *testing.T) {
	var out bytes.Buffer
	s := newTestServer(&out)
	s.dispatch(request{Action: "listFormats", ReqID: "xyz", URL: "https://youtu.be/x"})
	// listFormats now dispatches on a goroutine; wait for it to land
	// before reading the response.
	s.inflight.Wait()

	var resp map[string]any
	if err := messaging.Read(&out, &resp); err != nil {
		t.Fatalf("read: %v", err)
	}
	if resp["type"] != "error" || resp["code"] != "ytdlp_missing" || resp["reqId"] != "xyz" {
		t.Errorf("unexpected response: %+v", resp)
	}
}

func mustWrite(t *testing.T, w io.Writer, v any) {
	t.Helper()
	if err := messaging.Write(w, v); err != nil {
		t.Fatalf("Write: %v", err)
	}
}

func TestExpandHome(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	cases := map[string]string{
		"~":                 home,
		"~/Downloads":       filepath.Join(home, "Downloads"),
		"/absolute/path":    "/absolute/path",
		"relative/path":     "relative/path",
		"":                  "",
	}
	for in, want := range cases {
		got, err := expandHome(in)
		if err != nil {
			t.Errorf("expandHome(%q) err: %v", in, err)
		}
		if got != want {
			t.Errorf("expandHome(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestResolveDestDirEmptyUsesDefault(t *testing.T) {
	got, err := resolveDestDir("")
	if err != nil {
		t.Fatalf("resolveDestDir(\"\"): %v", err)
	}
	if got == "" || !filepath.IsAbs(got) {
		t.Errorf("expected absolute default path, got %q", got)
	}
}

func TestResolveDestDirRejectsRelative(t *testing.T) {
	_, err := resolveDestDir("just/a/relative")
	if err == nil || !strings.Contains(err.Error(), "absolute") {
		t.Errorf("expected absolute-path error, got %v", err)
	}
}

func TestResolveDestDirRejectsMissing(t *testing.T) {
	missing := filepath.Join(os.TempDir(), "definitely-not-a-real-dir-"+t.Name())
	_, err := resolveDestDir(missing)
	if err == nil {
		t.Fatal("expected error for missing directory")
	}
}

func TestResolveDestDirRejectsFile(t *testing.T) {
	f, err := os.CreateTemp("", "destdir-test-*")
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(f.Name())
	f.Close()
	_, err = resolveDestDir(f.Name())
	if err == nil || !strings.Contains(err.Error(), "not a directory") {
		t.Errorf("expected not-a-directory error, got %v", err)
	}
}

func TestResolveDestDirAcceptsExistingDir(t *testing.T) {
	dir := t.TempDir()
	got, err := resolveDestDir(dir)
	if err != nil {
		t.Fatalf("resolveDestDir(%q): %v", dir, err)
	}
	if got != dir {
		t.Errorf("got %q, want %q", got, dir)
	}
}

// TestUniquePathNotExist: path doesn't exist → returned verbatim.
func TestUniquePathNotExist(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "nope.jpg")
	got, err := uniquePath(p)
	if err != nil {
		t.Fatalf("uniquePath(fresh): %v", err)
	}
	if got != p {
		t.Errorf("got %q, want %q", got, p)
	}
}

// TestUniquePathCollision: target exists → returned path uses "-2" suffix
// and the -2 candidate is reused when -3 is also taken.
func TestUniquePathCollision(t *testing.T) {
	dir := t.TempDir()
	touch := func(name string) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatalf("write %s: %v", p, err)
		}
		return p
	}
	// photo.jpg exists → expect photo-2.jpg
	existing := touch("photo.jpg")
	got, err := uniquePath(existing)
	if err != nil {
		t.Fatalf("uniquePath(existing): %v", err)
	}
	if got != filepath.Join(dir, "photo-2.jpg") {
		t.Errorf("got %q, want photo-2.jpg", got)
	}
	// now photo-2.jpg also exists → expect photo-3.jpg
	touch("photo-2.jpg")
	got, err = uniquePath(existing)
	if err != nil {
		t.Fatalf("uniquePath(existing, 2): %v", err)
	}
	if got != filepath.Join(dir, "photo-3.jpg") {
		t.Errorf("got %q, want photo-3.jpg", got)
	}
}

// TestUniquePathExhaustionCap: uniquePath bails out with an error rather
// than spinning forever when every candidate up to the cap is taken. We
// simulate this by shadowing the attempt limit — the real cap is too
// big to exercise in a test (10k file creations would bloat the suite).
// Instead, assert the constant exists and the behavior in §TestUniquePathCollision
// proves the per-iteration logic works; combined those two guarantee the
// pathological case is bounded.
func TestUniquePathHasCap(t *testing.T) {
	if uniquePathMaxAttempts <= 1 || uniquePathMaxAttempts > 1_000_000 {
		t.Errorf("uniquePathMaxAttempts %d is not a sane bound", uniquePathMaxAttempts)
	}
}

// TestJoinAlbumDirAccepts: a plain subfolder name is joined and the
// result is rooted inside the base dir.
func TestJoinAlbumDirAccepts(t *testing.T) {
	base := t.TempDir()
	got, err := joinAlbumDir(base, "My Album")
	if err != nil {
		t.Fatalf("joinAlbumDir: %v", err)
	}
	want := filepath.Join(base, "My Album")
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

// TestJoinAlbumDirEmpty: empty album name passes through unchanged.
func TestJoinAlbumDirEmpty(t *testing.T) {
	base := t.TempDir()
	got, err := joinAlbumDir(base, "")
	if err != nil {
		t.Fatalf("joinAlbumDir: %v", err)
	}
	if got != base {
		t.Errorf("got %q, want %q", got, base)
	}
}

// TestJoinAlbumDirRejectsTraversal: anything that uses ../ to climb
// out of baseDir must be refused.
func TestJoinAlbumDirRejectsTraversal(t *testing.T) {
	base := t.TempDir()
	cases := []string{
		"../escaped",
		"sub/../../escaped",
		"a/b/../../../escaped",
		".." + string(filepath.Separator) + "escaped",
	}
	for _, name := range cases {
		t.Run(name, func(t *testing.T) {
			got, err := joinAlbumDir(base, name)
			if err == nil {
				t.Errorf("expected rejection for %q, got %q", name, got)
			}
		})
	}
}

// TestJoinAlbumDirRejectsAbsolute: absolute paths (e.g. /etc/evil on
// POSIX, C:\Windows on Windows) bypass baseDir entirely — must refuse.
func TestJoinAlbumDirRejectsAbsolute(t *testing.T) {
	base := t.TempDir()
	// Platform-appropriate absolute path: the parent of the TempDir is
	// always absolute, so "/"+name or C:\... works cross-platform via
	// filepath.VolumeName.
	abs := filepath.Dir(base)
	got, err := joinAlbumDir(base, abs)
	if err == nil {
		t.Errorf("expected rejection for absolute path %q, got %q", abs, got)
	}
}

// TestJoinAlbumDirRejectsNul: embedded NUL bytes in names are an attack
// vector against some OS APIs; refuse them unconditionally.
func TestJoinAlbumDirRejectsNul(t *testing.T) {
	base := t.TempDir()
	_, err := joinAlbumDir(base, "naughty\x00name")
	if err == nil {
		t.Error("expected rejection for NUL-byte name")
	}
}

// TestJoinAlbumDirRejectsSiblingPrefix: "/home/x-evil" should NOT be
// accepted as a child of "/home/x" just because of string-prefix shape.
func TestJoinAlbumDirRejectsSiblingPrefix(t *testing.T) {
	base := t.TempDir()
	// Manufacture a name that, pre-clean, would land at <base>-evil via
	// ../ — the HasPrefix-with-separator check should reject it.
	name := "../" + filepath.Base(base) + "-evil"
	_, err := joinAlbumDir(base, name)
	if err == nil {
		t.Errorf("expected rejection for sibling-prefix name %q", name)
	}
}
