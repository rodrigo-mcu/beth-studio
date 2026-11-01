package main

// settings.go — persisted appearance choices.
//
//   - <data dir>\web-settings.json (ours): default theme/font/size, per-pane
//     theme/font/size, font favourites, and favourites of themes the GUI does
//     not know (VS Code extension themes). Atomic writes (tmp + rename).
//   - <data dir>\theme-favorites.json (shared with the GUI config app,
//     wtinator/src/favorites.rs): favourites of GUI-known themes are added /
//     removed there with a fresh read-modify-write that keeps every other
//     entry byte-for-byte in content (serde pretty format: 2-space indent),
//     so the GUI and the web show the same stars.
//   - <data dir>\default-theme.json (GUI): read only, used as the default
//     theme while the web has none of its own.
//
// Per-pane keys are host pane ids. Each entry also stores the host identity
// (host.pid + its mtime) and the pane title/cwd: if the host restarted, an
// entry is applied only when the title or cwd still match.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	webSettingsFile = "web-settings.json"
	guiFavFile      = "theme-favorites.json"
	guiDefaultFile  = "default-theme.json"
)

type Appearance struct {
	Theme      string  `json:"theme,omitempty"`
	FontFamily string  `json:"font_family,omitempty"`
	FontSize   float64 `json:"font_size,omitempty"` // 0 = ajustar à área
	// SizeMode (so' por pane): fit = o web ajusta cols×rows do pane no host
	// a' janela; host = espelha o tamanho do BethStudio. "" = padrao da UI.
	SizeMode string `json:"size_mode,omitempty"`
	// Negrito (nil = herda: padrao do web -> font_bold da GUI).
	FontBold *bool `json:"font_bold,omitempty"`
}

type PaneAppearance struct {
	Appearance
	Title     string `json:"title,omitempty"`
	Cwd       string `json:"cwd,omitempty"`
	HostID    string `json:"host_id,omitempty"`
	UpdatedAt string `json:"updated_at,omitempty"`
}

type webSettings struct {
	Version        int                        `json:"version"`
	Default        Appearance                 `json:"default"`
	Panes          map[string]*PaneAppearance `json:"panes"`
	FontFavorites  []string                   `json:"font_favorites"`
	ThemeFavorites []string                   `json:"theme_favorites"` // ids the GUI does not know
	// Version 2: the web's own tabs/splits (layout.go). Absent in version-1
	// files; the UI then builds a first layout and posts it.
	Layout *WebLayout `json:"layout,omitempty"`
	// Interface ("shell" of the app) theme. Absent = Escuro (dark).
	UITheme *UITheme `json:"ui_theme,omitempty"`
	// Barra lateral: recolhida e largura (px). Ausente = aberta, 288 px.
	Sidebar *SidebarPrefs          `json:"sidebar,omitempty"`
	Spawned map[string]SpawnedPane `json:"spawned,omitempty"`
	// Cores da interface ja' calculadas (uiboot.go), para o primeiro quadro.
	UICSS *UICSS `json:"ui_css,omitempty"`
	// Microfone: provedores, modelos, prompt, vocabulario (sem chaves;
	// as chaves ficam em secrets.dat com DPAPI).
	Voice *VoiceSettings `json:"voice,omitempty"`
	// Nome de aba dado pelo usuario, por pane (panenames.go).
	PaneNames map[string]*PaneName `json:"pane_names,omitempty"`
	// Comando de inicialização do WSL por distro (chave em minúsculas): wsl_init_cfg.go.
	WSLInit map[string]WSLInitCfg `json:"wsl_init,omitempty"`
	// Ponte de agentes Windows <-> WSL (ponte.go).
	Ponte *PonteSettings `json:"ponte,omitempty"`
	// Limpeza automatica dos temporarios do Studio (tempclean.go).
	TempClean *TempCleanSettings `json:"temp_clean,omitempty"`
}

type SidebarPrefs struct {
	Collapsed bool     `json:"collapsed"`
	Width     int      `json:"width"`
	View      string   `json:"view,omitempty"`  // web | host | kind | folder
	Kinds     []string `json:"kinds,omitempty"` // filtro de tipos (vazio = todos)
	// Ordem dos grupos de tipo (vazio = padrao) e "Separar por tipo" nas
	// listas de "Nao organizados" / "Como no Beth Studio" (nil = ligado).
	KindOrder   []string `json:"kind_order,omitempty"`
	SplitByKind *bool    `json:"split_by_kind,omitempty"`
}

// SpawnedPane: pane criado pelo web (a GUI nao grava o comando desses).
type SpawnedPane struct {
	ShellID string `json:"shell_id"`
	HostID  string `json:"host_id,omitempty"`
}

// UITheme: mode = dark (Escuro = VS Code Dark Modern, padrao) | light
// (Claro) | navy (Azul-marinho) | follow (tema padrao dos terminais) |
// theme (ThemeID so' na interface). Valores de versoes anteriores sao
// migrados por legacyUIMode.
type UITheme struct {
	Mode    string `json:"mode"`
	ThemeID string `json:"theme_id,omitempty"`
}

// SettingsSnapshot is what the UI gets (GET /api/settings and the
// {"ev":"settings"} broadcast).
type SettingsSnapshot struct {
	Ev              string                    `json:"ev"`
	Default         Appearance                `json:"default"`
	GUIDefaultTheme string                    `json:"gui_default_theme,omitempty"`
	GUIDefaultFont  string                    `json:"gui_default_font,omitempty"`
	GUIDefaultBold  bool                      `json:"gui_default_bold,omitempty"`
	Panes           map[string]PaneAppearance `json:"panes"` // only entries valid for the running host
	FontFavorites   []string                  `json:"font_favorites"`
	ThemeFavorites  []string                  `json:"theme_favorites"` // GUI file + web-only
	GUIFavoritesErr string                    `json:"gui_favorites_error,omitempty"`
	Layout          *WebLayout                `json:"layout"`
	UITheme         UITheme                   `json:"ui_theme"`
	Sidebar         SidebarPrefs              `json:"sidebar"`
	// pane id -> nome de aba dado pelo usuario (so' os do host atual)
	PaneNames map[string]string `json:"pane_names"`
}

type paneMeta struct{ title, cwd string }

type settingsStore struct {
	mu   sync.Mutex
	dir  string
	s    webSettings
	live map[int]paneMeta // from the last bridge list
	// frozen: restauracao de terminais em andamento (settings_remap.go); o
	// reconcile so' atualiza st.live e nao mexe no layout nem na aparencia
	frozen  bool
	dirty   bool
	savedAt time.Time
	onChg   func(SettingsSnapshot)
	// stamp: mtime+tamanho do web-settings.json que esta' na memoria
	// (depois de ler ou gravar). Outro processo gravou = stamp diferente.
	stamp string
}

var settings = &settingsStore{}

func (st *settingsStore) load(dir string) {
	st.mu.Lock()
	defer st.mu.Unlock()
	st.dir = dir
	st.s = webSettings{Version: 2, Panes: map[string]*PaneAppearance{}}
	p := filepath.Join(dir, webSettingsFile)
	b, err := os.ReadFile(p)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			log.Printf("settings: lendo %s: %v", p, err)
		}
		return
	}
	var s webSettings
	if err := json.Unmarshal(stripBOM(b), &s); err != nil {
		bad := fmt.Sprintf("%s.corrupt-%s", p, time.Now().Format("20060102-150405"))
		_ = os.Rename(p, bad)
		log.Printf("settings: %s inválido (%v); guardado como %s, começando vazio", p, err, bad)
		return
	}
	if s.Panes == nil {
		s.Panes = map[string]*PaneAppearance{}
	}
	s.Version = 2
	st.s = s
	st.stamp = fileStamp(p)
	log.Printf("settings: carregado %s (%d panes, %d fontes favoritas)", p, len(s.Panes), len(s.FontFavorites))
}

// reloadFromDisk relê web-settings.json sem renomear o arquivo se ele estiver
// inválido. A janela do banco é outro processo: o modelo do assistente pode
// ter mudado no Studio depois que ela abriu.
func (st *settingsStore) reloadFromDisk() {
	st.mu.Lock()
	defer st.mu.Unlock()
	st.reloadLocked()
}

// reloadLocked relê web-settings.json. O Studio e a janela do banco gravam
// o mesmo arquivo; sem reler, um processo sobrescreve o que o outro acabou
// de salvar. Arquivo ausente ou inválido deixa a memória como está.
func (st *settingsStore) reloadLocked() {
	if st.dir == "" {
		return
	}
	b, err := os.ReadFile(filepath.Join(st.dir, webSettingsFile))
	if err != nil || len(b) == 0 {
		return
	}
	var s webSettings
	if json.Unmarshal(stripBOM(b), &s) != nil {
		return
	}
	if s.Panes == nil {
		s.Panes = map[string]*PaneAppearance{}
	}
	s.Version = 2
	st.s = s
	st.stamp = fileStamp(filepath.Join(st.dir, webSettingsFile))
}

// fileStamp: mtime + tamanho ("" = sem arquivo).
func fileStamp(p string) string {
	fi, err := os.Stat(p)
	if err != nil {
		return ""
	}
	return strconv.FormatInt(fi.ModTime().UnixNano(), 10) + ":" + strconv.FormatInt(fi.Size(), 10)
}

// reloadIfChangedLocked rele' o arquivo so' se outro processo gravou nele
// desde a ultima leitura/gravacao deste. Barato para chamar a cada `list`.
func (st *settingsStore) reloadIfChangedLocked() {
	if st.dir == "" {
		return
	}
	if cur := fileStamp(filepath.Join(st.dir, webSettingsFile)); cur != "" && cur != st.stamp {
		st.reloadLocked()
	}
}

// hostID identifies the running host: pid + host.pid mtime (pids repeat).
func (st *settingsStore) hostID() string {
	p := filepath.Join(st.dir, "host.pid")
	if id := hostID(); id != "" { // host de teste com id proprio (hostctl.go)
		p = filepath.Join(st.dir, "hosts", id+".pid")
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return ""
	}
	fi, err := os.Stat(p)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b)) + "@" + strconv.FormatInt(fi.ModTime().Unix(), 10)
}

func writeAtomic(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".tmp-web"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

func (st *settingsStore) saveLocked() error {
	b, err := json.MarshalIndent(st.s, "", "  ")
	if err != nil {
		return err
	}
	if err := writeAtomic(filepath.Join(st.dir, webSettingsFile), b); err != nil {
		log.Printf("settings: gravar: %v", err)
		return fmt.Errorf("não foi possível gravar %s: %w", webSettingsFile, err)
	}
	st.dirty = false
	st.savedAt = time.Now()
	st.stamp = fileStamp(filepath.Join(st.dir, webSettingsFile))
	return nil
}

// ---------------------------------------------------------------------------
// GUI theme-favorites.json
// ---------------------------------------------------------------------------

// readGUIFavorites returns the raw entries and their theme ids. A missing
// file is an empty list; an unparseable one is an error (we never overwrite
// a file we could not read).
func (st *settingsStore) readGUIFavorites() ([]json.RawMessage, []string, error) {
	b, err := os.ReadFile(filepath.Join(st.dir, guiFavFile))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil, nil
	}
	if err != nil {
		return nil, nil, err
	}
	if len(bytes.TrimSpace(b)) == 0 {
		return nil, nil, nil
	}
	var raw []json.RawMessage
	if err := json.Unmarshal(b, &raw); err != nil {
		return nil, nil, fmt.Errorf("%s não é um array JSON: %w", guiFavFile, err)
	}
	ids := make([]string, len(raw))
	for i, r := range raw {
		ids[i] = favEntryID(r)
	}
	return raw, ids, nil
}

// favEntryID: an entry is a preset object {"id":...} or a legacy string.
func favEntryID(r json.RawMessage) string {
	var s string
	if json.Unmarshal(r, &s) == nil {
		return s
	}
	var o struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(r, &o) == nil {
		return o.ID
	}
	return ""
}

// writeGUIFavorites mirrors serde_json::to_vec_pretty (2 spaces, no HTML
// escaping, no trailing newline).
func (st *settingsStore) writeGUIFavorites(raw []json.RawMessage) error {
	if raw == nil {
		raw = []json.RawMessage{}
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(raw); err != nil {
		return err
	}
	return writeAtomic(filepath.Join(st.dir, guiFavFile), bytes.TrimRight(buf.Bytes(), "\n"))
}

func (st *settingsStore) guiDefaultTheme() string {
	b, err := os.ReadFile(filepath.Join(st.dir, guiDefaultFile))
	if err != nil {
		return ""
	}
	var d struct {
		Theme *string `json:"theme"`
	}
	if json.Unmarshal(b, &d) != nil || d.Theme == nil {
		return ""
	}
	return strings.TrimSpace(*d.Theme)
}

// ---------------------------------------------------------------------------
// snapshot / mutations
// ---------------------------------------------------------------------------

func (st *settingsStore) snapshot() SettingsSnapshot {
	st.mu.Lock()
	defer st.mu.Unlock()
	if dbStandalone {
		st.reloadLocked()
	}
	return st.snapshotLocked()
}

func (st *settingsStore) snapshotLocked() SettingsSnapshot {
	snap := SettingsSnapshot{
		Ev:              "settings",
		Default:         st.s.Default,
		GUIDefaultTheme: st.guiDefaultTheme(),
		GUIDefaultFont:  st.guiDefaultFont(),
		GUIDefaultBold:  st.guiDefaultBold(),
		Panes:           map[string]PaneAppearance{},
		FontFavorites:   append([]string{}, st.s.FontFavorites...),
		Layout:          st.s.Layout,
		UITheme:         UITheme{Mode: "dark"},
	}
	if st.s.UITheme != nil {
		snap.UITheme = *st.s.UITheme
		snap.UITheme.Mode = legacyUIMode(snap.UITheme.Mode)
	}
	snap.Sidebar = SidebarPrefs{Width: defaultSidebarWidth}
	if st.s.Sidebar != nil {
		snap.Sidebar = *st.s.Sidebar
	}
	host := st.hostID()
	for k, p := range st.s.Panes {
		if st.paneValidLocked(k, p, host) {
			snap.Panes[k] = *p
		}
	}
	snap.PaneNames = st.paneNamesViewLocked(host)
	_, gui, err := st.readGUIFavorites()
	if err != nil {
		snap.GUIFavoritesErr = err.Error()
	}
	seen := map[string]bool{}
	for _, id := range append(gui, st.s.ThemeFavorites...) {
		if id != "" && !seen[id] {
			seen[id] = true
			snap.ThemeFavorites = append(snap.ThemeFavorites, id)
		}
	}
	if snap.ThemeFavorites == nil {
		snap.ThemeFavorites = []string{}
	}
	return snap
}

// paneValidLocked: same host => trust the id; other host => title or cwd
// must still match the pane that now has this id.
func (st *settingsStore) paneValidLocked(key string, p *PaneAppearance, host string) bool {
	if p.HostID != "" && p.HostID == host {
		return true
	}
	id, err := strconv.Atoi(key)
	if err != nil {
		return false
	}
	m, ok := st.live[id]
	if !ok {
		return false
	}
	return (p.Cwd != "" && p.Cwd == m.cwd) || (p.Title != "" && p.Title == m.title)
}

// reconcile runs on every bridge `list`: refresh title/cwd of entries that
// belong to the running host, adopt matching entries of a previous host,
// and drop stale entries of old hosts after 14 days.
func (st *settingsStore) reconcile(list []byte) {
	var ev struct {
		Panes []struct {
			PaneID int    `json:"pane_id"`
			Title  string `json:"title"`
			Cwd    string `json:"cwd"`
		} `json:"panes"`
	}
	if json.Unmarshal(list, &ev) != nil {
		return
	}
	st.mu.Lock()
	// Outro bethstudio-web (ou a janela do banco/SFTP) pode ter gravado desde
	// a ultima vez: sem reler, a gravacao abaixo desfaz o tema que o usuario
	// acabou de escolher num terminal (voltava ao escuro ao trocar de aba).
	st.reloadIfChangedLocked()
	st.live = map[int]paneMeta{}
	for _, p := range ev.Panes {
		st.live[p.PaneID] = paneMeta{p.Title, p.Cwd}
	}
	if st.frozen {
		st.mu.Unlock()
		return
	}
	host := st.hostID()
	changed := false
	for k, p := range st.s.Panes {
		id, _ := strconv.Atoi(k)
		m, alive := st.live[id]
		switch {
		case p.HostID == host && host != "":
			// Titles change often (spinners): keep them in memory and
			// save at most every 30 s (or with the next real change).
			if alive && (p.Title != m.title || p.Cwd != m.cwd) {
				p.Title, p.Cwd = m.title, m.cwd
				st.dirty = true
			}
		case alive && freshSpawn(st.s.Spawned, k, host):
			// O web acabou de criar este pane neste host: a entrada com o
			// mesmo numero e' de um terminal antigo (outro host). Nao herda
			// o tema dele; o terminal novo nasce com o tema do Studio.
			delete(st.s.Panes, k)
			changed = true
		case alive && ((p.Cwd != "" && p.Cwd == m.cwd) || (p.Title != "" && p.Title == m.title)):
			p.HostID, p.Title, p.Cwd = host, m.title, m.cwd
			changed = true
		default:
			if t, err := time.Parse(time.RFC3339, p.UpdatedAt); err != nil || time.Since(t) > 14*24*time.Hour {
				delete(st.s.Panes, k)
				changed = true
			}
		}
	}
	if st.reconcilePaneNamesLocked(host, time.Now()) {
		changed = true
	}
	refreshed := false
	if resolveLeaves(st.s.Layout, st.live, host, &refreshed) {
		changed = true
	}
	if dropEndedOpenTabs(st.s.Layout) {
		changed = true
	}
	if pruneClosed(st.s.Layout, time.Now()) {
		changed = true
	}
	if refreshed {
		st.dirty = true
	}
	var snap SettingsSnapshot
	if changed {
		_ = st.saveLocked()
		snap = st.snapshotLocked()
	} else if st.dirty && time.Since(st.savedAt) > 30*time.Second {
		_ = st.saveLocked()
	}
	cb := st.onChg
	st.mu.Unlock()
	if changed && cb != nil {
		cb(snap)
	}
}

func cleanAppearance(a Appearance) (Appearance, error) {
	a.Theme = strings.TrimSpace(a.Theme)
	a.FontFamily = strings.TrimSpace(a.FontFamily)
	if len(a.Theme) > 300 || len(a.FontFamily) > 200 || strings.ContainsAny(a.FontFamily, "\"';{}<>\\") {
		return a, errors.New("valor inválido")
	}
	if a.Theme != "" {
		if _, ok := themes.has(a.Theme); !ok {
			return a, fmt.Errorf("tema desconhecido: %s", a.Theme)
		}
	}
	if a.SizeMode != "" && a.SizeMode != "fit" && a.SizeMode != "host" {
		return a, errors.New("size_mode inválido")
	}
	if math.IsNaN(a.FontSize) || a.FontSize < 0 || (a.FontSize > 0 && (a.FontSize < 5 || a.FontSize > 48)) {
		return a, errors.New("tamanho de fonte fora de 5..48")
	}
	a.FontSize = math.Round(a.FontSize*2) / 2
	return a, nil
}

func (st *settingsStore) mutate(f func() error) (SettingsSnapshot, error) {
	st.mu.Lock()
	st.reloadLocked()
	if err := f(); err != nil {
		st.mu.Unlock()
		return SettingsSnapshot{}, err
	}
	snap := st.snapshotLocked()
	cb := st.onChg
	st.mu.Unlock()
	if cb != nil {
		cb(snap)
	}
	return snap, nil
}

func (st *settingsStore) setDefault(a Appearance) (SettingsSnapshot, error) {
	a, err := cleanAppearance(a)
	if err != nil {
		return SettingsSnapshot{}, err
	}
	return st.mutate(func() error {
		st.s.Default = a
		return st.saveLocked()
	})
}

// setPane stores (or, when a is empty, clears) the appearance of one pane.
func (st *settingsStore) setPane(paneID int, a Appearance) (SettingsSnapshot, error) {
	a, err := cleanAppearance(a)
	if err != nil {
		return SettingsSnapshot{}, err
	}
	return st.mutate(func() error {
		key := strconv.Itoa(paneID)
		if a == (Appearance{}) {
			delete(st.s.Panes, key)
			return st.saveLocked()
		}
		m, ok := st.live[paneID]
		if !ok {
			return fmt.Errorf("terminal %d não está na lista do host", paneID)
		}
		st.s.Panes[key] = &PaneAppearance{Appearance: a, Title: m.title, Cwd: m.cwd,
			HostID: st.hostID(), UpdatedAt: time.Now().Format(time.RFC3339)}
		return st.saveLocked()
	})
}

func (st *settingsStore) setFontFavorite(family string, fav bool) (SettingsSnapshot, error) {
	family = strings.TrimSpace(family)
	if family == "" || len(family) > 200 {
		return SettingsSnapshot{}, errors.New("fonte inválida")
	}
	return st.mutate(func() error {
		st.s.FontFavorites = toggleList(st.s.FontFavorites, family, fav)
		return st.saveLocked()
	})
}

// setThemeFavorite: GUI-known ids go to the GUI's theme-favorites.json (a
// fresh read-modify-write), the others to web-settings.json.
func (st *settingsStore) setThemeFavorite(id string, fav bool) (SettingsSnapshot, error) {
	id = strings.TrimSpace(id)
	t, known := themes.has(id)
	if id == "" || (fav && !known) {
		return SettingsSnapshot{}, fmt.Errorf("tema desconhecido: %s", id)
	}
	return st.mutate(func() error {
		raw, ids, err := st.readGUIFavorites()
		if err != nil {
			return err
		}
		inGUI := -1
		for i, x := range ids {
			if x == id {
				inGUI = i
				break
			}
		}
		switch {
		case fav && t.GUI && inGUI < 0:
			entry, _ := json.Marshal(map[string]string{"id": id})
			if err := st.writeGUIFavorites(append(raw, entry)); err != nil {
				return fmt.Errorf("gravar %s: %w", guiFavFile, err)
			}
		case !fav && inGUI >= 0:
			out := make([]json.RawMessage, 0, len(raw))
			for i, r := range raw {
				if ids[i] != id {
					out = append(out, r)
				}
			}
			if err := st.writeGUIFavorites(out); err != nil {
				return fmt.Errorf("gravar %s: %w", guiFavFile, err)
			}
		}
		webFav := fav && !t.GUI
		before := len(st.s.ThemeFavorites)
		st.s.ThemeFavorites = toggleList(st.s.ThemeFavorites, id, webFav)
		if len(st.s.ThemeFavorites) != before {
			return st.saveLocked()
		}
		return nil
	})
}

func toggleList(list []string, v string, on bool) []string {
	out := make([]string, 0, len(list)+1)
	for _, x := range list {
		if !strings.EqualFold(x, v) {
			out = append(out, x)
		}
	}
	if on {
		out = append(out, v)
	}
	return out
}

// flush saves pending title/cwd refreshes (called at exit).
func (st *settingsStore) flush() {
	st.mu.Lock()
	defer st.mu.Unlock()
	st.reloadIfChangedLocked()
	if st.dirty {
		_ = st.saveLocked()
	}
}

// setLayout stores the web's tabs/splits posted by the UI.
func (st *settingsStore) setLayout(in *WebLayout) (SettingsSnapshot, error) {
	l, err := sanitizeLayout(in)
	if err != nil {
		return SettingsSnapshot{}, err
	}
	return st.mutate(func() error {
		if st.live != nil {
			refreshed := false
			resolveLeaves(l, st.live, st.hostID(), &refreshed)
			dropEndedOpenTabs(l)
		}
		st.s.Layout = l
		return st.saveLocked()
	})
}

// legacyUIMode: modos gravados por versoes anteriores tinham um prefixo
// ("<prefixo>-dark", "<prefixo>-light", "<prefixo>-blue"); viram os atuais.
func legacyUIMode(m string) string {
	switch {
	case m == "dark" || m == "light" || m == "navy" || m == "follow" || m == "theme":
		return m
	case strings.HasSuffix(m, "-dark"):
		return "dark"
	case strings.HasSuffix(m, "-light"):
		return "light"
	case strings.HasSuffix(m, "-blue"):
		return "navy"
	}
	return m
}

func (st *settingsStore) setUITheme(u UITheme) (SettingsSnapshot, error) {
	u.Mode = legacyUIMode(u.Mode)
	switch u.Mode {
	case "dark", "light", "navy", "follow":
		u.ThemeID = ""
	case "theme":
		if _, ok := themes.has(u.ThemeID); !ok {
			return SettingsSnapshot{}, fmt.Errorf("tema desconhecido: %s", u.ThemeID)
		}
	default:
		return SettingsSnapshot{}, fmt.Errorf("modo inválido: %s", u.Mode)
	}
	return st.mutate(func() error {
		st.s.UITheme = &u
		return st.saveLocked()
	})
}

// clearPanes removes every per-terminal appearance ("Aplicar a todos").
func (st *settingsStore) clearPanes() (SettingsSnapshot, int, error) {
	n := 0
	snap, err := st.mutate(func() error {
		n = len(st.s.Panes)
		st.s.Panes = map[string]*PaneAppearance{}
		return st.saveLocked()
	})
	return snap, n, err
}

const (
	defaultSidebarWidth = 288
	minSidebarWidth     = 200
	maxSidebarWidth     = 640
)

func (st *settingsStore) setSidebar(p SidebarPrefs) (SettingsSnapshot, error) {
	if p.Width == 0 {
		p.Width = defaultSidebarWidth
	}
	if p.Width < minSidebarWidth {
		p.Width = minSidebarWidth
	}
	if p.Width > maxSidebarWidth {
		p.Width = maxSidebarWidth
	}
	switch p.View {
	case "", "web", "host", "kind", "folder":
	default:
		return SettingsSnapshot{}, errors.New("visão inválida")
	}
	if len(p.Kinds) > 20 || len(p.KindOrder) > 20 {
		return SettingsSnapshot{}, errors.New("filtros demais")
	}
	for _, k := range p.KindOrder {
		if len(k) == 0 || len(k) > 24 {
			return SettingsSnapshot{}, errors.New("ordem inválida")
		}
	}
	for _, k := range p.Kinds {
		if len(k) == 0 || len(k) > 24 {
			return SettingsSnapshot{}, errors.New("filtro inválido")
		}
	}
	return st.mutate(func() error {
		st.s.Sidebar = &p
		return st.saveLocked()
	})
}

// recordSpawn grava o shell de um pane criado pelo web.
func (st *settingsStore) recordSpawn(pane int, shellID string) {
	st.mu.Lock()
	defer st.mu.Unlock()
	host := st.hostID()
	if st.s.Spawned == nil {
		st.s.Spawned = map[string]SpawnedPane{}
	}
	for k, v := range st.s.Spawned { // de hosts antigos: nao valem mais
		if v.HostID != host {
			delete(st.s.Spawned, k)
		}
	}
	key := strconv.Itoa(pane)
	st.s.Spawned[key] = SpawnedPane{ShellID: shellID, HostID: host}
	// Aparencia de um pane antigo (outro host) com o mesmo numero nao vale
	// para o terminal novo: ele comeca com o tema do Beth Studio.
	if p := st.s.Panes[key]; p != nil && p.HostID != host {
		delete(st.s.Panes, key)
	}
	_ = st.saveLocked()
}

// freshSpawn: o pane `key` foi criado pelo web no host atual.
func freshSpawn(spawned map[string]SpawnedPane, key, host string) bool {
	sp, ok := spawned[key]
	return ok && host != "" && sp.HostID == host
}

// spawnedMap: panes criados pelo web no host atual.
func (st *settingsStore) spawnedMap() map[int]string {
	st.mu.Lock()
	defer st.mu.Unlock()
	host := st.hostID()
	out := map[int]string{}
	for k, v := range st.s.Spawned {
		if v.HostID != host {
			continue
		}
		if id, err := strconv.Atoi(k); err == nil {
			out[id] = v.ShellID
		}
	}
	return out
}

// guiDefaultFont: font_family do default-theme.json da GUI ("" = nenhuma).
func (st *settingsStore) guiDefaultFont() string {
	b, err := os.ReadFile(filepath.Join(st.dir, guiDefaultFile))
	if err != nil {
		return ""
	}
	var d struct {
		Font *string `json:"font_family"`
	}
	if json.Unmarshal(b, &d) != nil || d.Font == nil {
		return ""
	}
	return strings.TrimSpace(*d.Font)
}

// guiDefaultBold: font_bold do default-theme.json da GUI.
func (st *settingsStore) guiDefaultBold() bool {
	b, err := os.ReadFile(filepath.Join(st.dir, guiDefaultFile))
	if err != nil {
		return false
	}
	var d struct {
		Bold bool `json:"font_bold"`
	}
	_ = json.Unmarshal(b, &d)
	return d.Bold
}
