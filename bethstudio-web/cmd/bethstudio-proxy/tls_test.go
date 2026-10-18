package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestTLSFlagsCompletosNaoPerguntam(t *testing.T) {
	cfg, err := resolveInstall(installConfig{TLS: true, Domain: "agentes.exemplo.com", Data: "/var/lib/bethstudio-proxy", Email: "eu@exemplo.com", Staging: true}, false, strings.NewReader(""), &strings.Builder{})
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.TLS || cfg.Listen != "" || !cfg.Staging || cfg.Email != "eu@exemplo.com" {
		t.Fatalf("%+v", cfg)
	}
}

func TestTLSOpcoesInvalidas(t *testing.T) {
	cases := map[string]installConfig{
		"tls e listen":      {TLS: true, Listen: "127.0.0.1:8787", Domain: "a.b.com", Data: "/d"},
		"staging sem tls":   {Listen: "127.0.0.1:8787", Staging: true, Domain: "a.b.com", Data: "/d"},
		"email sem tls":     {Listen: "127.0.0.1:8787", Email: "a@b.com", Domain: "a.b.com", Data: "/d"},
		"email com injeção": {TLS: true, Email: "a@b.com\nExecStart=/bin/sh", Domain: "a.b.com", Data: "/d"},
	}
	for name, c := range cases {
		if _, err := resolveInstall(c, false, strings.NewReader(""), &strings.Builder{}); err == nil {
			t.Fatalf("%s: aceito", name)
		}
	}
}

func TestPerguntaHTTPSDireto(t *testing.T) {
	in := strings.NewReader(strings.Join([]string{
		"1", "", "agentes.exemplo.com",
		"3",              // HTTPS direto
		"eu@exemplo.com", // e-mail
		"s", "s",
	}, "\n") + "\n")
	var out strings.Builder
	cfg, err := resolveInstall(installConfig{}, true, in, &out)
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.TLS || cfg.Listen != "" || cfg.Email != "eu@exemplo.com" || !cfg.Service {
		t.Fatalf("%+v", cfg)
	}
	if !strings.Contains(out.String(), "80 e 443") {
		t.Fatal(out.String())
	}
}

func TestUnidadeTLSNaoRodaComoRoot(t *testing.T) {
	u := systemdUnit("/usr/local/bin/bethstudio-proxy", installConfig{TLS: true, Domain: "agentes.exemplo.com", Data: "/var/lib/bethstudio-proxy", Email: "eu@exemplo.com", Staging: true})
	for _, want := range []string{
		"ExecStart=/usr/local/bin/bethstudio-proxy -tls -domain agentes.exemplo.com -data /var/lib/bethstudio-proxy -acme-email eu@exemplo.com -acme-staging\n",
		"User=bethstudio\n", "Group=bethstudio\n",
		"AmbientCapabilities=CAP_NET_BIND_SERVICE\n", "CapabilityBoundingSet=CAP_NET_BIND_SERVICE\n",
		"NoNewPrivileges=yes\n", "ProtectSystem=strict\n", "ProtectHome=yes\n", "PrivateTmp=yes\n",
		"ReadWritePaths=/var/lib/bethstudio-proxy\n", "Restart=always\n",
	} {
		if !strings.Contains(u, want) {
			t.Fatalf("falta %q em:\n%s", want, u)
		}
	}
	if strings.Contains(u, "-listen") {
		t.Fatal("unit TLS com -listen")
	}
	if unitDataDir(u) != "/var/lib/bethstudio-proxy" {
		t.Fatalf("unitDataDir %q", unitDataDir(u))
	}
	u = systemdUnit("/b", installConfig{TLS: true, Domain: "a.b.com", Data: "/d"})
	if strings.Contains(u, "acme-") {
		t.Fatal(u)
	}
}

func TestUnidadeAntigaContinuaIgual(t *testing.T) {
	u := systemdUnit("/b", installConfig{Listen: "127.0.0.1:8787", Domain: "a.b.com", Data: "/d"})
	if strings.Contains(u, "User=") || strings.Contains(u, "AmbientCapabilities") || !strings.Contains(u, "-listen 127.0.0.1:8787") || !strings.Contains(u, "Restart=on-failure") {
		t.Fatal(u)
	}
}

func TestInstallServiceTLSCriaUsuarioEEntregaDados(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "src")
	if err := os.WriteFile(src, []byte("bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	data := filepath.Join(dir, "data")
	var cmds []string
	cfg := installConfig{TLS: true, Domain: "agentes.exemplo.com", Data: data, Service: true}
	err := installService(cfg, src, filepath.Join(dir, "bin"), filepath.Join(dir, "u.service"), func(name string, args ...string) error {
		cmds = append(cmds, name+" "+strings.Join(args, " "))
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	all := strings.Join(cmds, "\n")
	for _, want := range []string{"useradd --system --user-group", "--shell /usr/sbin/nologin bethstudio", "chown -R bethstudio:bethstudio " + data, "chmod 700 " + data, "enable --now bethstudio-proxy"} {
		if !strings.Contains(all, want) {
			t.Fatalf("falta %q em:\n%s", want, all)
		}
	}
	if strings.Index(all, "useradd") > strings.Index(all, "enable --now") {
		t.Fatal("o usuário precisa existir antes de o serviço subir")
	}
}

func TestRemoveServiceTLSRemoveUsuario(t *testing.T) {
	dir := t.TempDir()
	unit := filepath.Join(dir, "u.service")
	data := filepath.Join(dir, "data")
	_ = os.Mkdir(data, 0o700)
	if err := os.WriteFile(unit, []byte(systemdUnit("/b", installConfig{TLS: true, Domain: "a.b.com", Data: data})), 0o644); err != nil {
		t.Fatal(err)
	}
	var cmds []string
	if err := removeService(filepath.Join(dir, "bin"), unit, true, func(name string, args ...string) error {
		cmds = append(cmds, name+" "+strings.Join(args, " "))
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join(cmds, "\n"), "userdel bethstudio") {
		t.Fatalf("%v", cmds)
	}
	if _, err := os.Stat(data); !os.IsNotExist(err) {
		t.Fatal("dados ficaram")
	}
}
