package phonelink

import (
	"bufio"
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func startProxy(t *testing.T) (*Proxy, string) {
	t.Helper()
	p := &Proxy{Domain: "127.0.0.1", Secret: "0123456789abcdef0123456789abcdef"}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() { _ = http.Serve(ln, p) }()
	return p, "http://" + ln.Addr().String()
}

func TestOfflineAndHost(t *testing.T) {
	_, base := startProxy(t)
	req, _ := http.NewRequest(http.MethodGet, base+"/", nil)
	req.Host = "outro.exemplo.com"
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("host %d", res.StatusCode)
	}

	req, _ = http.NewRequest(http.MethodGet, base+"/", nil)
	req.Host = "127.0.0.1"
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	_ = res.Body.Close()
	if res.StatusCode != http.StatusServiceUnavailable || !strings.Contains(string(body), "desconectado") {
		t.Fatalf("%d %s", res.StatusCode, body)
	}
}

func TestForwardAndReplaceLink(t *testing.T) {
	_, base := startProxy(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	endpoint := "ws://" + strings.TrimPrefix(base, "http://")
	sess, err := Dial(ctx, endpoint, "0123456789abcdef0123456789abcdef")
	if err != nil {
		t.Fatal(err)
	}
	defer sess.Close()
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
		if r.Header.Get("X-BethStudio-Client") == "" {
			http.Error(w, "sem cliente", http.StatusBadRequest)
			return
		}
		_, _ = io.WriteString(w, "ola "+r.URL.Path)
	}))

	wait := time.Now().Add(2 * time.Second)
	var res *http.Response
	for {
		req, _ := http.NewRequest(http.MethodGet, base+"/agente", nil)
		req.Host = "127.0.0.1"
		res, err = http.DefaultClient.Do(req)
		if err == nil && res.StatusCode == http.StatusOK {
			break
		}
		if res != nil {
			_ = res.Body.Close()
		}
		if time.Now().After(wait) {
			t.Fatal(err)
		}
		time.Sleep(20 * time.Millisecond)
	}
	body, _ := io.ReadAll(res.Body)
	_ = res.Body.Close()
	if string(body) != "ola /agente" {
		t.Fatalf("%q", body)
	}

	bad, err := Dial(ctx, endpoint, "segredo-errado-segredo-errado-xx")
	if err == nil {
		_ = bad.Close()
		t.Fatal("segredo errado entrou")
	}
}

func TestWebSocketPasses(t *testing.T) {
	_, base := startProxy(t)
	ctx := context.Background()
	endpoint := "ws://" + strings.TrimPrefix(base, "http://")
	sess, err := Dial(ctx, endpoint, "0123456789abcdef0123456789abcdef")
	if err != nil {
		t.Fatal(err)
	}
	defer sess.Close()
	go Serve(sess, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		pipe, err := upgradeServer(w, r)
		if err != nil {
			return
		}
		defer pipe.Close()
		buf := make([]byte, 32)
		n, err := pipe.Read(buf)
		if err != nil {
			return
		}
		_, _ = pipe.Write(buf[:n])
	}))
	time.Sleep(50 * time.Millisecond)

	conn, err := net.Dial("tcp", strings.TrimPrefix(base, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	bw := bufio.NewWriter(conn)
	br := bufio.NewReader(conn)
	key := "dGhlIHNhbXBsZSBub25jZQ=="
	_, _ = bw.WriteString("GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: " + key + "\r\nSec-WebSocket-Version: 13\r\n\r\n")
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
	buf := make([]byte, 4)
	if _, err := io.ReadFull(pipe, buf); err != nil {
		t.Fatal(err)
	}
	if string(buf) != "ping" {
		t.Fatalf("%q", buf)
	}
}

func TestClientIP(t *testing.T) {
	mk := func(remote string, h map[string]string) *http.Request {
		r := httptest.NewRequest(http.MethodGet, "/", nil)
		r.RemoteAddr = remote
		for k, v := range h {
			r.Header.Set(k, v)
		}
		return r
	}
	cases := []struct {
		remote string
		h      map[string]string
		want   string
	}{
		// atrás do proxy HTTPS da máquina: vale o último do X-Forwarded-For
		{"127.0.0.1:5000", map[string]string{"X-Forwarded-For": "6.6.6.6, 203.0.113.9"}, "203.0.113.9"},
		{"[::1]:5000", map[string]string{"X-Real-IP": "203.0.113.7"}, "203.0.113.7"},
		{"@", map[string]string{"X-Forwarded-For": "198.51.100.2"}, "198.51.100.2"},
		{"127.0.0.1:5000", map[string]string{"X-Forwarded-For": "lixo"}, "127.0.0.1"},
		// direto de outra máquina: cabeçalho não vale
		{"198.51.100.5:4000", map[string]string{"X-Forwarded-For": "1.2.3.4"}, "198.51.100.5"},
	}
	for _, c := range cases {
		if got := ClientIP(mk(c.remote, c.h)); got != c.want {
			t.Fatalf("%s %v: %s, queria %s", c.remote, c.h, got, c.want)
		}
	}
}
