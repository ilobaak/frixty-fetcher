// Video download handler: runs yt-dlp on a resolved URL/format,
// streams progress back to the popup, and reports the final file path.
// Used by the video picker (single-video tweets, YouTube, etc.) — the
// multi-file gallery path lives in gallery.go.
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"strings"

	"github.com/ilobaak/frixty-fetcher/host/internal/jobs"
	"github.com/ilobaak/frixty-fetcher/host/internal/ytdlp"
)

func (s *server) handleDownload(req request) {
	if s.ytBin() == "" {
		s.sendJobError(req.JobID, "ytdlp_missing", "yt-dlp binary not found")
		return
	}
	if req.JobID == "" {
		s.sendRequestError(req.ReqID, "bad_request", "download requires jobId")
		return
	}
	// Everything after validation runs in a goroutine because the optional
	// folder dialog blocks until the user dismisses it, and the serve loop
	// must stay responsive (e.g. to cancel).
	go s.runDownload(req)
}

func (s *server) runDownload(req request) {
	log.Printf("[frixty/host] download start job=%s url=%q kind=%s cookies=%t askPath=%t", req.JobID, req.URL, req.Selection.Kind, req.CookiesText != "", req.AskPath)
	var destDir, outputPath string

	if req.AskPath {
		picked, err := s.promptSavePath(req, "Save download as…")
		if err != nil {
			return // error already sent to extension
		}
		outputPath = picked
	} else {
		d, err := resolveDestDir(req.DestDir)
		if err != nil {
			s.sendJobError(req.JobID, "bad_destdir", err.Error())
			return
		}
		// Optional subfolder: "Download to new folder" on the video
		// picker routes its album name through the same albumName slot
		// the gallery flow uses. yt-dlp -P creates the folder on its
		// own if it's missing, but we mkdir eagerly so a permission
		// failure surfaces before we spawn yt-dlp.
		if req.AlbumName != "" {
			joined, err := joinAlbumDir(d, req.AlbumName)
			if err != nil {
				s.sendJobError(req.JobID, "bad_request", err.Error())
				return
			}
			d = joined
			if err := os.MkdirAll(d, 0o755); err != nil {
				s.sendJobError(req.JobID, "write_failed", err.Error())
				return
			}
		}
		destDir = d
	}

	jobID := req.JobID
	onProgress := func(p ytdlp.Progress) {
		s.send(map[string]any{
			"type":    "progress",
			"jobId":   jobID,
			"percent": p.Percent,
			"speed":   p.Speed,
			"eta":     p.ETA,
			"stage":   p.Stage,
		})
	}

	ctx := context.Background()
	cookiesFile, cookiesCleanup, err := writeCookiesTemp(req.CookiesText)
	if err != nil {
		s.sendJobError(jobID, "cookies_write_failed", err.Error())
		return
	}
	defer cookiesCleanup()
	argv := ytdlp.BuildArgs(req.Selection, destDir, outputPath, req.URL, cookiesFile, req.FilenameTemplate)
	cmd, result, err := ytdlp.Run(ctx, s.ytBin(), argv, onProgress)
	if err != nil {
		s.sendJobError(jobID, "spawn_failed", err.Error())
		return
	}
	s.jobs.Add(jobID, jobs.KillFunc(cmd))

	waitErr := cmd.Wait()
	// Wait() above only synchronizes with the process. The parser
	// goroutine that populates result.{FinalPath,ParseErr,StdoutLeftover}
	// is a separate goroutine; block on it before reading those fields.
	result.Wait()
	// Check cancel state BEFORE Remove clears it. A user-initiated
	// cancel also produces a non-nil waitErr (exit status from the
	// killed process), but reporting that as "download_failed: exit
	// status 1" confuses users — surface it as a distinct code the
	// extension renders as "Canceled" (informational, not an error).
	canceled := s.jobs.WasCanceled(jobID)
	s.jobs.Remove(jobID)
	if canceled {
		s.sendJobError(jobID, "download_canceled", "Download canceled.")
		return
	}
	if waitErr != nil {
		msg := formatDownloadErr(waitErr, result.Stderr(), result.StdoutLeftover, argv)
		log.Printf("[frixty/host] download error job=%s url=%q err=%s", jobID, req.URL, msg)
		s.sendJobError(jobID, "download_failed", msg)
		return
	}
	if result.ParseErr != nil {
		log.Printf("[frixty/host] download parse error job=%s url=%q err=%v", jobID, req.URL, result.ParseErr)
		s.sendJobError(jobID, "parse_failed", result.ParseErr.Error())
		return
	}
	var size int64
	if st, statErr := os.Stat(result.FinalPath); statErr == nil {
		size = st.Size()
	}
	s.send(map[string]any{
		"type":  "done",
		"jobId": jobID,
		"path":  result.FinalPath,
		"bytes": size,
	})
	log.Printf("[frixty/host] download done job=%s path=%q bytes=%d", jobID, result.FinalPath, size)
}

// formatDownloadErr builds a user-facing error message from yt-dlp's
// exit status + stderr + stdout leftover + argv. Preference order:
//
//  1. ERROR: lines from stderr — the canonical yt-dlp diagnostic.
//  2. ERROR: lines from stdout leftover (some yt-dlp builds put
//     extractor errors on stdout when --print is active).
//  3. Last non-empty stderr line (tracebacks, RuntimeErrors).
//  4. Last non-empty stdout leftover line.
//  5. Bare exit status + a condensed argv dump so the user can
//     reproduce the invocation in a terminal. This is the "yt-dlp
//     failed silently" path — rare but possible.
//
// "exit status 1" alone tells the user nothing; this function always
// gives them SOMETHING they can act on or paste into a bug report.
func formatDownloadErr(waitErr error, stderr, stdoutLeftover string, argv []string) string {
	exitInfo := waitErr.Error()
	stderr = strings.TrimSpace(stderr)
	stdoutLeftover = strings.TrimSpace(stdoutLeftover)

	if line := firstErrorLine(stderr); line != "" {
		return fmt.Sprintf("%s (%s)", line, exitInfo)
	}
	if line := firstErrorLine(stdoutLeftover); line != "" {
		return fmt.Sprintf("%s (%s)", line, exitInfo)
	}
	if line := lastNonEmptyLine(stderr); line != "" {
		return fmt.Sprintf("%s (%s)", line, exitInfo)
	}
	if line := lastNonEmptyLine(stdoutLeftover); line != "" {
		return fmt.Sprintf("%s (%s)", line, exitInfo)
	}
	// Truly no diagnostic — include a condensed argv so the user can
	// reproduce in a shell. Tag with a "silent" marker so the popup
	// can recognize this state and suggest running the command
	// manually.
	return fmt.Sprintf("%s — yt-dlp emitted no diagnostic. Invocation: %s", exitInfo, condensedArgv(argv))
}

// firstErrorLine returns the first line starting with "ERROR:" in
// the given blob (CRLF/LF-tolerant), joining multiple hits with " / ".
func firstErrorLine(blob string) string {
	if blob == "" {
		return ""
	}
	var errs []string
	for _, ln := range strings.Split(blob, "\n") {
		ln = strings.TrimRight(ln, "\r")
		if strings.HasPrefix(ln, "ERROR:") {
			errs = append(errs, ln)
		}
	}
	return strings.Join(errs, " / ")
}

// lastNonEmptyLine returns the last non-empty trimmed line of blob.
func lastNonEmptyLine(blob string) string {
	if blob == "" {
		return ""
	}
	lines := strings.Split(blob, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		ln := strings.TrimSpace(strings.TrimRight(lines[i], "\r"))
		if ln != "" {
			return ln
		}
	}
	return ""
}

// condensedArgv renders a yt-dlp argv for display — strips the long
// --progress-template / --print format strings (noise the user
// doesn't need), keeps the meaningful flags (-f, -o, --cookies, URL).
func condensedArgv(argv []string) string {
	var out []string
	skipNext := false
	noisy := map[string]bool{
		"--progress-template": true,
		"--print":             true,
	}
	for _, a := range argv {
		if skipNext {
			skipNext = false
			continue
		}
		if noisy[a] {
			skipNext = true
			continue
		}
		// Escape arguments that contain whitespace so the condensed
		// line is pasteable.
		if strings.ContainsAny(a, " \t") {
			out = append(out, fmt.Sprintf("%q", a))
		} else {
			out = append(out, a)
		}
	}
	return "yt-dlp " + strings.Join(out, " ")
}
