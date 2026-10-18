package vpsinstall

import (
	"context"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Listener é um socket TCP em escuta no servidor (saída de `ss -ltnp`).
type Listener struct {
	Addr string
	Port int
	Proc string
}

var procRe = regexp.MustCompile(`\(\("([^"]+)"`)

// ParseListeners lê a saída de `ss -H -ltnp`.
func ParseListeners(out string) []Listener {
	var ls []Listener
	for _, line := range strings.Split(out, "\n") {
		f := strings.Fields(line)
		if len(f) < 4 {
			continue
		}
		local := f[3]
		i := strings.LastIndex(local, ":")
		if i < 0 {
			continue
		}
		port, err := strconv.Atoi(local[i+1:])
		if err != nil {
			continue
		}
		l := Listener{Addr: local[:i], Port: port}
		if m := procRe.FindStringSubmatch(line); m != nil {
			l.Proc = m[1]
		}
		ls = append(ls, l)
	}
	return ls
}

// ParseOSRelease devolve ID e VERSION_ID de /etc/os-release.
func ParseOSRelease(s string) (id, version string) {
	for _, line := range strings.Split(s, "\n") {
		k, v, ok := strings.Cut(strings.TrimSpace(line), "=")
		if !ok {
			continue
		}
		v = strings.Trim(v, `"'`)
		switch k {
		case "ID":
			id = strings.ToLower(v)
		case "VERSION_ID":
			version = v
		}
	}
	return
}

// SupportedOS: só as versões atuais de Debian e Ubuntu com apt e systemd.
func SupportedOS(id, version string) bool {
	switch id {
	case "debian":
		return version == "11" || version == "12" || version == "13"
	case "ubuntu":
		return version == "22.04" || version == "24.04" || version == "26.04"
	}
	return false
}

// ArchName converte `uname -m` para o nome usado nos binários.
func ArchName(uname string) string {
	switch strings.TrimSpace(uname) {
	case "x86_64", "amd64":
		return "amd64"
	case "aarch64", "arm64":
		return "arm64"
	}
	return ""
}

// Preflight é o resultado da verificação do servidor. Nada é alterado nele.
type Preflight struct {
	OS          string
	Arch        string
	Sudo        SudoMode
	Problems    []string
	ProxySHA    string
	SSHPorts    []int
}

func (p Preflight) OK() bool { return len(p.Problems) == 0 }

// Check roda os comandos de leitura e monta o relatório. Erros de rede voltam
// como error; problemas do servidor vão em Problems (e a instalação não começa).
func (s *session) Check(ctx context.Context) (Preflight, error) {
	var pf Preflight
	res, err := s.r.Run(ctx, cmdOSRelease, "")
	if err != nil {
		return pf, err
	}
	id, ver := ParseOSRelease(res.Stdout)
	pf.OS = strings.TrimSpace(id + " " + ver)
	if !SupportedOS(id, ver) {
		shown := pf.OS
		if shown == "" {
			shown = "desconhecido"
		}
		pf.Problems = append(pf.Problems, fmt.Sprintf("Sistema não suportado (%s). O assistente funciona em Debian 11, 12 e 13 e Ubuntu 22.04, 24.04 e 26.04.", shown))
	}
	res, err = s.r.Run(ctx, cmdArch, "")
	if err != nil {
		return pf, err
	}
	pf.Arch = ArchName(res.Stdout)
	if pf.Arch == "" {
		pf.Problems = append(pf.Problems, fmt.Sprintf("Arquitetura não suportada (%s). Só amd64 (x86_64) e arm64 (aarch64).", strings.TrimSpace(res.Stdout)))
	}
	if res, err = s.r.Run(ctx, cmdSystemd, ""); err != nil {
		return pf, err
	} else if res.Code != 0 {
		pf.Problems = append(pf.Problems, "O servidor não usa systemd, que o assistente precisa para criar o serviço.")
	}

	if err := s.detectSudo(ctx, &pf); err != nil {
		return pf, err
	}
	if pf.Sudo == SudoNone {
		pf.Problems = append(pf.Problems, fmt.Sprintf("O usuário %s não é root e não consegue usar sudo. Entre como root, ou como um usuário com sudo (informe a senha dele).", s.user))
		return pf, nil
	}

	ports, err := s.priv(ctx, cmdPorts)
	if err != nil {
		return pf, err
	}
	listeners := ParseListeners(ports.Stdout)

	home, err := s.r.Run(ctx, cmdUserHome, "")
	if err != nil {
		return pf, err
	}
	if h := strings.TrimSpace(home.Stdout); h != "" && h != ProxyData {
		pf.Problems = append(pf.Problems, fmt.Sprintf("Já existe um usuário %s neste servidor que não é deste assistente (pasta pessoal %s). Use um servidor limpo.", ProxyUser, h))
	}

	seen := map[string]bool{}
	for _, l := range listeners {
		if l.Proc == "sshd" || l.Proc == "ssh" {
			pf.SSHPorts = append(pf.SSHPorts, l.Port)
		}
		switch l.Port {
		case 80, 443:
			// uma instalação anterior deste assistente (reinstalar/atualizar) pode estar de pé
			if l.Proc == "bethstudio-proxy" {
				continue
			}
		default:
			continue
		}
		key := fmt.Sprintf("%d/%s", l.Port, l.Proc)
		if seen[key] {
			continue
		}
		seen[key] = true
		who := l.Proc
		if who == "" {
			who = "um programa que não consegui identificar"
		}
		if l.Proc == "docker-proxy" {
			who = "o Docker (docker-proxy)"
		}
		pf.Problems = append(pf.Problems, fmt.Sprintf("A porta %d já está em uso por %s. O bethstudio-proxy atende HTTPS sozinho e precisa das portas 80 e 443. O assistente só instala em servidor limpo e não remove nada: libere a porta você mesmo ou use outro servidor.", l.Port, who))
	}

	svc, err := s.r.Run(ctx, cmdServices, "")
	if err != nil {
		return pf, err
	}
	names := []string{"nginx", "apache2", "httpd", "lighttpd", "haproxy", "caddy"}
	lines := strings.Fields(svc.Stdout)
	for i, st := range lines {
		if i < len(names) && st == "active" {
			pf.Problems = append(pf.Problems, fmt.Sprintf("O serviço %s está ativo. O bethstudio-proxy atende HTTPS sozinho nas portas 80 e 443 e este assistente não mexe em outros servidores web: use um servidor limpo.", names[i]))
		}
	}

	if sha, err := s.r.Run(ctx, cmdProxySHA, ""); err == nil {
		pf.ProxySHA = strings.TrimSpace(sha.Stdout)
	}
	sort.Ints(pf.SSHPorts)
	pf.SSHPorts = dedupInts(pf.SSHPorts)
	return pf, nil
}

func dedupInts(in []int) []int {
	var out []int
	for i, v := range in {
		if i == 0 || v != in[i-1] {
			out = append(out, v)
		}
	}
	return out
}

func (s *session) detectSudo(ctx context.Context, pf *Preflight) error {
	res, err := s.r.Run(ctx, cmdUID, "")
	if err != nil {
		return err
	}
	if strings.TrimSpace(res.Stdout) == "0" {
		pf.Sudo = SudoRoot
		s.mode = SudoRoot
		return nil
	}
	res, err = s.r.Run(ctx, cmdSudoNopw, "")
	if err != nil {
		return err
	}
	if res.Code == 0 {
		pf.Sudo, s.mode = SudoNoPass, SudoNoPass
		return nil
	}
	if s.password != "" {
		cmd, in := wrapPriv(SudoPassword, s.password, "true")
		res, err = s.r.Run(ctx, cmd, in)
		if err != nil {
			return err
		}
		if res.Code == 0 {
			pf.Sudo, s.mode = SudoPassword, SudoPassword
			return nil
		}
	}
	pf.Sudo, s.mode = SudoNone, SudoNone
	return nil
}
