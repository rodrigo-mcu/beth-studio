package main

// vps_api.go — assistente "Instalar servidor" (Configurações > Celular).
// Rotas /api/vps/*. Só a interface local do Studio chega aqui: o Studio remoto
// as bloqueia (remote_gate.go) e o celular nem as enxerga (phone_gate.go).
// Senha SSH, chave, passphrase e token da Cloudflare vivem só na memória do
// job; nada vai para disco nem para log. Ver
// docs/superpowers/specs/2026-10-18-instalador-servidor-vps-design.md.

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"bethstudio-web/phonelink"
	"bethstudio-web/vpsinstall"
)

var vpsMgr vpsinstall.Manager

// vpsDialer é trocado nos testes.
var vpsDialer vpsinstall.Dialer = vpsinstall.DialSSH

// vpsCF cria o cliente da Cloudflare; trocado nos testes.
var vpsCF = func(token string) vpsinstall.CFAPI { return vpsinstall.NewCloudflare(token, "", nil) }

var vpsNet vpsinstall.NetChecker = vpsinstall.RealNet()

type studioHook struct{}

func (studioHook) PhoneConfigured() bool { return phone.hasPassword() }

func (studioHook) ApplyPairing(domain, secret, password string) error {
	if err := phonelink.CheckDomain(domain); err != nil {
		return err
	}
	if pw := strings.TrimSpace(password); pw != "" {
		if err := phone.setPassword(pw); err != nil {
			return err
		}
	} else if !phone.hasPassword() {
		return errNeedPhonePassword
	}
	if err := phone.setLink(domain, secret); err != nil {
		return err
	}
	phoneLink.set("connecting", "")
	kickPhoneLink()
	return nil
}

func (studioHook) LinkState() (string, string) { return phoneLinkView() }

func (studioHook) ClearPairing() error {
	if err := phone.setLink("", ""); err != nil {
		return err
	}
	phoneLink.set("off", "")
	kickPhoneLink()
	return nil
}

type vpsError string

func (e vpsError) Error() string { return string(e) }

const errNeedPhonePassword = vpsError("crie a senha do celular")

func (a *phoneAuth) hasPassword() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return len(a.hash) > 0
}

func vpsStore() *vpsinstall.Store { return &vpsinstall.Store{Dir: dataDir()} }

func vpsDeps() vpsinstall.Deps {
	return vpsinstall.Deps{
		Dial:   vpsDialer,
		CF:     vpsCF,
		Studio: studioHook{},
		Net:    vpsNet,
		Store:  vpsStore(),
		Bins:   vpsBins,
	}
}

var vpsBins vpsinstall.BinSource = vpsinstall.EmbeddedBins()

type vpsReq struct {
	Host          string   `json:"host"`
	Port          int      `json:"port"`
	User          string   `json:"user"`
	Password      string   `json:"password"`
	PrivateKey    string   `json:"private_key"`
	Passphrase    string   `json:"passphrase"`
	Fingerprint   string   `json:"fingerprint"`
	ReplaceKnown  bool     `json:"replace_known"`
	Domain        string   `json:"domain"`
	ZoneID        string   `json:"zone_id"`
	ZoneName      string   `json:"zone_name"`
	RecordIDs     []string `json:"record_ids"`
	IP            string   `json:"ip"`
	CFToken       string   `json:"cf_token"`
	Proxied       bool     `json:"proxied"`
	PhonePassword string   `json:"phone_password"`
	Unattended    bool     `json:"unattended"`
	Action        string   `json:"action"`
	Logs          bool     `json:"logs"`
}

func (q vpsReq) params() vpsinstall.Params {
	port := q.Port
	if port == 0 {
		port = 22
	}
	return vpsinstall.Params{
		Host: strings.TrimSpace(q.Host), Port: port, User: strings.TrimSpace(q.User),
		Password: q.Password, PrivateKey: q.PrivateKey, Passphrase: q.Passphrase, Fingerprint: q.Fingerprint,
		Domain: q.Domain, ZoneID: q.ZoneID, ZoneName: q.ZoneName, CFToken: q.CFToken, RecordIDs: q.RecordIDs,
		Proxied: q.Proxied, PhonePassword: q.PhonePassword, Unattended: q.Unattended,
	}
}

func vpsBad(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

func (s *server) serveVPS(w http.ResponseWriter, r *http.Request, remoteKey string) {
	// Defesa em profundidade: o Studio remoto já é barrado em remoteBlocked.
	if remoteKey != "" {
		vpsBad(w, http.StatusForbidden, "Disponível só no PC")
		return
	}
	sub := strings.TrimPrefix(r.URL.Path, "/api/vps")
	switch sub {
	case "/state":
		if r.Method != http.MethodGet {
			vpsBad(w, http.StatusMethodNotAllowed, "método não permitido")
			return
		}
		sv, _ := vpsStore().Load()
		_, _, e1 := vpsBins.Get("amd64")
		_, _, e2 := vpsBins.Get("arm64")
		writeJSON(w, http.StatusOK, map[string]any{
			"server":        sv,
			"phone":         phoneSetupView(),
			"phone_has_pw":  phone.hasPassword(),
			"bins_embedded": e1 == nil && e2 == nil,
		})
		return
	case "/job":
		if r.Method != http.MethodGet {
			vpsBad(w, http.StatusMethodNotAllowed, "método não permitido")
			return
		}
		j := vpsMgr.Get(r.URL.Query().Get("id"))
		if j == nil {
			vpsBad(w, http.StatusNotFound, "operação não encontrada")
			return
		}
		since, _ := strconv.Atoi(r.URL.Query().Get("since"))
		writeJSON(w, http.StatusOK, j.View(since))
		return
	}
	if r.Method != http.MethodPost {
		vpsBad(w, http.StatusMethodNotAllowed, "use POST")
		return
	}
	if s.hub.readOnly {
		vpsBad(w, http.StatusForbidden, "modo somente leitura")
		return
	}
	var q vpsReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&q); err != nil {
		vpsBad(w, http.StatusBadRequest, "JSON inválido")
		return
	}
	switch sub {
	case "/cf/zones":
		s.vpsZones(w, r, q)
	case "/cf/apply":
		s.vpsDNS(w, r, q)
	case "/probe":
		s.vpsProbe(w, r, q)
	case "/plan":
		p := q.params()
		if err := vpsinstall.ValidateDomain(p.Domain); err != nil && p.Domain != "" {
			vpsBad(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"steps": vpsinstall.Plan(p)})
	case "/install":
		s.vpsInstall(w, q)
	case "/action":
		s.vpsAction(w, q)
	case "/phone-password":
		if err := phone.setPassword(q.PhonePassword); err != nil {
			vpsBad(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	case "/cancel":
		vpsMgr.Cancel()
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	default:
		http.NotFound(w, r)
	}
}

func (s *server) vpsZones(w http.ResponseWriter, r *http.Request, q vpsReq) {
	if strings.TrimSpace(q.CFToken) == "" {
		vpsBad(w, http.StatusBadRequest, "informe o token da Cloudflare")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 40*time.Second)
	defer cancel()
	api := vpsCF(q.CFToken)
	if err := api.VerifyToken(ctx); err != nil {
		vpsBad(w, http.StatusBadRequest, err.Error())
		return
	}
	zs, err := api.ListZones(ctx)
	if err != nil {
		vpsBad(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(zs) == 0 {
		vpsBad(w, http.StatusBadRequest, "o token não enxerga nenhuma zona ativa (Zone → Zone → Read na zona certa?)")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"zones": zs})
}

// vpsDNS é o passo opcional "Endereço": só cria o registro DNS na Cloudflare,
// sem tocar em servidor nenhum.
func (s *server) vpsDNS(w http.ResponseWriter, r *http.Request, q vpsReq) {
	if strings.TrimSpace(q.CFToken) == "" {
		vpsBad(w, http.StatusBadRequest, "informe o token da Cloudflare")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 40*time.Second)
	defer cancel()
	api := vpsCF(q.CFToken)
	if err := api.VerifyToken(ctx); err != nil {
		vpsBad(w, http.StatusBadRequest, err.Error())
		return
	}
	res, err := vpsinstall.SetupDNS(ctx, api, q.ZoneID, q.ZoneName, q.Domain, q.IP)
	if err != nil {
		vpsBad(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *server) vpsProbe(w http.ResponseWriter, r *http.Request, q vpsReq) {
	p := q.params()
	if err := vpsinstall.ValidateHost(p.Host); err != nil {
		vpsBad(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := vpsinstall.ValidatePort(p.Port); err != nil {
		vpsBad(w, http.StatusBadRequest, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	res, err := vpsinstall.Probe(ctx, p.Host, p.Port)
	if err != nil {
		vpsBad(w, http.StatusBadGateway, err.Error())
		return
	}
	known := vpsStore().KnownFingerprint(p.Host, p.Port)
	status := "new"
	switch {
	case known == res.Fingerprint:
		status = "known"
	case known != "":
		status = "changed"
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"fingerprint": res.Fingerprint, "key_type": res.KeyType, "status": status, "known_fingerprint": known,
	})
}

func (s *server) vpsInstall(w http.ResponseWriter, q vpsReq) {
	p := q.params()
	if err := p.ValidateInstall(phone.hasPassword()); err != nil {
		vpsBad(w, http.StatusBadRequest, err.Error())
		return
	}
	if known := vpsStore().KnownFingerprint(p.Host, p.Port); known != "" && known != p.Fingerprint && !q.ReplaceKnown {
		vpsBad(w, http.StatusConflict, "A impressão digital deste servidor mudou desde a última vez. Confirme a nova na tela anterior.")
		return
	}
	d := vpsDeps()
	j, err := vpsMgr.Start("install", func(ctx context.Context, emit vpsinstall.Emit) (*vpsinstall.Outcome, string, error) {
		out, err := vpsinstall.Install(ctx, d, p, emit)
		p = vpsinstall.Params{} // solta os segredos
		return out, "", err
	})
	if err != nil {
		vpsBad(w, http.StatusConflict, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"job": j.ID})
}

func (s *server) vpsAction(w http.ResponseWriter, q vpsReq) {
	p := q.params()
	d := vpsDeps()
	var fn func(ctx context.Context, emit vpsinstall.Emit) (*vpsinstall.Outcome, string, error)
	switch q.Action {
	case "update":
		fn = func(ctx context.Context, emit vpsinstall.Emit) (*vpsinstall.Outcome, string, error) {
			return nil, "", vpsinstall.Update(ctx, d, p, emit)
		}
	case "status", "logs":
		logs := q.Action == "logs"
		fn = func(ctx context.Context, emit vpsinstall.Emit) (*vpsinstall.Outcome, string, error) {
			txt, err := vpsinstall.Status(ctx, d, p, logs, emit)
			return nil, txt, err
		}
	case "remove":
		fn = func(ctx context.Context, emit vpsinstall.Emit) (*vpsinstall.Outcome, string, error) {
			return nil, "", vpsinstall.Remove(ctx, d, p, emit)
		}
	default:
		vpsBad(w, http.StatusBadRequest, "ação desconhecida")
		return
	}
	j, err := vpsMgr.Start(q.Action, func(ctx context.Context, emit vpsinstall.Emit) (*vpsinstall.Outcome, string, error) {
		out, txt, err := fn(ctx, emit)
		p = vpsinstall.Params{}
		return out, txt, err
	})
	if err != nil {
		vpsBad(w, http.StatusConflict, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"job": j.ID})
}
