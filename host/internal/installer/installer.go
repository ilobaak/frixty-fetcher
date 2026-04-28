package installer

import (
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"

	"github.com/ilobaak/frixty-fetcher/host/internal/extid"
)

// Options tunes Install/Uninstall behavior. Zero value is "interactive
// install into DefaultInstallDir."
type Options struct {
	InstallDir string // override DefaultInstallDir (tests + advanced users)
	Silent     bool   // suppress interactive prompts; still logs progress
	Progress   func(step string)
}

func (o Options) step(msg string) {
	if o.Progress != nil {
		o.Progress(msg)
	}
}

// Install unpacks the payload into InstallDir, writes the native messaging
// manifest, and registers the host with Chrome (and Add/Remove Programs on
// Windows). payload is the filesystem-embedded bundle: the installer
// iterates it and extracts every non-README file into InstallDir with the
// same name.
func Install(payload fs.FS, opts Options) error {
	dir, err := resolveInstallDir(opts.InstallDir)
	if err != nil {
		return err
	}
	opts.step(fmt.Sprintf("install dir: %s", dir))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("create install dir: %w", err)
	}

	opts.step("copying installer into install dir")
	self, err := os.Executable()
	if err != nil {
		return fmt.Errorf("locate running executable: %w", err)
	}
	installerTarget := filepath.Join(dir, InstallerBinaryName())
	if err := copyExecutable(self, installerTarget); err != nil {
		return fmt.Errorf("copy installer: %w", err)
	}

	opts.step("extracting payload")
	if err := extractPayload(payload, dir); err != nil {
		return fmt.Errorf("extract payload: %w", err)
	}

	manifestPaths, err := ManifestDestinations(dir)
	if err != nil {
		return err
	}
	hostExePath := filepath.Join(dir, HostBinaryName())
	for _, manifestPath := range manifestPaths {
		opts.step(fmt.Sprintf("writing native messaging manifest: %s", manifestPath))
		if err := WriteManifest(manifestPath, hostExePath, extid.ExtensionID); err != nil {
			return err
		}
	}

	opts.step("registering with Chrome")
	// Windows uses a registry pointer (one path); macOS/Linux read the
	// manifest directly from each browser's NativeMessagingHosts dir
	// and need no further registration. The single-path call here is
	// only meaningful on Windows.
	if err := RegisterChromeHost(manifestPaths[0]); err != nil {
		return fmt.Errorf("register chrome: %w", err)
	}

	opts.step("registering uninstaller")
	if err := RegisterUninstaller(dir, installerTarget, AppVersion); err != nil {
		return fmt.Errorf("register uninstaller: %w", err)
	}

	return nil
}

// Uninstall reverses a prior Install: unregister Chrome, unregister from
// Add/Remove Programs, remove the manifest file, remove the install dir.
// Idempotent — missing pieces are skipped, not errored on.
func Uninstall(opts Options) error {
	dir, err := resolveInstallDir(opts.InstallDir)
	if err != nil {
		return err
	}
	opts.step("unregistering chrome host")
	if err := UnregisterChromeHost(); err != nil {
		return fmt.Errorf("unregister chrome: %w", err)
	}
	opts.step("unregistering from Add/Remove Programs")
	if err := UnregisterUninstaller(); err != nil {
		return fmt.Errorf("unregister uninstaller: %w", err)
	}

	manifestPaths, err := ManifestDestinations(dir)
	if err != nil {
		return err
	}
	opts.step("removing manifest(s)")
	for _, manifestPath := range manifestPaths {
		if err := os.Remove(manifestPath); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("remove manifest %s: %w", manifestPath, err)
		}
	}

	opts.step("removing install dir")
	// A running binary on Windows can't delete its own file, so leave the
	// self-delete of the installer + install dir to the caller (main.go
	// arranges a detached cleanup script). Here we just remove whatever we
	// safely can.
	if runtime.GOOS == "windows" {
		return removeInstallDirExceptSelf(dir)
	}
	return os.RemoveAll(dir)
}

// resolveInstallDir returns the effective install directory, honoring an
// explicit override and otherwise falling back to the OS default.
func resolveInstallDir(override string) (string, error) {
	if override != "" {
		return override, nil
	}
	return DefaultInstallDir()
}

// extractPayload walks payload and writes every file (except README.md)
// into dir with the same name. Used by Install to unpack the bundled
// frixtyhost + yt-dlp + ffmpeg.
//
// The flatten via filepath.Base is correct for today's payload (which is
// flat by convention), but a future payload that nests files under
// subdirs would silently collide on shared basenames — a hard-to-debug
// failure where the second file silently overwrites the first. Detect
// that and refuse rather than papering over it.
func extractPayload(payload fs.FS, dir string) error {
	seen := make(map[string]string)
	return fs.WalkDir(payload, ".", func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		name := filepath.Base(path)
		// Skip placeholder docs we keep so go:embed has something to match.
		if name == "README.md" || name == ".gitkeep" {
			return nil
		}
		if prior, ok := seen[name]; ok {
			return fmt.Errorf("payload basename collision: %q comes from both %q and %q — extractPayload flattens, payload must keep filenames unique", name, prior, path)
		}
		seen[name] = path
		data, err := fs.ReadFile(payload, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dir, name)
		if err := os.WriteFile(target, data, 0o755); err != nil {
			return err
		}
		return nil
	})
}

func copyExecutable(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}
	defer out.Close()
	if _, err := io.Copy(out, in); err != nil {
		return err
	}
	return nil
}

// removeInstallDirExceptSelf deletes every entry under dir other than the
// currently-running installer binary, which Windows locks.
func removeInstallDirExceptSelf(dir string) error {
	self, err := os.Executable()
	if err != nil {
		self = ""
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	for _, e := range entries {
		p := filepath.Join(dir, e.Name())
		if p == self {
			continue
		}
		if err := os.RemoveAll(p); err != nil {
			return err
		}
	}
	return nil
}
