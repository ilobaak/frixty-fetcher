// Command frixtyhost is the Chrome Native Messaging Host for Frixty Fetcher.
// It reads length-prefixed JSON requests from stdin, dispatches by action,
// and writes framed JSON responses to stdout. It is not intended to be run
// interactively — Chrome launches it as a subprocess.
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/ilobaak/frixty-fetcher/host/internal/hostlog"
	"github.com/ilobaak/frixty-fetcher/host/internal/jobs"
	"github.com/ilobaak/frixty-fetcher/host/internal/messaging"
	"github.com/ilobaak/frixty-fetcher/host/internal/probe"
	"github.com/ilobaak/frixty-fetcher/host/internal/updater"
	"github.com/ilobaak/frixty-fetcher/host/internal/ytdlp"
	"github.com/ncruces/zenity"
)

const (
	HostVersion        = "1.0.0"
	listFormatsTimeout = 30 * time.Second
	selfUpdateTimeout  = 5 * time.Minute
)

type request struct {
	Action          string          `json:"action"`
	URL             string          `json:"url,omitempty"`
	JobID           string          `json:"jobId,omitempty"`
	ReqID           string          `json:"reqId,omitempty"`
	Selection       ytdlp.Selection `json:"selection,omitempty"`
	DestDir         string          `json:"destDir,omitempty"`
	AskPath         bool            `json:"askPath,omitempty"`         // open Save As dialog before download
	AskDir          bool            `json:"askDir,omitempty"`          // open folder picker (galleries — multiple files to one folder)
	AskPerItem      bool            `json:"askPerItem,omitempty"`      // per-item Save As dialog for galleries
	DefaultFileName string          `json:"defaultFileName,omitempty"` // pre-filled name in the Save As dialog
	StartDir        string          `json:"startDir,omitempty"`        // initial directory for the dialog
	DialogTitle     string          `json:"dialogTitle,omitempty"`
	AlbumName       string          `json:"albumName,omitempty"` // subfolder inside destDir for gallery downloads
	Items           []galleryItem   `json:"items,omitempty"`     // gallery item list (url + ext per entry)
	Path             string          `json:"path,omitempty"`      // used by revealInFileManager
	CookiesText      string          `json:"cookiesText,omitempty"` // Netscape cookies.txt content; written to a temp file and passed to yt-dlp --cookies
	FilenameTemplate string          `json:"filenameTemplate,omitempty"` // yt-dlp -o template; empty = default "%(title)s.%(ext)s"
	Kind             string          `json:"kind,omitempty"`             // downloadUrl-level Kind (combined/audio/video) — same semantics as galleryItem.Kind
}

type galleryItem struct {
	URL  string `json:"url"`
	Ext  string `json:"ext,omitempty"`
	Name string `json:"name,omitempty"` // optional override filename; when set, used verbatim (popup pre-sanitizes)
	// Kind is the audio/video selector for video items: "combined"
	// (default, direct download), "audio" (yt-dlp -x → m4a), or "video"
	// (direct download + ffmpeg -an to strip audio). Empty / absent means
	// "combined". Ignored for image items.
	Kind string `json:"kind,omitempty"`
}

// safeWriter serializes writes to stdout. Progress events arrive on goroutines
// spawned per-download, and every one of them shares the same pipe.
type safeWriter struct {
	mu sync.Mutex
	w  io.Writer
}

func (s *safeWriter) Send(v any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return messaging.Write(s.w, v)
}

type server struct {
	out         *safeWriter
	jobs        *jobs.Tracker
	updater     *updater.Updater
	hostUpdater *updater.HostUpdater
	// resolveYt, when non-nil, overrides the normal ytdlp.Resolve() lookup.
	// Tests set it to simulate "yt-dlp missing" without having to munge PATH
	// or the managed-binary location.
	resolveYt func() string
	// fetchAndConvert downloads url to destPath, optionally with the
	// kind-specific audio/video post-processing step. Stored as a field
	// (rather than a plain method) so the gallery and downloadUrl
	// handlers can be tested without spawning yt-dlp/ffmpeg — tests
	// substitute a deterministic fake. Production wires it to
	// defaultFetchAndConvert at server construction time.
	fetchAndConvert func(ctx context.Context, url, destPath, kind string) (string, error)
	// inflight tracks short-lived dispatch goroutines (listFormats,
	// pickFolder, selfUpdate). Tests Wait on it after dispatch; production
	// can use it for graceful shutdown if we ever care. Long-running
	// handlers (download, downloadGallery) are tracked through s.jobs and
	// intentionally NOT counted here — they shouldn't block shutdown.
	inflight sync.WaitGroup
}

// goHandler dispatches fn on a goroutine and ticks the inflight WaitGroup
// around it. Use this for any short-lived handler that must not block the
// serve loop but that tests need to wait on.
func (s *server) goHandler(fn func()) {
	s.inflight.Add(1)
	go func() {
		defer s.inflight.Done()
		fn()
	}()
}

// ytBin resolves the yt-dlp path fresh on each call so background updates
// (which replace the managed binary mid-session) are picked up by the next
// request without the host having to restart.
func (s *server) ytBin() string {
	if s.resolveYt != nil {
		return s.resolveYt()
	}
	p, _ := ytdlp.Resolve()
	return p
}

func main() {
	// Any accidental write to stdout corrupts the native messaging stream.
	// Wire log to a file under the user config dir alongside stderr so
	// users reporting bugs can attach a frixtyhost.log instead of being
	// asked to enable Chrome's native-messaging-host stderr capture.
	closeLog := hostlog.Wire()
	defer closeLog.Close()
	log.Printf("frixtyhost %s starting (goos=%s)", HostVersion, runtime.GOOS)

	// Best-effort cleanup of a stale ".old" sibling left by a previous
	// host self-update. Disk hygiene only — failure here is fine.
	updater.CleanupOldSelf()

	out := &safeWriter{w: os.Stdout}
	tracker := jobs.New()
	up := updater.New()
	hostUp := updater.NewHostUpdater()

	s := &server{out: out, jobs: tracker, updater: up, hostUpdater: hostUp}
	s.fetchAndConvert = s.defaultFetchAndConvert

	// Kick off the download if the managed yt-dlp binary is missing
	// (first-run bootstrap) or the 12h throttle window has elapsed. Runs in
	// a goroutine so we don't block the serve loop; the next request after
	// this completes will pick up the new binary via ytBin().
	if !updater.ManagedExists() || up.ShouldAutoCheck() {
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), selfUpdateTimeout)
			defer cancel()
			if oldV, newV, err := up.Update(ctx, nil); err != nil {
				log.Printf("self-update: %v", err)
			} else if oldV != newV {
				log.Printf("self-update: %s → %s", oldV, newV)
			} else {
				log.Printf("self-update: up to date (%s)", newV)
			}
		}()
	}

	if err := s.serve(os.Stdin); err != nil && !errors.Is(err, io.EOF) {
		log.Printf("frixtyhost: %v", err)
	}
	tracker.CancelAll()
}

func (s *server) serve(in io.Reader) error {
	for {
		var req request
		if err := messaging.Read(in, &req); err != nil {
			return err
		}
		s.dispatch(req)
	}
}

func (s *server) dispatch(req request) {
	switch req.Action {
	case "version":
		s.handleVersion(req)
	case "probe":
		s.send(withReqID(req, map[string]any{"type": "probed", "supported": probe.Check(req.URL)}))
	case "listFormats":
		// listFormats spawns yt-dlp -J with up to listFormatsTimeout (30s)
		// of wall time. Run on a goroutine so the dispatch loop stays
		// responsive — a synchronous handler here blocks every other
		// request, including the user's cancel.
		s.goHandler(func() { s.handleListFormats(req) })
	case "download":
		s.handleDownload(req)
	case "cancel":
		s.handleCancel(req)
	case "pickFolder":
		s.goHandler(func() { s.handlePickFolder(req) })
	case "selfUpdate":
		s.goHandler(func() { s.handleSelfUpdate(req) })
	case "selfHostUpdate":
		s.goHandler(func() { s.handleSelfHostUpdate(req) })
	case "downloadUrl":
		s.handleDownloadUrl(req)
	case "downloadGallery":
		s.handleDownloadGallery(req)
	case "revealInFileManager":
		// Fire-and-forget. Failures are logged locally — the user can
		// always open their file manager by hand.
		if err := revealInFileManager(req.Path); err != nil {
			log.Printf("revealInFileManager(%q): %v", req.Path, err)
		}
	default:
		s.sendRequestError(req.ReqID, "unknown_action", fmt.Sprintf("unknown action %q", req.Action))
	}
}

// handleSelfUpdate bypasses the auto-update throttle — users explicitly
// clicked the button and want a definitive answer now. Downloads the
// latest release straight from GitHub into the extension's managed
// location, regardless of whatever other yt-dlp the user might have
// installed (pip, scoop, brew). Returns before/after versions so the UI
// can distinguish "was already up to date" from "just updated".
// handleSelfHostUpdate runs the Frixty Fetcher native-host self-update.
// Distinct from handleSelfUpdate (which updates yt-dlp) — this updates
// the frixtyhost binary itself, downloading from the project's GitHub
// Releases. The newly-installed binary takes effect on the next host
// launch (Chrome respawns frixtyhost on the next download), not
// instantly — the running process keeps using its old in-memory bytes
// until it exits.
func (s *server) handleSelfHostUpdate(req request) {
	ctx, cancel := context.WithTimeout(context.Background(), selfUpdateTimeout)
	defer cancel()
	oldVersion, newVersion, replaced, err := s.hostUpdater.Update(ctx, HostVersion)
	if err != nil {
		s.sendRequestError(req.ReqID, "host_update_failed", err.Error())
		return
	}
	s.send(withReqID(req, map[string]any{
		"type":       "hostUpdated",
		"oldVersion": oldVersion,
		"newVersion": newVersion,
		"replaced":   replaced,
	}))
}

func (s *server) handleSelfUpdate(req request) {
	ctx, cancel := context.WithTimeout(context.Background(), selfUpdateTimeout)
	defer cancel()
	onProgress := func(p updater.Progress) {
		s.send(map[string]any{
			"type":       "updateProgress",
			"downloaded": p.Downloaded,
			"total":      p.Total,
		})
	}
	oldVersion, newVersion, err := s.updater.Update(ctx, onProgress)
	if err != nil {
		s.sendRequestError(req.ReqID, "update_failed", err.Error())
		return
	}
	s.send(withReqID(req, map[string]any{
		"type":       "updated",
		"oldVersion": oldVersion,
		"newVersion": newVersion,
	}))
}



// revealInFileManager opens the OS file manager at the given path. For a
// file, it opens the containing folder with the file highlighted where the
// platform supports it (Windows Explorer, macOS Finder). For a directory,
// it opens that directory.
func revealInFileManager(path string) error {
	if path == "" {
		return errors.New("empty path")
	}
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	isDir := info.IsDir()

	switch runtime.GOOS {
	case "windows":
		if isDir {
			return exec.Command("explorer", path).Start()
		}
		return revealSelectWindows(path)
	case "darwin":
		if isDir {
			return exec.Command("open", path).Start()
		}
		return exec.Command("open", "-R", path).Start()
	case "linux":
		// Linux file managers don't share a "select file" convention; open
		// the containing directory, which is the next best thing.
		// xdg-open is canonical but not always installed on minimal /
		// container distros, so we try it first and fall back to the
		// best-known DE-specific opener whose binary is on PATH.
		target := path
		if !isDir {
			target = filepath.Dir(path)
		}
		openers := []string{"xdg-open", "gio", "gnome-open", "kde-open", "kde-open5", "exo-open", "gvfs-open"}
		var lastErr error
		for _, opener := range openers {
			if _, err := exec.LookPath(opener); err != nil {
				continue
			}
			args := []string{target}
			if opener == "gio" {
				// gio uses `gio open <path>`, not bare path
				args = []string{"open", target}
			}
			if err := exec.Command(opener, args...).Start(); err == nil {
				return nil
			} else {
				lastErr = err
			}
		}
		if lastErr != nil {
			return fmt.Errorf("no working file-manager opener on PATH: %w", lastErr)
		}
		return errors.New("no file-manager opener found (install xdg-utils, gnome-open, or kde-open)")
	default:
		return fmt.Errorf("unsupported OS: %s", runtime.GOOS)
	}
}

// handlePickFolder opens a native folder-browse dialog and responds with
// either the chosen absolute path or a structured cancel/error. Runs in a
// goroutine — Browse() blocks until the user dismisses the dialog, which
// could be seconds or minutes, and we must keep serving other requests.
func (s *server) handlePickFolder(req request) {
	title := req.DialogTitle
	if title == "" {
		title = "Frixty Fetcher — Choose folder"
	}
	path, err := zenity.SelectFile(zenity.Directory(), zenity.Title(title))
	if errors.Is(err, zenity.ErrCanceled) {
		s.send(withReqID(req, map[string]any{"type": "folderPicked", "canceled": true}))
		return
	}
	if err != nil {
		s.sendRequestError(req.ReqID, "picker_failed", err.Error())
		return
	}
	s.send(withReqID(req, map[string]any{"type": "folderPicked", "path": path}))
}

func (s *server) handleVersion(req request) {
	resp := map[string]any{
		"type": "version",
		"host": HostVersion,
	}
	bin := s.ytBin()
	if bin == "" {
		resp["ytDlp"] = ""
	} else if v, err := ytdlp.Version(bin); err == nil {
		resp["ytDlp"] = v
	} else {
		resp["ytDlp"] = "error: " + err.Error()
	}
	s.send(withReqID(req, resp))
}


func (s *server) handleCancel(req request) {
	if req.JobID == "" {
		s.sendRequestError(req.ReqID, "bad_request", "cancel requires jobId")
		return
	}
	if !s.jobs.Cancel(req.JobID) {
		s.sendJobError(req.JobID, "unknown_job", "no such job")
	}
	// On a successful cancel, the running download goroutine will emit a
	// download_failed error when Wait() returns — that's the user-visible
	// signal. No extra message from here.
}

func (s *server) send(v any) {
	if err := s.out.Send(v); err != nil {
		log.Printf("send: %v", err)
	}
}

// sendRequestError responds to a reqId-correlated request (listFormats,
// version, cancel-without-job) with a structured error.
func (s *server) sendRequestError(reqID, code, msg string) {
	payload := map[string]any{
		"type":    "error",
		"code":    code,
		"message": msg,
	}
	if reqID != "" {
		payload["reqId"] = reqID
	}
	s.send(payload)
}

// sendJobError responds to a job-scoped action (download, cancel) with an
// error carrying jobId so the SW can fold it into the jobs map.
func (s *server) sendJobError(jobID, code, msg string) {
	payload := map[string]any{
		"type":    "error",
		"code":    code,
		"message": msg,
	}
	if jobID != "" {
		payload["jobId"] = jobID
	}
	s.send(payload)
}

func withReqID(req request, resp map[string]any) map[string]any {
	if req.ReqID != "" {
		resp["reqId"] = req.ReqID
	}
	return resp
}

// defaultDestDir returns the user's Downloads folder when we can locate it.
func defaultDestDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	d := filepath.Join(home, "Downloads")
	if st, err := os.Stat(d); err == nil && st.IsDir() {
		return d, nil
	}
	return home, nil
}

// resolveDestDir expands ~/ and verifies the requested path exists and is a
// directory. An empty request uses the OS default Downloads folder. The
// return value is always an absolute path ready to pass to yt-dlp -P.
func resolveDestDir(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return defaultDestDir()
	}
	expanded, err := expandHome(raw)
	if err != nil {
		return "", err
	}
	if !filepath.IsAbs(expanded) {
		return "", fmt.Errorf("destDir must be an absolute path: %s", raw)
	}
	st, err := os.Stat(expanded)
	if err != nil {
		return "", fmt.Errorf("destDir does not exist: %s", expanded)
	}
	if !st.IsDir() {
		return "", fmt.Errorf("destDir is not a directory: %s", expanded)
	}
	return expanded, nil
}

// expandHome replaces a leading ~ (alone or before a separator) with the
// user's home directory. Other paths are returned unchanged.
func expandHome(p string) (string, error) {
	if p == "~" || strings.HasPrefix(p, "~/") || strings.HasPrefix(p, `~\`) {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		if p == "~" {
			return home, nil
		}
		return filepath.Join(home, p[2:]), nil
	}
	return p, nil
}
