package ffmpeg

import (
	"context"
	"strings"
	"testing"
)

func TestBuildExtractFrameArgs(t *testing.T) {
	args := BuildExtractFrameArgs(12.5, "https://example.com/video.mp4", "C:\\tmp\\frame.png")
	joined := strings.Join(args, " ")
	for _, want := range []string{"-ss 12.500", "-i https://example.com/video.mp4", "-frames:v 1", "C:\\tmp\\frame.png"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("args missing %q: %#v", want, args)
		}
	}
}

func TestBuildExtractFramePreviewArgs(t *testing.T) {
	args := BuildExtractFramePreviewArgs(12.5, "https://example.com/video.mp4", "C:\\tmp\\preview.jpg")
	joined := strings.Join(args, " ")
	for _, want := range []string{"-ss 12.500", "-i https://example.com/video.mp4", "-frames:v 1", "-vf scale=640:-2", "-q:v 5", "C:\\tmp\\preview.jpg"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("args missing %q: %#v", want, args)
		}
	}
}

func TestExtractFramePreviewRejectsNegativeTimestamp(t *testing.T) {
	err := ExtractFramePreview(context.Background(), "ffmpeg", -1, "in.mp4", "out.jpg")
	if err == nil || !strings.Contains(err.Error(), "timestamp") {
		t.Fatalf("expected timestamp error, got %v", err)
	}
}

func TestExtractFrameRejectsNegativeTimestamp(t *testing.T) {
	err := ExtractFrame(context.Background(), "ffmpeg", -1, "in.mp4", "out.png")
	if err == nil || !strings.Contains(err.Error(), "timestamp") {
		t.Fatalf("expected timestamp error, got %v", err)
	}
}
