//go:build windows

package main

// Testes do SSH contra um servidor SSH de teste EM PROCESSO (127.0.0.1,
// porta aleatoria, golang.org/x/crypto/ssh + github.com/pkg/sftp). Nada sai
// desta maquina.

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"
	"golang.org/x/sys/windows"
)

const testSSHPassword = "senha de teste ç"

type testSSHD struct {
	addr     string
	port     int
	signer   atomic.Pointer[ssh.Signer]
	authKeys sync.Map // string(pub.Marshal()) -> true
	sftpRoot string
	ln       net.Listener
}

func newTestSigner(t *testing.T) ssh.Signer {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	s, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func startTestSSHD(t *testing.T) *testSSHD {
	t.Helper()
	d := &testSSHD{sftpRoot: t.TempDir()}
	s := newTestSigner(t)
	d.signer.Store(&s)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	d.ln = ln
	d.addr = "127.0.0.1"
	d.port = ln.Addr().(*net.TCPAddr).Port
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go d.serve(c)
		}
	}()
	t.Cleanup(func() { _ = ln.Close() })
	return d
}

func (d *testSSHD) serve(nc net.Conn) {
	cfg := &ssh.ServerConfig{
		PasswordCallback: func(_ ssh.ConnMetadata, pw []byte) (*ssh.Permissions, error) {
			if string(pw) == testSSHPassword {
				return &ssh.Permissions{}, nil
			}
			return nil, errors.New("senha errada")
		},
		PublicKeyCallback: func(_ ssh.ConnMetadata, k ssh.PublicKey) (*ssh.Permissions, error) {
			if _, ok := d.authKeys.Load(string(k.Marshal())); ok {
				return &ssh.Permissions{}, nil
			}
			return nil, errors.New("chave desconhecida")
		},
	}
	cfg.AddHostKey(*d.signer.Load())
	sc, chans, reqs, err := ssh.NewServerConn(nc, cfg)
	if err != nil {
		return
	}
	defer sc.Close()
	go ssh.DiscardRequests(reqs)
	for nch := range chans {
		if nch.ChannelType() != "session" {
			_ = nch.Reject(ssh.UnknownChannelType, "só session")
			continue
		}
		ch, creqs, err := nch.Accept()
		if err != nil {
			continue
		}
		go d.session(ch, creqs)
	}
}

// session: pty-req/window-change/shell (um "shell" de brinquedo que ecoa e
// sai com "exit") e o subsistema sftp.
func (d *testSSHD) session(ch ssh.Channel, reqs <-chan *ssh.Request) {
	var mu sync.Mutex
	cols, rows := 0, 0
	for req := range reqs {
		switch req.Type {
		case "pty-req":
			var p struct {
				Term             string
				Cols, Rows, W, H uint32
				Modes            string
			}
			_ = ssh.Unmarshal(req.Payload, &p)
			mu.Lock()
			cols, rows = int(p.Cols), int(p.Rows)
			mu.Unlock()
			_ = req.Reply(true, nil)
		case "window-change":
			var p struct{ Cols, Rows, W, H uint32 }
			_ = ssh.Unmarshal(req.Payload, &p)
			fmt.Fprintf(ch, "\r\nRESIZE %d %d\r\n", p.Cols, p.Rows)
		case "shell":
			_ = req.Reply(true, nil)
			mu.Lock()
			fmt.Fprintf(ch, "BT-SSH-OK cols=%d rows=%d\r\n$ ", cols, rows)
			mu.Unlock()
			go func() {
				var line []byte
				buf := make([]byte, 256)
				for {
					n, err := ch.Read(buf)
					if err != nil {
						return
					}
					for _, b := range buf[:n] {
						if b == '\r' {
							fmt.Fprintf(ch, "\r\nvoce digitou: %s\r\n$ ", line)
							if string(line) == "exit" {
								_, _ = ch.SendRequest("exit-status", false, ssh.Marshal(struct{ C uint32 }{0}))
								_ = ch.Close()
								return
							}
							line = line[:0]
							continue
						}
						line = append(line, b)
						_, _ = ch.Write([]byte{b})
					}
				}
			}()
		case "subsystem":
			var p struct{ Name string }
			_ = ssh.Unmarshal(req.Payload, &p)
			if p.Name != "sftp" {
				_ = req.Reply(false, nil)
				continue
			}
			_ = req.Reply(true, nil)
			srv, err := sftp.NewServer(ch, sftp.WithServerWorkingDirectory(d.sftpRoot))
			if err != nil {
				_ = ch.Close()
				return
			}
			_ = srv.Serve()
			_ = ch.Close()
			return
		default:
			if req.WantReply {
				_ = req.Reply(false, nil)
			}
		}
	}
}

// sshTestEnv: pasta de dados isolada (hosts, cofre, known_hosts).
func sshTestEnv(t *testing.T) string {
	t.Helper()
	orig := os.Getenv("BETHSTUDIO_DATA_DIR")
	dir := t.TempDir()
	t.Setenv("BETHSTUDIO_DATA_DIR", dir)
	secrets.load(dir)
	t.Cleanup(func() { secrets.load(orig) })
	return dir
}

func TestSSHHelperInConPTY(t *testing.T) {
	dir := sshTestEnv(t)
	srv := startTestSSHD(t)
	env := map[string]string{"BETHSTUDIO_DATA_DIR": dir}

	// 1) senha salva no cofre + pergunta TOFU + PTY + resize + saida
	h, err := sshUpsertHost(SSHSavedHost{Name: "Servidor de teste", Host: srv.addr, Port: srv.port, User: "tester"})
	if err != nil {
		t.Fatal(err)
	}
	if err := sshSecretSet(sshSecretPw, h.ID, testSSHPassword); err != nil {
		t.Fatal(err)
	}
	c := startHelperInConPTY(t, 100, 30, env, "--ssh", h.ID)
	c.waitFor("Primeira conexão", 15*time.Second)
	c.waitFor("Confiar nesta chave e continuar? (s/N)", 5*time.Second)
	c.send("s\r")
	c.waitFor("BT-SSH-OK cols=100 rows=30", 15*time.Second)
	c.send("olá mundo\r")
	c.waitFor("voce digitou: olá mundo", 10*time.Second)
	c.resize(120, 40)
	c.waitFor("RESIZE 120 40", 10*time.Second)
	c.send("exit\r")
	if code := c.exitCode(10 * time.Second); code != 0 {
		t.Fatalf("saída %d; tela:\n%s", code, c.text())
	}
	kh, _ := os.ReadFile(filepath.Join(dir, sshKnownFile))
	if !strings.Contains(string(kh), "[127.0.0.1]:"+strconv.Itoa(srv.port)+" ssh-ed25519 ") {
		t.Fatalf("known_hosts: %q", kh)
	}
	t.Logf("tela (1):\n%s", c.text())

	// 2) sem senha salva: pedida no terminal, errada e depois certa
	h2, err := sshUpsertHost(SSHSavedHost{Name: "Pede senha", Host: srv.addr, Port: srv.port, User: "tester"})
	if err != nil {
		t.Fatal(err)
	}
	c = startHelperInConPTY(t, 80, 24, env, "--ssh", h2.ID)
	c.waitFor("Senha de tester@127.0.0.1:", 15*time.Second)
	c.send("errada\r")
	c.waitFor("Senha recusada.", 10*time.Second)
	c.send(testSSHPassword + "\r")
	c.waitFor("BT-SSH-OK cols=80 rows=24", 15*time.Second)
	if strings.Contains(c.text(), testSSHPassword) {
		t.Fatal("a senha digitada apareceu na tela")
	}
	c.send("exit\r")
	if code := c.exitCode(10 * time.Second); code != 0 {
		t.Fatalf("saída %d", code)
	}

	// 3) chave privada com frase-senha salva
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	sshPub, _ := ssh.NewPublicKey(pub)
	srv.authKeys.Store(string(sshPub.Marshal()), true)
	blk, err := ssh.MarshalPrivateKeyWithPassphrase(priv, "teste", []byte("frase secreta"))
	if err != nil {
		t.Fatal(err)
	}
	keyPath := filepath.Join(t.TempDir(), "id_ed25519")
	if err := os.WriteFile(keyPath, pem.EncodeToMemory(blk), 0o600); err != nil {
		t.Fatal(err)
	}
	h3, err := sshUpsertHost(SSHSavedHost{Name: "Com chave", Host: srv.addr, Port: srv.port, User: "tester", Auth: sshAuthKey, KeyPath: keyPath})
	if err != nil {
		t.Fatal(err)
	}
	if err := sshSecretSet(sshSecretPass, h3.ID, "frase secreta"); err != nil {
		t.Fatal(err)
	}
	c = startHelperInConPTY(t, 80, 24, env, "--ssh", h3.ID)
	c.waitFor("BT-SSH-OK", 15*time.Second)
	c.send("exit\r")
	if code := c.exitCode(10 * time.Second); code != 0 {
		t.Fatalf("saída %d", code)
	}

	// 4) o servidor troca de chave: recusa com explicacao, espera tecla
	s2 := newTestSigner(t)
	srv.signer.Store(&s2)
	c = startHelperInConPTY(t, 100, 30, env, "--ssh", h.ID)
	c.waitFor("MUDOU", 15*time.Second)
	// O ConPTY dos runners do GitHub descarta o meio desta linha longa (o texto
	// explicativo); no Windows de verdade ela chega inteira.
	if os.Getenv("GITHUB_ACTIONS") == "" {
		c.waitFor("homem no meio", 5*time.Second)
	}
	c.waitFor("Pressione qualquer tecla", 5*time.Second)
	if strings.Contains(c.text(), "BT-SSH-OK") {
		t.Fatal("conectou com chave trocada")
	}
	c.send("x")
	if code := c.exitCode(5 * time.Second); code != 1 {
		t.Fatalf("saída %d", code)
	}
	t.Logf("tela (chave trocada):\n%s", c.text())

	// 5) recusar a chave na primeira conexao
	if _, err := sshForgetKey(sshAddr(h)); err != nil {
		t.Fatal(err)
	}
	c = startHelperInConPTY(t, 100, 30, env, "--ssh", h.ID)
	c.waitFor("(s/N)", 15*time.Second)
	c.send("n\r")
	c.waitFor("chave do servidor não foi confirmada", 10*time.Second)
	c.send("x")
	if code := c.exitCode(5 * time.Second); code != 1 {
		t.Fatalf("saída %d", code)
	}
}

// Agente SSH: um pipe nomeado servido pelo proprio teste (como o do OpenSSH
// para Windows), nunca o agente real do usuario.
func TestSSHDialAgentPipe(t *testing.T) {
	sshTestEnv(t)
	srv := startTestSSHD(t)
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	signer, _ := ssh.NewSignerFromKey(priv)
	srv.authKeys.Store(string(signer.PublicKey().Marshal()), true)
	kr := agent.NewKeyring()
	if err := kr.Add(agent.AddedKey{PrivateKey: priv}); err != nil {
		t.Fatal(err)
	}
	pipe := `\\.\pipe\bethstudio-test-agent-` + strconv.Itoa(os.Getpid())
	name, _ := windows.UTF16PtrFromString(pipe)
	h, err := windows.CreateNamedPipe(name, windows.PIPE_ACCESS_DUPLEX, windows.PIPE_TYPE_BYTE|windows.PIPE_WAIT, 1, 4096, 4096, 0, nil)
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		_ = windows.ConnectNamedPipe(h, nil)
		f := os.NewFile(uintptr(h), pipe)
		_ = agent.ServeAgent(kr, f)
		f.Close()
	}()
	t.Setenv("BETHSTUDIO_SSH_AGENT_PIPE", pipe)
	host := SSHSavedHost{ID: sshNewID(), Host: srv.addr, Port: srv.port, User: "u", Auth: sshAuthAgent}
	cl, err := sshDial(host, sshCreds{}, func(sshHostKeyInfo) (bool, error) { return true, nil }, 10*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	cl.Close()

	t.Setenv("BETHSTUDIO_SSH_AGENT_PIPE", `\\.\pipe\bethstudio-test-sem-agente`)
	if _, err := sshDial(host, sshCreds{}, nil, 5*time.Second); err == nil || !strings.Contains(err.Error(), "agente SSH") {
		t.Fatalf("sem agente: %v", err)
	}
}

// API da tela SSH: salvar (senha no cofre, nunca na resposta), testar,
// confiar na chave vista, SFTP completo, esquecer chave.
func TestSSHWebAPIAndSFTP(t *testing.T) {
	dir := sshTestEnv(t)
	srv := startTestSSHD(t)
	downloads := t.TempDir()
	t.Setenv("BETHSTUDIO_DOWNLOADS", downloads)
	s := &server{hub: newHub(false)}

	call := func(method, path string, body any, hdr map[string]string) (int, map[string]any) {
		t.Helper()
		var rd io.Reader = http.NoBody
		ct := "application/json"
		switch b := body.(type) {
		case nil:
		case []byte:
			rd, ct = bytes.NewReader(b), "application/octet-stream"
		default:
			j, _ := json.Marshal(b)
			rd = bytes.NewReader(j)
		}
		req := httptest.NewRequest(method, path, rd)
		if body != nil {
			req.Header.Set("Content-Type", ct)
		}
		for k, v := range hdr {
			req.Header.Set(k, v)
		}
		w := httptest.NewRecorder()
		s.serveSSH(w, req)
		var out map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		if strings.Contains(w.Body.String(), testSSHPassword) {
			t.Fatalf("%s devolveu a senha!", path)
		}
		return w.Code, out
	}

	code, out := call("POST", "/api/ssh/hosts/save", map[string]any{
		"host":     map[string]any{"name": "Teste", "group": "Lab", "host": srv.addr, "port": srv.port, "user": "tester", "auth": "password"},
		"password": testSSHPassword, "save_password": true,
	}, nil)
	if code != 200 {
		t.Fatalf("save %d %v", code, out)
	}
	hm := out["host"].(map[string]any)
	id := hm["id"].(string)
	if hm["has_password"] != true {
		t.Fatalf("has_password: %v", hm)
	}
	raw, _ := os.ReadFile(filepath.Join(dir, sshHostsFile))
	sec, _ := os.ReadFile(filepath.Join(dir, secretsFile))
	if bytes.Contains(raw, []byte(testSSHPassword)) || bytes.Contains(sec, []byte(testSSHPassword)) || bytes.Contains(sec, []byte(base64.StdEncoding.EncodeToString([]byte(testSSHPassword)))) {
		t.Fatal("senha em claro no disco")
	}

	// testar: chave desconhecida -> confiar com a impressao digital vista
	code, out = call("POST", "/api/ssh/hosts/test", map[string]any{"id": id}, nil)
	if code != 200 || out["ok"] == true || out["code"] != "unknown_host_key" {
		t.Fatalf("test 1: %d %v", code, out)
	}
	fp := out["host_key"].(map[string]any)["fingerprint"].(string)
	code, out = call("POST", "/api/ssh/hosts/trust", map[string]any{"id": id, "fingerprint": "SHA256:outra"}, nil)
	if out["ok"] == true || out["trusted"] == true {
		t.Fatalf("confiou em impressão digital diferente: %v", out)
	}
	code, out = call("POST", "/api/ssh/hosts/trust", map[string]any{"id": id, "fingerprint": fp}, nil)
	if code != 200 || out["ok"] != true || out["trusted"] != true {
		t.Fatalf("trust: %d %v", code, out)
	}
	if code, out = call("POST", "/api/ssh/hosts/test", map[string]any{"id": id}, nil); out["ok"] != true {
		t.Fatalf("test 2: %d %v", code, out)
	}
	// formulario nao salvo, senha no cabecalho
	form := map[string]any{"host": srv.addr, "port": srv.port, "user": "x", "auth": "password"}
	if _, out = call("POST", "/api/ssh/hosts/test", map[string]any{"host": form}, nil); out["ok"] == true || !strings.Contains(fmt.Sprint(out["error"]), "senha") {
		t.Fatalf("sem senha: %v", out)
	}
	if _, out = call("POST", "/api/ssh/hosts/test", map[string]any{"host": form, "password": testSSHPassword}, nil); out["ok"] != true {
		t.Fatalf("senha no corpo: %v", out)
	}

	// SFTP
	if err := os.WriteFile(filepath.Join(srv.sftpRoot, "ola.txt"), []byte("conteúdo remoto"), 0o644); err != nil {
		t.Fatal(err)
	}
	code, out = call("POST", "/api/ssh/sftp/list", map[string]any{"id": id}, nil)
	if code != 200 {
		t.Fatalf("list: %d %v", code, out)
	}
	base := out["path"].(string)
	t.Logf("pasta inicial remota: %s", base)
	found := false
	for _, e := range out["entries"].([]any) {
		if e.(map[string]any)["name"] == "ola.txt" {
			found = true
		}
	}
	if !found {
		t.Fatalf("ola.txt não listado: %v", out)
	}
	join := func(n string) string { return strings.TrimRight(base, "/") + "/" + n }
	if code, out = call("POST", "/api/ssh/sftp/mkdir", map[string]any{"id": id, "path": join("pasta nova")}, nil); code != 200 {
		t.Fatalf("mkdir: %d %v", code, out)
	}
	if code, out = call("POST", "/api/ssh/sftp/upload?id="+id+"&path="+urlq(join("pasta nova/enviado.bin")), []byte("dados enviados"), nil); code != 200 {
		t.Fatalf("upload: %d %v", code, out)
	}
	if code, out = call("POST", "/api/ssh/sftp/upload?id="+id+"&path="+urlq(join("pasta nova/enviado.bin")), []byte("x"), nil); code != http.StatusConflict || out["code"] != "exists" {
		t.Fatalf("upload sem sobrescrever: %d %v", code, out)
	}
	if code, _ = call("POST", "/api/ssh/sftp/upload?id="+id+"&overwrite=1&path="+urlq(join("pasta nova/enviado.bin")), []byte("dados v2"), nil); code != 200 {
		t.Fatalf("upload sobrescrever: %d", code)
	}
	if b, _ := os.ReadFile(filepath.Join(srv.sftpRoot, "pasta nova", "enviado.bin")); string(b) != "dados v2" {
		t.Fatalf("conteúdo enviado: %q", b)
	}
	if code, out = call("POST", "/api/ssh/sftp/rename", map[string]any{"id": id, "from": join("ola.txt"), "to": join("renomeado.txt")}, nil); code != 200 {
		t.Fatalf("rename: %d %v", code, out)
	}
	code, out = call("POST", "/api/ssh/sftp/download", map[string]any{"id": id, "path": join("renomeado.txt")}, nil)
	if code != 200 {
		t.Fatalf("download: %d %v", code, out)
	}
	saved := out["saved"].(string)
	if b, _ := os.ReadFile(saved); string(b) != "conteúdo remoto" || filepath.Dir(saved) != downloads {
		t.Fatalf("baixado %s: %q", saved, b)
	}
	if _, out = call("POST", "/api/ssh/sftp/download", map[string]any{"id": id, "path": join("renomeado.txt")}, nil); !strings.HasSuffix(fmt.Sprint(out["saved"]), "renomeado (1).txt") {
		t.Fatalf("nome repetido: %v", out)
	}
	if code, out = call("POST", "/api/ssh/sftp/remove", map[string]any{"id": id, "path": join("pasta nova"), "is_dir": true}, nil); code != 200 {
		t.Fatalf("remove pasta: %d %v", code, out)
	}
	if _, err := os.Stat(filepath.Join(srv.sftpRoot, "pasta nova")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("pasta não apagada")
	}
	if code, _ = call("POST", "/api/ssh/sftp/remove", map[string]any{"id": id, "path": "/"}, nil); code != http.StatusBadRequest {
		t.Fatalf("apagar raiz: %d", code)
	}

	// chave trocada: SFTP recusa com 409 + mismatch
	sftpDrop(id)
	s2 := newTestSigner(t)
	srv.signer.Store(&s2)
	code, out = call("POST", "/api/ssh/sftp/list", map[string]any{"id": id}, nil)
	if code != http.StatusOK || out["ok"] != false || out["code"] != "host_key_mismatch" {
		t.Fatalf("mismatch: %d %v", code, out)
	}
	if code, out = call("POST", "/api/ssh/hosts/forget-key", map[string]any{"id": id}, nil); code != 200 || out["removed"] != float64(1) {
		t.Fatalf("forget: %d %v", code, out)
	}
	if _, out = call("POST", "/api/ssh/hosts/test", map[string]any{"id": id}, nil); out["code"] != "unknown_host_key" {
		t.Fatalf("depois de esquecer: %v", out)
	}

	// read-only recusa gravar
	ro := &server{hub: newHub(true)}
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/ssh/hosts/delete", strings.NewReader(`{"id":"`+id+`"}`))
	req.Header.Set("Content-Type", "application/json")
	ro.serveSSH(w, req)
	if w.Code != http.StatusForbidden {
		t.Fatalf("read-only: %d", w.Code)
	}
	if code, _ = call("POST", "/api/ssh/hosts/delete", map[string]any{"id": id}, nil); code != 200 {
		t.Fatalf("delete %d", code)
	}
	if _, ok := sshSecretGet(sshSecretPw, id); ok {
		t.Fatal("senha ficou no cofre depois de apagar o host")
	}
}

func urlq(s string) string { return strings.NewReplacer(" ", "%20", "/", "%2F").Replace(s) }
