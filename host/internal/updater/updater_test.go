package updater

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestShouldAutoCheckFirstLaunch(t *testing.T) {
	u := NewForTest(filepath.Join(t.TempDir(), "state.json"), time.Hour)
	if !u.ShouldAutoCheck() {
		t.Fatal("first launch with no state should want to auto-check")
	}
}

func TestShouldAutoCheckThrottle(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	u := NewForTest(path, time.Hour)
	// Write a state that says we checked just now — throttle should suppress.
	if err := u.saveState(State{LastCheckUnix: time.Now().Unix()}); err != nil {
		t.Fatal(err)
	}
	if u.ShouldAutoCheck() {
		t.Fatal("expected throttle to suppress auto-check")
	}
}

func TestShouldAutoCheckExpiredThrottle(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	u := NewForTest(path, time.Hour)
	// State from 2 hours ago, interval is 1 hour → should check again.
	past := time.Now().Add(-2 * time.Hour).Unix()
	if err := u.saveState(State{LastCheckUnix: past}); err != nil {
		t.Fatal(err)
	}
	if !u.ShouldAutoCheck() {
		t.Fatal("expected expired throttle to allow auto-check")
	}
}

func TestLoadStateMissingFile(t *testing.T) {
	u := NewForTest(filepath.Join(t.TempDir(), "does-not-exist.json"), time.Hour)
	s, err := u.LoadState()
	if err != nil {
		t.Fatalf("LoadState on missing file should return zero state, nil err: %v", err)
	}
	if s.LastCheckUnix != 0 {
		t.Errorf("expected zero state, got %+v", s)
	}
}

func TestSaveLoadRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	u := NewForTest(path, time.Hour)
	orig := State{LastCheckUnix: 1_700_000_000, LastVersion: "2026.02.04"}
	if err := u.saveState(orig); err != nil {
		t.Fatal(err)
	}
	got, err := u.LoadState()
	if err != nil {
		t.Fatal(err)
	}
	if got != orig {
		t.Errorf("round trip: got %+v, want %+v", got, orig)
	}
}

// fakeRelease serves a fake yt-dlp release: an API endpoint that returns a
// tag, a SHA2-256SUMS file with the given digest under the right asset
// name for this GOOS, and a binary blob whose actual hash is `binarySHA`.
// When binarySHA == "" the server hashes binaryBody on the fly so callers
// can opt in/out of mismatch behaviour just by passing a fixed digest.
func fakeRelease(t *testing.T, tag, sumsHex string, binaryBody []byte) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/api/latest", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, `{"tag_name": %q}`, tag)
	})
	mux.HandleFunc("/dl/SHA2-256SUMS", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "%s  %s\n", sumsHex, githubAssetName())
		fmt.Fprintf(w, "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff  unrelated-asset\n")
	})
	mux.HandleFunc("/dl/"+githubAssetName(), func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", fmt.Sprintf("%d", len(binaryBody)))
		w.Write(binaryBody)
	})
	return httptest.NewServer(mux)
}

func sha256hex(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

// TestDoUpdateInstallsWithValidChecksum: end-to-end — a fresh install
// (no existing managed binary) downloads, hashes, verifies against
// SHA2-256SUMS, and lands at dest. State is written.
func TestDoUpdateInstallsWithValidChecksum(t *testing.T) {
	body := []byte("fake yt-dlp binary contents")
	srv := fakeRelease(t, "2026.04.25", sha256hex(body), body)
	defer srv.Close()

	dir := t.TempDir()
	statePath := filepath.Join(dir, "state.json")
	u := NewForTest(statePath, time.Hour)
	u.SetEndpointsForTest(srv.URL+"/api/latest", srv.URL+"/dl/")

	dest := filepath.Join(dir, githubAssetName())
	// Bypass ManagedBinaryPath so we control the install location in tests.
	if err := u.installTo(context.Background(), dest); err != nil {
		t.Fatalf("install: %v", err)
	}
	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("read installed binary: %v", err)
	}
	if string(got) != string(body) {
		t.Errorf("binary content mismatch")
	}
	if runtime.GOOS != "windows" {
		st, _ := os.Stat(dest)
		if st.Mode().Perm()&0o100 == 0 {
			t.Errorf("expected executable bit on non-Windows install, got mode %v", st.Mode())
		}
	}
}

// TestDoUpdateRefusesOnChecksumMismatch: server publishes a SHA2-256SUMS
// entry for a different binary than what it actually serves. The updater
// must refuse, leave dest untouched, and surface an explicit error.
func TestDoUpdateRefusesOnChecksumMismatch(t *testing.T) {
	body := []byte("attacker-served binary")
	bogusHex := strings.Repeat("0", 64) // does not match body's SHA-256
	srv := fakeRelease(t, "2026.04.25", bogusHex, body)
	defer srv.Close()

	dir := t.TempDir()
	dest := filepath.Join(dir, githubAssetName())
	// Pre-existing binary that must NOT be touched on a mismatch.
	if err := os.WriteFile(dest, []byte("known-good"), 0o755); err != nil {
		t.Fatal(err)
	}

	u := NewForTest(filepath.Join(dir, "state.json"), time.Hour)
	u.SetEndpointsForTest(srv.URL+"/api/latest", srv.URL+"/dl/")

	err := u.installTo(context.Background(), dest)
	if err == nil {
		t.Fatal("expected checksum mismatch error, got nil")
	}
	if !strings.Contains(err.Error(), "checksum mismatch") {
		t.Errorf("error should mention checksum mismatch, got: %v", err)
	}
	got, _ := os.ReadFile(dest)
	if string(got) != "known-good" {
		t.Errorf("pre-existing binary was overwritten on checksum failure: %q", string(got))
	}
	// .new must not linger.
	if _, err := os.Stat(dest + ".new"); !os.IsNotExist(err) {
		t.Errorf(".new file should be cleaned up on failure")
	}
}

// TestDoUpdateRefusesWhenSumsAssetMissing: SHA2-256SUMS exists but doesn't
// list our asset name (e.g. upstream rename). We refuse to install rather
// than fall through to "no checksum, install anyway".
func TestDoUpdateRefusesWhenSumsAssetMissing(t *testing.T) {
	body := []byte("yt-dlp body")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/latest":
			fmt.Fprint(w, `{"tag_name": "2026.04.25"}`)
		case "/dl/SHA2-256SUMS":
			// Sums for some other asset only — does NOT include githubAssetName().
			fmt.Fprintln(w, "0000000000000000000000000000000000000000000000000000000000000000  not-our-binary")
		default:
			fmt.Fprint(w, string(body))
		}
	}))
	defer srv.Close()

	dir := t.TempDir()
	dest := filepath.Join(dir, githubAssetName())
	u := NewForTest(filepath.Join(dir, "state.json"), time.Hour)
	u.SetEndpointsForTest(srv.URL+"/api/latest", srv.URL+"/dl/")

	err := u.installTo(context.Background(), dest)
	if err == nil {
		t.Fatal("expected error when sums file lacks our asset")
	}
	if !strings.Contains(err.Error(), "no SHA2-256SUMS entry") {
		t.Errorf("error should explain missing sum entry, got: %v", err)
	}
}

// TestMigrateLegacyStateDirMovesContent: the typical case — old dir
// exists, new dir doesn't, contents move atomically and the source is
// removed.
func TestMigrateLegacyStateDirMovesContent(t *testing.T) {
	base := t.TempDir()
	oldDir := filepath.Join(base, legacyStateDirName)
	newDir := filepath.Join(base, stateDirName)
	if err := os.MkdirAll(filepath.Join(oldDir, "bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	stateBody := []byte(`{"lastVersion":"2026.01.01"}`)
	binBody := []byte("fake yt-dlp")
	if err := os.WriteFile(filepath.Join(oldDir, "updater.json"), stateBody, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(oldDir, "bin", "yt-dlp"), binBody, 0o755); err != nil {
		t.Fatal(err)
	}

	if err := migrateLegacyStateDir(base); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	got, err := os.ReadFile(filepath.Join(newDir, "updater.json"))
	if err != nil {
		t.Fatalf("new state file: %v", err)
	}
	if string(got) != string(stateBody) {
		t.Errorf("state body %q, want %q", got, stateBody)
	}
	gotBin, err := os.ReadFile(filepath.Join(newDir, "bin", "yt-dlp"))
	if err != nil {
		t.Fatalf("new bin: %v", err)
	}
	if string(gotBin) != string(binBody) {
		t.Errorf("binary body changed under migration")
	}
	if _, err := os.Stat(oldDir); !os.IsNotExist(err) {
		t.Errorf("old dir should be gone after rename, got err=%v", err)
	}
}

// TestMigrateLegacyStateDirNoOpWhenAbsent: fresh install — neither
// directory exists. No error, no-op.
func TestMigrateLegacyStateDirNoOpWhenAbsent(t *testing.T) {
	base := t.TempDir()
	if err := migrateLegacyStateDir(base); err != nil {
		t.Errorf("migrate on empty base should be no-op, got %v", err)
	}
}

// TestMigrateLegacyStateDirLeavesOrphanWhenBothExist: the conservative
// case — the new dir is already populated (e.g. user reinstalled or a
// prior partial migration left both). We refuse to merge; the old dir
// stays put as an orphan rather than risk overwriting good state.
func TestMigrateLegacyStateDirLeavesOrphanWhenBothExist(t *testing.T) {
	base := t.TempDir()
	oldDir := filepath.Join(base, legacyStateDirName)
	newDir := filepath.Join(base, stateDirName)
	for _, d := range []string{oldDir, newDir} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(newDir, "updater.json"), []byte("new"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(oldDir, "updater.json"), []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := migrateLegacyStateDir(base); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	got, err := os.ReadFile(filepath.Join(newDir, "updater.json"))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "new" {
		t.Errorf("new dir was overwritten by migration: got %q, want %q", got, "new")
	}
	if _, err := os.Stat(oldDir); err != nil {
		t.Errorf("old dir should still exist as orphan, got err=%v", err)
	}
}

// TestFetchExpectedSHA256ParsesBinaryMode: gnu coreutils sums files use
// "abc *filename" in binary mode. Make sure we strip the leading *.
func TestFetchExpectedSHA256ParsesBinaryMode(t *testing.T) {
	want := strings.Repeat("a", 64)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "%s *%s\n", want, githubAssetName())
	}))
	defer srv.Close()

	u := NewForTest(filepath.Join(t.TempDir(), "s.json"), time.Hour)
	u.SetEndpointsForTest("", srv.URL+"/")

	got, err := u.fetchExpectedSHA256(context.Background())
	if err != nil {
		t.Fatalf("fetchExpectedSHA256: %v", err)
	}
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}
