//go:build windows

package main

import "embed"

//go:embed payload/windows
var payloadFS embed.FS
