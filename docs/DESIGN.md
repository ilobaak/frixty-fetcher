# Frixty Fetcher — Design

This document describes the system as it ships at v1.0.0. It is the
authoritative reference for the architecture, message protocol, and
the non-obvious decisions behind both. Update it when those change.

---

## 1. Goals and non-goals

### Goals

- Download media (video, audio, images, galleries) from the active
  browser tab via `yt-dlp` + `ffmpeg`, without making the user open a
  terminal or install Python.
- Run entirely on the user's machine. No backend, no telemetry.
- Ship as one installer per OS plus an unpacked extension folder.
- Stay current with `yt-dlp` (which breaks frequently as sites change
  their video pipelines) without forcing the user to reinstall.

### Non-goals

- A polished cross-browser distribution. The extension is built for
  Chromium-family browsers (Chrome / Brave / Edge) loaded unpacked.
  Web Store and Firefox are explicit later-stage concerns.
- Streaming, transcoding, or playback. The host writes one file per
  job and exits the muxing/encoding to ffmpeg.
- Replacing `yt-dlp`. Where `yt-dlp`'s extractors work cleanly we
  hand off to it; the per-site code in the extension exists only
  where the popup needs richer DOM information than the URL alone
  reveals (galleries, photo posts, story carousels).

---

## 2. System architecture

Chrome extensions are sandboxed. They cannot fork processes, write
arbitrary files, or invoke local binaries. The escape hatch is
**Chrome's Native Messaging API**: the extension can launch a local
binary registered ahead of time and exchange length-prefixed JSON
with it over stdio.

```
                    ┌─────────────────────────────────┐
                    │  Chrome Extension               │
                    │                                 │
   user click ──►   │  ┌─popup.js (UI)──────┐         │
                    │  │  - per-site fetch  │         │
                    │  │  - format picker   │         │
                    │  │  - progress / done │         │
                    │  └────────┬───────────┘         │
                    │           │ runtime.connect      │
                    │  ┌────────▼───────────┐         │
                    │  │ background.js      │         │
                    │  │ (service worker)   │         │
                    │  │  - owns native port│         │
                    │  │  - cookies         │         │
                    │  │  - capture caches  │         │
                    │  │  - SPA url cache   │         │
                    │  └────────┬───────────┘         │
                    │           │ chrome.runtime.     │
                    │           │   connectNative     │
                    └───────────┼─────────────────────┘
                                │
                  length-prefixed JSON over stdio
                                │
                    ┌───────────▼─────────────────────┐
                    │  frixtyhost (Go binary)         │
                    │                                 │
                    │  - dispatch loop                │
                    │  - jobs.Tracker (cancellation)  │
                    │  - subprocess fan-out           │
                    │  - native Save As / folder pick │
                    │  - self-update (frixtyhost +    │
                    │      yt-dlp)                    │
                    │  - rotating log file            │
                    └────┬──────────────┬─────────────┘
                         │              │
                  ┌──────▼─────┐ ┌──────▼─────┐
                  │  yt-dlp    │ │  ffmpeg    │
                  │ (sibling)  │ │ (sibling)  │
                  └────────────┘ └────────────┘
```

### Why these three boundaries

- **Popup vs. service worker.** The popup is a UI tab that gets torn
  down when closed. Putting the native port there would lose every
  in-flight download the moment the user dismissed the picker. The
  SW owns the port and survives popup close; on re-open the popup
  asks the SW for the current job snapshot and re-renders. Chrome
  keeps the SW alive while the native port is open, so this also
  prevents the well-known MV3 SW-suspension trap.

- **Extension vs. host.** Chrome's content security model means the
  extension cannot launch processes, write outside `chrome.downloads`,
  or open native dialogs. Everything that touches the OS lives in
  the Go host: subprocess spawning, file writes, save-as dialogs,
  self-update, cookie temp file, log rotation.

- **Host vs. yt-dlp/ffmpeg.** Re-implementing site extractors is
  unbounded work — we'd be chasing every YouTube cipher rotation,
  every TikTok api change. yt-dlp is a 700+-extractor library
  already maintained by a community. The host shells out to it and
  parses its progress events; we never call into its Python
  internals.

---

## 3. Components

### 3.1 Extension

The extension is plain Manifest v3 — no bundler, no framework. Every
file is an ES module loaded directly by Chrome.

```
extension/
├── manifest.json          MV3 manifest (permissions, icons, content scripts)
├── popup.{html,css,js}    The fetch / format / picker UI
├── background.js          Service worker — port + dispatch + cookies + caches
├── options.{html,css,js}  Per-site cookie strategy, default save folder, updater button
│
├── shared.js              Pure helpers used across popup + content scripts
├── popup-errors.js        yt-dlp stderr → friendly error mapping
├── background-helpers.js  Pure helpers extracted from background.js for testing
│
├── reddit.js              Per-site URL classifier + JSON post detection
├── twitter.js             Per-site URL classifier + DOM scrape (carousels, video variants)
├── instagram.js           Per-site URL classifier + DOM scrape (feed/carousel/reel/story)
├── facebook.js            URL canonicalizer + interceptor cache reader
├── tiktok.js              URL classifier + photo-mode DOM scrape
├── tiktok-shared.js       Pure helpers shared across TikTok worlds
│
├── grab-button-shared.js  Shared helpers for per-site on-page Fetch buttons
├── {fb,ig,tw,yt,tiktok}-post-grab.{js,css}    On-page Fetch button per site
├── {tiktok,facebook}-interceptor.js            MAIN-world fetch/XHR hooks
└── icons/                 Action icons (PNG @ 16/24/32/48/128)
```

The extension splits responsibilities at three levels:

1. **Popup** runs the user-visible fetch flow. It detects the active
   tab's URL shape, picks a site-specific extractor, renders the
   right picker (video / image / gallery), and dispatches downloads
   to the SW. It is the only file that touches the picker DOM.

2. **Service worker (`background.js`)** is the single owner of:
   - The native messaging port (one per session).
   - Per-tab capture caches (`chrome.storage.session`) — what each
     site's grab button has collected, replayed when the popup
     re-opens.
   - Cookie reads (`chrome.cookies.getAll`) — partition-aware so
     Chrome 124+'s third-party-cookie partitioning doesn't lock
     yt-dlp out of authenticated sessions.
   - Per-host probe-success cache (avoid re-asking yt-dlp on hosts
     that already worked once this session).
   - Message routing for the per-tab TikTok job relay.

3. **Content scripts** run in the page's isolated and main worlds
   and do three categories of work:
   - **Per-site Fetch buttons** (`*-post-grab.js`) inject a small
     button next to the post's own action row, so the user doesn't
     have to open the popup at all.
   - **Interceptors** (`*-interceptor.js`) run in MAIN world at
     `document_start` and patch `fetch`/`XHR.send` to snapshot the
     site's own API responses. TikTok and Facebook only — those
     two sites hide a lot of media metadata behind GraphQL/feed
     APIs that don't land in initial HTML, and the popup needs that
     metadata to identify the active post.
   - **Pure helpers** (`tiktok-shared.js`, `grab-button-shared.js`)
     loaded into both worlds when needed.

### 3.2 Host (`frixtyhost`)

The host is one Go binary. Its dispatch loop is in
`host/cmd/frixtyhost/main.go::dispatch`; per-action handlers live
alongside (`download.go`, `download_url.go`, `gallery.go`, etc).

Internal packages provide reusable primitives:

```
host/
├── cmd/
│   ├── frixtyhost/        Main host binary; one .go per action handler
│   ├── installer/         Per-OS installer (embeds payload via go:embed)
│   ├── fetch-payload/     Build-time tool: download yt-dlp + ffmpeg, build
│   │                      frixtyhost into installer/payload/<os>/
│   ├── devinstall/        Dev convenience: install the locally-built host
│   └── genkey/            One-shot: RSA keypair → extension manifest "key"
│                          and ID exported to internal/extid
│
└── internal/
    ├── extid/             Extension ID baked into allowed_origins
    ├── ffmpeg/            Wrapped invocations: StripAudio, ExtractAudio
    ├── ytdlp/             Wrapped invocations: Run, ExtractAudio, Version
    ├── runproc/           TailBuffer + RunCaptureTail — bounded stderr capture
    │                      with sensible error formatting on subprocess failure
    ├── jobs/              Tracker — generic cancel registry keyed by jobId
    ├── hostlog/           File logger at <UserConfigDir>/frixty-fetcher/
    │                      frixtyhost.log; trims to 512 KiB when over 1 MiB
    ├── messaging/         Length-prefixed JSON framing on stdio
    ├── probe/             Static SUPPORTED_HOSTS list (mirrors extension/shared.js)
    ├── updater/           Two updaters: yt-dlp (cmd/updater) + frixtyhost
    │                      (HostUpdater); both verify SHA-256 before swap
    └── installer/         Install / uninstall / Chrome manifest registration;
                           per-OS path resolution + Windows registry hooks
```

Goroutine model: the dispatch loop reads requests serially. Each
action handler decides whether to spawn a goroutine (for long jobs)
or reply inline (for fast queries like `version`, `pickFolder`). All
writes to stdout go through `safeWriter.Send`, which serializes
behind a mutex so concurrent goroutines can't interleave frames.

### 3.3 Installer

Cross-platform, single Go codebase, three output binaries
(`installer-{windows.exe,macos,linux}`). Each binary embeds its OS's
payload via `//go:embed payload/<goos>` — so the Windows installer
ships only Windows binaries (smaller archive). Build flow:

1. `go run ./cmd/fetch-payload --os <os>` downloads upstream yt-dlp
   + ffmpeg (with checksum verification against published sums) and
   builds frixtyhost into `cmd/installer/payload/<os>/`.
2. `GOOS=<os> go build -o bin/installer-<asset-name> ./cmd/installer`
   embeds the payload and produces the installer binary.

At install time the installer extracts the payload to:

| OS      | Path                                                       |
|---------|------------------------------------------------------------|
| Windows | `%LOCALAPPDATA%\frixty-fetcher\`                           |
| macOS   | `~/Library/Application Support/frixty-fetcher/`            |
| Linux   | `~/.local/share/frixty-fetcher/`                           |

…then writes Chrome's native messaging manifest (`com.frixty.fetcher.json`)
to the OS-canonical location and, on Windows, an HKCU registry pointer
so Chrome can find it. Add/Remove Programs gets a record on Windows
too, registered via `internal/installer/registry_windows.go`.

Uninstall (`installer-<os> --uninstall`) reverses each step. On
Windows the running installer binary cannot be deleted by itself
(file lock); the rest of the install dir is removed and the
installer leaves itself for the user to delete.

---

## 4. Communication protocol

All messages are JSON objects framed by a 4-byte little-endian length
prefix. The framing is implemented in `host/internal/messaging`. The
extension uses `chrome.runtime.connectNative("com.frixty.fetcher")`,
which opens a single duplex port that lives until either side
disconnects.

The extension generates a unique `jobId` per download so the UI can
track a job before the host has acknowledged it. Request-response
RPCs that don't have a job (e.g. folder picker) use `reqId` instead.

### Extension → Host

| action               | payload                                                                  | semantics                                                                                  |
|----------------------|--------------------------------------------------------------------------|--------------------------------------------------------------------------------------------|
| `version`            | `{}`                                                                     | Health check. Returns host + tool versions.                                                |
| `listFormats`        | `{reqId, url, cookies?}`                                                 | Calls `yt-dlp -J`. Returns parsed formats (height, ext, codec, filesize).                  |
| `download`           | `{jobId, url, selection, saveMode, destDir?, askPath?, defaultFileName?}` | Single-file download. Tracks under `jobs.Tracker` for cancel.                              |
| `downloadUrl`        | `{jobId, url, kind, ...}`                                                | Direct HTTP GET (Reddit/Twitter/IG images). Optional ffmpeg post-process for audio/video.  |
| `downloadGallery`    | `{jobId, items, albumName?, saveMode, destDir?}`                         | Sequential multi-file write into a sanitized album subfolder.                              |
| `cancel`             | `{jobId}`                                                                | Invokes the cancel function registered for this job.                                       |
| `pickFolder`         | `{reqId, dialogTitle?}`                                                  | Opens a native folder dialog (zenity / NSOpenPanel / GetSaveFileNameW).                    |
| `selfUpdate`         | `{reqId}`                                                                | Force-runs `yt-dlp -U` (bypasses 12h throttle). Returns `oldVersion` / `newVersion`.       |
| `selfHostUpdate`     | `{reqId}`                                                                | Force-runs the frixtyhost self-updater against this repo's GitHub releases.                |
| `revealInFileManager`| `{path}`                                                                 | Opens the OS file manager focused on a downloaded file.                                    |
| `probe`              | `{url}`                                                                  | Defined for a future fast-badge hook; currently the extension does its own probe gating.   |

The `download` action subsumes the Save As dialog: when `askPath: true`,
the host opens the OS save-as dialog and passes the chosen path to
`yt-dlp -o` verbatim. If the user cancels the dialog, the job is
torn down with `destdir_canceled` (the popup treats this as a
no-op return-to-picker, not an error toast).

### Host → Extension

| type            | payload                                                            | semantics                                                                                |
|-----------------|--------------------------------------------------------------------|------------------------------------------------------------------------------------------|
| `formats`       | `{reqId, items: [{id, kind, height, fps, ext, filesize?, ...}]}`   | Reply to `listFormats`.                                                                  |
| `progress`      | `{jobId, percent, speed, eta, stage}`                              | `stage = "download" \| "merge" \| "postprocess"`. Stream of frames during a job.         |
| `done`          | `{jobId, path, bytes?}`                                            | Final absolute path. `bytes` populated for `downloadUrl` jobs.                           |
| `error`         | `{jobId?, reqId?, code, message}`                                  | `code` is machine-friendly (`download_failed`, `download_canceled`, `bad_destdir`, ...). |
| `pathPicked`    | `{jobId, path}`                                                    | Emitted after Save As returns; SW caches parent dir as `settings.lastDir`.               |
| `folderPicked`  | `{reqId, path}` or `{reqId, canceled: true}`                       | Reply to `pickFolder`.                                                                   |
| `updated`       | `{reqId, oldVersion, newVersion, output}`                          | Reply to `selfUpdate` / `selfHostUpdate`.                                                |
| `version`       | `{host, ytdlp, ffmpeg}`                                            | Reply to `version`.                                                                      |
| `log`           | `{line}`                                                           | Optional raw yt-dlp line (debug build only).                                             |

### yt-dlp progress parsing

yt-dlp downloads are invoked with:

```
--newline --no-colors
--progress-template "[YTDP]%(progress)j"
--print "after_move:[YTDP-DONE]%(filepath)s"
```

The host scans stdout line by line: `[YTDP]…` lines decode as JSON
progress frames (status, downloaded/total, speed, eta); the single
`[YTDP-DONE]…` line reports the final absolute output path. This
sidesteps yt-dlp's human-readable progress format entirely — that
format has changed several times across versions and is fragile to
parse.

---

## 5. Per-site extraction

Most sites work transparently through `yt-dlp`'s own extractor — we
hand off the URL and parse the formats. The cases where the popup
needs to do extra work fall into three buckets:

### 5.1 Image and gallery posts

`yt-dlp` doesn't surface static images and is awkward at multi-image
galleries. For these the popup detects the post shape itself
(usually via the site's JSON API or a DOM scrape), then dispatches
to `downloadUrl` (single image) or `downloadGallery` (multi-file).

Examples:

- **Reddit**: `<url>.json?raw_json=1` returns the post; `post_hint`
  + `is_gallery` decides between video / single image / gallery.
- **Twitter / X**: photos resolved via the syndication endpoint
  (`cdn.syndication.twimg.com`); when that fails, a DOM scrape of
  the focused tweet's `<article>` finds the carousel images and
  video variants.
- **Instagram**: feed posts via the page's GraphQL response; the
  story viewer via a DOM scrape (story URLs aren't stable enough
  for caching).
- **TikTok photo posts**: `/@user/photo/<id>` URLs render a
  slideshow that yt-dlp's photo-mode extractor returns awkwardly
  (one format per slide + audio). The popup scopes a DOM scrape to
  the modal's `[role="dialog"]` (excluding comment-list images),
  filters by tiktokcdn host + min 500px size, and routes through
  the gallery picker.

### 5.2 SPA URL identification

Some sites keep the address bar on a feed URL (`/foryou`, `/`)
while playing a specific post. yt-dlp can't extract from the feed
URL, so the popup has to resolve the active post first.

The hardest case is **TikTok's For You feed**: the URL is `/foryou`
and the DOM doesn't always carry a `/@user/video/<id>` anchor for
the active post. Solution: the MAIN-world `tiktok-interceptor.js`
patches `fetch`/`XHR` at `document_start` and snapshots every API
response that names a video (id + authorId + cover image). The
popup's `resolveTikTokUrlFromDom` runs three tiers in priority
order:

1. **DOM anchors** in the viewport-centered `<article>`.
2. **Interceptor cache match** by author (`/@user` profile anchor
   inside the centered card → unique cache entry by `authorId`).
3. **Interceptor cache match** by poster image hash or video src.

Each tier returns "no match" rather than guessing; without a
high-confidence match we surface a clear error rather than risk
fetching the wrong video.

### 5.3 Per-site Fetch buttons

Each supported site injects a small Fetch button into the page's
own action bar, so the user can grab a post in one click without
opening the popup. Implementation pattern:

- `grab-button-shared.js` provides the canonical icon SVG, button
  factory, and per-button captured/error flash with WeakMap-tracked
  timers. Loaded as the first JS in each per-site content script.
- Per-site script (`{fb,ig,tw,yt,tiktok}-post-grab.js`) handles the
  injection point (next to Like, Follow, the "..." menu, etc.) and
  wires the click handler.
- Click handlers fall into two flavors:
  - **Capture**: posts a `capture:add` message to the SW. The SW
    appends the URL/metadata to a per-tab list in
    `chrome.storage.session`. When the popup opens, `handleSnapshot`
    reads the list and renders it as a gallery.
  - **Trigger fetch**: posts `yt:trigger-fetch` to the SW, which
    sets a per-tab auto-fetch flag and calls `chrome.action.openPopup`.
    The popup picks the flag up and runs the full fetch flow.
    Used where the popup needs richer DOM access than the
    capture flow (TikTok photo posts, YouTube Shorts).

---

## 6. Updaters

Two independent updaters, both verify SHA-256 before installing.

### 6.1 yt-dlp updater (`internal/updater`)

Runs in a goroutine on host launch, throttled to once per 12 hours
via a state file at `<UserConfigDir>/frixty-fetcher/updater.json`.
The Options page also exposes a "Check for updates" button that
bypasses the throttle.

Source: `https://github.com/yt-dlp/yt-dlp/releases/latest`.
Verification: against the published `SHA2-256SUMS` release asset.
Install: download to a temp file in the same directory as the
target, verify SHA-256, atomic-rename into place.

### 6.2 frixtyhost self-updater (`internal/updater/host.go`)

The Options page button calls `selfHostUpdate`, which queries this
repo's GitHub releases for `frixtyhost-<goos>-<goarch>(.exe)` and
its `.sha256` sidecar. The atomic-replace dance handles Windows's
running-binary lock:

1. Stat the freshly-downloaded `.new` file to capture expected size.
2. Rename current `frixtyhost(.exe)` → `frixtyhost(.exe).old`.
3. Rename `.new` → live name.
4. Stat the live name to verify the swap succeeded with matching size.
5. On failure, restore from `.old` and surface a manual-recovery
   error message.

The new binary takes effect at the next host launch (Chrome
re-spawns the host on the next download).

### 6.3 ffmpeg

ffmpeg does not auto-update. It rides the installer payload and
gets refreshed on installer reinstall. ffmpeg's release cadence is
slow enough that this is fine.

---

## 7. Cookies

Authenticated downloads (age-gated YouTube, private accounts you
follow on Twitter / Instagram) need the user's browser cookies. The
flow is:

1. User opts in per site via Options (`Always` / `Auto` / `Never`).
2. On `listFormats` or `download`, the SW reads cookies via
   `chrome.cookies.getAll` for both the URL's domain and (for
   YouTube specifically) `accounts.google.com`. **Partition-aware**:
   Chrome 124+ partitions third-party cookies via CHIPS, so the SW
   passes a `partitionKey` matching the URL's top-level site;
   without this, yt-dlp would see only logged-out cookies.
3. The SW formats them into Netscape `cookies.txt` text and sends
   them inline with the request.
4. The host writes them to a `os.CreateTemp` file (which on Unix
   uses 0o600 mode atomically) and passes `--cookies <path>` to
   yt-dlp. The temp file is removed on job completion, success or
   failure.

**Trust boundary**: the cookies live in the browser's process until
the SW reads them, then in the SW's memory until they leave through
the native port. They land on disk only as the host's 0o600 temp
file, which is removed before the job's `done` event reaches the
extension. PRIVACY.md describes this in user-facing terms.

---

## 8. Security boundaries

- **Native messaging `allowed_origins`**: the manifest registered by
  the installer pins the extension ID baked into `internal/extid` —
  reproducible from the public key in `extension/manifest.json` via
  `cmd/genkey`. Only this exact extension can launch the host.

- **No shell interpolation**: every yt-dlp / ffmpeg invocation uses
  Go's `exec.Command` with argv slices. URLs are passed as argv
  elements, never interpolated into a command line.

- **Path traversal defense**: every write that uses an extension-
  supplied path goes through `host/cmd/frixtyhost/paths.go::joinAlbumDir`,
  which rejects `..`, absolute paths, NUL bytes, and sibling-prefix
  tricks (`<base>-evil`). Tested in `paths_test.go`.

- **Checksum verification**: every binary that lands on disk via an
  updater (yt-dlp, frixtyhost, ffmpeg via `fetch-payload`) has its
  SHA-256 verified against an upstream-published value before being
  moved into place. Mismatches abort the install. Documented per
  source in `internal/updater` + `cmd/fetch-payload`.

- **No telemetry, no network calls outside the user's request**:
  the host only makes outbound HTTP for explicit user actions
  (downloads, self-update). The extension only makes outbound
  fetches to documented site APIs (Twitter syndication, Reddit
  JSON, Instagram GraphQL, TikTok internal feeds) when running a
  fetch flow. PRIVACY.md is the user-facing version of this.

---

## 9. Operational concerns

### Logging

The host writes to `os.Stderr` (visible to Chrome) and to a rotating
file at `<UserConfigDir>/frixty-fetcher/frixtyhost.log` via
`internal/hostlog`. The file is trimmed to its last 512 KiB when it
crosses 1 MiB, so users can attach it to bug reports without thinking
about disk usage.

### Cancellation

`jobs.Tracker` (in `internal/jobs`) registers a cancel function per
`jobId`. The cancel function is generic (`func()`); subprocess jobs
register `jobs.KillFunc(cmd)` (cross-platform process-tree kill);
HTTP-driven jobs (downloadUrl, downloadGallery) register the
`context.CancelFunc` of a per-job context. `cancel` from the
extension iterates the tracker, finds the function, invokes it, and
flags the id as canceled so any late-arriving error from the now-
torn-down job is reported as `download_canceled` rather than
`download_failed`.

### Errors

All host errors flow through `sendJobError` / `sendRequestError`,
which produces `{type:"error", code, message}`. Codes are
machine-friendly (`download_failed`, `download_canceled`,
`destdir_canceled`, `bad_destdir`, `bad_request`, `update_failed`,
`listformats_failed`, `no_formats`, ...). The popup's
`popup-errors.js` maps known codes plus common yt-dlp stderr
patterns (e.g. age-restriction, region-block, account-required) to
short user-facing messages. Tests for the mapper live in
`tests/popup-errors.test.js`.

### Job state across popup close

A long download keeps running while the popup is closed (the SW
owns the port, and Chrome keeps the SW alive while the port is
open). When the popup re-opens, it sends `{cmd:"snapshot"}` to the
SW; the SW replies with the active job and any per-tab capture list.
The popup's `handleSnapshot` re-renders the running progress bar or
restores the previously-shown picker.

---

## 10. Build and release

Build is a four-step procedure (no Makefile — the steps are short
enough that a script would obscure more than it'd save):

1. `cd host && go run ./cmd/fetch-payload --os <os>` for each of
   `windows`, `linux`, `darwin`. Downloads upstream yt-dlp + ffmpeg
   with checksum verification, builds frixtyhost cross-compiled
   into `cmd/installer/payload/<os>/`.
2. `GOOS=<os> GOARCH=amd64 go build -trimpath -o bin/installer-<asset> ./cmd/installer`
   for each OS. Embeds the payload via `//go:embed`.
3. `GOOS=<os> GOARCH=amd64 go build -trimpath -o bin/frixtyhost-<os>-amd64 ./cmd/frixtyhost`
   for each OS. These are the self-update assets.
4. Generate `.sha256` sidecars for everything in `bin/`.

Release is `gh release create v<x.y.z>` against this repo,
attaching the 12 artifacts (6 binaries + 6 sidecars). The frixtyhost
self-updater queries `/repos/ilobaak/frixty-fetcher/releases/latest`,
so the release tag drives upgrade detection.

Versions live in three places that must move together:

- `extension/manifest.json` `"version"` (Chrome's view).
- `host/cmd/frixtyhost/main.go` `HostVersion` (self-update compare).
- `host/internal/installer/paths.go` `AppVersion` (Add/Remove Programs).

---

## 11. Known limitations

These are deliberate scope cuts for v1.0.0, not bugs:

- **Linux only registers the Chrome-proper native messaging dir**.
  Chromium / Brave / Edge users need to symlink the manifest
  themselves. Multi-variant write is a follow-up if it matters.

- **Installers are unsigned**. SmartScreen / Gatekeeper warn on
  first run; the README and release notes describe the click-through.
  Code signing requires paid certs we don't have yet.

- **TikTok logged-out feed UX**: the MAIN-world interceptor needs
  one fetch/XHR cycle to populate its cache, so a freshly-loaded
  feed page may need one scroll past a post before the grab button
  has metadata for it.

- **Facebook gated content**: yt-dlp's Facebook extractor is
  rate-limited and sometimes fails outright; reload + retry is the
  documented workaround.

- **macOS / Linux installers are not VM-tested**. Built and built
  from the same Go source as the Windows installer, but until each
  OS gets a clean-machine smoke test, treat their support as
  provisional.

---

## 12. Future work

- ffmpeg auto-update (currently rides the installer).
- Code-signing for the installer + host binaries.
- Auto-installer-update, currently the user re-runs the installer.
- Browser-variant native-messaging dirs on Linux (Brave, Chromium,
  Edge).
- Retire `popup.js`'s remaining ~2.8K lines of monolith into per-
  picker modules (the prior split shipped the pure-helper extracts;
  the picker DOM code remains coupled to module-level state).
