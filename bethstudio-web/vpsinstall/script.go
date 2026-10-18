package vpsinstall

import (
	"fmt"
	"strconv"
	"strings"
)

// Tudo que roda no servidor está aqui, como texto fixo. Só entram valores já
// validados (domínio, portas inteiras, sha256 em hex, caminhos devolvidos pelo
// próprio servidor e passados por shQuote). Nada vem do usuário sem validação.

const (
	ProxyBin           = "/usr/local/bin/bethstudio-proxy"
	ProxyUnit          = "/etc/systemd/system/bethstudio-proxy.service"
	ProxyData          = "/var/lib/bethstudio-proxy"
	ProxyListen        = "127.0.0.1:8787"
	CaddyfilePath      = "/etc/caddy/Caddyfile"
	CaddyMarker        = "# bethstudio-managed"
	WizardDir          = "/etc/bethstudio-wizard"
	CaddyInstalledMark = WizardDir + "/caddy-installed"
)

const (
	cmdOSRelease = "cat /etc/os-release"
	cmdArch      = "uname -m"
	cmdUID       = "id -u"
	cmdSystemd   = "test -d /run/systemd/system"
	cmdSudoNopw  = "sudo -n true"
	cmdPorts     = "ss -H -ltnp"
	cmdServices  = "systemctl is-active nginx apache2 httpd lighttpd haproxy || true"
	cmdProxySHA  = "sha256sum " + ProxyBin + " 2>/dev/null | cut -d' ' -f1; true"
	cmdLinkSec   = "cat " + ProxyData + "/link-secret"
)

const cmdCaddyState = `v=0; command -v caddy >/dev/null 2>&1 && v=1; o=0; grep -qs '^` + CaddyMarker + `' ` + CaddyfilePath + ` && o=1; m=0; [ -f ` + CaddyInstalledMark + ` ] && m=1; echo "caddy=$v ours=$o marker=$m"`

// SudoMode diz como comandos privilegiados são executados.
type SudoMode int

const (
	SudoNone     SudoMode = iota // sem privilégio
	SudoRoot                     // já é root
	SudoNoPass                   // sudo -n
	SudoPassword                 // sudo -S, com a senha do usuário no stdin
)

// wrapPriv devolve o comando e o stdin para executar script (bash) como root.
func wrapPriv(mode SudoMode, password, script string) (cmd, stdin string) {
	q := shQuote(script)
	switch mode {
	case SudoRoot:
		return "bash -c " + q, ""
	case SudoNoPass:
		return "sudo -n bash -c " + q, ""
	case SudoPassword:
		return "sudo -S -p '' bash -c " + q, password + "\n"
	}
	return "bash -c " + q, ""
}

func cmdStopProxy() string {
	return "systemctl stop bethstudio-proxy 2>/dev/null || true"
}

func cmdVerifySHA(sha, path string) string {
	return "echo " + shQuote(sha+"  "+path) + " | sha256sum -c -"
}

func cmdInstallProxyBin(src string) string {
	return "install -m 0755 -o root -g root " + shQuote(src) + " " + ProxyBin
}

func cmdProxyService(domain string) string {
	return ProxyBin + " -listen " + ProxyListen + " -domain " + domain + " -data " + ProxyData + " -service >/dev/null && systemctl restart bethstudio-proxy"
}

func cmdPrereqs() string {
	return `set -e; export DEBIAN_FRONTEND=noninteractive; apt-get update -qq; apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl gnupg ca-certificates`
}

// cmdInstallCaddy segue https://caddyserver.com/docs/install (Debian/Ubuntu).
func cmdInstallCaddy() string {
	return `set -euo pipefail; export DEBIAN_FRONTEND=noninteractive
if [ ! -f /usr/share/keyrings/caddy-stable-archive-keyring.gpg ]; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
fi
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' -o /etc/apt/sources.list.d/caddy-stable.list
chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
apt-get update -qq
apt-get install -y -qq caddy
mkdir -p ` + WizardDir + ` && touch ` + CaddyInstalledMark
}

// Caddyfile devolve a configuração do Beth (domínio já validado).
func Caddyfile(domain string) string {
	return CaddyMarker + " (gerado pelo Beth Studio; o assistente pode reescrever este arquivo)\n" +
		domain + " {\n" +
		"\theader {\n" +
		"\t\tStrict-Transport-Security \"max-age=31536000\"\n" +
		"\t\tX-Content-Type-Options \"nosniff\"\n" +
		"\t\t-Server\n" +
		"\t}\n" +
		"\treverse_proxy " + ProxyListen + "\n" +
		"}\n"
}

func cmdValidateCaddy(path string) string {
	return "caddy validate --config " + shQuote(path) + " --adapter caddyfile"
}

func cmdApplyCaddyfile(src string) string {
	return "install -m 0644 -o root -g root " + shQuote(src) + " " + CaddyfilePath +
		" && systemctl enable caddy >/dev/null 2>&1 && systemctl reload-or-restart caddy"
}

func cmdFirewall(sshPorts []int) string {
	var b strings.Builder
	b.WriteString("set -e; export DEBIAN_FRONTEND=noninteractive; command -v ufw >/dev/null 2>&1 || apt-get install -y -qq ufw\n")
	for _, p := range sshPorts {
		b.WriteString("ufw allow " + strconv.Itoa(p) + "/tcp >/dev/null\n")
	}
	b.WriteString("ufw allow 80/tcp >/dev/null\nufw allow 443/tcp >/dev/null\n")
	b.WriteString("ufw default deny incoming >/dev/null\nufw default allow outgoing >/dev/null\nufw --force enable >/dev/null")
	return b.String()
}

func cmdUnattended() string {
	return `set -e; export DEBIAN_FRONTEND=noninteractive; apt-get install -y -qq unattended-upgrades
printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' > /etc/apt/apt.conf.d/20auto-upgrades`
}

func cmdStatus() string {
	return "systemctl is-active bethstudio-proxy caddy ufw || true; echo ---; systemctl --no-pager --lines=0 status bethstudio-proxy caddy 2>&1 | grep -E 'Active:|Loaded:' || true"
}

func cmdLogs() string {
	return "echo '== bethstudio-proxy =='; journalctl -u bethstudio-proxy -n 60 --no-pager 2>&1; echo; echo '== caddy =='; journalctl -u caddy -n 60 --no-pager 2>&1"
}

// cmdRemove desfaz só o que o assistente instalou: serviço, binário, dados e a
// configuração do Caddy (se for a do assistente). Não desinstala pacotes.
func cmdRemove() string {
	return `set -e
systemctl disable --now bethstudio-proxy >/dev/null 2>&1 || true
rm -f ` + ProxyUnit + ` ` + ProxyBin + `
systemctl daemon-reload
rm -rf ` + ProxyData + `
if grep -qs '^` + CaddyMarker + `' ` + CaddyfilePath + `; then
  printf '# Configuração removida pelo Beth Studio.\n' > ` + CaddyfilePath + `
  systemctl reload-or-restart caddy >/dev/null 2>&1 || true
fi`
}

func uploadName(kind string) string {
	return fmt.Sprintf(".bethstudio-upload-%s", kind)
}
