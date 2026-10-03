package main

// ssh_hosts.go — hosts SSH salvos pelo usuario, em
// %APPDATA%\bethstudio\ssh-hosts.json (gravacao atomica: tmp + rename).
//
// So' metadados ficam no JSON. Senha e frase-senha da chave ficam em
// secrets.dat (DPAPI, secrets_windows.go) com as chaves "ssh.pw.<id>" e
// "ssh.pp.<id>", em base64 para que espacos no inicio/fim sobrevivam ao
// TrimSpace do cofre. Nada disso volta para o navegador: a API so' informa
// has_password / has_passphrase.
//
// O mesmo arquivo e' lido pelo processo auxiliar `--ssh <id>` (ssh_helper_*.go)
// que roda dentro do pane do host; so' o processo da interface web grava.

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"
)

const (
	sshHostsFile  = "ssh-hosts.json"
	sshKnownFile  = "ssh_known_hosts"
	sshMaxRecent  = 12
	sshMaxHosts   = 2000
	sshSecretPw   = "ssh.pw."
	sshSecretPass = "ssh.pp."
)

// Metodos de autenticacao aceitos.
const (
	sshAuthPassword = "password" // senha (salva no cofre ou pedida na hora)
	sshAuthKey      = "key"      // arquivo de chave privada (+ frase-senha opcional)
	sshAuthAgent    = "agent"    // agente SSH do Windows (servico ssh-agent)
)

// SSHSavedHost: um host salvo. Espelha SshHost em frontend/src/lib/sshApi.ts.
type SSHSavedHost struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Group      string `json:"group,omitempty"`
	Host       string `json:"host"`
	Port       int    `json:"port"`
	User       string `json:"user"`
	Auth       string `json:"auth"`
	KeyPath    string `json:"key_path,omitempty"`
	Color      string `json:"color,omitempty"` // #rrggbb (etiqueta na lista)
	Tag        string `json:"tag,omitempty"`
	Notes      string `json:"notes,omitempty"`
	InitialDir string `json:"initial_dir,omitempty"` // pasta inicial do navegador de arquivos
	CreatedAt  string `json:"created_at,omitempty"`
	UpdatedAt  string `json:"updated_at,omitempty"`

	// Derivados do cofre: so' valem na API (no arquivo ficam sempre false).
	HasPassword   bool `json:"has_password"`
	HasPassphrase bool `json:"has_passphrase"`
}

// SSHRecent: uma conexao recente ("Conectar" pela interface web).
type SSHRecent struct {
	ID string `json:"id"`
	At string `json:"at"`
}

type sshHostsDoc struct {
	Version int            `json:"version"`
	Hosts   []SSHSavedHost `json:"hosts"`
	Recent  []SSHRecent    `json:"recent,omitempty"`
}

var (
	sshStoreMu  sync.Mutex
	sshHostIDRe = regexp.MustCompile(`^[a-f0-9]{16}$`)
	sshColorRe  = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)
	sshHostRe   = regexp.MustCompile(`^[A-Za-z0-9._%:-]{1,253}$`)
)

func sshHostsPath() string { return filepath.Join(dataDir(), sshHostsFile) }
func sshKnownPath() string { return filepath.Join(dataDir(), sshKnownFile) }

func sshNewID() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b[:])
}

// sshLoadDocLocked: arquivo ausente = vazio; corrompido = erro (nunca
// sobrescrever um arquivo que nao conseguimos ler).
func sshLoadDocLocked() (sshHostsDoc, error) {
	var doc sshHostsDoc
	b, err := os.ReadFile(sshHostsPath())
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return sshHostsDoc{Version: 1}, nil
		}
		return doc, err
	}
	if len(strings.TrimSpace(string(b))) == 0 {
		return sshHostsDoc{Version: 1}, nil
	}
	if err := json.Unmarshal(b, &doc); err != nil {
		return doc, fmt.Errorf("%s ilegível: %v", sshHostsFile, err)
	}
	return doc, nil
}

func sshSaveDocLocked(doc sshHostsDoc) error {
	doc.Version = 1
	for i := range doc.Hosts {
		doc.Hosts[i].HasPassword, doc.Hosts[i].HasPassphrase = false, false
	}
	b, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	return writeAtomic(sshHostsPath(), b)
}

// --- cofre (secrets.dat) -------------------------------------------------

func sshSecretGet(prefix, id string) (string, bool) {
	enc, _ := secrets.get(prefix+id, nil)
	if enc == "" {
		return "", false
	}
	b, err := base64.StdEncoding.DecodeString(enc)
	if err != nil || len(b) == 0 {
		return "", false
	}
	return string(b), true
}

func sshSecretSet(prefix, id, value string) error {
	if value == "" {
		return secrets.set(prefix+id, "")
	}
	if len(value) > 2048 {
		return errors.New("senha longa demais")
	}
	return secrets.set(prefix+id, base64.StdEncoding.EncodeToString([]byte(value)))
}

func sshFillDerived(h *SSHSavedHost) {
	_, h.HasPassword = sshSecretGet(sshSecretPw, h.ID)
	_, h.HasPassphrase = sshSecretGet(sshSecretPass, h.ID)
}

// --- validacao -------------------------------------------------------------

func sshHasControl(s string) bool {
	for _, r := range s {
		if unicode.IsControl(r) {
			return true
		}
	}
	return false
}

// sshNormalizeHost valida e normaliza os campos editaveis. Erros em pt-BR,
// prontos para a interface.
func sshNormalizeHost(h SSHSavedHost) (SSHSavedHost, error) {
	h.Name = strings.TrimSpace(h.Name)
	h.Group = strings.TrimSpace(h.Group)
	h.Host = strings.Trim(strings.TrimSpace(h.Host), "[]")
	h.User = strings.TrimSpace(h.User)
	h.KeyPath = strings.Trim(strings.TrimSpace(h.KeyPath), `"`)
	h.Tag = strings.TrimSpace(h.Tag)
	h.Color = strings.TrimSpace(h.Color)
	h.InitialDir = strings.TrimSpace(h.InitialDir)
	h.Notes = strings.TrimRight(h.Notes, " \t\r\n")
	switch {
	case h.Host == "":
		return h, errors.New("informe o endereço (host ou IP)")
	case !sshHostRe.MatchString(h.Host):
		return h, errors.New("endereço inválido: use só o nome ou IP, sem espaços, usuário ou porta")
	case h.User == "":
		return h, errors.New("informe o usuário")
	case len(h.User) > 128 || sshHasControl(h.User):
		return h, errors.New("usuário inválido")
	case len(h.Name) > 120 || sshHasControl(h.Name):
		return h, errors.New("nome inválido (até 120 caracteres)")
	case len(h.Group) > 80 || sshHasControl(h.Group):
		return h, errors.New("grupo inválido (até 80 caracteres)")
	case len(h.Tag) > 40 || sshHasControl(h.Tag):
		return h, errors.New("etiqueta inválida (até 40 caracteres)")
	case h.Color != "" && !sshColorRe.MatchString(h.Color):
		return h, errors.New("cor inválida (use #rrggbb)")
	case len(h.Notes) > 4000 || strings.ContainsRune(h.Notes, 0):
		return h, errors.New("notas longas demais (até 4000 caracteres)")
	case len(h.InitialDir) > 1024 || sshHasControl(h.InitialDir):
		return h, errors.New("pasta inicial inválida")
	case len(h.KeyPath) > 1024 || sshHasControl(h.KeyPath):
		return h, errors.New("caminho da chave inválido")
	}
	if h.Port == 0 {
		h.Port = 22
	}
	if h.Port < 1 || h.Port > 65535 {
		return h, errors.New("porta inválida (1–65535)")
	}
	switch h.Auth {
	case "":
		h.Auth = sshAuthPassword
	case sshAuthPassword, sshAuthAgent:
	case sshAuthKey:
		if h.KeyPath == "" {
			return h, errors.New("informe o arquivo da chave privada")
		}
	default:
		return h, errors.New("método de autenticação inválido")
	}
	if h.Auth != sshAuthKey {
		h.KeyPath = ""
	}
	if h.Name == "" {
		h.Name = h.Host
	}
	return h, nil
}

// sshExpandHome: "~/..." e "%USERPROFILE%" no caminho da chave.
func sshExpandHome(p string) string {
	p = strings.TrimSpace(p)
	if home, err := os.UserHomeDir(); err == nil {
		if p == "~" {
			return home
		}
		if strings.HasPrefix(p, "~/") || strings.HasPrefix(p, `~\`) {
			return filepath.Join(home, p[2:])
		}
	}
	return os.ExpandEnv(strings.ReplaceAll(strings.ReplaceAll(p, "%USERPROFILE%", "${USERPROFILE}"), "%HOMEPATH%", "${HOMEPATH}"))
}

// --- operacoes ---------------------------------------------------------------

// sshListHosts: hosts (com has_password/has_passphrase) e recentes validos.
func sshListHosts() ([]SSHSavedHost, []SSHRecent, error) {
	sshStoreMu.Lock()
	doc, err := sshLoadDocLocked()
	sshStoreMu.Unlock()
	if err != nil {
		return nil, nil, err
	}
	hosts := doc.Hosts
	if hosts == nil {
		hosts = []SSHSavedHost{}
	}
	ids := map[string]bool{}
	for i := range hosts {
		sshFillDerived(&hosts[i])
		ids[hosts[i].ID] = true
	}
	sort.SliceStable(hosts, func(i, j int) bool {
		gi, gj := strings.ToLower(hosts[i].Group), strings.ToLower(hosts[j].Group)
		if gi != gj {
			return gi < gj
		}
		return strings.ToLower(hosts[i].Name) < strings.ToLower(hosts[j].Name)
	})
	recent := []SSHRecent{}
	for _, r := range doc.Recent {
		if ids[r.ID] {
			recent = append(recent, r)
		}
	}
	return hosts, recent, nil
}

// sshGetHost: um host pelo id (com os derivados do cofre).
func sshGetHost(id string) (SSHSavedHost, bool, error) {
	if !sshHostIDRe.MatchString(id) {
		return SSHSavedHost{}, false, nil
	}
	sshStoreMu.Lock()
	doc, err := sshLoadDocLocked()
	sshStoreMu.Unlock()
	if err != nil {
		return SSHSavedHost{}, false, err
	}
	for _, h := range doc.Hosts {
		if h.ID == id {
			sshFillDerived(&h)
			return h, true, nil
		}
	}
	return SSHSavedHost{}, false, nil
}

// sshUpsertHost cria (ID vazio) ou atualiza. Os derivados do cofre sao
// ignorados na entrada.
func sshUpsertHost(in SSHSavedHost) (SSHSavedHost, error) {
	h, err := sshNormalizeHost(in)
	if err != nil {
		return SSHSavedHost{}, err
	}
	now := time.Now().UTC().Format(time.RFC3339)
	sshStoreMu.Lock()
	defer sshStoreMu.Unlock()
	doc, err := sshLoadDocLocked()
	if err != nil {
		return SSHSavedHost{}, err
	}
	if h.ID == "" {
		if len(doc.Hosts) >= sshMaxHosts {
			return SSHSavedHost{}, errors.New("limite de hosts salvos atingido")
		}
		h.ID = sshNewID()
		h.CreatedAt, h.UpdatedAt = now, now
		doc.Hosts = append(doc.Hosts, h)
	} else {
		if !sshHostIDRe.MatchString(h.ID) {
			return SSHSavedHost{}, errors.New("id inválido")
		}
		found := false
		for i := range doc.Hosts {
			if doc.Hosts[i].ID == h.ID {
				h.CreatedAt, h.UpdatedAt = doc.Hosts[i].CreatedAt, now
				doc.Hosts[i] = h
				found = true
				break
			}
		}
		if !found {
			return SSHSavedHost{}, errors.New("host não encontrado (talvez tenha sido apagado)")
		}
	}
	if err := sshSaveDocLocked(doc); err != nil {
		return SSHSavedHost{}, err
	}
	h.HasPassword, h.HasPassphrase = false, false
	sshFillDerived(&h)
	return h, nil
}

// sshDuplicateHost: copia com nome "… (cópia)"; credenciais salvas vao junto.
func sshDuplicateHost(id string) (SSHSavedHost, error) {
	src, ok, err := sshGetHost(id)
	if err != nil {
		return SSHSavedHost{}, err
	}
	if !ok {
		return SSHSavedHost{}, errors.New("host não encontrado")
	}
	cp := src
	cp.ID = ""
	cp.Name = strings.TrimSpace(src.Name + " (cópia)")
	if len(cp.Name) > 120 {
		cp.Name = cp.Name[:120]
	}
	out, err := sshUpsertHost(cp)
	if err != nil {
		return SSHSavedHost{}, err
	}
	if pw, ok := sshSecretGet(sshSecretPw, src.ID); ok {
		if err := sshSecretSet(sshSecretPw, out.ID, pw); err != nil {
			return out, err
		}
	}
	if pp, ok := sshSecretGet(sshSecretPass, src.ID); ok {
		if err := sshSecretSet(sshSecretPass, out.ID, pp); err != nil {
			return out, err
		}
	}
	sshFillDerived(&out)
	return out, nil
}

// sshDeleteHost apaga o host, as credenciais salvas e o registro de recentes.
// A chave do servidor (known_hosts) fica: outro host pode usar o mesmo endereco.
func sshDeleteHost(id string) error {
	if !sshHostIDRe.MatchString(id) {
		return errors.New("id inválido")
	}
	sshStoreMu.Lock()
	doc, err := sshLoadDocLocked()
	if err != nil {
		sshStoreMu.Unlock()
		return err
	}
	hosts := doc.Hosts[:0]
	found := false
	for _, h := range doc.Hosts {
		if h.ID == id {
			found = true
			continue
		}
		hosts = append(hosts, h)
	}
	doc.Hosts = hosts
	rec := doc.Recent[:0]
	for _, r := range doc.Recent {
		if r.ID != id {
			rec = append(rec, r)
		}
	}
	doc.Recent = rec
	if found {
		err = sshSaveDocLocked(doc)
	}
	sshStoreMu.Unlock()
	if err != nil {
		return err
	}
	if !found {
		return errors.New("host não encontrado")
	}
	_ = sshSecretSet(sshSecretPw, id, "")
	_ = sshSecretSet(sshSecretPass, id, "")
	return nil
}

// sshNoteRecent poe o host no topo dos recentes.
func sshNoteRecent(id string) error {
	sshStoreMu.Lock()
	defer sshStoreMu.Unlock()
	doc, err := sshLoadDocLocked()
	if err != nil {
		return err
	}
	rec := []SSHRecent{{ID: id, At: time.Now().UTC().Format(time.RFC3339)}}
	for _, r := range doc.Recent {
		if r.ID != id && len(rec) < sshMaxRecent {
			rec = append(rec, r)
		}
	}
	doc.Recent = rec
	return sshSaveDocLocked(doc)
}
