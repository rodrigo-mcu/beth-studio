package vpsinstall

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

// ConnParams são os dados de uma conexão SSH. Senha, chave e passphrase só
// existem em memória.
type ConnParams struct {
	Host        string
	Port        int
	User        string
	Password    string
	PrivateKey  string
	Passphrase  string
	Fingerprint string // SHA256:... confirmado pela pessoa; obrigatório
}

// Result é a saída de um comando remoto.
type Result struct {
	Stdout string
	Stderr string
	Code   int
}

// Remote é a sessão com o servidor (real ou falsa nos testes).
type Remote interface {
	// Run executa um comando fixo escrito neste pacote.
	Run(ctx context.Context, cmd string, stdin string) (Result, error)
	// Upload grava data num arquivo da pasta pessoal do usuário e devolve o caminho absoluto.
	Upload(ctx context.Context, name string, data []byte, mode os.FileMode) (string, error)
	Close() error
}

type Dialer func(ctx context.Context, p ConnParams) (Remote, error)

// HostKeyError: a chave do servidor não é a que a pessoa confirmou.
type HostKeyError struct{ Got, Want string }

func (e *HostKeyError) Error() string {
	return fmt.Sprintf("a impressão digital do servidor mudou (esperada %s, recebida %s). Parei por segurança", e.Want, e.Got)
}

// ProbeResult é a chave que o servidor apresentou.
type ProbeResult struct {
	Fingerprint string `json:"fingerprint"`
	KeyType     string `json:"key_type"`
}

func addr(host string, port int) string { return net.JoinHostPort(host, strconv.Itoa(port)) }

// Probe lê a chave do servidor sem autenticar. Serve para mostrar a impressão
// digital antes de qualquer senha ser enviada.
func Probe(ctx context.Context, host string, port int) (ProbeResult, error) {
	var res ProbeResult
	d := net.Dialer{Timeout: 15 * time.Second}
	conn, err := d.DialContext(ctx, "tcp", addr(host, port))
	if err != nil {
		return res, friendlyNetErr(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(20 * time.Second))
	errProbe := errors.New("probe")
	cfg := &ssh.ClientConfig{
		User: "probe",
		HostKeyCallback: func(_ string, _ net.Addr, key ssh.PublicKey) error {
			res = ProbeResult{Fingerprint: ssh.FingerprintSHA256(key), KeyType: key.Type()}
			return errProbe
		},
		Timeout: 20 * time.Second,
	}
	_, _, _, err = ssh.NewClientConn(conn, addr(host, port), cfg)
	if res.Fingerprint != "" {
		return res, nil
	}
	if err != nil {
		return res, fmt.Errorf("o servidor não respondeu como SSH: %s", shortErr(err))
	}
	return res, errors.New("o servidor não apresentou chave")
}

func friendlyNetErr(err error) error {
	s := err.Error()
	switch {
	case strings.Contains(s, "refused"):
		return errors.New("o servidor recusou a conexão nessa porta (SSH está ligado? porta certa?)")
	case strings.Contains(s, "no such host"):
		return errors.New("nome do servidor não encontrado")
	case strings.Contains(s, "timeout"), strings.Contains(s, "deadline"):
		return errors.New("o servidor não respondeu (firewall, IP ou porta errados?)")
	}
	return errors.New("não consegui conectar: " + shortErr(err))
}

func shortErr(err error) string {
	s := err.Error()
	if len(s) > 160 {
		s = s[:160]
	}
	return s
}

func authMethods(p ConnParams) ([]ssh.AuthMethod, error) {
	var ms []ssh.AuthMethod
	if strings.TrimSpace(p.PrivateKey) != "" {
		var signer ssh.Signer
		var err error
		if p.Passphrase != "" {
			signer, err = ssh.ParsePrivateKeyWithPassphrase([]byte(p.PrivateKey), []byte(p.Passphrase))
		} else {
			signer, err = ssh.ParsePrivateKey([]byte(p.PrivateKey))
		}
		if err != nil {
			var miss *ssh.PassphraseMissingError
			if errors.As(err, &miss) {
				return nil, errors.New("a chave privada tem passphrase: informe-a")
			}
			return nil, errors.New("não consegui ler a chave privada (formato inválido ou passphrase errada)")
		}
		ms = append(ms, ssh.PublicKeys(signer))
	}
	if p.Password != "" {
		pw := p.Password
		ms = append(ms, ssh.Password(pw))
		ms = append(ms, ssh.KeyboardInteractive(func(_, _ string, qs []string, _ []bool) ([]string, error) {
			out := make([]string, len(qs))
			for i := range out {
				out[i] = pw
			}
			return out, nil
		}))
	}
	if len(ms) == 0 {
		return nil, errors.New("informe a senha ou a chave privada do servidor")
	}
	return ms, nil
}

type sshRemote struct {
	c    *ssh.Client
	sftp *sftp.Client
	home string
}

// DialSSH conecta exigindo a chave de servidor confirmada. Sem Fingerprint não conecta.
func DialSSH(ctx context.Context, p ConnParams) (Remote, error) {
	if p.Fingerprint == "" {
		return nil, errors.New("falta confirmar a impressão digital do servidor")
	}
	if err := ValidateHost(p.Host); err != nil {
		return nil, err
	}
	if err := ValidatePort(p.Port); err != nil {
		return nil, err
	}
	if err := ValidateUser(p.User); err != nil {
		return nil, err
	}
	auth, err := authMethods(p)
	if err != nil {
		return nil, err
	}
	cfg := &ssh.ClientConfig{
		User: p.User,
		Auth: auth,
		HostKeyCallback: func(_ string, _ net.Addr, key ssh.PublicKey) error {
			if got := ssh.FingerprintSHA256(key); got != p.Fingerprint {
				return &HostKeyError{Got: got, Want: p.Fingerprint}
			}
			return nil
		},
		Timeout: 20 * time.Second,
	}
	d := net.Dialer{Timeout: 15 * time.Second}
	conn, err := d.DialContext(ctx, "tcp", addr(p.Host, p.Port))
	if err != nil {
		return nil, friendlyNetErr(err)
	}
	_ = conn.SetDeadline(time.Now().Add(30 * time.Second))
	sc, chans, reqs, err := ssh.NewClientConn(conn, addr(p.Host, p.Port), cfg)
	if err != nil {
		_ = conn.Close()
		var hk *HostKeyError
		if errors.As(err, &hk) {
			return nil, hk
		}
		if strings.Contains(err.Error(), "unable to authenticate") {
			return nil, errors.New("o servidor recusou o usuário/senha/chave")
		}
		return nil, errors.New("falha no SSH: " + shortErr(err))
	}
	_ = conn.SetDeadline(time.Time{})
	cl := ssh.NewClient(sc, chans, reqs)
	sf, err := sftp.NewClient(cl)
	if err != nil {
		_ = cl.Close()
		return nil, errors.New("o servidor não oferece SFTP (necessário para enviar o programa)")
	}
	home, err := sf.Getwd()
	if err != nil || home == "" {
		_ = sf.Close()
		_ = cl.Close()
		return nil, errors.New("não consegui descobrir a pasta pessoal no servidor")
	}
	return &sshRemote{c: cl, sftp: sf, home: home}, nil
}

type limitBuf struct {
	b bytes.Buffer
}

func (l *limitBuf) Write(p []byte) (int, error) {
	if l.b.Len() < 1<<20 {
		l.b.Write(p)
	}
	return len(p), nil
}

func (r *sshRemote) Run(ctx context.Context, cmd string, stdin string) (Result, error) {
	s, err := r.c.NewSession()
	if err != nil {
		return Result{}, errors.New("a conexão com o servidor caiu")
	}
	defer s.Close()
	var out, errb limitBuf
	s.Stdout, s.Stderr = &out, &errb
	if stdin != "" {
		s.Stdin = strings.NewReader(stdin)
	}
	done := make(chan error, 1)
	go func() { done <- s.Run(cmd) }()
	select {
	case <-ctx.Done():
		_ = s.Close()
		return Result{}, ctx.Err()
	case err := <-done:
		res := Result{Stdout: out.b.String(), Stderr: errb.b.String()}
		if err == nil {
			return res, nil
		}
		var ee *ssh.ExitError
		if errors.As(err, &ee) {
			res.Code = ee.ExitStatus()
			return res, nil
		}
		return res, errors.New("a conexão com o servidor caiu durante um comando")
	}
}

func (r *sshRemote) Upload(ctx context.Context, name string, data []byte, mode os.FileMode) (string, error) {
	if strings.ContainsAny(name, "/\\") || name == "" || name == "." || name == ".." {
		return "", errors.New("nome de envio inválido")
	}
	path := strings.TrimSuffix(r.home, "/") + "/" + name
	f, err := r.sftp.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC)
	if err != nil {
		return "", errors.New("não consegui criar o arquivo no servidor")
	}
	if _, err := io.Copy(f, bytes.NewReader(data)); err != nil {
		_ = f.Close()
		return "", errors.New("o envio para o servidor falhou")
	}
	if err := f.Close(); err != nil {
		return "", errors.New("o envio para o servidor falhou")
	}
	if err := r.sftp.Chmod(path, mode); err != nil {
		return "", errors.New("não consegui ajustar a permissão do arquivo enviado")
	}
	return path, nil
}

func (r *sshRemote) Close() error {
	_ = r.sftp.Close()
	return r.c.Close()
}
