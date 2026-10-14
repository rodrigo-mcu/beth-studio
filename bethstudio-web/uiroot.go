package main

import (
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"bethstudio-web/webui"
)

// apiLevel é o contrato entre este exe (Go) e a interface (React). Uma
// interface de override só é usada se o manifesto dela pedir um nível <= este.
// Suba o número quando uma mudança na API ou no WebSocket quebrar UIs antigas
// OU quando a UI passar a depender de algo novo daqui.
const apiLevel = 1

// uiManifestName fica na raiz de <dados>\ui\current\ e descreve o pacote.
const uiManifestName = "ui.json"

// uiManifest: o que o deploy grava ao lado dos arquivos da interface.
type uiManifest struct {
	Version     string            `json:"version"`
	RequiresAPI int               `json:"requires_api"`
	Files       map[string]string `json:"files,omitempty"`
}

// uiSource é de onde a interface está sendo servida agora.
type uiSource struct {
	FS       fs.FS  // raiz: index.html, assets/, phone/
	Version  string // "embutida" ou a versão do pacote de override
	Override bool
	Reason   string // por que o override foi ignorado ("" se não havia / foi usado)
}

var (
	uiMu       sync.Mutex
	uiCache    uiSource
	uiCacheKey string
	uiCacheAt  time.Time
)

func embeddedUI() fs.FS {
	sub, err := fs.Sub(webui.Dist, "dist")
	if err != nil {
		panic(err)
	}
	return sub
}

// uiOverrideDir é onde o deploy da interface instala o pacote ativo.
func uiOverrideDir() string { return filepath.Join(dataDir(), "ui", "current") }

// currentUI escolhe a interface a servir: o pacote em <dados>\ui\current se
// ele for válido e compatível; senão a embutida. É chamada a cada requisição
// (barata: um stat do manifesto), então aplicar uma atualização não exige
// reiniciar o Studio — basta recarregar a página.
func currentUI() uiSource {
	dir := uiOverrideDir()
	mpath := filepath.Join(dir, uiManifestName)
	st, err := os.Stat(mpath)
	if err != nil {
		return uiSource{FS: embeddedUI(), Version: "embutida"}
	}
	key := dir + "|" + st.ModTime().String() + "|" + strconv.FormatInt(st.Size(), 10)

	uiMu.Lock()
	defer uiMu.Unlock()
	// o manifesto não mudou há pouco: reaproveita (index.html pode sumir, então
	// revalida a cada 2 s no máximo)
	if key == uiCacheKey && time.Since(uiCacheAt) < 2*time.Second && uiCache.FS != nil {
		return uiCache
	}
	src := loadOverride(dir, mpath)
	uiCache, uiCacheKey, uiCacheAt = src, key, time.Now()
	return src
}

func loadOverride(dir, mpath string) uiSource {
	fallback := func(reason string) uiSource {
		return uiSource{FS: embeddedUI(), Version: "embutida", Reason: reason}
	}
	b, err := os.ReadFile(mpath)
	if err != nil {
		return fallback("manifesto ilegível")
	}
	var m uiManifest
	if err := json.Unmarshal(stripBOM(b), &m); err != nil || strings.TrimSpace(m.Version) == "" {
		return fallback("manifesto inválido")
	}
	if m.RequiresAPI > apiLevel {
		return fallback("a interface " + m.Version + " pede um Studio mais novo")
	}
	if st, err := os.Stat(filepath.Join(dir, "index.html")); err != nil || st.IsDir() {
		return fallback("index.html ausente no pacote")
	}
	return uiSource{FS: os.DirFS(dir), Version: m.Version, Override: true}
}

// invalidateUICache faz a próxima leitura de currentUI olhar o disco de novo.
func invalidateUICache() {
	uiMu.Lock()
	uiCache = uiSource{}
	uiCacheKey = ""
	uiCacheAt = time.Time{}
	uiMu.Unlock()
}
