package vpsinstall

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

// testSSHServer é um servidor SSH em loopback: senha fixa, comandos por mapa.
type testSSHServer struct {
	ln       net.Listener
	hostKey  ssh.Signer
	password string
	home     string
	mu       sync.Mutex
	cmds     []string
	handler  func(cmd string) (string, int)
}

func newTestSSHServer(t *testing.T, password string, handler func(string) (string, int)) *testSSHServer {
	t.Helper()
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	signer, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	s := &testSSHServer{ln: ln, hostKey: signer, password: password, home: t.TempDir(), handler: handler}
	t.Cleanup(func() { ln.Close() })
	go s.serve()
	return s
}

func (s *testSSHServer) port() int  { return s.ln.Addr().(*net.TCPAddr).Port }
func (s *testSSHServer) fp() string { return ssh.FingerprintSHA256(s.hostKey.PublicKey()) }

func (s *testSSHServer) ran() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.cmds...)
}

func (s *testSSHServer) serve() {
	cfg := &ssh.ServerConfig{
		PasswordCallback: func(_ ssh.ConnMetadata, pw []byte) (*ssh.Permissions, error) {
			if string(pw) == s.password {
				return nil, nil
			}
			return nil, os.ErrPermission
		},
	}
	cfg.AddHostKey(s.hostKey)
	for {
		c, err := s.ln.Accept()
		if err != nil {
			return
		}
		go func() {
			sc, chans, reqs, err := ssh.NewServerConn(c, cfg)
			if err != nil {
				c.Close()
				return
			}
			go ssh.DiscardRequests(reqs)
			for nc := range chans {
				if nc.ChannelType() != "session" {
					_ = nc.Reject(ssh.UnknownChannelType, "x")
					continue
				}
				ch, creqs, _ := nc.Accept()
				go s.session(ch, creqs)
			}
			sc.Close()
		}()
	}
}

func (s *testSSHServer) session(ch ssh.Channel, reqs <-chan *ssh.Request) {
	for req := range reqs {
		switch req.Type {
		case "exec":
			var p struct{ Cmd string }
			_ = ssh.Unmarshal(req.Payload, &p)
			_ = req.Reply(true, nil)
			s.mu.Lock()
			s.cmds = append(s.cmds, p.Cmd)
			s.mu.Unlock()
			out, code := s.handler(p.Cmd)
			_, _ = ch.Write([]byte(out))
			_, _ = ch.SendRequest("exit-status", false, ssh.Marshal(struct{ C uint32 }{uint32(code)}))
			ch.Close()
			return
		case "subsystem":
			_ = req.Reply(true, nil)
			srv, err := sftp.NewServer(ch, sftp.WithServerWorkingDirectory(s.home))
			if err == nil {
				_ = srv.Serve()
			}
			ch.Close()
			return
		default:
			_ = req.Reply(false, nil)
		}
	}
}

func TestProbeMostraFingerprint(t *testing.T) {
	s := newTestSSHServer(t, "pw", func(string) (string, int) { return "", 0 })
	res, err := Probe(context.Background(), "127.0.0.1", s.port())
	if err != nil {
		t.Fatal(err)
	}
	if res.Fingerprint != s.fp() || !strings.HasPrefix(res.Fingerprint, "SHA256:") {
		t.Fatalf("%+v vs %s", res, s.fp())
	}
}

func TestProbeSemServidor(t *testing.T) {
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	if _, err := Probe(context.Background(), "127.0.0.1", port); err == nil || !strings.Contains(err.Error(), "recusou") {
		t.Fatalf("%v", err)
	}
}

func TestDialExigeFingerprintCerta(t *testing.T) {
	s := newTestSSHServer(t, "pw", func(string) (string, int) { return "", 0 })
	base := ConnParams{Host: "127.0.0.1", Port: s.port(), User: "root", Password: "pw"}
	if _, err := DialSSH(context.Background(), base); err == nil {
		t.Fatal("sem fingerprint não pode conectar")
	}
	base.Fingerprint = "SHA256:chave-errada"
	_, err := DialSSH(context.Background(), base)
	var hk *HostKeyError
	if err == nil || !asHK(err, &hk) || hk.Got != s.fp() {
		t.Fatalf("fingerprint alterada deveria falhar com HostKeyError: %v", err)
	}
	if got := s.ran(); len(got) != 0 {
		t.Fatalf("nada deveria ter rodado: %v", got)
	}
}

func asHK(err error, target **HostKeyError) bool {
	hk, ok := err.(*HostKeyError)
	if ok {
		*target = hk
	}
	return ok
}

func TestDialRunUpload(t *testing.T) {
	s := newTestSSHServer(t, "senha-secreta-1", func(cmd string) (string, int) {
		if cmd == "falha" {
			return "ruim", 3
		}
		return "ok:" + cmd, 0
	})
	p := ConnParams{Host: "127.0.0.1", Port: s.port(), User: "root", Password: "senha-secreta-1", Fingerprint: s.fp()}
	r, err := DialSSH(context.Background(), p)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	res, err := r.Run(context.Background(), "echo oi", "")
	if err != nil || res.Stdout != "ok:echo oi" || res.Code != 0 {
		t.Fatalf("%+v %v", res, err)
	}
	res, err = r.Run(context.Background(), "falha", "")
	if err != nil || res.Code != 3 {
		t.Fatalf("%+v %v", res, err)
	}
	path, err := r.Upload(context.Background(), "arq.bin", []byte("dados"), 0o755)
	if err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(s.home, "arq.bin"))
	if err != nil || string(b) != "dados" {
		t.Fatalf("%q %v", b, err)
	}
	if !strings.HasSuffix(filepath.ToSlash(path), "/arq.bin") {
		t.Fatal(path)
	}
	if _, err := r.Upload(context.Background(), "../x", nil, 0o644); err == nil {
		t.Fatal("nome com caminho deveria ser recusado")
	}
}

func TestDialSenhaErradaNaoVazaSenha(t *testing.T) {
	s := newTestSSHServer(t, "certa", func(string) (string, int) { return "", 0 })
	p := ConnParams{Host: "127.0.0.1", Port: s.port(), User: "root", Password: "ERRADA-segredo", Fingerprint: s.fp()}
	_, err := DialSSH(context.Background(), p)
	if err == nil || strings.Contains(err.Error(), "ERRADA-segredo") {
		t.Fatalf("%v", err)
	}
}

func TestDialChavePrivadaInvalida(t *testing.T) {
	p := ConnParams{Host: "127.0.0.1", Port: 22, User: "root", PrivateKey: "-----BEGIN lixo", Fingerprint: "SHA256:x"}
	if _, err := DialSSH(context.Background(), p); err == nil || !strings.Contains(err.Error(), "chave privada") {
		t.Fatalf("%v", err)
	}
}
