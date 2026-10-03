package main

// localfile.go — GET /api/local-file: le' um arquivo local (texto ou
// imagem) para o painel flutuante de preview, quando o usuario clica num
// caminho detectado na saida de um terminal. So' abre DENTRO do app (nunca
// no editor padrao do Windows) — ver frontend/src/lib/localFile.ts para a
// deteccao/resolucao do caminho.
//
// Validacao (nenhuma delas depende do cliente dizer a verdade):
//   - extensao tem que estar na lista permitida (por categoria: texto ou
//     imagem);
//   - caminho tem que ser absoluto (unidade do Windows "C:\..." ou UNC
//     "\\servidor\compartilhamento\..." — inclui "\\wsl$\<distro>\...");
//   - sem esquema (nunca "file://", "http://" etc. — isso e' link externo,
//     weblinks.go trata);
//   - sem ".." em nenhum ponto (antes ou depois de limpar o caminho), e o
//     caminho limpo continua absoluto — protege contra path traversal;
//   - limite de tamanho por categoria (texto: mostra so' o inicio acima
//     disso; imagem: recusa).
//
// Erros de leitura (arquivo sumiu, sem permissao) viram uma mensagem
// amigavel na resposta, nunca um pane em branco ou o processo travando.

import (
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

// textFileExt / imageFileExt: extensoes permitidas (minusculas, com ponto).
var textFileExt = map[string]string{
	".md":       "text/markdown; charset=utf-8",
	".markdown": "text/markdown; charset=utf-8",
	".txt":      "text/plain; charset=utf-8",
	".log":      "text/plain; charset=utf-8",
}

var imageFileExt = map[string]string{
	".png":  "image/png",
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".gif":  "image/gif",
	".webp": "image/webp",
	".bmp":  "image/bmp",
	".svg":  "image/svg+xml",
}

const (
	localTextPreviewMax = 2 << 20  // 2 MiB mostrados inteiros; acima disso, so' o inicio
	localImageMax       = 25 << 20 // 25 MiB
)

// validateLocalPath: caminho absoluto (unidade do Windows ou UNC/\\wsl$\...),
// sem esquema, sem ".." (antes ou depois de limpar). Devolve o caminho
// limpo, pronto para os.Open.
func validateLocalPath(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", errors.New("caminho vazio")
	}
	if strings.Contains(raw, "://") {
		return "", errors.New("esquema não é permitido aqui (é um link, não um arquivo local)")
	}
	if strings.Contains(raw, "..") {
		return "", errors.New("caminho com \"..\" não é permitido")
	}
	clean := filepath.Clean(raw)
	if strings.Contains(clean, "..") {
		return "", errors.New("caminho inválido")
	}
	isUNC := strings.HasPrefix(clean, `\\`)
	if !isUNC && !filepath.IsAbs(clean) {
		return "", errors.New("caminho relativo não é permitido")
	}
	return clean, nil
}

// localFileCategory: "text" | "image" | "" (extensao nao permitida).
func localFileCategory(path string) (mime, category string) {
	ext := strings.ToLower(filepath.Ext(path))
	if m, ok := textFileExt[ext]; ok {
		return m, "text"
	}
	if m, ok := imageFileExt[ext]; ok {
		return m, "image"
	}
	return "", ""
}

// openLocalFile: os.Open, com a alternativa do WSL — "\\wsl.localhost\X\..."
// (Windows 11 / WSL novo) e "\\wsl$\X\..." (nome antigo) apontam para o
// mesmo lugar; se um nao existir nesta maquina, tenta o outro.
func openLocalFile(path string) (*os.File, error) {
	f, err := os.Open(path)
	if err == nil {
		return f, nil
	}
	if alt := wslUNCAlternative(path); alt != "" {
		if f2, err2 := os.Open(alt); err2 == nil {
			return f2, nil
		}
	}
	return nil, err
}

func wslUNCAlternative(path string) string {
	low := strings.ToLower(path)
	switch {
	case strings.HasPrefix(low, `\\wsl.localhost\`):
		return `\\wsl$\` + path[len(`\\wsl.localhost\`):]
	case strings.HasPrefix(low, `\\wsl$\`):
		return `\\wsl.localhost\` + path[len(`\\wsl$\`):]
	}
	return ""
}

// friendlyFileError:mensagem amigavel para os erros mais comuns de os.Open/Stat.
func friendlyFileError(err error) string {
	switch {
	case os.IsNotExist(err):
		return "o arquivo não existe (ou já foi movido/apagado)"
	case os.IsPermission(err):
		return "sem permissão para ler este arquivo"
	default:
		return "não foi possível abrir o arquivo"
	}
}

// mimeAttachment: Content-Disposition com o nome em UTF-8 (RFC 6266).
func mimeAttachment(name string) string {
	ascii := strings.Map(func(r rune) rune {
		if r < 0x20 || r > 0x7e || r == '"' || r == '\\' {
			return '_'
		}
		return r
	}, name)
	return mime.FormatMediaType("attachment", map[string]string{"filename": ascii}) + "; filename*=UTF-8''" + url.PathEscape(name)
}

func serveLocalFile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "método não permitido", http.StatusMethodNotAllowed)
		return
	}
	path, err := validateLocalPath(r.URL.Query().Get("path"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	mime, category := localFileCategory(path)
	if category == "" {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "tipo de arquivo não suportado no preview"})
		return
	}
	f, err := openLocalFile(path)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": friendlyFileError(err)})
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": friendlyFileError(err)})
		return
	}
	if st.IsDir() {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "é uma pasta, não um arquivo"})
		return
	}
	// download=1: o arquivo inteiro como anexo (Studio remoto: "Salvar uma
	// cópia" vira download no navegador). Mesma validação de caminho e tipo.
	if r.URL.Query().Get("download") == "1" {
		h := w.Header()
		h.Set("Content-Type", mime)
		h.Set("Cache-Control", "no-store")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Content-Disposition", mimeAttachment(filepath.Base(path)))
		h.Set("Content-Length", strconv.FormatInt(st.Size(), 10))
		_, _ = io.Copy(w, f)
		return
	}
	max := int64(localTextPreviewMax)
	if category == "image" {
		max = localImageMax
		if st.Size() > max {
			writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "imagem grande demais para o preview (mais de 25 MB)"})
			return
		}
	}
	h := w.Header()
	h.Set("Content-Type", mime)
	h.Set("Cache-Control", "no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("X-File-Size", strconv.FormatInt(st.Size(), 10))
	h.Set("X-File-Mtime", fileMtime(st)) // o editor do painel devolve no salvar (conflito)
	if category == "text" && st.Size() > max {
		h.Set("X-Truncated", "1")
		_, _ = io.CopyN(w, f, max)
		return
	}
	_, _ = io.Copy(w, f)
}

// serveOpenLocalFileDefault: POST /api/local-file/open-default — abre o
// arquivo no editor padrao do Windows (cmd /c start "" <caminho>). So'
// dispara com um clique explicito do usuario no painel de preview (botao
// "Abrir com o editor padrão"), nunca automaticamente. Mesma validacao de
// caminho/extensao do preview — nao abre nada fora da lista permitida.
func serveOpenLocalFileDefault(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost || !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		http.Error(w, "use POST application/json", http.StatusBadRequest)
		return
	}
	var req struct {
		Path string `json:"path"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req) != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "JSON inválido"})
		return
	}
	path, err := validateLocalPath(req.Path)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if _, category := localFileCategory(path); category == "" {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "tipo de arquivo não suportado"})
		return
	}
	f, err := openLocalFile(path)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": friendlyFileError(err)})
		return
	}
	path = f.Name() // o caminho que abriu de fato (\\wsl.localhost ou \\wsl$)
	f.Close()
	if err := launchLocalFileDefault(path); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "não foi possível abrir o editor padrão"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"path": path})
}

var launchLocalFileDefault = func(path string) error {
	cmd := exec.Command("cmd", "/c", "start", "", path)
	hideChildWindow(&cmd.SysProcAttr)
	return cmd.Start()
}
