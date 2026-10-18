package phonelink

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

const testSecret = "0123456789abcdef0123456789abcdef"

type tclock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *tclock) now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *tclock) add(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

func get(p *Proxy, path string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodGet, path, nil)
	r.Host = "127.0.0.1"
	rec := httptest.NewRecorder()
	p.ServeHTTP(rec, r)
	return rec
}

func TestOfflineNeverSeen(t *testing.T) {
	p := &Proxy{Domain: "127.0.0.1", Secret: testSecret, DataDir: t.TempDir()}
	rec := get(p, "/")
	if rec.Code != http.StatusServiceUnavailable || !strings.Contains(rec.Body.String(), "desconectado") {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	if strings.Contains(rec.Body.String(), "Visto pela última vez") {
		t.Fatal("inventou uma hora")
	}
	rec = get(p, "/api/phone/me")
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if rec.Code != 503 || out["offline"] != true || out["last_seen"] != nil {
		t.Fatalf("%d %v", rec.Code, out)
	}
}

func TestLastSeenAfterSessionDrops(t *testing.T) {
	dir := t.TempDir()
	clk := &tclock{t: time.Date(2026, 10, 18, 14, 32, 10, 0, time.UTC)}
	p, base := startProxyWith(t, &Proxy{Domain: "127.0.0.1", Secret: testSecret, DataDir: dir, Now: clk.now})
	sess, err := Dial(context.Background(), "ws://"+strings.TrimPrefix(base, "http://"), testSecret)
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return !p.LastSeen().IsZero() })
	clk.add(7 * time.Minute) // o PC cai 7 min depois
	_ = sess.Close()
	want := clk.now().UTC().Truncate(time.Second)
	waitFor(t, func() bool { return p.LastSeen().Equal(want) && p.session() != nil && p.session().IsClosed() })

	// página pública: só a hora
	rec := get(p, "/")
	body := rec.Body.String()
	if rec.Code != 503 || !strings.Contains(body, `datetime="2026-10-18T14:39:10Z"`) || !strings.Contains(body, "Visto pela última vez às") || !strings.Contains(body, `http-equiv="refresh"`) {
		t.Fatalf("%d %s", rec.Code, body)
	}
	if strings.Contains(body, testSecret) || strings.Contains(strings.ToLower(body), "cookie") {
		t.Fatal("vazou algo além da hora")
	}
	rec = get(p, "/api/phone/me")
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out["last_seen"] != "2026-10-18T14:39:10Z" || rec.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("%v", out)
	}
	// persistido: um proxy novo (reinício) lembra
	b, err := os.ReadFile(filepath.Join(dir, seenFile))
	if err != nil || strings.TrimSpace(string(b)) != "2026-10-18T14:39:10Z" {
		t.Fatalf("arquivo: %q %v", b, err)
	}
	p2 := &Proxy{Domain: "127.0.0.1", Secret: testSecret, DataDir: dir}
	if !p2.LastSeen().Equal(want) {
		t.Fatalf("depois do reinício: %v", p2.LastSeen())
	}
	if !strings.Contains(get(p2, "/").Body.String(), "2026-10-18T14:39:10Z") {
		t.Fatal("página offline sem a hora depois do reinício")
	}
}

func TestSeenIgnoresGarbageFile(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, seenFile), []byte("lixo"), 0o644)
	p := &Proxy{DataDir: dir}
	if !p.LastSeen().IsZero() {
		t.Fatal("aceitou lixo")
	}
}

// O cliente não escolhe o IP que o Studio usa para travar tentativas.
func TestClientHeaderIsOverwritten(t *testing.T) {
	_, base := startProxyWith(t, &Proxy{Domain: "127.0.0.1", Secret: testSecret})
	sess, err := Dial(context.Background(), "ws://"+strings.TrimPrefix(base, "http://"), testSecret)
	if err != nil {
		t.Fatal(err)
	}
	defer sess.Close()
	got := make(chan string, 1)
	go Serve(sess, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got <- r.Header.Get("X-BethStudio-Client")
		_, _ = io.WriteString(w, "ok")
	}))
	req, _ := http.NewRequest(http.MethodGet, base+"/x", nil)
	req.Host = "127.0.0.1"
	req.Header.Set("X-BethStudio-Client", "6.6.6.6")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	// o cabeçalho do cliente nunca vale: sem XFF do proxy HTTPS, é o endereço da conexão
	if ip := <-got; ip != "127.0.0.1" {
		t.Fatalf("IP forjado passou: %q", ip)
	}
}

func TestLoginCapPerIP(t *testing.T) {
	clk := &tclock{t: time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC)}
	p := &Proxy{Domain: "127.0.0.1", Secret: testSecret, Now: clk.now}
	post := func(ip string) int {
		r := httptest.NewRequest(http.MethodPost, "/api/phone/login", strings.NewReader(`{}`))
		r.Host = "127.0.0.1"
		r.RemoteAddr = "127.0.0.1:1"
		r.Header.Set("X-Forwarded-For", ip)
		rec := httptest.NewRecorder()
		p.ServeHTTP(rec, r)
		return rec.Code
	}
	for i := 0; i < loginCapPerMin; i++ {
		if c := post("203.0.113.1"); c != http.StatusServiceUnavailable { // PC offline: chegou até aqui
			t.Fatalf("tentativa %d: %d", i, c)
		}
	}
	if c := post("203.0.113.1"); c != http.StatusTooManyRequests {
		t.Fatalf("devia limitar: %d", c)
	}
	if c := post("203.0.113.2"); c != http.StatusServiceUnavailable {
		t.Fatalf("outro IP não pode ser afetado: %d", c)
	}
	clk.add(61 * time.Second)
	if c := post("203.0.113.1"); c != http.StatusServiceUnavailable {
		t.Fatalf("devia liberar: %d", c)
	}
}

func TestOfflineHTMLOnlyTime(t *testing.T) {
	h := OfflineHTML(time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC))
	for _, want := range []string{"03:04 UTC de 02/01", `datetime="2026-01-02T03:04:05Z"`} {
		if !strings.Contains(h, want) {
			t.Fatalf("falta %q em %s", want, h)
		}
	}
}

func startProxyWith(t *testing.T, p *Proxy) (*Proxy, string) {
	t.Helper()
	srv := httptest.NewServer(p)
	t.Cleanup(srv.Close)
	return p, srv.URL
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	end := time.Now().Add(3 * time.Second)
	for !cond() {
		if time.Now().After(end) {
			t.Fatal("tempo esgotado")
		}
		time.Sleep(10 * time.Millisecond)
	}
}
