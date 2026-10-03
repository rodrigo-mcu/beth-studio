package main

// voicecatalog.go — catalogo de modelos com precos para o seletor em cards
// (Configuracoes → Voz e IA). Precos:
//   - DeepInfra: GET https://api.deepinfra.com/models/list (publico, sem chave)
//   - OpenRouter: GET https://openrouter.ai/api/v1/models (publico)
//   - demais: tabela de referencia embutida (com data) + os ids do /models do
//     provedor, se houver chave (sem preco).
// Cache de 24 h em memoria e em model-prices.json (pasta de dados).
// Nada aqui chama transcricao/chat: so' listas de modelos (GET).

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// ModelCard: um modelo no seletor. Precos em USD; -1 = desconhecido.
type ModelCard struct {
	ID      string  `json:"id"`
	Name    string  `json:"name"`
	Func    string  `json:"func"` // stt | llm
	PerMin  float64 `json:"per_min"`
	InPerM  float64 `json:"in_per_m"`
	OutPerM float64 `json:"out_per_m"`
	Context int     `json:"context,omitempty"`
}

type ModelCatalog struct {
	Provider   string      `json:"provider"`
	Source     string      `json:"source"` // api | reference
	AsOf       string      `json:"as_of"`  // RFC3339 (api) ou "2026-06" (referencia)
	PricingURL string      `json:"pricing_url,omitempty"`
	Note       string      `json:"note,omitempty"`
	Models     []ModelCard `json:"models"`
}

const referencePricesDate = "2026-06"

var pricingURLs = map[string]string{
	"deepinfra":  "https://deepinfra.com/pricing",
	"openai":     "https://openai.com/api/pricing/",
	"groq":       "https://groq.com/pricing",
	"together":   "https://www.together.ai/pricing",
	"fireworks":  "https://fireworks.ai/pricing",
	"elevenlabs": "https://elevenlabs.io/pricing/api",
	"deepgram":   "https://deepgram.com/pricing",
	"anthropic":  "https://www.anthropic.com/pricing#api",
	"gemini":     "https://ai.google.dev/gemini-api/docs/pricing",
	"openrouter": "https://openrouter.ai/models",
	"mistral":    "https://mistral.ai/pricing",
	"xai":        "https://docs.x.ai/docs/models",
	"azure":      "https://azure.microsoft.com/pricing/details/cognitive-services/openai-service/",
}

func pricingURL(provider string) string { return pricingURLs[provider] }

// Tabela de referencia (USD). Transcricao: por minuto; chat: por 1M tokens.
var referencePrices = map[string][]ModelCard{
	"openai": {
		{ID: "gpt-4o-transcribe", Func: "stt", PerMin: 0.006},
		{ID: "gpt-4o-mini-transcribe", Func: "stt", PerMin: 0.003},
		{ID: "whisper-1", Func: "stt", PerMin: 0.006},
		{ID: "gpt-4.1-mini", Func: "llm", InPerM: 0.40, OutPerM: 1.60, Context: 1047576},
		{ID: "gpt-4.1-nano", Func: "llm", InPerM: 0.10, OutPerM: 0.40, Context: 1047576},
		{ID: "gpt-4o-mini", Func: "llm", InPerM: 0.15, OutPerM: 0.60, Context: 128000},
		{ID: "gpt-4.1", Func: "llm", InPerM: 2.00, OutPerM: 8.00, Context: 1047576},
	},
	"groq": {
		{ID: "whisper-large-v3-turbo", Func: "stt", PerMin: 0.04 / 60},
		{ID: "whisper-large-v3", Func: "stt", PerMin: 0.111 / 60},
		{ID: "llama-3.3-70b-versatile", Func: "llm", InPerM: 0.59, OutPerM: 0.79, Context: 131072},
		{ID: "llama-3.1-8b-instant", Func: "llm", InPerM: 0.05, OutPerM: 0.08, Context: 131072},
	},
	"together": {
		{ID: "openai/whisper-large-v3", Func: "stt", PerMin: 0.0015},
		{ID: "meta-llama/Llama-3.3-70B-Instruct-Turbo", Func: "llm", InPerM: 0.88, OutPerM: 0.88, Context: 131072},
	},
	"fireworks": {
		{ID: "whisper-v3", Func: "stt", PerMin: 0.0015},
		{ID: "whisper-v3-turbo", Func: "stt", PerMin: 0.0009},
		{ID: "accounts/fireworks/models/llama-v3p3-70b-instruct", Func: "llm", InPerM: 0.90, OutPerM: 0.90, Context: 131072},
	},
	"elevenlabs": {{ID: "scribe_v1", Func: "stt", PerMin: 0.40 / 60}},
	"deepgram": {
		{ID: "nova-3", Func: "stt", PerMin: 0.0043},
		{ID: "nova-2", Func: "stt", PerMin: 0.0043},
	},
	"anthropic": {
		{ID: "claude-haiku-4-5", Func: "llm", InPerM: 1, OutPerM: 5, Context: 200000},
		{ID: "claude-sonnet-4-5", Func: "llm", InPerM: 3, OutPerM: 15, Context: 200000},
	},
	"gemini": {
		{ID: "gemini-2.5-flash", Func: "llm", InPerM: 0.30, OutPerM: 2.50, Context: 1048576},
		{ID: "gemini-2.5-flash-lite", Func: "llm", InPerM: 0.10, OutPerM: 0.40, Context: 1048576},
	},
	"mistral": {{ID: "mistral-small-latest", Func: "llm", InPerM: 0.10, OutPerM: 0.30, Context: 131072}},
	"xai":     {{ID: "grok-3-mini", Func: "llm", InPerM: 0.30, OutPerM: 0.50, Context: 131072}},
}

var catalogCache = struct {
	sync.Mutex
	m      map[string]ModelCatalog
	loaded bool
}{m: map[string]ModelCatalog{}}

const catalogTTL = 24 * time.Hour

func catalogFile() string { return filepath.Join(dataDir(), "model-prices.json") }

func modelCatalog(ctx context.Context, provider string, refresh bool) ModelCatalog {
	catalogCache.Lock()
	if !catalogCache.loaded {
		catalogCache.loaded = true
		if b, err := os.ReadFile(catalogFile()); err == nil {
			_ = json.Unmarshal(b, &catalogCache.m)
		}
	}
	c, ok := catalogCache.m[provider]
	catalogCache.Unlock()
	if ok && !refresh && c.Source == "api" {
		if t, err := time.Parse(time.RFC3339, c.AsOf); err == nil && time.Since(t) < catalogTTL {
			return c
		}
	}
	fresh, err := buildCatalog(ctx, provider)
	if err != nil {
		log.Printf("voz: catálogo de %s: %v", provider, err)
		if ok && c.Source == "api" { // mantem o ultimo bom
			c.Note = "não foi possível atualizar agora (" + err.Error() + "); mostrando os preços de " + c.AsOf
			return c
		}
		fresh = referenceCatalog(ctx, provider)
		fresh.Note = strings.TrimSpace("preços da API indisponíveis agora (" + err.Error() + "). " + fresh.Note)
	}
	if fresh.Source == "api" {
		catalogCache.Lock()
		catalogCache.m[provider] = fresh
		if b, err := json.Marshal(catalogCache.m); err == nil {
			tmp := catalogFile() + ".tmp"
			if os.WriteFile(tmp, b, 0o600) == nil {
				_ = os.Rename(tmp, catalogFile())
			}
		}
		catalogCache.Unlock()
	}
	return fresh
}

func buildCatalog(ctx context.Context, provider string) (ModelCatalog, error) {
	switch provider {
	case "deepinfra":
		b, err := getPublic(ctx, "https://api.deepinfra.com/models/list")
		if err != nil {
			return ModelCatalog{}, err
		}
		ms, err := parseDeepInfraModels(b)
		if err != nil {
			return ModelCatalog{}, err
		}
		return ModelCatalog{Provider: provider, Source: "api", AsOf: time.Now().Format(time.RFC3339), PricingURL: pricingURL(provider), Models: ms}, nil
	case "openrouter":
		b, err := getPublic(ctx, "https://openrouter.ai/api/v1/models")
		if err != nil {
			return ModelCatalog{}, err
		}
		ms, err := parseOpenRouterModels(b)
		if err != nil {
			return ModelCatalog{}, err
		}
		return ModelCatalog{Provider: provider, Source: "api", AsOf: time.Now().Format(time.RFC3339), PricingURL: pricingURL(provider), Models: ms}, nil
	}
	return referenceCatalog(ctx, provider), nil
}

// referenceCatalog: tabela embutida + ids do /models (sem preco).
func referenceCatalog(ctx context.Context, provider string) ModelCatalog {
	c := ModelCatalog{Provider: provider, Source: "reference", AsOf: referencePricesDate, PricingURL: pricingURL(provider)}
	seen := map[string]bool{}
	for _, m := range referencePrices[provider] {
		m.Name = friendlyModelName(m.ID)
		c.Models = append(c.Models, m)
		seen[m.ID] = true
	}
	def, _ := providerByID(provider)
	for _, id := range def.STTModels {
		if !seen[id] {
			seen[id] = true
			c.Models = append(c.Models, ModelCard{ID: id, Name: friendlyModelName(id), Func: "stt", PerMin: -1, InPerM: -1, OutPerM: -1})
		}
	}
	for _, id := range def.LLMModels {
		if !seen[id] {
			seen[id] = true
			c.Models = append(c.Models, ModelCard{ID: id, Name: friendlyModelName(id), Func: "llm", PerMin: -1, InPerM: -1, OutPerM: -1})
		}
	}
	if def.Models {
		if pc, err := settings.callFor(provider); err == nil && (!def.NeedsKey || pc.key != "") {
			if ids, err := pc.listModels(ctx); err == nil {
				for _, id := range ids {
					if seen[id] {
						continue
					}
					seen[id] = true
					f := guessFunc(id, def)
					if f == "" {
						continue
					}
					c.Models = append(c.Models, ModelCard{ID: id, Name: friendlyModelName(id), Func: f, PerMin: -1, InPerM: -1, OutPerM: -1})
				}
			} else {
				c.Note = "lista do provedor indisponível: " + err.Error()
			}
		}
	}
	for i := range c.Models { // campos de preco nao usados = -1
		m := &c.Models[i]
		if m.Func == "stt" {
			m.InPerM, m.OutPerM = -1, -1
			if m.PerMin == 0 {
				m.PerMin = -1
			}
		} else {
			m.PerMin = -1
			if m.InPerM == 0 && m.OutPerM == 0 {
				m.InPerM, m.OutPerM = -1, -1
			}
		}
	}
	return c
}

var sttIDRe = regexp.MustCompile(`(?i)whisper|transcri|scribe|nova-|speech|asr|voxtral`)
var nonChatRe = regexp.MustCompile(`(?i)embed|tts|dall-e|image|vision-only|moderation|rerank|audio-preview|realtime|guard`)

func guessFunc(id string, def ProviderDef) string {
	if sttIDRe.MatchString(id) {
		if def.STT {
			return "stt"
		}
		return ""
	}
	if def.LLM && !nonChatRe.MatchString(id) {
		return "llm"
	}
	return ""
}

func getPublic(ctx context.Context, u string) ([]byte, error) {
	req, _ := http.NewRequestWithContext(ctx, "GET", u, nil)
	req.Header.Set("Accept", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return b, nil
}

// parseDeepInfraModels: /models/list. Precos em CENTAVOS de dolar.
func parseDeepInfraModels(b []byte) ([]ModelCard, error) {
	var raw []struct {
		Name       string   `json:"model_name"`
		Type       string   `json:"type"`
		Deprecated *float64 `json:"deprecated"`
		Private    any      `json:"private"`
		MaxTokens  *int     `json:"max_tokens"`
		Pricing    struct {
			Type        string   `json:"type"`
			CentsIn     *float64 `json:"cents_per_input_token"`
			CentsOut    *float64 `json:"cents_per_output_token"`
			CentsSec    *float64 `json:"cents_per_sec"`
			CentsInSec  *float64 `json:"cents_per_input_sec"`
			CentsMinute *float64 `json:"cents_per_minute"`
		} `json:"pricing"`
	}
	if err := json.Unmarshal(b, &raw); err != nil {
		return nil, errors.New("resposta inesperada da DeepInfra")
	}
	var out []ModelCard
	for _, m := range raw {
		if m.Name == "" || (m.Deprecated != nil && *m.Deprecated != 0) {
			continue
		}
		if p, ok := m.Private.(bool); ok && p {
			continue
		}
		if f, ok := m.Private.(float64); ok && f != 0 {
			continue
		}
		c := ModelCard{ID: m.Name, Name: friendlyModelName(m.Name), PerMin: -1, InPerM: -1, OutPerM: -1}
		if m.MaxTokens != nil {
			c.Context = *m.MaxTokens
		}
		switch m.Type {
		case "text-generation":
			c.Func = "llm"
			if m.Pricing.CentsIn != nil {
				c.InPerM = *m.Pricing.CentsIn * 1e6 / 100
			}
			if m.Pricing.CentsOut != nil {
				c.OutPerM = *m.Pricing.CentsOut * 1e6 / 100
			}
		case "automatic-speech-recognition":
			c.Func = "stt"
			switch {
			case m.Pricing.CentsInSec != nil:
				c.PerMin = *m.Pricing.CentsInSec * 60 / 100
			case m.Pricing.CentsSec != nil:
				c.PerMin = *m.Pricing.CentsSec * 60 / 100
			case m.Pricing.CentsMinute != nil:
				c.PerMin = *m.Pricing.CentsMinute / 100
			}
		default:
			continue
		}
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	if len(out) == 0 {
		return nil, errors.New("DeepInfra não devolveu modelos")
	}
	return out, nil
}

// parseOpenRouterModels: /api/v1/models. Precos em USD por token (texto).
func parseOpenRouterModels(b []byte) ([]ModelCard, error) {
	var r struct {
		Data []struct {
			ID      string `json:"id"`
			Name    string `json:"name"`
			Context int    `json:"context_length"`
			Pricing struct {
				Prompt     string `json:"prompt"`
				Completion string `json:"completion"`
			} `json:"pricing"`
		} `json:"data"`
	}
	if err := json.Unmarshal(b, &r); err != nil {
		return nil, errors.New("resposta inesperada do OpenRouter")
	}
	var out []ModelCard
	for _, m := range r.Data {
		if m.ID == "" {
			continue
		}
		c := ModelCard{ID: m.ID, Name: m.Name, Func: "llm", PerMin: -1, InPerM: -1, OutPerM: -1, Context: m.Context}
		if c.Name == "" {
			c.Name = friendlyModelName(m.ID)
		}
		var in, outp float64
		if _, err := fmt.Sscan(m.Pricing.Prompt, &in); err == nil && in >= 0 {
			c.InPerM = in * 1e6
		}
		if _, err := fmt.Sscan(m.Pricing.Completion, &outp); err == nil && outp >= 0 {
			c.OutPerM = outp * 1e6
		}
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	if len(out) == 0 {
		return nil, errors.New("OpenRouter não devolveu modelos")
	}
	return out, nil
}

// friendlyModelName: "meta-llama/Llama-3.3-70B-Instruct-Turbo" -> "Llama 3.3 70B Instruct Turbo".
func friendlyModelName(id string) string {
	n := id
	if i := strings.LastIndex(n, "/"); i >= 0 {
		n = n[i+1:]
	}
	n = strings.NewReplacer("-", " ", "_", " ").Replace(n)
	words := strings.Fields(n)
	for i, w := range words {
		if w != "" && w[0] >= 'a' && w[0] <= 'z' {
			words[i] = strings.ToUpper(w[:1]) + w[1:]
		}
	}
	if len(words) == 0 {
		return id
	}
	return strings.Join(words, " ")
}

// serveUILog: POST /api/log {"msg": "..."} — passos curtos da UI (microfone
// etc.) no log do Go. So' texto curto, sem controle; nunca audio/chaves.
func serveUILog(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost || !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		http.Error(w, "use POST application/json", http.StatusBadRequest)
		return
	}
	var req struct {
		Msg string `json:"msg"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "JSON inválido"})
		return
	}
	log.Printf("ui: %s", cleanLogText(req.Msg))
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func cleanLogText(s string) string {
	s = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return ' '
		}
		return r
	}, s)
	if r := []rune(s); len(r) > 300 {
		s = string(r[:300]) + "…"
	}
	return s
}
