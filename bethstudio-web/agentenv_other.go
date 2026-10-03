//go:build !windows

package main

func persistentEnvNames() map[string]bool { return map[string]bool{} }
