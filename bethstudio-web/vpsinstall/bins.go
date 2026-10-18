package vpsinstall

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
)

// bins/ recebe, no build (build.ps1), bethstudio-proxy-linux-amd64,
// bethstudio-proxy-linux-arm64 e SHA256SUMS. Ficam embutidos no Studio: o
// assistente funciona offline e sem baixar nada sem checksum.
//
//go:embed all:bins
var binsFS embed.FS

// BinSource entrega o binário do proxy para uma arquitetura.
type BinSource interface {
	Get(arch string) (data []byte, sha string, err error)
}

type embeddedBins struct{ fs embed.FS }

// EmbeddedBins lê os binários embutidos e confere cada um com o SHA256SUMS.
func EmbeddedBins() BinSource { return embeddedBins{binsFS} }

var errNoBins = errors.New("este Studio foi compilado sem o programa do servidor (rode build.ps1 de novo para embutir os binários do bethstudio-proxy)")

func (e embeddedBins) Get(arch string) ([]byte, string, error) {
	if arch != "amd64" && arch != "arm64" {
		return nil, "", fmt.Errorf("arquitetura %q sem binário", arch)
	}
	name := "bethstudio-proxy-linux-" + arch
	data, err := e.fs.ReadFile("bins/" + name)
	if err != nil {
		return nil, "", errNoBins
	}
	sums, err := e.fs.ReadFile("bins/SHA256SUMS")
	if err != nil {
		return nil, "", errNoBins
	}
	want := ""
	for _, line := range strings.Split(string(sums), "\n") {
		f := strings.Fields(line)
		if len(f) == 2 && strings.TrimPrefix(f[1], "*") == name {
			want = strings.ToLower(f[0])
		}
	}
	h := sha256.Sum256(data)
	got := hex.EncodeToString(h[:])
	if want == "" || want != got {
		return nil, "", errors.New("o binário embutido do proxy não confere com o SHA256SUMS; recompile o Studio")
	}
	return data, got, nil
}
