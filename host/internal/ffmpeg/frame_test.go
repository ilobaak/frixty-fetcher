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

func TestExtractFrameRejectsNegativeTimestamp(t *testing.T) {
	err := ExtractFrame(context.Background(), "ffmpeg", -1, "in.mp4", "out.png")
	if err == nil || !strings.Contains(err.Error(), "timestamp") {
		t.Fatalf("expected timestamp error, got %v", err)
	}
}
