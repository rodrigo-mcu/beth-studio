package main

// wsl_init_cfg.go — configuração do comando de inicialização do WSL, por
// distro, editada na tela do Studio (Configurações > Terminais > WSL).
// O comando é o que o usuário digitaria no terminal (por exemplo init-wsl2);
// a restauração o usa quando falta a pasta de um terminal (restore_init.go).

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

const (
	wslInitDefaultTimeoutSec = 300
	wslInitMaxTimeoutSec     = 1800
	wslInitMaxCommandRunes   = 1024
)

// WSLInitCfg: o que fazer, para uma distro, quando a pasta de um terminal não existe.
type WSLInitCfg struct {
	Enabled    bool   `json:"enabled"`
	Command    string `json:"command"`
	TimeoutSec int    `json:"timeout_sec"`
	// DefaultDir: pasta de "Abrir na pasta padrão"; vazio = a home do WSL.
	DefaultDir string `json:"default_dir,omitempty"`
}

func hasControl(s string) bool {
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			return true
		}
	}
	return false
}

// validateWSLInit confere e normaliza a configuração. O comando vira texto
// digitado num terminal, por isso não aceita quebra de linha nem controle.
func validateWSLInit(distro string, c WSLInitCfg) (WSLInitCfg, error) {
	if !distroRe.MatchString(distro) {
		return c, errors.New("nome de distro inválido")
	}
	c.Command = strings.TrimSpace(c.Command)
	if hasControl(c.Command) {
		return c, errors.New("o comando não pode ter quebra de linha nem caracteres de controle")
	}
	if utf8.RuneCountInString(c.Command) > wslInitMaxCommandRunes {
		return c, fmt.Errorf("o comando passa de %d caracteres", wslInitMaxCommandRunes)
	}
	if c.Enabled && c.Command == "" {
		return c, errors.New("informe o comando de inicialização")
	}
	if c.TimeoutSec <= 0 {
		c.TimeoutSec = wslInitDefaultTimeoutSec
	}
	if c.TimeoutSec > wslInitMaxTimeoutSec {
		c.TimeoutSec = wslInitMaxTimeoutSec
	}
	c.DefaultDir = strings.TrimSpace(c.DefaultDir)
	if c.DefaultDir != "" {
		if !strings.HasPrefix(c.DefaultDir, "/") || hasControl(c.DefaultDir) || utf8.RuneCountInString(c.DefaultDir) > wslInitMaxCommandRunes {
			return c, errors.New("a pasta padrão deve ser um caminho Linux absoluto (começa com /)")
		}
	}
	return c, nil
}

// wslInitFor devolve a configuração da distro (nome sem distinguir maiúsculas).
func (st *settingsStore) wslInitFor(distro string) (WSLInitCfg, bool) {
	st.mu.Lock()
	defer st.mu.Unlock()
	st.reloadIfChangedLocked()
	c, ok := st.s.WSLInit[strings.ToLower(distro)]
	return c, ok
}

// wslInitAll: cópia de todas as configurações (chave = distro em minúsculas).
func (st *settingsStore) wslInitAll() map[string]WSLInitCfg {
	st.mu.Lock()
	defer st.mu.Unlock()
	st.reloadIfChangedLocked()
	out := make(map[string]WSLInitCfg, len(st.s.WSLInit))
	for k, v := range st.s.WSLInit {
		out[k] = v
	}
	return out
}

// setWSLInit valida e grava a configuração da distro.
func (st *settingsStore) setWSLInit(distro string, c WSLInitCfg) error {
	c, err := validateWSLInit(distro, c)
	if err != nil {
		return err
	}
	_, err = st.mutate(func() error {
		if st.s.WSLInit == nil {
			st.s.WSLInit = map[string]WSLInitCfg{}
		}
		st.s.WSLInit[strings.ToLower(distro)] = c
		return st.saveLocked()
	})
	return err
}

// importWSLDistrosFile migra o antigo wsl-distros.json (que rodava o init em
// silêncio) para a configuração da tela: cada distro sem configuração própria
// ganha o init como comando, ligado. O arquivo vira wsl-distros.json.migrado.
func importWSLDistrosFile(dir string, st *settingsStore) {
	path := filepath.Join(dir, "wsl-distros.json")
	b, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var raw map[string]struct {
		Init       string `json:"init"`
		TimeoutSec int    `json:"timeout_sec"`
	}
	if err := json.Unmarshal(stripBOM(b), &raw); err != nil {
		log.Printf("wsl: wsl-distros.json ilegível (%v); não migrado", err)
		return
	}
	failed := false
	for distro, v := range raw {
		distro = strings.TrimSpace(distro)
		if _, have := st.wslInitFor(distro); have || strings.TrimSpace(v.Init) == "" {
			continue
		}
		if err := st.setWSLInit(distro, WSLInitCfg{Enabled: true, Command: v.Init, TimeoutSec: v.TimeoutSec}); err != nil {
			log.Printf("wsl: init de %q em wsl-distros.json não migrado: %v", distro, err)
			failed = true
		}
	}
	if failed {
		return // o arquivo fica onde está: nada se perde em silêncio e a próxima inicialização tenta de novo
	}
	if err := os.Rename(path, path+".migrado"); err != nil {
		log.Printf("wsl: não foi possível renomear wsl-distros.json: %v", err)
	}
}

type wslInitBody struct {
	Distros []string              `json:"distros"`
	Config  map[string]WSLInitCfg `json:"config"`
}

// wslInitHandler: GET /api/wsl-init (distros instaladas + configurações) e
// POST /api/wsl-init {"distro","config"}; o POST fica bloqueado em modo somente leitura.
func wslInitHandler(st *settingsStore, list func() []string, readOnly bool) http.Handler {
	body := func() wslInitBody {
		d := list()
		if d == nil {
			d = []string{}
		}
		return wslInitBody{Distros: d, Config: st.wslInitAll()}
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			writeJSON(w, http.StatusOK, body())
		case http.MethodPost:
			if readOnly {
				writeJSON(w, http.StatusForbidden, map[string]string{"error": "modo somente leitura"})
				return
			}
			if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
				http.Error(w, "use application/json", http.StatusUnsupportedMediaType)
				return
			}
			var req struct {
				Distro string     `json:"distro"`
				Config WSLInitCfg `json:"config"`
			}
			if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&req); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "JSON inválido"})
				return
			}
			if err := st.setWSLInit(req.Distro, req.Config); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, body())
		default:
			http.Error(w, "método não permitido", http.StatusMethodNotAllowed)
		}
	})
}

// wslInitTestHandler: POST /api/wsl-init/test {"distro"} — "Testar agora": abre o
// terminal de inicialização e digita o comando, sem restaurar nada. Responde 202
// logo; o resultado se vê no próprio terminal.
func wslInitTestHandler(st *settingsStore, readOnly bool, start func(distro string, cfg WSLInitCfg)) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "método não permitido", http.StatusMethodNotAllowed)
			return
		}
		if readOnly {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "modo somente leitura"})
			return
		}
		if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
			http.Error(w, "use application/json", http.StatusUnsupportedMediaType)
			return
		}
		var req struct {
			Distro string `json:"distro"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req); err != nil || !distroRe.MatchString(req.Distro) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "distro inválida"})
			return
		}
		cfg, ok := st.wslInitFor(req.Distro)
		if !ok || strings.TrimSpace(cfg.Command) == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "configure o comando de inicialização antes de testar"})
			return
		}
		start(req.Distro, cfg)
		writeJSON(w, http.StatusAccepted, map[string]bool{"ok": true})
	})
}
