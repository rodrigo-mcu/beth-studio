package main

import (
	"os"
	"path/filepath"
	"strings"
)

// dataDir is the Beth Studio data folder, resolved like
// wtinator::session::session_dir (without its one-time rename):
// %APPDATA%\bethstudio, or the legacy %APPDATA%\wezterminator when only that
// one exists. BETHSTUDIO_DATA_DIR overrides it (tests use a copy).
func dataDir() string {
	if v := strings.TrimSpace(os.Getenv("BETHSTUDIO_DATA_DIR")); v != "" {
		return v
	}
	base := os.Getenv("APPDATA")
	if base == "" {
		if up := os.Getenv("USERPROFILE"); up != "" {
			base = filepath.Join(up, "AppData", "Roaming")
		}
	}
	d := filepath.Join(base, "bethstudio")
	if _, err := os.Stat(d); err != nil {
		legacy := filepath.Join(base, "wezterminator")
		if st, err := os.Stat(legacy); err == nil && st.IsDir() {
			return legacy
		}
	}
	return d
}
