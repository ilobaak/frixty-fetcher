//go:build linux

package main

import "embed"

//go:embed payload/linux
var payloadFS embed.FS
