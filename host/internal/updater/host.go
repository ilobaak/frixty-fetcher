package updater

// HostUpdater self-updates the running frixtyhost binary against this
// repo's GitHub Releases. It mirrors the yt-dlp Updater pattern in this
// package: fetch latest release tag, compare to the embedded
// HostVersion, download the per-OS asset, verify SHA-256 against a
// published sidecar, atomically replace the binary on disk.
//
// "Self-update of a running .exe" caveat: on Windows the running
// process holds an executable lock, but Windows DOES allow renaming a
// locked .exe (the lock prevents writes, not directory operations).
// Pattern: rename current → ".old", move new into place. The currently-
// running frixtyhost still uses the old bytes from memory; the next
// time Chrome spawns the host (e.g. on next browser restart or first
// download after extension reload), the new binary runs. macOS and
// Linux don't lock executables at all.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

const (
	// hostReleasesAPI / hostDownloadBase point at this project's repo on
	// GitHub. The releases API returns the latest tag name + the list
	// of attached assets; the download base resolves "/<assetname>" to
	// the actual asset under "/releases/latest/download/...".
	hostReleasesAPI  = "https://api.github.com/repos/ilobaak/frixty-fetcher/releases/latest"
	hostDownloadBase = "https://github.com/ilobaak/frixty-fetcher/releases/latest/download/"
)

// HostUpdater is a separate type from Updater because the two operate
// on different binaries with different lifetimes (yt-dlp lives in a
// managed config-dir path; the host lives at its install dir, found
// via os.Executable()), and because the running host can't replace
// its own bytes in memory — only the on-disk file. Sharing the same
// struct would conflate two different installation models.
type HostUpdater struct {
	http         *http.Client
	apiURL       string
	downloadBase string
}

// NewHostUpdater constructs a HostUpdater bound to this repo's
// releases.
func NewHostUpdater() *HostUpdater {
	return &HostUpdater{
		http:         &http.Client{Timeout: downloadTimeout},
		apiURL:       hostReleasesAPI,
		downloadBase: hostDownloadBase,
	}
}

// SetEndpointsForTest redirects the updater at an httptest.Server.
func (u *HostUpdater) SetEndpointsForTest(apiURL, downloadBase string) {
	u.apiURL = apiURL
	u.downloadBase = downloadBase
}

// hostAssetName picks the per-OS asset filename. Releases must publish
// these names with each tag. Convention: frixtyhost-<goos>-<goarch>
// with the .exe suffix on Windows.
//
// Today only amd64 is shipped; if/when arm64 is added, the convention
// extends naturally and the host's runtime.GOARCH lookup picks up the
// right file.
func hostAssetName() string {
	suffix := ""
	if runtime.GOOS == "windows" {
		suffix = ".exe"
	}
	return fmt.Sprintf("frixtyhost-%s-%s%s", runtime.GOOS, runtime.GOARCH, suffix)
}

// CheckLatest fetches the tag of the latest release.
func (u *HostUpdater) CheckLatest(ctx context.Context) (string, error) {
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
		return "", fmt.Errorf("releases API: HTTP %d", resp.StatusCode)
	}
	var data struct {
		TagName string `json:"tag_name"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return "", fmt.Errorf("decode releases response: %w", err)
	}
	tag := strings.TrimSpace(data.TagName)
	if tag == "" {
		return "", errors.New("releases API returned empty tag_name")
	}
	return strings.TrimPrefix(tag, "v"), nil
}

// Update compares the current host version (passed in) against the
// latest release. If they differ, downloads the new binary, verifies
// SHA-256 against the published sidecar, and atomically replaces the
// running binary on disk. Returns (current, latest, replaced, err).
//
// `replaced` is true only when the on-disk binary actually changed.
// "already up to date" returns (v, v, false, nil).
//
// The newly-installed binary takes effect on the next host launch
// (Chrome respawns frixtyhost on the next download or extension
// reload). The currently-running process keeps using its old bytes
// until it exits.
func (u *HostUpdater) Update(ctx context.Context, currentVersion string) (string, string, bool, error) {
	latest, err := u.CheckLatest(ctx)
	if err != nil {
		return currentVersion, "", false, fmt.Errorf("check latest: %w", err)
	}
	current := strings.TrimPrefix(currentVersion, "v")
	if current == latest {
		return current, latest, false, nil
	}

	// Resolve the running binary's path.
	dest, err := os.Executable()
	if err != nil {
		return current, latest, false, fmt.Errorf("locate self: %w", err)
	}
	dest, err = filepath.EvalSymlinks(dest)
	if err != nil {
		return current, latest, false, fmt.Errorf("resolve self path: %w", err)
	}

	asset := hostAssetName()
	expectedSHA, err := u.fetchHostExpectedSHA256(ctx, asset)
	if err != nil {
		return current, latest, false, fmt.Errorf("checksum unavailable, refusing to install: %w", err)
	}

	if err := u.downloadAndReplace(ctx, dest, asset, expectedSHA); err != nil {
		return current, latest, false, err
	}
	return current, latest, true, nil
}

// fetchHostExpectedSHA256 fetches the .sha256 sidecar published next to
// the host binary asset and returns the expected hex digest. Each
// release MUST publish "<assetName>.sha256" alongside the binary.
func (u *HostUpdater) fetchHostExpectedSHA256(ctx context.Context, assetName string) (string, error) {
	url := u.downloadBase + assetName + ".sha256"
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
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	text := strings.TrimSpace(string(body))
	if text == "" {
		return "", errors.New("empty sums sidecar")
	}
	// Sidecar format: "<hex>" or "<hex>  <filename>" (GNU coreutils).
	fields := strings.Fields(text)
	digest := strings.ToLower(fields[0])
	if len(digest) != 64 {
		return "", fmt.Errorf("malformed digest in sidecar: %q", digest)
	}
	return digest, nil
}

// downloadAndReplace fetches the asset, verifies its SHA-256, and
// atomically swaps the running binary out for the new one. The OLD
// binary is renamed to "<dest>.old" rather than deleted so a botched
// update can be undone by hand. The next launch of frixtyhost (which
// will be the new binary) cleans up any stale .old siblings via
// CleanupOldSelf.
func (u *HostUpdater) downloadAndReplace(ctx context.Context, dest, assetName, expectedSHA string) error {
	url := u.downloadBase + assetName
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
	if _, err := io.Copy(io.MultiWriter(f, hasher), resp.Body); err != nil {
		f.Close()
		os.Remove(tmp)
		return fmt.Errorf("write new: %w", err)
	}
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

	// Capture the new binary's size BEFORE the destructive swap so
	// we can verify the dest binary post-rename matches what we
	// downloaded. Any divergence means a partial / interrupted
	// rename that didn't surface as an error.
	tmpInfo, err := os.Stat(tmp)
	if err != nil {
		os.Remove(tmp)
		return fmt.Errorf("stat new binary: %w", err)
	}
	expectedSize := tmpInfo.Size()

	old := dest + ".old"
	_ = os.Remove(old) // any stale leftover from a prior update
	if err := os.Rename(dest, old); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("move running binary aside: %w", err)
	}
	if err := os.Rename(tmp, dest); err != nil {
		// Best-effort restore so the install still has SOMETHING runnable.
		if restoreErr := os.Rename(old, dest); restoreErr != nil {
			// Both renames failed — the running binary is at .old but
			// the dest slot is empty. The host is unbootable until the
			// user manually renames .old back. Surface enough state so
			// support can talk a user through recovery.
			return fmt.Errorf(
				"install new binary failed (%w) AND restore of previous binary failed (%v); "+
					"manual recovery: rename %q back to %q",
				err, restoreErr, old, dest,
			)
		}
		os.Remove(tmp)
		return fmt.Errorf("install new binary: %w", err)
	}
	// Post-swap verification: confirm the new binary actually landed.
	// A successful os.Rename on Windows can still leave dest empty on
	// some filesystems if the underlying NT operation got mangled
	// (rare but documented). Catching it here lets us roll back to
	// the .old copy before the user runs the broken binary.
	if destInfo, err := os.Stat(dest); err != nil || destInfo.Size() != expectedSize {
		_ = os.Rename(old, dest) // restore previous version
		if err != nil {
			return fmt.Errorf("post-install verification failed (stat dest): %w", err)
		}
		return fmt.Errorf("post-install verification failed: expected %d bytes at %q, got %d", expectedSize, dest, destInfo.Size())
	}
	return nil
}

// CleanupOldSelf removes a stale ".old" sibling left by a prior
// Update. Called once at host launch so successful updates don't
// accumulate orphan files. Errors are non-fatal — the .old file is
// just disk waste, not broken state.
func CleanupOldSelf() {
	self, err := os.Executable()
	if err != nil {
		return
	}
	self, err = filepath.EvalSymlinks(self)
	if err != nil {
		return
	}
	_ = os.Remove(self + ".old")
}
