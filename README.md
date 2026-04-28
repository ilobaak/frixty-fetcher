# Frixty Fetcher

A Chrome extension that downloads videos and images from the active
tab. Supports YouTube, Reddit, Twitter / X, Instagram, Facebook, and
TikTok with first-class extractors; falls through to yt-dlp's generic
extractor for hundreds of other sites.

Free, open source (MIT), no telemetry, no third-party servers.
Everything runs locally on your machine.

**Latest release:** [v1.0.0](https://github.com/ilobaak/frixty-fetcher/releases/latest)

## Credits

Frixty Fetcher would not exist without:

- **[yt-dlp](https://github.com/yt-dlp/yt-dlp)** — the actual media
  downloader. Every URL this extension hands off is resolved by yt-dlp.
  Frixty Fetcher is a UI wrapper; yt-dlp is the engine.
- **[FFmpeg](https://ffmpeg.org/)** — merges separate audio + video
  streams, extracts audio-only output, strips audio for video-only
  saves. The flexibility of "best video + best audio" downloads is
  entirely thanks to ffmpeg.

Both are bundled with the installer (unmodified, downloaded from their
upstream releases with checksums verified at build time). See
[THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) for license details
and source URLs.

## Installing

Frixty Fetcher ships in two parts: a per-OS installer (drops the native
messaging host + bundled `yt-dlp` and `ffmpeg` into a user-writable
directory and registers the host with your browser) and the unpacked
extension (you load it into Chrome / Chromium / Brave / Edge / Vivaldi /
Opera yourself). There is no Chrome Web Store listing — distribution is
through GitHub Releases only.

1. **Download the installer for your OS** from the [latest
   release](https://github.com/ilobaak/frixty-fetcher/releases/latest):
   - **Windows:** `installer-windows.exe`
   - **macOS:** `installer-macos`
   - **Linux:** `installer-linux` — `chmod +x installer-linux` before running

2. **Run the installer.** It writes the host + bundled tools to:
   - **Windows:** `%LOCALAPPDATA%\frixty-fetcher\`
   - **macOS:** `~/Library/Application Support/frixty-fetcher/`
   - **Linux:** `~/.local/share/frixty-fetcher/`

3. **Load the extension unpacked.** Open `chrome://extensions` (or
   `brave://extensions`, `edge://extensions`, etc.), enable
   **Developer mode** in the top-right, click **Load unpacked**, and
   select the `extension/` folder from a [source-zip
   download](https://github.com/ilobaak/frixty-fetcher/archive/refs/tags/v1.0.0.zip)
   of the same release.

4. **Pin the toolbar icon and click it** while on a YouTube / Reddit /
   Twitter / Instagram / Facebook / TikTok page.

> **First-run note (Windows / macOS):** the installer is currently
> unsigned. On Windows, SmartScreen will warn "Windows protected your
> PC"; click **More info → Run anyway**. On macOS, Gatekeeper will
> warn that the binary is from an unidentified developer; right-click
> the installer → **Open** to bypass once.

## Acceptable use

Frixty Fetcher is a tool. Whether downloading a given piece of media is
allowed depends on the site's terms of service, the content's
copyright status, and your local laws. By using this software you
agree:

- You are responsible for ensuring you have the right to download the
  content you're saving.
- The authors of Frixty Fetcher are not responsible for misuse,
  copyright infringement, or terms-of-service violations performed
  through the tool.
- This software is provided "AS IS" without warranty (see
  [LICENSE](LICENSE)).

This is the same disclaimer that applies to yt-dlp, curl, wget, or any
other download tool.

## Privacy

Nothing leaves your machine except requests to the sites you're
downloading from and (every 12 hours) update checks to GitHub. No
analytics, no telemetry, no third-party servers. Full details in
[PRIVACY.md](PRIVACY.md).

## Architecture

The extension cannot invoke `yt-dlp` directly from the browser sandbox.
It talks to a **Chrome Native Messaging Host** — a local Go binary
launched by Chrome over stdin/stdout using length-prefixed JSON — that
runs `yt-dlp` (URL resolution, downloading) and `ffmpeg` (mux / strip /
extract audio) and streams progress back to the popup.

```
┌─────────────────────┐   postMessage    ┌──────────────────┐   subprocess   ┌────────┐
│ Chrome Extension    │ ───────────────► │ Native Host (Go) │ ─────────────► │ yt-dlp │
│ (popup + background)│ ◄─────────────── │   frixtyhost     │ ◄───────────── │        │
└─────────────────────┘   JSON events    └────────┬─────────┘                └────────┘
                                                  │ subprocess
                                                  ▼
                                              ┌────────┐
                                              │ ffmpeg │
                                              └────────┘
```

The native port is owned by the **service worker**, not the popup, so
downloads survive popup close — re-opening the popup mid-download
restores the live progress bar via a snapshot request to the SW.

Full design and protocol reference: [docs/DESIGN.md](docs/DESIGN.md).

## Repo layout

```
extension/    Manifest v3 Chrome extension (popup, background, icons)
host/         Go native messaging host (host/cmd/frixtyhost), installer (host/cmd/installer), build helpers (host/cmd/{fetch-payload,devinstall,genkey})
docs/         DESIGN.md, release notes
tests/        Vitest test suites for the extension JS
tools/        Build helpers (icon rendering)
```

## Using Frixty Fetcher

### Downloading a video

1. Open a tab on any supported site (YouTube, Reddit, Twitter / X, Instagram, Facebook, TikTok). Other sites work too if yt-dlp's generic extractor recognizes them — the popup will show a Fetch prompt to opt in.
2. Click the extension icon. The popup picks the right view based on what it found on the page: a **format picker** for video (resolutions + audio-only options), a **gallery picker** for carousels and TikTok photo posts, an **image picker** for single static images, or a Fetch button if the site isn't auto-recognized.
3. Pick **Combined / Video only / Audio only**, choose a max quality, then click **Download**.
4. Depending on your save-mode setting (see below), a native folder picker may open first. Pick a folder and the download starts.
5. Progress bar updates live (percent, speed, ETA). **Cancel** kills the running yt-dlp process.

Because the native port is held by the service worker, closing the popup mid-download does NOT stop the download. Reopen and the popup will pick up where it left off.

### Settings

Right-click the extension icon → **Options**, or visit `chrome://extensions` and click **Details → Extension options**. Three save-modes are available:

- **Ask where to save** *(default)* — the native OS **Save As dialog** opens each time you click Download, pre-filled with a filename derived from the video title. You can edit name and extension freely.
- **Save to a specific folder** — click *Choose folder…* to pick once; subsequent downloads go straight there with yt-dlp's default filename.
- **Save to your default download folder** — files land in your OS Downloads folder without prompting.

Dialogs are opened by the Go native host (not by Chrome), so they use the real OS widgets — `GetSaveFileNameW` on Windows (the modern Explorer-style Save dialog), `NSSavePanel` on macOS, and `zenity` on Linux.

### On-page Fetch buttons

Every supported site also gets a small Fetch button injected into the page itself, next to the post's own action row (the avatar / Follow / "..." cluster, depending on layout). Clicking it does the same thing as the popup — fetches the active post and routes it to the right picker.

Two flavors:

- **Direct fetch** — opens the popup with the active post pre-loaded (TikTok photo posts, YouTube Shorts).
- **Capture** — adds the post's URL to a per-tab list without opening the popup, so you can collect several before opening the popup once to download them as a batch (Twitter, Instagram, Facebook, YouTube watch page).

### Known limitations

- **Age-gated YouTube videos** require login. Set the YouTube cookies
  setting to "Always" or "Auto" in Options, and make sure you're
  signed in to YouTube in this Chrome profile.
- **Private Twitter / X accounts** you don't follow won't download
  even with cookies. yt-dlp can only see what your logged-in account
  can see.
- **Instagram private accounts you don't follow** are inaccessible
  for the same reason. Stories from accounts you do follow work as
  long as Instagram cookies are enabled.
- **Facebook gated content** (login walls, NSFW pages, geo-blocks)
  often fails. The extension reads cookies from the active tab, but
  Facebook aggressively rotates session tokens; if a download fails
  despite being signed in, reload the page and try again.
- **TikTok logged-out feeds** rely on the extension's MAIN-world
  fetch interceptor to capture API responses. If you see "Couldn't
  identify the video" on `tiktok.com/foryou`, scroll past the post
  once before clicking the on-page Fetch button — that gives the
  interceptor time to capture the metadata.
- **Live streams** download until the stream ends or you click
  Cancel — there's no length-based auto-stop, and progress shows the
  rolling segment count rather than a percentage.
- **Linux desktop-environment dependency** — the "Save As" / folder
  picker uses `zenity` (with automatic fallback to `kdialog` on KDE).
  On a minimal install without a desktop environment, set
  Options → save mode to "Specific folder" so the host doesn't need
  to open a dialog.

### Privacy quick note

The high-level Privacy section above covers the basics; this is the
cookies-specific caveat worth knowing before you enable per-site
cookies in Options.

The extension reads your logged-in cookies for the supported sites
when it needs to download authenticated content. Cookie text is
written to a temporary file with restricted permissions (read-only by
your user account) and deleted after the download. **On a
multi-user machine, root or another user with access to your account
could read that file mid-download.** This is how yt-dlp accepts
cookies — Frixty Fetcher doesn't bypass it, just exposes it. See
[PRIVACY.md](PRIVACY.md) for the full picture.

### Troubleshooting

- **"Specified native messaging host not found"** — re-run the installer (or `devinstall` if running a dev build) so the manifest is rewritten with the right extension ID.
- **"yt-dlp binary not found"** — only seen on dev builds. Install yt-dlp so `yt-dlp --version` works in the terminal, or point `YTDLP_BIN` at the binary. The production installer bundles yt-dlp so end users shouldn't see this.
- **Popup errors on a supported site** — right-click the extension icon → **Inspect popup** → Console tab. Service worker errors are reachable from the *service worker* link on `chrome://extensions`.
- **Host rebuilt but nothing changed** — Chrome caches the host process. Toggle the extension off/on to force a fresh launch.
- **Where do I find the helper's log?** — `frixtyhost.log` lives in your user config directory under `frixty-fetcher/`:
  - **Windows:** `%APPDATA%\frixty-fetcher\frixtyhost.log`
  - **macOS:** `~/Library/Application Support/frixty-fetcher/frixtyhost.log`
  - **Linux:** `~/.config/frixty-fetcher/frixtyhost.log`

  The file holds a tail of recent download attempts and errors (auto-trimmed to the last 512 KiB once it exceeds 1 MiB). Useful when filing a bug report.

For anything not covered above, file a bug at
[github.com/ilobaak/frixty-fetcher/issues](https://github.com/ilobaak/frixty-fetcher/issues)
and attach the helper log if it's a download failure.

## Building a shippable installer

From the `host/` directory, pick a target OS:

```bash
# Windows
go run ./cmd/fetch-payload --os windows
GOOS=windows go build -o bin/installer-windows.exe ./cmd/installer

# macOS
go run ./cmd/fetch-payload --os darwin
GOOS=darwin go build -o bin/installer-macos ./cmd/installer

# Linux
go run ./cmd/fetch-payload --os linux
GOOS=linux go build -o bin/installer-linux ./cmd/installer
```

`fetch-payload` downloads `yt-dlp` and `ffmpeg` from upstream (BtbN on Windows, evermeet on macOS, John Van Sickle on Linux) and cross-builds `frixtyhost` into the payload dir. The installer `go build` then embeds everything. All three targets cross-compile cleanly from any host — no CGO toolchain needed.

Output size is dominated by ffmpeg: ~232 MB on Windows, ~129 MB on macOS, ~93 MB on Linux.

Running the installer:

```bash
bin/installer-windows.exe            # interactive
bin/installer-windows.exe --silent   # no prompts, for scripting
bin/installer-windows.exe --uninstall
```

Install writes binaries to `%LOCALAPPDATA%\frixty-fetcher\`, registers the native messaging host under `HKCU\Software\Google\Chrome\NativeMessagingHosts`, and adds an Add/Remove Programs entry. Uninstall reverses all of it.

## Local dev

Requires Go 1.21+, a Chromium-family browser (Chrome / Chromium / Brave / Edge / Vivaldi / Opera — all auto-detected by the production installer; in dev only Chrome is wired by `cmd/devinstall`), and `yt-dlp` available to the host. In dev the host finds yt-dlp by checking, in order: `$YTDLP_BIN`, a binary sitting next to `frixtyhost`, and then `PATH`. The simplest setup is `scoop install yt-dlp` / `brew install yt-dlp` / your package manager — no config needed.

### First-time setup

> **About `extension-private-key.pem`:** if you see this file at the
> repo root, Chrome generated it when you packaged the extension
> locally (via *Pack extension…*) — it's the signing key for your
> personal `.crx` build. It's **not tracked in git** (see
> `.gitignore`) and it's **not a secret shared with the project**.
> You don't need it for unpacked development loads. If you ever
> produce a signed `.crx` you plan to distribute, keep that
> key in a secret store, not next to your checkout.

1. **Build the host binary.**
   ```bash
   cd host

   # Windows:
   go build -o bin/frixtyhost.exe ./cmd/frixtyhost

   # macOS / Linux:
   go build -o bin/frixtyhost ./cmd/frixtyhost
   ```

2. **Load the extension unpacked.** In Chrome, open `chrome://extensions`, enable Developer mode, click *Load unpacked*, and select `extension/`. Copy the generated extension ID.

3. **Register the native host manifest for that extension ID.**
   ```bash
   cd host
   go run ./cmd/devinstall --extension-id <ID_FROM_STEP_2> --host-path ./bin/frixtyhost.exe
   ```
   On Windows this writes `%USERPROFILE%\.frixty-fetcher\com.frixty.fetcher.json` and a `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.frixty.fetcher` registry entry pointing at it. On macOS / Linux it writes to the standard Chrome `NativeMessagingHosts/` directory.

### Tests

```bash
npm test                  # extension (vitest)
cd host && go test ./...  # host (Go unit + integration)
```
