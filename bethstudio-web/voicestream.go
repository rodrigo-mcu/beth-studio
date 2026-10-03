package main

// voicestream.go — transcricao e correcao com prazos de verdade, tempos
// (ate o primeiro byte e total), logs de cada etapa, streaming da correcao
// (NDJSON para a UI) e o registro de custo (aiusage.go).

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptrace"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const defaultCorrectTimeout = 30 * time.Second

// classifyVoiceError: tipo do erro para a UI decidir o que oferecer
// ("Tentar novamente" reenviando o mesmo audio, ou um link direto para
// configurar a chave). Baseado no texto das mensagens em pt-BR que este
// arquivo e voice.go ja' geram (friendlyError, callFor) — nenhuma mudanca
// nessas mensagens, so' uma classificacao por cima.
func classifyVoiceError(err error) string {
	if err == nil {
		return ""
	}
	msg := err.Error()
	switch {
	case strings.Contains(msg, "sem chave de API"), strings.Contains(msg, "recusou a chave"):
		return "auth"
	case strings.Contains(msg, "limite de uso atingido"):
		return "rate_limit"
	case strings.Contains(msg, "não respondeu a tempo"):
		return "timeout"
	case strings.Contains(msg, "sem conexão com"):
		return "network"
	case strings.Contains(msg, "voltou vazia"), strings.Contains(msg, "só devolveu o raciocínio"):
		return "empty"
	default:
		return "other"
	}
}

// --- limpeza da resposta do corretor ---------------------------------------
//
// Alguns modelos "raciocinadores" (DeepSeek R1, a familia gpt-oss...) --
// principalmente atras de um proxy/servidor que nao separa os canais de
// raciocinio e resposta final -- deixam o "pensamento" dentro do proprio
// texto (tags <think>...</think>), ou mandam SO' o raciocinio num campo a
// parte (delta.reasoning / delta.reasoning_content) e terminam sem nunca
// preencher o conteudo de verdade (por exemplo, cortados pelo limite de
// tokens antes de chegar na resposta). O segundo caso e' a causa do "caixa
// de texto ficou vazia depois de uma correcao 'bem sucedida'": o texto
// concatenado (`content`) fica vazio, mas a chamada nao deu erro nenhum.
//
// Alguns modelos tambem embrulham a resposta inteira em aspas ou num bloco
// de codigo markdown, mesmo quando o prompt pede so' o texto corrigido.
//
// stripThinkTags / unwrapAnswer tratam isso; o vazio que sobrar (raciocinio
// sem resposta, ou os dois vazios) e' pego depois como erro (ver
// serveCorrect), com uma rede de seguranca: nunca um resultado vazio e'
// tratado como sucesso silencioso.

var thinkTagRe = regexp.MustCompile(`(?is)<think(?:ing)?>.*?</think(?:ing)?>`)

// stripThinkTags tira blocos de raciocinio deixados dentro do texto. Um
// bloco que abriu e nao fechou (cortado no meio) nao deixa nada aproveitavel
// depois dele.
func stripThinkTags(s string) string {
	s = thinkTagRe.ReplaceAllString(s, "")
	low := strings.ToLower(s)
	if i := strings.Index(low, "<think"); i >= 0 && !strings.Contains(low[i:], "</think") {
		s = s[:i]
	}
	return s
}

var codeFenceRe = regexp.MustCompile("(?s)^```[a-zA-Z0-9_-]*\n(.*)\n```$")

var quotePairs = [][2]rune{{'"', '"'}, {'\'', '\''}, {'“', '”'}, {'‘', '’'}}

// unwrapMatchingQuotes tira UM par de aspas que envolve a resposta inteira,
// so' quando esse caractere nao aparece mais dentro (senao pode ser uma fala
// citada de verdade, que o usuario ditou).
func unwrapMatchingQuotes(s string) string {
	r := []rune(s)
	if len(r) < 2 {
		return s
	}
	for _, p := range quotePairs {
		if r[0] != p[0] || r[len(r)-1] != p[1] {
			continue
		}
		inner := string(r[1 : len(r)-1])
		if !strings.ContainsRune(inner, p[0]) && !strings.ContainsRune(inner, p[1]) {
			return strings.TrimSpace(inner)
		}
	}
	return s
}

// unwrapAnswer: tira raciocinio, bloco de codigo e aspas que embrulham a
// resposta inteira. Chamada em toda resposta do corretor, com ou sem
// streaming, antes de decidir se deu certo.
func unwrapAnswer(s string) string {
	s = strings.TrimSpace(stripThinkTags(s))
	if m := codeFenceRe.FindStringSubmatch(s); m != nil {
		s = strings.TrimSpace(m[1])
	}
	return unwrapMatchingQuotes(s)
}

func correctTimeout(v VoiceSettings) time.Duration {
	if v.CorrectTimeoutSec >= 5 {
		return time.Duration(v.CorrectTimeoutSec) * time.Second
	}
	return defaultCorrectTimeout
}

// callStats: tempo ate o primeiro byte da resposta do provedor.
type callStats struct {
	start time.Time
	ttfb  time.Duration
}

func (pc providerCall) traced(req *http.Request) *http.Request {
	if pc.stats == nil {
		return req
	}
	st := pc.stats
	st.start = time.Now()
	tr := &httptrace.ClientTrace{GotFirstResponseByte: func() {
		if st.ttfb == 0 {
			st.ttfb = time.Since(st.start)
		}
	}}
	return req.WithContext(httptrace.WithClientTrace(req.Context(), tr))
}

// chatUsage: tokens informados pelo provedor (Reported) ou estimados.
type chatUsage struct {
	In, Out  int
	Reported bool
}

// provedores que aceitam stream_options.include_usage no streaming
var streamUsageOK = map[string]bool{"openai": true, "deepinfra": true, "groq": true, "together": true, "fireworks": true, "openrouter": true, "xai": true, "grok-build": true}

// correctStream: chat com stream:true; onDelta recebe o texto chegando.
// Se o provedor responder sem SSE, le a resposta inteira.
func (pc providerCall) correctStream(ctx context.Context, model, system, text string, onDelta func(string)) (string, chatUsage, error) {
	if model == "" && len(pc.def.LLMModels) > 0 {
		model = pc.def.LLMModels[0]
	}
	msgs := []map[string]string{{"role": "system", "content": system}, {"role": "user", "content": text}}
	var target string
	var payload map[string]any
	switch pc.def.Kind {
	case "anthropic":
		target = pc.base() + "/messages"
		payload = map[string]any{"model": model, "max_tokens": 4096, "system": system, "stream": true,
			"messages": []map[string]string{{"role": "user", "content": text}}}
	case "azure":
		u, err := pc.azureURL(model, "chat/completions")
		if err != nil {
			return "", chatUsage{}, err
		}
		target = u
		payload = map[string]any{"temperature": 0, "stream": true, "messages": msgs}
	case "openai":
		target = pc.base() + "/chat/completions"
		payload = map[string]any{"model": model, "temperature": 0, "stream": true, "messages": msgs}
		if streamUsageOK[pc.def.ID] {
			payload["stream_options"] = map[string]any{"include_usage": true}
		}
	case "codex":
		if system == "" {
			system = "You are a helpful assistant."
		}
		target = strings.TrimRight(pc.base(), "/") + "/responses"
		payload = map[string]any{
			"model": model, "instructions": system, "stream": true, "store": false,
			"input": []any{map[string]any{
				"type": "message", "role": "user",
				"content": []any{map[string]any{"type": "input_text", "text": text}},
			}},
		}
	default:
		return "", chatUsage{}, fmt.Errorf("%s não faz correção de texto", pc.def.Name)
	}
	b, _ := json.Marshal(payload)
	req, _ := http.NewRequestWithContext(ctx, "POST", target, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	pc.auth(req)
	resp, err := pc.client.Do(pc.traced(req))
	if err != nil {
		return "", chatUsage{}, friendlyError(pc.def.Name, 0, nil, ctxErr(ctx, err))
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
		return "", chatUsage{}, friendlyError(pc.def.Name, resp.StatusCode, body, nil)
	}
	if !strings.Contains(resp.Header.Get("Content-Type"), "event-stream") {
		body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
		if err != nil {
			return "", chatUsage{}, friendlyError(pc.def.Name, 0, nil, ctxErr(ctx, err))
		}
		out, reasoningOnly, u, err := parseChatBody(pc.def, body)
		out = unwrapAnswer(out)
		if err == nil && out == "" && reasoningOnly {
			err = fmt.Errorf("%s: o modelo só devolveu o raciocínio, sem resposta final", pc.def.Name)
		}
		if err == nil && out != "" {
			onDelta(out)
		}
		return out, u, err
	}
	var out string
	var reasoningOnly bool
	var u chatUsage
	if pc.def.Kind == "codex" {
		out, u, err = readCodexSSE(resp.Body, onDelta)
	} else {
		out, reasoningOnly, u, err = readChatSSE(pc.def.Kind, resp.Body, onDelta)
	}
	out = unwrapAnswer(out)
	if err != nil {
		return out, u, friendlyError(pc.def.Name, 0, nil, ctxErr(ctx, err))
	}
	if out == "" && reasoningOnly {
		return "", u, fmt.Errorf("%s: o modelo só devolveu o raciocínio, sem resposta final", pc.def.Name)
	}
	return out, u, nil
}

// ctxErr: prefere o erro do contexto (prazo/cancelamento) ao erro de rede.
func ctxErr(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return err
}

// parseChatBody: resposta sem streaming (OpenAI ou Anthropic), com usage.
// reasoningOnly volta true quando so' veio texto de raciocinio
// (message.reasoning_content, usado por varios provedores compativeis com
// OpenAI para modelos "raciocinadores"), sem nada no conteudo de verdade.
func parseChatBody(def ProviderDef, body []byte) (text string, reasoningOnly bool, usage chatUsage, err error) {
	var r struct {
		Choices []struct {
			Message struct {
				Content          string `json:"content"`
				ReasoningContent string `json:"reasoning_content"`
				Reasoning        string `json:"reasoning"`
			} `json:"message"`
		} `json:"choices"`
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
		Usage struct {
			Prompt     int `json:"prompt_tokens"`
			Completion int `json:"completion_tokens"`
			Input      int `json:"input_tokens"`
			Output     int `json:"output_tokens"`
		} `json:"usage"`
	}
	if json.Unmarshal(body, &r) != nil {
		return "", false, chatUsage{}, fmt.Errorf("%s: resposta inesperada", def.Name)
	}
	u := chatUsage{In: r.Usage.Prompt + r.Usage.Input, Out: r.Usage.Completion + r.Usage.Output}
	u.Reported = u.In > 0 || u.Out > 0
	var sb strings.Builder
	sawReasoning := false
	for _, c := range r.Choices {
		sb.WriteString(c.Message.Content)
		if c.Message.ReasoningContent != "" || c.Message.Reasoning != "" {
			sawReasoning = true
		}
		break
	}
	for _, c := range r.Content {
		if c.Type == "" || c.Type == "text" {
			sb.WriteString(c.Text)
		}
	}
	if sb.Len() == 0 && len(r.Choices) == 0 && len(r.Content) == 0 {
		return "", false, u, fmt.Errorf("%s: resposta inesperada", def.Name)
	}
	out := strings.TrimSpace(sb.String())
	return out, out == "" && sawReasoning, u, nil
}

// readChatSSE le "data: {...}" (OpenAI: choices[0].delta.content;
// Anthropic: content_block_delta) e o usage, se vier. reasoningOnly volta
// true quando so' chegou texto de raciocinio (delta.reasoning /
// delta.reasoning_content, formato usado por varios provedores
// compativeis com OpenAI para modelos "raciocinadores") e o campo de
// conteudo de verdade nunca veio preenchido.
func readChatSSE(kind string, r io.Reader, onDelta func(string)) (text string, reasoningOnly bool, usage chatUsage, err error) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	var sb strings.Builder
	var u chatUsage
	sawReasoning := false
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "[DONE]" {
			break
		}
		var ev struct {
			Type    string `json:"type"`
			Choices []struct {
				Delta struct {
					Content          string `json:"content"`
					ReasoningContent string `json:"reasoning_content"`
					Reasoning        string `json:"reasoning"`
				} `json:"delta"`
			} `json:"choices"`
			Delta struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"delta"`
			Message struct {
				Usage struct {
					Input int `json:"input_tokens"`
				} `json:"usage"`
			} `json:"message"`
			Usage *struct {
				Prompt     int `json:"prompt_tokens"`
				Completion int `json:"completion_tokens"`
				Output     int `json:"output_tokens"`
			} `json:"usage"`
		}
		if json.Unmarshal([]byte(data), &ev) != nil {
			continue
		}
		d := ""
		if kind == "anthropic" {
			switch ev.Type {
			case "content_block_delta":
				d = ev.Delta.Text
			case "message_start":
				if ev.Message.Usage.Input > 0 {
					u.In, u.Reported = ev.Message.Usage.Input, true
				}
			case "message_delta":
				if ev.Usage != nil && ev.Usage.Output > 0 {
					u.Out, u.Reported = ev.Usage.Output, true
				}
			}
		} else {
			if len(ev.Choices) > 0 {
				d = ev.Choices[0].Delta.Content
				if ev.Choices[0].Delta.ReasoningContent != "" || ev.Choices[0].Delta.Reasoning != "" {
					sawReasoning = true
				}
			}
			if ev.Usage != nil && (ev.Usage.Prompt > 0 || ev.Usage.Completion > 0) {
				u.In, u.Out, u.Reported = ev.Usage.Prompt, ev.Usage.Completion, true
			}
		}
		if d != "" {
			sb.WriteString(d)
			onDelta(d)
		}
	}
	out := sb.String()
	return out, strings.TrimSpace(out) == "" && sawReasoning, u, sc.Err()
}

// estimateTokens: ~4 caracteres por token (so' quando a API nao informa).
func estimateTokens(s string) int {
	n := utf8.RuneCountInString(s)
	if n == 0 {
		return 0
	}
	return (n + 3) / 4
}

// serveCorrect: POST /api/voice/correct → NDJSON:
//
//	{"delta":"..."} ... {"done":true,"text":...,"ms":...,"ttfb_ms":...,"cost_usd":...}
//	ou {"error":"...","timeout":true|false}
func (s *server) serveCorrect(w http.ResponseWriter, r *http.Request, text string, pane *int, test bool) {
	v := settings.voice()
	pc, err := settings.callFor(v.LLMProvider)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error(), "kind": classifyVoiceError(err)})
		return
	}
	model := v.LLMModel
	if model == "" && len(pc.def.LLMModels) > 0 {
		model = pc.def.LLMModels[0]
	}
	limit := correctTimeout(v)
	ctx, cancel := context.WithTimeout(r.Context(), limit)
	defer cancel()
	pc.stats = &callStats{}
	price := startPriceLookup(v.LLMProvider, model, "llm")
	system := buildSystemPrompt(v.Prompt, v.Language, correctionVocab(v))
	log.Printf("voz: correção início — %s / %s, %d caracteres, prazo %s", pc.def.ID, model, utf8.RuneCountInString(text), limit)

	w.Header().Set("Content-Type", "application/x-ndjson; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	fl, _ := w.(http.Flusher)
	enc := json.NewEncoder(w)
	emit := func(m map[string]any) {
		_ = enc.Encode(m)
		if fl != nil {
			fl.Flush()
		}
	}
	w.WriteHeader(http.StatusOK)
	if fl != nil {
		fl.Flush()
	}
	start := time.Now()
	var first time.Duration
	out, u, err := pc.correctStream(ctx, model, system, text, func(d string) {
		if first == 0 {
			first = time.Since(start)
		}
		emit(map[string]any{"delta": d})
	})
	total := time.Since(start)
	if first == 0 {
		first = pc.stats.ttfb
	}
	// Rede de seguranca: uma correcao "bem sucedida" (sem erro) que devolveu
	// so' espacos NUNCA vira sucesso silencioso — senao a caixa de texto no
	// popup fica vazia sem nenhum aviso (era exatamente esse o bug: a UI
	// tratava out == "" como resultado valido).
	if err == nil && strings.TrimSpace(out) == "" {
		err = fmt.Errorf("%s: a correção voltou vazia", pc.def.Name)
	}
	rec := UsageRecord{TS: time.Now(), Func: "correcao", Test: test, Provider: pc.def.ID, Model: model,
		Ms: total.Milliseconds(), TTFBMs: first.Milliseconds(), Pane: pane}
	if u.Reported {
		rec.InTokens, rec.OutTokens = u.In, u.Out
	} else {
		rec.InTokens, rec.OutTokens, rec.Estimated = estimateTokens(system)+estimateTokens(text), estimateTokens(out), true
	}
	if err != nil {
		timeout := errors.Is(ctx.Err(), context.DeadlineExceeded) && r.Context().Err() == nil
		canceled := r.Context().Err() != nil
		msg := err.Error()
		switch {
		case timeout:
			msg = fmt.Sprintf("a correção passou do prazo de %d s", int(limit.Seconds()))
			log.Printf("voz: correção TIMEOUT após %s (%s / %s)", total.Round(time.Millisecond), pc.def.ID, model)
		case canceled:
			msg = "correção cancelada"
			log.Printf("voz: correção cancelada pelo usuário após %s", total.Round(time.Millisecond))
		default:
			log.Printf("voz: correção erro após %s: %v", total.Round(time.Millisecond), err)
		}
		rec.Error = msg
		recordUsage(rec, price)
		if !canceled {
			kind := classifyVoiceError(err)
			if timeout {
				kind = "timeout"
			}
			emit(map[string]any{"error": msg, "timeout": timeout, "kind": kind})
		}
		return
	}
	rec.OK = true
	rec = recordUsage(rec, price)
	log.Printf("voz: correção ok em %s (1º trecho em %s), %d → %d caracteres, tokens %d/%d%s, US$ %.6f",
		total.Round(time.Millisecond), first.Round(time.Millisecond), utf8.RuneCountInString(text), utf8.RuneCountInString(out),
		rec.InTokens, rec.OutTokens, map[bool]string{true: " (estimado)"}[rec.Estimated], rec.CostUSD)
	emit(map[string]any{"done": true, "text": out, "ms": total.Milliseconds(), "ttfb_ms": first.Milliseconds(),
		"provider": pc.def.Name, "model": model, "in_tokens": rec.InTokens, "out_tokens": rec.OutTokens,
		"cost_usd": rec.CostUSD, "cost_estimated": rec.Estimated || rec.PriceSource != "api"})
}

// transcribeAndLog: transcricao com tempos (1º byte / total), logs e custo.
func (s *server) transcribeAndLog(w http.ResponseWriter, r *http.Request, audio []byte, ct string) {
	v := settings.voice()
	pc, err := settings.callFor(v.STTProvider)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error(), "kind": classifyVoiceError(err)})
		return
	}
	model := v.STTModel
	if model == "" && len(pc.def.STTModels) > 0 {
		model = pc.def.STTModels[0]
	}
	audioSec, estimated := audioSeconds(r.Header.Get("X-Audio-Ms"), audio, ct)
	var pane *int
	if n, err := strconv.Atoi(r.Header.Get("X-Pane-Id")); err == nil && n >= 0 {
		pane = &n
	}
	test := r.Header.Get("X-Voice-Test") == "1"
	if rt := r.Header.Get("X-Route"); test && (rt == "openai" || rt == "native") {
		pc.routeOverride = rt // "Comparar caminhos"
	}
	price := startPriceLookup(v.STTProvider, model, "stt")
	pc.stats = &callStats{}
	log.Printf("voz: transcrição início — %s / %s (rota %s), %d bytes (%s), %.1f s de áudio", pc.def.ID, model, pc.sttRoute(), len(audio), ct, audioSec)
	ctx, cancel := context.WithTimeout(r.Context(), 120*time.Second)
	defer cancel()
	start := time.Now()
	// o mime com codecs (ex. audio/webm;codecs=opus) vai inteiro no arquivo
	// vocabulario curto (prompt do Whisper): usuario + tecnicos mais frequentes
	text, err := pc.transcribe(ctx, model, v.Language, transcriptionVocab(v), audio, ct)
	total := time.Since(start)
	rec := UsageRecord{TS: time.Now(), Func: "transcricao", Test: test, Provider: pc.def.ID, Model: model,
		AudioSec: audioSec, Estimated: estimated, Ms: total.Milliseconds(), TTFBMs: pc.stats.ttfb.Milliseconds(), Pane: pane}
	if err != nil {
		canceled := r.Context().Err() != nil
		kind := classifyVoiceError(err)
		if canceled {
			err = errors.New("transcrição cancelada")
			kind = "canceled"
		}
		log.Printf("voz: transcrição erro após %s: %v", total.Round(time.Millisecond), err)
		rec.Error = err.Error()
		recordUsage(rec, price)
		if !canceled {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error(), "kind": kind})
		}
		return
	}
	rec.OK = true
	rec = recordUsage(rec, price)
	log.Printf("voz: transcrição ok — %d bytes por %s em %s (1º byte em %s), %d caracteres, US$ %.6f",
		len(audio), pc.def.ID, total.Round(time.Millisecond), pc.stats.ttfb.Round(time.Millisecond), utf8.RuneCountInString(text), rec.CostUSD)
	writeJSON(w, http.StatusOK, map[string]any{"text": text, "ms": total.Milliseconds(), "ttfb_ms": pc.stats.ttfb.Milliseconds(),
		"provider": pc.def.Name, "model": model, "audio_sec": audioSec, "bytes": len(audio), "route": pc.sttRoute(),
		"cost_usd": rec.CostUSD, "cost_estimated": rec.Estimated || rec.PriceSource != "api"})
}

// audioSeconds: duracao informada pelo gravador (X-Audio-Ms); WAV pelo
// cabecalho; senao estimada pelo tamanho (opus ~ 32 kbit/s).
func audioSeconds(hdr string, audio []byte, ct string) (float64, bool) {
	if ms, err := strconv.Atoi(strings.TrimSpace(hdr)); err == nil && ms > 0 && ms < 3600_000 {
		return float64(ms) / 1000, false
	}
	if sec, ok := wavSeconds(audio); ok {
		return sec, false
	}
	return float64(len(audio)) * 8 / 32000, true
}

func wavSeconds(b []byte) (float64, bool) {
	if len(b) < 44 || string(b[0:4]) != "RIFF" || string(b[8:12]) != "WAVE" {
		return 0, false
	}
	var byteRate uint32
	for i := 12; i+8 <= len(b); {
		id := string(b[i : i+4])
		size := uint32(b[i+4]) | uint32(b[i+5])<<8 | uint32(b[i+6])<<16 | uint32(b[i+7])<<24
		if id == "fmt " && i+16 <= len(b) {
			byteRate = uint32(b[i+16]) | uint32(b[i+17])<<8 | uint32(b[i+18])<<16 | uint32(b[i+19])<<24
		}
		if id == "data" && byteRate > 0 {
			return float64(size) / float64(byteRate), true
		}
		i += 8 + int(size) + int(size&1)
	}
	return 0, false
}

// readCodexSSE lê o SSE da Responses API do Codex
// (response.output_text.delta). O endpoint exige stream=true.
func readCodexSSE(r io.Reader, onDelta func(string)) (string, chatUsage, error) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64<<10), 2<<20)
	var b strings.Builder
	var u chatUsage
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "" || data == "[DONE]" {
			continue
		}
		var ev struct {
			Type     string `json:"type"`
			Delta    string `json:"delta"`
			Response struct {
				Usage struct {
					Input  int `json:"input_tokens"`
					Output int `json:"output_tokens"`
				} `json:"usage"`
			} `json:"response"`
		}
		if json.Unmarshal([]byte(data), &ev) != nil {
			continue
		}
		if ev.Type == "response.output_text.delta" && ev.Delta != "" {
			b.WriteString(ev.Delta)
			onDelta(ev.Delta)
		}
		if ev.Response.Usage.Input > 0 || ev.Response.Usage.Output > 0 {
			u = chatUsage{In: ev.Response.Usage.Input, Out: ev.Response.Usage.Output, Reported: true}
		}
	}
	if err := sc.Err(); err != nil {
		return b.String(), u, err
	}
	return strings.TrimSpace(b.String()), u, nil
}
