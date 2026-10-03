package main

// ssh_dial.go — conexao SSH a um host salvo (golang.org/x/crypto/ssh),
// usada pelo terminal (ssh_helper_windows.go), pelo navegador de arquivos
// (sftp_api.go) e pelo "Testar conexão".
//
// Chave do servidor: %APPDATA%\bethstudio\ssh_known_hosts (formato OpenSSH).
// Primeira conexao = pergunta (TOFU); chave diferente da salva = recusa, sem
// opcao de "continuar mesmo assim" na mesma tela.
//
// Autenticacao: senha (salva no cofre, digitada agora ou pedida no
// terminal; tambem responde "keyboard-interactive"), arquivo de chave (com
// frase-senha salva/pedida) ou o agente SSH do Windows.

import (
	"bytes"
	"crypto/x509"
	"errors"
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"
	"golang.org/x/crypto/ssh/knownhosts"
)

// sshCreds: o que a interface/terminal fornece alem do cofre.
type sshCreds struct {
	Password   string // digitada agora (vazio = cofre / perguntar)
	Passphrase string

	// So' no terminal: perguntar. nil = nao ha como perguntar (web).
	Ask func(prompt string, echo bool) (string, error)
	// Chamado antes/depois de uma pergunta (para pausar o prazo do handshake).
	Pause, Resume func()
}

// sshHostKeyInfo: a chave apresentada pelo servidor.
type sshHostKeyInfo struct {
	Addr        string   `json:"addr"` // host:porta
	KeyType     string   `json:"key_type"`
	Fingerprint string   `json:"fingerprint"` // SHA256:...
	Known       []string `json:"known_fingerprints,omitempty"`
	Mismatch    bool     `json:"mismatch"`
}

// sshHostKeyError: chave desconhecida (e nao aceita) ou diferente da salva.
type sshHostKeyError struct{ Info sshHostKeyInfo }

func (e *sshHostKeyError) Error() string {
	if e.Info.Mismatch {
		return fmt.Sprintf("A CHAVE DO SERVIDOR %s MUDOU. A chave apresentada (%s %s) é diferente da que foi salva na primeira conexão (%s). "+
			"Isso acontece quando o servidor foi reinstalado ou trocado — mas também é exatamente o que um ataque \"homem no meio\" "+
			"mostraria. A conexão foi recusada. Confirme com quem administra o servidor; se a troca for legítima, use "+
			"\"Esquecer chave salva\" na tela SSH e conecte de novo.",
			e.Info.Addr, e.Info.KeyType, e.Info.Fingerprint, strings.Join(e.Info.Known, ", "))
	}
	return fmt.Sprintf("chave do servidor %s ainda não confirmada (%s %s)", e.Info.Addr, e.Info.KeyType, e.Info.Fingerprint)
}

// --- known_hosts -----------------------------------------------------------

var sshKnownMu sync.Mutex

func sshAddr(h SSHSavedHost) string { return net.JoinHostPort(h.Host, strconv.Itoa(h.Port)) }

// sshKnownKeys: chaves salvas para o endereco (normalizado como o OpenSSH:
// "host" na porta 22, "[host]:porta" nas outras).
func sshKnownKeys(addr string) ([]ssh.PublicKey, error) {
	b, err := os.ReadFile(sshKnownPath())
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	want := knownhosts.Normalize(addr)
	var keys []ssh.PublicKey
	for len(b) > 0 {
		marker, hosts, key, _, rest, err := ssh.ParseKnownHosts(b)
		if err != nil {
			break // fim do arquivo ou linha invalida no fim
		}
		b = rest
		if marker != "" {
			continue
		}
		for _, h := range hosts {
			if h == want {
				keys = append(keys, key)
				break
			}
		}
	}
	return keys, nil
}

// sshRememberKey acrescenta a chave (gravacao atomica).
func sshRememberKey(addr string, key ssh.PublicKey) error {
	sshKnownMu.Lock()
	defer sshKnownMu.Unlock()
	old, err := os.ReadFile(sshKnownPath())
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if len(old) > 0 && old[len(old)-1] != '\n' {
		old = append(old, '\n')
	}
	line := knownhosts.Line([]string{knownhosts.Normalize(addr)}, key) + "\n"
	return writeAtomic(sshKnownPath(), append(old, line...))
}

// sshForgetKey remove as linhas do endereco. Devolve quantas.
func sshForgetKey(addr string) (int, error) {
	sshKnownMu.Lock()
	defer sshKnownMu.Unlock()
	b, err := os.ReadFile(sshKnownPath())
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return 0, nil
		}
		return 0, err
	}
	want := knownhosts.Normalize(addr)
	var out []byte
	n := 0
	for _, line := range strings.SplitAfter(string(b), "\n") {
		f := strings.Fields(line)
		if len(f) >= 3 && !strings.HasPrefix(f[0], "#") {
			match := false
			for _, h := range strings.Split(f[0], ",") {
				if h == want {
					match = true
				}
			}
			if match {
				n++
				continue
			}
		}
		out = append(out, line...)
	}
	if n == 0 {
		return 0, nil
	}
	return n, writeAtomic(sshKnownPath(), out)
}

// sshHostKeyAlgos: com chave salva, pede ao servidor exatamente aquele tipo
// (senao um servidor com varias chaves pode mandar outra e parecer "mudou").
func sshHostKeyAlgos(known []ssh.PublicKey) []string {
	if len(known) == 0 {
		// padrao moderno + ssh-rsa (SHA-1) no fim para servidores antigos
		return []string{
			ssh.KeyAlgoED25519, ssh.KeyAlgoECDSA256, ssh.KeyAlgoECDSA384, ssh.KeyAlgoECDSA521,
			ssh.KeyAlgoRSASHA512, ssh.KeyAlgoRSASHA256, ssh.KeyAlgoRSA,
		}
	}
	seen := map[string]bool{}
	var out []string
	add := func(a ...string) {
		for _, x := range a {
			if !seen[x] {
				seen[x] = true
				out = append(out, x)
			}
		}
	}
	for _, k := range known {
		if k.Type() == ssh.KeyAlgoRSA {
			add(ssh.KeyAlgoRSASHA512, ssh.KeyAlgoRSASHA256, ssh.KeyAlgoRSA)
		} else {
			add(k.Type())
		}
	}
	return out
}

// sshCheckHostKey: nil = conhecida e igual; *sshHostKeyError = desconhecida
// ou diferente.
func sshCheckHostKey(addr string, key ssh.PublicKey, known []ssh.PublicKey) error {
	info := sshHostKeyInfo{Addr: addr, KeyType: key.Type(), Fingerprint: ssh.FingerprintSHA256(key)}
	if len(known) == 0 {
		return &sshHostKeyError{Info: info}
	}
	wire := key.Marshal()
	for _, k := range known {
		if bytes.Equal(k.Marshal(), wire) {
			return nil
		}
	}
	for _, k := range known {
		info.Known = append(info.Known, k.Type()+" "+ssh.FingerprintSHA256(k))
	}
	info.Mismatch = true
	return &sshHostKeyError{Info: info}
}

// --- autenticacao --------------------------------------------------------------

func sshAgentPipe() string {
	if v := strings.TrimSpace(os.Getenv("BETHSTUDIO_SSH_AGENT_PIPE")); v != "" {
		return v // testes
	}
	if v := strings.TrimSpace(os.Getenv("SSH_AUTH_SOCK")); strings.HasPrefix(v, `\\.\pipe\`) {
		return v
	}
	return `\\.\pipe\openssh-ssh-agent`
}

// sshAuthMethods monta os metodos do host. closers: fechar depois do dial.
func sshAuthMethods(h SSHSavedHost, c sshCreds) (methods []ssh.AuthMethod, closers []func(), err error) {
	ask := func(prompt string, echo bool) (string, error) {
		if c.Ask == nil {
			return "", errors.New("senha necessária")
		}
		if c.Pause != nil {
			c.Pause()
		}
		defer func() {
			if c.Resume != nil {
				c.Resume()
			}
		}()
		return c.Ask(prompt, echo)
	}
	switch h.Auth {
	case sshAuthKey:
		path := sshExpandHome(h.KeyPath)
		st, err := os.Stat(path)
		if err != nil {
			return nil, nil, fmt.Errorf("arquivo de chave não encontrado: %s", path)
		}
		if st.Size() > 256<<10 {
			return nil, nil, fmt.Errorf("arquivo de chave grande demais: %s", path)
		}
		pem, err := os.ReadFile(path)
		if err != nil {
			return nil, nil, fmt.Errorf("não foi possível ler a chave: %v", err)
		}
		signer, err := ssh.ParsePrivateKey(pem)
		var missing *ssh.PassphraseMissingError
		if errors.As(err, &missing) {
			pp := c.Passphrase
			if pp == "" {
				pp, _ = sshSecretGet(sshSecretPass, h.ID)
			}
			for try := 0; ; try++ {
				if pp == "" {
					if c.Ask == nil {
						return nil, nil, errors.New("frase-senha da chave necessária")
					}
					if pp, err = ask("Frase-senha da chave "+path+": ", false); err != nil {
						return nil, nil, err
					}
				}
				signer, err = ssh.ParsePrivateKeyWithPassphrase(pem, []byte(pp))
				if err == nil || !errors.Is(err, x509.IncorrectPasswordError) {
					break
				}
				if c.Ask == nil || try >= 2 {
					return nil, nil, errors.New("frase-senha da chave incorreta")
				}
				pp = ""
			}
		}
		if err != nil {
			return nil, nil, fmt.Errorf("chave privada inválida (%s): %v", path, err)
		}
		return []ssh.AuthMethod{ssh.PublicKeys(signer)}, nil, nil
	case sshAuthAgent:
		pipe := sshAgentPipe()
		f, err := os.OpenFile(pipe, os.O_RDWR, 0)
		if err != nil {
			return nil, nil, fmt.Errorf("agente SSH do Windows indisponível (%s). Ative o serviço \"OpenSSH Authentication Agent\" e adicione a chave com ssh-add", pipe)
		}
		ag := agent.NewClient(f)
		return []ssh.AuthMethod{ssh.PublicKeysCallback(ag.Signers)}, []func(){func() { _ = f.Close() }}, nil
	default: // senha
		first := c.Password
		if first == "" {
			first, _ = sshSecretGet(sshSecretPw, h.ID)
		}
		var mu sync.Mutex
		tries := 0
		next := func() (string, error) {
			mu.Lock()
			defer mu.Unlock()
			tries++
			if tries == 1 && first != "" {
				return first, nil
			}
			if c.Ask == nil {
				if first == "" {
					return "", errors.New("senha necessária")
				}
				return "", errors.New("senha recusada pelo servidor")
			}
			if tries > 3 {
				return "", errors.New("senha recusada pelo servidor (3 tentativas)")
			}
			prompt := fmt.Sprintf("Senha de %s@%s: ", h.User, h.Host)
			if tries > 1 {
				prompt = "Senha recusada. " + prompt
			}
			return ask(prompt, false)
		}
		pw := ssh.RetryableAuthMethod(ssh.PasswordCallback(next), 3)
		kbd := ssh.RetryableAuthMethod(ssh.KeyboardInteractive(func(name, instruction string, questions []string, echos []bool) ([]string, error) {
			ans := make([]string, len(questions))
			for i, q := range questions {
				// pergunta de senha comum: responde com a senha
				lq := strings.ToLower(q)
				if !echos[i] && (strings.Contains(lq, "password") || strings.Contains(lq, "senha")) {
					v, err := next()
					if err != nil {
						return nil, err
					}
					ans[i] = v
					continue
				}
				if c.Ask == nil {
					return nil, errors.New("o servidor fez uma pergunta que só pode ser respondida no terminal: " + strings.TrimSpace(q))
				}
				if instruction != "" && i == 0 {
					_, _ = ask(strings.TrimSpace(name+" "+instruction)+"\n(Enter para continuar) ", true)
				}
				v, err := ask(q, echos[i])
				if err != nil {
					return nil, err
				}
				ans[i] = v
			}
			return ans, nil
		}), 3)
		return []ssh.AuthMethod{pw, kbd}, nil, nil
	}
}

// --- dial ----------------------------------------------------------------------

// sshDial conecta. onUnknown decide sobre uma chave de servidor nunca vista
// (true = confiar e gravar). Chave diferente da salva: sempre recusa.
func sshDial(h SSHSavedHost, c sshCreds, onUnknown func(sshHostKeyInfo) (bool, error), timeout time.Duration) (*ssh.Client, error) {
	if timeout <= 0 {
		timeout = 20 * time.Second
	}
	addr := sshAddr(h)
	known, err := sshKnownKeys(addr)
	if err != nil {
		return nil, fmt.Errorf("não foi possível ler %s: %v", sshKnownFile, err)
	}
	conn, err := net.DialTimeout("tcp", addr, timeout)
	if err != nil {
		return nil, sshFriendlyErr(err)
	}
	deadline := func() { _ = conn.SetDeadline(time.Now().Add(timeout)) }
	pause := func() { _ = conn.SetDeadline(time.Time{}) }
	deadline()
	c.Pause, c.Resume = pause, deadline
	methods, closers, err := sshAuthMethods(h, c)
	defer func() {
		for _, f := range closers {
			f()
		}
	}()
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	var keyErr *sshHostKeyError
	cfg := &ssh.ClientConfig{
		User:              h.User,
		Auth:              methods,
		HostKeyAlgorithms: sshHostKeyAlgos(known),
		ClientVersion:     "SSH-2.0-BethStudio",
		HostKeyCallback: func(_ string, _ net.Addr, key ssh.PublicKey) error {
			err := sshCheckHostKey(addr, key, known)
			if err == nil {
				return nil
			}
			ke := err.(*sshHostKeyError)
			if ke.Info.Mismatch || onUnknown == nil {
				keyErr = ke
				return ke
			}
			pause()
			ok, aerr := onUnknown(ke.Info)
			deadline()
			if aerr != nil {
				return aerr
			}
			if !ok {
				keyErr = ke
				return ke
			}
			if err := sshRememberKey(addr, key); err != nil {
				return fmt.Errorf("não foi possível salvar a chave do servidor: %v", err)
			}
			return nil
		},
	}
	sc, chans, reqs, err := ssh.NewClientConn(conn, addr, cfg)
	if err != nil {
		_ = conn.Close()
		if keyErr != nil {
			return nil, keyErr
		}
		if len(known) > 0 && strings.Contains(err.Error(), "no common algorithm for host key") {
			return nil, fmt.Errorf("o servidor %s não oferece mais o tipo de chave salvo (%s): a chave do servidor pode ter mudado. "+
				"Se for legítimo, use \"Esquecer chave salva\" e conecte de novo", addr, known[0].Type())
		}
		return nil, sshFriendlyErr(err)
	}
	_ = conn.SetDeadline(time.Time{})
	return ssh.NewClient(sc, chans, reqs), nil
}

// sshKeepAlive manda keepalive@openssh.com a cada intervalo; fecha o cliente
// apos 3 falhas seguidas (rede caiu sem FIN).
func sshKeepAlive(cl *ssh.Client, every time.Duration, stop <-chan struct{}) {
	t := time.NewTicker(every)
	defer t.Stop()
	fails := 0
	for {
		select {
		case <-stop:
			return
		case <-t.C:
			done := make(chan error, 1)
			go func() {
				_, _, err := cl.SendRequest("keepalive@openssh.com", true, nil)
				done <- err
			}()
			select {
			case err := <-done:
				if err != nil {
					fails++
				} else {
					fails = 0
				}
			case <-time.After(every):
				fails++
			}
			if fails >= 3 {
				_ = cl.Close()
				return
			}
		}
	}
}

// sshFriendlyErr: mensagens comuns em pt-BR (o original vai junto).
func sshFriendlyErr(err error) error {
	if err == nil {
		return nil
	}
	var ke *sshHostKeyError
	if errors.As(err, &ke) {
		return err
	}
	s := err.Error()
	low := strings.ToLower(s)
	switch {
	case strings.Contains(low, "unable to authenticate") || strings.Contains(low, "no supported methods remain"):
		return fmt.Errorf("autenticação recusada pelo servidor (usuário, senha ou chave incorretos) — %s", s)
	case strings.Contains(low, "senha necessária"), strings.Contains(low, "senha recusada"):
		return err
	case strings.Contains(low, "connection refused") || strings.Contains(low, "actively refused") || strings.Contains(low, "recusou"):
		return fmt.Errorf("conexão recusada: não há servidor SSH nessa porta — %s", s)
	case strings.Contains(low, "i/o timeout") || strings.Contains(low, "timed out") || strings.Contains(low, "tempo"):
		return fmt.Errorf("tempo esgotado ao conectar (endereço inacessível ou firewall) — %s", s)
	case strings.Contains(low, "no such host") || strings.Contains(low, "não é conhecido"):
		return fmt.Errorf("nome de host não encontrado (DNS) — %s", s)
	case strings.Contains(low, "network is unreachable") || strings.Contains(low, "unreachable"):
		return fmt.Errorf("rede inacessível a partir deste computador — %s", s)
	case strings.Contains(low, "handshake failed") && strings.Contains(low, "eof"):
		return fmt.Errorf("o servidor fechou a conexão durante o início da sessão (limite de tentativas ou algoritmo não aceito) — %s", s)
	}
	return err
}
