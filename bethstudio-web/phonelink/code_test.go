package phonelink

import (
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestDialAddrAddsTLSPort(t *testing.T) {
	u, err := url.Parse("wss://agentes.exemplo.com/bethstudio-link")
	if err != nil {
		t.Fatal(err)
	}
	if got := dialAddr(u); got != "agentes.exemplo.com:443" {
		t.Fatal(got)
	}
	u, err = url.Parse("ws://127.0.0.1:8787/bethstudio-link")
	if err != nil {
		t.Fatal(err)
	}
	if got := dialAddr(u); got != "127.0.0.1:8787" {
		t.Fatal(got)
	}
}

func TestParseListen(t *testing.T) {
	netw, addr, err := ParseListen("127.0.0.1:8787")
	if err != nil || netw != "tcp" || addr != "127.0.0.1:8787" {
		t.Fatalf("%s %s %v", netw, addr, err)
	}
	netw, addr, err = ParseListen("unix:/tmp/beth.sock")
	if err != nil || netw != "unix" || addr != "/tmp/beth.sock" {
		t.Fatalf("unix: %s %s %v", netw, addr, err)
	}
	netw, addr, err = ParseListen("unix:///tmp/beth.sock")
	if err != nil || netw != "unix" || addr != "/tmp/beth.sock" {
		t.Fatalf("unix uri: %s %s %v", netw, addr, err)
	}
	if _, _, err := ParseListen("sem-porta"); err == nil {
		t.Fatal("esperava erro")
	}
}

func TestCodeRoundTrip(t *testing.T) {
	raw := FormatCode("agentes.exemplo.com", "0123456789abcdef0123456789abcdef")
	c, err := ParseCode(raw)
	if err != nil {
		t.Fatal(err)
	}
	if c.Domain != "agentes.exemplo.com" || c.Secret != "0123456789abcdef0123456789abcdef" {
		t.Fatalf("%+v", c)
	}
	if _, err := ParseCode("https://agentes.exemplo.com"); err == nil {
		t.Fatal("esperava erro")
	}
}

func TestHostOK(t *testing.T) {
	if !HostOK("Agentes.Exemplo.com:443", "agentes.exemplo.com") {
		t.Fatal("porta e caixa")
	}
	if HostOK("outro.exemplo.com", "agentes.exemplo.com") {
		t.Fatal("outro domínio")
	}
}

func TestLoadOrCreateSecret(t *testing.T) {
	dir := t.TempDir()
	a, err := LoadOrCreateSecret(dir)
	if err != nil || len(a) != 64 {
		t.Fatal(err, a)
	}
	b, err := LoadOrCreateSecret(dir)
	if err != nil || a != b {
		t.Fatal(err, b)
	}
	st, err := os.Stat(filepath.Join(dir, "link-secret"))
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && st.Mode().Perm()&0o077 != 0 {
		t.Fatalf("permissão %o", st.Mode().Perm())
	}
}
