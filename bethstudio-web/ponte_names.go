package main

// ponte_names.go — nomes dos agentes na ponte.
//
// Quem fala com o agente pelo nome que o usuário conhece ("MOBI VMS"), não
// por um nome tirado da pasta. O Claude Code guarda cada sessão aberta em
// <home>\.claude\sessions\<pid>.json, com o `name` dela (o mesmo que o
// /list-agents mostra). O servidor da ponte lê esse arquivo.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"unicode"
	"unsafe"

	"golang.org/x/sys/windows"
)

// cleanAgentName: nome legível, com espaços, sem caracteres de controle.
func cleanAgentName(s string) string {
	var b strings.Builder
	space := false
	for _, r := range s {
		switch {
		case unicode.IsControl(r):
			continue
		case unicode.IsSpace(r):
			space = true
		default:
			if space && b.Len() > 0 {
				b.WriteByte(' ')
			}
			space = false
			b.WriteRune(r)
		}
	}
	out := strings.TrimSpace(b.String())
	if r := []rune(out); len(r) > 60 {
		out = string(r[:60])
	}
	return out
}

var accentFold = strings.NewReplacer(
	"á", "a", "à", "a", "â", "a", "ã", "a", "ä", "a", "é", "e", "è", "e", "ê", "e", "ë", "e",
	"í", "i", "ì", "i", "î", "i", "ï", "i", "ó", "o", "ò", "o", "ô", "o", "õ", "o", "ö", "o",
	"ú", "u", "ù", "u", "û", "u", "ü", "u", "ç", "c", "ñ", "n",
)

// normKey: só letras e números, minúsculas, sem acento: "MOBI VMS", "mobi-vms"
// e "Mobi_Vms" viram a mesma chave.
func normKey(s string) string {
	s = accentFold.Replace(strings.ToLower(s))
	var b strings.Builder
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// ---------------------------------------------------------------------------
// registro de sessões do Claude Code
// ---------------------------------------------------------------------------

type claudeSession struct {
	PID       int    `json:"pid"`
	SessionID string `json:"sessionId"`
	Name      string `json:"name"`
	Cwd       string `json:"cwd"`
}

func readClaudeSessions(dir string) []claudeSession {
	files, _ := filepath.Glob(filepath.Join(dir, "*.json"))
	var out []claudeSession
	for _, f := range files {
		st, err := os.Stat(f)
		if err != nil || st.IsDir() || st.Size() > 64<<10 {
			continue
		}
		b, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		var s claudeSession
		if json.Unmarshal(b, &s) == nil && (s.SessionID != "" || s.PID != 0) {
			out = append(out, s)
		}
	}
	return out
}

// windowsHomeDir: a pasta do usuário do Windows, mesmo quando o programa foi
// aberto pelo WSL e sem USERPROFILE.
func windowsHomeDir() string {
	if h, err := os.UserHomeDir(); err == nil && h != "" {
		return h
	}
	if p, err := windows.KnownFolderPath(windows.FOLDERID_Profile, 0); err == nil {
		return p
	}
	return ""
}

// wslDistroFromPath: "\\wsl.localhost\Debian\home\u" -> "Debian".
func wslDistroFromPath(p string) string {
	l := strings.ReplaceAll(p, "/", `\`)
	for _, pre := range []string{`\\wsl.localhost\`, `\\wsl$\`} {
		if strings.HasPrefix(strings.ToLower(l), pre) {
			rest := l[len(pre):]
			if i := strings.IndexByte(rest, '\\'); i > 0 {
				return rest[:i]
			}
			return rest
		}
	}
	return ""
}

// claudeSessionDirs: onde procurar o registro de sessões de cada lado.
func claudeSessionDirs(side, cwd string) []string {
	if side != "wsl" {
		if h := windowsHomeDir(); h != "" {
			return []string{filepath.Join(h, ".claude", "sessions")}
		}
		return nil
	}
	distro := wslDistroFromPath(cwd)
	if distro == "" {
		distro = strings.TrimSpace(os.Getenv("WSL_DISTRO_NAME"))
	}
	if distro == "" || !safeDistroName(distro) {
		return nil
	}
	root := `\\wsl.localhost\` + distro
	dirs, _ := filepath.Glob(root + `\home\*\.claude\sessions`)
	return append(dirs, root+`\root\.claude\sessions`)
}

// claudeSessionName: o nome da sessão do Claude, pelo id da sessão ou, se não
// houver, pelo pid do claude.exe. "" se não achar (ou se não tiver nome).
func claudeSessionName(dirs []string, sid string, pid int) string {
	for _, d := range dirs {
		for _, s := range readClaudeSessions(d) {
			if (sid != "" && s.SessionID == sid) || (sid == "" && pid != 0 && s.PID == pid) {
				return cleanAgentName(s.Name)
			}
		}
	}
	return ""
}

// windowsParentPID: pid do processo que abriu `pid` (0 se não achar). O Studio
// usa para descobrir qual claude.exe abriu um servidor da ponte antigo, que
// não mandou o id da sessão.
func windowsParentPID(pid int) int {
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return 0
	}
	defer windows.CloseHandle(snap)
	var e windows.ProcessEntry32
	e.Size = uint32(unsafe.Sizeof(e))
	for err = windows.Process32First(snap, &e); err == nil; err = windows.Process32Next(snap, &e) {
		if int(e.ProcessID) == pid {
			return int(e.ParentProcessID)
		}
	}
	return 0
}
