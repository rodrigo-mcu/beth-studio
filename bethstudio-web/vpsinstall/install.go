package vpsinstall

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strings"
	"time"
)

// Event é uma linha do andamento mostrada na tela.
type Event struct {
	Seq    int    `json:"seq"`
	Step   string `json:"step"`
	Status string `json:"status"` // running, ok, skip, info, warn, error
	Msg    string `json:"msg"`
	Hint   string `json:"hint,omitempty"`
}

type Emit func(Event)

// StudioHook é o que o assistente precisa deste Studio (o pacote não conhece o main).
type StudioHook interface {
	PhoneConfigured() bool
	ApplyPairing(domain, secret, phonePassword string) error
	LinkState() (state, detail string)
	ClearPairing() error
}

// NetChecker faz as verificações de fora (DNS e HTTPS) do ponto de vista deste PC.
type NetChecker interface {
	LookupHost(ctx context.Context, host string) ([]string, error)
	// GetHTTPS faz GET https://domain/ validando o certificado.
	GetHTTPS(ctx context.Context, domain string) (status int, err error)
}

type Deps struct {
	Dial   Dialer
	CF     func(token string) CFAPI
	Studio StudioHook
	Net    NetChecker
	Store  *Store
	Bins   BinSource
	Sleep  func(time.Duration)
	// Tentativas de espera do teste final (DNS, HTTPS, ligação) e intervalo.
	Tries    int
	Interval time.Duration
}

func (d Deps) sleep(t time.Duration) {
	if d.Sleep != nil {
		d.Sleep(t)
		return
	}
	time.Sleep(t)
}

func (d Deps) tries() int {
	if d.Tries > 0 {
		return d.Tries
	}
	return 30
}

func (d Deps) interval() time.Duration {
	if d.Interval > 0 {
		return d.Interval
	}
	return 4 * time.Second
}

// Params é o pedido do assistente. Contém segredos: só em memória.
type Params struct {
	Host, User                       string
	Port                             int
	Password, PrivateKey, Passphrase string
	Fingerprint                      string

	Domain, ZoneID, ZoneName string
	CFToken                  string
	Proxied                  bool
	PhonePassword            string
	Unattended               bool
}

func (p Params) conn() ConnParams {
	return ConnParams{Host: p.Host, Port: p.Port, User: p.User, Password: p.Password,
		PrivateKey: p.PrivateKey, Passphrase: p.Passphrase, Fingerprint: p.Fingerprint}
}

// Secrets lista tudo que nunca pode aparecer em texto emitido.
func (p Params) Secrets() []string {
	s := []string{p.Password, p.Passphrase, p.CFToken, p.PhonePassword}
	for _, l := range strings.Split(p.PrivateKey, "\n") {
		l = strings.TrimSpace(l)
		if len(l) >= 8 && !strings.HasPrefix(l, "-----") {
			s = append(s, l)
		}
	}
	return s
}

// ValidateInstall confere os campos antes de qualquer conexão.
func (p Params) ValidateInstall(phoneConfigured bool) error {
	if err := ValidateHost(p.Host); err != nil {
		return err
	}
	if err := ValidatePort(p.Port); err != nil {
		return err
	}
	if err := ValidateUser(p.User); err != nil {
		return err
	}
	if p.Password == "" && strings.TrimSpace(p.PrivateKey) == "" {
		return errors.New("informe a senha ou a chave privada do servidor")
	}
	if p.Fingerprint == "" {
		return errors.New("confirme a impressão digital do servidor")
	}
	if err := ValidateDomain(p.Domain); err != nil {
		return err
	}
	if p.Proxied {
		return errors.New("a nuvem laranja da Cloudflare não é suportada: o servidor obtém o certificado sozinho (Let's Encrypt) e a Cloudflare no meio atrapalha o desafio. Use \"somente DNS\" (nuvem cinza)")
	}
	if !DomainInZone(p.Domain, p.ZoneName) {
		return errors.New("o domínio precisa ser a zona escolhida ou um subdomínio dela")
	}
	if p.ZoneID == "" || checkID(p.ZoneID) != nil {
		return errors.New("escolha a zona da Cloudflare")
	}
	if strings.TrimSpace(p.CFToken) == "" {
		return errors.New("informe o token da Cloudflare")
	}
	if p.PhonePassword != "" {
		if len(strings.TrimSpace(p.PhonePassword)) < 8 {
			return errors.New("a senha do celular precisa de pelo menos 8 caracteres")
		}
	} else if !phoneConfigured {
		return errors.New("crie a senha do celular (mínimo de 8 caracteres)")
	}
	return nil
}

// StepError é uma falha em um passo, com o que fazer.
type StepError struct {
	Step string
	Msg  string
	Hint string
}

func (e *StepError) Error() string { return e.Msg }

// Outcome é o resultado de uma instalação concluída.
type Outcome struct {
	Domain string `json:"domain"`
	URL    string `json:"url"`
	QR     string `json:"qr"`
	Link   string `json:"link"`
	Detail string `json:"detail,omitempty"`
}

type session struct {
	r        Remote
	user     string
	password string
	mode     SudoMode
	secrets  *Redactor
}

func (s *session) priv(ctx context.Context, script string) (Result, error) {
	cmd, in := wrapPriv(s.mode, s.password, script)
	return s.r.Run(ctx, cmd, in)
}

// must roda como root e falha se o comando sair com código ≠ 0.
func (s *session) must(ctx context.Context, step, what, script string) (Result, error) {
	res, err := s.priv(ctx, script)
	if err != nil {
		return res, &StepError{Step: step, Msg: what + ": " + err.Error()}
	}
	if res.Code != 0 {
		return res, &StepError{Step: step, Msg: fmt.Sprintf("%s falhou (código %d)", what, res.Code), Hint: s.tail(res)}
	}
	return res, nil
}

func (s *session) tail(res Result) string {
	t := strings.TrimSpace(res.Stderr)
	if t == "" {
		t = strings.TrimSpace(res.Stdout)
	}
	if len(t) > 600 {
		t = "…" + t[len(t)-600:]
	}
	return s.secrets.Clean(t)
}

type runner struct {
	d    Deps
	emit Emit
	red  *Redactor
	seq  int
}

func (r *runner) ev(step, status, msg, hint string) {
	r.seq++
	r.emit(Event{Seq: r.seq, Step: step, Status: status, Msg: r.red.Clean(msg), Hint: r.red.Clean(hint)})
}

func (r *runner) fail(err error) error {
	var se *StepError
	if errors.As(err, &se) {
		r.ev(se.Step, "error", se.Msg, se.Hint)
		return &StepError{Step: se.Step, Msg: r.red.Clean(se.Msg), Hint: r.red.Clean(se.Hint)}
	}
	r.ev("geral", "error", err.Error(), "")
	return &StepError{Step: "geral", Msg: r.red.Clean(err.Error())}
}

func (r *runner) connect(ctx context.Context, p Params) (*session, error) {
	r.ev("connect", "running", "Conectando em "+p.Host+" (SSH)…", "")
	rem, err := r.d.Dial(ctx, p.conn())
	if err != nil {
		var hk *HostKeyError
		hint := "Confira o IP, a porta, o usuário e a senha/chave."
		if errors.As(err, &hk) {
			hint = "Se você reinstalou o servidor, a chave muda: confirme a nova impressão digital na tela anterior. Se não, alguém pode estar no meio do caminho."
		}
		return nil, &StepError{Step: "connect", Msg: err.Error(), Hint: hint}
	}
	r.ev("connect", "ok", "Conectado. Impressão digital confere com a que você confirmou.", "")
	return &session{r: rem, user: p.User, password: p.Password, secrets: r.red}, nil
}

func hostIPs(ctx context.Context, d Deps, host string) (v4, v6 string, err error) {
	var ips []string
	if net.ParseIP(host) != nil {
		ips = []string{host}
	} else {
		ips, err = d.Net.LookupHost(ctx, host)
		if err != nil {
			return "", "", fmt.Errorf("não consegui descobrir o IP de %s", host)
		}
	}
	for _, s := range ips {
		ip := net.ParseIP(s)
		if ip == nil {
			continue
		}
		if ip.To4() != nil {
			if v4 == "" {
				v4 = ip.String()
			}
		} else if v6 == "" {
			v6 = ip.String()
		}
	}
	if v4 == "" && v6 == "" {
		return "", "", errors.New("o servidor não tem IP")
	}
	return v4, v6, nil
}

// Install executa (ou retoma) a instalação completa. É idempotente: cada passo
// confere o estado do servidor antes de agir.
func Install(ctx context.Context, d Deps, p Params, emit Emit) (*Outcome, error) {
	red := NewRedactor(p.Secrets()...)
	r := &runner{d: d, emit: emit, red: red}
	out, err := r.install(ctx, p)
	if err != nil {
		return nil, r.fail(err)
	}
	return out, nil
}

func (r *runner) install(ctx context.Context, p Params) (*Outcome, error) {
	d := r.d
	if err := p.ValidateInstall(d.Studio.PhoneConfigured()); err != nil {
		return nil, &StepError{Step: "connect", Msg: err.Error()}
	}
	p.Domain = NormalizeDomain(p.Domain)
	s, err := r.connect(ctx, p)
	if err != nil {
		return nil, err
	}
	defer s.r.Close()

	// 2. Verificação
	r.ev("preflight", "running", "Verificando se o servidor está limpo e é compatível…", "")
	pf, err := s.Check(ctx)
	if err != nil {
		return nil, &StepError{Step: "preflight", Msg: err.Error()}
	}
	if !pf.OK() {
		return nil, &StepError{Step: "preflight", Msg: "O servidor não está pronto: " + strings.Join(pf.Problems, " "),
			Hint: "Nada foi alterado no servidor. Corrija o que foi dito, ou use um VPS recém-criado."}
	}
	r.ev("preflight", "ok", fmt.Sprintf("%s, %s, acesso %s. Portas 80 e 443 livres, nenhum outro servidor web.", pf.OS, pf.Arch, sudoText(pf.Sudo)), "")

	// 3. DNS
	rec, err := r.dns(ctx, p)
	if err != nil {
		return nil, err
	}

	// 4a. Usuário de serviço e programa do proxy
	data, sha, err := d.Bins.Get(pf.Arch)
	if err != nil {
		return nil, &StepError{Step: "proxy", Msg: err.Error()}
	}
	if err := r.proxy(ctx, s, p, pf, data, sha); err != nil {
		return nil, err
	}
	// 4b. Firewall
	if err := r.firewall(ctx, s, p, pf); err != nil {
		return nil, err
	}
	// 4c. Atualizações automáticas
	if p.Unattended {
		r.ev("upgrades", "running", "Ligando as atualizações de segurança automáticas (sem reiniciar sozinho)…", "")
		if _, err := s.must(ctx, "upgrades", "Instalar unattended-upgrades", cmdUnattended()); err != nil {
			return nil, err
		}
		r.ev("upgrades", "ok", "Atualizações de segurança automáticas ligadas.", "")
	} else {
		r.ev("upgrades", "skip", "Atualizações automáticas: você optou por não ligar.", "")
	}

	// Guarda o estado (sem segredos) já aqui: se o resto falhar, "Remover" funciona.
	st := Server{Host: p.Host, Port: p.Port, User: p.User, Domain: p.Domain, ZoneID: p.ZoneID, ZoneName: p.ZoneName,
		Proxied: p.Proxied, RecordIDs: rec, Fingerprint: p.Fingerprint, ProxySHA: sha, Arch: pf.Arch,
		Unattended: p.Unattended, InstalledAt: time.Now().Format(time.RFC3339)}
	if err := d.Store.Save(st); err != nil {
		r.ev("geral", "warn", "Não consegui salvar o estado do servidor neste PC: "+err.Error(), "Atualizar e Remover vão pedir os dados de novo.")
	}
	_ = d.Store.Remember(p.Host, p.Port, p.Fingerprint)

	// 5. Pareamento
	if err := r.pair(ctx, s, p); err != nil {
		return nil, err
	}
	// 6. Certificado e teste
	if err := r.cert(ctx, s, p); err != nil {
		return nil, err
	}
	state, detail, err := r.verify(ctx, p, rec)
	if err != nil {
		return nil, err
	}
	url := "https://" + p.Domain
	qrURI, _ := QRDataURI(url)
	r.ev("done", "ok", "Pronto. No celular, abra "+url, "")
	return &Outcome{Domain: p.Domain, URL: url, QR: qrURI, Link: state, Detail: detail}, nil
}

func sudoText(m SudoMode) string {
	switch m {
	case SudoRoot:
		return "root"
	case SudoNoPass:
		return "sudo sem senha"
	case SudoPassword:
		return "sudo com a senha informada"
	}
	return "sem privilégio"
}

func (r *runner) dns(ctx context.Context, p Params) ([]string, error) {
	d := r.d
	r.ev("dns", "running", "Configurando o DNS na Cloudflare…", "")
	api := d.CF(p.CFToken)
	if err := api.VerifyToken(ctx); err != nil {
		return nil, &StepError{Step: "dns", Msg: err.Error()}
	}
	z, err := api.GetZone(ctx, p.ZoneID)
	if err != nil {
		return nil, &StepError{Step: "dns", Msg: err.Error()}
	}
	if !strings.EqualFold(z.Name, p.ZoneName) {
		return nil, &StepError{Step: "dns", Msg: "a zona escolhida não é " + p.ZoneName}
	}
	v4, v6, err := hostIPs(ctx, d, p.Host)
	if err != nil {
		return nil, &StepError{Step: "dns", Msg: err.Error()}
	}
	var ids []string
	if v4 != "" {
		o, err := EnsureRecord(ctx, api, p.ZoneID, p.Domain, "A", v4, p.Proxied)
		if err != nil {
			return nil, &StepError{Step: "dns", Msg: err.Error()}
		}
		ids = append(ids, o.RecordID)
		r.ev("dns", "info", fmt.Sprintf("Registro A %s → %s: %s.", p.Domain, v4, o.Action), "")
	}
	if v6 != "" {
		o, err := EnsureRecord(ctx, api, p.ZoneID, p.Domain, "AAAA", v6, p.Proxied)
		if err != nil {
			return nil, &StepError{Step: "dns", Msg: err.Error()}
		}
		ids = append(ids, o.RecordID)
		r.ev("dns", "info", fmt.Sprintf("Registro AAAA %s → %s: %s.", p.Domain, v6, o.Action), "")
	}
	mode := "somente DNS (nuvem cinza)"
	if p.Proxied {
		mode = "com proxy da Cloudflare (nuvem laranja)"
	}
	r.ev("dns", "ok", "DNS pronto, "+mode+".", "")
	return ids, nil
}

func (r *runner) proxy(ctx context.Context, s *session, p Params, pf Preflight, data []byte, sha string) error {
	r.ev("proxy", "running", "Instalando o bethstudio-proxy…", "")
	if _, err := s.must(ctx, "proxy", "Criar o usuário de serviço "+ProxyUser, cmdCreateUser()); err != nil {
		return err
	}
	if pf.ProxySHA == sha {
		r.ev("proxy", "info", "O programa do servidor já é esta versão; só reconfigurando o serviço.", "")
	} else {
		path, err := s.r.Upload(ctx, uploadName("proxy"), data, 0o700)
		if err != nil {
			return &StepError{Step: "proxy", Msg: err.Error()}
		}
		defer s.r.Run(ctx, "rm -f "+shQuote(path), "")
		if _, err := s.must(ctx, "proxy", "Conferir o SHA-256 do programa enviado", cmdVerifySHA(sha, path)); err != nil {
			return err
		}
		r.ev("proxy", "info", "Programa enviado e SHA-256 conferido ("+sha[:12]+"…).", "")
		if _, err := s.must(ctx, "proxy", "Parar o serviço antigo", cmdStopProxy()); err != nil {
			return err
		}
		if _, err := s.must(ctx, "proxy", "Instalar o programa", cmdInstallProxyBin(path)); err != nil {
			return err
		}
	}
	if _, err := s.must(ctx, "proxy", "Criar e iniciar o serviço bethstudio-proxy", cmdProxyService(p.Domain)); err != nil {
		return err
	}
	r.ev("proxy", "ok", "Serviço bethstudio-proxy instalado e ativo: HTTPS nas portas 80 e 443, como o usuário "+ProxyUser+" (não root).", "")
	return nil
}

// cert espera o certificado Let's Encrypt sair. O proxy o pede sozinho ao
// subir e guarda no cache em disco; o assistente só confere, por SSH, se o
// arquivo já existe. Não precisa de endpoint novo nem de segredo.
func (r *runner) cert(ctx context.Context, s *session, p Params) error {
	d := r.d
	r.ev("cert", "running", "Esperando o certificado HTTPS (Let's Encrypt) de "+p.Domain+"…", "")
	for i := 0; i < d.tries(); i++ {
		res, err := s.priv(ctx, cmdCertReady(p.Domain))
		if err == nil && res.Code == 0 && strings.Contains(res.Stdout, "ready") {
			r.ev("cert", "ok", "Certificado emitido e guardado no servidor. A renovação é automática.", "")
			return nil
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		d.sleep(d.interval())
	}
	hint := "O servidor não registrou o certificado."
	if res, err := s.priv(ctx, cmdProxyLogsShort()); err == nil {
		if t := strings.TrimSpace(res.Stdout); t != "" {
			hint = "Últimas linhas do serviço:\n" + s.secrets.Clean(t)
		}
	}
	return &StepError{Step: "cert", Msg: "O certificado ainda não saiu",
		Hint: hint + "\nConfira: o nome " + p.Domain + " aponta para este servidor (DNS, sem a nuvem laranja) e as portas 80 e 443 estão abertas no firewall do provedor. O serviço tenta de novo sozinho; rode o assistente de novo para refazer o teste."}
}

func (r *runner) firewall(ctx context.Context, s *session, p Params, pf Preflight) error {
	ports := []int{p.Port}
	for _, sp := range pf.SSHPorts {
		if sp != p.Port {
			ports = append(ports, sp)
		}
	}
	r.ev("firewall", "running", "Configurando o firewall (ufw): SSH primeiro, depois 80 e 443…", "")
	if _, err := s.must(ctx, "firewall", "Configurar o ufw", cmdFirewall(ports)); err != nil {
		return err
	}
	r.ev("firewall", "ok", "Firewall ligado: só as portas "+portsText(ports)+", 80 e 443 ficam abertas.", "")
	return nil
}

func portsText(ps []int) string {
	var b []string
	for _, p := range ps {
		b = append(b, fmt.Sprint(p))
	}
	return strings.Join(b, ", ")
}

func (r *runner) pair(ctx context.Context, s *session, p Params) error {
	r.ev("pair", "running", "Lendo o código de pareamento do servidor…", "")
	res, err := s.must(ctx, "pair", "Ler o segredo da ligação", cmdLinkSec)
	if err != nil {
		// o stderr de um cat não tem segredo, mas por segurança nada da saída vai à tela
		return &StepError{Step: "pair", Msg: "Não consegui ler o código de pareamento do servidor"}
	}
	secret := strings.TrimSpace(res.Stdout)
	if len(secret) < 32 || strings.ContainsAny(secret, " \r\n\x00") {
		return &StepError{Step: "pair", Msg: "O código de pareamento lido do servidor é inválido"}
	}
	r.red.Add(secret)
	if err := r.d.Studio.ApplyPairing(p.Domain, secret, p.PhonePassword); err != nil {
		return &StepError{Step: "pair", Msg: "Não consegui salvar o pareamento neste Studio: " + err.Error()}
	}
	r.ev("pair", "ok", "Este Studio já está pareado com "+p.Domain+".", "")
	return nil
}

func (r *runner) verify(ctx context.Context, p Params, _ []string) (string, string, error) {
	d := r.d
	r.ev("verify", "running", "Testando de ponta a ponta (DNS, HTTPS, proxy, ligação)…", "")
	// DNS
	ok := false
	for i := 0; i < d.tries(); i++ {
		if ips, err := d.Net.LookupHost(ctx, p.Domain); err == nil && len(ips) > 0 {
			ok = true
			break
		}
		if ctx.Err() != nil {
			return "", "", ctx.Err()
		}
		d.sleep(d.interval())
	}
	if !ok {
		return "", "", &StepError{Step: "verify", Msg: "O nome " + p.Domain + " ainda não resolve neste PC",
			Hint: "O DNS pode demorar alguns minutos. Rode o assistente de novo para só refazer o teste."}
	}
	r.ev("verify", "info", "DNS resolve.", "")
	// HTTPS
	status := 0
	var herr error
	for i := 0; i < d.tries(); i++ {
		status, herr = d.Net.GetHTTPS(ctx, p.Domain)
		if herr == nil && (status < 500 || status == 503) {
			break
		}
		if ctx.Err() != nil {
			return "", "", ctx.Err()
		}
		d.sleep(d.interval())
	}
	if herr != nil || !(status < 500 || status == 503) {
		hint := "O certificado já saiu no servidor, mas este PC ainda não vê o HTTPS válido. Confira o DNS e rode de novo para refazer o teste; veja \"Ver estado e logs\"."
		msg := "HTTPS ainda não responde direito"
		if herr != nil {
			msg += ": " + herr.Error()
		} else {
			msg += fmt.Sprintf(" (HTTP %d)", status)
		}
		return "", "", &StepError{Step: "verify", Msg: msg, Hint: hint}
	}
	r.ev("verify", "info", "HTTPS válido e o proxy responde.", "")
	// Ligação
	state, detail := "", ""
	for i := 0; i < d.tries(); i++ {
		state, detail = d.Studio.LinkState()
		if state == "up" {
			break
		}
		d.sleep(d.interval() / 2)
	}
	if state != "up" {
		return "", "", &StepError{Step: "verify", Msg: "A ligação deste PC com o servidor não subiu (" + state + ")", Hint: detail}
	}
	r.ev("verify", "ok", "Ligação PC ↔ servidor: no ar.", "")
	return state, detail, nil
}

// LoadedServer devolve o servidor salvo ou um erro amigável.
func LoadedServer(st *Store) (*Server, error) {
	sv, err := st.Load()
	if err != nil {
		return nil, err
	}
	if sv == nil {
		return nil, errors.New("nenhum servidor instalado por este assistente")
	}
	return sv, nil
}

// actionParams monta a conexão de uma ação posterior (atualizar, estado, remover).
func (p Params) forServer(sv *Server) Params {
	p.Host, p.Port, p.User = sv.Host, sv.Port, sv.User
	p.Fingerprint = sv.Fingerprint
	return p
}

func (r *runner) open(ctx context.Context, p Params) (*session, *Server, error) {
	sv, err := LoadedServer(r.d.Store)
	if err != nil {
		return nil, nil, &StepError{Step: "connect", Msg: err.Error()}
	}
	if p.Password == "" && strings.TrimSpace(p.PrivateKey) == "" {
		return nil, nil, &StepError{Step: "connect", Msg: "informe a senha ou a chave privada do servidor"}
	}
	p = p.forServer(sv)
	s, err := r.connect(ctx, p)
	if err != nil {
		return nil, nil, err
	}
	var pf Preflight
	if err := s.detectSudo(ctx, &pf); err != nil {
		s.r.Close()
		return nil, nil, &StepError{Step: "connect", Msg: err.Error()}
	}
	if s.mode == SudoNone {
		s.r.Close()
		return nil, nil, &StepError{Step: "connect", Msg: "o usuário não tem privilégio (root ou sudo)", Hint: "Informe a senha do usuário para usar sudo."}
	}
	return s, sv, nil
}

// Update envia o binário embutido, se for diferente, e reinicia o serviço.
func Update(ctx context.Context, d Deps, p Params, emit Emit) error {
	r := &runner{d: d, emit: emit, red: NewRedactor(p.Secrets()...)}
	err := r.update(ctx, p)
	if err != nil {
		return r.fail(err)
	}
	return nil
}

func (r *runner) update(ctx context.Context, p Params) error {
	s, sv, err := r.open(ctx, p)
	if err != nil {
		return err
	}
	defer s.r.Close()
	data, sha, err := r.d.Bins.Get(sv.Arch)
	if err != nil {
		return &StepError{Step: "proxy", Msg: err.Error()}
	}
	cur, _ := s.r.Run(ctx, cmdProxySHA, "")
	pf := Preflight{ProxySHA: strings.TrimSpace(cur.Stdout)}
	if pf.ProxySHA == sha {
		r.ev("proxy", "ok", "O servidor já tem a versão mais nova do programa.", "")
		return nil
	}
	if err := r.proxy(ctx, s, Params{Domain: sv.Domain}, pf, data, sha); err != nil {
		return err
	}
	sv.ProxySHA = sha
	_ = r.d.Store.Save(*sv)
	r.ev("done", "ok", "Servidor atualizado.", "")
	return nil
}

// Status devolve o estado dos serviços e os últimos registros (logs) do servidor.
func Status(ctx context.Context, d Deps, p Params, logs bool, emit Emit) (string, error) {
	r := &runner{d: d, emit: emit, red: NewRedactor(p.Secrets()...)}
	s, _, err := r.open(ctx, p)
	if err != nil {
		return "", r.fail(err)
	}
	defer s.r.Close()
	script := cmdStatus()
	if logs {
		script = cmdLogs()
	}
	res, err := s.priv(ctx, script)
	if err != nil {
		return "", r.fail(&StepError{Step: "status", Msg: err.Error()})
	}
	out := r.red.Clean(res.Stdout + res.Stderr)
	r.ev("done", "ok", "Pronto.", "")
	return out, nil
}

// Remove desfaz a instalação: serviço, programa, dados do proxy (certificados
// incluídos), usuário de serviço e os registros DNS que o assistente criou.
func Remove(ctx context.Context, d Deps, p Params, emit Emit) error {
	r := &runner{d: d, emit: emit, red: NewRedactor(p.Secrets()...)}
	if err := r.remove(ctx, p); err != nil {
		return r.fail(err)
	}
	return nil
}

func (r *runner) remove(ctx context.Context, p Params) error {
	s, sv, err := r.open(ctx, p)
	if err != nil {
		return err
	}
	defer s.r.Close()
	r.ev("remove", "running", "Removendo o serviço, o programa, os dados e o usuário de serviço do Beth…", "")
	if _, err := s.must(ctx, "remove", "Remover do servidor", cmdRemove()); err != nil {
		return err
	}
	r.ev("remove", "ok", "Servidor limpo do Beth. O ufw e os pacotes continuam instalados e as portas abertas continuam abertas (não apago pacotes nem mexo no firewall).", "")
	if strings.TrimSpace(p.CFToken) != "" {
		r.ev("dns", "running", "Removendo os registros DNS criados pelo assistente…", "")
		api := r.d.CF(p.CFToken)
		n, err := RemoveWizardRecords(ctx, api, sv.ZoneID, sv.Domain, sv.RecordIDs)
		if err != nil {
			return &StepError{Step: "dns", Msg: err.Error(), Hint: "O servidor já foi limpo. Apague o registro à mão na Cloudflare se precisar."}
		}
		r.ev("dns", "ok", fmt.Sprintf("%d registro(s) DNS do assistente removido(s). Os outros não foram tocados.", n), "")
	} else {
		r.ev("dns", "skip", "Sem token da Cloudflare: os registros DNS ficaram como estão.", "Apague o registro "+sv.Domain+" na Cloudflare se quiser.")
	}
	if err := r.d.Studio.ClearPairing(); err != nil {
		r.ev("pair", "warn", "Não consegui limpar o pareamento deste Studio: "+err.Error(), "")
	} else {
		r.ev("pair", "ok", "Pareamento deste Studio removido.", "")
	}
	if err := r.d.Store.Clear(); err != nil {
		r.ev("geral", "warn", "Não consegui apagar o registro local do servidor: "+err.Error(), "")
	}
	r.ev("done", "ok", "Servidor removido.", "")
	return nil
}

// PlanStep é uma linha de "Ver o que será feito".
type PlanStep struct {
	ID       string   `json:"id"`
	Title    string   `json:"title"`
	Detail   string   `json:"detail"`
	Commands []string `json:"commands,omitempty"`
}

// Plan descreve a instalação sem executar nada. Os comandos são os mesmos que rodam.
func Plan(p Params) []PlanStep {
	domain := NormalizeDomain(p.Domain)
	dnsMode := "somente DNS (nuvem cinza)"
	steps := []PlanStep{
		{ID: "connect", Title: "Conectar por SSH", Detail: "Confere que a impressão digital é a que você confirmou. Nada é aceito às cegas."},
		{ID: "preflight", Title: "Verificar o servidor (só leitura)", Detail: "Debian 11/12/13 ou Ubuntu 22.04/24.04/26.04, amd64 ou arm64, systemd, root ou sudo, portas 80/443 livres, sem nginx/apache/Caddy/Docker no meio. Se algo não servir, para e explica; não apaga nada.",
			Commands: []string{cmdOSRelease, cmdArch, cmdPorts, cmdServices}},
		{ID: "dns", Title: "Cloudflare: registro DNS", Detail: "Cria ou atualiza " + domain + " (A, e AAAA se o servidor tiver IPv6) " + dnsMode + " (a nuvem laranja não é usada: atrapalharia o certificado). Só mexe em registros marcados com \"" + WizardComment + "\"."},
		{ID: "proxy", Title: "Instalar o bethstudio-proxy", Detail: "Cria o usuário de serviço " + ProxyUser + " (sem shell), envia o programa embutido neste Studio por SFTP, confere o SHA-256 no servidor e cria o serviço systemd. O programa atende HTTPS sozinho nas portas 80 e 443, sem root (só a permissão de abrir essas portas). Nenhum outro programa é instalado no servidor.",
			Commands: []string{cmdCreateUser(), cmdVerifySHA("<sha256>", "<arquivo enviado>"), cmdStopProxy(), cmdInstallProxyBin("<arquivo enviado>"), cmdProxyService(domain)}},
		{ID: "firewall", Title: "Firewall (ufw)", Detail: "Libera a porta do SSH antes de ligar, depois 80 e 443. O resto fica fechado.",
			Commands: []string{cmdFirewall([]int{p.Port})}},
	}
	if p.Unattended {
		steps = append(steps, PlanStep{ID: "upgrades", Title: "Atualizações de segurança automáticas", Detail: "unattended-upgrades, sem reiniciar sozinho.", Commands: []string{cmdUnattended()}})
	}
	steps = append(steps,
		PlanStep{ID: "cert", Title: "Esperar o certificado HTTPS", Detail: "O serviço pede o certificado à Let's Encrypt sozinho (desafio nas portas 80/443) e o guarda em " + ProxyData + "/certs. O assistente só confere se o arquivo apareceu.", Commands: []string{cmdCertReady(domain)}},
		PlanStep{ID: "pair", Title: "Parear este Studio", Detail: "Lê o segredo da ligação do servidor e salva neste Studio (cofre do Windows). O segredo nunca aparece na tela nem em log.", Commands: []string{cmdLinkSec}},
		PlanStep{ID: "verify", Title: "Teste de ponta a ponta", Detail: "DNS resolve, HTTPS com certificado válido visto deste PC, o proxy responde e a ligação PC↔servidor sobe."},
	)
	return steps
}
