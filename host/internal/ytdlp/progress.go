package ytdlp

import (
	"bufio"
	"encoding/json"
	"io"
	"math"
	"strings"

	"github.com/ilobaak/frixty-fetcher/host/internal/runproc"
)

// Progress is the event we emit for each update parsed from yt-dlp.
type Progress struct {
	Percent float64 `json:"percent"`           // 0..100
	Speed   float64 `json:"speed,omitempty"`   // bytes/sec
	ETA     int     `json:"eta,omitempty"`     // seconds
	Stage   string  `json:"stage"`             // "download" | "postprocess"
}

// rawProgress matches the `%(progress)j` template: yt-dlp dumps its progress
// dict as JSON on each update when we ask for it.
type rawProgress struct {
	Status          string  `json:"status"`
	DownloadedBytes float64 `json:"downloaded_bytes"`
	TotalBytes      float64 `json:"total_bytes"`
	TotalBytesEst   float64 `json:"total_bytes_estimate"`
	Speed           float64 `json:"speed"`
	ETA             float64 `json:"eta"`
}

const progressPrefix = "[YTDP]"
const donePrefix = "[YTDP-DONE]"

// ParseStream reads yt-dlp's stdout line-by-line, invoking onProgress
// for each parsed progress frame and returning the final output path
// if yt-dlp printed one. It stops when r hits EOF.
//
// Lines that don't match our prefixes are captured into `leftover`
// (bounded to stderrCap bytes) so downstream error-reporting can
// surface them when yt-dlp exits with no stderr signal — some failure
// modes (format-selection errors, extractor misses) log to stdout with
// no corresponding stderr line.
func ParseStream(r io.Reader, onProgress func(Progress)) (finalPath, leftover string, err error) {
	scan := bufio.NewScanner(r)
	scan.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	var leftoverBuf []byte
	for scan.Scan() {
		line := scan.Text()
		switch {
		case strings.HasPrefix(line, progressPrefix):
			if p, ok := parseProgress(line[len(progressPrefix):]); ok {
				onProgress(p)
			}
		case strings.HasPrefix(line, donePrefix):
			finalPath = strings.TrimSpace(line[len(donePrefix):])
		default:
			// Non-progress stdout line — could be an extractor status
			// message or an error yt-dlp put on stdout instead of stderr.
			// Keep the tail so callers can include it in error reports.
			if len(leftoverBuf) > 0 {
				leftoverBuf = append(leftoverBuf, '\n')
			}
			leftoverBuf = append(leftoverBuf, line...)
			if over := len(leftoverBuf) - runproc.DefaultStderrCap; over > 0 {
				leftoverBuf = leftoverBuf[over:]
			}
		}
	}
	return finalPath, string(leftoverBuf), scan.Err()
}

func parseProgress(payload string) (Progress, bool) {
	var r rawProgress
	if err := json.Unmarshal([]byte(payload), &r); err != nil {
		return Progress{}, false
	}
	total := r.TotalBytes
	if total == 0 {
		total = r.TotalBytesEst
	}
	var percent float64
	if total > 0 {
		percent = (r.DownloadedBytes / total) * 100
		if percent > 100 {
			percent = 100
		}
	}
	stage := "download"
	if r.Status == "finished" {
		stage = "postprocess"
	}
	return Progress{
		Percent: round1(percent),
		Speed:   r.Speed,
		ETA:     int(r.ETA),
		Stage:   stage,
	}, true
}

func round1(f float64) float64 {
	return math.Round(f*10) / 10
}
