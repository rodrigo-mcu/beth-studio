package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFlagsCompletosNaoPerguntam(t *testing.T) {
	in := strings.NewReader("")
	cfg, err := resolveInstall(installConfig{
		Listen: "127.0.0.1:8787",
		Domain: "agentes.exemplo.com",
		Data:   "/var/lib/bethstudio-proxy",
	}, false, in, &strings.Builder{})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Listen != "127.0.0.1:8787" || cfg.Domain != "agentes.exemplo.com" {
		t.Fatalf("%+v", cfg)
	}
}

func TestSemTerminalNaoTrava(t *testing.T) {
	_, err := resolveInstall(installConfig{}, false, strings.NewReader(""), &strings.Builder{})
	if err == nil {
		t.Fatal("esperava erro de uso")
	}
}

func TestPerguntaPorta(t *testing.T) {
	in := strings.NewReader(strings.Join([]string{
		"1",                   // instalar
		"",                    // pasta padrão
		"agentes.exemplo.com", // domínio
		"1",                   // porta
		"9090",                // porta
		"s",                   // confirma
		"n",                   // não instala serviço
	}, "\n") + "\n")
	var out strings.Builder
	cfg, err := resolveInstall(installConfig{}, true, in, &out)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Data != "/var/lib/bethstudio-proxy" || cfg.Domain != "agentes.exemplo.com" || cfg.Listen != "127.0.0.1:9090" {
		t.Fatalf("%+v", cfg)
	}
	if !strings.Contains(out.String(), "arquivo socket") {
		t.Fatal(out.String())
	}
}

func TestPerguntaSocket(t *testing.T) {
	in := strings.NewReader(strings.Join([]string{
		"1",
		"/opt/bethstudio",
		"celular.exemplo.com",
		"2",
		"/run/beth.sock",
		"s",
		"n",
	}, "\n") + "\n")
	cfg, err := resolveInstall(installConfig{}, true, in, &strings.Builder{})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Service {
		t.Fatal("não pediu serviço")
	}
	if cfg.Data != "/opt/bethstudio" || cfg.Listen != "unix:/run/beth.sock" {
		t.Fatalf("%+v", cfg)
	}
}

func TestDominioInvalidoPedeDeNovo(t *testing.T) {
	in := strings.NewReader(strings.Join([]string{
		"1",
		"",
		"nao é domínio",
		"ok.exemplo.com",
		"",
		"",
		"s",
		"n",
	}, "\n") + "\n")
	cfg, err := resolveInstall(installConfig{}, true, in, &strings.Builder{})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Domain != "ok.exemplo.com" || cfg.Listen != "127.0.0.1:8787" {
		t.Fatalf("%+v", cfg)
	}
}

func TestPerguntaServico(t *testing.T) {
	in := strings.NewReader(strings.Join([]string{
		"1",
		"",
		"agentes.exemplo.com",
		"",
		"",
		"s",
		"s",
	}, "\n") + "\n")
	cfg, err := resolveInstall(installConfig{}, true, in, &strings.Builder{})
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.Service || cfg.Listen != "127.0.0.1:8787" {
		t.Fatalf("%+v", cfg)
	}
	unit := systemdUnit("/usr/local/bin/bethstudio-proxy", cfg)
	if !strings.Contains(unit, "ExecStart=/usr/local/bin/bethstudio-proxy -listen 127.0.0.1:8787 -domain agentes.exemplo.com -data /var/lib/bethstudio-proxy") {
		t.Fatal(unit)
	}
	if !strings.Contains(unit, "Restart=on-failure") || !strings.Contains(unit, "WantedBy=multi-user.target") {
		t.Fatal(unit)
	}
}

func TestMenuControlaServico(t *testing.T) {
	for _, tc := range []struct{ choice, action string }{
		{"2", "start"},
		{"3", "stop"},
		{"4", "restart"},
		{"reiniciar", "restart"},
		{"5", "remove"},
		{"remover", "remove"},
	} {
		cfg, err := resolveInstall(installConfig{}, true, strings.NewReader(tc.choice+"\n"), &strings.Builder{})
		if err != nil {
			t.Fatal(err)
		}
		if cfg.Action != tc.action || cfg.Domain != "" {
			t.Fatalf("%s -> %+v", tc.choice, cfg)
		}
		if serviceDone(tc.action) == "" {
			t.Fatal(tc.action)
		}
	}
}

func TestRemovePerguntaPasta(t *testing.T) {
	cfg, err := resolveInstall(installConfig{}, true, strings.NewReader("5\ns\n"), &strings.Builder{})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Action != "remove" || !cfg.Purge {
		t.Fatalf("%+v", cfg)
	}
}

func TestRemoveServiceApagaUnidade(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "bethstudio-proxy")
	unit := filepath.Join(dir, "bethstudio-proxy.service")
	data := filepath.Join(dir, "data")
	if err := os.Mkdir(data, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(data, "link-secret"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(bin, []byte("b"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(unit, []byte("ExecStart=/bin/bethstudio-proxy -listen 127.0.0.1:8787 -domain a.b -data "+data+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	var cmds []string
	err := removeService(bin, unit, false, func(name string, args ...string) error {
		cmds = append(cmds, name+" "+strings.Join(args, " "))
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(bin); !os.IsNotExist(err) {
		t.Fatal("binário ficou")
	}
	if _, err := os.Stat(unit); !os.IsNotExist(err) {
		t.Fatal("unidade ficou")
	}
	if _, err := os.Stat(filepath.Join(data, "link-secret")); err != nil {
		t.Fatal("apagou os dados sem pedir")
	}
	if len(cmds) != 2 || !strings.Contains(cmds[0], "disable --now") || !strings.Contains(cmds[1], "daemon-reload") {
		t.Fatalf("%v", cmds)
	}
	if err := os.WriteFile(unit, []byte("-data "+data+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := removeService(bin, unit, true, func(string, ...string) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(data); !os.IsNotExist(err) {
		t.Fatal("pasta de dados ficou")
	}
}

func TestInstallServiceGravaUnidade(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "bethstudio-proxy-linux")
	if err := os.WriteFile(src, []byte("bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(dir, "bin", "bethstudio-proxy")
	unit := filepath.Join(dir, "systemd", "bethstudio-proxy.service")
	var cmds []string
	cfg := installConfig{Listen: "unix:/run/beth.sock", Domain: "agentes.exemplo.com", Data: "/var/lib/bethstudio-proxy", Service: true}
	err := installService(cfg, src, bin, unit, func(name string, args ...string) error {
		cmds = append(cmds, name+" "+strings.Join(args, " "))
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(unit)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), "unix:/run/beth.sock") || !strings.Contains(string(b), bin) {
		t.Fatal(string(b))
	}
	if len(cmds) != 2 || !strings.Contains(cmds[1], "enable --now bethstudio-proxy") {
		t.Fatalf("%v", cmds)
	}
}

func TestInstrucoesDaLinha(t *testing.T) {
	got := pasteInstructions("bethstudio://link?domain=agentes.exemplo.com&secret=abc", "agentes.exemplo.com")
	if !strings.Contains(got, "Cole esta linha") || !strings.Contains(got, "https://agentes.exemplo.com") || !strings.Contains(got, "bethstudio://link?domain=") {
		t.Fatal(got)
	}
}
