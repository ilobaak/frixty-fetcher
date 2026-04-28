// Direct HTTP-to-file fetch helpers used by the Reddit/Twitter/Instagram
// image paths (where yt-dlp has no applicable extractor). Split out of
// main.go in the sprint-2 decomposition pass.
package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

// fetchURLToFileCtx GETs url under ctx and writes the body to destPath,
// creating any missing parent dirs. ctx cancellation kills the in-flight
// transfer promptly. Used by the gallery and downloadUrl flows for
// non-yt-dlp media (Reddit/Twitter/Instagram direct image URLs).
func fetchURLToFileCtx(ctx context.Context, url, destPath string) error {
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return err
	}
	client := &http.Client{Timeout: 5 * time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	if err := os.MkdirAll(filepath.Dir(destPath), 0o755); err != nil {
		return fmt.Errorf("create parent dir: %w", err)
	}
	f, err := os.Create(destPath)
	if err != nil {
		return err
	}
	defer f.Close()
	if _, err := io.Copy(f, resp.Body); err != nil {
		return err
	}
	return nil
}
