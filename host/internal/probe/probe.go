// Package probe answers "can yt-dlp likely handle this URL?" without
// invoking yt-dlp. v1 uses a hostname allowlist aligned with the product's
// primary target sites.
package probe

import (
	"net/url"
	"strings"
)

// Supported lists registrable domains we claim to support in v1.
// Keep aligned with docs/DESIGN.md ("primary target sites").
var Supported = []string{
	"youtube.com",
	"youtu.be",
	"reddit.com",
	"redd.it",
	"twitter.com",
	"x.com",
	"instagram.com",
	"facebook.com",
	"fb.watch",
	"tiktok.com",
}

// Check reports whether the given URL's host matches the v1 allowlist.
func Check(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return false
	}
	host := strings.ToLower(u.Hostname())
	for _, d := range Supported {
		if host == d || strings.HasSuffix(host, "."+d) {
			return true
		}
	}
	return false
}
