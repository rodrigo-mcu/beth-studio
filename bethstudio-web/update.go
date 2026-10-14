package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Atualização a partir dos releases publicados do repositório oficial.
// A interface é trocada no disco, sem reiniciar nada. O Studio e o host
// não são instalados daqui: o botão só baixa o BethStudio-Setup.exe, confere
// a soma e o abre se a pessoa confirmar de novo. O instalador não recebe
// argumentos, então a opção "Encerrar tudo" continua desmarcada — marcá-la
// é o único jeito de o instalador parar o host, e isso fica com a pessoa.

const (
	updateOwner    = "rodrigo-mcu"
	updateRepo     = "beth-studio"
	updateCacheTTL = 5 * time.Minute
	updateUA       = "BethStudio"
)

var (
	// updateTestBase só é preenchida por testes (http://127.0.0.1:<porta>).
	// A cópia que a pessoa usa ignora qualquer variável de ambiente.
	updateTestBase string

	updateUIZipMax int64 = 64 << 20
	updateSetupMax int64 = 256 << 20
	updateSumsMax  int64 = 256 << 10
	updateAPIMax   int64 = 2 << 20

	updateCacheMu        sync.Mutex
	updateCachedReleases []ghRelease
	updateCachedAt       time.Time
	updateETag           string

	updateApplyMu sync.Mutex

	errRedirect = errors.New("redirecionamento recusado")
)

type updateFailure struct {
	status int
	msg    string
}

func (e *updateFailure) Error() string { return e.msg }

func updateErr(status int, msg string) error { return &updateFailure{status: status, msg: msg} }

func writeUpdateErr(w http.ResponseWriter, err error) {
	var ue *updateFailure
	if errors.As(err, &ue) {
		writeJSON(w, ue.status, map[string]string{"error": ue.msg})
		return
	}
	writeJSON(w, http.StatusBadGateway, map[string]string{"error": "Não foi possível concluir a atualização."})
}

type ghRelease struct {
	TagName    string    `json:"tag_name"`
	Draft      bool      `json:"draft"`
	Prerelease bool      `json:"prerelease"`
	Assets     []ghAsset `json:"assets"`
}

type ghAsset struct {
	Name               string `json:"name"`
	BrowserDownloadURL string `json:"browser_download_url"`
	Size               int64  `json:"size"`
}

type updateView struct {
	Current        string `json:"current"`
	Latest         string `json:"latest,omitempty"`
	Update         bool   `json:"update"`
	CanInstall     bool   `json:"can_install"`
	UIAvailable    bool   `json:"ui_available"`
	UIAlready      bool   `json:"ui_already"`
	SetupAvailable bool   `json:"setup_available"`
	Message        string `json:"message"`
	HTMLURL        string `json:"html_url,omitempty"`
	APILevel       int    `json:"api_level"`
}

func setUpdateTestBase(raw string) error {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Scheme != "http" || !strings.EqualFold(u.Hostname(), "127.0.0.1") || u.Port() == "" || u.User != nil || u.Path != "" && u.Path != "/" {
		return errors.New("base de teste tem de ser http://127.0.0.1:<porta>")
	}
	updateTestBase = "http://127.0.0.1:" + u.Port()
	return nil
}

func updateAPIRoot() string {
	if updateTestBase != "" {
		return updateTestBase
	}
	return "https://api.github.com"
}

func updateURLAllowed(u *url.URL) bool {
	if u == nil || u.User != nil || u.Host == "" {
		return false
	}
	host := strings.ToLower(u.Hostname())
	if updateTestBase != "" {
		base, err := url.Parse(updateTestBase)
		if err != nil {
			return false
		}
		return u.Scheme == "http" && host == "127.0.0.1" && u.Port() == base.Port()
	}
	if u.Scheme != "https" {
		return false
	}
	if p := u.Port(); p != "" && p != "443" {
		return false
	}
	switch host {
	case "api.github.com", "github.com", "objects.githubusercontent.com",
		"release-assets.githubusercontent.com", "github-releases.githubusercontent.com":
		return true
	default:
		return false
	}
}

func clearUpdateCache() {
	updateCacheMu.Lock()
	updateCachedReleases = nil
	updateCachedAt = time.Time{}
	updateETag = ""
	updateCacheMu.Unlock()
	_ = os.Remove(updateCachePath())
}

func updateCachePath() string {
	return filepath.Join(dataDir(), "ui", "release-check.json")
}

func updateHTTP() *http.Client {
	var tr *http.Transport
	if base, ok := http.DefaultTransport.(*http.Transport); ok {
		tr = base.Clone()
	} else {
		tr = &http.Transport{}
	}
	// No teste o servidor é local: um proxy do ambiente não pode desviar o pedido.
	if updateTestBase != "" {
		tr.Proxy = nil
	}
	return &http.Client{
		Timeout:   3 * time.Minute,
		Transport: tr,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 5 || !updateURLAllowed(req.URL) {
				return errRedirect
			}
			return nil
		},
	}
}

func (s *server) installBlocked(remoteKey string) string {
	if remoteKey != "" {
		return "A instalação só pode ser feita no Studio deste computador."
	}
	if s.hub != nil && s.hub.readOnly {
		return "Neste modo só é possível verificar se há versão nova."
	}
	return ""
}

func (s *server) serveUpdateCheck(w http.ResponseWriter, r *http.Request, remoteKey string) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "use GET", http.StatusMethodNotAllowed)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
	defer cancel()
	view, err := buildUpdateView(ctx, s.installBlocked(remoteKey) == "")
	if err != nil {
		writeUpdateErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, view)
}

func (s *server) serveUpdateApplyUI(w http.ResponseWriter, r *http.Request, remoteKey string) {
	if msg := s.beginInstall(w, r, remoteKey); msg != "" {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Minute)
	defer cancel()
	version, err := applyUIPackage(ctx)
	if err != nil {
		writeUpdateErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"version": version,
		"message": "Interface " + version + " instalada. Recarregue a interface para vê-la. O Studio e o host não foram reiniciados.",
	})
}

func (s *server) serveUpdatePrepareSetup(w http.ResponseWriter, r *http.Request, remoteKey string) {
	if msg := s.beginInstall(w, r, remoteKey); msg != "" {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Minute)
	defer cancel()
	path, version, err := prepareSetupFile(ctx)
	if err != nil {
		writeUpdateErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"path":    path,
		"version": version,
		"message": "Instalador " + version + " verificado. Abrir o instalador não encerra nada sozinho. A opção Encerrar tudo vem desmarcada; se você marcá-la, o host encerra e os terminais abertos serão perdidos.",
	})
}

func (s *server) serveUpdateOpenSetup(w http.ResponseWriter, r *http.Request, remoteKey string) {
	if r.Method != http.MethodPost {
		http.Error(w, "use POST", http.StatusMethodNotAllowed)
		return
	}
	if msg := s.installBlocked(remoteKey); msg != "" {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": msg})
		return
	}
	confirm, action, err := readUpdateBody(w, r)
	if err != nil {
		writeUpdateErr(w, err)
		return
	}
	if !confirm {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Confirme para continuar. Nada foi aberto."})
		return
	}
	if err := openVerifiedSetup(action); err != nil {
		writeUpdateErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// beginInstall recusa leitura, remoto e POST sem confirm. Devolve mensagem
// quando a resposta já foi escrita.
func (s *server) beginInstall(w http.ResponseWriter, r *http.Request, remoteKey string) string {
	if r.Method != http.MethodPost {
		http.Error(w, "use POST", http.StatusMethodNotAllowed)
		return "método"
	}
	if msg := s.installBlocked(remoteKey); msg != "" {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": msg})
		return msg
	}
	confirm, _, err := readUpdateBody(w, r)
	if err != nil {
		writeUpdateErr(w, err)
		return "json"
	}
	if !confirm {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Confirme para continuar. Nada foi baixado."})
		return "confirm"
	}
	return ""
}

func readUpdateBody(w http.ResponseWriter, r *http.Request) (bool, string, error) {
	var req struct {
		Confirm bool   `json:"confirm"`
		Action  string `json:"action"`
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10))
	if err := dec.Decode(&req); err != nil {
		return false, "", updateErr(http.StatusBadRequest, "JSON inválido")
	}
	return req.Confirm, req.Action, nil
}

func buildUpdateView(ctx context.Context, canInstall bool) (updateView, error) {
	list, err := fetchReleases(ctx)
	if err != nil {
		return updateView{}, err
	}
	view := updateView{Current: appVersion, CanInstall: canInstall, APILevel: apiLevel}
	rel, ver, ok := pickStable(list)
	if !ok {
		view.Message = "Não há release publicado."
		return view, nil
	}
	view.Latest = ver
	view.HTMLURL = releasePage(ver)
	view.UIAvailable = assetNamed(rel, uiAssetName(ver)) != nil
	view.SetupAvailable = assetNamed(rel, "BethStudio-Setup.exe") != nil
	if ui := currentUI(); ui.Override {
		if cmp, err := compareSemver(ui.Version, ver); err == nil && cmp == 0 {
			view.UIAlready = true
		}
	}
	if !releaseIsNewer(ver, appVersion) {
		view.Message = "Não há versão mais nova. Esta cópia é " + shownVersion(appVersion) + " e o último release publicado é " + ver + "."
		return view, nil
	}
	view.Update = true
	if canInstall {
		view.Message = "Há a versão " + ver + ", mais nova que " + shownVersion(appVersion) + ". Escolha o que instalar. Nada é instalado sem a sua confirmação."
	} else {
		view.Message = "Há a versão " + ver + ", mais nova que " + shownVersion(appVersion) + ". A instalação só pode ser feita no Studio deste computador."
	}
	return view, nil
}

func shownVersion(v string) string {
	if strings.TrimSpace(v) == "" {
		return "desconhecida"
	}
	return v
}

func releasePage(version string) string {
	if _, err := parseSemver(version); err != nil {
		return ""
	}
	return "https://github.com/" + updateOwner + "/" + updateRepo + "/releases/tag/v" + version
}

func uiAssetName(version string) string {
	return "BethStudio-ui-" + version + ".zip"
}

func pickStable(list []ghRelease) (ghRelease, string, bool) {
	var best ghRelease
	var bestV semver
	found := false
	for _, rel := range list {
		if rel.Draft || rel.Prerelease {
			continue
		}
		v, err := parseSemver(rel.TagName)
		if err != nil {
			continue
		}
		if !found || v.cmp(bestV) > 0 {
			best, bestV, found = rel, v, true
		}
	}
	if !found {
		return ghRelease{}, "", false
	}
	ver := strings.TrimPrefix(strings.TrimSpace(best.TagName), "v")
	return best, ver, true
}

func assetNamed(rel ghRelease, name string) *ghAsset {
	for i := range rel.Assets {
		if rel.Assets[i].Name == name && strings.TrimSpace(rel.Assets[i].BrowserDownloadURL) != "" {
			return &rel.Assets[i]
		}
	}
	return nil
}

func fetchReleases(ctx context.Context) ([]ghRelease, error) {
	rels, etag, fresh := snapshotReleases()
	if fresh {
		return rels, nil
	}
	raw := updateAPIRoot() + "/repos/" + updateOwner + "/" + updateRepo + "/releases?per_page=100"
	u, err := url.Parse(raw)
	if err != nil || !updateURLAllowed(u) {
		return nil, updateErr(http.StatusBadGateway, "O endereço de consulta não é o do repositório oficial.")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, raw, nil)
	if err != nil {
		return nil, wrapNet(err)
	}
	req.Header.Set("User-Agent", updateUA)
	req.Header.Set("Accept", "application/vnd.github+json")
	if etag != "" {
		req.Header.Set("If-None-Match", etag)
	}
	resp, err := updateHTTP().Do(req)
	if err != nil {
		return nil, wrapNet(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotModified {
		if len(rels) == 0 {
			return nil, updateErr(http.StatusBadGateway, "O GitHub não enviou a lista de releases. Tente de novo.")
		}
		saveReleases(etag, rels)
		return rels, nil
	}
	if resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusTooManyRequests {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<10))
		return nil, updateErr(http.StatusServiceUnavailable, "O GitHub limitou as consultas anônimas. Espere alguns minutos e tente de novo.")
	}
	if resp.StatusCode == http.StatusNotFound {
		return nil, updateErr(http.StatusNotFound, "Não há release publicado.")
	}
	if resp.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<10))
		return nil, updateErr(http.StatusBadGateway, "O GitHub respondeu com um erro. Nada foi alterado.")
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, updateAPIMax+1))
	if err != nil {
		return nil, wrapNet(err)
	}
	if int64(len(body)) > updateAPIMax {
		return nil, updateErr(http.StatusBadGateway, "A resposta do GitHub passou do tamanho esperado. Nada foi alterado.")
	}
	var list []ghRelease
	if err := json.Unmarshal(body, &list); err != nil {
		return nil, updateErr(http.StatusBadGateway, "O GitHub respondeu de um jeito inesperado. Nada foi alterado.")
	}
	saveReleases(resp.Header.Get("ETag"), list)
	return list, nil
}

func snapshotReleases() (rels []ghRelease, etag string, fresh bool) {
	updateCacheMu.Lock()
	defer updateCacheMu.Unlock()
	if updateCachedReleases == nil {
		loadDiskCacheLocked()
	}
	if updateCachedReleases == nil {
		return nil, "", false
	}
	out := append([]ghRelease(nil), updateCachedReleases...)
	return out, updateETag, time.Since(updateCachedAt) < updateCacheTTL
}

func saveReleases(etag string, rels []ghRelease) {
	updateCacheMu.Lock()
	defer updateCacheMu.Unlock()
	updateCachedReleases = append([]ghRelease(nil), rels...)
	updateCachedAt = time.Now()
	if etag != "" {
		updateETag = etag
	}
	_ = writeDiskCacheLocked()
}

type updateDiskCache struct {
	ETag     string      `json:"etag"`
	At       time.Time   `json:"at"`
	Releases []ghRelease `json:"releases"`
}

func loadDiskCacheLocked() {
	b, err := os.ReadFile(updateCachePath())
	if err != nil {
		return
	}
	var d updateDiskCache
	if json.Unmarshal(b, &d) != nil || d.Releases == nil {
		return
	}
	updateCachedReleases = d.Releases
	updateCachedAt = d.At
	updateETag = d.ETag
}

func writeDiskCacheLocked() error {
	d := updateDiskCache{ETag: updateETag, At: updateCachedAt, Releases: updateCachedReleases}
	b, err := json.Marshal(d)
	if err != nil {
		return err
	}
	dir := filepath.Dir(updateCachePath())
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp := updateCachePath() + ".partial"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	_ = os.Remove(updateCachePath())
	return os.Rename(tmp, updateCachePath())
}

func wrapNet(err error) error {
	if err == nil {
		return nil
	}
	var ue *updateFailure
	if errors.As(err, &ue) {
		return err
	}
	if errors.Is(err, errRedirect) {
		return updateErr(http.StatusBadGateway, "O download apontou para um servidor que não é o do GitHub. Nada foi instalado.")
	}
	return updateErr(http.StatusServiceUnavailable, "Não foi possível falar com o GitHub. Verifique a internet e tente de novo.")
}

func newestInstallable(ctx context.Context) (ghRelease, string, error) {
	list, err := fetchReleases(ctx)
	if err != nil {
		return ghRelease{}, "", err
	}
	rel, ver, ok := pickStable(list)
	if !ok {
		return ghRelease{}, "", updateErr(http.StatusNotFound, "Não há release publicado.")
	}
	if !releaseIsNewer(ver, appVersion) {
		return ghRelease{}, "", updateErr(http.StatusConflict, "Não há versão mais nova.")
	}
	return rel, ver, nil
}
