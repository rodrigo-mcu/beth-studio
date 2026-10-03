//go:build windows

package main

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func sshStoreTestEnv(t *testing.T) string {
	t.Helper()
	orig := os.Getenv("BETHSTUDIO_DATA_DIR")
	dir := t.TempDir()
	t.Setenv("BETHSTUDIO_DATA_DIR", dir)
	secrets.load(dir)
	t.Cleanup(func() { secrets.load(orig) })
	return dir
}

func TestSSHHostsStore(t *testing.T) {
	dir := sshStoreTestEnv(t)
	h, err := sshUpsertHost(SSHSavedHost{Host: " [fe80::1%eth0] ", User: "root", Group: "Lab"})
	if err != nil {
		t.Fatal(err)
	}
	if h.Host != "fe80::1%eth0" || h.Port != 22 || h.Auth != sshAuthPassword || h.Name != h.Host || !sshHostIDRe.MatchString(h.ID) {
		t.Fatalf("normalização: %+v", h)
	}
	if err := sshSecretSet(sshSecretPw, h.ID, "  com espaços  "); err != nil {
		t.Fatal(err)
	}
	if pw, ok := sshSecretGet(sshSecretPw, h.ID); !ok || pw != "  com espaços  " {
		t.Fatalf("cofre: %q %v", pw, ok)
	}
	got, ok, err := sshGetHost(h.ID)
	if err != nil || !ok || !got.HasPassword || got.HasPassphrase {
		t.Fatalf("get: %+v %v %v", got, ok, err)
	}
	raw, _ := os.ReadFile(filepath.Join(dir, sshHostsFile))
	if bytes.Contains(raw, []byte("has_password\": true")) || bytes.Contains(raw, []byte("espaços")) {
		t.Fatalf("derivado/senha no JSON: %s", raw)
	}
	dup, err := sshDuplicateHost(h.ID)
	if err != nil || !dup.HasPassword || dup.Name != h.Name+" (cópia)" {
		t.Fatalf("duplicar: %+v %v", dup, err)
	}
	if _, err := sshUpsertHost(SSHSavedHost{ID: "0123456789abcdef", Host: "x", User: "u"}); err == nil {
		t.Fatal("atualizar id inexistente devia falhar")
	}
	for _, bad := range []SSHSavedHost{
		{Host: "", User: "u"}, {Host: "a b", User: "u"}, {Host: "user@host", User: "u"}, {Host: "h", User: ""},
		{Host: "h", User: "u", Port: 70000}, {Host: "h", User: "u", Auth: "key"}, {Host: "h", User: "u", Auth: "x"},
		{Host: "h", User: "u\x01v"}, {Host: "h", User: "u", Color: "azul"},
	} {
		if _, err := sshNormalizeHost(bad); err == nil {
			t.Errorf("devia recusar %+v", bad)
		}
	}
	if err := sshNoteRecent(dup.ID); err != nil {
		t.Fatal(err)
	}
	hosts, rec, err := sshListHosts()
	if err != nil || len(hosts) != 2 || len(rec) != 1 {
		t.Fatalf("lista: %v %v %v", hosts, rec, err)
	}
	// argv / shell id -> user@host:port (estilo Bitvise)
	wantLabel := sshEndpointLabel(h)
	if l, ok := sshHostForArgv([]string{`C:\BethStudio\bethstudio-tool.exe`, "--ssh", h.ID}); !ok || l != wantLabel {
		t.Fatalf("argv: %q %v (queria %q)", l, ok, wantLabel)
	}
	if l, ok := sshHostForArgv([]string{"bethstudio-web.exe", "--ssh", h.ID}); !ok || l != wantLabel {
		t.Fatalf("argv web: %q %v", l, ok)
	}
	for _, argv := range [][]string{{"ssh.exe", "--ssh", h.ID}, {"bethstudio-tool.exe", "--ssh", "../x"}, {"bethstudio-tool.exe"}, {"bethstudio-tool.exe", "--serial", h.ID}} {
		if _, ok := sshHostForArgv(argv); ok {
			t.Errorf("não devia reconhecer %v", argv)
		}
	}
	if l, ok := sshHostForShellID("ssh." + h.ID); !ok || l != wantLabel {
		t.Fatalf("shell id: %q %v", l, ok)
	}
	if _, ok := sshHostForShellID("ssh.servidor"); ok {
		t.Fatal("ssh.<nome> é o formato antigo, não um host salvo")
	}
	msg, shell, err := toolSpawnMessage("ssh", h.ID, "r9", nil)
	if err != nil || msg["kind"] != "ssh" || shell != "ssh."+h.ID || !shellIDRe.MatchString(shell) {
		t.Fatalf("spawn: %v %q %v", msg, shell, err)
	}
	if err := sshDeleteHost(h.ID); err != nil {
		t.Fatal(err)
	}
	if _, ok := sshSecretGet(sshSecretPw, h.ID); ok {
		t.Fatal("senha ficou no cofre")
	}
	if l, ok := sshHostForArgv([]string{"bethstudio-tool.exe", "--ssh", h.ID}); !ok || l != "host removido" {
		t.Fatalf("host apagado: %q %v", l, ok)
	}
}

func TestSSHConfigImport(t *testing.T) {
	sshStoreTestEnv(t)
	cfg := `# comentário
User padrao
Host prod web01
    HostName 10.0.0.5
    Port 2222
    IdentityFile ~/.ssh/id_prod
Host bastion
  HostName=bastion.exemplo.org
  User admin
  ProxyJump outro
Host *.interno !x.interno
  User interno
Match host teste
  User ignorado
Host *
  User ultimo
  Port 22
`
	existing := []SSHSavedHost{{Host: "10.0.0.5", Port: 2222, User: "padrao"}}
	c := sshConfigCandidates(cfg, existing)
	if len(c) != 3 {
		t.Fatalf("candidatos: %+v", c)
	}
	byAlias := map[string]SSHConfigCandidate{}
	for _, x := range c {
		byAlias[x.Alias] = x
	}
	p := byAlias["prod"].Host
	if p.Host != "10.0.0.5" || p.Port != 2222 || p.User != "padrao" || p.Auth != sshAuthKey || p.KeyPath != "~/.ssh/id_prod" || !byAlias["prod"].Exists {
		t.Fatalf("prod: %+v", byAlias["prod"])
	}
	b := byAlias["bastion"]
	if b.Host.Host != "bastion.exemplo.org" || b.Host.User != "padrao" || len(b.Warnings) == 0 || b.Exists {
		t.Fatalf("bastion (primeiro valor vale; aviso de ProxyJump): %+v", b)
	}
	if _, err := sshNormalizeHost(b.Host); err != nil {
		t.Fatal(err)
	}

	// pela API: importar só o escolhido
	path := filepath.Join(t.TempDir(), "config")
	_ = os.WriteFile(path, []byte(cfg), 0o644)
	t.Setenv("BETHSTUDIO_SSH_CONFIG", path)
	s := &server{hub: newHub(false)}
	req := httptest.NewRequest("POST", "/api/ssh/config-import", strings.NewReader(`{"aliases":["bastion"]}`))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	s.serveSSH(w, req)
	var out struct {
		Imported int `json:"imported"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	if w.Code != 200 || out.Imported != 1 {
		t.Fatalf("import: %d %s", w.Code, w.Body.String())
	}
	hosts, _, _ := sshListHosts()
	if len(hosts) != 1 || hosts[0].Name != "bastion" || hosts[0].Group == "" {
		t.Fatalf("hosts: %+v", hosts)
	}
}
