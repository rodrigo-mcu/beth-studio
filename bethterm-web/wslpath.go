package main

// wslpath.go — o pane roda no WSL? E em qual distro? Usado para abrir no
// painel de preview um caminho Linux ("/home/...", "/mnt/data/...") que
// aparece na saida de um terminal WSL — inclusive quando o pane foi
// classificado como "agente"/outro (ex. um agente de IA rodando no WSL).
//
// A distro vem, em ordem: do argv (wsl.exe -d X), do cwd UNC
// (\\wsl$\X\... ou \\wsl.localhost\X\...), ou da distro PADRAO gravada no
// registro (HKCU\...\Lxss, DefaultDistribution -> DistributionName). Ler o
// registro nao inicia nenhuma distro (ao contrario de rodar wsl.exe).

import (
	"strings"
	"sync"
	"time"

	"golang.org/x/sys/windows/registry"
)

const lxssKey = `Software\Microsoft\Windows\CurrentVersion\Lxss`

// listWSLDistros: nomes das distros instaladas (registro, sem rodar wsl.exe),
// a padrão primeiro.
func listWSLDistros() []string {
	k, err := registry.OpenKey(registry.CURRENT_USER, lxssKey, registry.ENUMERATE_SUB_KEYS)
	if err != nil {
		return nil
	}
	guids, _ := k.ReadSubKeyNames(-1)
	k.Close()
	def := readDefaultWSLDistro()
	var out []string
	for _, g := range guids {
		d, err := registry.OpenKey(registry.CURRENT_USER, lxssKey+`\`+g, registry.QUERY_VALUE)
		if err != nil {
			continue
		}
		name, _, err := d.GetStringValue("DistributionName")
		d.Close()
		if err != nil || name == "" || strings.HasPrefix(strings.ToLower(name), "docker-desktop") {
			continue
		}
		if name == def {
			out = append([]string{name}, out...)
		} else {
			out = append(out, name)
		}
	}
	return out
}

// readDefaultWSLDistro: nome da distro padrao, "" se nao houver WSL.
func readDefaultWSLDistro() string {
	k, err := registry.OpenKey(registry.CURRENT_USER, lxssKey, registry.QUERY_VALUE)
	if err != nil {
		return ""
	}
	guid, _, err := k.GetStringValue("DefaultDistribution")
	k.Close()
	if err != nil || guid == "" {
		return ""
	}
	d, err := registry.OpenKey(registry.CURRENT_USER, lxssKey+`\`+guid, registry.QUERY_VALUE)
	if err != nil {
		return ""
	}
	defer d.Close()
	name, _, err := d.GetStringValue("DistributionName")
	if err != nil {
		return ""
	}
	return name
}

var wslDefault struct {
	mu   sync.Mutex
	at   time.Time
	name string
}

// defaultWSLDistro: cache de 30 s (a lista e' enriquecida a cada `list`).
// Variavel para os testes trocarem.
var defaultWSLDistro = func() string {
	wslDefault.mu.Lock()
	defer wslDefault.mu.Unlock()
	if time.Since(wslDefault.at) > 30*time.Second {
		wslDefault.name = readDefaultWSLDistro()
		wslDefault.at = time.Now()
	}
	return wslDefault.name
}

// cwdPath: o caminho de um cwd "file://host/caminho" (sem o host), ou o
// proprio texto se nao for URI.
func cwdPath(cwd string) string {
	if !strings.HasPrefix(cwd, "file://") {
		return cwd
	}
	rest := cwd[len("file://"):]
	host, path := rest, ""
	if i := strings.IndexByte(rest, '/'); i >= 0 {
		host, path = rest[:i], rest[i:]
	}
	if h := strings.ToLower(host); h == "wsl$" || h == "wsl.localhost" {
		return `\\` + host + strings.ReplaceAll(path, "/", `\`)
	}
	return path
}

// wslDistroFromUNC: "\\wsl$\Ubuntu\..." / "\\wsl.localhost\Ubuntu\..." -> "Ubuntu".
func wslDistroFromUNC(p string) string {
	p = strings.ReplaceAll(p, "/", `\`)
	low := strings.ToLower(p)
	for _, pre := range []string{`\\wsl$\`, `\\wsl.localhost\`} {
		if strings.HasPrefix(low, pre) {
			rest := p[len(pre):]
			if i := strings.IndexByte(rest, '\\'); i >= 0 {
				rest = rest[:i]
			}
			return rest
		}
	}
	return ""
}

// paneWSL: o pane roda no WSL e, se der para saber, em qual distro.
func paneWSL(k PaneKind, cwd string) (bool, string) {
	uncDistro := wslDistroFromUNC(cwdPath(cwd))
	switch k.Kind {
	case "wsl":
	case "other", "unknown":
		// agente (ou outro programa) sem registro de comando: vale o cwd
		if !cwdLooksWSL(cwd) && uncDistro == "" {
			return false, ""
		}
	default:
		return false, ""
	}
	d := k.Distro
	if d == "" {
		d = uncDistro
	}
	if d == "" {
		d = defaultWSLDistro()
	}
	return true, d
}
