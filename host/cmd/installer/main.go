// Command installer is the production installer for Frixty Fetcher.
// It ships the native host + bundled yt-dlp + ffmpeg, writes the native
// messaging manifest, and (on Windows) hooks Add/Remove Programs.
//
// Dev flow is cmd/devinstall, not this.
package main

import (
	"bufio"
	"flag"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"

	"github.com/ilobaak/frixty-fetcher/host/internal/installer"
)

func main() {
	uninstall := flag.Bool("uninstall", false, "remove a previous install and exit")
	silent := flag.Bool("silent", false, "do not prompt; assume yes to confirmations")
	installDir := flag.String("install-dir", "", "override default install location (advanced)")
	printVersion := flag.Bool("version", false, "print the installer version and exit")
	flag.Parse()

	if *printVersion {
		fmt.Printf("Frixty Fetcher installer %s (%s)\n", installer.AppVersion, runtime.GOOS)
		return
	}

	opts := installer.Options{
		InstallDir: *installDir,
		Silent:     *silent,
		Progress:   func(step string) { fmt.Printf("  • %s\n", step) },
	}

	var err error
	if *uninstall {
		err = runUninstall(opts)
	} else {
		err = runInstall(opts)
	}

	if err != nil {
		fmt.Fprintf(os.Stderr, "\nERROR: %v\n", err)
	}

	// Keep the terminal window open so users who double-click from Explorer
	// can read the output. Scripted use with --silent skips the pause so
	// automation isn't blocked.
	waitForExit(opts.Silent)

	if err != nil {
		os.Exit(1)
	}
}

func runInstall(opts installer.Options) error {
	dir, err := effectiveInstallDir(opts)
	if err != nil {
		return fmt.Errorf("resolve install dir: %w", err)
	}
	fmt.Printf("Frixty Fetcher will be installed to:\n  %s\n\n", dir)

	if !opts.Silent && !confirm("Continue? [Y/n]: ", true) {
		fmt.Println("Aborted.")
		return nil
	}

	// Surface when the embed is still just placeholders so users aren't
	// surprised by a registered-but-broken install during the skeleton
	// phase.
	if payloadIsEmpty(payloadFS) {
		fmt.Println()
		fmt.Println("Warning: this installer build has no bundled binaries.")
		fmt.Println("It will register paths with Chrome but the host won't launch until yt-dlp/ffmpeg/frixtyhost are placed manually into the install dir.")
		fmt.Println()
	}

	if err := installer.Install(payloadFS, opts); err != nil {
		return fmt.Errorf("install failed: %w", err)
	}
	fmt.Println()
	fmt.Println("Installed successfully.")
	fmt.Println("Next: install the Chrome extension (load the extension/ folder unpacked at chrome://extensions), then click its icon.")
	return nil
}

func runUninstall(opts installer.Options) error {
	dir, err := effectiveInstallDir(opts)
	if err != nil {
		return fmt.Errorf("resolve install dir: %w", err)
	}
	fmt.Printf("This will remove Frixty Fetcher from:\n  %s\n\n", dir)
	if !opts.Silent && !confirm("Proceed? [Y/n]: ", true) {
		fmt.Println("Aborted.")
		return nil
	}
	if err := installer.Uninstall(opts); err != nil {
		return fmt.Errorf("uninstall failed: %w", err)
	}
	fmt.Println()
	if runtime.GOOS == "windows" {
		fmt.Println("Uninstalled. The install dir was removed except for this installer binary,")
		fmt.Println("which Windows can't delete while it's running. You can safely delete it manually.")
	} else {
		fmt.Println("Uninstalled.")
	}
	return nil
}

func effectiveInstallDir(opts installer.Options) (string, error) {
	if opts.InstallDir != "" {
		abs, err := filepath.Abs(opts.InstallDir)
		if err != nil {
			return "", err
		}
		return abs, nil
	}
	return installer.DefaultInstallDir()
}

// confirm prompts the user for y/n; defaultYes sets what pressing Enter means.
func confirm(prompt string, defaultYes bool) bool {
	fmt.Print(prompt)
	in := bufio.NewReader(os.Stdin)
	line, err := in.ReadString('\n')
	if err != nil {
		return defaultYes
	}
	// Some Reader implementations return ("", nil) on EOF without an
	// error (e.g. truly empty piped input). Indexing line[0] on that
	// would panic — fall back to the default just like a read error.
	if len(line) == 0 {
		return defaultYes
	}
	switch line[0] {
	case 'y', 'Y', '\n', '\r':
		return true
	case 'n', 'N':
		return false
	default:
		return defaultYes
	}
}

// waitForExit blocks until the user presses Enter, so a double-clicked
// installer doesn't flash its terminal window closed. Silent mode skips it
// — automation would hang otherwise.
func waitForExit(silent bool) {
	if silent {
		return
	}
	fmt.Println()
	fmt.Print("Press Enter to exit...")
	bufio.NewReader(os.Stdin).ReadString('\n')
}

// payloadIsEmpty returns true when the embedded FS holds only placeholder
// READMEs — useful to warn during the step-6 skeleton phase.
func payloadIsEmpty(p fs.FS) bool {
	empty := true
	_ = fs.WalkDir(p, ".", func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		name := filepath.Base(path)
		if name != "README.md" && name != ".gitkeep" {
			empty = false
		}
		return nil
	})
	return empty
}
