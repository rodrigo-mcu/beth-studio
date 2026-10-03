package main

import "testing"

func TestFactoryPaletteIsDarkAndComplete(t *testing.T) {
	c, ok := paletteForTheme("")
	if !ok {
		t.Fatal("factory theme")
	}
	if c.Background != "#1E1E1E" || c.Foreground != "#D4D4D4" {
		t.Fatalf("factory colours %s / %s", c.Background, c.Foreground)
	}
	if n := len(c.ansi()); n != 16 {
		t.Fatalf("ansi len %d", n)
	}
}

func TestPaletteForThemeUnknown(t *testing.T) {
	if _, ok := paletteForTheme("!!not-a-theme!!"); ok {
		t.Fatal("unknown theme should be skipped")
	}
}
