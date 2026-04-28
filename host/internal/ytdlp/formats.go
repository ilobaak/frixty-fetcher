package ytdlp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// Format is the trimmed view of a yt-dlp format we send to the extension.
// Everything needed to render the picker, nothing else — yt-dlp's full -J
// payload is ~100KB per URL and most of it is irrelevant to the UI.
type Format struct {
	ID       string  `json:"id"`
	Kind     string  `json:"kind"` // "video" | "audio" | "combined"
	Height   int     `json:"height,omitempty"`
	FPS      float64 `json:"fps,omitempty"`
	Ext      string  `json:"ext,omitempty"`
	Filesize int64   `json:"filesize,omitempty"`
	Note     string  `json:"note,omitempty"`
}

// Listing is the listFormats response body.
type Listing struct {
	Title      string   `json:"title"`
	Thumbnail  string   `json:"thumbnail,omitempty"`
	Duration   float64  `json:"duration,omitempty"` // seconds
	Uploader   string   `json:"uploader,omitempty"`
	UploaderID string   `json:"uploaderId,omitempty"` // YouTube "@handle" when available
	Date       int64    `json:"date,omitempty"`       // post upload time (unix seconds); 0 = unknown
	Formats    []Format `json:"formats"`
}

// rawInfo mirrors the subset of `yt-dlp -J` we care about. Everything else in
// the payload is discarded by encoding/json.
type rawInfo struct {
	Title            string      `json:"title"`
	Thumbnail        string      `json:"thumbnail"`
	Duration         float64     `json:"duration"`
	Uploader         string      `json:"uploader"`
	UploaderID       string      `json:"uploader_id"`
	Channel          string      `json:"channel"`
	UploadDate       string      `json:"upload_date"`       // "YYYYMMDD"
	Timestamp        float64     `json:"timestamp"`         // unix seconds
	ReleaseDate      string      `json:"release_date"`      // "YYYYMMDD"
	ReleaseTimestamp float64     `json:"release_timestamp"` // unix seconds
	Formats          []rawFormat `json:"formats"`
}

type rawFormat struct {
	FormatID       string  `json:"format_id"`
	Ext            string  `json:"ext"`
	Height         int     `json:"height"`
	FPS            float64 `json:"fps"`
	VCodec         string  `json:"vcodec"`
	ACodec         string  `json:"acodec"`
	Filesize       int64   `json:"filesize"`
	FilesizeApprox int64   `json:"filesize_approx"`
	FormatNote     string  `json:"format_note"`
}

// ListFormats runs `yt-dlp -J` and returns the trimmed listing. When
// cookiesFile is a non-empty path, --cookies <path> is passed so yt-dlp
// can act as the authenticated session whose cookies the extension
// exported via chrome.cookies.getAll. Leaving cookiesFile empty runs
// unauthenticated.
func ListFormats(ctx context.Context, bin, url, cookiesFile string) (*Listing, error) {
	args := []string{"-J", "--no-warnings", "--no-playlist"}
	args = append(args, youtubeExtractorArgs()...)
	if cookiesFile != "" {
		args = append(args, "--cookies", cookiesFile)
	}
	args = append(args, url)
	cmd := exec.CommandContext(ctx, bin, args...)
	out, err := cmd.Output()
	if err != nil {
		// exec.Cmd.Output() populates ExitError.Stderr when Stderr wasn't
		// set, which is where yt-dlp writes the real failure reason (auth,
		// extractor, network, etc.). Surface it so the popup doesn't just
		// say "exit status 1".
		var ee *exec.ExitError
		if errors.As(err, &ee) && len(ee.Stderr) > 0 {
			return nil, fmt.Errorf("yt-dlp -J: %w: %s", err, strings.TrimSpace(string(ee.Stderr)))
		}
		return nil, fmt.Errorf("yt-dlp -J: %w", err)
	}
	var info rawInfo
	if err := json.Unmarshal(out, &info); err != nil {
		return nil, fmt.Errorf("parse -J output: %w", err)
	}
	uploader := info.Uploader
	if uploader == "" {
		uploader = info.Channel
	}
	return &Listing{
		Title:      info.Title,
		Thumbnail:  info.Thumbnail,
		Duration:   info.Duration,
		Uploader:   uploader,
		UploaderID: info.UploaderID,
		Date:       pickDate(info),
		Formats:    classify(info.Formats),
	}, nil
}

// pickDate coerces yt-dlp's various date fields into a single unix-seconds
// value. Preference order:
//  1. timestamp (exact, timezone-clean)
//  2. release_timestamp (for scheduled videos)
//  3. upload_date / release_date — parsed as midnight UTC on that day
//
// Returns 0 when none of the fields is populated.
func pickDate(info rawInfo) int64 {
	if info.Timestamp > 0 {
		return int64(info.Timestamp)
	}
	if info.ReleaseTimestamp > 0 {
		return int64(info.ReleaseTimestamp)
	}
	for _, s := range []string{info.UploadDate, info.ReleaseDate} {
		if len(s) == 8 {
			if t, err := time.Parse("20060102", s); err == nil {
				return t.Unix()
			}
		}
	}
	return 0
}

func classify(raws []rawFormat) []Format {
	out := make([]Format, 0, len(raws))
	for _, r := range raws {
		k := kind(r.VCodec, r.ACodec)
		if k == "" {
			continue // storyboard / metadata pseudo-formats
		}
		size := r.Filesize
		if size == 0 {
			// yt-dlp frequently omits filesize for adaptive streams but
			// provides a filesize_approx computed from bitrate and
			// duration. Good enough for a "show me how big this video is"
			// readout.
			size = r.FilesizeApprox
		}
		out = append(out, Format{
			ID:       r.FormatID,
			Kind:     k,
			Height:   r.Height,
			FPS:      r.FPS,
			Ext:      r.Ext,
			Filesize: size,
			Note:     r.FormatNote,
		})
	}
	return out
}

func kind(v, a string) string {
	hasV := v != "" && v != "none"
	hasA := a != "" && a != "none"
	switch {
	case hasV && hasA:
		return "combined"
	case hasV:
		return "video"
	case hasA:
		return "audio"
	default:
		return ""
	}
}
