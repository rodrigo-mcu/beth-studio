package phonelink

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

const (
	LinkPath   = "/bethstudio-link"
	codeScheme = "bethstudio"
)

// Code é o que a pessoa cola no Beth Studio: domínio público + segredo da ligação.
type Code struct {
	Domain string
	Secret string
}

func FormatCode(domain, secret string) string {
	q := url.Values{}
	q.Set("domain", domain)
	q.Set("secret", secret)
	return codeScheme + "://link?" + q.Encode()
}

func ParseCode(raw string) (Code, error) {
	s := strings.TrimSpace(raw)
	u, err := url.Parse(s)
	if err != nil || u.Scheme != codeScheme || u.Host != "link" {
		return Code{}, errors.New("cole a linha do servidor, a que começa com bethstudio://link")
	}
	domain := strings.TrimSpace(u.Query().Get("domain"))
	secret := strings.TrimSpace(u.Query().Get("secret"))
	if err := CheckDomain(domain); err != nil {
		return Code{}, err
	}
	if len(secret) < 32 || strings.ContainsAny(secret, " \r\n\x00") {
		return Code{}, errors.New("segredo inválido")
	}
	return Code{Domain: domain, Secret: secret}, nil
}

func CheckDomain(domain string) error {
	if domain == "" || strings.ContainsAny(domain, " \r\n\x00/\\:") {
		return errors.New("domínio inválido")
	}
	return nil
}

func secretOK(got, want string) bool {
	if want == "" || len(got) != len(want) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(got), []byte(want)) == 1
}

// HostOK compara o Host do pedido com o domínio configurado, ignorando a porta.
func HostOK(hostHeader, domain string) bool {
	host := hostHeader
	if h, _, err := net.SplitHostPort(hostHeader); err == nil {
		host = h
	}
	host = strings.TrimSuffix(strings.ToLower(strings.TrimSpace(host)), ".")
	domain = strings.TrimSuffix(strings.ToLower(strings.TrimSpace(domain)), ".")
	if host == "" || domain == "" || len(host) != len(domain) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(host), []byte(domain)) == 1
}

// LoadOrCreateSecret lê data/link-secret ou cria 32 bytes em hex.
func LoadOrCreateSecret(dir string) (string, error) {
	if strings.TrimSpace(dir) == "" {
		return "", errors.New("pasta vazia")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	path := filepath.Join(dir, "link-secret")
	if b, err := os.ReadFile(path); err == nil {
		s := strings.TrimSpace(string(b))
		if len(s) >= 32 {
			return s, nil
		}
	}
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	s := hex.EncodeToString(buf)
	if err := os.WriteFile(path, []byte(s+"\n"), 0o600); err != nil {
		return "", err
	}
	return s, nil
}
