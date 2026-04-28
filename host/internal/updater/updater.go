// Package updater owns the extension's private yt-dlp binary. Instead of
// calling `yt-dlp -U` (which fails for pip/wheel/scoop/homebrew/etc. users
// whose yt-dlp refuses self-replacement), we download the official release
// binary straight from yt-dlp's GitHub releases into a known managed path
// under os.UserConfigDir(). The host's ytdlp.Resolve() then prefers that
// managed path over PATH, so the user's system yt-dlp (however installed)
// is left alone and the extension always runs a known-good version.
package updater

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

const (
	DefaultInterval    = 12 * time.Hour
	githubReleasesAPI  = "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest"
	githubDownloadBase = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/"
	downloadTimeout    = 5 * time.Minute
	userAgent          = "frixty-fetcher-updater"

	// stateDirName is the per-product folder under os.UserConfigDir()
	// that holds updater.json and the managed yt-dlp binary. Renamed
	// from the legacy product name in 2026-04 — see migrateLegacyStateDir
	// for the on-launch one-time move.
	stateDirName       = "frixty-fetcher"
	legacyStateDirName = "yt-dlp-extension"
)

// State is what we persist between runs. Survives host restarts via a small
// JSON file under os.UserConfigDir().
type State struct {
	LastCheckUnix int64  `json:"lastCheck"`
	LastVersion   string `json:"lastVersion,omitempty"`
}

// Progress reports how far along a yt-dlp download is. Total is 0 when the
// server doesn't advertise Content-Length (rare for GitHub releases but
// possible).
type Progress struct {
	Downloaded int64
	Total      int64
}

type updateResult struct {
	oldVersion, newVersion string
	err                    error
}

type Updater struct {
	statePath    string
	interval     time.Duration
	http         *http.Client
	apiURL       string // GitHub releases API endpoint; overridable for tests
	downloadBase string // base URL for asset downloads; overridable for tests

	mu        sync.Mutex
	running   bool
	listeners []func(Progress)
	done      chan struct{}
	result    updateResult
}

func New() *Updater {
	// Best-effort one-time relocation of the pre-rename state dir. Any
	// error is non-fatal: at worst the user re-downloads yt-dlp on the
	// next launch.
	if base, err := os.UserConfigDir(); err == nil && base != "" {
		_ = migrateLegacyStateDir(base)
	}
	return &Updater{
		statePath:    defaultStatePath(),
		interval:     DefaultInterval,
		http:         &http.Client{Timeout: downloadTimeout},
		apiURL:       githubReleasesAPI,
		downloadBase: githubDownloadBase,
	}
}

// NewForTest lets tests point the state file at a tempdir and control the
// interval without touching the real user config directory.
func NewForTest(statePath string, interval time.Duration) *Updater {
	return &Updater{
		statePath:    statePath,
		interval:     interval,
		http:         &http.Client{Timeout: downloadTimeout},
		apiURL:       githubReleasesAPI,
		downloadBase: githubDownloadBase,
	}
}

// SetEndpointsForTest overrides the GitHub API + download base URLs.
// Tests use this to redirect the updater at an httptest.Server.
func (u *Updater) SetEndpointsForTest(apiURL, downloadBase string) {
	u.apiURL = apiURL
	u.downloadBase = downloadBase
}

// ManagedBinaryPath is the filesystem location the extension manages its
// own yt-dlp copy at. Deliberately separate from any system-level or
// package-manager install so the two don't fight over ownership.
func ManagedBinaryPath() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil || base == "" {
		return "", err
	}
	return filepath.Join(base, stateDirName, "bin", managedBinaryName()), nil
}

// ManagedExists reports whether the managed yt-dlp binary is present on
// disk right now. Used on launch to decide whether we need to bootstrap.
func ManagedExists() bool {
	p, err := ManagedBinaryPath()
	if err != nil || p == "" {
		return false
	}
	_, err = os.Stat(p)
	return err == nil
}

func managedBinaryName() string {
	if runtime.GOOS == "windows" {
		return "yt-dlp.exe"
	}
	return "yt-dlp"
}

// githubAssetName picks the right release asset filename for this OS. yt-dlp
// ships a .exe for Windows, a "_macos" universal binary, and a plain "yt-dlp"
// for Linux/other.
func githubAssetName() string {
	switch runtime.GOOS {
	case "windows":
		return "yt-dlp.exe"
	case "darwin":
		return "yt-dlp_macos"
	default:
		return "yt-dlp"
	}
}

// ShouldAutoCheck reports whether enough time has elapsed since the last
// successful check for an auto-update to fire on this launch.
func (u *Updater) ShouldAutoCheck() bool {
	s, err := u.LoadState()
	if err != nil {
		return true
	}
	if s.LastCheckUnix == 0 {
		return true
	}
	return time.Since(time.Unix(s.LastCheckUnix, 0)) > u.interval
}

// Update checks GitHub for the latest release and downloads it into the
// managed path if it's different from what's already there. Returns
// (currentVersion, newVersion, error). currentVersion is empty when no
// managed binary existed before this call. A no-op "already up to date"
// case returns (v, v, nil).
//
// Concurrent callers piggy-back on an in-flight update rather than failing:
// the second caller waits for the first to finish and returns the same
// result. Progress callbacks from all callers receive events while the
// download is running.
func (u *Updater) Update(ctx context.Context, onProgress func(Progress)) (string, string, error) {
	u.mu.Lock()
	if u.running {
		if onProgress != nil {
			u.listeners = append(u.listeners, onProgress)
		}
		done := u.done
		u.mu.Unlock()
		select {
		case <-done:
		case <-ctx.Done():
			return "", "", ctx.Err()
		}
		u.mu.Lock()
		r := u.result
		u.mu.Unlock()
		return r.oldVersion, r.newVersion, r.err
	}
	u.running = true
	u.done = make(chan struct{})
	if onProgress != nil {
		u.listeners = append(u.listeners, onProgress)
	}
	u.mu.Unlock()

	old, latest, err := u.doUpdate(ctx)

	u.mu.Lock()
	u.result = updateResult{oldVersion: old, newVersion: latest, err: err}
	u.listeners = nil
	u.running = false
	close(u.done)
	u.mu.Unlock()

	return old, latest, err
}

// emitProgress fans a single Progress value out to every current
// listener. Each listener runs in its own goroutine so a slow callback
// (one popup whose IPC pipe is backed up, a debug logger doing fsync,
// etc.) doesn't stall delivery to the others. Progress values are
// monotonically increasing on `Downloaded`, so receivers don't need
// strict event ordering — they render the latest value they've seen.
//
// recover() guards against a panicking listener taking down the whole
// goroutine pool. We don't otherwise track listener completion: this
// is fire-and-forget by design (no backpressure, no per-listener
// channel queue) — appropriate for the 10 Hz emit cadence and short
// download lifetime.
func (u *Updater) emitProgress(p Progress) {
	u.mu.Lock()
	listeners := append([]func(Progress){}, u.listeners...)
	u.mu.Unlock()
	for _, fn := range listeners {
		go func(fn func(Progress)) {
			defer func() { _ = recover() }()
			fn(p)
		}(fn)
	}
}

func (u *Updater) doUpdate(ctx context.Context) (string, string, error) {
	dest, err := ManagedBinaryPath()
	if err != nil || dest == "" {
		return "", "", errors.New("couldn't locate user config directory")
	}

	latest, err := u.fetchLatestVersion(ctx)
	if err != nil {
		return "", "", fmt.Errorf("check latest: %w", err)
	}

	current := ""
	if _, err := os.Stat(dest); err == nil {
		out, _ := exec.CommandContext(ctx, dest, "--version").Output()
		current = strings.TrimSpace(string(out))
	}

	if current != "" && current == latest {
		_ = u.saveState(State{LastCheckUnix: time.Now().Unix(), LastVersion: current})
		return current, current, nil
	}

	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return current, "", fmt.Errorf("mkdir managed dir: %w", err)
	}

	if err := u.installTo(ctx, dest); err != nil {
		return current, "", err
	}
	_ = u.saveState(State{LastCheckUnix: time.Now().Unix(), LastVersion: latest})
	return current, latest, nil
}

func (u *Updater) fetchLatestVersion(ctx context.Context) (string, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", u.apiURL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept", "application/vnd.github+json")
	resp, err := u.http.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("GitHub releases API: HTTP %d", resp.StatusCode)
	}
	var data struct {
		TagName string `json:"tag_name"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return "", fmt.Errorf("decode GitHub response: %w", err)
	}
	tag := strings.TrimSpace(data.TagName)
	if tag == "" {
		return "", errors.New("GitHub returned empty tag_name")
	}
	return strings.TrimPrefix(tag, "v"), nil
}

// fetchExpectedSHA256 fetches the SHA2-256SUMS asset published with the
// latest yt-dlp release and returns the expected hex digest for the asset
// whose filename matches githubAssetName(). Returns an error if the sums
// file can't be fetched or doesn't list our asset.
//
// Used as the integrity gate in downloadBinary: a compromised CDN that
// serves us a tampered binary will not also be able to consistently
// rewrite SHA2-256SUMS for the same asset name, so a mismatch is
// treated as a hard failure.
func (u *Updater) fetchExpectedSHA256(ctx context.Context) (string, error) {
	url := u.downloadBase + "SHA2-256SUMS"
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", userAgent)
	resp, err := u.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("fetch sums: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("fetch sums: HTTP %d", resp.StatusCode)
	}
	want := githubAssetName()
	scanner := bufio.NewScanner(resp.Body)
	// Each line is: "<64-hex-sha256>  <filename>" — sometimes "*<filename>"
	// in binary-mode sums files. Tolerate both.
	for scanner.Scan() {
		ln := strings.TrimSpace(scanner.Text())
		if ln == "" || strings.HasPrefix(ln, "#") {
			continue
		}
		fields := strings.Fields(ln)
		if len(fields) < 2 {
			continue
		}
		digest := strings.ToLower(fields[0])
		name := strings.TrimPrefix(fields[1], "*")
		if name == want {
			if len(digest) != 64 {
				return "", fmt.Errorf("malformed digest for %q: %q", want, digest)
			}
			return digest, nil
		}
	}
	if err := scanner.Err(); err != nil {
		return "", fmt.Errorf("scan sums: %w", err)
	}
	return "", fmt.Errorf("no SHA2-256SUMS entry for %q", want)
}

// installTo fetches the latest yt-dlp release for this OS, verifies its
// SHA-256 against the SHA2-256SUMS published with the same release, and
// atomically places it at dest. Writes through a .new file first, then
// renames. The old copy (if any) is moved aside to .bak — if that rename
// fails (Windows file lock while a download is running), the update bails
// cleanly without damaging the working binary.
//
// Checksum verification is non-negotiable: this is a Chrome native-messaging
// host that runs the downloaded binary as the user, so a compromised CDN or
// MITM is a remote-code-execution vector.
func (u *Updater) installTo(ctx context.Context, dest string) error {
	expectedSHA, err := u.fetchExpectedSHA256(ctx)
	if err != nil {
		return fmt.Errorf("checksum unavailable, refusing to install: %w", err)
	}

	url := u.downloadBase + githubAssetName()
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", userAgent)
	resp, err := u.http.Do(req)
	if err != nil {
		return fmt.Errorf("download: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download: HTTP %d", resp.StatusCode)
	}

	tmp := dest + ".new"
	_ = os.Remove(tmp)
	f, err := os.Create(tmp)
	if err != nil {
		return fmt.Errorf("create new: %w", err)
	}
	hasher := sha256.New()
	pr := &progressReader{r: resp.Body, total: resp.ContentLength, emit: u.emitProgress}
	if _, err := io.Copy(io.MultiWriter(f, hasher), pr); err != nil {
		f.Close()
		os.Remove(tmp)
		return fmt.Errorf("write new: %w", err)
	}
	pr.flush()
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	gotSHA := hex.EncodeToString(hasher.Sum(nil))
	if !strings.EqualFold(gotSHA, expectedSHA) {
		os.Remove(tmp)
		return fmt.Errorf("checksum mismatch: expected %s, got %s — refusing to install possibly tampered binary", expectedSHA, gotSHA)
	}
	if runtime.GOOS != "windows" {
		if err := os.Chmod(tmp, 0o755); err != nil {
			os.Remove(tmp)
			return err
		}
	}

	bak := dest + ".bak"
	_ = os.Remove(bak)
	if _, err := os.Stat(dest); err == nil {
		if err := os.Rename(dest, bak); err != nil {
			os.Remove(tmp)
			return fmt.Errorf("move old aside (likely in use): %w", err)
		}
	}
	if err := os.Rename(tmp, dest); err != nil {
		// Try to restore the old binary so the host doesn't lose yt-dlp.
		_ = os.Rename(bak, dest)
		return fmt.Errorf("move new into place: %w", err)
	}
	_ = os.Remove(bak)
	return nil
}

// LoadState exposes the persisted state for callers that want to render it.
// Returns a zero State, nil error when no state file exists yet.
func (u *Updater) LoadState() (State, error) {
	var s State
	data, err := os.ReadFile(u.statePath)
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return s, err
	}
	err = json.Unmarshal(data, &s)
	return s, err
}

func (u *Updater) saveState(s State) error {
	if err := os.MkdirAll(filepath.Dir(u.statePath), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(u.statePath, data, 0o644)
}

// progressReader wraps an io.Reader and forwards byte-count updates to
// emit. Throttled to ~10 Hz so a 30 MB download produces a few dozen events
// instead of hundreds, which keeps the native-messaging pipe quiet.
type progressReader struct {
	r        io.Reader
	total    int64
	done     int64
	emit     func(Progress)
	lastEmit time.Time
}

func (pr *progressReader) Read(b []byte) (int, error) {
	n, err := pr.r.Read(b)
	if n > 0 {
		pr.done += int64(n)
		now := time.Now()
		if pr.emit != nil && now.Sub(pr.lastEmit) > 100*time.Millisecond {
			pr.lastEmit = now
			pr.emit(Progress{Downloaded: pr.done, Total: pr.total})
		}
	}
	return n, err
}

// flush emits a final Progress value so listeners see 100% even if the last
// Read slipped under the throttle window.
func (pr *progressReader) flush() {
	if pr.emit != nil {
		pr.emit(Progress{Downloaded: pr.done, Total: pr.total})
	}
}

func defaultStatePath() string {
	base, err := os.UserConfigDir()
	if err != nil || base == "" {
		base = "."
	}
	return filepath.Join(base, stateDirName, "updater.json")
}

// migrateLegacyStateDir relocates state from the pre-rename directory
// (yt-dlp-extension/) to the current one (frixty-fetcher/) for existing
// installs. The in-repo rename only changed source-level identifiers;
// without this, every user's filesystem still points at the old name
// and the host re-downloads yt-dlp because ManagedBinaryPath now looks
// somewhere new.
//
// Atomic via os.Rename when only the old dir exists. If the new dir
// already exists (rare — a previous run partially migrated, the user
// reinstalled, or both names exist for some other reason), we leave the
// old dir alone as an orphan so we don't risk merging two partial
// states. Idempotent — safe to call on every Updater.New().
//
// All errors are non-fatal and returned for the caller to log; the
// worst case is the user re-downloads yt-dlp on next launch.
func migrateLegacyStateDir(base string) error {
	if base == "" {
		return nil
	}
	oldDir := filepath.Join(base, legacyStateDirName)
	newDir := filepath.Join(base, stateDirName)
	oldInfo, err := os.Stat(oldDir)
	if err != nil {
		// Old dir absent → fresh install or already migrated. No-op.
		return nil
	}
	if !oldInfo.IsDir() {
		return nil
	}
	if _, err := os.Stat(newDir); err == nil {
		// Both exist; leave old alone.
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}
	return os.Rename(oldDir, newDir)
}
