// Gallery download handler: multi-item batch, optional per-item prompt,
// partial-success accounting. Split out of main.go in sprint 2 because
// this flow alone was ~200 lines and had its own subtle policies worth
// locating in one file.
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/ncruces/zenity"
)

// handleDownloadGallery downloads a list of URLs into one folder. Used by
// the Reddit gallery flow. In askDir mode the host opens a native folder
// picker; otherwise destDir is used. AlbumName, when set, is created as a
// subfolder so multi-image posts don't dump files straight into Downloads.
// Individual items are named <zero-padded index>.<ext> — the post title
// already lives on the folder, so per-file titles would be redundant.
func (s *server) handleDownloadGallery(req request) {
	if req.JobID == "" {
		s.sendRequestError(req.ReqID, "bad_request", "downloadGallery requires jobId")
		return
	}
	if len(req.Items) == 0 {
		s.sendJobError(req.JobID, "bad_request", "downloadGallery requires non-empty items")
		return
	}
	go s.runDownloadGallery(req)
}

func (s *server) runDownloadGallery(req request) {
	log.Printf("[frixty/host] downloadGallery start job=%s items=%d askDir=%t askPerItem=%t", req.JobID, len(req.Items), req.AskDir, req.AskPerItem)
	// AskPerItem runs a Save As dialog per item and places each file
	// wherever the user chooses. No album subfolder is created — the user
	// has explicit control over every path.
	var albumPath string
	if !req.AskPerItem {
		var baseDir string
		if req.AskDir {
			picked, err := s.promptFolder(req, "Choose folder for gallery")
			if err != nil {
				return // error already sent
			}
			baseDir = picked
		} else {
			dir, err := resolveDestDir(req.DestDir)
			if err != nil {
				s.sendJobError(req.JobID, "bad_destdir", err.Error())
				return
			}
			baseDir = dir
		}
		albumPath = baseDir
		if req.AlbumName != "" {
			joined, err := joinAlbumDir(baseDir, req.AlbumName)
			if err != nil {
				s.sendJobError(req.JobID, "bad_request", err.Error())
				return
			}
			albumPath = joined
			if err := os.MkdirAll(albumPath, 0o755); err != nil {
				s.sendJobError(req.JobID, "write_failed", err.Error())
				return
			}
		}
	}

	ctx, cancel := context.WithCancel(context.Background())
	s.jobs.Add(req.JobID, cancel)
	defer s.jobs.Remove(req.JobID)

	total := len(req.Items)
	// Pad exactly to the number of digits in `total` so every index in
	// this batch stays the same width — 1..9 items render as "1".."9",
	// 10..99 as "01".."99", and so on.
	digits := len(strconv.Itoa(total))

	var lastSavedPath string
	savedCount := 0
	// Accumulate per-item failures so the final "done" event can report
	// which items didn't make it. Soft failures (download_failed for a
	// single item) are recorded and the loop continues. Hard failures
	// (ctx canceled, picker errors) still terminate.
	type itemFailure struct {
		Index int    `json:"index"` // 1-based
		URL   string `json:"url,omitempty"`
		Error string `json:"error"`
	}
	var failures []itemFailure

	for i, item := range req.Items {
		if ctx.Err() != nil {
			// Match the single-file path (download.go) and surface the
			// dedicated download_canceled code so the popup renders this
			// as an informational "Canceled" rather than a red error.
			s.sendJobError(req.JobID, "download_canceled", "Gallery download canceled.")
			return
		}

		var path string
		if req.AskPerItem {
			picked, err := s.promptGalleryItemPath(req, item, i, total, digits, lastSavedPath)
			if errors.Is(err, zenity.ErrCanceled) {
				// User dismissed the dialog — skip this item, continue.
				s.send(map[string]any{
					"type":    "progress",
					"jobId":   req.JobID,
					"percent": float64(i+1) / float64(total) * 100,
					"stage":   fmt.Sprintf("%d/%d skipped", i+1, total),
				})
				continue
			}
			if err != nil {
				s.sendJobError(req.JobID, "picker_failed", err.Error())
				return
			}
			path = picked
			s.send(map[string]any{
				"type":  "pathPicked",
				"jobId": req.JobID,
				"path":  picked,
			})
		} else {
			var filename string
			if item.Name != "" {
				filename = item.Name
			} else {
				ext := item.Ext
				if ext == "" {
					ext = "jpg"
				}
				filename = fmt.Sprintf("%0*d.%s", digits, i+1, ext)
			}
			// Kind=audio forces the output to .m4a regardless of what the
			// popup pre-baked — the source mp4 gets replaced by the
			// extracted audio track.
			if item.Kind == "audio" {
				filename = strings.TrimSuffix(filename, filepath.Ext(filename)) + ".m4a"
			}
			unique, err := uniquePath(filepath.Join(albumPath, filename))
			if err != nil {
				failures = append(failures, itemFailure{Index: i + 1, URL: item.URL, Error: err.Error()})
				continue
			}
			path = unique
		}

		savedPath, err := s.fetchAndConvert(ctx, item.URL, path, item.Kind)
		if err != nil {
			if ctx.Err() != nil {
				// Same code as the top-of-loop cancel branch above —
				// preserve UI parity with the single-file download path.
				s.sendJobError(req.JobID, "download_canceled", "Gallery download canceled.")
				return
			}
			log.Printf("[frixty/host] downloadGallery item error job=%s index=%d url=%q err=%v", req.JobID, i+1, item.URL, err)
			failures = append(failures, itemFailure{Index: i + 1, URL: item.URL, Error: err.Error()})
			s.send(map[string]any{
				"type":    "progress",
				"jobId":   req.JobID,
				"percent": float64(i+1) / float64(total) * 100,
				"stage":   fmt.Sprintf("%d/%d failed", i+1, total),
			})
			continue
		}
		path = savedPath
		lastSavedPath = path
		savedCount++
		s.send(map[string]any{
			"type":    "progress",
			"jobId":   req.JobID,
			"percent": float64(i+1) / float64(total) * 100,
			"stage":   fmt.Sprintf("%d/%d", i+1, total),
		})
	}

	if savedCount == 0 {
		reason := "no items saved (all canceled)"
		if len(failures) > 0 {
			reason = fmt.Sprintf("all %d items failed; first error: %s", len(failures), failures[0].Error)
		}
		done := map[string]any{
			"type":    "error",
			"jobId":   req.JobID,
			"code":    "download_failed",
			"message": reason,
		}
		if len(failures) > 0 {
			done["failures"] = failures
		}
		s.send(done)
		return
	}

	// Non-askPerItem: return the album folder (so Open Folder opens the
	// shared directory). AskPerItem: return the last saved file's path so
	// Open Folder lands near whatever the user just placed.
	finalPath := albumPath
	if req.AskPerItem {
		finalPath = lastSavedPath
	}
	doneMsg := map[string]any{
		"type":  "done",
		"jobId": req.JobID,
		"path":  finalPath,
		"saved": savedCount,
		"total": total,
	}
	if len(failures) > 0 {
		// Partial success: popup renders a "saved N of M" banner and can
		// drill into the failure list for retry affordances if desired.
		doneMsg["failures"] = failures
	}
	s.send(doneMsg)
	log.Printf("[frixty/host] downloadGallery done job=%s saved=%d total=%d path=%q", req.JobID, savedCount, total, finalPath)
}
