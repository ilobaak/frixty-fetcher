//go:build !windows

package installer

// On macOS and Linux, Chrome reads the native messaging manifest directly
// from a canonical filesystem path — there's no registry. Writing the
// manifest file is enough, so these registry operations are no-ops.

func RegisterChromeHost(manifestPath string) error  { return nil }
func UnregisterChromeHost() error                   { return nil }
func RegisterUninstaller(installDir, installerPath, version string) error {
	return nil
}
func UnregisterUninstaller() error { return nil }
