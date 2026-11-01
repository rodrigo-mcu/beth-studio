package main

// tempclean.go - limpeza automatica dos arquivos temporarios que o Studio
// cria: imagens e arquivos colados (clipboard-*.png, file-*) e textos longos
// do Falar (fala-*.txt). So' apaga arquivos com esses prefixos, direto nas
// duas pastas (sem entrar em subpastas), e so' os mais velhos que N dias.

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	tempCleanDefaultDays = 10
	tempCleanMaxDays     = 365
)

// TempCleanSettings fica em web-settings.json ("temp_clean"). Zero = ligado, 10 dias.
type TempCleanSettings struct {
	Off  bool `json:"off,omitempty"`
	Days int  `json:"days,omitempty"`
}

func (c TempCleanSettings) days() int {
	if c.Days <= 0 {
		return tempCleanDefaultDays
	}
	if c.Days > tempCleanMaxDays {
		return tempCleanMaxDays
	}
	return c.Days
}

func (st *settingsStore) tempClean() TempCleanSettings {
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.s.TempClean == nil {
		return TempCleanSettings{}
	}
	return *st.s.TempClean
}

func (st *settingsStore) setTempClean(c TempCleanSettings) error {
	st.mu.Lock()
	defer st.mu.Unlock()
	st.s.TempClean = &c
	return st.saveLocked()
}

func tempCleanDirs() []string { return []string{imageDir(), textDir()} }

func tempCleanOwned(name string) bool {
	return strings.HasPrefix(name, "clipboard-") || strings.HasPrefix(name, "file-") || strings.HasPrefix(name, "fala-")
}

type tempCleanStat struct {
	Files        int   `json:"files"`
	Bytes        int64 `json:"bytes"`
	OldFiles     int   `json:"old_files"`
	OldBytes     int64 `json:"old_bytes"`
	RemovedFiles int   `json:"removed_files,omitempty"`
	RemovedBytes int64 `json:"removed_bytes,omitempty"`
}

// tempCleanScan conta (e, com remove, apaga) os arquivos mais velhos que days.
func tempCleanScan(days int, remove bool, now time.Time) tempCleanStat {
	var st tempCleanStat
	cutoff := now.Add(-time.Duration(days) * 24 * time.Hour)
	for _, dir := range tempCleanDirs() {
		ents, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, e := range ents {
			if e.IsDir() || !e.Type().IsRegular() || !tempCleanOwned(e.Name()) {
				continue
			}
			info, err := e.Info()
			if err != nil {
				continue
			}
			st.Files++
			st.Bytes += info.Size()
			if info.ModTime().Before(cutoff) {
				st.OldFiles++
				st.OldBytes += info.Size()
				if remove && os.Remove(filepath.Join(dir, e.Name())) == nil {
					st.RemovedFiles++
					st.RemovedBytes += info.Size()
				}
			}
		}
	}
	return st
}

// startTempClean: uma varredura 1 min depois de abrir e depois a cada 6 h.
func startTempClean() {
	go func() {
		time.Sleep(time.Minute)
		for {
			if c := settings.tempClean(); !c.Off {
				_ = tempCleanScan(c.days(), true, time.Now())
			}
			time.Sleep(6 * time.Hour)
		}
	}()
}

type tempCleanView struct {
	Enabled bool `json:"enabled"`
	Days    int  `json:"days"`
	tempCleanStat
	Dirs []string `json:"dirs"`
}

func (s *server) serveTempClean(w http.ResponseWriter, r *http.Request, remoteKey string) {
	if remoteKey != "" {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "A limpeza de temporários é só do Studio deste computador."})
		return
	}
	view := func(removed *tempCleanStat) tempCleanView {
		c := settings.tempClean()
		v := tempCleanView{Enabled: !c.Off, Days: c.days(), tempCleanStat: tempCleanScan(c.days(), false, time.Now()), Dirs: tempCleanDirs()}
		if removed != nil {
			v.RemovedFiles, v.RemovedBytes = removed.RemovedFiles, removed.RemovedBytes
		}
		return v
	}
	switch r.URL.Path {
	case "/api/temp-clean":
		if r.Method == http.MethodGet {
			writeJSON(w, http.StatusOK, view(nil))
			return
		}
		var body struct {
			Enabled bool `json:"enabled"`
			Days    int  `json:"days"`
		}
		if r.Method != http.MethodPost || json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body) != nil || body.Days < 1 || body.Days > tempCleanMaxDays {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "informe de 1 a 365 dias"})
			return
		}
		if err := settings.setTempClean(TempCleanSettings{Off: !body.Enabled, Days: body.Days}); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, view(nil))
	case "/api/temp-clean/run":
		if r.Method != http.MethodPost || (s.hub != nil && s.hub.readOnly) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "pedido inválido"})
			return
		}
		st := tempCleanScan(settings.tempClean().days(), true, time.Now())
		writeJSON(w, http.StatusOK, view(&st))
	default:
		http.NotFound(w, r)
	}
}
