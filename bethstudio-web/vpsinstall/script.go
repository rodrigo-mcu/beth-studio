package vpsinstall

import (
	"fmt"
	"strconv"
	"strings"
)

// Tudo que roda no servidor está aqui, como texto fixo. Só entram valores já
// validados (domínio, portas inteiras, sha256 em hex, caminhos devolvidos pelo
// próprio servidor e passados por shQuote). Nada vem do usuário sem validação.
//
// O servidor recebe um único programa: o bethstudio-proxy, que atende HTTPS
// sozinho (certificado Let's Encrypt automático). Não há Caddy, nginx nem
// repositório apt extra.

const (
	ProxyBin  = "/usr/local/bin/bethstudio-proxy"
	ProxyUnit = "/etc/systemd/system/bethstudio-proxy.service"
	ProxyData = "/var/lib/bethstudio-proxy"
	// ProxyUser é o usuário sem shell que roda o serviço (nunca root).
	ProxyUser = "bethstudio"
)

const (
	cmdOSRelease = "cat /etc/os-release"
	cmdArch      = "uname -m"
	cmdUID       = "id -u"
	cmdSystemd   = "test -d /run/systemd/system"
	cmdSudoNopw  = "sudo -n true"
	cmdPorts     = "ss -H -ltnp"
	cmdServices  = "systemctl is-active nginx apache2 httpd lighttpd haproxy caddy || true"
	cmdProxySHA  = "sha256sum " + ProxyBin + " 2>/dev/null | cut -d' ' -f1; true"
	cmdLinkSec   = "cat " + ProxyData + "/link-secret"
	// cmdUserHome imprime a pasta pessoal do usuário do serviço ("" se não existe).
	cmdUserHome = "getent passwd " + ProxyUser + " | cut -d: -f6; true"
)

// CertFile é onde o autocert guarda o certificado emitido para o domínio
// (chave e cadeia no mesmo arquivo, 0600, dentro de uma pasta 0700).
func CertFile(domain string) string { return ProxyData + "/certs/" + domain }

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

// cmdCreateUser cria o usuário de serviço (sem shell, sem login). Se já existe, não toca.
func cmdCreateUser() string {
	return "id -u " + ProxyUser + " >/dev/null 2>&1 || useradd --system --user-group --home-dir " + ProxyData + " --no-create-home --shell /usr/sbin/nologin " + ProxyUser
}

// cmdProxyService grava a unit systemd (modo HTTPS próprio, usuário dedicado,
// capability só para abrir 80/443) e sobe o serviço.
func cmdProxyService(domain string) string {
	return ProxyBin + " -tls -domain " + domain + " -data " + ProxyData + " -service >/dev/null && systemctl restart bethstudio-proxy"
}

// cmdCertReady imprime "ready" quando o certificado do domínio já está no cache.
func cmdCertReady(domain string) string {
	return "[ -s " + shQuote(CertFile(domain)) + " ] && echo ready || echo waiting"
}

func cmdProxyLogsShort() string {
	return "journalctl -u bethstudio-proxy -n 15 --no-pager 2>&1 | cut -c1-300"
}

func cmdFirewall(sshPorts []int) string {
	var b strings.Builder
	b.WriteString("set -e; export DEBIAN_FRONTEND=noninteractive; command -v ufw >/dev/null 2>&1 || apt-get -o DPkg::Lock::Timeout=300 install -y -qq ufw\n")
	for _, p := range sshPorts {
		b.WriteString("ufw allow " + strconv.Itoa(p) + "/tcp >/dev/null\n")
	}
	b.WriteString("ufw allow 80/tcp >/dev/null\nufw allow 443/tcp >/dev/null\n")
	b.WriteString("ufw default deny incoming >/dev/null\nufw default allow outgoing >/dev/null\nufw --force enable >/dev/null")
	return b.String()
}

func cmdUnattended() string {
	return `set -e; export DEBIAN_FRONTEND=noninteractive; apt-get -o DPkg::Lock::Timeout=300 install -y -qq unattended-upgrades
printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' > /etc/apt/apt.conf.d/20auto-upgrades`
}

func cmdStatus() string {
	return "systemctl is-active bethstudio-proxy ufw || true; echo ---; systemctl --no-pager --lines=0 status bethstudio-proxy 2>&1 | grep -E 'Active:|Loaded:' || true"
}

func cmdLogs() string {
	return "echo '== bethstudio-proxy =='; journalctl -u bethstudio-proxy -n 80 --no-pager 2>&1"
}

// cmdRemove desfaz só o que o assistente criou: serviço, programa, dados
// (certificados incluídos) e o usuário de serviço (só se for o nosso, pela
// pasta pessoal). Não desinstala pacotes nem fecha portas do ufw.
func cmdRemove() string {
	return `set -e
systemctl disable --now bethstudio-proxy >/dev/null 2>&1 || true
rm -f ` + ProxyUnit + ` ` + ProxyBin + `
systemctl daemon-reload
rm -rf ` + ProxyData + `
if [ "$(getent passwd ` + ProxyUser + ` | cut -d: -f6)" = "` + ProxyData + `" ]; then
  userdel ` + ProxyUser + ` >/dev/null 2>&1 || true
fi`
}

func uploadName(kind string) string {
	return fmt.Sprintf(".bethstudio-upload-%s", kind)
}
