package main

// perf_defender.go — exclusoes do Windows Defender para as pastas do Beth Studio.
//
// Em notebook lento, o antivirus em tempo real examina cada arquivo que o Studio
// e o WebView2 gravam (cache, perfil, logs). Excluir so' as DUAS pastas abaixo
// alivia isso. Reduz um pouco a protecao dessas pastas, por isso:
//
//   - so' acontece depois de um confirm explicito, mostrando os caminhos;
//   - quem faz a mudanca e' um PowerShell elevado pelo UAC (a janela de
//     permissao do Windows): o Studio nunca roda como administrador;
//   - o script elevado e' montado aqui, com os caminhos entre aspas, e confere
//     depois se a exclusao ficou valendo (politica da empresa ou Protecao contra
//     Violacoes podem impedir);
//   - nao funciona pelo Studio remoto nem no modo somente leitura.
//
// O resultado volta so' pelo codigo de saida (sem arquivo temporario).

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type defenderPath struct {
	Label string `json:"label"`
	Path  string `json:"path"`
}

type defenderView struct {
	Supported bool           `json:"supported"`
	Antivirus []string       `json:"antivirus"`
	Defender  bool           `json:"defender"`
	Paths     []defenderPath `json:"paths"`
}

// Codigos de saida do script elevado (e do PowerShell externo).
const (
	defenderOK        = 0
	defenderFailed    = 3    // o Add/Remove-MpPreference falhou
	defenderNotKept   = 4    // rodou, mas a exclusao nao ficou valendo (politica / Protecao contra Violacoes)
	defenderCancelled = 1223 // ERROR_CANCELLED: o usuario recusou o UAC
)

var (
	perfAntivirus    = detectAntivirus // plataforma
	perfElevate      = runDefenderElevated
	perfOpenSecurity = openWindowsSecurity
	perfExecutable   = os.Executable
	perfDataDir      = dataDir
)

// defenderPaths: as pastas do programa e dos dados (que inclui o perfil do WebView2).
func defenderPaths() []defenderPath {
	var out []defenderPath
	seen := map[string]bool{}
	add := func(label, p string) {
		if p == "" {
			return
		}
		p = filepath.Clean(p)
		key := strings.ToLower(p)
		if seen[key] {
			return
		}
		if st, err := os.Stat(p); err != nil || !st.IsDir() {
			return
		}
		seen[key] = true
		out = append(out, defenderPath{Label: label, Path: p})
	}
	if exe, err := perfExecutable(); err == nil {
		add("Programa do Beth Studio", filepath.Dir(exe))
	}
	add("Dados do Beth Studio (inclui o WebView2)", perfDataDir())
	return out
}

// psQuote: literal entre aspas simples do PowerShell (aspa simples no texto vira duas).
func psQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }

// defenderScript: o que roda ELEVADO. Confere o resultado lendo as exclusoes de volta.
func defenderScript(paths []string, remove bool) string {
	list := make([]string, len(paths))
	for i, p := range paths {
		list[i] = psQuote(p)
	}
	arr := "@(" + strings.Join(list, ",") + ")"
	var b strings.Builder
	b.WriteString("$ErrorActionPreference='Stop'\n")
	b.WriteString("$p = " + arr + "\n")
	b.WriteString("try {\n")
	if remove {
		b.WriteString("  Remove-MpPreference -ExclusionPath $p\n")
	} else {
		b.WriteString("  Add-MpPreference -ExclusionPath $p\n")
	}
	b.WriteString("  $now = @((Get-MpPreference).ExclusionPath)\n")
	b.WriteString("  foreach ($x in $p) {\n")
	b.WriteString("    $has = $false\n")
	b.WriteString("    foreach ($y in $now) { if ([string]::Equals($y, $x, 'OrdinalIgnoreCase')) { $has = $true } }\n")
	if remove {
		b.WriteString("    if ($has) { exit 4 }\n")
	} else {
		b.WriteString("    if (-not $has) { exit 4 }\n")
	}
	b.WriteString("  }\n")
	b.WriteString("  exit 0\n")
	b.WriteString("} catch { exit 3 }\n")
	return b.String()
}

func (s *server) perfBlocked(remoteKey string) string {
	if remoteKey != "" {
		return "Isto só pode ser feito no Studio deste computador."
	}
	if s.hub != nil && s.hub.readOnly {
		return "Neste modo não é possível mudar o antivírus."
	}
	return ""
}

func (s *server) servePerfDefender(w http.ResponseWriter, r *http.Request, remoteKey string) {
	switch r.URL.Path {
	case "/api/perf/defender":
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "use GET", http.StatusMethodNotAllowed)
			return
		}
		if msg := s.perfBlocked(remoteKey); msg != "" {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": msg})
			return
		}
		writeJSON(w, http.StatusOK, defenderStatus())
	case "/api/perf/defender/apply", "/api/perf/defender/remove":
		s.servePerfDefenderChange(w, r, remoteKey, r.URL.Path == "/api/perf/defender/remove")
	case "/api/perf/defender/open-security":
		if r.Method != http.MethodPost {
			http.Error(w, "use POST", http.StatusMethodNotAllowed)
			return
		}
		if msg := s.perfBlocked(remoteKey); msg != "" {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": msg})
			return
		}
		if err := perfOpenSecurity(); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Não consegui abrir a Segurança do Windows."})
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	default:
		http.NotFound(w, r)
	}
}

func defenderStatus() defenderView {
	names, supported := perfAntivirus()
	v := defenderView{Supported: supported, Antivirus: names, Paths: defenderPaths()}
	if v.Antivirus == nil {
		v.Antivirus = []string{}
	}
	for _, n := range names {
		l := strings.ToLower(n)
		if strings.Contains(l, "defender") {
			v.Defender = true
		}
	}
	return v
}

func (s *server) servePerfDefenderChange(w http.ResponseWriter, r *http.Request, remoteKey string, remove bool) {
	if r.Method != http.MethodPost {
		http.Error(w, "use POST", http.StatusMethodNotAllowed)
		return
	}
	if msg := s.perfBlocked(remoteKey); msg != "" {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": msg})
		return
	}
	var body struct {
		Confirm bool `json:"confirm"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil || !body.Confirm {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Confirme para continuar. Nada foi alterado."})
		return
	}
	st := defenderStatus()
	if !st.Supported {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Esta função só existe no Windows."})
		return
	}
	if !st.Defender {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "O Windows Defender não é o antivírus deste computador. Adicione as pastas no seu antivírus. Nada foi alterado."})
		return
	}
	if len(st.Paths) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Não encontrei as pastas do Beth Studio. Nada foi alterado."})
		return
	}
	paths := make([]string, len(st.Paths))
	for i, p := range st.Paths {
		paths[i] = p.Path
	}
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Minute) // o UAC espera o usuário
	defer cancel()
	code, err := perfElevate(ctx, defenderScript(paths, remove))
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Não consegui pedir a permissão de administrador."})
		return
	}
	msg, status := defenderOutcome(code, remove)
	if status != http.StatusOK {
		writeJSON(w, status, map[string]string{"error": msg})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "message": msg, "paths": st.Paths})
}

func defenderOutcome(code int, remove bool) (string, int) {
	switch code {
	case defenderOK:
		if remove {
			return "Exclusões removidas. O Defender volta a examinar as pastas do Beth Studio.", http.StatusOK
		}
		return "Pronto: as pastas do Beth Studio foram adicionadas às exclusões do Defender.", http.StatusOK
	case defenderCancelled:
		return "Você recusou a permissão de administrador. Nada foi alterado.", http.StatusConflict
	case defenderNotKept:
		return "O Windows aceitou o comando, mas a exclusão não ficou valendo (política da empresa ou Proteção contra Violações). Faça pela Segurança do Windows.", http.StatusConflict
	default:
		return "Não foi possível alterar as exclusões do Defender. Faça pela Segurança do Windows.", http.StatusInternalServerError
	}
}
