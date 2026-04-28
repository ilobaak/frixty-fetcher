# Privacy Policy — Frixty Fetcher

**Last updated:** 2026-04-26

This document explains exactly what Frixty Fetcher does with your data.
The short version: **everything stays on your machine. Nothing is sent
anywhere except to the sites you're already downloading from.**

## What Frixty Fetcher is

Frixty Fetcher is a Chrome extension that downloads media (videos and
images) from the page you're currently viewing. It does this by talking
to a small local helper program (the "native host") that runs `yt-dlp`
and `ffmpeg` on your computer. The extension and the helper are written
to live entirely on your machine.

## Data the extension reads

### Browser cookies for supported sites

When you click Download, the extension may read your logged-in session
cookies for the site you're downloading from. This is the only way to
download content that requires you to be signed in (age-gated YouTube
videos, private Twitter accounts you follow, Instagram posts visible
only to logged-in users, etc.).

The extension only reads cookies for the following hosts, and only when
needed for a download:

- `*.reddit.com` and `*.redd.it`
- `twitter.com`, `*.twitter.com`, `x.com`, `*.x.com`
- `*.youtube.com`, `youtu.be`, and `accounts.google.com` (the last
  because YouTube login cookies are set on the parent google.com
  domain)
- `*.instagram.com`
- `*.facebook.com` and `*.fb.watch`
- `*.tiktok.com`

You can change the cookie behaviour per-site in the extension's Options
page (Always / Auto / Never). The default is "Always" for sites where
authenticated requests are usually necessary; the Options page lets you
disable cookie reading for any site you prefer.

### The URL of the active tab

When you open the popup, the extension reads the URL of the active tab
so it knows what to download. It also reads page DOM via
`chrome.scripting.executeScript` for site-specific extractors (Twitter
photo carousels, Instagram stories, etc.). DOM scraping runs only on
the supported hosts listed above.

### Local browser storage

The extension stores the following on your machine via Chrome's storage
APIs:

- **`chrome.storage.local`**: your saved settings (default download
  folder, filename mode, per-site cookie strategy, last-used folder).
  Survives browser restarts. You can clear it from
  `chrome://extensions` → Frixty Fetcher → Details → Site settings.
- **`chrome.storage.session`**: per-session caches — the list of media
  the page-grab buttons have captured, the auto-fetch flag set when
  you click an on-page grab button, and a per-host "this site is
  supported" cache that disappears when Chrome closes.

## Data the extension sends

### To the local helper program

Each download dispatches a JSON message over a local pipe (Chrome's
Native Messaging API) to a Go binary running on your computer. The
message contains the URL to download, your cookie text for that site
(if cookies are enabled), and the download settings you chose.

The helper writes your cookie text to a temporary file with
filesystem-restricted permissions (read-only by your user account)
that yt-dlp reads. The temp file is deleted after the download
finishes.

**The cookie temp file is on your local filesystem. On a multi-user
system, root or someone with access to your user account could read it
during a download.** This is a property of how yt-dlp accepts cookies
and applies to any cookie-passing yt-dlp wrapper — not unique to
Frixty Fetcher.

### To the sites you're downloading from

The helper invokes `yt-dlp` (and `ffmpeg` when post-processing is
needed). yt-dlp makes HTTP requests to the site you're downloading
from to fetch the media. Those requests go directly from your machine
to the site — Frixty Fetcher has no servers and no intermediary.

### To upstream update servers (yt-dlp + helper)

The helper periodically (every 12 hours after first launch) checks for
a new yt-dlp release on GitHub. If one exists, it downloads the new
binary and verifies its SHA-256 against the upstream-published
`SHA2-256SUMS` before installing. The helper itself can also check for
updates from this repository's GitHub Releases page when you click
"Check for updates" in the Options page. Both check requests are plain
HTTPS to GitHub; they include only your IP address (visible to GitHub
the same way any GitHub HTTPS request is) and a User-Agent string.

You can disable the automatic yt-dlp self-update check via the helper's
state file if you prefer to manage yt-dlp yourself.

## Data Frixty Fetcher does NOT collect

- **No analytics or telemetry.** The extension and helper send no
  usage data, error reports, or pings anywhere except as described
  above.
- **No third-party servers.** There is no Frixty Fetcher backend.
- **No advertising or tracking identifiers.** The extension does not
  read any cookies or storage outside the supported hosts listed
  above.
- **No data is shared with the developer.** The author of Frixty
  Fetcher does not receive any information about you, your downloads,
  or your usage.

## Permissions explained

Chrome shows a permissions dialog on install. Here's why each one is
requested:

- `nativeMessaging` — talk to the local helper program over a pipe.
- `activeTab` — read the URL and DOM of the page you click the
  extension on.
- `storage` — save your settings.
- `scripting` — run the per-site DOM scrapers (e.g. find every photo
  in a Twitter gallery).
- `cookies` — read your logged-in session cookies for the supported
  hosts so authenticated downloads work.
- `downloads` — create save dialogs and write the downloaded file to
  the location you chose.
- Host permissions for the supported sites listed above.

## Children

Frixty Fetcher is not directed at children under 13 and does not
knowingly collect data from anyone — see "Data Frixty Fetcher does NOT
collect" above.

## Changes to this policy

If the privacy practices change, this file will be updated and the
"Last updated" date at the top will reflect the change.

## Contact

Questions about this policy: open an issue at the project's GitHub
repository. There is no other contact channel — the project has no
servers, no email list, no support address.
