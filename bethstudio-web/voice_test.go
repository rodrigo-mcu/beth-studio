package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Nenhuma chave real: tudo contra servidores falsos (httptest).

func withVoiceStores(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	oldS, oldK := settings, secrets
	settings = &settingsStore{}
	settings.load(dir)
	secrets = &secretStore{}
	secrets.load(dir)
	t.Cleanup(func() { settings, secrets = oldS, oldK })
	return dir
}

func TestDPAPIAndSecretStore(t *testing.T) {
	enc, err := dpapiProtect([]byte("sk-teste-123456"))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(enc, []byte("sk-teste")) {
		t.Fatal("DPAPI output contains the plain key")
	}
	plain, err := dpapiUnprotect(enc)
	if err != nil || string(plain) != "sk-teste-123456" {
		t.Fatalf("roundtrip: %q %v", plain, err)
	}
	dir := withVoiceStores(t)
	if err := secrets.set("deepinfra", "chave-falsa-9876"); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(filepath.Join(dir, secretsFile))
	if len(raw) == 0 || bytes.Contains(raw, []byte("chave-falsa")) {
		t.Fatal("secrets.dat must be encrypted")
	}
	s2 := &secretStore{}
	s2.load(dir)
	if k, src := s2.get("deepinfra", nil); k != "chave-falsa-9876" || src != "salva" {
		t.Fatalf("reload: %q %q", k, src)
	}
	t.Setenv("FAKE_GROQ_KEY_FOR_TEST", "env-key-0001")
	if k, src := s2.get("groq", []string{"FAKE_GROQ_KEY_FOR_TEST"}); k != "env-key-0001" || src != "env:FAKE_GROQ_KEY_FOR_TEST" {
		t.Fatalf("env fallback: %q %q", k, src)
	}
	if maskKey("chave-falsa-9876") != "••••9876" || maskKey("") != "" {
		t.Fatal("mask")
	}
	if err := secrets.set("deepinfra", "a\nb"); err == nil {
		t.Fatal("key with newline accepted")
	}
}

func TestVoiceAPINeverReturnsKey(t *testing.T) {
	withVoiceStores(t)
	h := newHub(false)
	srv := newServer("tok", 5555, "", h)
	call := func(method, path, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "http://127.0.0.1:5555"+path, strings.NewReader(body))
		req.Host = "127.0.0.1:5555"
		req.Header.Set(tokenHeader, "tok")
		req.Header.Set("Content-Type", "application/json")
		rr := httptest.NewRecorder()
		srv.ServeHTTP(rr, req)
		return rr
	}
	rr := call("POST", "/api/voice/key", `{"provider":"openai","key":"sk-FALSA-abcdef-7777"}`)
	if rr.Code != 200 || strings.Contains(rr.Body.String(), "sk-FALSA") || !strings.Contains(rr.Body.String(), "••••7777") {
		t.Fatalf("key response leaks or lacks mask: %s", rr.Body)
	}
	rr = call("GET", "/api/voice", "")
	if strings.Contains(rr.Body.String(), "sk-FALSA") {
		t.Fatal("GET /api/voice leaked the key")
	}
	var snap struct {
		Settings  VoiceSettings `json:"settings"`
		Providers []providerView
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &snap)
	if snap.Settings.STTProvider != "deepinfra" || snap.Settings.STTModel != "openai/whisper-large-v3-turbo" || snap.Settings.LLMEnabled {
		t.Fatalf("defaults = %+v", snap.Settings)
	}
	if call("POST", "/api/voice/key", `{"provider":"nao-existe","key":"x"}`).Code != 400 {
		t.Fatal("unknown provider accepted")
	}
}

func TestSystemPromptVariables(t *testing.T) {
	p := buildSystemPrompt("", "pt", "Beth Studio\nWSL, PowerShell\n\nbeth studio")
	if !strings.Contains(p, "(português do Brasil (pt-BR))") || !strings.Contains(p, "com a grafia correta: Beth Studio, WSL, PowerShell.") {
		t.Fatalf("prompt = %s", p)
	}
	if got := buildSystemPrompt("Idioma={idioma}; termos={vocabulario}", "en", ""); got != "Idioma=inglês; termos=(nenhum)" {
		t.Fatalf("custom = %q", got)
	}
}

// fake provider: records what it received and answers like the real API.
type fakeProv struct {
	t      *testing.T
	check  func(r *http.Request, body []byte)
	answer string
	status int
	delay  time.Duration
}

func (f fakeProv) server() *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		r.Body = io.NopCloser(bytes.NewReader(body))
		if f.check != nil {
			f.check(r, body)
		}
		if f.delay > 0 {
			time.Sleep(f.delay)
		}
		if f.status != 0 {
			w.WriteHeader(f.status)
		}
		_, _ = io.WriteString(w, f.answer)
	}))
}

func setProvider(t *testing.T, id, base string, v VoiceSettings) providerCall {
	t.Helper()
	if v.Providers == nil {
		v.Providers = map[string]ProviderPrefs{}
	}
	pp := v.Providers[id]
	pp.BaseURL = base
	pp.AudioURL = base
	v.Providers[id] = pp
	if err := settings.setVoice(v); err != nil {
		t.Fatal(err)
	}
	_ = secrets.set(id, "chave-falsa-"+id)
	pc, err := settings.callFor(id)
	if err != nil {
		t.Fatal(err)
	}
	return pc
}

func TestAdaptersAgainstFakeServers(t *testing.T) {
	withVoiceStores(t)
	ctx := context.Background()
	audio := bytes.Repeat([]byte{1, 2, 3}, 100)

	// OpenAI-compativel (DeepInfra): multipart e Authorization
	s := fakeProv{t: t, answer: `{"text":"  olá mundo  "}`, check: func(r *http.Request, _ []byte) {
		if r.URL.Path != "/audio/transcriptions" || r.Header.Get("Authorization") != "Bearer chave-falsa-deepinfra" {
			t.Errorf("openai stt: %s %s", r.URL.Path, r.Header.Get("Authorization"))
		}
		if err := r.ParseMultipartForm(1 << 20); err != nil {
			t.Error(err)
			return
		}
		if r.FormValue("model") != "openai/whisper-large-v3-turbo" || r.FormValue("language") != "pt" || r.FormValue("prompt") != "Beth Studio, WSL" {
			t.Errorf("fields: %v", r.MultipartForm.Value)
		}
		fh := r.MultipartForm.File["file"]
		if len(fh) != 1 || fh[0].Filename != "audio.webm" || fh[0].Header.Get("Content-Type") != "audio/webm;codecs=opus" {
			t.Errorf("file part: %+v", fh)
		}
	}}.server()
	defer s.Close()
	// rota OpenAI-compativel escolhida (a nativa, padrao, tem teste proprio)
	pc := setProvider(t, "deepinfra", s.URL, VoiceSettings{Vocabulary: "Beth Studio\nWSL",
		Providers: map[string]ProviderPrefs{"deepinfra": {Route: "openai"}}})
	if txt, err := pc.transcribe(ctx, "openai/whisper-large-v3-turbo", "pt", "Beth Studio\nWSL", audio, "audio/webm;codecs=opus"); err != nil || txt != "olá mundo" {
		t.Fatalf("openai stt: %q %v", txt, err)
	}

	// chat/completions com o prompt de sistema
	c := fakeProv{t: t, answer: `{"choices":[{"message":{"content":"texto corrigido"}}]}`, check: func(r *http.Request, b []byte) {
		var p struct {
			Model    string              `json:"model"`
			Messages []map[string]string `json:"messages"`
		}
		_ = json.Unmarshal(b, &p)
		if r.URL.Path != "/chat/completions" || p.Model != "m1" || len(p.Messages) != 2 || !strings.Contains(p.Messages[0]["content"], "Beth Studio") || p.Messages[1]["content"] != "texto ditado" {
			t.Errorf("chat: %s %s", r.URL.Path, b)
		}
	}}.server()
	defer c.Close()
	pc = setProvider(t, "openai", c.URL, VoiceSettings{})
	if out, err := pc.correct(ctx, "m1", buildSystemPrompt("", "pt", "Beth Studio"), "texto ditado"); err != nil || out != "texto corrigido" {
		t.Fatalf("chat: %q %v", out, err)
	}

	// Anthropic /v1/messages
	a := fakeProv{t: t, answer: `{"content":[{"type":"text","text":"ok anthropic"}]}`, check: func(r *http.Request, b []byte) {
		if r.URL.Path != "/messages" || r.Header.Get("x-api-key") != "chave-falsa-anthropic" || r.Header.Get("anthropic-version") == "" || !bytes.Contains(b, []byte(`"system"`)) {
			t.Errorf("anthropic: %s %v %s", r.URL.Path, r.Header, b)
		}
	}}.server()
	defer a.Close()
	pc = setProvider(t, "anthropic", a.URL, VoiceSettings{})
	if out, err := pc.correct(ctx, "claude-haiku-4-5", "sys", "x"); err != nil || out != "ok anthropic" {
		t.Fatalf("anthropic: %q %v", out, err)
	}

	// ElevenLabs Scribe
	e := fakeProv{t: t, answer: `{"text":"eleven"}`, check: func(r *http.Request, _ []byte) {
		_ = r.ParseMultipartForm(1 << 20)
		if r.URL.Path != "/speech-to-text" || r.Header.Get("xi-api-key") != "chave-falsa-elevenlabs" || r.FormValue("model_id") != "scribe_v1" {
			t.Errorf("elevenlabs: %s %v", r.URL.Path, r.MultipartForm)
		}
	}}.server()
	defer e.Close()
	pc = setProvider(t, "elevenlabs", e.URL, VoiceSettings{})
	if txt, err := pc.transcribe(ctx, "scribe_v1", "pt", "", audio, "audio/webm"); err != nil || txt != "eleven" {
		t.Fatalf("elevenlabs: %q %v", txt, err)
	}

	// Deepgram /listen (corpo cru, Token, keyterm)
	d := fakeProv{t: t, answer: `{"results":{"channels":[{"alternatives":[{"transcript":"deepgram ok"}]}]}}`, check: func(r *http.Request, b []byte) {
		q := r.URL.Query()
		if r.URL.Path != "/listen" || r.Header.Get("Authorization") != "Token chave-falsa-deepgram" || q.Get("model") != "nova-3" || q.Get("language") != "pt-BR" || q["keyterm"][0] != "WezTerm" || len(b) != len(audio) {
			t.Errorf("deepgram: %s %v %d", r.URL, r.Header, len(b))
		}
	}}.server()
	defer d.Close()
	pc = setProvider(t, "deepgram", d.URL, VoiceSettings{})
	if txt, err := pc.transcribe(ctx, "nova-3", "pt", "WezTerm", audio, "audio/webm"); err != nil || txt != "deepgram ok" {
		t.Fatalf("deepgram: %q %v", txt, err)
	}

	// Azure: deployment + api-version + api-key
	z := fakeProv{t: t, answer: `{"text":"azure ok"}`, check: func(r *http.Request, _ []byte) {
		if r.URL.Path != "/openai/deployments/meu-whisper/audio/transcriptions" || r.URL.Query().Get("api-version") != "2024-10-21" || r.Header.Get("api-key") != "chave-falsa-azure" {
			t.Errorf("azure: %s %v", r.URL, r.Header)
		}
	}}.server()
	defer z.Close()
	pc = setProvider(t, "azure", z.URL, VoiceSettings{})
	if txt, err := pc.transcribe(ctx, "meu-whisper", "pt", "", audio, "audio/webm"); err != nil || txt != "azure ok" {
		t.Fatalf("azure: %q %v", txt, err)
	}

	// /models
	m := fakeProv{t: t, answer: `{"data":[{"id":"b"},{"id":"a"}]}`}.server()
	defer m.Close()
	pc = setProvider(t, "groq", m.URL, VoiceSettings{})
	if ms, err := pc.listModels(ctx); err != nil || strings.Join(ms, ",") != "a,b" {
		t.Fatalf("models: %v %v", ms, err)
	}
	if msg, err := pc.test(ctx); err != nil || !strings.Contains(msg, "2 modelos") {
		t.Fatalf("test: %q %v", msg, err)
	}
}

func TestProviderErrors(t *testing.T) {
	withVoiceStores(t)
	ctx := context.Background()
	for status, want := range map[int]string{401: "recusou a chave", 429: "limite de uso", 500: "erro no servidor"} {
		s := fakeProv{t: t, status: status, answer: `{"error":"x"}`}.server()
		pc := setProvider(t, "deepinfra", s.URL, VoiceSettings{})
		_, err := pc.correct(ctx, "m", "sys", "x")
		s.Close()
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Fatalf("status %d => %v", status, err)
		}
	}
	slow := fakeProv{t: t, delay: 300 * time.Millisecond, answer: `{}`}.server()
	defer slow.Close()
	pc := setProvider(t, "deepinfra", slow.URL, VoiceSettings{})
	tctx, cancel := context.WithTimeout(ctx, 50*time.Millisecond)
	defer cancel()
	if _, err := pc.correct(tctx, "m", "sys", "x"); err == nil || !strings.Contains(err.Error(), "não respondeu a tempo") {
		t.Fatalf("timeout => %v", err)
	}
	// sem chave
	withVoiceStores(t)
	if _, err := settings.callFor("openai"); err == nil || !strings.Contains(err.Error(), "sem chave") {
		t.Fatalf("no key => %v", err)
	}
	// provedor local nao precisa de chave
	if _, err := settings.callFor("ollama"); err != nil {
		t.Fatal(err)
	}
}

func TestTranscribeEndpoint(t *testing.T) {
	withVoiceStores(t)
	s := fakeProv{t: t, answer: `{"text":"ditado"}`}.server()
	defer s.Close()
	setProvider(t, "deepinfra", s.URL, VoiceSettings{})
	post := func(ro bool, ct string, body []byte) *httptest.ResponseRecorder {
		srv := newServer("tok", 5555, "", newHub(ro))
		req := httptest.NewRequest("POST", "http://127.0.0.1:5555/api/voice/transcribe", bytes.NewReader(body))
		req.Host = "127.0.0.1:5555"
		req.Header.Set(tokenHeader, "tok")
		req.Header.Set("Content-Type", ct)
		rr := httptest.NewRecorder()
		srv.ServeHTTP(rr, req)
		return rr
	}
	audio := bytes.Repeat([]byte{9}, 500)
	if rr := post(false, "audio/webm;codecs=opus", audio); rr.Code != 200 || !strings.Contains(rr.Body.String(), `"text":"ditado"`) {
		t.Fatalf("ok: %d %s", rr.Code, rr.Body)
	}
	if rr := post(false, "text/plain", audio); rr.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("text/plain: %d", rr.Code)
	}
	if rr := post(true, "audio/webm", audio); rr.Code != http.StatusForbidden {
		t.Fatalf("read-only: %d", rr.Code)
	}
	if rr := post(false, "audio/webm", []byte{1}); rr.Code != http.StatusBadRequest {
		t.Fatalf("empty: %d", rr.Code)
	}
}
