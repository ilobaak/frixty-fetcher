package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ilobaak/frixty-fetcher/host/internal/messaging"
)

// galleryReq builds a downloadGallery request with n items rooted at
// dir. All items use the .jpg extension and a synthetic URL so the test
// fetchAndConvert fake can decide success/failure per item.
func galleryReq(jobID, dir string, n int) request {
	items := make([]galleryItem, n)
	for i := 0; i < n; i++ {
		items[i] = galleryItem{URL: fmt.Sprintf("https://test/%d", i+1), Ext: "jpg"}
	}
	return request{
		Action:  "downloadGallery",
		JobID:   jobID,
		DestDir: dir,
		Items:   items,
	}
}

// drainMessages decodes every framed message in buf until messaging.Read
// returns an error (EOF on a complete buffer).
func drainMessages(buf *bytes.Buffer) []map[string]any {
	var out []map[string]any
	for {
		var m map[string]any
		if err := messaging.Read(buf, &m); err != nil {
			return out
		}
		out = append(out, m)
	}
}

func findByType(msgs []map[string]any, kind string) map[string]any {
	for _, m := range msgs {
		if m["type"] == kind {
			return m
		}
	}
	return nil
}

func findByCode(msgs []map[string]any, code string) map[string]any {
	for _, m := range msgs {
		if m["type"] == "error" && m["code"] == code {
			return m
		}
	}
	return nil
}

// TestRunDownloadGalleryAllSuccess: every item resolves cleanly. The
// host emits per-item progress events plus a single "done" with the
// total, no failures field.
func TestRunDownloadGalleryAllSuccess(t *testing.T) {
	var buf bytes.Buffer
	s := newTestServer(&buf)
	dir := t.TempDir()
	s.fetchAndConvert = func(_ context.Context, _, destPath, _ string) (string, error) {
		if err := os.WriteFile(destPath, []byte("ok"), 0o644); err != nil {
			return "", err
		}
		return destPath, nil
	}
	s.runDownloadGallery(galleryReq("j1", dir, 3))

	msgs := drainMessages(&buf)
	done := findByType(msgs, "done")
	if done == nil {
		t.Fatalf("expected done message, got %#v", msgs)
	}
	if done["saved"].(float64) != 3 {
		t.Errorf("saved %v, want 3", done["saved"])
	}
	if _, has := done["failures"]; has {
		t.Errorf("all-success done should not carry a failures field, got %v", done["failures"])
	}
	if done["path"].(string) != dir {
		t.Errorf("done path %q, want %q (album folder)", done["path"], dir)
	}
}

// TestRunDownloadGalleryPartialFailure: the middle item fails. The
// loop continues past the failure, and the final "done" carries a
// populated failures list with index/url/error.
func TestRunDownloadGalleryPartialFailure(t *testing.T) {
	var buf bytes.Buffer
	s := newTestServer(&buf)
	dir := t.TempDir()
	s.fetchAndConvert = func(_ context.Context, _, destPath, _ string) (string, error) {
		// digits=1 for total=3, so item 2's filename is "2.jpg".
		if filepath.Base(destPath) == "2.jpg" {
			return "", errors.New("simulated extractor failure")
		}
		if err := os.WriteFile(destPath, []byte("ok"), 0o644); err != nil {
			return "", err
		}
		return destPath, nil
	}
	s.runDownloadGallery(galleryReq("j2", dir, 3))

	msgs := drainMessages(&buf)
	done := findByType(msgs, "done")
	if done == nil {
		t.Fatalf("expected done with partial success, got %#v", msgs)
	}
	if done["saved"].(float64) != 2 {
		t.Errorf("saved %v, want 2 (item 2 should have failed)", done["saved"])
	}
	failures, ok := done["failures"].([]any)
	if !ok || len(failures) != 1 {
		t.Fatalf("expected 1 failure entry, got %v", done["failures"])
	}
	f := failures[0].(map[string]any)
	if f["index"].(float64) != 2 {
		t.Errorf("failure index %v, want 2", f["index"])
	}
	if !strings.Contains(f["error"].(string), "simulated extractor failure") {
		t.Errorf("failure error %q missing expected substring", f["error"])
	}
}

// TestRunDownloadGalleryAllFailed: every item errors. No saved files →
// host emits a top-level error with code download_failed and the full
// failures list (rather than a "done" with empty saved count).
func TestRunDownloadGalleryAllFailed(t *testing.T) {
	var buf bytes.Buffer
	s := newTestServer(&buf)
	dir := t.TempDir()
	s.fetchAndConvert = func(_ context.Context, _, _, _ string) (string, error) {
		return "", errors.New("upstream is down")
	}
	s.runDownloadGallery(galleryReq("j3", dir, 3))

	msgs := drainMessages(&buf)
	failed := findByCode(msgs, "download_failed")
	if failed == nil {
		t.Fatalf("expected download_failed error, got %#v", msgs)
	}
	failures, ok := failed["failures"].([]any)
	if !ok || len(failures) != 3 {
		t.Errorf("expected 3 failure entries on all-fail, got %v", failed["failures"])
	}
	msg := failed["message"].(string)
	if !strings.Contains(msg, "upstream is down") {
		t.Errorf("error message %q should surface the first failure", msg)
	}
}

// TestRunDownloadGalleryCancelsMidLoop: a user-initiated cancel between
// items must surface the dedicated download_canceled code (not
// download_failed) so the popup renders the same informational state
// the single-file path uses.
func TestRunDownloadGalleryCancelsMidLoop(t *testing.T) {
	var buf bytes.Buffer
	s := newTestServer(&buf)
	dir := t.TempDir()
	calls := 0
	s.fetchAndConvert = func(ctx context.Context, _, destPath, _ string) (string, error) {
		calls++
		if calls == 2 {
			// Simulate the user hitting Cancel after item 1 completed.
			// jobs.Cancel invokes the stored cancel func (the gallery
			// ctx's cancel), so the next loop iteration sees ctx.Err()
			// and bails into the canceled branch.
			s.jobs.Cancel("j4")
			return "", ctx.Err()
		}
		_ = os.WriteFile(destPath, []byte("ok"), 0o644)
		return destPath, nil
	}
	s.runDownloadGallery(galleryReq("j4", dir, 4))

	msgs := drainMessages(&buf)
	if findByCode(msgs, "download_canceled") == nil {
		t.Fatalf("expected download_canceled, got %#v", msgs)
	}
	if findByCode(msgs, "download_failed") != nil {
		t.Errorf("cancel should not surface as download_failed (regression of the fix in d13e769)")
	}
}
