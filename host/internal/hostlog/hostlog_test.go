package hostlog

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestTrimToTailKeepsLastBytes: a file longer than `keep` should be
// rewritten with only its last `keep` bytes.
func TestTrimToTailKeepsLastBytes(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "log.txt")
	body := strings.Repeat("a", 100) + strings.Repeat("b", 100)
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := trimToTail(path, 100); err != nil {
		t.Fatalf("trimToTail: %v", err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != strings.Repeat("b", 100) {
		t.Errorf("expected 100 b's, got %q", got)
	}
}

// TestTrimToTailNoOpWhenSmaller: file already smaller than the keep
// budget is left untouched.
func TestTrimToTailNoOpWhenSmaller(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "log.txt")
	if err := os.WriteFile(path, []byte("short"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := trimToTail(path, 100); err != nil {
		t.Fatalf("trimToTail: %v", err)
	}
	got, _ := os.ReadFile(path)
	if string(got) != "short" {
		t.Errorf("expected unchanged, got %q", got)
	}
}

// TestTrimToTailMissingFile: trimming a non-existent path returns the
// underlying error rather than panicking.
func TestTrimToTailMissingFile(t *testing.T) {
	err := trimToTail(filepath.Join(t.TempDir(), "nope.log"), 100)
	if err == nil {
		t.Fatal("expected error for missing file")
	}
}
