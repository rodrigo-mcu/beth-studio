//go:build !windows

package main

import "errors"

type unsupportedHostCtl struct{}

func newHostCtl() hostCtl { return unsupportedHostCtl{} }

var errHostOnlyWindows = errors.New("o supervisor do host só existe no Windows")

func (unsupportedHostCtl) Running() bool            { return false }
func (unsupportedHostCtl) Start() error             { return errHostOnlyWindows }
func (unsupportedHostCtl) RequestQuit(string) error { return errHostOnlyWindows }
func (unsupportedHostCtl) GUIRunning() bool         { return false }
