package main

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"strings"
)

// O instalador é um programa à parte. Daqui ele só é aberto depois de uma
// confirmação explícita, sem argumentos: a caixa "Encerrar tudo" do
// instalador nasce desmarcada, e o Studio não a marca.

var (
	updateLaunch = launchInstaller
	updateReveal = revealInExplorer
)

func launchInstaller(path string) error {
	cmd := exec.Command(path)
	return cmd.Start()
}

func updatesDir() string { return filepath.Join(dataDir(), "updates") }

func applyUIPackage(ctx context.Context) (string, error) {
	updateApplyMu.Lock()
	defer updateApplyMu.Unlock()
	rel, ver, err := newestInstallable(ctx)
	if err != nil {
		return "", err
	}
	zipName := uiAssetName(ver)
	zipAsset := assetNamed(rel, zipName)
	sumsAsset := assetNamed(rel, "SHA256SUMS.txt")
	if zipAsset == nil || sumsAsset == nil {
		return "", updateErr(http.StatusNotFound, "Este release não publica o pacote da interface. Nada foi instalado.")
	}
	if zipAsset.Size > updateUIZipMax {
		return "", updateErr(http.StatusBadRequest, "O pacote da interface é grande demais. Nada foi instalado.")
	}
	want, err := downloadExpectedHash(ctx, sumsAsset.BrowserDownloadURL, zipName)
	if err != nil {
		return "", err
	}
	dest := filepath.Join(updatesDir(), zipName)
	if err := downloadToFile(ctx, zipAsset.BrowserDownloadURL, dest, updateUIZipMax); err != nil {
		return "", err
	}
	defer os.Remove(dest)
	got, err := fileSHA256(dest)
	if err != nil {
		return "", updateErr(http.StatusBadGateway, "Não consegui ler o pacote baixado. Nada foi instalado.")
	}
	if !strings.EqualFold(got, want) {
		return "", updateErr(http.StatusBadRequest, "A soma SHA-256 do arquivo não confere com o SHA256SUMS.txt deste release. Nada foi instalado.")
	}
	staging := filepath.Join(dataDir(), "ui", "staging-"+ver)
	_ = os.RemoveAll(staging)
	if err := extractUIZip(dest, staging); err != nil {
		_ = os.RemoveAll(staging)
		return "", err
	}
	if err := validateUIPackage(staging, ver); err != nil {
		_ = os.RemoveAll(staging)
		return "", err
	}
	if err := swapUICurrent(staging); err != nil {
		return "", err
	}
	return ver, nil
}

func prepareSetupFile(ctx context.Context) (string, string, error) {
	updateApplyMu.Lock()
	defer updateApplyMu.Unlock()
	rel, ver, err := newestInstallable(ctx)
	if err != nil {
		return "", "", err
	}
	name := "BethStudio-Setup-" + ver + ".exe"
	if !safeUpdateName(name) {
		return "", "", updateErr(http.StatusBadRequest, "Nome de arquivo inválido. Nada foi baixado.")
	}
	exeAsset := assetNamed(rel, "BethStudio-Setup.exe")
	sumsAsset := assetNamed(rel, "SHA256SUMS.txt")
	if exeAsset == nil || sumsAsset == nil {
		return "", "", updateErr(http.StatusNotFound, "Este release não publica o instalador. Nada foi baixado.")
	}
	if exeAsset.Size > updateSetupMax {
		return "", "", updateErr(http.StatusBadRequest, "O instalador é grande demais. Nada foi baixado.")
	}
	want, err := downloadExpectedHash(ctx, sumsAsset.BrowserDownloadURL, "BethStudio-Setup.exe")
	if err != nil {
		return "", "", err
	}
	dest := filepath.Join(updatesDir(), name)
	if err := downloadToFile(ctx, exeAsset.BrowserDownloadURL, dest, updateSetupMax); err != nil {
		_ = os.Remove(dest)
		return "", "", err
	}
	got, err := fileSHA256(dest)
	if err != nil || !strings.EqualFold(got, want) {
		_ = os.Remove(dest)
		return "", "", updateErr(http.StatusBadRequest, "A soma SHA-256 do instalador não confere com o SHA256SUMS.txt deste release. Nada foi guardado.")
	}
	meta := setupMeta{Version: ver, SHA256: strings.ToLower(got), Name: name}
	b, err := json.Marshal(meta)
	if err != nil {
		return "", "", err
	}
	if err := os.MkdirAll(updatesDir(), 0o755); err != nil {
		return "", "", updateErr(http.StatusInternalServerError, "Não consegui criar a pasta de atualização.")
	}
	if err := os.WriteFile(setupMetaPath(), b, 0o644); err != nil {
		return "", "", updateErr(http.StatusInternalServerError, "Não consegui registrar o instalador verificado.")
	}
	return dest, ver, nil
}

type setupMeta struct {
	Version string `json:"version"`
	SHA256  string `json:"sha256"`
	Name    string `json:"name"`
}

func setupMetaPath() string { return filepath.Join(updatesDir(), "setup.json") }

func openVerifiedSetup(action string) error {
	b, err := os.ReadFile(setupMetaPath())
	if err != nil {
		return updateErr(http.StatusBadRequest, "Ainda não há instalador verificado. Baixe-o antes de abrir.")
	}
	var m setupMeta
	if json.Unmarshal(stripBOM(b), &m) != nil || !safeUpdateName(m.Name) || len(m.SHA256) != 64 {
		return updateErr(http.StatusBadRequest, "O registro do instalador está inválido. Baixe de novo.")
	}
	path := filepath.Join(updatesDir(), m.Name)
	got, err := fileSHA256(path)
	if err != nil || !strings.EqualFold(got, m.SHA256) {
		return updateErr(http.StatusBadRequest, "O instalador em disco não confere com a soma verificada. Nada foi aberto.")
	}
	switch action {
	case "reveal":
		if updateReveal == nil {
			return updateErr(http.StatusInternalServerError, "Não consegui mostrar a pasta.")
		}
		return updateReveal(path, true)
	case "launch":
		if updateLaunch == nil {
			return updateErr(http.StatusInternalServerError, "Não consegui abrir o instalador.")
		}
		return updateLaunch(path)
	default:
		return updateErr(http.StatusBadRequest, "Ação desconhecida. Nada foi aberto.")
	}
}

func safeUpdateName(name string) bool {
	if name == "" || len(name) > 80 || strings.Contains(name, "..") {
		return false
	}
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '.', r == '-', r == '_':
		default:
			return false
		}
	}
	return true
}

func downloadExpectedHash(ctx context.Context, rawURL, fileName string) (string, error) {
	b, err := downloadBytes(ctx, rawURL, updateSumsMax)
	if err != nil {
		return "", err
	}
	return hashFromSums(string(b), fileName)
}

func hashFromSums(text, name string) (string, error) {
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(strings.TrimRight(line, "\r"))
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		sum := strings.ToLower(fields[0])
		file := strings.TrimPrefix(fields[len(fields)-1], "*")
		file = strings.ReplaceAll(file, "\\", "/")
		if path.Base(file) != name && file != name {
			continue
		}
		if len(sum) == 64 && isHex(sum) {
			return sum, nil
		}
	}
	return "", updateErr(http.StatusBadRequest, "O SHA256SUMS.txt deste release não lista o arquivo. Nada foi instalado.")
}

func isHex(s string) bool {
	for _, r := range s {
		switch {
		case r >= '0' && r <= '9', r >= 'a' && r <= 'f':
		default:
			return false
		}
	}
	return true
}

func downloadBytes(ctx context.Context, rawURL string, max int64) ([]byte, error) {
	resp, err := updateGET(ctx, rawURL)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, updateErr(http.StatusBadGateway, "O GitHub não entregou o arquivo. Nada foi instalado.")
	}
	if resp.ContentLength > max {
		return nil, updateErr(http.StatusBadRequest, "O arquivo do release é grande demais. Nada foi instalado.")
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, max+1))
	if err != nil {
		return nil, wrapNet(err)
	}
	if int64(len(b)) > max {
		return nil, updateErr(http.StatusBadRequest, "O arquivo do release é grande demais. Nada foi instalado.")
	}
	return b, nil
}

func downloadToFile(ctx context.Context, rawURL, dest string, max int64) error {
	resp, err := updateGET(ctx, rawURL)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return updateErr(http.StatusBadGateway, "O GitHub não entregou o arquivo. Nada foi instalado.")
	}
	if resp.ContentLength > max {
		return updateErr(http.StatusBadRequest, "O arquivo do release é grande demais. Nada foi instalado.")
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return updateErr(http.StatusInternalServerError, "Não consegui criar a pasta de atualização.")
	}
	tmp := dest + ".partial"
	f, err := os.Create(tmp)
	if err != nil {
		return updateErr(http.StatusInternalServerError, "Não consegui gravar o download.")
	}
	n, copyErr := io.Copy(f, io.LimitReader(resp.Body, max+1))
	closeErr := f.Close()
	if copyErr != nil || closeErr != nil || n > max {
		_ = os.Remove(tmp)
		if n > max {
			return updateErr(http.StatusBadRequest, "O arquivo do release é grande demais. Nada foi instalado.")
		}
		return updateErr(http.StatusBadGateway, "O download foi interrompido. Nada foi instalado.")
	}
	_ = os.Remove(dest)
	if err := os.Rename(tmp, dest); err != nil {
		_ = os.Remove(tmp)
		return updateErr(http.StatusInternalServerError, "Não consegui guardar o download.")
	}
	return nil
}

func updateGET(ctx context.Context, rawURL string) (*http.Response, error) {
	u, err := url.Parse(rawURL)
	if err != nil || !updateURLAllowed(u) {
		return nil, updateErr(http.StatusBadGateway, "O download apontou para um servidor que não é o do GitHub. Nada foi instalado.")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, wrapNet(err)
	}
	req.Header.Set("User-Agent", updateUA)
	req.Header.Set("Accept", "application/octet-stream")
	resp, err := updateHTTP().Do(req)
	if err != nil {
		return nil, wrapNet(err)
	}
	return resp, nil
}

func fileSHA256(p string) (string, error) {
	f, err := os.Open(p)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func extractUIZip(zipPath, dest string) error {
	r, err := zip.OpenReader(zipPath)
	if err != nil {
		return updateErr(http.StatusBadRequest, "O pacote da interface não é um zip válido. Nada foi instalado.")
	}
	defer r.Close()
	if len(r.File) == 0 || len(r.File) > 4000 {
		return updateErr(http.StatusBadRequest, "O pacote da interface não tem o tamanho esperado. Nada foi instalado.")
	}
	if err := os.MkdirAll(dest, 0o755); err != nil {
		return updateErr(http.StatusInternalServerError, "Não consegui preparar a pasta da interface.")
	}
	var total uint64
	const maxTotal = 128 << 20
	for _, f := range r.File {
		name, err := safeZipPath(f.Name)
		if err != nil {
			return err
		}
		if name == "" {
			continue
		}
		if f.Mode()&os.ModeSymlink != 0 {
			return updateErr(http.StatusBadRequest, "O pacote da interface tem um link. Nada foi instalado.")
		}
		target := filepath.Join(dest, filepath.FromSlash(name))
		if !withinDir(dest, target) {
			return updateErr(http.StatusBadRequest, "O pacote da interface tem um caminho inválido. Nada foi instalado.")
		}
		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return updateErr(http.StatusInternalServerError, "Não consegui extrair a interface.")
			}
			continue
		}
		if f.UncompressedSize64 > uint64(updateUIZipMax) || total+f.UncompressedSize64 > maxTotal {
			return updateErr(http.StatusBadRequest, "O pacote da interface é grande demais. Nada foi instalado.")
		}
		total += f.UncompressedSize64
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return updateErr(http.StatusInternalServerError, "Não consegui extrair a interface.")
		}
		rc, err := f.Open()
		if err != nil {
			return updateErr(http.StatusBadRequest, "Não consegui ler o pacote da interface. Nada foi instalado.")
		}
		out, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
		if err != nil {
			rc.Close()
			return updateErr(http.StatusInternalServerError, "Não consegui extrair a interface.")
		}
		n, copyErr := io.Copy(out, io.LimitReader(rc, updateUIZipMax+1))
		closeErr := out.Close()
		rc.Close()
		if copyErr != nil || closeErr != nil || n > updateUIZipMax {
			return updateErr(http.StatusBadRequest, "Não consegui extrair a interface. Nada foi instalado.")
		}
	}
	return nil
}

func safeZipPath(name string) (string, error) {
	name = strings.ReplaceAll(name, "\\", "/")
	if strings.Contains(name, "\x00") || strings.HasPrefix(name, "/") || strings.Contains(name, ":") {
		return "", updateErr(http.StatusBadRequest, "O pacote da interface tem um caminho inválido. Nada foi instalado.")
	}
	clean := path.Clean(name)
	if clean == "." {
		return "", nil
	}
	if clean == ".." || strings.HasPrefix(clean, "../") {
		return "", updateErr(http.StatusBadRequest, "O pacote da interface tem um caminho inválido. Nada foi instalado.")
	}
	return clean, nil
}

func withinDir(root, target string) bool {
	rel, err := filepath.Rel(filepath.Clean(root), filepath.Clean(target))
	if err != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(os.PathSeparator))
}

func validateUIPackage(dir, version string) error {
	b, err := os.ReadFile(filepath.Join(dir, uiManifestName))
	if err != nil {
		return updateErr(http.StatusBadRequest, "O pacote da interface não tem manifesto. Nada foi instalado.")
	}
	var m uiManifest
	if json.Unmarshal(stripBOM(b), &m) != nil || strings.TrimSpace(m.Version) == "" {
		return updateErr(http.StatusBadRequest, "O manifesto da interface é inválido. Nada foi instalado.")
	}
	if m.Version != version {
		return updateErr(http.StatusBadRequest, "O pacote da interface não é da versão "+version+". Nada foi instalado.")
	}
	if m.RequiresAPI > apiLevel {
		return updateErr(http.StatusConflict, "A interface "+version+" pede um Studio mais novo. Nada foi instalado.")
	}
	st, err := os.Stat(filepath.Join(dir, "index.html"))
	if err != nil || st.IsDir() {
		return updateErr(http.StatusBadRequest, "O pacote não tem index.html. Nada foi instalado.")
	}
	for rel, want := range m.Files {
		rel = path.Clean(strings.ReplaceAll(rel, "\\", "/"))
		if rel == ".." || strings.HasPrefix(rel, "../") || strings.Contains(rel, ":") {
			return updateErr(http.StatusBadRequest, "O manifesto da interface tem um caminho inválido. Nada foi instalado.")
		}
		got, err := fileSHA256(filepath.Join(dir, filepath.FromSlash(rel)))
		if err != nil || !strings.EqualFold(got, strings.TrimSpace(want)) {
			return updateErr(http.StatusBadRequest, "Um arquivo do pacote não confere com o manifesto. Nada foi instalado.")
		}
	}
	return nil
}

func swapUICurrent(staging string) error {
	root := filepath.Join(dataDir(), "ui")
	current := filepath.Join(root, "current")
	previous := filepath.Join(root, "previous")
	if err := os.MkdirAll(root, 0o755); err != nil {
		return updateErr(http.StatusInternalServerError, "Não consegui preparar a pasta da interface.")
	}
	_ = os.RemoveAll(previous)
	if st, err := os.Stat(current); err == nil && st.IsDir() {
		if err := os.Rename(current, previous); err != nil {
			return updateErr(http.StatusInternalServerError, "Não consegui guardar a interface anterior. Nada de novo foi aplicado.")
		}
	}
	if err := os.Rename(staging, current); err != nil {
		_ = os.Rename(previous, current)
		return updateErr(http.StatusInternalServerError, "Não consegui trocar a interface. Nada de novo foi aplicado.")
	}
	invalidateUICache()
	return nil
}
