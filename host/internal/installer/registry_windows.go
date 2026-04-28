//go:build windows

package installer

import (
	"errors"
	"fmt"

	"golang.org/x/sys/windows/registry"
)

const uninstallKeyBase = `Software\Microsoft\Windows\CurrentVersion\Uninstall\`

// chromiumHostKeyBases is every HKCU registry path each Chromium-family
// browser on Windows reads native-messaging-host pointers from. Brave,
// Edge, Vivaldi all consult their own vendor-named subtrees, NOT
// Google\Chrome's. Without writing to all of them, users on those
// browsers see "Specified native messaging host not found" even when
// the host binary and manifest exist on disk.
var chromiumHostKeyBases = []string{
	`Software\Google\Chrome\NativeMessagingHosts\`,
	`Software\Chromium\NativeMessagingHosts\`,
	`Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\`,
	`Software\Microsoft\Edge\NativeMessagingHosts\`,
	`Software\Vivaldi\NativeMessagingHosts\`,
}

// RegisterChromeHost writes HKCU\<vendor>\NativeMessagingHosts\<HostManifestName>
// = <manifestPath> for every Chromium-family browser we know about.
// Browsers that aren't installed quietly accept the registry write —
// the key sits inert until the user installs that browser, at which
// point native messaging Just Works.
func RegisterChromeHost(manifestPath string) error {
	for _, base := range chromiumHostKeyBases {
		k, _, err := registry.CreateKey(
			registry.CURRENT_USER,
			base+HostManifestName,
			registry.SET_VALUE|registry.CREATE_SUB_KEY,
		)
		if err != nil {
			return fmt.Errorf("create registry key %s: %w", base+HostManifestName, err)
		}
		if err := k.SetStringValue("", manifestPath); err != nil {
			k.Close()
			return fmt.Errorf("write registry value %s: %w", base+HostManifestName, err)
		}
		k.Close()
	}
	return nil
}

// UnregisterChromeHost removes the HKCU registry pointer from every
// Chromium-family browser path. Missing keys are not errors —
// uninstall is idempotent.
func UnregisterChromeHost() error {
	for _, base := range chromiumHostKeyBases {
		err := registry.DeleteKey(registry.CURRENT_USER, base+HostManifestName)
		if err != nil && !errors.Is(err, registry.ErrNotExist) {
			return fmt.Errorf("delete %s: %w", base+HostManifestName, err)
		}
	}
	return nil
}

// RegisterUninstaller adds an entry to Add/Remove Programs so the user can
// uninstall via Windows Settings as well as by re-running the installer.
func RegisterUninstaller(installDir, installerPath, version string) error {
	k, _, err := registry.CreateKey(
		registry.CURRENT_USER,
		uninstallKeyBase+UninstallKeyName,
		registry.SET_VALUE|registry.CREATE_SUB_KEY,
	)
	if err != nil {
		return fmt.Errorf("create uninstall key: %w", err)
	}
	defer k.Close()
	values := map[string]string{
		"DisplayName":     AppDisplayName,
		"DisplayVersion":  version,
		"InstallLocation": installDir,
		// The quoted-path + flag form is what Windows expects so paths with
		// spaces survive the shell.
		"UninstallString": fmt.Sprintf(`"%s" --uninstall --silent`, installerPath),
	}
	for name, val := range values {
		if err := k.SetStringValue(name, val); err != nil {
			return fmt.Errorf("set %s: %w", name, err)
		}
	}
	// NoModify/NoRepair hide the "Repair" / "Change" options in Add/Remove
	// Programs since we don't support them.
	if err := k.SetDWordValue("NoModify", 1); err != nil {
		return err
	}
	if err := k.SetDWordValue("NoRepair", 1); err != nil {
		return err
	}
	return nil
}

// UnregisterUninstaller removes the Add/Remove Programs entry. Idempotent.
func UnregisterUninstaller() error {
	err := registry.DeleteKey(registry.CURRENT_USER, uninstallKeyBase+UninstallKeyName)
	if errors.Is(err, registry.ErrNotExist) {
		return nil
	}
	return err
}
