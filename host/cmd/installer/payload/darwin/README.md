# macOS payload

This directory holds the macOS binaries embedded into the installer at build time:

- `frixtyhost` — native messaging host (built from `host/cmd/frixtyhost`)
- `yt-dlp` — the downloader itself (fetched from yt-dlp's GitHub releases)
- `ffmpeg` — the muxer/transcoder (fetched from a static ffmpeg build)

These files are produced by the payload-fetch script (introduced in part 3 of step 6). They are `.gitignore`d — only this README is committed so `go:embed` finds at least one file.
