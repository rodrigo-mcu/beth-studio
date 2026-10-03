package main

// about.go — secao "Sobre" das Configuracoes: versao/data do build do web e
// da ponte, e os caminhos dos arquivos (com "Abrir pasta").

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const appVersion = "0.1.0"

// appTitle: nome visivel (janela, avisos). O exe continua bethstudio-web.exe;
// o menu da bandeja chama isto de "Beth Studio" (patch 0186).
const appTitle = "Beth Studio"

// windowTitle: legenda Win32 (barra de tarefas / Alt+Tab). As janelas SFTP
// e Banco de dados trocam isto antes de abrir; o Studio fica com o nome padrão.
var windowTitle = appTitle

// buildTime: preenchido pelo build.ps1 (-ldflags -X main.buildTime=...).
var buildTime = ""

type aboutFile struct {
	ID     string `json:"id"`
	Label  string `json:"label"`
	Path   string `json:"path"`
	Exists bool   `json:"exists"`
}

func aboutFiles() []aboutFile {
	d := dataDir()
	home, _ := os.UserHomeDir()
	wez := filepath.Join(home, ".wezterm.lua")
	for _, c := range []string{
		filepath.Join(os.Getenv("WEZTERM_CONFIG_DIR"), "wezterm.lua"),
		filepath.Join(home, ".wezterm.lua"),
		filepath.Join(os.Getenv("APPDATA"), "wezterm", "wezterm.lua"),
	} {
		if strings.HasPrefix(c, "wezterm.lua") { // WEZTERM_CONFIG_DIR vazio
			continue
		}
		if _, err := os.Stat(c); err == nil {
			wez = c
			break
		}
	}
	files := []aboutFile{
		{ID: "web_settings", Label: "Configurações do web (web-settings.json)", Path: filepath.Join(d, webSettingsFile)},
		{ID: "secrets", Label: "Chaves de API cifradas (secrets.dat)", Path: filepath.Join(d, secretsFile)},
		{ID: "db_connections", Label: "Conexões do Banco de dados (db-connections.json; senhas ficam em secrets.dat)", Path: filepath.Join(d, dbConnectionsFile)},
		{ID: "pane_commands", Label: "Comandos dos terminais da GUI (pane-commands.json)", Path: filepath.Join(d, "pane-commands.json")},
		{ID: "gui_default", Label: "Padrão da GUI (default-theme.json)", Path: filepath.Join(d, guiDefaultFile)},
		{ID: "wezterm_lua", Label: "Configuração do WezTerm/BethStudio (wezterm.lua)", Path: wez},
		{ID: "web_log", Label: "Log do bethstudio-web", Path: filepath.Join(appDataDir(), "bethstudio-web.log")},
		{ID: "host_log", Label: "Log do host (host-life.log)", Path: filepath.Join(d, "host-life.log")},
		{ID: "remote_log", Label: "Acessos pelo celular e Studio remoto (remote-access.log)", Path: filepath.Join(appDataDir(), "remote-access.log")},
	}
	for i := range files {
		_, err := os.Stat(files[i].Path)
		files[i].Exists = err == nil
	}
	return files
}

func (s *server) serveAbout(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		exe, _ := os.Executable()
		bexe := ""
		bmod := ""
		if s.hub.bridge != nil {
			bexe = s.hub.bridge.exe
			if st, err := os.Stat(bexe); err == nil {
				bmod = st.ModTime().Format(time.RFC3339)
			}
		}
		webMod := ""
		if st, err := os.Stat(exe); err == nil {
			webMod = st.ModTime().Format(time.RFC3339)
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"version": appVersion, "build_time": buildTime, "exe": exe, "exe_time": webMod, "go": runtime.Version(),
			"bridge_exe": bexe, "bridge_time": bmod, "data_dir": dataDir(), "read_only": s.hub.readOnly, "files": aboutFiles(),
		})
		return
	}
	if r.Method != http.MethodPost || !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		http.Error(w, "use POST application/json", http.StatusBadRequest)
		return
	}
	var req struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "JSON inválido"})
		return
	}
	for _, f := range aboutFiles() {
		if f.ID != req.ID {
			continue
		}
		if err := revealInExplorer(f.Path, f.Exists); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"path": f.Path})
		return
	}
	writeJSON(w, http.StatusBadRequest, map[string]string{"error": "arquivo desconhecido"})
}

// revealInExplorer abre a pasta (selecionando o arquivo, se existir).
// So' caminhos da lista fixa de aboutFiles chegam aqui.
func revealInExplorer(path string, exists bool) error {
	var cmd *exec.Cmd
	if exists {
		cmd = exec.Command("explorer.exe", "/select,"+path)
	} else {
		dir := filepath.Dir(path)
		if _, err := os.Stat(dir); err != nil {
			return errors.New("a pasta ainda não existe")
		}
		cmd = exec.Command("explorer.exe", dir)
	}
	hideChildWindow(&cmd.SysProcAttr)
	return cmd.Start()
}
