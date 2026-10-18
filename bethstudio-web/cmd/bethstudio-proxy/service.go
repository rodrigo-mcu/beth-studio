package main

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strings"
)

const (
	serviceBin  = "/usr/local/bin/bethstudio-proxy"
	serviceUnit = "/etc/systemd/system/bethstudio-proxy.service"
	// serviceUser é o usuário sem shell que roda o serviço no modo HTTPS próprio.
	serviceUser = "bethstudio"
)

func serviceDone(action string) string {
	switch action {
	case "start":
		return "Serviço bethstudio-proxy iniciado."
	case "stop":
		return "Serviço bethstudio-proxy parado."
	case "restart":
		return "Serviço bethstudio-proxy reiniciado."
	case "remove":
		return "Serviço bethstudio-proxy removido."
	default:
		return ""
	}
}

func systemdUnit(exe string, cfg installConfig) string {
	if cfg.TLS {
		return tlsUnit(exe, cfg)
	}
	return fmt.Sprintf(`[Unit]
Description=Beth Studio proxy do celular
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=%s -listen %s -domain %s -data %s
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
`, exe, cfg.Listen, cfg.Domain, cfg.Data)
}

// tlsUnit: modo HTTPS próprio. Não roda como root: usuário dedicado, só a
// capability de abrir portas abaixo de 1024, sistema de arquivos somente
// leitura exceto a pasta de dados.
func tlsUnit(exe string, cfg installConfig) string {
	args := "-tls -domain " + cfg.Domain + " -data " + cfg.Data
	if cfg.Email != "" {
		args += " -acme-email " + cfg.Email
	}
	if cfg.Staging {
		args += " -acme-staging"
	}
	return fmt.Sprintf(`[Unit]
Description=Beth Studio proxy do celular (HTTPS direto)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=%s %s
User=%s
Group=%s
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
ReadWritePaths=%s
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
`, exe, args, serviceUser, serviceUser, cfg.Data)
}

func unitDataDir(body string) string {
	const mark = "-data "
	i := strings.Index(body, mark)
	if i < 0 {
		return ""
	}
	rest := strings.TrimSpace(body[i+len(mark):])
	if j := strings.IndexAny(rest, " \t\r\n"); j >= 0 {
		rest = rest[:j]
	}
	if rest == "/" || rest == "." {
		return ""
	}
	return rest
}

func removeService(binPath, unitPath string, purge bool, run func(name string, args ...string) error) error {
	body, _ := os.ReadFile(unitPath)
	data := unitDataDir(string(body))
	_ = run("systemctl", "disable", "--now", "bethstudio-proxy")
	if err := os.Remove(unitPath); err != nil && !os.IsNotExist(err) {
		return err
	}
	if err := os.Remove(binPath); err != nil && !os.IsNotExist(err) {
		return err
	}
	if err := run("systemctl", "daemon-reload"); err != nil {
		return fmt.Errorf("systemctl daemon-reload: %w", err)
	}
	if purge && data != "" {
		if err := os.RemoveAll(data); err != nil {
			return err
		}
	}
	// o usuário dedicado do modo HTTPS próprio foi criado por nós: sai junto
	if strings.Contains(string(body), "\nUser="+serviceUser+"\n") {
		_ = run("userdel", serviceUser)
	}
	return nil
}

func installService(cfg installConfig, srcExe, binPath, unitPath string, run func(name string, args ...string) error) error {
	if err := copyBinary(srcExe, binPath); err != nil {
		return err
	}
	if cfg.TLS {
		if err := prepareServiceUser(cfg.Data, run); err != nil {
			return err
		}
	}
	if err := os.MkdirAll(filepath.Dir(unitPath), 0o755); err != nil {
		return err
	}
	body := systemdUnit(binPath, cfg)
	if err := os.WriteFile(unitPath, []byte(body), 0o644); err != nil {
		return err
	}
	if err := run("systemctl", "daemon-reload"); err != nil {
		return fmt.Errorf("systemctl daemon-reload: %w", err)
	}
	if err := run("systemctl", "enable", "--now", "bethstudio-proxy"); err != nil {
		return fmt.Errorf("systemctl enable --now: %w", err)
	}
	return nil
}

// prepareServiceUser cria o usuário sem shell e entrega a pasta de dados a ele
// (o segredo da ligação foi criado por quem instalou, root).
func prepareServiceUser(data string, run func(name string, args ...string) error) error {
	if err := os.MkdirAll(data, 0o700); err != nil {
		return err
	}
	if _, err := user.Lookup(serviceUser); err != nil {
		if err := run("useradd", "--system", "--user-group", "--home-dir", data, "--no-create-home", "--shell", "/usr/sbin/nologin", serviceUser); err != nil {
			return fmt.Errorf("useradd %s: %w", serviceUser, err)
		}
	}
	if err := run("chown", "-R", serviceUser+":"+serviceUser, data); err != nil {
		return fmt.Errorf("chown: %w", err)
	}
	return run("chmod", "700", data)
}

func copyBinary(src, dst string) error {
	if same, _ := samePath(src, dst); same {
		return nil
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
	if err != nil {
		return err
	}
	defer out.Close()
	if _, err := io.Copy(out, in); err != nil {
		return err
	}
	return out.Close()
}

func runCmd(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

func samePath(a, b string) (bool, error) {
	aa, err := filepath.Abs(a)
	if err != nil {
		return false, err
	}
	bb, err := filepath.Abs(b)
	if err != nil {
		return false, err
	}
	if aa == bb {
		return true, nil
	}
	ia, err1 := os.Stat(aa)
	ib, err2 := os.Stat(bb)
	if err1 != nil || err2 != nil {
		return false, nil
	}
	return os.SameFile(ia, ib), nil
}
