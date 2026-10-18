package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/bcrypt"
)

func TestPhonePasswordLength(t *testing.T) {
	if err := validatePhonePassword("curta"); err == nil {
		t.Fatal("senha curta")
	}
	if err := validatePhonePassword("12345678"); err != nil {
		t.Fatal(err)
	}
}

func TestPhoneLoginLock(t *testing.T) {
	hash, err := bcrypt.GenerateFromPassword([]byte("senha-certa"), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 27, 20, 0, 0, 0, time.UTC)
	a := &phoneAuth{
		hash:     hash,
		limit:    &loginLimiter{now: func() time.Time { return now }},
		now:      func() time.Time { return now },
	}
	for i := 0; i < 5; i++ {
		if _, err := a.login("1.2.3.4", "ua", "errada"); err == nil {
			t.Fatal("aceitou senha errada")
		}
	}
	if _, err := a.login("1.2.3.4", "ua", "senha-certa"); err == nil || err.Error() != "muitas tentativas, espere um minuto" {
		t.Fatalf("trava: %v", err)
	}
	now = now.Add(time.Minute + time.Second)
	tok, err := a.login("1.2.3.4", "ua", "senha-certa")
	if err != nil || tok == "" {
		t.Fatal(err)
	}
	if !a.valid(tok) {
		t.Fatal("sessão")
	}
	a.logout(tok)
	if a.valid(tok) {
		t.Fatal("saiu e a sessão ficou")
	}
}

func TestPhoneVoiceHidesProvider(t *testing.T) {
	b, err := json.Marshal(phoneVoiceView())
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	for _, bad := range []string{"base_url", "audio_url", "keys_url", "api.openai", "deepinfra", "masked", "key_source", "\"key\""} {
		if strings.Contains(s, bad) {
			t.Fatalf("vazou %s em %s", bad, s)
		}
	}
	if !strings.Contains(s, "privacy_ack") {
		t.Fatal(s)
	}
	srv := &server{hub: newHub(false)}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/voice/key", strings.NewReader(`{"provider":"openai","key":"sekret"}`))
	srv.servePhoneVoice(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("chave exposta: %d %s", rec.Code, rec.Body.String())
	}
}

func TestPhoneOpAllowed(t *testing.T) {
	for _, op := range []string{"list", "watch", "scroll", "send", "paste"} {
		if !phoneOpAllowed(op) {
			t.Fatal(op)
		}
	}
	for _, op := range []string{"spawn", "kill", "separate", "spawn_tool", "resize", "shells"} {
		if phoneOpAllowed(op) {
			t.Fatal(op)
		}
	}
}

func TestPhoneHandleBlocksSpawn(t *testing.T) {
	s := &server{hub: newHub(false)}
	var got string
	s.handle(&client{phone: true, gone: make(chan struct{})}, clientRequest{Op: "spawn", ShellID: "pwsh"}, func(m string) { got = m })
	if got == "" {
		t.Fatal("spawn passou")
	}
}
