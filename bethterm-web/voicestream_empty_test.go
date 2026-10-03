package main

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// rawSSEServer: servidor falso que devolve exatamente os eventos SSE dados,
// para simular formatos de resposta de modelos "raciocinadores" (gpt-oss,
// DeepSeek R1 etc.) — raciocinio num campo a parte, sem nunca preencher o
// conteudo de verdade; o texto envolto em aspas ou bloco de codigo; etc.
func rawSSEServer(t *testing.T, events ...string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "text/event-stream")
		fl := w.(http.Flusher)
		for _, e := range events {
			io.WriteString(w, "data: "+e+"\n\n")
			fl.Flush()
		}
		io.WriteString(w, "data: [DONE]\n\n")
	}))
}

// lastEvent: o ultimo evento NDJSON (o "done" ou o "error" final).
func lastEvent(t *testing.T, evs []map[string]any) map[string]any {
	t.Helper()
	if len(evs) == 0 {
		t.Fatal("nenhum evento")
	}
	return evs[len(evs)-1]
}

func TestCorrectEmptyResponseIsError(t *testing.T) {
	withVoiceStores(t)
	isolatedUsage(t)
	// content vazio, sem nenhum campo de raciocinio: o modelo so' respondeu vazio mesmo
	s := rawSSEServer(t, `{"choices":[{"delta":{"content":""}}]}`,
		`{"choices":[],"usage":{"prompt_tokens":80,"completion_tokens":1}}`)
	defer s.Close()
	setProvider(t, "groq", s.URL, VoiceSettings{LLMEnabled: true, LLMProvider: "groq"})
	last := lastEvent(t, postCorrect(t, newServer("tok", 5555, "", newHub(false)), "abc"))
	if last["error"] != "Groq: a correção voltou vazia" || last["kind"] != "empty" {
		t.Fatalf("vazio => %v", last)
	}
}

func TestCorrectWhitespaceOnlyResponseIsError(t *testing.T) {
	withVoiceStores(t)
	isolatedUsage(t)
	s := rawSSEServer(t, `{"choices":[{"delta":{"content":"   \n\t  "}}]}`)
	defer s.Close()
	setProvider(t, "groq", s.URL, VoiceSettings{LLMEnabled: true, LLMProvider: "groq"})
	last := lastEvent(t, postCorrect(t, newServer("tok", 5555, "", newHub(false)), "abc"))
	if last["kind"] != "empty" {
		t.Fatalf("só espaços => %v", last)
	}
}

// TestCorrectReasoningOnlyIsError e' o bug relatado: um modelo raciocinador
// (ex. gpt-oss-20b) manda tudo pelo campo delta.reasoning_content e nunca
// preenche delta.content — antes, isso terminava sem erro com out == "",
// e a UI mostrava a caixa de correcao vazia como se tivesse dado certo.
func TestCorrectReasoningOnlyIsError(t *testing.T) {
	withVoiceStores(t)
	isolatedUsage(t)
	s := rawSSEServer(t,
		`{"choices":[{"delta":{"reasoning_content":"Vou analisar o texto ditado..."}}]}`,
		`{"choices":[{"delta":{"reasoning_content":" parece estar correto, mas vou revisar de novo"}}]}`,
		`{"choices":[{"delta":{}}],"usage":{"prompt_tokens":150,"completion_tokens":40}}`,
	)
	defer s.Close()
	setProvider(t, "groq", s.URL, VoiceSettings{LLMEnabled: true, LLMProvider: "groq", LLMModel: "openai/gpt-oss-20b"})
	evs := postCorrect(t, newServer("tok", 5555, "", newHub(false)), "abc")
	last := lastEvent(t, evs)
	if last["kind"] != "empty" || !strings.Contains(last["error"].(string), "só devolveu o raciocínio") {
		t.Fatalf("só raciocínio => %v", evs)
	}
	// nenhum "delta" de texto visivel deve ter vazado o raciocinio para a UI
	for _, e := range evs {
		if d, ok := e["delta"]; ok {
			t.Fatalf("raciocínio vazou como delta de texto: %v", d)
		}
	}
	// o custo (tokens de verdade gastos) ainda e' registrado, mas como falha
	usage := usageLog.readAll()
	if len(usage) != 1 || usage[0].OK || usage[0].OutTokens != 40 {
		t.Fatalf("uso = %+v", usage)
	}
}

// TestCorrectThinkTagsInsideContent: deploy que nao separa os canais e deixa
// o raciocinio dentro do proprio content, com tags <think>.
func TestCorrectThinkTagsInsideContent(t *testing.T) {
	withVoiceStores(t)
	isolatedUsage(t)
	s := rawSSEServer(t, `{"choices":[{"delta":{"content":"<think>o usuário disse open ai, deve ser OpenAI</think>Abra o OpenAI no navegador."}}]}`)
	defer s.Close()
	setProvider(t, "groq", s.URL, VoiceSettings{LLMEnabled: true, LLMProvider: "groq"})
	last := lastEvent(t, postCorrect(t, newServer("tok", 5555, "", newHub(false)), "abc"))
	if last["text"] != "Abra o OpenAI no navegador." {
		t.Fatalf("think tags => %v", last)
	}
}

// TestCorrectUnterminatedThinkTagIsError: o streaming foi cortado (prazo,
// limite de tokens) bem no meio do raciocinio — nada aproveitavel sobra.
func TestCorrectUnterminatedThinkTagIsError(t *testing.T) {
	withVoiceStores(t)
	isolatedUsage(t)
	s := rawSSEServer(t, `{"choices":[{"delta":{"content":"<think>ainda pensando sobre C sharp vs C++"}}]}`)
	defer s.Close()
	setProvider(t, "groq", s.URL, VoiceSettings{LLMEnabled: true, LLMProvider: "groq"})
	last := lastEvent(t, postCorrect(t, newServer("tok", 5555, "", newHub(false)), "abc"))
	if last["kind"] != "empty" {
		t.Fatalf("think sem fechar => %v", last)
	}
}

func TestCorrectUnwrapsQuotesAndCodeFence(t *testing.T) {
	withVoiceStores(t)
	cases := map[string]string{
		`{"choices":[{"delta":{"content":"\"Abra o OpenAI no navegador.\""}}]}`:    "Abra o OpenAI no navegador.",
		"{\"choices\":[{\"delta\":{\"content\":\"```\\nAbra o OpenAI.\\n```\"}}]}": "Abra o OpenAI.",
		// aspas que aparecem tambem por dentro: e' fala citada de verdade, nao embrulho — mantem
		`{"choices":[{"delta":{"content":"\"ele disse \\\"oi\\\"\""}}]}`: `"ele disse \"oi\""`,
	}
	for body, want := range cases {
		isolatedUsage(t)
		s := rawSSEServer(t, body)
		setProvider(t, "groq", s.URL, VoiceSettings{LLMEnabled: true, LLMProvider: "groq"})
		last := lastEvent(t, postCorrect(t, newServer("tok", 5555, "", newHub(false)), "abc"))
		s.Close()
		if last["text"] != want {
			t.Fatalf("body=%s got=%v want=%q", body, last["text"], want)
		}
	}
}

func TestCorrectNonStreamingJSONReasoningOnly(t *testing.T) {
	withVoiceStores(t)
	isolatedUsage(t)
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"choices":[{"message":{"content":"","reasoning_content":"pensando..."}}],"usage":{"prompt_tokens":10,"completion_tokens":5}}`)
	}))
	defer s.Close()
	setProvider(t, "groq", s.URL, VoiceSettings{LLMEnabled: true, LLMProvider: "groq"})
	last := lastEvent(t, postCorrect(t, newServer("tok", 5555, "", newHub(false)), "abc"))
	if last["kind"] != "empty" || !strings.Contains(last["error"].(string), "raciocínio") {
		t.Fatalf("json sem streaming, só raciocínio => %v", last)
	}
}

// TestRetryCorrectionOnly cobre o botao "Corrigir novamente": o MESMO texto
// transcrito e' reenviado ao endpoint de correcao (o handler nao sabe nem
// precisa saber que e' um retry — e' so' outro POST /api/voice/correct); o
// segundo resultado substitui o primeiro.
func TestRetryCorrectionOnly(t *testing.T) {
	withVoiceStores(t)
	isolatedUsage(t)
	first := true
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "text/event-stream")
		if first {
			first = false
			io.WriteString(w, `data: {"choices":[{"delta":{"content":""}}]}`+"\n\n")
		} else {
			io.WriteString(w, `data: {"choices":[{"delta":{"content":"texto corrigido de verdade"}}]}`+"\n\n")
		}
		io.WriteString(w, "data: [DONE]\n\n")
	}))
	defer s.Close()
	setProvider(t, "groq", s.URL, VoiceSettings{LLMEnabled: true, LLMProvider: "groq"})
	srv := newServer("tok", 5555, "", newHub(false))
	last1 := lastEvent(t, postCorrect(t, srv, "texto ditado"))
	if last1["kind"] != "empty" {
		t.Fatalf("1ª tentativa deveria falhar: %v", last1)
	}
	last2 := lastEvent(t, postCorrect(t, srv, "texto ditado")) // "Corrigir novamente": mesmo texto, novo POST
	if last2["text"] != "texto corrigido de verdade" {
		t.Fatalf("2ª tentativa (retry) => %v", last2)
	}
}

func TestUnwrapAnswerDirect(t *testing.T) {
	cases := map[string]string{
		"  olá  ":                     "olá",
		"<think>oi</think>final":      "final",
		"<think>sem fechar":           "",
		"\"entre aspas\"":             "entre aspas",
		"```\nbloco\n```":             "bloco",
		"```go\ncode\n```":            "code",
		"'aspas simples'":             "aspas simples",
		`"tem 'aspas' dentro tambem"`: `tem 'aspas' dentro tambem`, // aspas de outro tipo por dentro nao bloqueiam
		"sem nada para tirar":         "sem nada para tirar",
	}
	for in, want := range cases {
		if got := unwrapAnswer(in); got != want {
			t.Errorf("unwrapAnswer(%q) = %q, queria %q", in, got, want)
		}
	}
}

func TestClassifyVoiceErrorEmpty(t *testing.T) {
	if classifyVoiceError(errors.New("Groq: a correção voltou vazia")) != "empty" {
		t.Fatal("kind empty (texto vazio)")
	}
	if classifyVoiceError(errors.New("Groq: o modelo só devolveu o raciocínio, sem resposta final")) != "empty" {
		t.Fatal("kind empty (só raciocínio)")
	}
}

var _ = bytes.NewReader // mantem o import se algum teste acima parar de usa-lo
