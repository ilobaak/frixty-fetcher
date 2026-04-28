// Package extid exposes the stable Chrome extension ID derived from the
// RSA keypair pinned in extension/manifest.json's "key" field. The installer
// bakes this into the native messaging manifest's allowed_origins so Chrome
// will let the host connect on end-user machines.
//
// Regenerating this requires re-running cmd/genkey and updating BOTH this
// constant AND extension/manifest.json's "key". Once shipped, do not change
// it — every user would have to re-install.
package extid

const ExtensionID = "ocpdajnbpndidcflonpppfkkpadmhigk"
