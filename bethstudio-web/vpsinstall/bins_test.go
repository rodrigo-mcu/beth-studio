package vpsinstall

import (
	"strings"
	"testing"
)

func TestEmbeddedBinsConferemComSHA256SUMS(t *testing.T) {
	for _, arch := range []string{"amd64", "arm64"} {
		data, sha, err := EmbeddedBins().Get(arch)
		if err != nil {
			if strings.Contains(err.Error(), "compilado sem") {
				t.Skip("binários não embutidos nesta árvore (rode build.ps1)")
			}
			t.Fatal(err)
		}
		if len(sha) != 64 || len(data) < 1<<20 {
			t.Fatalf("%s: sha=%s tamanho=%d", arch, sha, len(data))
		}
		// ELF
		if string(data[:4]) != "\x7fELF" {
			t.Fatalf("%s: não é ELF", arch)
		}
	}
	if _, _, err := EmbeddedBins().Get("riscv"); err == nil {
		t.Fatal("arquitetura desconhecida")
	}
}

func TestStoreHostKeysEEstado(t *testing.T) {
	st := &Store{Dir: t.TempDir()}
	if st.KnownFingerprint("h", 22) != "" {
		t.Fatal("começa vazio")
	}
	if err := st.Remember("h", 22, "SHA256:a"); err != nil {
		t.Fatal(err)
	}
	if st.KnownFingerprint("h", 22) != "SHA256:a" || st.KnownFingerprint("h", 2222) != "" {
		t.Fatal("chave é host:porta")
	}
	if sv, err := st.Load(); sv != nil || err != nil {
		t.Fatal("sem estado ainda")
	}
	if err := st.Save(Server{Host: "h", Domain: "d.exemplo.com"}); err != nil {
		t.Fatal(err)
	}
	if sv, _ := st.Load(); sv == nil || sv.Domain != "d.exemplo.com" {
		t.Fatal("Load")
	}
	if err := st.Clear(); err != nil {
		t.Fatal(err)
	}
	if sv, _ := st.Load(); sv != nil {
		t.Fatal("Clear")
	}
}
