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
	"path/filepath"
	"strconv"
	"strings"

	"golang.org/x/sys/windows"
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

// expandHomePath troca "~" e "~/..." pela pasta do usuário. Não mexe em
// mais nada: ".." continua sendo rejeitado por validateLocalPath.
func expandHomePath(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw != "~" && !strings.HasPrefix(raw, "~/") && !strings.HasPrefix(raw, `~\`) {
		return raw
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return raw
	}
	rest := strings.TrimPrefix(raw, "~")
	rest = strings.TrimPrefix(rest, "/")
	rest = strings.TrimPrefix(rest, `\`)
	if rest == "" {
		return home
	}
	return filepath.Join(home, rest)
}

// validateLocalPath: caminho absoluto (unidade do Windows ou UNC/\\wsl$\...),
// sem esquema, sem ".." (antes ou depois de limpar). Devolve o caminho
// limpo, pronto para os.Open. "~" é a pasta do usuário.
func validateLocalPath(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", errors.New("caminho vazio")
	}
	if strings.Contains(raw, "://") {
		return "", errors.New("esquema não é permitido aqui (é um link, não um arquivo local)")
	}
	// Antes de expandir "~": filepath.Join apagaria o ".." e o caminho sairia da pasta.
	if strings.Contains(raw, "..") {
		return "", errors.New("caminho com \"..\" não é permitido")
	}
	raw = expandHomePath(raw)
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

// Extensões que o Windows executa (ou pode executar) ao "abrir". Um clique
// na saída do terminal nunca dispara isso: esses arquivos só aparecem na pasta.
var dangerousFileExt = map[string]struct{}{
	".exe": {}, ".bat": {}, ".cmd": {}, ".com": {}, ".scr": {}, ".pif": {},
	".msi": {}, ".msp": {}, ".msix": {}, ".appx": {}, ".appinstaller": {},
	".ps1": {}, ".psm1": {}, ".psd1": {}, ".psc1": {},
	".vbs": {}, ".vbe": {}, ".js": {}, ".jse": {}, ".wsf": {}, ".wsh": {}, ".ws": {}, ".wsc": {},
	".hta": {}, ".cpl": {}, ".msc": {}, ".lnk": {}, ".scf": {}, ".inf": {}, ".reg": {},
	".url": {}, ".website": {}, ".gadget": {}, ".appref-ms": {},
	".dll": {}, ".sys": {}, ".jar": {},
}

func isDangerousFileExt(path string) bool {
	_, ok := dangerousFileExt[strings.ToLower(filepath.Ext(path))]
	return ok
}

var errNotAFile = errors.New("é uma pasta, não um arquivo")

// openRegularFile abre um arquivo que existe e não é pasta. O caminho já
// passou por validateLocalPath. Devolve o nome que abriu de fato
// (\\wsl.localhost ou \\wsl$).
func openRegularFile(path string) (string, error) {
	if strings.HasPrefix(path, `\\.\`) {
		return "", errors.New("caminho de dispositivo não é permitido")
	}
	f, err := openLocalFile(path)
	if err != nil {
		return "", err
	}
	st, err := f.Stat()
	name := f.Name()
	f.Close()
	if err != nil {
		return "", err
	}
	if st.IsDir() {
		return "", errNotAFile
	}
	return name, nil
}

func writeLocalFileOpError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errNotAFile):
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
	case os.IsNotExist(err):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": friendlyFileError(err)})
	case os.IsPermission(err):
		writeJSON(w, http.StatusForbidden, map[string]string{"error": friendlyFileError(err)})
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
	}
}

// serveOpenLocalFileDefault: POST /api/local-file/open-default — abre o
// arquivo no programa padrão do Windows. Vale para qualquer arquivo que
// exista (o preview continua só com texto e imagem). Programa e script
// (.exe, .bat, .ps1, .lnk e similares) não são executados.
func serveOpenLocalFileDefault(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost || !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		http.Error(w, "use POST application/json", http.StatusBadRequest)
		return
	}
	var req struct {
		Path string `json:"path"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&req) != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "JSON inválido"})
		return
	}
	path, err := validateLocalPath(req.Path)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if isDangerousFileExt(path) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "este arquivo não é aberto por clique (pode ser um programa)"})
		return
	}
	path, err = openRegularFile(path)
	if err != nil {
		writeLocalFileOpError(w, err)
		return
	}
	if err := launchLocalFileDefault(path); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "não foi possível abrir o programa padrão"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"path": path})
}

// ShellExecute abre com a associação do Windows, sem passar por cmd.exe
// (um nome com & ou | não vira outro comando).
var launchLocalFileDefault = func(path string) error {
	verb, err := windows.UTF16PtrFromString("open")
	if err != nil {
		return err
	}
	file, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	return windows.ShellExecute(0, verb, file, nil, nil, windows.SW_SHOWNORMAL)
}
