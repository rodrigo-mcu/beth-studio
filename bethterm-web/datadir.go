package main

import (
	"os"
	"path/filepath"
	"strings"
)

// dataDir is the BethTerm data folder, resolved like
// wtinator::session::session_dir (without its one-time rename):
// %APPDATA%\bethterm, or the legacy %APPDATA%\wezterminator when only that
// one exists. BETHTERM_DATA_DIR overrides it (tests use a copy).
func dataDir() string {
	if v := strings.TrimSpace(os.Getenv("BETHTERM_DATA_DIR")); v != "" {
		return v
	}
	base := os.Getenv("APPDATA")
	if base == "" {
		if up := os.Getenv("USERPROFILE"); up != "" {
			base = filepath.Join(up, "AppData", "Roaming")
		}
	}
	d := filepath.Join(base, "bethterm")
	if _, err := os.Stat(d); err != nil {
		legacy := filepath.Join(base, "wezterminator")
		if st, err := os.Stat(legacy); err == nil && st.IsDir() {
			return legacy
		}
	}
	return d
}
