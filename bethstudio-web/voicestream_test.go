package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestMain: nenhum teste grava na pasta real do usuario (%APPDATA%\bethstudio).
func TestMain(m *testing.M) {
	// Só o binário de teste lê isto. O bethstudio-web.exe ignora a variável.
	if v := strings.TrimSpace(os.Getenv("BETHSTUDIO_UPDATE_BASE")); v != "" {
		if err := setUpdateTestBase(v); err != nil {
			fmt.Fprintln(os.Stderr, "BETHSTUDIO_UPDATE_BASE:", err)
			os.Exit(2)
		}
	}
	if os.Getenv("BETHSTUDIO_DATA_DIR") == "" {
		d, err := os.MkdirTemp("", "bethstudio-web-test-data")
		if err == nil {
			os.Setenv("BETHSTUDIO_DATA_DIR", d)
			code := m.Run()
			os.RemoveAll(d)
			os.Exit(code)
		}
	}
	os.Exit(m.Run())
}

// isolatedUsage: registro de uso num arquivo temporario.
func isolatedUsage(t *testing.T) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "ai-usage.jsonl")
	old := usageLog.path
	usageLog.path = p
	t.Cleanup(func() { usageLog.path = old })
	return p
}

// chatServer: servidor falso de chat. mode: sse | json | slow | sse-slow
func chatServer(t *testing.T, mode string, gotStream *bool) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		_, _ = io.Copy(io.Discard, r.Body)
		if gotStream != nil {
			*gotStream, _ = body["stream"].(bool)
		}
		switch mode {
		case "slow":
			select {
			case <-time.After(5 * time.Second):
			case <-r.Context().Done():
			}
			return
		case "json":
			w.Header().Set("Content-Type", "application/json")
			io.WriteString(w, `{"choices":[{"message":{"content":"texto corrigido"}}],"usage":{"prompt_tokens":120,"completion_tokens":7}}`)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fl := w.(http.Flusher)
		for i, part := range []string{"texto ", "corri", "gido"} {
			fmt.Fprintf(w, "data: {\"choices\":[{\"delta\":{\"content\":%q}}]}\n\n", part)
			fl.Flush()
			if mode == "sse-slow" && i == 0 {
				select {
				case <-time.After(5 * time.Second):
				case <-r.Context().Done():
					return
				}
			}
		}
		io.WriteString(w, "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":100,\"completion_tokens\":5}}\n\ndata: [DONE]\n\n")
	}))
}

func postCorrect(t *testing.T, srv http.Handler, text string) []map[string]any {
	t.Helper()
	b, _ := json.Marshal(map[string]any{"text": text, "pane_id": 7})
	req := httptest.NewRequest("POST", "http://127.0.0.1:5555/api/voice/correct", bytes.NewReader(b))
	req.Host = "127.0.0.1:5555"
	req.Header.Set(tokenHeader, "tok")
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	srv.ServeHTTP(rr, req)
	if rr.Code != 200 {
		t.Fatalf("status %d: %s", rr.Code, rr.Body)
	}
	var out []map[string]any
	sc := bufio.NewScanner(rr.Body)
	for sc.Scan() {
		var m map[string]any
		if json.Unmarshal(sc.Bytes(), &m) == nil {
			out = append(out, m)
		}
	}
	return out
}

func TestCorrectStreamingAndUsage(t *testing.T) {
	withVoiceStores(t)
	usage := isolatedUsage(t)
	var streamed bool
	s := chatServer(t, "sse", &streamed)
	defer s.Close()
	setProvider(t, "groq", s.URL, VoiceSettings{LLMEnabled: true, LLMProvider: "groq", LLMModel: "llama-3.3-70b-versatile"})
	evs := postCorrect(t, newServer("tok", 5555, "", newHub(false)), "texto corijido")
	if !streamed {
		t.Fatal("pedido sem stream:true")
	}
	var deltas []string
	for _, e := range evs[:len(evs)-1] {
		deltas = append(deltas, e["delta"].(string))
	}
	last := evs[len(evs)-1]
	if strings.Join(deltas, "") != "texto corrigido" || last["done"] != true || last["text"] != "texto corrigido" {
		t.Fatalf("eventos = %v", evs)
	}
	// usage informado pela API: 100/5 tokens; preco de referencia do Groq
	recs := (&usageStore{path: usage}).readAll()
	if len(recs) != 1 || recs[0].InTokens != 100 || recs[0].OutTokens != 5 || recs[0].Estimated || !recs[0].OK ||
		recs[0].Func != "correcao" || recs[0].Pane == nil || *recs[0].Pane != 7 || recs[0].PriceSource != "reference" {
		t.Fatalf("registro = %+v", recs)
	}
	want := 100/1e6*0.59 + 5/1e6*0.79
	if d := recs[0].CostUSD - want; d > 1e-9 || d < -1e-9 {
		t.Fatalf("custo %v, esperado %v", recs[0].CostUSD, want)
	}
	raw, _ := os.ReadFile(usage)
	if bytes.Contains(raw, []byte("corijido")) || bytes.Contains(raw, []byte("texto corrigido")) {
		t.Fatal("o registro de uso não pode conter o texto")
	}
}

func TestCorrectWithoutSSEUsesJSON(t *testing.T) {
	withVoiceStores(t)
	isolatedUsage(t)
	s := chatServer(t, "json", nil)
	defer s.Close()
	setProvider(t, "groq", s.URL, VoiceSettings{LLMEnabled: true, LLMProvider: "groq"})
	evs := postCorrect(t, newServer("tok", 5555, "", newHub(false)), "x")
	last := evs[len(evs)-1]
	if last["text"] != "texto corrigido" || last["in_tokens"].(float64) != 120 {
		t.Fatalf("eventos = %v", evs)
	}
}

func TestCorrectTimeout(t *testing.T) {
	withVoiceStores(t)
	usage := isolatedUsage(t)
	for _, mode := range []string{"slow", "sse-slow"} {
		s := chatServer(t, mode, nil)
		setProvider(t, "groq", s.URL, VoiceSettings{LLMEnabled: true, LLMProvider: "groq", CorrectTimeoutSec: 5})
		// prazo de 5 s e' o minimo da tela; no teste encurtamos pelo settings direto
		v := settings.voice()
		v.CorrectTimeoutSec = 5
		t0 := time.Now()
		evs := postCorrect(t, newServer("tok", 5555, "", newHub(false)), "abc")
		el := time.Since(t0)
		s.Close()
		last := evs[len(evs)-1]
		if last["timeout"] != true || !strings.Contains(last["error"].(string), "prazo de 5 s") {
			t.Fatalf("%s: eventos = %v", mode, evs)
		}
		if el < 4500*time.Millisecond || el > 8*time.Second {
			t.Fatalf("%s: prazo não respeitado: %s", mode, el)
		}
		if mode == "sse-slow" && evs[0]["delta"] != "texto " {
			t.Fatalf("o trecho que chegou antes do prazo deve ir para a UI: %v", evs)
		}
	}
	recs := (&usageStore{path: usage}).readAll()
	if len(recs) != 2 || recs[0].OK || !strings.Contains(recs[0].Error, "prazo") {
		t.Fatalf("registros = %+v", recs)
	}
}

func TestCorrectCancelStopsProviderCall(t *testing.T) {
	withVoiceStores(t)
	isolatedUsage(t)
	done := make(chan struct{})
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		<-r.Context().Done() // so' termina quando o bethstudio-web desiste
		close(done)
	}))
	defer s.Close()
	setProvider(t, "groq", s.URL, VoiceSettings{LLMEnabled: true, LLMProvider: "groq"})
	srv := httptest.NewServer(newServer("tok", 5555, "", newHub(false)))
	defer srv.Close()
	b, _ := json.Marshal(map[string]any{"text": "abc"})
	req, _ := http.NewRequest("POST", srv.URL+"/api/voice/correct", bytes.NewReader(b))
	req.Host = "127.0.0.1:5555"
	req.Header.Set(tokenHeader, "tok")
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(200 * time.Millisecond)
	resp.Body.Close() // "Pular correção" / "Cancelar": o navegador aborta
	http.DefaultClient.CloseIdleConnections()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("a chamada ao provedor continuou depois do cancelamento")
	}
}

func TestTranscribeTimingAndCost(t *testing.T) {
	withVoiceStores(t)
	usage := isolatedUsage(t)
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(150 * time.Millisecond)
		io.WriteString(w, `{"text":"ditado"}`)
	}))
	defer s.Close()
	setProvider(t, "groq", s.URL, VoiceSettings{STTProvider: "groq", STTModel: "whisper-large-v3-turbo"})
	srv := newServer("tok", 5555, "", newHub(false))
	req := httptest.NewRequest("POST", "http://127.0.0.1:5555/api/voice/transcribe", bytes.NewReader(bytes.Repeat([]byte{9}, 500)))
	req.Host = "127.0.0.1:5555"
	req.Header.Set(tokenHeader, "tok")
	req.Header.Set("Content-Type", "audio/webm")
	req.Header.Set("X-Audio-Ms", "60000")
	req.Header.Set("X-Pane-Id", "3")
	rr := httptest.NewRecorder()
	srv.ServeHTTP(rr, req)
	var got map[string]any
	_ = json.Unmarshal(rr.Body.Bytes(), &got)
	if rr.Code != 200 || got["ttfb_ms"].(float64) < 140 || got["audio_sec"].(float64) != 60 {
		t.Fatalf("%d %v", rr.Code, got)
	}
	recs := (&usageStore{path: usage}).readAll()
	// 1 min × US$ 0,04/h
	if len(recs) != 1 || recs[0].AudioSec != 60 || recs[0].Estimated || recs[0].TTFBMs < 140 || *recs[0].Pane != 3 {
		t.Fatalf("registro = %+v", recs)
	}
	if d := recs[0].CostUSD - 0.04/60; d > 1e-8 || d < -1e-8 {
		t.Fatalf("custo = %v", recs[0].CostUSD)
	}
}

func TestUsageRotationAndSummary(t *testing.T) {
	p := filepath.Join(t.TempDir(), "ai-usage.jsonl")
	u := &usageStore{path: p, max: 600}
	now := time.Date(2026, 9, 25, 15, 0, 0, 0, time.Local)
	mk := func(daysAgo int, cost float64, fn string) UsageRecord {
		return UsageRecord{TS: now.AddDate(0, 0, -daysAgo), Func: fn, Provider: "deepinfra", Model: "m", OK: true, CostUSD: cost}
	}
	for i := 0; i < 8; i++ {
		if err := u.append(mk(i, 0.01, "transcricao")); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := os.Stat(p + ".1"); err != nil {
		t.Fatal("sem rotação")
	}
	all := u.readAll()
	if len(all) == 0 || len(all) > 8 {
		t.Fatalf("lidos %d", len(all))
	}
	recs := []UsageRecord{mk(0, 0.5, "transcricao"), mk(0, 0.25, "correcao"), mk(3, 1, "correcao"), mk(40, 2, "transcricao")}
	s := summarize(recs, now, 1.5, 2)
	if s.Today.USD != 0.75 || s.Week.USD != 1.75 || s.All.USD != 3.75 || s.All.Calls != 4 {
		t.Fatalf("totais %+v %+v %+v", s.Today, s.Week, s.All)
	}
	if s.Month.USD != 1.75 || !s.OverLimit {
		t.Fatalf("mês %+v over=%v", s.Month, s.OverLimit)
	}
	if len(s.Daily) != 30 || s.Daily[29].USD != 0.75 || len(s.Recent) != 2 || s.Recent[0].CostUSD != 2 {
		t.Fatalf("diário/recentes: %d %+v %+v", len(s.Daily), s.Daily[29], s.Recent)
	}
	if s.ByFunc[0].Key != "transcricao" || s.ByFunc[0].USD != 2.5 {
		t.Fatalf("por função %+v", s.ByFunc)
	}
	rows := usageCSVRows(recs)
	if len(rows) != 5 || rows[0][0] != "data_hora" {
		t.Fatalf("csv %v", rows)
	}
}

func TestCostWithoutUsageIsEstimated(t *testing.T) {
	if estimateTokens("abcdefgh") != 2 || estimateTokens("") != 0 {
		t.Fatal("estimativa")
	}
	c := costUSD(UsageRecord{Func: "correcao", InTokens: 1_000_000, OutTokens: 500_000}, ModelCard{InPerM: 0.1, OutPerM: 0.32})
	if d := c - (0.1 + 0.16); d > 1e-9 || d < -1e-9 {
		t.Fatalf("custo %v", c)
	}
	if sec, est := audioSeconds("", bytes.Repeat([]byte{1}, 4000), "audio/webm"); !est || sec != 1 {
		t.Fatalf("estimativa de áudio %v %v", sec, est)
	}
	if sec, ok := wavSeconds(sampleWAV); !ok || sec < 2 || sec > 10 {
		t.Fatalf("wav de exemplo: %v %v", sec, ok)
	}
	if i := voiceSampleInfo(); !strings.Contains(i.Text, "Beth Studio") || i.Voice == "" {
		t.Fatalf("info do exemplo: %+v", i)
	}
}

func TestDeepInfraNativeRoute(t *testing.T) {
	withVoiceStores(t)
	isolatedUsage(t)
	var gotPath, gotField, gotAuth, gotLang string
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		_ = r.ParseMultipartForm(1 << 20)
		gotLang = r.FormValue("language")
		for k := range r.MultipartForm.File {
			gotField = k
		}
		if strings.Contains(r.URL.Path, "/inference/") {
			io.WriteString(w, `{"text":"","segments":[{"text":"nativo "},{"text":"ok"}],"language":"pt"}`)
			return
		}
		io.WriteString(w, `{"text":"compativel"}`)
	}))
	defer s.Close()
	// sem rota escolhida = nativa (padrao)
	v := VoiceSettings{STTProvider: "deepinfra", STTModel: "openai/whisper-large-v3-turbo"}
	pc := setProvider(t, "deepinfra", s.URL+"/v1/openai", v)
	txt, err := pc.transcribe(t.Context(), "openai/whisper-large-v3-turbo", "pt", "", bytes.Repeat([]byte{1}, 300), "audio/wav")
	if err != nil || txt != "nativo ok" || gotPath != "/v1/inference/openai/whisper-large-v3-turbo" || gotField != "audio" ||
		gotAuth != "bearer chave-falsa-deepinfra" || gotLang != "pt" {
		t.Fatalf("nativa: %q %v %s %s %q %q", txt, err, gotPath, gotField, gotAuth, gotLang)
	}
	if pc.nativeInferenceURL("whisper-large-v3") != s.URL+"/v1/inference/openai/whisper-large-v3" ||
		pc.nativeInferenceURL("Qwen/Qwen3-ASR-0.6B") != s.URL+"/v1/inference/Qwen/Qwen3-ASR-0.6B" {
		t.Fatal("URL nativa")
	}
	pc.routeOverride = "openai"
	txt, err = pc.transcribe(t.Context(), "openai/whisper-large-v3-turbo", "pt", "", bytes.Repeat([]byte{1}, 300), "audio/webm")
	if err != nil || txt != "compativel" || gotField != "file" || gotAuth != "Bearer chave-falsa-deepinfra" {
		t.Fatalf("compatível: %q %v %s", txt, err, gotField)
	}
	if _, err := cleanVoiceSettings(VoiceSettings{Providers: map[string]ProviderPrefs{"deepinfra": {Route: "x"}}}); err == nil {
		t.Fatal("rota inválida aceita")
	}
}

func TestTranscribeErrorKinds(t *testing.T) {
	withVoiceStores(t)
	isolatedUsage(t)
	post := func() *httptest.ResponseRecorder {
		req := httptest.NewRequest("POST", "http://127.0.0.1:5555/api/voice/transcribe", bytes.NewReader(bytes.Repeat([]byte{9}, 500)))
		req.Host = "127.0.0.1:5555"
		req.Header.Set(tokenHeader, "tok")
		req.Header.Set("Content-Type", "audio/webm")
		rr := httptest.NewRecorder()
		newServer("tok", 5555, "", newHub(false)).ServeHTTP(rr, req)
		return rr
	}
	body := func(rr *httptest.ResponseRecorder) map[string]any {
		var m map[string]any
		_ = json.Unmarshal(rr.Body.Bytes(), &m)
		return m
	}

	// sem chave configurada: erro amigavel + kind "auth", ANTES de qualquer envio ao provedor
	withVoiceStores(t)
	m := body(post())
	if m["kind"] != "auth" || !strings.Contains(m["error"].(string), "sem chave") {
		t.Fatalf("sem chave: %v", m)
	}

	for status, want := range map[int]string{401: "auth", 403: "auth", 429: "rate_limit", 500: "other", 404: "other"} {
		withVoiceStores(t)
		s := fakeProv{t: t, status: status, answer: `{"error":"x"}`}.server()
		setProvider(t, "deepinfra", s.URL, VoiceSettings{STTProvider: "deepinfra"})
		m := body(post())
		s.Close()
		if m["kind"] != want {
			t.Fatalf("status %d => kind %v (querido %s), erro=%v", status, m["kind"], want, m["error"])
		}
		if _, hasText := m["text"]; hasText {
			t.Fatalf("status %d: resposta de erro não devia ter texto", status)
		}
	}

	// rede indisponível (porta fechada): kind "network"
	withVoiceStores(t)
	setProvider(t, "deepinfra", "http://127.0.0.1:1", VoiceSettings{STTProvider: "deepinfra"})
	m = body(post())
	if m["kind"] != "network" {
		t.Fatalf("rede: %v", m)
	}

	// prazo esgotado: kind "timeout" (testado direto em pc.transcribe, sem esperar os 120s do handler)
	withVoiceStores(t)
	slow := fakeProv{t: t, delay: 200 * time.Millisecond, answer: `{"text":"x"}`}.server()
	defer slow.Close()
	pc := setProvider(t, "deepinfra", slow.URL, VoiceSettings{STTProvider: "deepinfra"})
	tctx, cancel := context.WithTimeout(t.Context(), 20*time.Millisecond)
	defer cancel()
	_, err := pc.transcribe(tctx, "openai/whisper-large-v3-turbo", "pt", "", bytes.Repeat([]byte{1}, 300), "audio/webm")
	if err == nil || classifyVoiceError(err) != "timeout" {
		t.Fatalf("timeout: %v (kind %s)", err, classifyVoiceError(err))
	}
}

func TestCorrectErrorKinds(t *testing.T) {
	withVoiceStores(t)
	isolatedUsage(t)
	// sem chave: kind "auth" tambem na correcao (mesmo tratamento da transcricao);
	// esse erro acontece ANTES do streaming comecar, entao a resposta e' um
	// JSON comum (400), nao NDJSON — por isso nao usamos o postCorrect (que
	// espera sempre 200 + NDJSON).
	b, _ := json.Marshal(map[string]any{"text": "abc"})
	req := httptest.NewRequest("POST", "http://127.0.0.1:5555/api/voice/correct", bytes.NewReader(b))
	req.Host = "127.0.0.1:5555"
	req.Header.Set(tokenHeader, "tok")
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	newServer("tok", 5555, "", newHub(false)).ServeHTTP(rr, req)
	var m map[string]any
	_ = json.Unmarshal(rr.Body.Bytes(), &m)
	if rr.Code != http.StatusBadRequest || m["kind"] != "auth" || !strings.Contains(m["error"].(string), "sem chave") {
		t.Fatalf("correção sem chave: %d %v", rr.Code, m)
	}
	// status 429 do provedor (aqui sim ja' streaming, NDJSON): kind "rate_limit"
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(429)
		io.WriteString(w, `{"error":"limite"}`)
	}))
	defer s.Close()
	setProvider(t, "groq", s.URL, VoiceSettings{LLMEnabled: true, LLMProvider: "groq"})
	evs := postCorrect(t, newServer("tok", 5555, "", newHub(false)), "abc")
	last := evs[len(evs)-1]
	if last["kind"] != "rate_limit" {
		t.Fatalf("correção 429: %v", evs)
	}
}
