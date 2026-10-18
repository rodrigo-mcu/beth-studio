package vpsinstall

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

const (
	testSSHPass   = "SENHA-ssh-9f3k"
	testPhonePass = "senha-celular-77"
	testLinkSec   = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
)

// fakeVPS simula um servidor Debian/Ubuntu: responde aos comandos fixos do
// assistente e mantém o estado (proxy instalado, Caddy instalado…).
type fakeVPS struct {
	mu           sync.Mutex
	osrel        string
	uname        string
	uid          string
	sudoNopw     bool // sudo -n funciona
	sudoPass     string
	ports        []string // linhas extras do ss
	services     string
	caddyForeign bool
	proxySHA     string
	caddyInst    bool
	failOn       string // substring: o próximo comando que a contiver falha (uma vez)
	failErr      string
	cmds         []string
	stdins       []string
	uploads      map[string][]byte
	lastSHA      string
	sshdPort     int
}

func newFakeVPS() *fakeVPS {
	return &fakeVPS{
		osrel:    "NAME=\"Ubuntu\"\nID=ubuntu\nVERSION_ID=\"24.04\"\n",
		uname:    "x86_64\n",
		uid:      "0\n",
		services: "inactive\ninactive\ninactive\ninactive\ninactive\n",
		uploads:  map[string][]byte{},
		sshdPort: 22,
	}
}

func (f *fakeVPS) listeners() string {
	var b strings.Builder
	b.WriteString("LISTEN 0 128 0.0.0.0:" + strconv.Itoa(f.sshdPort) + " 0.0.0.0:* users:((\"sshd\",pid=1,fd=3))\n")
	b.WriteString("LISTEN 0 4096 127.0.0.53%lo:53 0.0.0.0:* users:((\"systemd-resolve\",pid=2,fd=14))\n")
	for _, p := range f.ports {
		b.WriteString(p + "\n")
	}
	if f.proxySHA != "" {
		b.WriteString("LISTEN 0 4096 127.0.0.1:8787 0.0.0.0:* users:((\"bethstudio-proxy\",pid=9,fd=3))\n")
	}
	if f.caddyInst {
		b.WriteString("LISTEN 0 4096 *:80 *:* users:((\"caddy\",pid=7,fd=3))\nLISTEN 0 4096 *:443 *:* users:((\"caddy\",pid=7,fd=4))\n")
	}
	return b.String()
}

func (f *fakeVPS) Run(_ context.Context, cmd string, stdin string) (Result, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.cmds = append(f.cmds, cmd)
	f.stdins = append(f.stdins, stdin)
	if f.failOn != "" && strings.Contains(cmd, f.failOn) {
		f.failOn = ""
		return Result{Stderr: f.failErr, Code: 1}, nil
	}
	has := func(s string) bool { return strings.Contains(cmd, s) }
	ok := func(out string) (Result, error) { return Result{Stdout: out}, nil }
	// sudo
	if strings.HasPrefix(cmd, "sudo -S") && stdin != f.sudoPass+"\n" {
		return Result{Stderr: "sudo: incorrect password", Code: 1}, nil
	}
	if cmd == "sudo -n true" {
		if f.sudoNopw {
			return ok("")
		}
		return Result{Code: 1}, nil
	}
	switch {
	case cmd == "cat /etc/os-release":
		return ok(f.osrel)
	case cmd == "uname -m":
		return ok(f.uname)
	case cmd == "id -u":
		return ok(f.uid)
	case strings.HasPrefix(cmd, "test -d /run/systemd"):
		return ok("")
	case has("ss -H -ltnp"):
		return ok(f.listeners())
	case has("systemctl is-active nginx"):
		return ok(f.services)
	case has("caddy=$v"):
		switch {
		case f.caddyForeign:
			return ok("caddy=1 ours=0 marker=0\n")
		case f.caddyInst:
			return ok("caddy=1 ours=0 marker=1\n")
		}
		return ok("caddy=0 ours=0 marker=0\n")
	case has("sha256sum " + ProxyBin):
		return ok(f.proxySHA + "\n")
	case has("sha256sum -c -"):
		return ok("ok\n")
	case has("install -m 0755"):
		f.proxySHA = f.lastSHA
	case has("install -y -qq caddy"):
		f.caddyInst = true
	case has("link-secret"):
		return ok(testLinkSec + "\n")
	case has("rm -rf " + ProxyData):
		f.proxySHA = ""
	}
	return ok("")
}

func (f *fakeVPS) Upload(_ context.Context, name string, data []byte, _ os.FileMode) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.uploads[name] = data
	if strings.Contains(name, "proxy") {
		h := sha256.Sum256(data)
		f.lastSHA = hex.EncodeToString(h[:])
	}
	return "/home/u/" + name, nil
}

func (f *fakeVPS) Close() error { return nil }

func (f *fakeVPS) ran(sub string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, c := range f.cmds {
		if strings.Contains(c, sub) {
			return true
		}
	}
	return false
}

func (f *fakeVPS) index(sub string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i, c := range f.cmds {
		if strings.Contains(c, sub) {
			return i
		}
	}
	return -1
}

type fakeBins struct{ data []byte }

func (b fakeBins) Get(arch string) ([]byte, string, error) {
	if arch == "" {
		return nil, "", errors.New("sem arch")
	}
	h := sha256.Sum256(b.data)
	return b.data, hex.EncodeToString(h[:]), nil
}

type fakeStudio struct {
	configured bool
	domain     string
	secret     string
	password   string
	link       string
	cleared    bool
}

func (s *fakeStudio) PhoneConfigured() bool { return s.configured }
func (s *fakeStudio) ApplyPairing(domain, secret, pw string) error {
	s.domain, s.secret, s.password, s.configured = domain, secret, pw, true
	return nil
}
func (s *fakeStudio) LinkState() (string, string) { return s.link, "" }
func (s *fakeStudio) ClearPairing() error         { s.cleared, s.configured = true, false; return nil }

type fakeNet struct {
	ips    []string
	status int
	err    error
}

func (n fakeNet) LookupHost(context.Context, string) ([]string, error) { return n.ips, nil }
func (n fakeNet) GetHTTPS(context.Context, string) (int, error)        { return n.status, n.err }

type harness struct {
	t      *testing.T
	vps    *fakeVPS
	cf     *fakeCF
	studio *fakeStudio
	net    fakeNet
	deps   Deps
	events []Event
	params Params
}

func newHarness(t *testing.T) *harness {
	h := &harness{t: t, vps: newFakeVPS(), cf: newFakeCF(t), studio: &fakeStudio{link: "up"},
		net: fakeNet{ips: []string{"203.0.113.9"}, status: 200}}
	h.rebuild()
	h.params = Params{
		Host: "203.0.113.9", Port: 22, User: "root", Password: testSSHPass, Fingerprint: "SHA256:abc",
		Domain: "agentes.exemplo.com", ZoneID: "aaa111", ZoneName: "exemplo.com", CFToken: testToken,
		PhonePassword: testPhonePass, Unattended: true,
	}
	return h
}

func (h *harness) rebuild() {
	h.deps = Deps{
		Dial: func(_ context.Context, p ConnParams) (Remote, error) {
			if p.Fingerprint == "" {
				return nil, errors.New("sem fingerprint")
			}
			return h.vps, nil
		},
		CF:       func(tok string) CFAPI { return NewCloudflare(tok, h.cf.srv.URL, h.cf.srv.Client()) },
		Studio:   h.studio,
		Net:      h.net,
		Store:    &Store{Dir: h.t.TempDir()},
		Bins:     fakeBins{data: []byte("ELF-fake-proxy")},
		Sleep:    func(time.Duration) {},
		Tries:    2,
		Interval: time.Millisecond,
	}
}

func (h *harness) emit(e Event) { h.events = append(h.events, e) }

func (h *harness) install() (*Outcome, error) {
	return Install(context.Background(), h.deps, h.params, h.emit)
}

func (h *harness) allText() string {
	var b strings.Builder
	for _, e := range h.events {
		b.WriteString(e.Step + "|" + e.Status + "|" + e.Msg + "|" + e.Hint + "\n")
	}
	return b.String()
}

func (h *harness) noSecrets(extra ...string) {
	h.t.Helper()
	text := h.allText()
	for _, s := range append([]string{testSSHPass, testToken, testPhonePass, testLinkSec}, extra...) {
		if strings.Contains(text, s) {
			h.t.Fatalf("segredo %q apareceu nos eventos:\n%s", s, text)
		}
	}
}

func (h *harness) stepStatus(step, status string) bool {
	for _, e := range h.events {
		if e.Step == step && e.Status == status {
			return true
		}
	}
	return false
}

func TestInstallCaminhoFeliz(t *testing.T) {
	h := newHarness(t)
	out, err := h.install()
	if err != nil {
		t.Fatalf("%v\n%s", err, h.allText())
	}
	if out.URL != "https://agentes.exemplo.com" || !strings.HasPrefix(out.QR, "data:image/png;base64,") || out.Link != "up" {
		t.Fatalf("%+v", out)
	}
	for _, s := range []string{"connect", "preflight", "dns", "proxy", "caddy", "firewall", "upgrades", "pair", "verify"} {
		if !h.stepStatus(s, "ok") {
			t.Errorf("passo %s sem ok:\n%s", s, h.allText())
		}
	}
	if len(h.cf.records) != 1 || h.cf.records[0].Comment != WizardComment || h.cf.records[0].Proxied || h.cf.records[0].Content != "203.0.113.9" {
		t.Fatalf("DNS: %+v", h.cf.records)
	}
	if h.studio.domain != "agentes.exemplo.com" || h.studio.secret != testLinkSec || h.studio.password != testPhonePass {
		t.Fatalf("pareamento: %+v", h.studio)
	}
	if string(h.vps.uploads[uploadName("caddyfile")]) != Caddyfile("agentes.exemplo.com") {
		t.Fatal("Caddyfile enviado diferente do esperado")
	}
	// firewall: libera o SSH antes de ligar
	var fw string
	for _, c := range h.vps.cmds {
		if strings.Contains(c, "ufw --force enable") {
			fw = c
		}
	}
	if fw == "" || strings.Index(fw, "ufw allow 22/tcp") < 0 || strings.Index(fw, "ufw allow 22/tcp") > strings.Index(fw, "ufw --force enable") {
		t.Fatalf("o SSH precisa ser liberado antes do enable: %q", fw)
	}
	sv, _ := h.deps.Store.Load()
	if sv == nil || sv.Domain != "agentes.exemplo.com" || len(sv.RecordIDs) != 1 || sv.Arch != "amd64" {
		t.Fatalf("estado: %+v", sv)
	}
	raw, _ := os.ReadFile(h.deps.Store.Dir + "/vps-server.json")
	for _, s := range []string{testSSHPass, testToken, testPhonePass, testLinkSec} {
		if strings.Contains(string(raw), s) {
			t.Fatalf("segredo em disco: %s", s)
		}
	}
	h.noSecrets()
}

func TestInstallServidorSujoPorta80(t *testing.T) {
	h := newHarness(t)
	h.vps.ports = []string{"LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:((\"nginx\",pid=5,fd=6))"}
	_, err := h.install()
	if err == nil || !strings.Contains(err.Error(), "porta 80") || !strings.Contains(err.Error(), "nginx") {
		t.Fatalf("%v", err)
	}
	if h.vps.ran("apt-get") || h.vps.ran("install -m") || h.vps.ran("ufw") || h.vps.ran("rm ") {
		t.Fatalf("não podia alterar nada: %v", h.vps.cmds)
	}
	if len(h.cf.records) != 0 {
		t.Fatal("DNS não deveria ter sido criado")
	}
	if !h.stepStatus("preflight", "error") {
		t.Fatal(h.allText())
	}
}

func TestInstallDockerProxyEServicoWeb(t *testing.T) {
	h := newHarness(t)
	h.vps.ports = []string{"LISTEN 0 4096 *:443 *:* users:((\"docker-proxy\",pid=5,fd=6))"}
	h.vps.services = "active\ninactive\ninactive\ninactive\ninactive\n"
	_, err := h.install()
	if err == nil || !strings.Contains(err.Error(), "Docker") || !strings.Contains(err.Error(), "nginx") {
		t.Fatalf("%v", err)
	}
}

func TestInstallDistroNaoSuportada(t *testing.T) {
	h := newHarness(t)
	h.vps.osrel = "ID=ubuntu\nVERSION_ID=\"18.04\"\n"
	_, err := h.install()
	if err == nil || !strings.Contains(err.Error(), "não suportado") {
		t.Fatalf("%v", err)
	}
	h2 := newHarness(t)
	h2.vps.uname = "armv7l\n"
	if _, err := h2.install(); err == nil || !strings.Contains(err.Error(), "Arquitetura") {
		t.Fatalf("%v", err)
	}
	h3 := newHarness(t)
	h3.vps.osrel = "ID=fedora\nVERSION_ID=40\n"
	if _, err := h3.install(); err == nil {
		t.Fatal("fedora deveria ser recusado")
	}
}

func TestInstallCaddyAlheio(t *testing.T) {
	h := newHarness(t)
	h.vps.caddyForeign = true
	_, err := h.install()
	if err == nil || !strings.Contains(err.Error(), "Caddy") || h.vps.ran("apt-get") {
		t.Fatalf("%v", err)
	}
}

func TestInstallFalhaNoMeioERetomada(t *testing.T) {
	h := newHarness(t)
	h.vps.failOn = "caddy validate"
	h.vps.failErr = "Error: parsing caddyfile"
	_, err := h.install()
	if err == nil || !strings.Contains(err.Error(), "Validar a configuração do Caddy") {
		t.Fatalf("%v", err)
	}
	if !h.stepStatus("caddy", "error") {
		t.Fatal(h.allText())
	}
	if len(h.cf.records) != 1 {
		t.Fatalf("DNS deveria existir uma vez: %+v", h.cf.records)
	}
	// segunda rodada: continua de onde parou, sem duplicar
	h.events = nil
	out, err := h.install()
	if err != nil {
		t.Fatalf("retomada: %v\n%s", err, h.allText())
	}
	if out == nil || len(h.cf.records) != 1 {
		t.Fatalf("DNS duplicado: %+v", h.cf.records)
	}
	txt := h.allText()
	if !strings.Contains(txt, "já foi instalado por este assistente") || !strings.Contains(txt, "já é esta versão") {
		t.Fatalf("a retomada deveria reaproveitar o que existe:\n%s", txt)
	}
	// o apt do Caddy rodou uma vez só
	n := 0
	for _, c := range h.vps.cmds {
		if strings.Contains(c, "install -y -qq caddy") {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("Caddy instalado %d vezes", n)
	}
}

func TestInstallRegistroDNSAlheioPara(t *testing.T) {
	h := newHarness(t)
	h.cf.records = []Record{{ID: "00ab", Type: "A", Name: "agentes.exemplo.com", Content: "198.51.100.1"}}
	_, err := h.install()
	if err == nil || !strings.Contains(err.Error(), "não foi criado por este assistente") {
		t.Fatalf("%v", err)
	}
	if h.cf.records[0].Content != "198.51.100.1" {
		t.Fatal("registro alheio alterado")
	}
	if h.vps.ran("apt-get") || h.vps.ran("install -m") {
		t.Fatal("nada deveria ser instalado se o DNS não pôde ser feito")
	}
}

func TestInstallTokenSemPermissao(t *testing.T) {
	h := newHarness(t)
	h.cf.denyDNS = true
	_, err := h.install()
	if err == nil || !strings.Contains(err.Error(), "DNS → Edit") {
		t.Fatalf("%v", err)
	}
	h2 := newHarness(t)
	h2.params.CFToken = "token-errado-XYZ"
	_, err = h2.install()
	if err == nil || strings.Contains(h2.allText(), "token-errado-XYZ") {
		t.Fatalf("%v", err)
	}
}

func TestInstallZonaInexistente(t *testing.T) {
	h := newHarness(t)
	h.params.ZoneID = "bbb222"
	_, err := h.install()
	if err == nil || !strings.Contains(err.Error(), "não encontrou") {
		t.Fatalf("%v", err)
	}
}

func TestInstallSudoComSenhaNaoVazaSegredos(t *testing.T) {
	h := newHarness(t)
	h.params.User = "ubuntu"
	h.params.Password = testSSHPass
	h.vps.uid = "1000\n"
	h.vps.sudoPass = testSSHPass
	h.vps.failOn = "install -y -qq caddy"
	h.vps.failErr = "E: falha, a senha " + testSSHPass + " apareceu na saída, token " + testToken
	_, err := h.install()
	if err == nil {
		t.Fatal("deveria falhar no apt")
	}
	if strings.Contains(err.Error(), testSSHPass) || strings.Contains(err.Error(), testToken) {
		t.Fatalf("segredo no erro devolvido: %v", err)
	}
	h.noSecrets()
	// os comandos privilegiados levaram a senha do sudo só no stdin
	found := false
	for i, c := range h.vps.cmds {
		if strings.HasPrefix(c, "sudo -S") {
			found = true
			if h.vps.stdins[i] != testSSHPass+"\n" {
				t.Fatal("stdin do sudo errado")
			}
		}
		if strings.Contains(c, testSSHPass) {
			t.Fatalf("senha na linha de comando: %q", c)
		}
	}
	if !found {
		t.Fatal("deveria ter usado sudo -S")
	}
}

func TestInstallSemSudo(t *testing.T) {
	h := newHarness(t)
	h.params.User = "ubuntu"
	h.vps.uid = "1000\n"
	h.params.Password = "outra-senha-errada"
	h.vps.sudoPass = "diferente"
	_, err := h.install()
	if err == nil || !strings.Contains(err.Error(), "sudo") {
		t.Fatalf("%v", err)
	}
	if h.vps.ran("apt-get") {
		t.Fatal("não deveria instalar")
	}
}

func TestInstallSenhaDoCelularObrigatoria(t *testing.T) {
	h := newHarness(t)
	h.params.PhonePassword = ""
	if _, err := h.install(); err == nil || !strings.Contains(err.Error(), "senha do celular") {
		t.Fatalf("%v", err)
	}
	h.studio.configured = true
	if _, err := h.install(); err != nil {
		t.Fatalf("já configurado, sem senha nova: %v", err)
	}
}

func TestInstallTesteFinalFalha(t *testing.T) {
	h := newHarness(t)
	h.net.status = 502
	h.rebuild()
	_, err := h.install()
	if err == nil || !strings.Contains(err.Error(), "HTTPS") {
		t.Fatalf("%v", err)
	}
	h2 := newHarness(t)
	h2.params.Proxied = true
	h2.net = fakeNet{ips: []string{"104.16.0.1"}, err: errors.New("stopped after 10 redirects")}
	h2.rebuild()
	_, err = h2.install()
	var se *StepError
	if !errors.As(err, &se) || !strings.Contains(se.Hint, "Full (strict)") {
		t.Fatalf("%v", err)
	}
	h3 := newHarness(t)
	h3.studio.link = "down"
	if _, err := h3.install(); err == nil || !strings.Contains(err.Error(), "ligação") {
		t.Fatalf("%v", err)
	}
}

func TestPlanNaoTemSegredos(t *testing.T) {
	h := newHarness(t)
	steps := Plan(h.params)
	var b strings.Builder
	for _, s := range steps {
		b.WriteString(s.Title + s.Detail + strings.Join(s.Commands, "\n"))
	}
	for _, s := range []string{testSSHPass, testToken, testPhonePass} {
		if strings.Contains(b.String(), s) {
			t.Fatalf("segredo no plano: %s", s)
		}
	}
	if len(steps) < 8 || !strings.Contains(b.String(), "reverse_proxy 127.0.0.1:8787") {
		t.Fatalf("plano incompleto: %d", len(steps))
	}
}

func TestUpdateStatusRemove(t *testing.T) {
	h := newHarness(t)
	if _, err := h.install(); err != nil {
		t.Fatal(err)
	}
	// um registro DNS de outra pessoa na mesma zona não pode ser tocado
	h.cf.records = append(h.cf.records, Record{ID: "00cd", Type: "A", Name: "outro.exemplo.com", Content: "9.9.9.9"})

	// atualizar: mesmo binário = nada a enviar
	h.events = nil
	ap := Params{Password: testSSHPass}
	if err := Update(context.Background(), h.deps, ap, h.emit); err != nil || !strings.Contains(h.allText(), "versão mais nova") {
		t.Fatalf("%v\n%s", err, h.allText())
	}
	// binário novo no Studio
	h.deps.Bins = fakeBins{data: []byte("ELF-nova-versao")}
	h.events = nil
	if err := Update(context.Background(), h.deps, ap, h.emit); err != nil {
		t.Fatalf("%v\n%s", err, h.allText())
	}
	if !h.vps.ran("systemctl stop bethstudio-proxy") || !h.vps.ran("systemctl restart bethstudio-proxy") {
		t.Fatal("deveria parar, instalar e reiniciar")
	}
	sv, _ := h.deps.Store.Load()
	h2 := sha256.Sum256([]byte("ELF-nova-versao"))
	if sv.ProxySHA != hex.EncodeToString(h2[:]) {
		t.Fatal("estado não registrou a nova versão")
	}

	txt, err := Status(context.Background(), h.deps, ap, false, h.emit)
	if err != nil || txt != "" && strings.Contains(txt, testSSHPass) {
		t.Fatalf("%q %v", txt, err)
	}

	// remover
	h.events = nil
	rp := Params{Password: testSSHPass, CFToken: testToken}
	if err := Remove(context.Background(), h.deps, rp, h.emit); err != nil {
		t.Fatalf("%v\n%s", err, h.allText())
	}
	if !h.vps.ran("systemctl disable --now bethstudio-proxy") {
		t.Fatal("serviço não removido")
	}
	if len(h.cf.records) != 1 || h.cf.records[0].ID != "00cd" {
		t.Fatalf("só o registro do assistente podia sair: %+v", h.cf.records)
	}
	if !h.studio.cleared {
		t.Fatal("pareamento deveria ser limpo")
	}
	if sv, _ := h.deps.Store.Load(); sv != nil {
		t.Fatal("estado deveria ser apagado")
	}
	if h.vps.ran("apt-get remove") || h.vps.ran("apt-get purge") {
		t.Fatal("não deve desinstalar pacotes")
	}
	h.noSecrets()
	// sem servidor salvo
	if err := Update(context.Background(), h.deps, ap, h.emit); err == nil {
		t.Fatal("sem servidor deveria falhar")
	}
}

func TestRedactor(t *testing.T) {
	r := NewRedactor("abcdef", "abcdefghi", "ab")
	if got := r.Clean("x abcdefghi y abcdef z ab"); got != "x *** y *** z ab" {
		t.Fatal(got)
	}
}

func TestParseListenersEOS(t *testing.T) {
	ls := ParseListeners("LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:((\"nginx\",pid=5,fd=6))\nLISTEN 0 128 [::]:22 [::]:*\nlixo\n")
	if len(ls) != 2 || ls[0].Port != 80 || ls[0].Proc != "nginx" || ls[1].Port != 22 || ls[1].Proc != "" {
		t.Fatalf("%+v", ls)
	}
	id, v := ParseOSRelease("ID=debian\nVERSION_ID=\"12\"\n")
	if id != "debian" || v != "12" || !SupportedOS(id, v) || SupportedOS("debian", "9") {
		t.Fatal(id, v)
	}
}

func TestManagerUmJobPorVez(t *testing.T) {
	var m Manager
	release := make(chan struct{})
	j, err := m.Start("x", func(ctx context.Context, emit Emit) (*Outcome, string, error) {
		emit(Event{Seq: 1, Step: "a", Status: "ok", Msg: "oi"})
		<-release
		return nil, "texto", nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.Start("y", nil); !errors.Is(err, ErrBusy) {
		t.Fatalf("%v", err)
	}
	close(release)
	for i := 0; i < 200 && j.Running(); i++ {
		time.Sleep(5 * time.Millisecond)
	}
	v := m.Get(j.ID).View(0)
	if !v.Done || !v.OK || v.Text != "texto" || len(v.Events) != 1 || v.Next != 1 {
		t.Fatalf("%+v", v)
	}
	if m.Get("outro") != nil {
		t.Fatal("id desconhecido")
	}
}
