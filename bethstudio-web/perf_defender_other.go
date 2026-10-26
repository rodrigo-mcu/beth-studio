//go:build !windows

package main

import (
	"context"
	"errors"
)

func detectAntivirus() ([]string, bool) { return nil, false }

func runDefenderElevated(context.Context, string) (int, error) {
	return 0, errors.New("só no Windows")
}

func openWindowsSecurity() error { return errors.New("só no Windows") }
