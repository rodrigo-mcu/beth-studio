//go:build windows

package main

// secrets_windows.go — chaves de API dos provedores de IA, cifradas com a
// DPAPI do Windows (CryptProtectData, escopo do usuario) em
// <data dir>\secrets.dat. Nunca vao para web-settings.json nem voltam para o
// navegador (a API so' mostra "••••1234").
//
// As chaves tambem podem vir das variaveis de ambiente de cada provedor
// (DEEPINFRA_TOKEN/DEEPINFRA_API_KEY, OPENAI_API_KEY, ...); a chave salva
// aqui tem prioridade.

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
)

const secretsFile = "secrets.dat"

var secretsEntropy = []byte("bethterm-web/secrets/v1")

func dpapiProtect(plain []byte) ([]byte, error) {
	if len(plain) == 0 {
		return nil, errors.New("vazio")
	}
	in := windows.DataBlob{Size: uint32(len(plain)), Data: &plain[0]}
	ent := windows.DataBlob{Size: uint32(len(secretsEntropy)), Data: &secretsEntropy[0]}
	var out windows.DataBlob
	desc, _ := windows.UTF16PtrFromString("bethterm-web")
	if err := windows.CryptProtectData(&in, desc, &ent, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &out); err != nil {
		return nil, err
	}
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(out.Data)))
	return append([]byte(nil), unsafe.Slice(out.Data, out.Size)...), nil
}

func dpapiUnprotect(enc []byte) ([]byte, error) {
	if len(enc) == 0 {
		return nil, errors.New("vazio")
	}
	in := windows.DataBlob{Size: uint32(len(enc)), Data: &enc[0]}
	ent := windows.DataBlob{Size: uint32(len(secretsEntropy)), Data: &secretsEntropy[0]}
	var out windows.DataBlob
	if err := windows.CryptUnprotectData(&in, nil, &ent, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &out); err != nil {
		return nil, err
	}
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(out.Data)))
	return append([]byte(nil), unsafe.Slice(out.Data, out.Size)...), nil
}

type secretStore struct {
	mu   sync.Mutex
	dir  string
	keys map[string]string // provider id -> chave
}

var secrets = &secretStore{}

func (s *secretStore) load(dir string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.dir = dir
	s.keys = map[string]string{}
	s.reloadLocked()
}

// reloadLocked relê secrets.dat. O Studio e a janela do banco são processos
// diferentes e os dois gravam o arquivo inteiro; sem reler, um apaga a chave
// que o outro acabou de salvar. Se a leitura falhar, fica o que já está na
// memória.
func (s *secretStore) reloadLocked() {
	if s.dir == "" {
		return
	}
	enc, err := os.ReadFile(filepath.Join(s.dir, secretsFile))
	if err != nil {
		if os.IsNotExist(err) {
			s.keys = map[string]string{}
		}
		return
	}
	plain, err := dpapiUnprotect(enc)
	if err != nil {
		return
	}
	keys := map[string]string{}
	if json.Unmarshal(plain, &keys) != nil {
		return
	}
	s.keys = keys
}

func (s *secretStore) saveLocked() error {
	b, err := json.Marshal(s.keys)
	if err != nil {
		return err
	}
	enc, err := dpapiProtect(b)
	if err != nil {
		return err
	}
	return writeAtomic(filepath.Join(s.dir, secretsFile), enc)
}

// set grava (ou apaga, com chave vazia) a chave de um provedor.
func (s *secretStore) set(provider, key string) error {
	key = strings.TrimSpace(key)
	if len(key) > 4096 || strings.ContainsAny(key, "\r\n\x00") {
		return errors.New("chave inválida")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.reloadLocked()
	if key == "" {
		delete(s.keys, provider)
	} else {
		s.keys[provider] = key
	}
	return s.saveLocked()
}

// get: chave salva; senao a primeira variavel de ambiente definida.
func (s *secretStore) get(provider string, env []string) (key, source string) {
	s.mu.Lock()
	s.reloadLocked()
	k := s.keys[provider]
	s.mu.Unlock()
	if k != "" {
		return k, "salva"
	}
	for _, e := range env {
		if v := strings.TrimSpace(os.Getenv(e)); v != "" {
			return v, "env:" + e
		}
	}
	return "", ""
}

// maskKey: "••••1234" (nunca a chave inteira).
func maskKey(k string) string {
	if k == "" {
		return ""
	}
	if len(k) <= 4 {
		return "••••"
	}
	return "••••" + k[len(k)-4:]
}
