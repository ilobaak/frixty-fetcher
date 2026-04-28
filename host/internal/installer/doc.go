// Package installer performs the native-messaging-host registration
// Chrome needs to talk to frixtyhost on first launch: writing the
// com.frixty.fetcher.json manifest to the right platform-specific
// location and — on Windows — adding the HKCU registry pointer that
// Chrome actually reads.
//
// Two concerns split across files:
//
//   - manifest.go: builds the JSON manifest (allowed_origins filled in
//     from the extension ID baked into the extension's "key" field),
//     and figures out which per-user directory to write it to on each
//     OS (%USERPROFILE%\.frixty-fetcher\ on Windows; the standard
//     NativeMessagingHosts/ directories on macOS and Linux).
//
//   - installer.go: glues the manifest writer to the registry/file
//     writes and wraps the whole operation so cmd/installer and
//     cmd/devinstall can share it.
//
// Tests cover manifest serialization (golden-ish assertions on the
// JSON shape) — the filesystem side is exercised by the devinstall
// command during first-run development.
package installer
