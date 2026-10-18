package vpsinstall

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"sync"
)

// Server é o que o Studio lembra do servidor instalado. Sem nenhum segredo:
// nem senha SSH, nem token da Cloudflare, nem o segredo da ligação.
type Server struct {
	Host        string   `json:"host"`
	Port        int      `json:"port"`
	User        string   `json:"user"`
	Domain      string   `json:"domain"`
	ZoneID      string   `json:"zone_id"`
	ZoneName    string   `json:"zone_name"`
	Proxied     bool     `json:"proxied"`
	RecordIDs   []string `json:"record_ids"`
	Fingerprint string   `json:"fingerprint"`
	ProxySHA    string   `json:"proxy_sha256"`
	Arch        string   `json:"arch"`
	Unattended  bool     `json:"unattended"`
	InstalledAt string   `json:"installed_at"`
}

// Store guarda o estado não secreto e as impressões digitais confirmadas.
type Store struct {
	Dir string
	mu  sync.Mutex
}

const (
	serverFile   = "vps-server.json"
	hostKeysFile = "vps-hostkeys.json"
)

func writeAtomic(path string, b []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// Load devolve nil se ainda não há servidor.
func (s *Store) Load() (*Server, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, err := os.ReadFile(filepath.Join(s.Dir, serverFile))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var v Server
	if err := json.Unmarshal(b, &v); err != nil {
		return nil, err
	}
	return &v, nil
}

func (s *Store) Save(v Server) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	return writeAtomic(filepath.Join(s.Dir, serverFile), b)
}

func (s *Store) Clear() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	err := os.Remove(filepath.Join(s.Dir, serverFile))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func hostKey(host string, port int) string { return host + ":" + strconv.Itoa(port) }

func (s *Store) loadKeys() map[string]string {
	m := map[string]string{}
	if b, err := os.ReadFile(filepath.Join(s.Dir, hostKeysFile)); err == nil {
		_ = json.Unmarshal(b, &m)
	}
	return m
}

// KnownFingerprint devolve a impressão digital já confirmada para host:porta.
func (s *Store) KnownFingerprint(host string, port int) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.loadKeys()[hostKey(host, port)]
}

// Remember guarda a impressão digital confirmada (substitui a anterior).
func (s *Store) Remember(host string, port int, fp string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	m := s.loadKeys()
	m[hostKey(host, port)] = fp
	b, _ := json.MarshalIndent(m, "", "  ")
	return writeAtomic(filepath.Join(s.Dir, hostKeysFile), b)
}
