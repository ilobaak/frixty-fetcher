// Package installer owns the production install/uninstall flow for the
// Frixty Fetcher native host. It is distinct from cmd/devinstall, which
// only registers a dev-built frixtyhost under the current user's Chrome.
package installer

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

// Package identity — these are shared with the native messaging manifest.
const (
	HostManifestName = "com.frixty.fetcher"
	AppDisplayName   = "Frixty Fetcher"
	AppVersion       = "1.0.0"
	// UninstallKeyName is what we register under HKCU\...\Uninstall.
	UninstallKeyName = "frixty-fetcher"
)

// DefaultInstallDir returns where binaries should be unpacked.
// Per-OS user-writable location so the installer never needs admin rights.
func DefaultInstallDir() (string, error) {
	switch runtime.GOOS {
	case "windows":
		base := os.Getenv("LOCALAPPDATA")
		if base == "" {
			home, err := os.UserHomeDir()
			if err != nil {
				return "", err
			}
			base = filepath.Join(home, "AppData", "Local")
		}
		return filepath.Join(base, "frixty-fetcher"), nil
	case "darwin":
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		return filepath.Join(home, "Library", "Application Support", "frixty-fetcher"), nil
	case "linux":
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		return filepath.Join(home, ".local", "share", "frixty-fetcher"), nil
	default:
		return "", fmt.Errorf("unsupported OS: %s", runtime.GOOS)
	}
}

// ManifestDestination returns the canonical Chrome native-messaging
// manifest path. Retained for backward compatibility and for callers
// (Windows registry pointer, dev install) that legitimately want a
// single path. New code that registers the manifest with the user's
// browser should call ManifestDestinations to also reach Chromium /
// Brave / Edge / Vivaldi.
func ManifestDestination(installDir string) (string, error) {
	switch runtime.GOOS {
	case "windows":
		return filepath.Join(installDir, HostManifestName+".json"), nil
	case "darwin":
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		return filepath.Join(home, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts", HostManifestName+".json"), nil
	case "linux":
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		return filepath.Join(home, ".config", "google-chrome", "NativeMessagingHosts", HostManifestName+".json"), nil
	default:
		return "", fmt.Errorf("unsupported OS: %s", runtime.GOOS)
	}
}

// ManifestDestinations returns every path the native-messaging manifest
// should be written to so Chromium-family browsers can find the host.
// Chrome's protocol expects each browser to read from its own per-user
// directory; without writing into all installed variants, users on
// Brave / Chromium / Edge / Vivaldi see the misleading "Specified
// native messaging host not found" error from the extension.
//
// Writing happens only into directories whose parent profile directory
// already exists, so we don't pollute the filesystem with config for
// browsers the user never installed. If we can't see any installed
// variant, we fall back to Chrome's canonical location so the install
// is still usable for Chrome users who haven't launched it yet.
//
// Windows: still a single file inside the install dir — the registry
// pointer is what makes Chrome find it, and Chrome / Edge / Brave on
// Windows all consult HKCU\Software\<vendor>\NativeMessagingHosts.
// Multi-browser support on Windows is in registry_windows.go.
func ManifestDestinations(installDir string) ([]string, error) {
	if runtime.GOOS == "windows" {
		single, err := ManifestDestination(installDir)
		if err != nil {
			return nil, err
		}
		return []string{single}, nil
	}

	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}

	candidates := chromiumProfileDirs(home)
	var dests []string
	for _, c := range candidates {
		if _, err := os.Stat(c.profileBase); err == nil {
			dests = append(dests, filepath.Join(c.manifestDir, HostManifestName+".json"))
		}
	}
	if len(dests) == 0 {
		// No browser detected — fall back to Chrome's canonical location
		// so the install isn't a no-op for users whose Chrome dir gets
		// created later.
		dests = append(dests, filepath.Join(candidates[0].manifestDir, HostManifestName+".json"))
	}
	return dests, nil
}

// chromiumProfileDirs lists the Chromium-family browser profile dirs we
// know about, paired with their NativeMessagingHosts subdirs. Order
// matters — Chrome first, used as the fall-back path when nothing else
// is detected.
type chromiumDir struct {
	profileBase string // user-config dir of the browser; existence = "user has the browser"
	manifestDir string // NativeMessagingHosts dir we write into
}

func chromiumProfileDirs(home string) []chromiumDir {
	switch runtime.GOOS {
	case "linux":
		return []chromiumDir{
			{filepath.Join(home, ".config", "google-chrome"), filepath.Join(home, ".config", "google-chrome", "NativeMessagingHosts")},
			{filepath.Join(home, ".config", "chromium"), filepath.Join(home, ".config", "chromium", "NativeMessagingHosts")},
			{filepath.Join(home, ".config", "BraveSoftware", "Brave-Browser"), filepath.Join(home, ".config", "BraveSoftware", "Brave-Browser", "NativeMessagingHosts")},
			{filepath.Join(home, ".config", "microsoft-edge"), filepath.Join(home, ".config", "microsoft-edge", "NativeMessagingHosts")},
			{filepath.Join(home, ".config", "vivaldi"), filepath.Join(home, ".config", "vivaldi", "NativeMessagingHosts")},
			{filepath.Join(home, ".config", "opera"), filepath.Join(home, ".config", "opera", "NativeMessagingHosts")},
		}
	case "darwin":
		appSupport := filepath.Join(home, "Library", "Application Support")
		return []chromiumDir{
			{filepath.Join(appSupport, "Google", "Chrome"), filepath.Join(appSupport, "Google", "Chrome", "NativeMessagingHosts")},
			{filepath.Join(appSupport, "Chromium"), filepath.Join(appSupport, "Chromium", "NativeMessagingHosts")},
			{filepath.Join(appSupport, "BraveSoftware", "Brave-Browser"), filepath.Join(appSupport, "BraveSoftware", "Brave-Browser", "NativeMessagingHosts")},
			{filepath.Join(appSupport, "Microsoft Edge"), filepath.Join(appSupport, "Microsoft Edge", "NativeMessagingHosts")},
			{filepath.Join(appSupport, "Vivaldi"), filepath.Join(appSupport, "Vivaldi", "NativeMessagingHosts")},
		}
	}
	return nil
}

// HostBinaryName returns the filename of the native messaging host binary
// as it sits inside the install dir.
func HostBinaryName() string {
	if runtime.GOOS == "windows" {
		return "frixtyhost.exe"
	}
	return "frixtyhost"
}

// InstallerBinaryName returns the filename used for the installer's own
// copy inside the install dir (so Add/Remove Programs can invoke it on
// uninstall).
func InstallerBinaryName() string {
	if runtime.GOOS == "windows" {
		return "installer.exe"
	}
	return "installer"
}
