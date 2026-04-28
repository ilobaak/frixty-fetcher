# Third-Party Licenses

Frixty Fetcher would not exist without the work of the projects below.
The Frixty Fetcher installer bundles their official binaries — the
binaries are not modified, and they are downloaded from their upstream
sources at build time with their published checksums verified before
embedding (see `host/cmd/fetch-payload/main.go`).

## yt-dlp

Frixty Fetcher uses **yt-dlp** as the actual media downloader. Every
extractor in this project, every cookies-based authenticated download,
every URL the popup ever hands to the helper — that's yt-dlp doing the
work. The Frixty Fetcher extension is a UI wrapper; yt-dlp is the
engine.

- **Project:** https://github.com/yt-dlp/yt-dlp
- **License:** The Unlicense (public domain)

The Unlicense places yt-dlp into the public domain worldwide. No
restriction on use, copying, modification, distribution, or commercial
use applies to the bundled yt-dlp binary.

## FFmpeg

Frixty Fetcher uses **FFmpeg** to merge separately-downloaded video
and audio streams (yt-dlp's "best video + best audio" path), to extract
audio-only output (yt-dlp -x), and to strip the audio track when the
user picks "Video only."

- **Project:** https://ffmpeg.org/
- **License:** GNU Lesser General Public License v2.1 or later (LGPL)
  for the default builds we ship; some statically-linked builds may be
  distributed under the GNU General Public License v2.1 or later (GPL)
  depending on which optional codecs are compiled in.

We bundle the following upstream FFmpeg builds, unmodified:

- **Windows:** [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds)
  — `ffmpeg-master-latest-win64-gpl.zip` (GPL)
- **macOS:** [evermeet.cx](https://evermeet.cx/ffmpeg/) FFmpeg static
  build (LGPL)
- **Linux:** [John Van Sickle's static builds](https://johnvansickle.com/ffmpeg/)
  (GPL release tarball)

The full text of the LGPL v2.1 is available at
https://www.gnu.org/licenses/lgpl-2.1.txt and the GPL v2 at
https://www.gnu.org/licenses/old-licenses/gpl-2.0.txt. Both upstream
FFmpeg projects host their license texts alongside their releases.

Per LGPL §6, recipients of this distribution have the right to obtain
the FFmpeg source code from the upstream FFmpeg project at
https://ffmpeg.org/download.html.

## Other dependencies

The Go native messaging host depends on a small number of Go modules
listed in `host/go.mod`. The Chrome extension depends on a small set
of npm packages listed in `package.json` (devDependencies only — none
are shipped to users). Each is licensed under either MIT, Apache-2.0,
or BSD; none impose redistribution conditions on Frixty Fetcher.
