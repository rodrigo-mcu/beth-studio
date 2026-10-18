package main

import (
	"errors"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"golang.org/x/crypto/bcrypt"
)

const (
	phoneCookie       = "bethstudio_phone"
	phoneCookieMaxAge = int(deviceIdleMax / time.Second)
)

type phoneAuth struct {
	mu       sync.Mutex
	dir      string
	domain   string
	secret   string
	hash     []byte
	limit    *loginLimiter // nil = tunnelLogins
	now      func() time.Time

	// aparelhos e links de pareamento (phone_devices.go)
	devices       []*phoneDevice
	pairs         []pairEntry
	devicesLoaded bool
	saveMu        sync.Mutex
	onDrop        func(alive func(id string) bool)
}

var phone = &phoneAuth{now: time.Now}

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
	a.loadDevices()
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
	a.mu.Unlock()
	// Trocar a senha NÃO revoga os aparelhos já pareados (há "Revogar todos").
	// A senha é a mesma do Studio remoto: trocar derruba as sessões de lá também.
	remote.revoke("", "senha trocada")
	return nil
}

func (a *phoneAuth) login(ip, ua, password string) (string, error) {
	lim := a.limiter()
	if err := lim.check(ip); err != nil {
		remoteLog("celular: login recusado (espera) ip=%s", ip)
		return "", err
	}
	a.mu.Lock()
	hash := a.hash
	a.mu.Unlock()
	if len(hash) == 0 {
		return "", errors.New("a senha do celular ainda não foi criada neste PC")
	}
	if bcrypt.CompareHashAndPassword(hash, []byte(password)) != nil {
		if lim.fail(ip) {
			remoteLog("celular: senha errada, ip travado ip=%s", ip)
		} else {
			remoteLog("celular: senha errada ip=%s", ip)
		}
		return "", errors.New("senha incorreta")
	}
	lim.ok(ip)
	a.mu.Lock()
	token, err := a.addDeviceLocked(ip, ua)
	a.mu.Unlock()
	if err != nil {
		return "", err
	}
	remoteLog("celular: login ip=%s", ip)
	a.saveDevices()
	return token, nil
}

// logout: o aparelho sai (some da lista).
func (a *phoneAuth) logout(token string) {
	a.mu.Lock()
	if d, ok := a.findLocked(token); ok {
		a.removeLocked(d.ID)
	}
	a.mu.Unlock()
	a.saveDevices()
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

// authenticate confere o cookie, registra o uso e devolve o id do aparelho.
func (a *phoneAuth) authenticate(r *http.Request) (string, bool) {
	c, err := r.Cookie(phoneCookie)
	if err != nil || c.Value == "" {
		return "", false
	}
	return a.session(c.Value, phoneClientIP(r))
}

func (a *phoneAuth) authorized(r *http.Request) bool {
	_, ok := a.authenticate(r)
	return ok
}

func setPhoneCookie(w http.ResponseWriter, token string, maxAge int) {
	http.SetCookie(w, &http.Cookie{
		Name: phoneCookie, Value: token, Path: "/",
		HttpOnly: true, Secure: true, SameSite: http.SameSiteStrictMode,
		MaxAge: maxAge,
	})
}
