package main

// serial_profiles.go — perfis de porta serial salvos, em
// %APPDATA%\bethterm\serial-profiles.json (gravacao atomica).
//
// Um perfil e' aberto como terminal comum no host:
// `bethterm-tool.exe --serial <id>` (tool_spawn.go, serial_helper_windows.go).

import (
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
)

const (
	serialProfilesFile  = "serial-profiles.json"
	serialHelperFlag    = "--serial"
	serialShellIDPrefix = "serial."
	serialMaxProfiles   = 500
	serialMaxRecent     = 12
)

// SerialProfile espelha SerialProfile em frontend/src/lib/serialApi.ts.
type SerialProfile struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Group      string `json:"group,omitempty"`
	Port       string `json:"port"`      // COM3
	Baud       int    `json:"baud"`      // 9600 … 4000000
	DataBits   int    `json:"data_bits"` // 5–8
	Parity     string `json:"parity"`    // none | odd | even | mark | space
	StopBits   string `json:"stop_bits"` // 1 | 1.5 | 2
	Flow       string `json:"flow"`      // none | rtscts | xonxoff
	LineEnding string `json:"line_ending"`
	LocalEcho  bool   `json:"local_echo"`
	Timestamps bool   `json:"timestamps"`
	LogFile    string `json:"log_file,omitempty"` // "" = sem log
	Color      string `json:"color,omitempty"`
	Notes      string `json:"notes,omitempty"`
	CreatedAt  string `json:"created_at,omitempty"`
	UpdatedAt  string `json:"updated_at,omitempty"`
}

type serialDoc struct {
	Version  int             `json:"version"`
	Profiles []SerialProfile `json:"profiles"`
	Recent   []SSHRecent     `json:"recent,omitempty"`
}

var (
	serialMu          sync.Mutex
	serialProfileIDRe = regexp.MustCompile(`^[a-f0-9]{16}$`)
	serialPortRe      = regexp.MustCompile(`^(?i:COM)[1-9][0-9]{0,2}$`)
)

func serialProfilesPath() string { return filepath.Join(dataDir(), serialProfilesFile) }

func serialLoadLocked() (serialDoc, error) {
	var doc serialDoc
	b, err := os.ReadFile(serialProfilesPath())
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return serialDoc{Version: 1}, nil
		}
		return doc, err
	}
	if len(strings.TrimSpace(string(b))) == 0 {
		return serialDoc{Version: 1}, nil
	}
	if err := json.Unmarshal(b, &doc); err != nil {
		return doc, fmt.Errorf("%s ilegível: %v", serialProfilesFile, err)
	}
	return doc, nil
}

func serialSaveLocked(doc serialDoc) error {
	doc.Version = 1
	b, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	return writeAtomic(serialProfilesPath(), b)
}

// serialNormalize valida e completa os padroes (115200 8N1, sem controle de
// fluxo, Enter = CR).
func serialNormalize(p SerialProfile) (SerialProfile, error) {
	p.Name = strings.TrimSpace(p.Name)
	p.Group = strings.TrimSpace(p.Group)
	p.Port = strings.ToUpper(strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(p.Port), `\\.\`)))
	p.LogFile = strings.Trim(strings.TrimSpace(p.LogFile), `"`)
	p.Color = strings.TrimSpace(p.Color)
	p.Notes = strings.TrimRight(p.Notes, " \t\r\n")
	if !serialPortRe.MatchString(p.Port) {
		return p, errors.New("porta inválida (ex.: COM3)")
	}
	if p.Baud == 0 {
		p.Baud = 115200
	}
	if p.Baud < 50 || p.Baud > 12_000_000 {
		return p, errors.New("velocidade inválida (50–12000000 baud)")
	}
	if p.DataBits == 0 {
		p.DataBits = 8
	}
	if p.DataBits < 5 || p.DataBits > 8 {
		return p, errors.New("bits de dados inválidos (5–8)")
	}
	switch p.Parity {
	case "":
		p.Parity = "none"
	case "none", "odd", "even", "mark", "space":
	default:
		return p, errors.New("paridade inválida")
	}
	switch p.StopBits {
	case "":
		p.StopBits = "1"
	case "1", "1.5", "2":
	default:
		return p, errors.New("bits de parada inválidos (1, 1.5 ou 2)")
	}
	if p.StopBits == "1.5" && p.DataBits != 5 {
		return p, errors.New("1.5 bit de parada só vale com 5 bits de dados")
	}
	switch p.Flow {
	case "":
		p.Flow = "none"
	case "none", "rtscts", "xonxoff":
	default:
		return p, errors.New("controle de fluxo inválido")
	}
	switch p.LineEnding {
	case "":
		p.LineEnding = "cr"
	case "cr", "lf", "crlf":
	default:
		return p, errors.New("fim de linha inválido (CR, LF ou CRLF)")
	}
	switch {
	case len(p.Name) > 120 || sshHasControl(p.Name):
		return p, errors.New("nome inválido (até 120 caracteres)")
	case len(p.Group) > 80 || sshHasControl(p.Group):
		return p, errors.New("grupo inválido (até 80 caracteres)")
	case p.Color != "" && !sshColorRe.MatchString(p.Color):
		return p, errors.New("cor inválida (use #rrggbb)")
	case len(p.Notes) > 4000 || strings.ContainsRune(p.Notes, 0):
		return p, errors.New("notas longas demais")
	case len(p.LogFile) > 1024 || sshHasControl(p.LogFile):
		return p, errors.New("arquivo de log inválido")
	case p.LogFile != "" && !filepath.IsAbs(sshExpandHome(p.LogFile)):
		return p, errors.New("use um caminho completo para o arquivo de log (ex.: C:\\logs\\placa.log)")
	}
	if p.Name == "" {
		p.Name = p.Port
	}
	return p, nil
}

func serialListProfiles() ([]SerialProfile, []SSHRecent, error) {
	serialMu.Lock()
	doc, err := serialLoadLocked()
	serialMu.Unlock()
	if err != nil {
		return nil, nil, err
	}
	ps := doc.Profiles
	if ps == nil {
		ps = []SerialProfile{}
	}
	ids := map[string]bool{}
	for _, p := range ps {
		ids[p.ID] = true
	}
	sort.SliceStable(ps, func(i, j int) bool {
		gi, gj := strings.ToLower(ps[i].Group), strings.ToLower(ps[j].Group)
		if gi != gj {
			return gi < gj
		}
		return strings.ToLower(ps[i].Name) < strings.ToLower(ps[j].Name)
	})
	rec := []SSHRecent{}
	for _, r := range doc.Recent {
		if ids[r.ID] {
			rec = append(rec, r)
		}
	}
	return ps, rec, nil
}

func serialGetProfile(id string) (SerialProfile, bool, error) {
	if !serialProfileIDRe.MatchString(id) {
		return SerialProfile{}, false, nil
	}
	serialMu.Lock()
	doc, err := serialLoadLocked()
	serialMu.Unlock()
	if err != nil {
		return SerialProfile{}, false, err
	}
	for _, p := range doc.Profiles {
		if p.ID == id {
			return p, true, nil
		}
	}
	return SerialProfile{}, false, nil
}

func serialUpsertProfile(in SerialProfile) (SerialProfile, error) {
	p, err := serialNormalize(in)
	if err != nil {
		return SerialProfile{}, err
	}
	now := time.Now().UTC().Format(time.RFC3339)
	serialMu.Lock()
	defer serialMu.Unlock()
	doc, err := serialLoadLocked()
	if err != nil {
		return SerialProfile{}, err
	}
	if p.ID == "" {
		if len(doc.Profiles) >= serialMaxProfiles {
			return SerialProfile{}, errors.New("limite de perfis atingido")
		}
		p.ID = sshNewID()
		p.CreatedAt, p.UpdatedAt = now, now
		doc.Profiles = append(doc.Profiles, p)
	} else {
		if !serialProfileIDRe.MatchString(p.ID) {
			return SerialProfile{}, errors.New("id inválido")
		}
		found := false
		for i := range doc.Profiles {
			if doc.Profiles[i].ID == p.ID {
				p.CreatedAt, p.UpdatedAt = doc.Profiles[i].CreatedAt, now
				doc.Profiles[i] = p
				found = true
				break
			}
		}
		if !found {
			return SerialProfile{}, errors.New("perfil não encontrado (talvez tenha sido apagado)")
		}
	}
	if err := serialSaveLocked(doc); err != nil {
		return SerialProfile{}, err
	}
	return p, nil
}

func serialDuplicateProfile(id string) (SerialProfile, error) {
	src, ok, err := serialGetProfile(id)
	if err != nil {
		return SerialProfile{}, err
	}
	if !ok {
		return SerialProfile{}, errors.New("perfil não encontrado")
	}
	src.ID = ""
	src.Name = strings.TrimSpace(src.Name + " (cópia)")
	if len(src.Name) > 120 {
		src.Name = src.Name[:120]
	}
	return serialUpsertProfile(src)
}

func serialDeleteProfile(id string) error {
	if !serialProfileIDRe.MatchString(id) {
		return errors.New("id inválido")
	}
	serialMu.Lock()
	defer serialMu.Unlock()
	doc, err := serialLoadLocked()
	if err != nil {
		return err
	}
	out := doc.Profiles[:0]
	found := false
	for _, p := range doc.Profiles {
		if p.ID == id {
			found = true
			continue
		}
		out = append(out, p)
	}
	if !found {
		return errors.New("perfil não encontrado")
	}
	doc.Profiles = out
	rec := doc.Recent[:0]
	for _, r := range doc.Recent {
		if r.ID != id {
			rec = append(rec, r)
		}
	}
	doc.Recent = rec
	return serialSaveLocked(doc)
}

func serialNoteRecent(id string) error {
	serialMu.Lock()
	defer serialMu.Unlock()
	doc, err := serialLoadLocked()
	if err != nil {
		return err
	}
	rec := []SSHRecent{{ID: id, At: time.Now().UTC().Format(time.RFC3339)}}
	for _, r := range doc.Recent {
		if r.ID != id && len(rec) < serialMaxRecent {
			rec = append(rec, r)
		}
	}
	doc.Recent = rec
	return serialSaveLocked(doc)
}

// --- tipo do pane ------------------------------------------------------------

func serialShellIDFor(id string) string { return serialShellIDPrefix + id }

// serialPortForArgv mapeia `bethterm-tool.exe --serial <id>` para o rotulo
// "COM3" (ou "COM3 · nome" quando o perfil tem nome proprio). ok=false para
// outros comandos. O tipo na barra lateral fica "Serial · <rotulo>".
func serialPortForArgv(argv []string) (label string, ok bool) {
	id, ok := toolArgvID(argv, serialHelperFlag, serialProfileIDRe)
	if !ok {
		return "", false
	}
	return serialLabelFor(id), true
}

// serialPortForShellID: o mesmo para o shell_id "serial.<id>".
func serialPortForShellID(shellID string) (label string, ok bool) {
	id := strings.TrimPrefix(shellID, serialShellIDPrefix)
	if id == shellID || !serialProfileIDRe.MatchString(id) {
		return "", false
	}
	return serialLabelFor(id), true
}

func serialLabelFor(id string) string {
	p, ok, err := serialGetProfile(id)
	if err != nil || !ok {
		return "perfil removido"
	}
	if p.Name != "" && !strings.EqualFold(p.Name, p.Port) {
		return p.Port + " · " + p.Name
	}
	return p.Port
}
