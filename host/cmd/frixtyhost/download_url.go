// Direct-URL download handler (no yt-dlp extractor). Used by the
// Reddit/Twitter/Instagram image flows where we already have the
// final media URL and just need to write it to disk — optionally
// with an audio-extract or video-only post-process step.
package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/ilobaak/frixty-fetcher/host/internal/ffmpeg"
	"github.com/ilobaak/frixty-fetcher/host/internal/ytdlp"
)

// handleDownloadUrl performs a plain HTTP GET of a URL and writes the bytes
// to the user's chosen path. Used by the Reddit image flow where yt-dlp
// doesn't apply (static images aren't something its extractors surface).
// Honors the same saveMode contract as video downloads: askPath opens the
// Save As dialog, otherwise destDir+defaultFileName determines the path.
func (s *server) handleDownloadUrl(req request) {
	if req.JobID == "" {
		s.sendRequestError(req.ReqID, "bad_request", "downloadUrl requires jobId")
		return
	}
	go s.runDownloadUrl(req)
}

func (s *server) runDownloadUrl(req request) {
	var destPath string
	if req.AskPath {
		picked, err := s.promptSavePath(req, "Save as…")
		if err != nil {
			return // error already sent to extension
		}
		destPath = picked
	} else {
		dir, err := resolveDestDir(req.DestDir)
		if err != nil {
			s.sendJobError(req.JobID, "bad_destdir", err.Error())
			return
		}
		if req.DefaultFileName == "" {
			s.sendJobError(req.JobID, "bad_request", "downloadUrl requires defaultFileName when askPath is false")
			return
		}
		// Optional subfolder: when the popup's "Download to new folder"
		// option is on, album name arrives with the request. Create it
		// upfront so the subsequent file write doesn't fail.
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

	// Per-job cancellable context so the popup's Cancel button
	// actually stops an in-flight download. Without this, fetchAndConvert
	// runs under context.Background and the user has to wait out the
	// transfer before the cancel takes effect.
	ctx, cancel := context.WithCancel(context.Background())
	s.jobs.Add(req.JobID, cancel)
	defer s.jobs.Remove(req.JobID)

	finalPath, err := s.fetchAndConvert(ctx, req.URL, destPath, req.Kind)
	if err != nil {
		// Surface a cancel as a distinct code so the popup can render
		// the user-initiated stop as a quiet "canceled" rather than
		// the louder generic "download_failed" red toast.
		if ctx.Err() == context.Canceled {
			s.sendJobError(req.JobID, "download_canceled", "Download canceled.")
			return
		}
		s.sendJobError(req.JobID, "download_failed", err.Error())
		return
	}
	// Stat the written file so the popup can show its size on the
	// gallery card after the download completes. Failure here is
	// non-fatal — we still report "done", just without bytes.
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
}

// defaultFetchAndConvert downloads url to destPath and, when kind is
// "audio" or "video", runs the appropriate conversion step. destPath is
// the *final* path the user requested (with an extension matching the
// chosen kind); intermediate files are written alongside and cleaned up
// on success.
//
// For Kind=audio we route through yt-dlp -x because its generic extractor
// handles the download + ffmpeg ExtractAudio pipeline in one shot (and
// has a retry loop for transient network hiccups). For Kind=video we do
// the direct download ourselves (fast, no Python spawn) and invoke
// ffmpeg directly to strip the audio track — no re-encode.
//
// Bound to server.fetchAndConvert at construction time; tests substitute
// a deterministic fake. Call it via s.fetchAndConvert in handlers.
func (s *server) defaultFetchAndConvert(ctx context.Context, url, destPath, kind string) (string, error) {
	switch kind {
	case "audio":
		ytbin := s.ytBin()
		if ytbin == "" {
			return "", fmt.Errorf("yt-dlp not available (required for audio-only)")
		}
		if err := os.MkdirAll(filepath.Dir(destPath), 0o755); err != nil {
			return "", fmt.Errorf("create parent dir: %w", err)
		}
		// yt-dlp renames to .m4a itself via --audio-format m4a; hand it
		// the path without the extension so it doesn't end up like
		// "foo.mp4.m4a".
		stem := strings.TrimSuffix(destPath, filepath.Ext(destPath))
		if err := ytdlp.ExtractAudio(ctx, ytbin, url, stem); err != nil {
			// yt-dlp normally cleans up its own .part / fragment files
			// on graceful exit, but a hard kill (context cancel during
			// host shutdown) can leave them behind. Mirror the .src
			// cleanup the video branch already does so the next run
			// starts clean.
			os.Remove(stem + ".m4a")
			os.Remove(stem + ".m4a.part")
			return "", err
		}
		return stem + ".m4a", nil

	case "video":
		if err := fetchURLToFileCtx(ctx, url, destPath+".src"); err != nil {
			return "", err
		}
		ffbin, err := ffmpeg.Resolve()
		if err != nil {
			os.Remove(destPath + ".src")
			return "", fmt.Errorf("video-only needs ffmpeg: %w", err)
		}
		if err := ffmpeg.StripAudio(ctx, ffbin, destPath+".src", destPath); err != nil {
			os.Remove(destPath + ".src")
			return "", err
		}
		os.Remove(destPath + ".src")
		return destPath, nil

	default: // "" or "combined"
		if err := fetchURLToFileCtx(ctx, url, destPath); err != nil {
			return "", err
		}
		return destPath, nil
	}
}
