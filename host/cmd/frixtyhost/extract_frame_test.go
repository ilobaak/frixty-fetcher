package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ilobaak/frixty-fetcher/host/internal/messaging"
)

func TestExtractFrameValidation(t *testing.T) {
	tests := []struct {
		name string
		req  request
		code string
	}{
		{
			name: "missing job",
			req:  request{Action: "extractFrame", URL: "https://youtu.be/x", Timestamp: 1},
			code: "bad_request",
		},
		{
			name: "missing ytdlp",
			req:  request{Action: "extractFrame", JobID: "j1", URL: "https://youtu.be/x", Timestamp: 1},
			code: "ytdlp_missing",
		},
		{
			name: "bad timestamp",
			req:  request{Action: "extractFrame", JobID: "j1", URL: "https://youtu.be/x", Timestamp: -1},
			code: "bad_request",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var out bytes.Buffer
			s := newTestServer(&out)
			s.dispatch(tt.req)
			var resp map[string]any
			if err := messaging.Read(&out, &resp); err != nil {
				t.Fatalf("read: %v", err)
			}
			if resp["type"] != "error" || resp["code"] != tt.code {
				t.Fatalf("unexpected response: %+v", resp)
			}
		})
	}
}

func TestExtractFrameDispatchUsesStructuredErrorForMissingFfmpeg(t *testing.T) {
	var out bytes.Buffer
	s := newTestServer(&out)
	s.resolveYt = func() string { return "yt-dlp" }
	s.resolveFfmpeg = func() (string, error) { return "", errTestFfmpegMissing{} }
	s.dispatch(request{
		Action:          "extractFrame",
		JobID:           "j1",
		URL:             "https://youtu.be/x",
		Timestamp:       1,
		DefaultFileName: "frame.png",
	})

	var resp map[string]any
	if err := messaging.Read(&out, &resp); err != nil {
		t.Fatalf("read: %v", err)
	}
	if resp["type"] != "error" || resp["code"] != "ffmpeg_missing" || !strings.Contains(resp["message"].(string), "missing") {
		t.Fatalf("unexpected response: %+v", resp)
	}
}

type errTestFfmpegMissing struct{}

func (errTestFfmpegMissing) Error() string { return "ffmpeg missing" }

func TestExtractFramePreviewReturnsDataURL(t *testing.T) {
	var out bytes.Buffer
	s := newTestServer(&out)
	s.resolveYt = func() string { return "yt-dlp" }
	s.resolveFfmpeg = func() (string, error) { return "ffmpeg", nil }
	s.extractFramePreview = func(ctx context.Context, ytbin, ffbin, pageURL, cookiesFile, destPath string, timestamp float64) (string, error) {
		if timestamp != 12.5 {
			t.Fatalf("timestamp = %v, want 12.5", timestamp)
		}
		if filepath.Ext(destPath) != ".jpg" {
			t.Fatalf("destPath = %q, want jpg", destPath)
		}
		if err := os.WriteFile(destPath, []byte{0xff, 0xd8, 0xff, 0xd9}, 0o644); err != nil {
			t.Fatalf("write preview: %v", err)
		}
		return destPath, nil
	}

	s.dispatch(request{
		Action:    "extractFramePreview",
		ReqID:     "preview-1",
		URL:       "https://youtu.be/x",
		Timestamp: 12.5,
	})
	s.inflight.Wait()

	var resp map[string]any
	if err := messaging.Read(&out, &resp); err != nil {
		t.Fatalf("read: %v", err)
	}
	if resp["type"] != "framePreview" || resp["reqId"] != "preview-1" {
		t.Fatalf("unexpected response: %+v", resp)
	}
	if resp["mime"] != "image/jpeg" {
		t.Fatalf("mime = %v, want image/jpeg", resp["mime"])
	}
	if got := resp["dataUrl"].(string); !strings.HasPrefix(got, "data:image/jpeg;base64,") {
		t.Fatalf("dataUrl = %q", got)
	}
}
