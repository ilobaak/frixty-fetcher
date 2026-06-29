package ytdlp

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
)

func ResolveMediaURL(ctx context.Context, bin, pageURL, cookiesFile string) (string, error) {
	args := []string{"-g", "--no-warnings", "--no-playlist"}
	args = append(args, youtubeExtractorArgs()...)
	if cookiesFile != "" {
		args = append(args, "--cookies", cookiesFile)
	}
	args = append(args, pageURL)
	out, err := exec.CommandContext(ctx, bin, args...).CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("yt-dlp -g: %w: %s", err, strings.TrimSpace(string(out)))
	}
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "http://") || strings.HasPrefix(line, "https://") {
			return line, nil
		}
	}
	return "", fmt.Errorf("yt-dlp -g returned no media URL")
}
