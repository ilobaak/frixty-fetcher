---
name: Bug report
about: Something downloaded incorrectly, the popup misbehaved, or the helper crashed
title: "[bug] "
labels: bug
---

<!--
Thanks for filing a report. The single most useful thing you can attach
is the helper log — see "Where do I find the helper's log?" below.
-->

## What happened

<!-- One or two sentences. -->

## Where it happened

- **Site / URL** (redact private parts if needed):
- **What you clicked** (toolbar icon? on-page Fetch button? Options page button?):
- **What the popup showed** (format picker? error toast? blank?):

## Expected behaviour

<!-- What should have happened instead. -->

## Environment

- **OS:** (Windows 11 / macOS 14 / Ubuntu 22.04 / etc.)
- **Browser + version:** (Chrome 130, Brave 1.x, Edge 120, …)
- **Frixty Fetcher extension version:** (chrome://extensions → details panel)
- **Helper version:** (Options page, next to "Check for updates")

## Helper log

<!--
Attach `frixtyhost.log` from your user config dir. The file holds the
last ~512 KiB of host activity and is the single most useful artifact.

  - Windows: %APPDATA%\frixty-fetcher\frixtyhost.log
  - macOS:   ~/Library/Application Support/frixty-fetcher/frixtyhost.log
  - Linux:   ~/.config/frixty-fetcher/frixtyhost.log

If the issue is a popup-side error (no host call), check the popup
console too: right-click the toolbar icon → Inspect popup → Console.
-->

## Steps to reproduce (if not obvious)

1.
2.
3.
