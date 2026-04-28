// Command genkey produces the RSA keypair that stabilizes the Chrome
// extension's ID for self-distribution.
//
// Chrome derives an unpacked extension's ID by SHA256-hashing the public key
// bytes (DER SPKI) and mapping the first 32 hex nibbles to the letters a..p.
// Putting the same public key into manifest.json's "key" field pins the ID
// across machines, which the installer depends on — it needs a known ID to
// bake into the native messaging manifest's allowed_origins.
//
// Run once, paste the output into:
//   - extension/manifest.json  (the "key" field)
//   - host/internal/extid/extid.go (the EXTensionID constant)
//
// The private key is written to --private-out (default: ./private-key.pem)
// so it can be used later if/when we sign .crx packages. It is NOT needed
// for unpacked distribution. Keep it out of version control.
package main

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"flag"
	"fmt"
	"log"
	"os"
)

func main() {
	privateOut := flag.String("private-out", "private-key.pem", "path to write the PEM-encoded private key")
	flag.Parse()

	// 2048 is what Chrome uses for its own generated dev keys; stick with it
	// for compatibility and so the derived ID fits expectations.
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		log.Fatalf("generate key: %v", err)
	}

	pubDER, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		log.Fatalf("marshal public key: %v", err)
	}

	extID := extensionIDFromPubKey(pubDER)
	manifestKey := base64.StdEncoding.EncodeToString(pubDER)

	privDER := x509.MarshalPKCS1PrivateKey(key)
	privPEM := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: privDER})
	if err := os.WriteFile(*privateOut, privPEM, 0o600); err != nil {
		log.Fatalf("write private key: %v", err)
	}

	fmt.Println("Extension ID: " + extID)
	fmt.Println()
	fmt.Println("manifest.json \"key\" field (paste verbatim, including quotes):")
	fmt.Printf("  \"key\": \"%s\"\n", manifestKey)
	fmt.Println()
	fmt.Println("Private key written to: " + *privateOut)
	fmt.Println("  Keep this out of version control. Only needed for .crx signing.")
}

// extensionIDFromPubKey reproduces Chrome's algorithm: take the first 16
// bytes of sha256(der), render as lowercase hex, and map each hex digit 0..f
// to the letter a..p (so the whole 32-char string is lowercase a..p).
func extensionIDFromPubKey(der []byte) string {
	sum := sha256.Sum256(der)
	first16 := sum[:16]
	out := make([]byte, 32)
	for i, b := range first16 {
		out[i*2] = 'a' + (b >> 4)
		out[i*2+1] = 'a' + (b & 0x0f)
	}
	return string(out)
}
