// Command devinstall writes the Chrome Native Messaging manifest for
// development: fills the template with the absolute host binary path and
// the loaded extension's ID, then places it where Chrome expects per OS.
//
// This is NOT the production installer — it is the dev loop helper that lets
// us run an unpacked extension against a locally built host.
//
// Usage:
//   devinstall --extension-id <id> --host-path <path-to-frixtyhost[.exe]>
package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"

	"github.com/ilobaak/frixty-fetcher/host/internal/extid"
	"github.com/ilobaak/frixty-fetcher/host/internal/installer"
)

func main() {
	extID := flag.String("extension-id", extid.ExtensionID, "Chrome extension ID (defaults to the stable ID pinned in the manifest's key field)")
	hostPath := flag.String("host-path", "", "path to the built frixtyhost binary")
	flag.Parse()

	if *hostPath == "" {
		flag.Usage()
		os.Exit(2)
	}

	absHost, err := filepath.Abs(*hostPath)
	if err != nil {
		log.Fatalf("resolve host path: %v", err)
	}
	if _, err := os.Stat(absHost); err != nil {
		log.Fatalf("host binary not found at %s: %v", absHost, err)
	}

	dest, err := manifestDestination()
	if err != nil {
		log.Fatalf("compute manifest destination: %v", err)
	}
	// Production installer's WriteManifest builds the right struct
	// (name, description, type, allowed_origins) from the same
	// canonical constants — keeps the dev manifest binary-equivalent
	// to the installed one without duplicating the schema here.
	if err := installer.WriteManifest(dest, absHost, *extID); err != nil {
		log.Fatalf("write manifest: %v", err)
	}
	fmt.Printf("wrote %s\n", dest)

	// Windows reads the manifest path from the registry rather than from a
	// filesystem convention. Point HKCU at the file we just wrote.
	if runtime.GOOS == "windows" {
		key := `HKCU\Software\Google\Chrome\NativeMessagingHosts\` + installer.HostManifestName
		cmd := exec.Command("reg", "add", key, "/ve", "/t", "REG_SZ", "/d", dest, "/f")
		out, err := cmd.CombinedOutput()
		if err != nil {
			log.Fatalf("reg add failed: %v\n%s", err, out)
		}
		fmt.Printf("registered %s -> %s\n", key, dest)
	}
}

// manifestDestination returns the per-OS path Chrome reads the host manifest
// from. On Windows this is a file we point the registry at (under
// ~/.frixty-fetcher/, separate from the production installer's location so
// dev and prod registrations don't collide); anywhere else it is the
// canonical NativeMessagingHosts directory.
func manifestDestination() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	name := installer.HostManifestName
	switch runtime.GOOS {
	case "windows":
		return filepath.Join(home, ".frixty-fetcher", name+".json"), nil
	case "darwin":
		return filepath.Join(home, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts", name+".json"), nil
	case "linux":
		return filepath.Join(home, ".config", "google-chrome", "NativeMessagingHosts", name+".json"), nil
	default:
		return "", fmt.Errorf("unsupported OS: %s", runtime.GOOS)
	}
}
