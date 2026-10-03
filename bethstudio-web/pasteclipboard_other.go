//go:build !windows

package main

func readOSClipboardFiles() ([]string, error) { return nil, nil }
