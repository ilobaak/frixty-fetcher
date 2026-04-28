package messaging

import (
	"bytes"
	"errors"
	"io"
	"testing"
)

func TestRoundTrip(t *testing.T) {
	var buf bytes.Buffer
	in := map[string]any{"action": "version"}
	if err := Write(&buf, in); err != nil {
		t.Fatalf("Write: %v", err)
	}
	var out map[string]any
	if err := Read(&buf, &out); err != nil {
		t.Fatalf("Read: %v", err)
	}
	if out["action"] != "version" {
		t.Fatalf("round-trip mismatch: got %v", out)
	}
}

func TestReadEOF(t *testing.T) {
	var out map[string]any
	if err := Read(&bytes.Buffer{}, &out); !errors.Is(err, io.EOF) {
		t.Fatalf("expected io.EOF, got %v", err)
	}
}

func TestReadRejectsOversizedFrame(t *testing.T) {
	// Craft a header claiming MaxMessageBytes+1 so we don't have to allocate it.
	var hdr [4]byte
	hdr[0] = 0x01
	hdr[1] = 0x00
	hdr[2] = 0x10 // 0x00100001 = 1 MiB + 1
	hdr[3] = 0x00
	var out map[string]any
	err := Read(bytes.NewReader(hdr[:]), &out)
	if err == nil {
		t.Fatal("expected error for oversized frame")
	}
}
