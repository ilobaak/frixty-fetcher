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

  // Same canonical icon path data every grab button uses — a
  // magnifying glass with a "+" inside framed by four corner brackets
  // (a "scan / fetch" motif). Per-site SVG sizing differs (FB uses
  // 15px on tight chrome, TW uses 18px in tweet action rows) so we
  // expose a builder that takes the size; FETCH_ICON_SVG is the
  // 20px default for sites without space pressure.
  //
  // Icon is fill-only — the source SVG draws every detail as a filled
  // shape, so we omit the stroke that the prior arrow icon used. A
  // stroke here would visibly bloat the fine "+" / bracket lines.
  const ICON_PATHS =
    '<polygon points="24 19 21 19 21 16 19 16 19 19 16 19 16 21 19 21 19 24 21 24 21 21 24 21 24 19"/>' +
    '<path d="M31,29.5859l-4.6885-4.6884a8.028,8.028,0,1,0-1.414,1.414L29.5859,31ZM20,26a6,6,0,1,1,6-6A6.0066,6.0066,0,0,1,20,26Z"/>' +
    '<path d="M4,8H2V4A2.0021,2.0021,0,0,1,4,2H8V4H4Z"/>' +
    '<path d="M26,8H24V4H20V2h4a2.0021,2.0021,0,0,1,2,2Z"/>' +
    '<rect x="12" y="2" width="4" height="2"/>' +
    '<path d="M8,26H4a2.0021,2.0021,0,0,1-2-2V20H4v4H8Z"/>' +
    '<rect x="2" y="12" width="2" height="4"/>';
  // Default 30px gives a high icon-to-button fill ratio inside
  // per-site containers (e.g. ~0.83 in TikTok's 36px detail circle).
  function fetchIconSvg(size) {
    const s = size || 30;
    return (
      '<svg viewBox="0 0 32 32" width="' +
      s +
      '" height="' +
      s +
      '" ' +
      'fill="currentColor" aria-hidden="true">' +
      ICON_PATHS +
      "</svg>"
    );
  }
  const FETCH_ICON_SVG = fetchIconSvg(30);

  const FLASH_MS = 1100;

  // Per-button timer storage — fixes the latent bug where the older
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
  //   className   string  (required) — CSS class the per-site stylesheet hooks
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
