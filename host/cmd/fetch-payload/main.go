// Command fetch-payload assembles the binaries the installer embeds:
// yt-dlp and ffmpeg for the target OS (downloaded from their upstream
// release hosts), plus a freshly-built frixtyhost. Output lands in
// cmd/installer/payload/<goos>/ where //go:embed picks it up on the next
// `go build ./cmd/installer`.
//
// Usage (from the host/ directory):
//   go run ./cmd/fetch-payload --os windows
//   go run ./cmd/fetch-payload --os windows --force   # re-download
//
// Designed to be re-runnable: already-present files are skipped unless
// --force is set, so iterating on the installer doesn't re-download 80MB
// of ffmpeg every time.
package main

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"crypto/md5"
	"crypto/sha256"
	"encoding/hex"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/ulikunitz/xz"
)

// fetchSpec describes one binary we need to pull down.
type fetchSpec struct {
	Name    string // display name ("yt-dlp", "ffmpeg")
	URL     string // upstream download URL (follows redirects)
	OutName string // filename to write inside the payload dir
	Extract extractFn
	// Verify, when non-nil, is called with the raw downloaded bytes BEFORE
	// extraction and must return nil iff the body matches an upstream
	// integrity record. nil indicates we have no upstream checksum source
	// for this asset and the build will fall back to HTTPS-only trust with
	// a printed warning.
	Verify verifyFn
}

type extractFn func(raw []byte) ([]byte, error)
type verifyFn func(raw []byte) error

// hashSha256Hex / hashMD5Hex return lower-case hex digests of raw.
// Used by verifySidecarHash; kept tiny because the standard library
// already does the heavy lifting.
func hashSha256Hex(raw []byte) string {
	h := sha256.Sum256(raw)
	return hex.EncodeToString(h[:])
}
func hashMD5Hex(raw []byte) string {
	h := md5.Sum(raw)
	return hex.EncodeToString(h[:])
}

// verifySidecarHash fetches a sidecar URL whose body is "<hex>" or
// "<hex>  <filename>" (the GNU coreutils format) and verifies raw's
// hash against it via hashFn. label appears in error messages so the
// developer can tell which source rejected the build.
//
// Used for the three ffmpeg upstreams: BtbN ships a .sha256 file next
// to each release asset, evermeet has a /getrelease/sha256 endpoint
// that returns the SHA256 of its zip, and johnvansickle ships a .md5
// next to its tarball. MD5 is cryptographically broken but useful as
// an integrity check against partial-download corruption — the
// johnvansickle path documents that limitation in its spec comment.
func verifySidecarHash(sidecarURL string, hashFn func([]byte) string, label string) verifyFn {
	return func(raw []byte) error {
		body, err := httpGet(sidecarURL)
		if err != nil {
			return fmt.Errorf("fetch %s: %w", label, err)
		}
		text := strings.TrimSpace(string(body))
		if text == "" {
			return fmt.Errorf("%s sidecar empty (%s)", label, sidecarURL)
		}
		fields := strings.Fields(text)
		expected := strings.ToLower(fields[0])
		got := hashFn(raw)
		if got != expected {
			return fmt.Errorf("%s mismatch: expected %s, got %s", label, expected, got)
		}
		return nil
	}
}

// verifyYtdlpSums returns a verifyFn that fetches yt-dlp's SHA2-256SUMS
// release asset and matches `raw` against the entry for assetName. The
// sums file is signed and published as a release asset by upstream; a
// CDN compromise that swapped a single asset would not consistently
// rewrite this file too.
func verifyYtdlpSums(assetName string) verifyFn {
	return func(raw []byte) error {
		sumsBody, err := httpGet("https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS")
		if err != nil {
			return fmt.Errorf("fetch sums: %w", err)
		}
		expected := ""
		for _, ln := range strings.Split(string(sumsBody), "\n") {
			ln = strings.TrimSpace(ln)
			if ln == "" || strings.HasPrefix(ln, "#") {
				continue
			}
			fields := strings.Fields(ln)
			if len(fields) < 2 {
				continue
			}
			name := strings.TrimPrefix(fields[1], "*")
			if name == assetName {
				expected = strings.ToLower(fields[0])
				break
			}
		}
		if expected == "" {
			return fmt.Errorf("no SHA2-256SUMS entry for %q", assetName)
		}
		sum := sha256.Sum256(raw)
		got := hex.EncodeToString(sum[:])
		if got != expected {
			return fmt.Errorf("checksum mismatch: expected %s, got %s", expected, got)
		}
		return nil
	}
}

func asIs(raw []byte) ([]byte, error) { return raw, nil }

// fromZipSuffix finds the first entry in a zip whose name ends with the
// given suffix and returns its contents. Used for archives whose layout is
// `<somedir>/bin/ffmpeg.exe` where we just want ffmpeg.exe.
func fromZipSuffix(suffix string) extractFn {
	return func(raw []byte) ([]byte, error) {
		r, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
		if err != nil {
			return nil, err
		}
		for _, f := range r.File {
			if strings.HasSuffix(f.Name, suffix) {
				rc, err := f.Open()
				if err != nil {
					return nil, err
				}
				defer rc.Close()
				return io.ReadAll(rc)
			}
		}
		return nil, fmt.Errorf("no zip entry ending in %q", suffix)
	}
}

// fromTarXzBasename walks an xz-compressed tarball and returns the first
// regular file whose basename matches exactly. John Van Sickle's Linux
// ffmpeg build nests the binary inside a versioned directory, so we want
// a basename match rather than a path suffix.
func fromTarXzBasename(wantBasename string) extractFn {
	return func(raw []byte) ([]byte, error) {
		xzR, err := xz.NewReader(bytes.NewReader(raw))
		if err != nil {
			return nil, fmt.Errorf("open xz: %w", err)
		}
		tr := tar.NewReader(xzR)
		for {
			hdr, err := tr.Next()
			if err == io.EOF {
				break
			}
			if err != nil {
				return nil, fmt.Errorf("read tar: %w", err)
			}
			if hdr.Typeflag != tar.TypeReg {
				continue
			}
			if filepath.Base(hdr.Name) == wantBasename {
				return io.ReadAll(tr)
			}
		}
		return nil, fmt.Errorf("no tar entry with basename %q", wantBasename)
	}
}

func specsFor(goos string) ([]fetchSpec, error) {
	switch goos {
	case "windows":
		return []fetchSpec{
			{
				Name:    "yt-dlp",
				URL:     "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe",
				OutName: "yt-dlp.exe",
				Extract: asIs,
				Verify:  verifyYtdlpSums("yt-dlp.exe"),
			},
			{
				Name: "ffmpeg",
				// BtbN publishes statically-linked ffmpeg builds as part of
				// their GitHub release flow. The gpl zip is ~80MB and ships
				// a single ffmpeg.exe we can extract from bin/. The
				// .sha256 sidecar next to the asset closes the integrity
				// gap so a CDN swap can't replace the binary unnoticed.
				URL:     "https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip",
				OutName: "ffmpeg.exe",
				Extract: fromZipSuffix("bin/ffmpeg.exe"),
				Verify: verifySidecarHash(
					"https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip.sha256",
					hashSha256Hex,
					"BtbN SHA-256",
				),
			},
		}, nil
	case "darwin":
		return []fetchSpec{
			{
				Name:    "yt-dlp",
				URL:     "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos",
				OutName: "yt-dlp",
				Extract: asIs,
				Verify:  verifyYtdlpSums("yt-dlp_macos"),
			},
			{
				Name: "ffmpeg",
				// evermeet.cx publishes a self-contained universal ffmpeg
				// binary for macOS as a single-file zip. The
				// /ffmpeg/getrelease/sha256 endpoint returns the SHA256
				// of the same release the /ffmpeg/getrelease/zip URL
				// serves, so they stay in sync as long as evermeet's
				// release-publishing process is atomic.
				URL:     "https://evermeet.cx/ffmpeg/getrelease/zip",
				OutName: "ffmpeg",
				Extract: fromZipSuffix("ffmpeg"),
				Verify: verifySidecarHash(
					"https://evermeet.cx/ffmpeg/getrelease/sha256",
					hashSha256Hex,
					"evermeet SHA-256",
				),
			},
		}, nil
	case "linux":
		return []fetchSpec{
			{
				Name:    "yt-dlp",
				URL:     "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp",
				OutName: "yt-dlp",
				Extract: asIs,
				Verify:  verifyYtdlpSums("yt-dlp"),
			},
			{
				Name: "ffmpeg",
				// John Van Sickle's static builds are the long-standing
				// reference distribution of ffmpeg on Linux; the tarball
				// nests the binary inside a versioned directory.
				//
				// MD5 sidecar — cryptographically broken (collisions can
				// be constructed) but the only sidecar upstream ships.
				// Useful as an integrity check against partial-download
				// corruption; insufficient against a deliberate CDN
				// compromise. Treat HTTPS as the primary defence and
				// MD5 as belt-and-braces. Upgrade if upstream adds a
				// SHA-based sidecar.
				URL:     "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz",
				OutName: "ffmpeg",
				Extract: fromTarXzBasename("ffmpeg"),
				Verify: verifySidecarHash(
					"https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz.md5",
					hashMD5Hex,
					"johnvansickle MD5",
				),
			},
		}, nil
	default:
		return nil, fmt.Errorf("unsupported OS: %s", goos)
	}
}

func main() {
	target := flag.String("os", runtime.GOOS, "target operating system (windows / darwin / linux)")
	force := flag.Bool("force", false, "re-download even if the file already exists")
	flag.Parse()

	log.SetFlags(0)

	specs, err := specsFor(*target)
	if err != nil {
		log.Fatal(err)
	}
	outDir, err := payloadDir(*target)
	if err != nil {
		log.Fatal(err)
	}
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		log.Fatalf("mkdir %s: %v", outDir, err)
	}
	fmt.Printf("target: %s\npayload dir: %s\n\n", *target, outDir)

	for _, s := range specs {
		outPath := filepath.Join(outDir, s.OutName)
		if !*force {
			if st, err := os.Stat(outPath); err == nil && st.Size() > 0 {
				fmt.Printf("skip %s (already present; pass --force to refresh)\n", s.OutName)
				continue
			}
		}
		fmt.Printf("downloading %s from %s\n", s.Name, s.URL)
		raw, err := httpGet(s.URL)
		if err != nil {
			log.Fatalf("download %s: %v", s.Name, err)
		}
		if s.Verify != nil {
			if err := s.Verify(raw); err != nil {
				log.Fatalf("verify %s: %v", s.Name, err)
			}
			fmt.Printf("  verified %s upstream checksum\n", s.Name)
		} else {
			fmt.Printf("  WARNING: no upstream checksum source wired for %s — trusting HTTPS only\n", s.Name)
		}
		bin, err := s.Extract(raw)
		if err != nil {
			log.Fatalf("extract %s: %v", s.Name, err)
		}
		if err := os.WriteFile(outPath, bin, 0o755); err != nil {
			log.Fatalf("write %s: %v", outPath, err)
		}
		fmt.Printf("  wrote %s (%.1f MB)\n", outPath, float64(len(bin))/1024/1024)
	}

	fmt.Println("\nbuilding frixtyhost for target")
	if err := buildYthost(*target, outDir); err != nil {
		log.Fatalf("build frixtyhost: %v", err)
	}

	fmt.Println("\npayload ready.")
	fmt.Printf("next: GOOS=%s go build -o bin/installer-%s.exe ./cmd/installer\n", *target, *target)
}

// payloadDir returns the embed target directory for the given GOOS.
// The path is resolved from the caller's working directory, which the
// command's doc comment pins to host/.
func payloadDir(goos string) (string, error) {
	return filepath.Abs(filepath.Join("cmd", "installer", "payload", goos))
}

func httpGet(url string) ([]byte, error) {
	// Upstream redirects (GitHub release → S3) can add latency; give
	// generous timeouts for the 80MB ffmpeg zip on slow links.
	client := &http.Client{Timeout: 10 * time.Minute}
	resp, err := client.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s: HTTP %d", url, resp.StatusCode)
	}
	var buf bytes.Buffer
	if _, err := io.Copy(&buf, resp.Body); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// buildYthost invokes `go build` for the given GOOS, outputting into the
// payload dir so the installer's embed picks it up.
func buildYthost(goos, outDir string) error {
	outName := "frixtyhost"
	if goos == "windows" {
		outName += ".exe"
	}
	outPath := filepath.Join(outDir, outName)
	cmd := exec.Command("go", "build", "-o", outPath, "./cmd/frixtyhost")
	cmd.Env = append(os.Environ(), "GOOS="+goos)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}
