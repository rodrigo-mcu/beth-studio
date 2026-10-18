package phonelink

import (
	"bufio"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"errors"
	"io"
	"math/big"
	"net"
	"net/http"
	"os"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// selfSigned gera um certificado de teste para 127.0.0.1.
func selfSigned(t *testing.T) (tls.Certificate, *x509.CertPool) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "127.0.0.1"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	leaf, _ := x509.ParseCertificate(der)
	pool := x509.NewCertPool()
	pool.AddCert(leaf)
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key, Leaf: leaf}, pool
}

// fakeProvider é o CertProvider dos testes: certificado fixo, sem ACME. Anuncia
// h2 como o autocert faz, para provar que o servidor o desliga.
type fakeProvider struct{ cert tls.Certificate }

func (f fakeProvider) TLSConfig() *tls.Config {
	return &tls.Config{Certificates: []tls.Certificate{f.cert}, NextProtos: []string{"h2", "http/1.1", "acme-tls/1"}}
}
func (f fakeProvider) HTTPHandler(fb http.Handler) http.Handler { return fb }

type tlsEnv struct {
	httpsAddr, httpAddr string
	pool                *x509.CertPool
	proxy               *Proxy
}

func startTLS(t *testing.T, hsts bool) *tlsEnv {
	t.Helper()
	cert, pool := selfSigned(t)
	p := &Proxy{Domain: "127.0.0.1", Secret: testSecret, Direct: true}
	srvs := NewTLSServers(p, fakeProvider{cert}, "127.0.0.1", hsts)
	lnS, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	lnH, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = srvs.HTTPS.ServeTLS(lnS, "", "") }()
	go func() { _ = srvs.HTTP.Serve(lnH) }()
	t.Cleanup(func() { _ = srvs.HTTPS.Close(); _ = srvs.HTTP.Close() })
	return &tlsEnv{httpsAddr: lnS.Addr().String(), httpAddr: lnH.Addr().String(), pool: pool, proxy: p}
}

func (e *tlsEnv) client() *http.Client {
	return &http.Client{
		Transport:     &http.Transport{TLSClientConfig: &tls.Config{RootCAs: e.pool}, ForceAttemptHTTP2: true},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

func TestTLSRedirecionaHTTPParaHTTPS(t *testing.T) {
	e := startTLS(t, true)
	req, _ := http.NewRequest(http.MethodGet, "http://"+e.httpAddr+"/agente?a=1", nil)
	req.Host = "malvado.exemplo.com" // o destino não pode seguir o Host do pedido
	res, err := e.client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	if res.StatusCode != http.StatusPermanentRedirect {
		t.Fatalf("status %d", res.StatusCode)
	}
	if loc := res.Header.Get("Location"); loc != "https://127.0.0.1/agente?a=1" {
		t.Fatalf("Location %q", loc)
	}
}

func TestTLSVersaoCabecalhosESemH2(t *testing.T) {
	for _, hsts := range []bool{true, false} {
		e := startTLS(t, hsts)
		req, _ := http.NewRequest(http.MethodGet, "https://"+e.httpsAddr+"/", nil)
		req.Host = "127.0.0.1"
		res, err := e.client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = res.Body.Close()
		if res.ProtoMajor != 1 {
			t.Fatalf("esperava HTTP/1.x, veio %s", res.Proto)
		}
		if res.TLS == nil || res.TLS.Version < tls.VersionTLS12 {
			t.Fatalf("TLS %v", res.TLS)
		}
		if res.Header.Get("X-Content-Type-Options") != "nosniff" {
			t.Fatal("sem nosniff")
		}
		got := res.Header.Get("Strict-Transport-Security")
		if hsts && got != HSTSValue {
			t.Fatalf("HSTS %q", got)
		}
		if !hsts && got != "" {
			t.Fatalf("HSTS com certificado de teste: %q", got)
		}
		if strings.Contains(strings.ToLower(got), "includesubdomains") || strings.Contains(strings.ToLower(got), "preload") {
			t.Fatalf("HSTS largo demais: %q", got)
		}
	}
	// TLS 1.1 recusado
	e := startTLS(t, true)
	_, err := tls.Dial("tcp", e.httpsAddr, &tls.Config{RootCAs: e.pool, MaxVersion: tls.VersionTLS11, ServerName: "127.0.0.1"})
	if err == nil {
		t.Fatal("TLS 1.1 aceito")
	}
}

func TestTLSWebSocketDePontaAPonta(t *testing.T) {
	e := startTLS(t, true)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// ligação do PC: yamux sobre WebSocket sobre TLS
	sess, err := DialTLS(ctx, "wss://"+e.httpsAddr, testSecret, &tls.Config{RootCAs: e.pool})
	if err != nil {
		t.Fatal(err)
	}
	defer sess.Close()
	var seenClient, seenXFF atomic.Value
	go Serve(sess, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if isWebsocket(r) {
			pipe, err := upgradeServer(w, r)
			if err != nil {
				return
			}
			defer pipe.Close()
			buf := make([]byte, 4)
			_, _ = io.ReadFull(pipe, buf)
			_, _ = pipe.Write([]byte("eco:" + string(buf)))
			return
		}
		seenClient.Store(r.Header.Get("X-BethStudio-Client"))
		seenXFF.Store(r.Header.Get("X-Forwarded-For") + "|" + r.Header.Get("X-Real-IP"))
		_, _ = io.WriteString(w, "ola")
	}))

	// pedido HTTP comum do celular, tentando forjar o IP
	var res *http.Response
	deadline := time.Now().Add(3 * time.Second)
	for {
		req, _ := http.NewRequest(http.MethodGet, "https://"+e.httpsAddr+"/x", nil)
		req.Host = "127.0.0.1"
		req.Header.Set("X-Forwarded-For", "6.6.6.6")
		req.Header.Set("X-Real-IP", "7.7.7.7")
		res, err = e.client().Do(req)
		if err == nil && res.StatusCode == http.StatusOK {
			break
		}
		if res != nil {
			_ = res.Body.Close()
		}
		if time.Now().After(deadline) {
			t.Fatalf("sem resposta: %v", err)
		}
		time.Sleep(20 * time.Millisecond)
	}
	body, _ := io.ReadAll(res.Body)
	_ = res.Body.Close()
	if string(body) != "ola" {
		t.Fatalf("%q", body)
	}
	if res.Header.Get("Strict-Transport-Security") != HSTSValue {
		t.Fatalf("HSTS %q", res.Header)
	}
	// vindo de 127.0.0.1 mas Direct: não vale X-Forwarded-For
	if c := seenClient.Load(); c != "127.0.0.1" {
		t.Fatalf("X-BethStudio-Client %v", c)
	}
	if x := seenXFF.Load(); x != "|" {
		t.Fatalf("cabeçalhos de IP chegaram ao PC: %v", x)
	}

	// WebSocket do celular (/ws) sobre TLS
	conn, err := tls.Dial("tcp", e.httpsAddr, &tls.Config{RootCAs: e.pool, ServerName: "127.0.0.1", NextProtos: []string{"http/1.1"}})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	bw := bufio.NewWriter(conn)
	br := bufio.NewReader(conn)
	_, _ = bw.WriteString("GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n")
	_ = bw.Flush()
	resp, err := http.ReadResponse(br, &http.Request{Method: "GET"})
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 101 {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("%d %s", resp.StatusCode, b)
	}
	pipe := newWSPipe(conn, br, bw, true)
	if _, err := pipe.Write([]byte("ping")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 8)
	if _, err := io.ReadFull(pipe, buf); err != nil {
		t.Fatal(err)
	}
	if string(buf) != "eco:ping" {
		t.Fatalf("%q", buf)
	}

	// segredo errado continua barrado sobre TLS
	if bad, err := DialTLS(ctx, "wss://"+e.httpsAddr, "segredo-errado-segredo-errado-xx", &tls.Config{RootCAs: e.pool}); err == nil {
		_ = bad.Close()
		t.Fatal("segredo errado entrou")
	}
}

func TestTLSLimiteDeLoginUsaIPDaConexao(t *testing.T) {
	// No modo direto, um cliente não escapa do limite trocando X-Forwarded-For.
	p := &Proxy{Domain: "127.0.0.1", Secret: testSecret, Direct: true}
	ip := func(xff string) string {
		r, _ := http.NewRequest(http.MethodPost, "/api/phone/login", nil)
		r.RemoteAddr = "127.0.0.1:5000"
		r.Header.Set("X-Forwarded-For", xff)
		return p.clientIP(r)
	}
	if ip("1.1.1.1") != "127.0.0.1" || ip("2.2.2.2") != "127.0.0.1" {
		t.Fatal("X-Forwarded-For influenciou o IP no modo direto")
	}
	p.Direct = false
	r, _ := http.NewRequest(http.MethodGet, "/", nil)
	r.RemoteAddr = "127.0.0.1:5000"
	r.Header.Set("X-Forwarded-For", "203.0.113.9")
	if p.clientIP(r) != "203.0.113.9" {
		t.Fatal("modo atrás de proxy mudou")
	}
}

func TestAutocertSoAceitaODominio(t *testing.T) {
	dir := t.TempDir()
	m, err := NewAutocert("agentes.exemplo.com", dir, "", false)
	if err != nil {
		t.Fatal(err)
	}
	// HostPolicy barra antes de qualquer acesso à rede
	_, err = m.GetCertificate(&tls.ClientHelloInfo{ServerName: "outro.exemplo.com"})
	if err == nil || !strings.Contains(err.Error(), "not configured") {
		t.Fatalf("outro domínio aceito: %v", err)
	}
	if err := m.HostPolicy(context.Background(), "agentes.exemplo.com"); err != nil {
		t.Fatal(err)
	}
	if err := m.HostPolicy(context.Background(), "sub.agentes.exemplo.com"); err == nil {
		t.Fatal("subdomínio aceito")
	}
	st, err := os.Stat(CertDir(dir))
	if err != nil || !st.IsDir() {
		t.Fatal("pasta de certificados não criada")
	}
	if runtime.GOOS != "windows" && st.Mode().Perm() != 0o700 {
		t.Fatalf("permissão %v", st.Mode().Perm())
	}
	// o autocert anuncia h2; o servidor tem que tirar
	srvs := NewTLSServers(http.NotFoundHandler(), m, "agentes.exemplo.com", true)
	for _, p := range srvs.Cfg.NextProtos {
		if p == "h2" {
			t.Fatal("h2 ligado")
		}
	}
	hasACME := false
	for _, p := range srvs.Cfg.NextProtos {
		hasACME = hasACME || p == "acme-tls/1"
	}
	if !hasACME {
		t.Fatal("sem acme-tls/1 (TLS-ALPN-01)")
	}
}

func TestAutocertCorrigePermissaoDaPasta(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("permissões unix")
	}
	dir := t.TempDir()
	if err := os.MkdirAll(CertDir(dir), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := NewAutocert("agentes.exemplo.com", dir, "", false); err != nil {
		t.Fatal(err)
	}
	st, _ := os.Stat(CertDir(dir))
	if st.Mode().Perm() != 0o700 {
		t.Fatalf("%v", st.Mode().Perm())
	}
}

func TestWarmCertsTentaAteConseguir(t *testing.T) {
	var n int32
	cfg := &tls.Config{GetCertificate: func(h *tls.ClientHelloInfo) (*tls.Certificate, error) {
		if h.ServerName != "agentes.exemplo.com" {
			return nil, errors.New("domínio errado")
		}
		if atomic.AddInt32(&n, 1) < 3 {
			return nil, errors.New("dns ainda não propagou")
		}
		return &tls.Certificate{}, nil
	}}
	err := WarmCerts(context.Background(), cfg, "agentes.exemplo.com", []time.Duration{time.Millisecond}, func(string, ...any) {})
	if err != nil || n != 3 {
		t.Fatalf("err=%v n=%d", err, n)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	cfg.GetCertificate = func(*tls.ClientHelloInfo) (*tls.Certificate, error) { return nil, errors.New("x") }
	if err := WarmCerts(ctx, cfg, "a.b", []time.Duration{time.Hour}, func(string, ...any) {}); err == nil {
		t.Fatal("devia parar com o contexto")
	}
}

func TestCleanEmail(t *testing.T) {
	for _, ok := range []string{"", "  ", "eu@exemplo.com"} {
		if _, err := CleanEmail(ok); err != nil {
			t.Fatalf("%q: %v", ok, err)
		}
	}
	for _, bad := range []string{"semarroba", "a@b", "a b@c.com", "a@c.com\nExecStart=/bin/sh", "a%h@c.com", "@c.com", "a@@c.com"} {
		if _, err := CleanEmail(bad); err == nil {
			t.Fatalf("%q aceito", bad)
		}
	}
}
