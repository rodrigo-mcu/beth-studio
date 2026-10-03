// Package webui embeds the production build of ../frontend (copied here by
// build.ps1). Vite uses base "./", so every asset path is relative.
package webui

import "embed"

//go:embed all:dist
var Dist embed.FS
