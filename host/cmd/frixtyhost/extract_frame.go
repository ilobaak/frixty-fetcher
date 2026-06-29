package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"

	"github.com/ilobaak/frixty-fetcher/host/internal/ffmpeg"
	"github.com/ilobaak/frixty-fetcher/host/internal/ytdlp"
)

func (s *server) handleExtractFrame(req request) {
	if req.JobID == "" {
		s.sendRequestError(req.ReqID, "bad_request", "extractFrame requires jobId")
		return
	}
	if req.Timestamp < 0 {
		s.sendJobError(req.JobID, "bad_request", "extractFrame requires a non-negative timestamp")
		return
	}
	ytbin := s.ytBin()
	if ytbin == "" {
		s.sendJobError(req.JobID, "ytdlp_missing", "yt-dlp binary not found")
		return
	}
	ffbin, err := s.ffmpegBin()
	if err != nil {
		if errors.Is(err, ffmpeg.ErrNotFound) {
			s.sendJobError(req.JobID, "ffmpeg_missing", err.Error())
			return
		}
		s.sendJobError(req.JobID, "ffmpeg_missing", err.Error())
		return
	}
	go s.runExtractFrame(req, ytbin, ffbin)
}

func (s *server) runExtractFrame(req request, ytbin, ffbin string) {
	log.Printf("[frixty/host] extractFrame start job=%s url=%q timestamp=%.3f cookies=%t askPath=%t", req.JobID, req.URL, req.Timestamp, req.CookiesText != "", req.AskPath)
	var destPath string
	if req.AskPath {
		picked, err := s.promptSavePath(req, "Save frame as...")
		if err != nil {
			return
		}
		destPath = picked
	} else {
		dir, err := resolveDestDir(req.DestDir)
		if err != nil {
			s.sendJobError(req.JobID, "bad_destdir", err.Error())
			return
		}
		if req.DefaultFileName == "" {
			s.sendJobError(req.JobID, "bad_request", "extractFrame requires defaultFileName when askPath is false")
			return
		}
		if req.AlbumName != "" {
			joined, err := joinAlbumDir(dir, req.AlbumName)
			if err != nil {
				s.sendJobError(req.JobID, "bad_request", err.Error())
				return
			}
			dir = joined
			if err := os.MkdirAll(dir, 0o755); err != nil {
				s.sendJobError(req.JobID, "write_failed", err.Error())
				return
			}
		}
		destPath = filepath.Join(dir, req.DefaultFileName)
	}

	ctx, cancel := context.WithCancel(context.Background())
	s.jobs.Add(req.JobID, cancel)
	defer s.jobs.Remove(req.JobID)

	cookiesFile, cleanup, err := writeCookiesTemp(req.CookiesText)
	if err != nil {
		s.sendJobError(req.JobID, "cookies_write_failed", err.Error())
		return
	}
	defer cleanup()

	finalPath, err := s.extractFrame(ctx, ytbin, ffbin, req.URL, cookiesFile, destPath, req.Timestamp)
	if err != nil {
		if ctx.Err() == context.Canceled {
			s.sendJobError(req.JobID, "download_canceled", "Download canceled.")
			return
		}
		log.Printf("[frixty/host] extractFrame error job=%s url=%q timestamp=%.3f err=%v", req.JobID, req.URL, req.Timestamp, err)
		s.sendJobError(req.JobID, "download_failed", err.Error())
		return
	}
	var size int64
	if st, statErr := os.Stat(finalPath); statErr == nil {
		size = st.Size()
	}
	s.send(map[string]any{
		"type":  "done",
		"jobId": req.JobID,
		"path":  finalPath,
		"bytes": size,
	})
	log.Printf("[frixty/host] extractFrame done job=%s path=%q bytes=%d", req.JobID, finalPath, size)
}

func (s *server) defaultExtractFrame(ctx context.Context, ytbin, ffbin, pageURL, cookiesFile, destPath string, timestamp float64) (string, error) {
	if err := os.MkdirAll(filepath.Dir(destPath), 0o755); err != nil {
		return "", fmt.Errorf("create parent dir: %w", err)
	}
	mediaURL, err := ytdlp.ResolveMediaURL(ctx, ytbin, pageURL, cookiesFile)
	if err != nil {
		return "", err
	}
	log.Printf("[frixty/host] extractFrame media resolved page=%q media=%q", pageURL, mediaURL)
	if err := ffmpeg.ExtractFrame(ctx, ffbin, timestamp, mediaURL, destPath); err != nil {
		os.Remove(destPath)
		return "", err
	}
	return destPath, nil
}
