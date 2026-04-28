// Cookie file handling: extract the browser-exported Netscape-format
// cookies.txt blob into a temp file so yt-dlp can read it via --cookies.
package main

import "os"

// writeCookiesTemp writes a Netscape cookies.txt blob to a temporary file
// for yt-dlp's --cookies flag. Returns the path + a cleanup function that
// removes the file; callers defer the cleanup. An empty text resolves to
// no file path ("" and a no-op cleanup) so callers don't need to branch.
func writeCookiesTemp(text string) (string, func(), error) {
	noop := func() {}
	if text == "" {
		return "", noop, nil
	}
	f, err := os.CreateTemp("", "ytdlp-cookies-*.txt")
	if err != nil {
		return "", noop, err
	}
	if _, err := f.WriteString(text); err != nil {
		f.Close()
		os.Remove(f.Name())
		return "", noop, err
	}
	if err := f.Close(); err != nil {
		os.Remove(f.Name())
		return "", noop, err
	}
	path := f.Name()
	return path, func() { os.Remove(path) }, nil
}
