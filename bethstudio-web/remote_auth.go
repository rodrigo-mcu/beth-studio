package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"golang.org/x/crypto/bcrypt"
)

// Studio completo pelo navegador (docs/superpowers/specs/2026-09-30-studio-remoto-design.md).
// Entra com a senha do celular + código do app autenticador. A sessão é outra,
// com cookie próprio (Path=/studio): a do celular não abre o Studio.

const (
	remoteCookie   = "bethstudio_remote"
	remoteBase     = "/studio"
	remoteIdle     = 12 * time.Hour
	remoteMaxAge   = 7 * 24 * time.Hour
	remoteTouchGap = time.Minute
)

type remoteSession struct {
	Created time.Time `json:"created"`
	Last    time.Time `json:"last"`
	IP      string    `json:"ip"`
	UA      string    `json:"ua"`
	saved   time.Time
}

type remoteAuth struct {
	mu       sync.Mutex
	dir      string
	enabled  bool
	totp     string                    // segredo confirmado
	pending  string                    // segredo em configuração (ainda sem código confirmado)
	lastStep uint64                    // último passo TOTP aceito: o mesmo código não vale duas vezes
	sessions map[string]*remoteSession // chave: sha256(token) em hex
	limit    *loginLimiter
	now      func() time.Time
	onDrop   func(gone func(key string) bool)
}

var remote = &remoteAuth{sessions: map[string]*remoteSession{}}

func (a *remoteAuth) clock() time.Time {
	if a.now != nil {
		return a.now()
	}
	return time.Now()
}

func (a *remoteAuth) limiter() *loginLimiter {
	if a.limit != nil {
		return a.limit
	}
	return tunnelLogins
}

func sessionKey(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// publicID: o que a tela de sessões mostra e manda para encerrar uma sessão.
func publicID(key string) string {
	if len(key) < 16 {
		return key
	}
	return key[:16]
}

func (a *remoteAuth) load() {
	en, _ := secrets.get("remote_enabled", nil)
	sec, _ := secrets.get("remote_totp_secret", nil)
	a.mu.Lock()
	a.enabled = en == "1"
	a.totp = sec
	if a.dir == "" {
		a.dir = dataDir()
	}
	if a.enabled && a.totp == "" {
		a.enabled = false
	}
	a.mu.Unlock()
	a.loadSessions()
}

func (a *remoteAuth) active() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.enabled && a.totp != ""
}

// login: senha do celular + código. Devolve o token do cookie.
func (a *remoteAuth) login(ip, ua, password, code string) (string, error) {
	lim := a.limiter()
	if err := lim.check(ip); err != nil {
		remoteLog("studio remoto: login recusado (espera) ip=%s", ip)
		return "", err
	}
	if !a.active() {
		return "", errors.New("o Studio remoto está desligado neste PC")
	}
	pwOK := phone.checkPassword(password)
	a.mu.Lock()
	step, codeOK := totpCheck(a.totp, code, a.clock())
	if codeOK && step <= a.lastStep {
		codeOK = false // código já usado
	}
	if !pwOK || !codeOK {
		a.mu.Unlock()
		locked := lim.fail(ip)
		what := "senha"
		if pwOK {
			what = "código"
		}
		remoteLog("studio remoto: %s errado ip=%s travado=%v", what, ip, locked)
		// Não diz qual dos dois errou.
		return "", errors.New("senha ou código incorreto")
	}
	a.lastStep = step
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		a.mu.Unlock()
		return "", err
	}
	token := hex.EncodeToString(buf)
	now := a.clock()
	if len(ua) > 200 {
		ua = ua[:200]
	}
	a.sessions[sessionKey(token)] = &remoteSession{Created: now, Last: now, IP: ip, UA: ua, saved: now}
	a.mu.Unlock()
	lim.ok(ip)
	a.saveSessions()
	remoteLog("studio remoto: login ip=%s ua=%q", ip, ua)
	return token, nil
}

func (a *remoteAuth) expired(s *remoteSession, now time.Time) bool {
	return now.Sub(s.Last) > remoteIdle || now.Sub(s.Created) > remoteMaxAge
}

// session: a chave da sessão do cookie, se ainda vale. Marca o uso.
func (a *remoteAuth) session(r *http.Request) (string, bool) {
	c, err := r.Cookie(remoteCookie)
	if err != nil || c.Value == "" || len(c.Value) > 128 {
		return "", false
	}
	key := sessionKey(c.Value)
	a.mu.Lock()
	if !a.enabled || a.totp == "" {
		a.mu.Unlock()
		return "", false
	}
	s, ok := a.sessions[key]
	if !ok {
		a.mu.Unlock()
		return "", false
	}
	now := a.clock()
	if a.expired(s, now) {
		delete(a.sessions, key)
		a.mu.Unlock()
		remoteLog("studio remoto: sessão expirou ip=%s", s.IP)
		a.saveSessions()
		return "", false
	}
	s.Last = now
	save := now.Sub(s.saved) > remoteTouchGap
	if save {
		s.saved = now
	}
	a.mu.Unlock()
	if save {
		a.saveSessions()
	}
	return key, true
}

// touchKey: o WebSocket aberto conta como uso; false = sessão acabou.
func (a *remoteAuth) touchKey(key string) bool {
	a.mu.Lock()
	s, ok := a.sessions[key]
	if !ok || !a.enabled || a.totp == "" || a.expired(s, a.clock()) {
		a.mu.Unlock()
		return false
	}
	now := a.clock()
	s.Last = now
	save := now.Sub(s.saved) > remoteTouchGap
	if save {
		s.saved = now
	}
	a.mu.Unlock()
	if save {
		a.saveSessions()
	}
	return true
}

// valid: a chave ainda existe.
func (a *remoteAuth) valid(key string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	s, ok := a.sessions[key]
	return ok && a.enabled && a.totp != "" && !a.expired(s, a.clock())
}

func (a *remoteAuth) logout(key string) {
	a.mu.Lock()
	s := a.sessions[key]
	delete(a.sessions, key)
	a.mu.Unlock()
	if s != nil {
		remoteLog("studio remoto: saiu ip=%s", s.IP)
	}
	a.saveSessions()
	a.drop()
}

// revoke encerra uma sessão pela id pública; "" encerra todas.
func (a *remoteAuth) revoke(id, why string) int {
	a.mu.Lock()
	n := 0
	for k := range a.sessions {
		if id == "" || publicID(k) == id {
			delete(a.sessions, k)
			n++
		}
	}
	a.mu.Unlock()
	if n > 0 {
		remoteLog("studio remoto: %d sessão(ões) encerrada(s): %s", n, why)
		a.saveSessions()
	}
	a.drop()
	return n
}

func (a *remoteAuth) drop() {
	if a.onDrop != nil {
		a.onDrop(func(key string) bool { return !a.valid(key) })
	}
}

func (a *remoteAuth) setEnabled(on bool) error {
	a.mu.Lock()
	if on && a.totp == "" {
		a.mu.Unlock()
		return errors.New("configure o segundo fator antes de ligar")
	}
	a.mu.Unlock()
	v := ""
	if on {
		v = "1"
	}
	if err := secrets.set("remote_enabled", v); err != nil {
		return err
	}
	a.mu.Lock()
	a.enabled = on
	a.mu.Unlock()
	if on {
		remoteLog("studio remoto: ligado no PC")
	} else {
		a.revoke("", "desligado no PC")
		remoteLog("studio remoto: desligado no PC")
	}
	return nil
}

// startTOTP gera um segredo novo, que só passa a valer depois de confirmado.
func (a *remoteAuth) startTOTP() (string, error) {
	sec, err := newTOTPSecret()
	if err != nil {
		return "", err
	}
	a.mu.Lock()
	a.pending = sec
	a.mu.Unlock()
	return sec, nil
}

func (a *remoteAuth) pendingSecret() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.pending
}

// confirmTOTP: o código do app bate com o segredo novo; troca e derruba as sessões.
func (a *remoteAuth) confirmTOTP(code string) error {
	a.mu.Lock()
	sec := a.pending
	a.mu.Unlock()
	if sec == "" {
		return errors.New("gere o QR primeiro")
	}
	step, ok := totpCheck(sec, code, a.clock())
	if !ok {
		return errors.New("código não confere; veja se o relógio do celular está certo")
	}
	if err := secrets.set("remote_totp_secret", sec); err != nil {
		return err
	}
	a.mu.Lock()
	a.totp = sec
	a.pending = ""
	a.lastStep = step
	a.mu.Unlock()
	a.revoke("", "segundo fator trocado")
	remoteLog("studio remoto: segundo fator configurado")
	return nil
}

type remoteSessionView struct {
	ID      string    `json:"id"`
	IP      string    `json:"ip"`
	UA      string    `json:"ua"`
	Created time.Time `json:"created"`
	Last    time.Time `json:"last"`
}

func (a *remoteAuth) view() (enabled, hasTOTP bool, list []remoteSessionView) {
	a.mu.Lock()
	defer a.mu.Unlock()
	now := a.clock()
	for k, s := range a.sessions {
		if a.expired(s, now) {
			continue
		}
		list = append(list, remoteSessionView{ID: publicID(k), IP: s.IP, UA: s.UA, Created: s.Created, Last: s.Last})
	}
	sort.Slice(list, func(i, j int) bool { return list[i].Last.After(list[j].Last) })
	return a.enabled, a.totp != "", list
}

func (a *remoteAuth) loadSessions() {
	a.mu.Lock()
	dir := a.dir
	a.mu.Unlock()
	if dir == "" {
		return
	}
	b, err := os.ReadFile(filepath.Join(dir, "remote-sessions.json"))
	if err != nil {
		return
	}
	var file struct {
		Sessions map[string]*remoteSession `json:"sessions"`
	}
	if json.Unmarshal(b, &file) != nil {
		return
	}
	now := a.clock()
	a.mu.Lock()
	for k, s := range file.Sessions {
		if s != nil && !a.expired(s, now) {
			s.saved = s.Last
			a.sessions[k] = s
		}
	}
	a.mu.Unlock()
}

func (a *remoteAuth) saveSessions() {
	a.mu.Lock()
	dir := a.dir
	cp := make(map[string]remoteSession, len(a.sessions))
	for k, s := range a.sessions {
		cp[k] = *s
	}
	a.mu.Unlock()
	if dir == "" {
		return
	}
	b, err := json.Marshal(map[string]any{"sessions": cp})
	if err != nil {
		return
	}
	_ = writeAtomic(filepath.Join(dir, "remote-sessions.json"), b)
}

var (
	dummyOnce sync.Once
	dummyHash []byte
)

// checkPassword: a senha do celular (bcrypt), sem criar sessão do celular.
func (a *phoneAuth) checkPassword(pw string) bool {
	a.mu.Lock()
	hash := a.hash
	a.mu.Unlock()
	if len(hash) == 0 {
		// mesmo custo de uma senha errada
		dummyOnce.Do(func() { dummyHash, _ = bcrypt.GenerateFromPassword([]byte("-"), bcrypt.DefaultCost) })
		_ = bcrypt.CompareHashAndPassword(dummyHash, []byte(pw))
		return false
	}
	return bcrypt.CompareHashAndPassword(hash, []byte(pw)) == nil
}

// --- registro de acessos -------------------------------------------------

var (
	remoteLogMu  sync.Mutex
	remoteLogDir string // "" = só no log do bethstudio-web (testes)
)

// remoteLog: remote-access.log (login, erro de senha, sessões encerradas).
func remoteLog(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	log.Print(msg)
	remoteLogMu.Lock()
	defer remoteLogMu.Unlock()
	if remoteLogDir == "" {
		return
	}
	p := filepath.Join(remoteLogDir, "remote-access.log")
	if st, err := os.Stat(p); err == nil && st.Size() > 2<<20 {
		_ = os.Rename(p, p+".old")
	}
	f, err := os.OpenFile(p, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "%s %s\n", time.Now().Format("2006-01-02 15:04:05"), msg)
}
