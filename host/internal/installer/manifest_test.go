package installer

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWriteManifest(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "nested", HostManifestName+".json")

	if err := WriteManifest(path, filepath.Join(dir, "frixtyhost.exe"), "abc123"); err != nil {
		t.Fatalf("WriteManifest: %v", err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}

	var got nativeHostManifest
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if got.Name != HostManifestName {
		t.Errorf("Name = %q", got.Name)
	}
	if got.Type != "stdio" {
		t.Errorf("Type = %q", got.Type)
	}
	if len(got.AllowedOrigins) != 1 || !strings.Contains(got.AllowedOrigins[0], "abc123") {
		t.Errorf("AllowedOrigins = %v", got.AllowedOrigins)
	}
	if !strings.HasSuffix(got.Path, "frixtyhost.exe") {
		t.Errorf("Path = %q", got.Path)
	}
}
