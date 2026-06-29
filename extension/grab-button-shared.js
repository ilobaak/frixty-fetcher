// Shared helpers for the per-site grab buttons. Loaded BEFORE each
// {facebook,twitter,instagram,youtube}-post-grab.js content script via
// manifest.json. Content scripts run in the isolated world without ES
// module support, so the helpers attach to window.__frixtyGrabButton
// rather than export.
//
// TikTok's grab button has a multi-state flash (pressing / captured /
// error with bespoke timing) that doesn't map cleanly to the simple
// helpers below; it keeps its own copies.
(function () {
  if (window.__frixtyGrabButton) return;

  // Same canonical download-tray path data every shared grab button uses.
  // Per-site SVG sizing differs (FB uses 22px on tight chrome, TW uses
  // 26px in tweet action rows) so we expose a builder that takes the size.
  const FRIXTY_DOWNLOAD_TRAY_PATHS =
    '<path data-part="arrow" d="M16 5.5v17"/>' +
    '<path data-part="arrow" d="M9.8 17.2 16 23.4l6.2-6.2"/>' +
    '<path data-part="tray" d="M5.2 21.4v4.1a3 3 0 0 0 3 3h15.6a3 3 0 0 0 3-3v-4.1"/>';
  // Default 30px gives a high icon-to-button fill ratio inside
  // per-site containers (e.g. ~0.83 in TikTok's 36px detail circle).
  function fetchIconSvg(size) {
    const s = size || 30;
    return (
      '<svg id="frixty-download-tray" viewBox="0 0 32 32" width="' +
      s +
      '" height="' +
      s +
      '" ' +
      'fill="none" stroke="currentColor" stroke-width="2.6" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      FRIXTY_DOWNLOAD_TRAY_PATHS +
      "</svg>"
    );
  }
  const FETCH_ICON_SVG = fetchIconSvg(30);

  const FLASH_MS = 1100;

  // Per-button timer storage: fixes the latent bug where the older
  // module-level `flashTimer` was shared across every button on the
  // page (e.g. every tweet's grab). A rapid click on button B would
  // clear A's timer before its class came off.
  const flashTimers = new WeakMap();

  function clearFlash(btn) {
    const t = flashTimers.get(btn);
    if (t) {
      clearTimeout(t);
      flashTimers.delete(btn);
    }
    btn.classList.remove("is-captured");
    btn.classList.remove("is-error");
  }

  function flash(btn, kind, ms) {
    if (!btn) return;
    clearFlash(btn);
    btn.classList.add("is-" + kind);
    const t = setTimeout(() => {
      flashTimers.delete(btn);
      btn.classList.remove("is-" + kind);
    }, ms || FLASH_MS);
    flashTimers.set(btn, t);
  }

  // makeButton returns a fresh <button> with the standard icon and
  // attributes. opts:
  //   className   string  (required): CSS class the per-site stylesheet hooks
  //   title       string  hover tooltip
  //   ariaLabel   string  screen-reader label
  //   onClick     fn      bound with capture=true so wrapping page handlers don't swallow
  // Site-specific scripts then position the returned node in their own
  // DOM injection logic; this helper has no opinion about placement.
  function makeButton(opts) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = opts.className;
    btn.innerHTML = FETCH_ICON_SVG;
    if (opts.title) btn.title = opts.title;
    if (opts.ariaLabel) btn.setAttribute("aria-label", opts.ariaLabel);
    if (opts.onClick) btn.addEventListener("click", opts.onClick, true);
    return btn;
  }

  window.__frixtyGrabButton = {
    FETCH_ICON_SVG,
    FLASH_MS,
    fetchIconSvg,
    makeButton,
    flashCaptured: (btn, ms) => flash(btn, "captured", ms),
    flashError: (btn, ms) => flash(btn, "error", ms),
    clearFlash,
  };
})();
