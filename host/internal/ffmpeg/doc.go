// Package ffmpeg wraps the small surface of ffmpeg invocations the host
// needs — resolving an ffmpeg binary on $PATH (or a platform-specific
// fallback) and running narrow conversion steps like audio-strip
// (`-an -c copy`) on an already-downloaded file.
//
// The package deliberately doesn't expose a general "run arbitrary
// ffmpeg" API: each entry point matches a specific pipeline step the
// download flow needs, so the argument list + error handling can be
// scoped tight and the caller doesn't have to know ffmpeg syntax.
//
// Resolve returns ("", err) when ffmpeg isn't installed — the download
// flow translates that into an actionable error code the popup shows
// the user rather than letting an exec.LookPath error bubble raw.
package ffmpeg
