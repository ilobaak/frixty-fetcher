//go:build darwin

package main

import "embed"

//go:embed payload/darwin
var payloadFS embed.FS
