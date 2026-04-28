// Package messaging implements Chrome Native Messaging's length-prefixed JSON
// framing: each message is a 4-byte little-endian uint32 length followed by
// that many bytes of UTF-8 JSON.
package messaging

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

// Chrome enforces a 1 MB cap on host->extension messages. Reject anything
// larger rather than allocating.
const MaxMessageBytes = 1024 * 1024

// Read decodes the next framed JSON message from r into v.
// Returns io.EOF cleanly when the peer closes.
func Read(r io.Reader, v any) error {
	var length uint32
	if err := binary.Read(r, binary.LittleEndian, &length); err != nil {
		return err
	}
	if length == 0 {
		return errors.New("messaging: zero-length frame")
	}
	if length > MaxMessageBytes {
		return fmt.Errorf("messaging: frame too large: %d bytes", length)
	}
	buf := make([]byte, length)
	if _, err := io.ReadFull(r, buf); err != nil {
		return err
	}
	return json.Unmarshal(buf, v)
}

// Write encodes v as JSON and writes it framed to w.
func Write(w io.Writer, v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	if len(data) > MaxMessageBytes {
		return fmt.Errorf("messaging: message too large: %d bytes", len(data))
	}
	if err := binary.Write(w, binary.LittleEndian, uint32(len(data))); err != nil {
		return err
	}
	_, err = w.Write(data)
	return err
}
