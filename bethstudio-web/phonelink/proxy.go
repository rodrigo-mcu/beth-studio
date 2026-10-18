package phonelink

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/base64"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/hashicorp/yamux"
)

// Proxy recebe o celular (atrás do proxy que a pessoa já tem) e uma ligação do Beth Studio.
type Proxy struct {
	Domain string
	Secret string
	// DataDir: onde guardar a hora em que o PC foi visto pela última vez ("" = só memória).
	DataDir string
	// Now: relógio (testes). nil = time.Now.
	Now func() time.Time
	// Direct: o proxy atende a internet sem outro proxy na frente (modo HTTPS
	// próprio). O IP do cliente é só o da conexão TCP; X-Forwarded-For e
	// X-Real-IP vindos do cliente nunca valem, nem de 127.0.0.1.
	Direct bool

	mu   sync.Mutex
	sess *yamux.Session

	seenMu     sync.Mutex
	seen       time.Time
	seenLoaded bool

	capMu sync.Mutex
	caps  map[string][]time.Time
}

func (p *Proxy) clientIP(r *http.Request) string {
	if p.Direct {
		return directIP(r)
	}
	return ClientIP(r)
}

// directIP: o endereço da conexão, sem ler nenhum cabeçalho.
func directIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	if host == "" {
		return "local"
	}
	return host
}

func (p *Proxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !HostOK(r.Host, p.Domain) {
		http.Error(w, "host inválido", http.StatusForbidden)
		return
	}
	if r.URL.Path == LinkPath {
		p.serveLink(w, r)
		return
	}
	p.forward(w, r)
}

func (p *Proxy) serveLink(w http.ResponseWriter, r *http.Request) {
	got := r.Header.Get("X-BethStudio-Secret")
	if !secretOK(got, p.Secret) {
		http.Error(w, "segredo inválido", http.StatusUnauthorized)
		return
	}
	pipe, err := upgradeServer(w, r)
	if err != nil {
		return
	}
	cfg := yamux.DefaultConfig()
	cfg.LogOutput = io.Discard
	tuneLink(cfg)
	sess, err := yamux.Client(pipe, cfg)
	if err != nil {
		_ = pipe.Close()
		return
	}
	p.mu.Lock()
	old := p.sess
	p.sess = sess
	p.mu.Unlock()
	if old != nil {
		_ = old.Close()
	}
	p.watchSeen(sess.CloseChan())
}

func (p *Proxy) session() *yamux.Session {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.sess
}

func (p *Proxy) forward(w http.ResponseWriter, r *http.Request) {
	if loginCapPath(r) && !p.allowLogin(p.clientIP(r)) {
		w.Header().Set("Retry-After", "60")
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = io.WriteString(w, `{"error":"muitas tentativas, espere um minuto"}`)
		return
	}
	sess := p.session()
	if sess == nil || sess.IsClosed() {
		p.serveOffline(w, r)
		return
	}
	stream, err := sess.Open()
	if err != nil {
		p.serveOffline(w, r)
		return
	}
	defer stream.Close()

	out := r.Clone(r.Context())
	out.URL.Scheme = "http"
	out.URL.Host = "studio"
	out.RequestURI = ""
	out.Host = r.Host
	out.Header.Set("X-BethStudio-Client", p.clientIP(r))
	if p.Direct {
		out.Header.Del("X-Forwarded-For")
		out.Header.Del("X-Real-IP")
	}
	if !isWebsocket(r) {
		out.Header.Del("Upgrade")
		out.Header.Del("Connection")
	}
	if err := out.Write(stream); err != nil {
		http.Error(w, "ligação interrompida", http.StatusBadGateway)
		return
	}
	br := bufio.NewReader(stream)
	resp, err := http.ReadResponse(br, out)
	if err != nil {
		http.Error(w, "ligação interrompida", http.StatusBadGateway)
		return
	}
	if resp.StatusCode == http.StatusSwitchingProtocols && isWebsocket(r) {
		splice(w, resp, &readerConn{Reader: br, Conn: stream})
		return
	}
	defer resp.Body.Close()
	copyHeader(w.Header(), resp.Header)
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

// ClientIP: o IP de quem acessa. O bethstudio-proxy escuta só na máquina,
// atrás do proxy HTTPS; quando o pedido vem de lá (loopback ou socket), vale o
// último endereço do X-Forwarded-For, que é o que esse proxy acrescenta (o
// cliente pode mandar os anteriores, não o último). Sem ele, X-Real-IP.
// Pedido direto de outra máquina: o endereço da conexão, sem ler cabeçalho.
func ClientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	local := host == "" || host == "@" || strings.HasPrefix(r.RemoteAddr, "/")
	if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
		local = true
	}
	if !local {
		return host
	}
	if xff := r.Header.Values("X-Forwarded-For"); len(xff) > 0 {
		parts := strings.Split(xff[len(xff)-1], ",")
		if ip := net.ParseIP(strings.TrimSpace(parts[len(parts)-1])); ip != nil {
			return ip.String()
		}
	}
	if ip := net.ParseIP(strings.TrimSpace(r.Header.Get("X-Real-IP"))); ip != nil {
		return ip.String()
	}
	if host == "" {
		return "local"
	}
	return host
}

func isWebsocket(r *http.Request) bool {
	return strings.Contains(strings.ToLower(r.Header.Get("Connection")), "upgrade") &&
		strings.ToLower(r.Header.Get("Upgrade")) == "websocket"
}

func copyHeader(dst, src http.Header) {
	for k, vs := range src {
		if strings.EqualFold(k, "Content-Length") {
			continue
		}
		// cabeçalhos de segurança que o próprio proxy já pôs não duplicam
		if (strings.EqualFold(k, "Strict-Transport-Security") || strings.EqualFold(k, "X-Content-Type-Options")) && dst.Get(k) != "" {
			continue
		}
		for _, v := range vs {
			dst.Add(k, v)
		}
	}
}

func splice(w http.ResponseWriter, resp *http.Response, backend net.Conn) {
	hj, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "hijack indisponível", http.StatusInternalServerError)
		return
	}
	conn, rw, err := hj.Hijack()
	if err != nil {
		return
	}
	defer conn.Close()
	defer backend.Close()
	if _, err := rw.WriteString("HTTP/1.1 " + resp.Status + "\r\n"); err != nil {
		return
	}
	if err := resp.Header.Write(rw); err != nil {
		return
	}
	if _, err := rw.WriteString("\r\n"); err != nil {
		return
	}
	if err := rw.Flush(); err != nil {
		return
	}
	client := &readerConn{Reader: rw.Reader, Conn: conn}
	done := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(backend, client); done <- struct{}{} }()
	go func() { _, _ = io.Copy(client, backend); done <- struct{}{} }()
	<-done
}

type readerConn struct {
	*bufio.Reader
	net.Conn
}

func (c *readerConn) Read(p []byte) (int, error) { return c.Reader.Read(p) }

func dialAddr(u *url.URL) string {
	if u.Port() != "" {
		return u.Host
	}
	port := "80"
	if u.Scheme == "wss" {
		port = "443"
	}
	return net.JoinHostPort(u.Hostname(), port)
}

// Dial liga o Beth Studio no proxy e devolve a sessão que aceita os pedidos do celular.
func Dial(ctx context.Context, endpoint, secret string) (*yamux.Session, error) {
	return DialTLS(ctx, endpoint, secret, nil)
}

// DialTLS é o Dial com configuração TLS própria (testes com certificado autoassinado).
func DialTLS(ctx context.Context, endpoint, secret string, tlsCfg *tls.Config) (*yamux.Session, error) {
	u, err := url.Parse(endpoint)
	if err != nil {
		return nil, err
	}
	switch u.Scheme {
	case "https":
		u.Scheme = "wss"
	case "http":
		u.Scheme = "ws"
	}
	if u.Scheme != "wss" && u.Scheme != "ws" {
		return nil, errors.New("use ws:// ou wss://")
	}
	if u.Path == "" || u.Path == "/" {
		u.Path = LinkPath
	}
	host := u.Host
	addr := dialAddr(u)
	d := &net.Dialer{Timeout: 15 * time.Second}
	var conn net.Conn
	if u.Scheme == "wss" {
		conn, err = (&tls.Dialer{NetDialer: d, Config: tlsCfg}).DialContext(ctx, "tcp", addr)
	} else {
		conn, err = d.DialContext(ctx, "tcp", addr)
	}
	if err != nil {
		return nil, err
	}
	keyRaw := make([]byte, 16)
	if _, err := io.ReadFull(randReader, keyRaw); err != nil {
		_ = conn.Close()
		return nil, err
	}
	key := base64.StdEncoding.EncodeToString(keyRaw)
	req := "GET " + u.RequestURI() + " HTTP/1.1\r\n" +
		"Host: " + host + "\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Key: " + key + "\r\n" +
		"Sec-WebSocket-Version: 13\r\n" +
		"X-BethStudio-Secret: " + secret + "\r\n\r\n"
	br := bufio.NewReader(conn)
	bw := bufio.NewWriter(conn)
	if _, err := bw.WriteString(req); err != nil {
		_ = conn.Close()
		return nil, err
	}
	if err := bw.Flush(); err != nil {
		_ = conn.Close()
		return nil, err
	}
	resp, err := http.ReadResponse(br, &http.Request{Method: http.MethodGet})
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	if resp.StatusCode != http.StatusSwitchingProtocols {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 256))
		_ = resp.Body.Close()
		_ = conn.Close()
		msg := strings.TrimSpace(string(body))
		if msg == "" {
			msg = resp.Status
		}
		return nil, errors.New(msg)
	}
	_ = resp.Body.Close()
	if resp.Header.Get("Sec-WebSocket-Accept") != wsAccept(key) {
		_ = conn.Close()
		return nil, errors.New("handshake websocket recusado")
	}
	pipe := newWSPipe(conn, br, bw, true)
	cfg := yamux.DefaultConfig()
	cfg.LogOutput = io.Discard
	tuneLink(cfg)
	return yamux.Server(pipe, cfg)
}

// Serve aceita cada pedido que o proxy abre e entrega ao handler do celular.
func Serve(sess *yamux.Session, h http.Handler) error {
	for {
		conn, err := sess.Accept()
		if err != nil {
			return err
		}
		go func(c net.Conn) {
			srv := &http.Server{Handler: h, ReadHeaderTimeout: 15 * time.Second}
			_ = srv.Serve(&oneShot{c: c})
		}(conn)
	}
}

type oneShot struct {
	mu   sync.Mutex
	c    net.Conn
	used bool
}

func (l *oneShot) Accept() (net.Conn, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.used {
		return nil, io.EOF
	}
	l.used = true
	return l.c, nil
}

func (l *oneShot) Close() error { return nil }
func (l *oneShot) Addr() net.Addr {
	if l.c == nil {
		return dummyAddr{}
	}
	return l.c.LocalAddr()
}

type dummyAddr struct{}

func (dummyAddr) Network() string { return "yamux" }
func (dummyAddr) String() string  { return "yamux" }

// tuneLink: o padrão do yamux (keepalive de 30 s, escrita de 10 s) deixa a
// sessão morta valendo por quase um minuto, e o celular vê "PC desconectado"
// com o PC ligado. Com 10 s a queda é percebida logo e o PC religa.
func tuneLink(cfg *yamux.Config) {
	cfg.KeepAliveInterval = 10 * time.Second
	cfg.ConnectionWriteTimeout = 10 * time.Second
}
