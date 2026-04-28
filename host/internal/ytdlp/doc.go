// Package ytdlp is a thin Go wrapper around the yt-dlp command-line
// tool. It exposes only the five operations the host actually invokes:
//
//   - Resolve: find the managed binary (see internal/updater) or fall
//     back to PATH. Returns "" when nothing is available.
//   - Version: `yt-dlp --version` for the host's own version report.
//   - ListFormats: `yt-dlp -J` with cookies + structured output parsing,
//     returning a Listing (title, thumbnail, duration, formats).
//   - Run: spawn the actual download with BuildArgs flags and stream
//     progress via a [YTDP] / [YTDP-DONE] marker protocol the host
//     parses line-by-line (see ParseStream).
//   - ExtractAudio: the `-x --audio-format m4a` shortcut used by the
//     Reddit / Twitter image flow when the user picks Kind=audio.
//
// Why a marker protocol for progress (rather than yt-dlp's default
// line format): stdout gets interleaved across download / convert /
// merge stages and the default formatting drops enough precision
// that a smooth progress bar is hard to reconstruct. Our custom
// `--progress-template [YTDP]%(progress)j` emits one machine-parseable
// JSON object per tick; BuildArgs wires that up.
//
// The package intentionally stays close to yt-dlp's CLI vocabulary.
// Selecting a format, picking cookies, deciding the output template
// is the caller's job — ytdlp just marshals those choices into
// argv and runs the binary.
package ytdlp
