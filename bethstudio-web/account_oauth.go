package main

// Login por código (OAuth device) das contas Grok Build e Codex.
// O fluxo é o mesmo do claude-router-go: o Beth Studio mostra um código,
// a pessoa autoriza no navegador, e o access token fica cifrado no DPAPI.
// Os client_id são públicos (os mesmos do Grok CLI e do Codex CLI).

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const (
	grokClientID  = "b1a00492-073a-47ea-816f-4c329264a828"
	grokScope     = "openid profile email offline_access grok-cli:access api:access"
	codexClientID = "app_EMoamEEZ73f0CkXaXp7hrann"
)

var (
	grokAuthHost   = "https://auth.x.ai"
	codexAuthHost  = "https://auth.openai.com"
	acctHTTP       = &http.Client{Timeout: 20 * time.Second}
	errAcctPending = errors.New("authorization pending")
)

type acctToken struct {
	AccessToken  string    `json:"access_token"`
	RefreshToken string    `json:"refresh_token"`
	AccountID    string    `json:"account_id,omitempty"`
	Email        string    `json:"email,omitempty"`
	ExpiresAt    time.Time `json:"expires_at"`
}

func acctSecretKey(id string) string { return "acct:" + id }

func loadAcct(id string) (acctToken, bool) {
	raw, _ := secrets.get(acctSecretKey(id), nil)
	if strings.TrimSpace(raw) == "" {
		return acctToken{}, false
	}
	var t acctToken
	if json.Unmarshal([]byte(raw), &t) != nil || t.AccessToken == "" {
		return acctToken{}, false
	}
	return t, true
}

func saveAcct(id string, t acctToken) error {
	b, err := json.Marshal(t)
	if err != nil {
		return err
	}
	if err := secrets.set(acctSecretKey(id), string(b)); err != nil {
		return err
	}
	return secrets.set(id, t.AccessToken)
}

func clearAcct(id string) error {
	if err := secrets.set(acctSecretKey(id), ""); err != nil {
		return err
	}
	return secrets.set(id, "")
}

// accountEnsure devolve um access token válido. Renova se faltar pouco
// para expirar. Sem conta gravada, pede o login por código.
func accountEnsure(id string) (acctToken, error) {
	t, ok := loadAcct(id)
	if !ok {
		def, _ := providerByID(id)
		name := def.Name
		if name == "" {
			name = id
		}
		return acctToken{}, fmt.Errorf("entre com o código da conta %s em Provedores de IA", name)
	}
	if t.RefreshToken == "" || t.ExpiresAt.IsZero() || time.Until(t.ExpiresAt) > 2*time.Minute {
		return t, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	var nt acctToken
	var err error
	switch id {
	case "grok-build":
		nt, err = refreshGrok(ctx, t.RefreshToken)
	case "codex":
		nt, err = refreshCodex(ctx, t.RefreshToken)
	default:
		return t, nil
	}
	if err != nil {
		return t, nil
	}
	if nt.RefreshToken == "" {
		nt.RefreshToken = t.RefreshToken
	}
	if nt.AccountID == "" {
		nt.AccountID = t.AccountID
	}
	if nt.Email == "" {
		nt.Email = t.Email
	}
	if err := saveAcct(id, nt); err != nil {
		return t, nil
	}
	return nt, nil
}

type deviceWait struct {
	provider   string
	grokDevice string
	codexID    string
	codexUser  string
	expires    time.Time
}

var (
	deviceMu     sync.Mutex
	deviceWaitBy = map[string]*deviceWait{}
)

type deviceStart struct {
	UserCode        string `json:"user_code"`
	VerificationURI string `json:"verification_uri"`
	Interval        int    `json:"interval"`
	ExpiresIn       int    `json:"expires_in"`
}

func accountStart(ctx context.Context, id string) (deviceStart, error) {
	switch id {
	case "grok-build":
		return startGrok(ctx)
	case "codex":
		return startCodex(ctx)
	default:
		return deviceStart{}, errors.New("esta conta não entra por código")
	}
}

func accountPoll(ctx context.Context, id string) error {
	deviceMu.Lock()
	w := deviceWaitBy[id]
	deviceMu.Unlock()
	if w == nil || time.Now().After(w.expires) {
		return errors.New("o código expirou — comece de novo")
	}
	switch id {
	case "grok-build":
		tok, err := pollGrok(ctx, w.grokDevice)
		if err != nil {
			return err
		}
		return saveAcct(id, tok)
	case "codex":
		code, verifier, err := pollCodex(ctx, w.codexID, w.codexUser)
		if err != nil {
			return err
		}
		tok, err := exchangeCodex(ctx, code, verifier)
		if err != nil {
			return err
		}
		return saveAcct(id, tok)
	default:
		return errors.New("esta conta não entra por código")
	}
}

func startGrok(ctx context.Context) (deviceStart, error) {
	form := url.Values{}
	form.Set("client_id", grokClientID)
	form.Set("scope", grokScope)
	body, status, err := acctPOST(ctx, grokAuthHost+"/oauth2/device/code", "application/x-www-form-urlencoded", form.Encode())
	if err != nil {
		return deviceStart{}, err
	}
	if status != http.StatusOK {
		return deviceStart{}, fmt.Errorf("Grok Build recusou o código (%d)", status)
	}
	var out struct {
		DeviceCode      string `json:"device_code"`
		UserCode        string `json:"user_code"`
		VerificationURI string `json:"verification_uri"`
		Complete        string `json:"verification_uri_complete"`
		ExpiresIn       int    `json:"expires_in"`
		Interval        int    `json:"interval"`
	}
	if json.Unmarshal(body, &out) != nil || out.DeviceCode == "" || out.UserCode == "" {
		return deviceStart{}, errors.New("resposta inesperada do Grok Build")
	}
	if out.Interval <= 0 {
		out.Interval = 5
	}
	if out.ExpiresIn <= 0 {
		out.ExpiresIn = 600
	}
	if out.VerificationURI == "" {
		out.VerificationURI = "https://accounts.x.ai/oauth2/device"
	}
	uri := out.Complete
	if uri == "" {
		uri = out.VerificationURI + "?user_code=" + url.QueryEscape(out.UserCode)
	}
	deviceMu.Lock()
	deviceWaitBy["grok-build"] = &deviceWait{provider: "grok-build", grokDevice: out.DeviceCode, expires: time.Now().Add(time.Duration(out.ExpiresIn) * time.Second)}
	deviceMu.Unlock()
	return deviceStart{UserCode: out.UserCode, VerificationURI: uri, Interval: out.Interval, ExpiresIn: out.ExpiresIn}, nil
}

func pollGrok(ctx context.Context, deviceCode string) (acctToken, error) {
	form := url.Values{}
	form.Set("client_id", grokClientID)
	form.Set("grant_type", "urn:ietf:params:oauth:grant-type:device_code")
	form.Set("device_code", deviceCode)
	return grokToken(ctx, form)
}

func refreshGrok(ctx context.Context, refresh string) (acctToken, error) {
	form := url.Values{}
	form.Set("client_id", grokClientID)
	form.Set("grant_type", "refresh_token")
	form.Set("refresh_token", refresh)
	tok, err := grokToken(ctx, form)
	if err != nil {
		return acctToken{}, err
	}
	if tok.RefreshToken == "" {
		tok.RefreshToken = refresh
	}
	return tok, nil
}

func grokToken(ctx context.Context, form url.Values) (acctToken, error) {
	body, status, err := acctPOST(ctx, grokAuthHost+"/oauth2/token", "application/x-www-form-urlencoded", form.Encode())
	if err != nil {
		return acctToken{}, err
	}
	var out struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    int    `json:"expires_in"`
		Error        string `json:"error"`
	}
	_ = json.Unmarshal(body, &out)
	if status != http.StatusOK {
		switch out.Error {
		case "authorization_pending", "slow_down":
			return acctToken{}, errAcctPending
		case "expired_token":
			return acctToken{}, errors.New("o código expirou — comece de novo")
		case "access_denied":
			return acctToken{}, errors.New("a autorização foi recusada")
		}
		return acctToken{}, fmt.Errorf("Grok Build recusou o login (%s)", out.Error)
	}
	if out.AccessToken == "" {
		return acctToken{}, errors.New("Grok Build não devolveu o token")
	}
	exp := time.Now().Add(time.Hour)
	if out.ExpiresIn > 0 {
		exp = time.Now().Add(time.Duration(out.ExpiresIn) * time.Second)
	}
	return acctToken{AccessToken: out.AccessToken, RefreshToken: out.RefreshToken, ExpiresAt: exp}, nil
}

func startCodex(ctx context.Context) (deviceStart, error) {
	raw, _ := json.Marshal(map[string]string{"client_id": codexClientID})
	body, status, err := acctPOST(ctx, codexAuthHost+"/api/accounts/deviceauth/usercode", "application/json", string(raw))
	if err != nil {
		return deviceStart{}, err
	}
	if status == http.StatusNotFound {
		return deviceStart{}, errors.New("o login por código do Codex não está disponível")
	}
	if status != http.StatusOK {
		return deviceStart{}, fmt.Errorf("Codex recusou o código (%d)", status)
	}
	var out struct {
		DeviceAuthID string `json:"device_auth_id"`
		UserCode     string `json:"user_code"`
		UserCodeAlt  string `json:"usercode"`
		Interval     string `json:"interval"`
		ExpiresIn    int    `json:"expires_in"`
	}
	if json.Unmarshal(body, &out) != nil {
		return deviceStart{}, errors.New("resposta inesperada do Codex")
	}
	if out.UserCode == "" {
		out.UserCode = out.UserCodeAlt
	}
	if out.UserCode == "" || out.DeviceAuthID == "" {
		return deviceStart{}, errors.New("resposta inesperada do Codex")
	}
	interval := 5
	if n := atoiPos(out.Interval); n > 0 {
		interval = n
	}
	if out.ExpiresIn <= 0 {
		out.ExpiresIn = 900
	}
	deviceMu.Lock()
	deviceWaitBy["codex"] = &deviceWait{provider: "codex", codexID: out.DeviceAuthID, codexUser: out.UserCode, expires: time.Now().Add(time.Duration(out.ExpiresIn) * time.Second)}
	deviceMu.Unlock()
	return deviceStart{
		UserCode: out.UserCode, VerificationURI: codexAuthHost + "/codex/device",
		Interval: interval, ExpiresIn: out.ExpiresIn,
	}, nil
}

func pollCodex(ctx context.Context, deviceAuthID, userCode string) (string, string, error) {
	raw, _ := json.Marshal(map[string]string{"device_auth_id": deviceAuthID, "user_code": userCode})
	body, status, err := acctPOST(ctx, codexAuthHost+"/api/accounts/deviceauth/token", "application/json", string(raw))
	if err != nil {
		return "", "", err
	}
	if status == http.StatusForbidden || status == http.StatusNotFound {
		return "", "", errAcctPending
	}
	if status != http.StatusOK {
		return "", "", fmt.Errorf("Codex recusou a confirmação (%d)", status)
	}
	var out struct {
		AuthorizationCode string `json:"authorization_code"`
		CodeVerifier      string `json:"code_verifier"`
	}
	if json.Unmarshal(body, &out) != nil || out.AuthorizationCode == "" {
		return "", "", errors.New("resposta inesperada do Codex")
	}
	return out.AuthorizationCode, out.CodeVerifier, nil
}

func exchangeCodex(ctx context.Context, code, verifier string) (acctToken, error) {
	form := url.Values{}
	form.Set("grant_type", "authorization_code")
	form.Set("client_id", codexClientID)
	form.Set("code", code)
	form.Set("code_verifier", verifier)
	form.Set("redirect_uri", codexAuthHost+"/deviceauth/callback")
	return codexToken(ctx, form, "")
}

func refreshCodex(ctx context.Context, refresh string) (acctToken, error) {
	form := url.Values{}
	form.Set("grant_type", "refresh_token")
	form.Set("client_id", codexClientID)
	form.Set("refresh_token", refresh)
	tok, err := codexToken(ctx, form, refresh)
	if err != nil {
		return acctToken{}, err
	}
	if tok.RefreshToken == "" {
		tok.RefreshToken = refresh
	}
	return tok, nil
}

func codexToken(ctx context.Context, form url.Values, keepRefresh string) (acctToken, error) {
	body, status, err := acctPOST(ctx, codexAuthHost+"/oauth/token", "application/x-www-form-urlencoded", form.Encode())
	if err != nil {
		return acctToken{}, err
	}
	if status != http.StatusOK {
		return acctToken{}, fmt.Errorf("Codex recusou o token (%d)", status)
	}
	var out struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		IDToken      string `json:"id_token"`
		ExpiresIn    int    `json:"expires_in"`
	}
	if json.Unmarshal(body, &out) != nil || out.AccessToken == "" {
		return acctToken{}, errors.New("Codex não devolveu o token")
	}
	if out.RefreshToken == "" {
		out.RefreshToken = keepRefresh
	}
	tok := acctToken{AccessToken: out.AccessToken, RefreshToken: out.RefreshToken}
	tok.AccountID, tok.Email = codexClaims(out.IDToken)
	tok.ExpiresAt = time.Now().Add(time.Hour)
	if out.ExpiresIn > 0 {
		tok.ExpiresAt = time.Now().Add(time.Duration(out.ExpiresIn) * time.Second)
	}
	return tok, nil
}

func codexClaims(idToken string) (accountID, email string) {
	parts := strings.Split(idToken, ".")
	if len(parts) < 2 {
		return "", ""
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "", ""
	}
	var c struct {
		Sub   string `json:"sub"`
		Email string `json:"email"`
	}
	if json.Unmarshal(payload, &c) != nil {
		return "", ""
	}
	return c.Sub, c.Email
}

func acctPOST(ctx context.Context, urlStr, contentType, body string) ([]byte, int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, urlStr, strings.NewReader(body))
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "bethstudio-web")
	res, err := acctHTTP.Do(req)
	if err != nil {
		return nil, 0, fmt.Errorf("sem conexão com o login (%v)", err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	return raw, res.StatusCode, nil
}

func atoiPos(s string) int {
	n := 0
	for _, r := range s {
		if r < '0' || r > '9' {
			return 0
		}
		n = n*10 + int(r-'0')
	}
	return n
}
