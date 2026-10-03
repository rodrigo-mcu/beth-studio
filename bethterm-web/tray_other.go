//go:build !windows

package main

import "context"

// Fora do Windows não há bandeja.
func runTrayWhenFree(ctx context.Context, h *hub, sup *supervisor, ctl hostCtl) {
	_, _, _, _ = ctx, h, sup, ctl
}

func stopTray() {}
