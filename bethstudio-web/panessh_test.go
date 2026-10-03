package main

import (
	"os"
	"strings"
	"sync"
	"testing"
)

func TestSSHHostFromArgv(t *testing.T) {
	cases := map[string]string{
		"ssh.exe alice@srv1":                                  "srv1",
		"ssh -p 2222 root@10.0.0.5":                           "10.0.0.5",
		"ssh -i C:/k/id_ed25519 -l admin db.example.local":    "db.example.local",
		"ssh -p2222 -o StrictHostKeyChecking=no web01 uptime": "web01",
		"ssh -J bastion gw.interno":                           "gw.interno",
		"ssh ssh://deploy@app.example.com:2200":               "app.example.com",
		"ssh -v":                                              "",
	}
	for in, want := range cases {
		if got := sshHostFromArgv(strings.Fields(in)); got != want {
			t.Errorf("%q => %q, queria %q", in, got, want)
		}
	}
	k := classifyArgv([]string{`C:\Windows\System32\OpenSSH\ssh.exe`, "alice@srv1"})
	if k.Kind != "ssh" || k.Host != "srv1" || k.Label != "SSH · srv1" {
		t.Fatalf("argv => %+v", k)
	}
}

func TestSSHHeuristicNoLocalFalsePositive(t *testing.T) {
	t.Setenv("BETHSTUDIO_LOCAL_HOSTNAMES", "my-desktop")
	localNames.once = sync.Once{} // relê os nomes locais com a variável acima
	localNames.names = nil
	host, _ := os.Hostname()
	local := strings.ToLower(host)

	// WSL local: cwd com o nome da maquina (maiusculas ou nao) => WSL, nao SSH
	for _, c := range []string{"file://my-desktop/home/user", "file://MY-DESKTOP/mnt/c", "file://" + local + "/home/x", "file://localhost/tmp"} {
		k := classifyPane(1, "user@MY-DESKTOP: ~", c, map[int][]string{1: {"wsl.exe", "-d", "Debian"}}, nil)
		if k.Kind != "wsl" || k.Distro != "Debian" {
			t.Errorf("cwd local %q => %+v", c, k)
		}
	}
	// ssh digitado dentro do WSL: cwd com host remoto => SSH · host
	k := classifyPane(2, "deploy@web01: /srv", "file://web01/srv", map[int][]string{2: {"wsl.exe"}}, nil)
	if k.Kind != "ssh" || k.Host != "web01" || k.Source != "gui" {
		t.Fatalf("cwd remoto => %+v", k)
	}
	// so' o titulo user@host: (sem OSC 7)
	k = classifyPane(3, "root@db-prod: ~", "", nil, nil)
	if k.Kind != "ssh" || k.Host != "db-prod" {
		t.Fatalf("título remoto => %+v", k)
	}
	// titulo do WSL local nao vira SSH
	if k := classifyPane(4, "user@my-desktop: ~/repo", "file://my-desktop/home/user/repo", nil, nil); k.Kind != "wsl" {
		t.Fatalf("título local => %+v", k)
	}
	// PowerShell/cmd nao sao reclassificados pelo titulo
	if k := classifyPane(5, "admin@x: foo", "", map[int][]string{5: {"pwsh.exe"}}, nil); k.Kind != "pwsh" {
		t.Fatalf("pwsh => %+v", k)
	}
	// Claude Code e titulos sem "user@host:" nao viram SSH
	for _, ti := range []string{"✳ Claude Code", "user@: x", "e-mail a@b.com enviado", "Windows PowerShell"} {
		if k := classifyPane(6, ti, "", nil, nil); k.Kind == "ssh" {
			t.Errorf("falso positivo %q => %+v", ti, k)
		}
	}
	// shell do web ssh.<host>
	if k := classifyShellID("ssh.srv9"); k.Kind != "ssh" || k.Host != "srv9" {
		t.Fatalf("shell id => %+v", k)
	}
	// enrichList leva ssh_host
	out := string(enrichList([]byte(`{"ev":"list","panes":[{"pane_id":7,"title":"x","cwd":"file://gw/etc"}]}`), nil, nil))
	if !strings.Contains(out, `"ssh_host":"gw"`) || !strings.Contains(out, `"kind":"ssh"`) {
		t.Fatalf("enrich => %s", out)
	}
}
