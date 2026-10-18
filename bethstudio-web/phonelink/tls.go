package phonelink

import (
	"context"
	"crypto/tls"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/crypto/acme"
	"golang.org/x/crypto/acme/autocert"
)

// CertProvider é o que o modo HTTPS próprio precisa de quem obtém os
// certificados. Em produção é um autocert.Manager (Let's Encrypt); nos testes
// é um certificado autoassinado, sem rede.
type CertProvider interface {
	TLSConfig() *tls.Config
	HTTPHandler(fallback http.Handler) http.Handler
}

// HSTSValue: 180 dias, sem includeSubDomains e sem preload (de propósito: o
// domínio pode ter outros serviços em subdomínios).
const HSTSValue = "max-age=15552000"

// CertDir é a pasta dos certificados dentro da pasta de dados do proxy.
func CertDir(dataDir string) string { return filepath.Join(dataDir, "certs") }

// NewAutocert monta o gerenciador Let's Encrypt restrito a um único domínio,
// com cache em disco (pasta 0700). staging usa o ambiente de testes da Let's
// Encrypt, sem o limite de taxa da produção e cujos certificados o navegador
// não aceita.
func NewAutocert(domain, dataDir, email string, staging bool) (*autocert.Manager, error) {
	if err := CheckDomain(domain); err != nil {
		return nil, err
	}
	dir := CertDir(dataDir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return nil, err
	}
	m := &autocert.Manager{
		Prompt:     autocert.AcceptTOS,
		HostPolicy: autocert.HostWhitelist(domain),
		Cache:      autocert.DirCache(dir),
		Email:      email,
	}
	if staging {
		m.Client = &acme.Client{DirectoryURL: "https://acme-staging-v02.api.letsencrypt.org/directory"}
	}
	return m, nil
}

// TLSServers são os dois servidores do modo HTTPS próprio.
type TLSServers struct {
	HTTPS *http.Server // :443, atende o celular e a ligação do PC
	HTTP  *http.Server // :80, desafio ACME HTTP-01 e redirecionamento para https
	Cfg   *tls.Config
}

// NewTLSServers monta os servidores. h atende o HTTPS. hsts liga o
// Strict-Transport-Security (desligado com certificado de teste: o navegador
// ficaria preso em HTTPS sem certificado válido).
//
// HTTP/2 fica desligado de propósito: a ligação do celular e do PC usa
// WebSocket (HTTP/1.1 com Upgrade e Hijack), o proxy repassa um pedido HTTP/1.1
// por fluxo, e para um app de uso pessoal h2 não traz ganho que compense a
// superfície a mais.
func NewTLSServers(h http.Handler, prov CertProvider, domain string, hsts bool) *TLSServers {
	cfg := prov.TLSConfig().Clone()
	cfg.MinVersion = tls.VersionTLS12
	var protos []string
	for _, p := range cfg.NextProtos {
		if p != "h2" {
			protos = append(protos, p)
		}
	}
	if len(protos) == 0 {
		protos = []string{"http/1.1"}
	}
	cfg.NextProtos = protos
	secured := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hd := w.Header()
		hd.Set("X-Content-Type-Options", "nosniff")
		if hsts {
			hd.Set("Strict-Transport-Security", HSTSValue)
		}
		h.ServeHTTP(w, r)
	})
	redirect := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Destino fixo: nunca o Host do pedido (evita redirecionamento aberto).
		http.Redirect(w, r, "https://"+domain+r.URL.RequestURI(), http.StatusPermanentRedirect)
	})
	return &TLSServers{
		Cfg: cfg,
		HTTPS: &http.Server{
			Handler:           secured,
			TLSConfig:         cfg,
			TLSNextProto:      map[string]func(*http.Server, *tls.Conn, http.Handler){},
			ReadHeaderTimeout: 15 * time.Second,
			IdleTimeout:       120 * time.Second,
		},
		HTTP: &http.Server{
			Handler:           prov.HTTPHandler(redirect),
			ReadHeaderTimeout: 15 * time.Second,
			IdleTimeout:       30 * time.Second,
		},
	}
}

// WarmCerts pede o certificado do domínio sem esperar o primeiro visitante,
// para que o assistente e a pessoa vejam logo se a emissão funcionou. Tenta de
// novo com intervalos crescentes (a Let's Encrypt limita falhas a 5 por hora
// por domínio). Retorna quando consegue ou quando ctx termina.
func WarmCerts(ctx context.Context, cfg *tls.Config, domain string, delays []time.Duration, logf func(format string, a ...any)) error {
	if cfg == nil || cfg.GetCertificate == nil || len(delays) == 0 {
		return errors.New("configuração de certificado incompleta")
	}
	for i := 0; ; i++ {
		_, err := cfg.GetCertificate(&tls.ClientHelloInfo{ServerName: domain, SupportedProtos: []string{"http/1.1"}})
		if err == nil {
			logf("certificado de %s pronto", domain)
			return nil
		}
		logf("certificado de %s ainda não saiu: %v", domain, err)
		d := delays[len(delays)-1]
		if i < len(delays) {
			d = delays[i]
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(d):
		}
	}
}

// DefaultWarmDelays: 1, 3, 8, 15 e depois a cada 30 minutos.
var DefaultWarmDelays = []time.Duration{time.Minute, 3 * time.Minute, 8 * time.Minute, 15 * time.Minute, 30 * time.Minute}

// CleanEmail aceita vazio ou um e-mail simples (vai para a unit do systemd).
func CleanEmail(s string) (string, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return "", nil
	}
	at := strings.Index(s, "@")
	if strings.ContainsAny(s, " \t\r\n\x00%\"'\\$;&|<>`") || strings.Count(s, "@") != 1 || at < 1 || !strings.Contains(s[at:], ".") || strings.HasSuffix(s, ".") {
		return "", errors.New("e-mail inválido")
	}
	return s, nil
}
