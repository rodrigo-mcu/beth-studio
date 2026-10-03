package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"golang.org/x/crypto/bcrypt"
)

const phoneCookie = "bethstudio_phone"

type phoneAuth struct {
	mu       sync.Mutex
	dir      string
	domain   string
	secret   string
	hash     []byte
	sessions map[string]time.Time
	limit    *loginLimiter // nil = tunnelLogins
	now      func() time.Time
}

var phone = &phoneAuth{
	sessions: map[string]time.Time{},
	now:      time.Now,
}

func (a *phoneAuth) limiter() *loginLimiter {
	if a.limit != nil {
		return a.limit
	}
	return tunnelLogins
}

func (a *phoneAuth) clock() time.Time {
	if a.now != nil {
		return a.now()
	}
	return time.Now()
}

func validatePhonePassword(pw string) error {
	pw = strings.TrimSpace(pw)
	if utf8.RuneCountInString(pw) < 8 {
		return errors.New("a senha precisa de pelo menos 8 caracteres")
	}
	if len(pw) > 200 {
		return errors.New("senha grande demais")
	}
	return nil
}

func (a *phoneAuth) load() {
	domain, _ := secrets.get("phone_domain", nil)
	secret, _ := secrets.get("phone_link_secret", nil)
	hash, _ := secrets.get("phone_password_hash", nil)
	a.mu.Lock()
	a.domain = domain
	a.secret = secret
	a.hash = []byte(hash)
	if a.dir == "" {
		a.dir = dataDir()
	}
	a.mu.Unlock()
	a.loadSessions()
}

func (a *phoneAuth) creds() (domain, secret string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.domain, a.secret
}

func (a *phoneAuth) configured() (domain string, ok bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.domain, a.domain != "" && a.secret != "" && len(a.hash) > 0
}

func (a *phoneAuth) setLink(domain, secret string) error {
	if err := secrets.set("phone_domain", domain); err != nil {
		return err
	}
	if err := secrets.set("phone_link_secret", secret); err != nil {
		return err
	}
	a.mu.Lock()
	a.domain = domain
	a.secret = secret
	a.mu.Unlock()
	return nil
}

func (a *phoneAuth) setPassword(pw string) error {
	if err := validatePhonePassword(pw); err != nil {
		return err
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(strings.TrimSpace(pw)), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	if err := secrets.set("phone_password_hash", string(hash)); err != nil {
		return err
	}
	a.mu.Lock()
	a.hash = hash
	a.sessions = map[string]time.Time{}
	a.mu.Unlock()
	a.saveSessions()
	// A senha é a mesma do Studio remoto: trocar derruba as sessões de lá também.
	remote.revoke("", "senha trocada")
	return nil
}

func (a *phoneAuth) login(ip, password string) (string, error) {
	lim := a.limiter()
	if err := lim.check(ip); err != nil {
		remoteLog("celular: login recusado (espera) ip=%s", ip)
		return "", err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if len(a.hash) == 0 {
		return "", errors.New("a senha do celular ainda não foi criada neste PC")
	}
	if bcrypt.CompareHashAndPassword(a.hash, []byte(password)) != nil {
		if lim.fail(ip) {
			remoteLog("celular: senha errada, ip travado ip=%s", ip)
		} else {
			remoteLog("celular: senha errada ip=%s", ip)
		}
		return "", errors.New("senha incorreta")
	}
	lim.ok(ip)
	remoteLog("celular: login ip=%s", ip)
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	token := hex.EncodeToString(buf)
	if a.sessions == nil {
		a.sessions = map[string]time.Time{}
	}
	a.sessions[token] = a.clock().Add(30 * 24 * time.Hour)
	go a.saveSessions()
	return token, nil
}

func (a *phoneAuth) valid(token string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	exp, ok := a.sessions[token]
	if !ok {
		return false
	}
	if !a.clock().Before(exp) {
		delete(a.sessions, token)
		go a.saveSessions()
		return false
	}
	return true
}

func (a *phoneAuth) logout(token string) {
	a.mu.Lock()
	delete(a.sessions, token)
	a.mu.Unlock()
	a.saveSessions()
}

func (a *phoneAuth) loadSessions() {
	a.mu.Lock()
	dir := a.dir
	a.mu.Unlock()
	if dir == "" {
		return
	}
	b, err := os.ReadFile(filepath.Join(dir, "phone-sessions.json"))
	if err != nil {
		return
	}
	var file struct {
		Tokens map[string]time.Time `json:"tokens"`
	}
	if json.Unmarshal(b, &file) != nil || file.Tokens == nil {
		return
	}
	now := a.clock()
	a.mu.Lock()
	if a.sessions == nil {
		a.sessions = map[string]time.Time{}
	}
	for k, exp := range file.Tokens {
		if now.Before(exp) {
			a.sessions[k] = exp
		}
	}
	a.mu.Unlock()
}

func (a *phoneAuth) saveSessions() {
	a.mu.Lock()
	dir := a.dir
	cp := make(map[string]time.Time, len(a.sessions))
	for k, v := range a.sessions {
		cp[k] = v
	}
	a.mu.Unlock()
	if dir == "" {
		return
	}
	b, err := json.Marshal(map[string]any{"tokens": cp})
	if err != nil {
		return
	}
	_ = writeAtomic(filepath.Join(dir, "phone-sessions.json"), b)
}

func phoneClientIP(r *http.Request) string {
	if v := strings.TrimSpace(r.Header.Get("X-BethStudio-Client")); v != "" {
		return v
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil || host == "" {
		return r.RemoteAddr
	}
	return host
}

func (a *phoneAuth) authorized(r *http.Request) bool {
	c, err := r.Cookie(phoneCookie)
	if err != nil || c.Value == "" {
		return false
	}
	return a.valid(c.Value)
}

func setPhoneCookie(w http.ResponseWriter, token string, maxAge int) {
	http.SetCookie(w, &http.Cookie{
		Name: phoneCookie, Value: token, Path: "/",
		HttpOnly: true, Secure: true, SameSite: http.SameSiteStrictMode,
		MaxAge: maxAge,
	})
}
