package installer

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// nativeHostManifest is the shape Chrome expects at the Native Messaging
// Hosts path. Keep fields in this order (it doesn't functionally matter but
// matches examples in the Chrome docs, which makes diffs easier to review).
type nativeHostManifest struct {
	Name           string   `json:"name"`
	Description    string   `json:"description"`
	Path           string   `json:"path"`
	Type           string   `json:"type"`
	AllowedOrigins []string `json:"allowed_origins"`
}

// WriteManifest writes the native messaging host manifest to manifestPath,
// creating parent dirs as needed. hostExePath must be an absolute path; it
// becomes the "path" Chrome will invoke. extID is the stable extension ID
// (see internal/extid).
func WriteManifest(manifestPath, hostExePath, extID string) error {
	if err := os.MkdirAll(filepath.Dir(manifestPath), 0o755); err != nil {
		return fmt.Errorf("mkdir manifest parent: %w", err)
	}
	m := nativeHostManifest{
		Name:           HostManifestName,
		Description:    AppDisplayName + " native messaging host",
		Path:           hostExePath,
		Type:           "stdio",
		AllowedOrigins: []string{fmt.Sprintf("chrome-extension://%s/", extID)},
	}
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(manifestPath, data, 0o644)
}
