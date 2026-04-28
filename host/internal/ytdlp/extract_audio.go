package ytdlp

import (
	"context"
	"fmt"

	"github.com/ilobaak/frixty-fetcher/host/internal/runproc"
)

// ExtractAudio runs yt-dlp with -x on a source URL, writing the final
// audio file at destPath (the extension is derived from --audio-format).
// Used by the gallery Kind=audio path: yt-dlp's generic extractor handles
// the direct mp4 download, then its ExtractAudio post-processor hands off
// to ffmpeg to pull clean m4a out of the container.
//
// yt-dlp's -o template must target destPath without the extension so
// yt-dlp can rename after conversion. We pass destPath's stem and let
// yt-dlp add ".m4a".
func ExtractAudio(ctx context.Context, bin, url, destWithoutExt string) error {
	args := []string{
		"-x",
		"--audio-format", "m4a",
		"--no-warnings",
		"--no-playlist",
		"-o", destWithoutExt + ".%(ext)s",
		url,
	}
	if err := runproc.RunCaptureTail(ctx, bin, args...); err != nil {
		return fmt.Errorf("yt-dlp -x: %w", err)
	}
	return nil
}
