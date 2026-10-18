package main

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// Aparelhos do celular e links de pareamento (docs/superpowers/specs/
// 2026-10-18-celular-pareamento-design.md).
//
// Cada celular que entra é um aparelho com uma sessão própria. No disco só
// ficam os SHA-256 dos tokens (da sessão e do link de pareamento); o token
// em si só existe no cookie do celular e no QR code por 5 minutos.
const (
	pairTTL         = 5 * time.Minute
	deviceIdleMax   = 90 * 24 * time.Hour  // sem uso: a sessão expira
	deviceAbsMax    = 365 * 24 * time.Hour // idade máxima da sessão
	deviceTouchSave = 10 * time.Minute     // só grava o "último uso" de tempos em tempos
	deviceNameMax   = 40
	phoneDevicesFile = "phone-devices.json"
	phoneLegacyFile  = "phone-sessions.json"
)

var errPairInvalid = errors.New("link inválido ou expirado")

type phoneDevice struct {
	ID       string    `json:"id"`
	Hash     string    `json:"hash"`
	Name     string    `json:"name"`
	Created  time.Time `json:"created"`
	LastUsed time.Time `json:"last_used"`
	LastIP   string    `json:"last_ip"`
}

type pairEntry struct {
	Hash    string    `json:"hash"`
	Expires time.Time `json:"expires"`
}

// phoneDeviceView é o que a interface do PC vê: nunca o hash.
type phoneDeviceView struct {
	ID       string    `json:"id"`
	Name     string    `json:"name"`
	Created  time.Time `json:"created"`
	LastUsed time.Time `json:"last_used"`
	LastIP   string    `json:"last_ip"`
}

func hashToken(tok string) string {
	sum := sha256.Sum256([]byte(tok))
	return hex.EncodeToString(sum[:])
}

func newSecretToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

func newDeviceID() string {
	buf := make([]byte, 8)
	_, _ = rand.Read(buf)
	return hex.EncodeToString(buf)
}

// deviceNameFromUA sugere "iPhone — Safari" a partir do user-agent.
func deviceNameFromUA(ua string) string {
	l := strings.ToLower(ua)
	osName := ""
	switch {
	case strings.Contains(l, "iphone"):
		osName = "iPhone"
	case strings.Contains(l, "ipad"):
		osName = "iPad"
	case strings.Contains(l, "android"):
		osName = "Android"
	case strings.Contains(l, "windows"):
		osName = "Windows"
	case strings.Contains(l, "macintosh"), strings.Contains(l, "mac os"):
		osName = "Mac"
	case strings.Contains(l, "linux"):
		osName = "Linux"
	}
	browser := ""
	switch {
	case strings.Contains(l, "edg/"), strings.Contains(l, "edga/"), strings.Contains(l, "edgios/"):
		browser = "Edge"
	case strings.Contains(l, "samsungbrowser"):
		browser = "Samsung Internet"
	case strings.Contains(l, "firefox/"), strings.Contains(l, "fxios/"):
		browser = "Firefox"
	case strings.Contains(l, "opr/"), strings.Contains(l, "opera"):
		browser = "Opera"
	case strings.Contains(l, "chrome/"), strings.Contains(l, "crios/"):
		browser = "Chrome"
	case strings.Contains(l, "safari/"):
		browser = "Safari"
	}
	switch {
	case osName != "" && browser != "":
		return osName + " — " + browser
	case osName != "":
		return osName
	case browser != "":
		return browser
	}
	return "Celular"
}

// cleanDeviceName: sem controle, sem espaço sobrando, até 40 letras.
func cleanDeviceName(s string) (string, error) {
	s = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, s)
	s = strings.Join(strings.Fields(s), " ")
	if s == "" {
		return "", errors.New("dê um nome ao aparelho")
	}
	if utf8.RuneCountInString(s) > deviceNameMax {
		r := []rune(s)
		s = strings.TrimSpace(string(r[:deviceNameMax]))
	}
	return s, nil
}

// ---- persistência ----

type devicesFile struct {
	Devices []*phoneDevice `json:"devices"`
	Pairs   []pairEntry    `json:"pairs"`
}

// loadDevices lê o arquivo uma vez (load() roda várias vezes) e migra o
// phone-sessions.json antigo, que guardava os tokens em claro.
func (a *phoneAuth) loadDevices() {
	a.mu.Lock()
	if a.devicesLoaded {
		a.mu.Unlock()
		return
	}
	a.devicesLoaded = true
	dir := a.dir
	a.mu.Unlock()
	if dir == "" {
		return
	}
	now := a.clock()
	var df devicesFile
	migrated := false
	if b, err := os.ReadFile(filepath.Join(dir, phoneDevicesFile)); err == nil {
		_ = json.Unmarshal(b, &df)
	} else if b, err := os.ReadFile(filepath.Join(dir, phoneLegacyFile)); err == nil {
		var old struct {
			Tokens map[string]time.Time `json:"tokens"`
		}
		if json.Unmarshal(b, &old) == nil {
			for tok, exp := range old.Tokens {
				if now.Before(exp) {
					df.Devices = append(df.Devices, &phoneDevice{
						ID: newDeviceID(), Hash: hashToken(tok), Name: "Aparelho anterior",
						Created: now, LastUsed: now,
					})
				}
			}
		}
		migrated = true
	}
	a.mu.Lock()
	a.devices = append(a.devices, df.Devices...)
	for _, p := range df.Pairs {
		if now.Before(p.Expires) {
			a.pairs = append(a.pairs, p)
		}
	}
	a.mu.Unlock()
	if migrated {
		a.saveDevices()
		_ = os.Remove(filepath.Join(dir, phoneLegacyFile))
	}
}

func (a *phoneAuth) saveDevices() {
	a.saveMu.Lock()
	defer a.saveMu.Unlock()
	a.mu.Lock()
	dir := a.dir
	df := devicesFile{Devices: make([]*phoneDevice, len(a.devices)), Pairs: append([]pairEntry(nil), a.pairs...)}
	for i, d := range a.devices {
		cp := *d
		df.Devices[i] = &cp
	}
	a.mu.Unlock()
	if dir == "" {
		return
	}
	b, err := json.Marshal(df)
	if err != nil {
		return
	}
	_ = writeAtomic(filepath.Join(dir, phoneDevicesFile), b)
}

// ---- aparelhos ----

// addDeviceLocked cria um aparelho e devolve o token da sessão (única vez em que existe em claro).
func (a *phoneAuth) addDeviceLocked(ip, ua string) (string, error) {
	tok, err := newSecretToken()
	if err != nil {
		return "", err
	}
	now := a.clock()
	a.devices = append(a.devices, &phoneDevice{
		ID: newDeviceID(), Hash: hashToken(tok), Name: deviceNameFromUA(ua),
		Created: now, LastUsed: now, LastIP: ip,
	})
	return tok, nil
}

// findLocked acha o aparelho do token comparando os hashes em tempo constante
// (percorre todos, sem parar no primeiro). Sessão vencida é removida.
func (a *phoneAuth) findLocked(tok string) (*phoneDevice, bool) {
	if tok == "" || len(tok) > 200 {
		return nil, false
	}
	h := []byte(hashToken(tok))
	var hit *phoneDevice
	for _, d := range a.devices {
		if subtle.ConstantTimeCompare(h, []byte(d.Hash)) == 1 {
			hit = d
		}
	}
	if hit == nil {
		return nil, false
	}
	now := a.clock()
	if now.Sub(hit.LastUsed) >= deviceIdleMax || now.Sub(hit.Created) >= deviceAbsMax {
		a.removeLocked(hit.ID)
		return nil, false
	}
	return hit, true
}

func (a *phoneAuth) removeLocked(id string) bool {
	for i, d := range a.devices {
		if d.ID == id {
			a.devices = append(a.devices[:i], a.devices[i+1:]...)
			return true
		}
	}
	return false
}

// session confere o token, registra o uso (hora e IP) e devolve o id do aparelho.
func (a *phoneAuth) session(tok, ip string) (string, bool) {
	a.mu.Lock()
	d, ok := a.findLocked(tok)
	if !ok {
		a.mu.Unlock()
		return "", false
	}
	now := a.clock()
	stale := now.Sub(d.LastUsed) >= deviceTouchSave || (ip != "" && ip != d.LastIP)
	d.LastUsed = now
	if ip != "" {
		d.LastIP = ip
	}
	id := d.ID
	a.mu.Unlock()
	if stale {
		go a.saveDevices()
	}
	return id, true
}

func (a *phoneAuth) valid(tok string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	_, ok := a.findLocked(tok)
	return ok
}

func (a *phoneAuth) deviceAlive(id string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, d := range a.devices {
		if d.ID == id {
			return true
		}
	}
	return false
}

func (a *phoneAuth) deviceViews() []phoneDeviceView {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := make([]phoneDeviceView, 0, len(a.devices))
	for _, d := range a.devices {
		out = append(out, phoneDeviceView{ID: d.ID, Name: d.Name, Created: d.Created, LastUsed: d.LastUsed, LastIP: d.LastIP})
	}
	return out
}

func (a *phoneAuth) renameDevice(id, name string) error {
	name, err := cleanDeviceName(name)
	if err != nil {
		return err
	}
	a.mu.Lock()
	var hit *phoneDevice
	for _, d := range a.devices {
		if d.ID == id {
			hit = d
		}
	}
	if hit == nil {
		a.mu.Unlock()
		return errors.New("aparelho não encontrado")
	}
	hit.Name = name
	a.mu.Unlock()
	a.saveDevices()
	return nil
}

// revokeDevice derruba um aparelho na hora, inclusive o WebSocket aberto.
func (a *phoneAuth) revokeDevice(id string) bool {
	a.mu.Lock()
	ok := a.removeLocked(id)
	a.mu.Unlock()
	if ok {
		remoteLog("celular: aparelho revogado id=%s", id)
		a.saveDevices()
		a.drop()
	}
	return ok
}

func (a *phoneAuth) revokeAllDevices() int {
	a.mu.Lock()
	n := len(a.devices)
	a.devices = nil
	a.mu.Unlock()
	if n > 0 {
		remoteLog("celular: %d aparelho(s) revogado(s)", n)
		a.saveDevices()
		a.drop()
	}
	return n
}

func (a *phoneAuth) drop() {
	if a.onDrop != nil {
		a.onDrop(a.deviceAlive)
	}
}

// ---- pareamento ----

func (a *phoneAuth) prunePairsLocked() {
	now := a.clock()
	keep := a.pairs[:0]
	for _, p := range a.pairs {
		if now.Before(p.Expires) {
			keep = append(keep, p)
		}
	}
	a.pairs = keep
}

// pairCreate gera um token de uso único que vale pairTTL.
func (a *phoneAuth) pairCreate() (string, time.Time, error) {
	tok, err := newSecretToken()
	if err != nil {
		return "", time.Time{}, err
	}
	exp := a.clock().Add(pairTTL)
	a.mu.Lock()
	// Um link por vez: gerar outro invalida o anterior.
	a.pairs = []pairEntry{{Hash: hashToken(tok), Expires: exp}}
	a.mu.Unlock()
	a.saveDevices()
	remoteLog("celular: link de pareamento gerado")
	return tok, exp, nil
}

func (a *phoneAuth) pairPending() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.prunePairsLocked()
	return len(a.pairs)
}

func (a *phoneAuth) pairCancel() {
	a.mu.Lock()
	a.pairs = nil
	a.mu.Unlock()
	a.saveDevices()
}

// pairRedeem troca o token do link por uma sessão. Tudo sob o mesmo mutex:
// dois usos ao mesmo tempo, só um vale.
func (a *phoneAuth) pairRedeem(ip, ua, tok string) (string, error) {
	lim := a.limiter()
	if err := lim.check(ip); err != nil {
		remoteLog("celular: pareamento recusado (espera) ip=%s", ip)
		return "", err
	}
	a.mu.Lock()
	a.prunePairsLocked()
	idx := -1
	if tok != "" && len(tok) <= 200 {
		h := []byte(hashToken(tok))
		for i, p := range a.pairs {
			if subtle.ConstantTimeCompare(h, []byte(p.Hash)) == 1 {
				idx = i
			}
		}
	}
	if idx < 0 {
		a.mu.Unlock()
		if lim.fail(ip) {
			remoteLog("celular: link de pareamento inválido, ip travado ip=%s", ip)
		} else {
			remoteLog("celular: link de pareamento inválido ip=%s", ip)
		}
		return "", errPairInvalid
	}
	a.pairs = append(a.pairs[:idx], a.pairs[idx+1:]...)
	sess, err := a.addDeviceLocked(ip, ua)
	a.mu.Unlock()
	if err != nil {
		return "", err
	}
	lim.ok(ip)
	remoteLog("celular: aparelho pareado ip=%s", ip)
	a.saveDevices()
	return sess, nil
}
