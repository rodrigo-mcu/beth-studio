//go:build darwin

package main

import (
	"os"
	"syscall"
)

// hostLockHeld reports whether another process holds the host lock file.
// Taking the lock and releasing it is how we probe without stealing it:
// flock is exclusive, so a successful non-blocking lock means nobody else
// has it.
func hostLockHeld(path string) bool {
	f, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		return false
	}
	defer f.Close()
	err = syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
	if err != nil {
		return true
	}
	_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
	return false
}
