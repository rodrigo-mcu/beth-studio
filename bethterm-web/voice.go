package main

// voice.go — microfone: transcricao (Whisper e afins) e correcao opcional
// por um modelo de linguagem, sempre chamados pelo Go (o navegador manda o
// audio para ca'; as chaves nunca saem do Go).
//
// Padrao: DeepInfra (API compativel com OpenAI e rota nativa de
// transcricao). Uma chave por provedor; as variaveis de ambiente de cada
// provedor (DEEPINFRA_API_KEY, OPENAI_API_KEY...) servem de alternativa.
// As chaves digitadas ficam cifradas com DPAPI (secrets_windows.go).
//
// Adaptadores: "openai" (compativel: /audio/transcriptions,
// /chat/completions, /models), "azure" (deployments + api-version),
// "anthropic" (/v1/messages), "elevenlabs" (Scribe), "deepgram" (/listen).
// Modelos sugeridos sao so' sugestoes editaveis (envelhecem rapido);
// "Buscar modelos" consulta /models quando o provedor tem.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime/multipart"
	"net"
	"net/http"
	"net/textproto"
	"net/url"
	"sort"
	"strings"
	"time"
)

// ---------------------------------------------------------------------------
// catalogo de provedores
// ---------------------------------------------------------------------------

type ProviderDef struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	Kind      string   `json:"kind"` // openai | azure | anthropic | elevenlabs | deepgram
	BaseURL   string   `json:"base_url"`
	AudioURL  string   `json:"audio_url,omitempty"` // base propria de audio (Fireworks)
	KeysURL   string   `json:"keys_url,omitempty"`
	STT       bool     `json:"stt"`
	LLM       bool     `json:"llm"`
	STTModels []string `json:"stt_models,omitempty"`
	LLMModels []string `json:"llm_models,omitempty"`
	NeedsKey  bool     `json:"needs_key"`
	Env       []string `json:"-"`
	Models    bool     `json:"models_list"` // tem GET /models
	Local     bool     `json:"local,omitempty"`
	EditURL   bool     `json:"edit_url,omitempty"` // URL base editavel na tela
	Notes     string   `json:"notes,omitempty"`
	// Login "device": a conta entra por código (OAuth device), não por chave colada.
	Login string `json:"login,omitempty"`
}

var providerCatalog = []ProviderDef{
	{ID: "deepinfra", Name: "DeepInfra", Kind: "openai", BaseURL: "https://api.deepinfra.com/v1/openai",
		KeysURL: "https://deepinfra.com/dash/api_keys", STT: true, LLM: true, NeedsKey: true, Models: true,
		STTModels: []string{"openai/whisper-large-v3-turbo", "openai/whisper-large-v3"},
		LLMModels: []string{"meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo", "mistralai/Mistral-Small-3.2-24B-Instruct-2506", "meta-llama/Llama-3.3-70B-Instruct-Turbo"},
		Env:       []string{"DEEPINFRA_TOKEN", "DEEPINFRA_API_KEY"}},
	{ID: "openai", Name: "OpenAI", Kind: "openai", BaseURL: "https://api.openai.com/v1",
		KeysURL: "https://platform.openai.com/api-keys", STT: true, LLM: true, NeedsKey: true, Models: true,
		STTModels: []string{"gpt-4o-transcribe", "gpt-4o-mini-transcribe", "whisper-1"},
		LLMModels: []string{"gpt-4.1-mini", "gpt-4o-mini"}, Env: []string{"OPENAI_API_KEY"}},
	{ID: "groq", Name: "Groq", Kind: "openai", BaseURL: "https://api.groq.com/openai/v1",
		KeysURL: "https://console.groq.com/keys", STT: true, LLM: true, NeedsKey: true, Models: true,
		STTModels: []string{"whisper-large-v3-turbo", "whisper-large-v3"},
		LLMModels: []string{"llama-3.3-70b-versatile", "llama-3.1-8b-instant"}, Env: []string{"GROQ_API_KEY"}},
	{ID: "together", Name: "Together AI", Kind: "openai", BaseURL: "https://api.together.xyz/v1",
		KeysURL: "https://api.together.ai/settings/api-keys", STT: true, LLM: true, NeedsKey: true, Models: true,
		STTModels: []string{"openai/whisper-large-v3"},
		LLMModels: []string{"meta-llama/Llama-3.3-70B-Instruct-Turbo"}, Env: []string{"TOGETHER_API_KEY"}},
	{ID: "fireworks", Name: "Fireworks AI", Kind: "openai", BaseURL: "https://api.fireworks.ai/inference/v1",
		AudioURL: "https://audio-prod.us-virginia-1.direct.fireworks.ai/v1",
		KeysURL:  "https://fireworks.ai/account/api-keys", STT: true, LLM: true, NeedsKey: true, Models: true, EditURL: true,
		STTModels: []string{"whisper-v3", "whisper-v3-turbo"},
		LLMModels: []string{"accounts/fireworks/models/llama-v3p3-70b-instruct"}, Env: []string{"FIREWORKS_API_KEY"},
		Notes: "O áudio usa uma URL própria (editável); o whisper-v3-turbo usa audio-turbo…"},
	{ID: "azure", Name: "Azure OpenAI", Kind: "azure", KeysURL: "https://portal.azure.com/",
		STT: true, LLM: true, NeedsKey: true, EditURL: true, Env: []string{"AZURE_OPENAI_API_KEY"},
		Notes: "Informe o endpoint (https://<recurso>.openai.azure.com) e a api-version; o modelo é o nome do deployment."},
	{ID: "elevenlabs", Name: "ElevenLabs (Scribe)", Kind: "elevenlabs", BaseURL: "https://api.elevenlabs.io/v1",
		KeysURL: "https://elevenlabs.io/app/settings/api-keys", STT: true, NeedsKey: true,
		STTModels: []string{"scribe_v1"}, Env: []string{"ELEVENLABS_API_KEY"}},
	{ID: "deepgram", Name: "Deepgram", Kind: "deepgram", BaseURL: "https://api.deepgram.com/v1",
		KeysURL: "https://console.deepgram.com/", STT: true, NeedsKey: true,
		STTModels: []string{"nova-3", "nova-2"}, Env: []string{"DEEPGRAM_API_KEY"}},
	{ID: "anthropic", Name: "Anthropic (Claude)", Kind: "anthropic", BaseURL: "https://api.anthropic.com/v1",
		KeysURL: "https://console.anthropic.com/settings/keys", LLM: true, NeedsKey: true, Models: true,
		LLMModels: []string{"claude-haiku-4-5", "claude-sonnet-4-5"}, Env: []string{"ANTHROPIC_API_KEY"}},
	{ID: "gemini", Name: "Google Gemini", Kind: "openai", BaseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
		KeysURL: "https://aistudio.google.com/apikey", LLM: true, NeedsKey: true, Models: true,
		LLMModels: []string{"gemini-2.5-flash", "gemini-2.5-flash-lite"}, Env: []string{"GEMINI_API_KEY"}},
	{ID: "openrouter", Name: "OpenRouter", Kind: "openai", BaseURL: "https://openrouter.ai/api/v1",
		KeysURL: "https://openrouter.ai/keys", LLM: true, NeedsKey: true, Models: true,
		LLMModels: []string{"anthropic/claude-haiku-4.5", "openai/gpt-4.1-mini"}, Env: []string{"OPENROUTER_API_KEY"}},
	{ID: "mistral", Name: "Mistral", Kind: "openai", BaseURL: "https://api.mistral.ai/v1",
		KeysURL: "https://console.mistral.ai/api-keys", LLM: true, NeedsKey: true, Models: true,
		LLMModels: []string{"mistral-small-latest"}, Env: []string{"MISTRAL_API_KEY"}},
	{ID: "xai", Name: "xAI (Grok)", Kind: "openai", BaseURL: "https://api.x.ai/v1",
		KeysURL: "https://console.x.ai/", LLM: true, NeedsKey: true, Models: true,
		LLMModels: []string{"grok-3-mini"}, Env: []string{"XAI_API_KEY"}},
	{ID: "grok-build", Name: "Grok Build", Kind: "openai", BaseURL: "https://api.x.ai/v1",
		LLM: true, NeedsKey: true, Login: "device", Models: true,
		LLMModels: []string{"grok-build-0.1", "grok-4.7"},
		Notes:     "Conta Grok Build. O Beth Studio mostra um código para autorizar no navegador."},
	{ID: "codex", Name: "Codex", Kind: "codex", BaseURL: "https://chatgpt.com/backend-api/codex",
		LLM: true, NeedsKey: true, Login: "device",
		LLMModels: []string{"gpt-5.6-terra", "gpt-5.5"},
		Notes:     "Conta ChatGPT/Codex. O Beth Studio mostra um código para digitar em auth.openai.com."},
	{ID: "ollama", Name: "Ollama (local)", Kind: "openai", BaseURL: "http://localhost:11434/v1",
		LLM: true, Local: true, Models: true, EditURL: true, LLMModels: []string{"llama3.2", "qwen2.5"}},
	{ID: "lmstudio", Name: "LM Studio (local)", Kind: "openai", BaseURL: "http://localhost:1234/v1",
		LLM: true, Local: true, Models: true, EditURL: true},
	{ID: "localwhisper", Name: "Whisper local (faster-whisper-server / LocalAI)", Kind: "openai", BaseURL: "http://localhost:8000/v1",
		STT: true, Local: true, Models: true, EditURL: true, STTModels: []string{"Systran/faster-whisper-large-v3"}},
	{ID: "custom", Name: "Personalizado (compatível com OpenAI)", Kind: "openai", BaseURL: "",
		STT: true, LLM: true, Models: true, EditURL: true},
}

func providerByID(id string) (ProviderDef, bool) {
	for _, p := range providerCatalog {
		if p.ID == id {
			return p, true
		}
	}
	return ProviderDef{}, false
}

// ---------------------------------------------------------------------------
// configuracao (web-settings.json -> "voice"; sem chaves)
// ---------------------------------------------------------------------------

type ProviderPrefs struct {
	BaseURL    string   `json:"base_url,omitempty"`
	AudioURL   string   `json:"audio_url,omitempty"`
	APIVersion string   `json:"api_version,omitempty"` // Azure
	STTModels  []string `json:"stt_models,omitempty"`
	LLMModels  []string `json:"llm_models,omitempty"`
	// DeepInfra: rota da transcricao ("" / "native" = nativa /v1/inference/<modelo>, o padrao; "openai" = OpenAI-compativel)
	Route string `json:"route,omitempty"`
}

type VoiceSettings struct {
	STTProvider   string `json:"stt_provider"`
	STTModel      string `json:"stt_model"`
	Language      string `json:"language"` // pt | en | es | auto ...
	LLMEnabled    bool   `json:"llm_enabled"`
	LLMProvider   string `json:"llm_provider"`
	LLMModel      string `json:"llm_model"`
	Prompt        string `json:"prompt"`     // "" = padrao
	Vocabulary    string `json:"vocabulary"` // um termo por linha
	PrefixEnabled *bool  `json:"prefix_enabled,omitempty"`
	PrefixText    string `json:"prefix_text"` // "" = padrao
	SendDirect    bool   `json:"send_direct"`
	PrivacyAck    bool   `json:"privacy_ack"`
	// Microfone escolhido: deviceId do navegador + nome (para reencontrar
	// se o id mudar). Vazio = padrao do Windows.
	MicDeviceID string `json:"mic_device_id,omitempty"`
	MicLabel    string `json:"mic_label,omitempty"`
	// Prazo da correcao em segundos (0 = padrao de 30 s).
	CorrectTimeoutSec int `json:"correct_timeout_sec,omitempty"`
	// Alerta de gasto mensal com IA em US$ (0 = sem alerta). So' avisa.
	MonthlyLimitUSD float64 `json:"monthly_limit_usd,omitempty"`
	// Vocabulario tecnico padrao (techvocab.go) junto do vocabulario do
	// usuario. nil = ligado.
	TechVocab *bool `json:"tech_vocab,omitempty"`
	// Mostrar o texto da correcao enquanto chega (padrao: nao; so' o final).
	ShowCorrectionStream bool `json:"show_correction_stream,omitempty"`
	// Assistente do editor SQL. Modelo proprio; a chave e' a do provedor.
	DBAssistEnabled  bool                     `json:"db_assist_enabled,omitempty"`
	DBAssistProvider string                   `json:"db_assist_provider,omitempty"`
	DBAssistModel    string                   `json:"db_assist_model,omitempty"`
	Providers        map[string]ProviderPrefs `json:"providers,omitempty"`
}

const defaultCorrectionPrompt = "Você corrige textos ditados por voz e transcritos automaticamente. O texto será enviado a um agente de IA de programação. " +
	"Corrija apenas erros de reconhecimento (palavras trocadas por outras de som parecido, termos técnicos, nomes de arquivos, comandos, siglas e identificadores), pontuação e maiúsculas. " +
	"Não traduza, não resuma, não responda ao conteúdo, não acrescente nem remova ideias. Mantenha o idioma original ({idioma}). " +
	"Termos do projeto e termos técnicos, com a grafia correta: {vocabulario}. " +
	"Termos técnicos costumam chegar escritos como soam em português: corrija essas variantes fonéticas para a grafia correta (só quando o contexto for técnico). Exemplos:\n{foneticos}\n" +
	"Se um trecho estiver ambíguo, mantenha a forma mais provável e marque-o entre [? ]. Devolva somente o texto corrigido."

const defaultVoicePrefix = "[Mensagem ditada por voz e transcrita automaticamente — pode conter erros de reconhecimento. Se algo parecer estranho ou ambíguo, pergunte antes de agir.]"

const defaultVocabulary = "BethTerm\nWezTerm\nWSL\nPowerShell\nClaude Code"

func (v VoiceSettings) withDefaults() VoiceSettings {
	if v.STTProvider == "" {
		v.STTProvider, v.STTModel = "deepinfra", "openai/whisper-large-v3-turbo"
	}
	if v.Language == "" {
		v.Language = "pt"
	}
	if v.LLMProvider == "" {
		v.LLMProvider = "deepinfra"
	}
	if v.PrefixEnabled == nil {
		t := true
		v.PrefixEnabled = &t
	}
	if v.PrefixText == "" {
		v.PrefixText = defaultVoicePrefix
	}
	if v.Prompt == "" {
		v.Prompt = defaultCorrectionPrompt
	}
	if v.Providers == nil {
		v.Providers = map[string]ProviderPrefs{}
	}
	return v
}

var languageNames = map[string]string{
	"pt": "português do Brasil (pt-BR)", "en": "inglês", "es": "espanhol", "fr": "francês", "de": "alemão", "it": "italiano",
	"auto": "o mesmo idioma do texto",
}

// vocabularyTerms: um termo por linha (ou virgula), sem repetidos.
func vocabularyTerms(v string) []string {
	var out []string
	seen := map[string]bool{}
	for _, t := range strings.FieldsFunc(v, func(r rune) bool { return r == '\n' || r == '\r' || r == ',' || r == ';' }) {
		t = strings.TrimSpace(t)
		if t != "" && !seen[strings.ToLower(t)] && len(out) < 1000 {
			seen[strings.ToLower(t)] = true
			out = append(out, t)
		}
	}
	return out
}

// buildSystemPrompt substitui {idioma} e {vocabulario}.
func buildSystemPrompt(tmpl, lang, vocab string) string {
	if strings.TrimSpace(tmpl) == "" {
		tmpl = defaultCorrectionPrompt
	}
	name := languageNames[lang]
	if name == "" {
		name = lang
	}
	terms := vocabularyTerms(vocab)
	list := "(nenhum)"
	if len(terms) > 0 {
		list = strings.Join(terms, ", ")
	}
	return strings.NewReplacer("{idioma}", name, "{vocabulario}", list, "{foneticos}", phoneticTable()).Replace(tmpl)
}

func cleanVoiceSettings(v VoiceSettings) (VoiceSettings, error) {
	if v.STTProvider != "" {
		if p, ok := providerByID(v.STTProvider); !ok || !p.STT {
			return v, fmt.Errorf("provedor de transcrição inválido: %s", v.STTProvider)
		}
	}
	if v.LLMProvider != "" {
		if p, ok := providerByID(v.LLMProvider); !ok || !p.LLM {
			return v, fmt.Errorf("provedor de correção inválido: %s", v.LLMProvider)
		}
	}
	if v.DBAssistProvider != "" {
		if p, ok := providerByID(v.DBAssistProvider); !ok || !p.LLM {
			return v, fmt.Errorf("provedor do assistente de banco inválido: %s", v.DBAssistProvider)
		}
	}
	if len(v.Prompt) > 8000 || len(v.Vocabulary) > 8000 || len(v.PrefixText) > 2000 || len(v.STTModel) > 200 || len(v.LLMModel) > 200 || len(v.DBAssistModel) > 200 || len(v.Language) > 10 ||
		len(v.MicDeviceID) > 200 || len(v.MicLabel) > 200 {
		return v, errors.New("texto grande demais")
	}
	if v.CorrectTimeoutSec != 0 && (v.CorrectTimeoutSec < 5 || v.CorrectTimeoutSec > 180) {
		return v, errors.New("prazo da correção deve ficar entre 5 e 180 s")
	}
	if v.MonthlyLimitUSD < 0 || v.MonthlyLimitUSD > 100000 {
		return v, errors.New("limite mensal inválido")
	}
	for id, pp := range v.Providers {
		if _, ok := providerByID(id); !ok {
			return v, fmt.Errorf("provedor desconhecido: %s", id)
		}
		for _, u := range []string{pp.BaseURL, pp.AudioURL} {
			if u == "" {
				continue
			}
			pu, err := url.Parse(u)
			if err != nil || (pu.Scheme != "https" && pu.Scheme != "http") || pu.Host == "" {
				return v, fmt.Errorf("URL inválida para %s: %s", id, u)
			}
		}
		if pp.Route != "" && pp.Route != "openai" && pp.Route != "native" {
			return v, fmt.Errorf("rota inválida para %s: %s", id, pp.Route)
		}
		if len(pp.STTModels) > 30 || len(pp.LLMModels) > 30 || len(pp.APIVersion) > 40 {
			return v, errors.New("listas grandes demais")
		}
	}
	return v, nil
}

func (st *settingsStore) voice() VoiceSettings {
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.s.Voice == nil {
		return VoiceSettings{}.withDefaults()
	}
	return st.s.Voice.withDefaults()
}

func (st *settingsStore) setVoice(v VoiceSettings) error {
	v, err := cleanVoiceSettings(v)
	if err != nil {
		return err
	}
	// texto igual ao padrao = guardar vazio (acompanha o padrao se mudar)
	if strings.TrimSpace(v.Prompt) == strings.TrimSpace(defaultCorrectionPrompt) {
		v.Prompt = ""
	}
	if strings.TrimSpace(v.PrefixText) == strings.TrimSpace(defaultVoicePrefix) {
		v.PrefixText = ""
	}
	st.mu.Lock()
	defer st.mu.Unlock()
	st.s.Voice = &v
	return st.saveLocked()
}

// ---------------------------------------------------------------------------
// chamadas aos provedores
// ---------------------------------------------------------------------------

type providerCall struct {
	def       ProviderDef
	prefs     ProviderPrefs
	key       string
	accountID string // Codex: chatgpt-account-id
	client    *http.Client
	stats     *callStats // opcional: mede o tempo ate o primeiro byte
	// rota da transcricao so' nesta chamada ("Comparar caminhos")
	routeOverride string
}

// sttRoute: DeepInfra usa por padrao a rota NATIVA de transcricao
// (/v1/inference/<modelo>); "openai" = rota OpenAI-compativel.
func (pc providerCall) sttRoute() string {
	if pc.def.ID != "deepinfra" {
		return "openai"
	}
	r := pc.routeOverride
	if r == "" {
		r = pc.prefs.Route
	}
	if r == "openai" {
		return "openai"
	}
	return "native"
}

// nativeInferenceURL: como o ia-gateway — https://api.deepinfra.com/v1/inference/
// + modelo sem o prefixo "openai/" (e com "openai/" se ficar sem dono).
func (pc providerCall) nativeInferenceURL(model string) string {
	m := strings.TrimPrefix(model, "openai/")
	if !strings.Contains(m, "/") {
		m = "openai/" + m
	}
	return strings.TrimSuffix(strings.TrimSuffix(pc.base(), "/"), "/openai") + "/inference/" + m
}

func (st *settingsStore) callFor(id string) (providerCall, error) {
	def, ok := providerByID(id)
	if !ok {
		return providerCall{}, fmt.Errorf("provedor desconhecido: %s", id)
	}
	v := st.voice()
	pc := providerCall{def: def, prefs: v.Providers[id], client: &http.Client{}}
	if def.Login == "device" {
		tok, err := accountEnsure(id)
		if err != nil {
			return pc, err
		}
		pc.key = tok.AccessToken
		pc.accountID = tok.AccountID
	} else {
		pc.key, _ = secrets.get(id, def.Env)
	}
	if def.NeedsKey && pc.key == "" {
		if def.Login == "device" {
			return pc, fmt.Errorf("entre com o código da conta %s em Provedores de IA", def.Name)
		}
		return pc, fmt.Errorf("sem chave de API para %s — cadastre em Voz e IA → Provedores", def.Name)
	}
	return pc, nil
}

func (pc providerCall) base() string {
	if pc.prefs.BaseURL != "" {
		return strings.TrimRight(pc.prefs.BaseURL, "/")
	}
	return strings.TrimRight(pc.def.BaseURL, "/")
}

func (pc providerCall) audioBase() string {
	if pc.prefs.AudioURL != "" {
		return strings.TrimRight(pc.prefs.AudioURL, "/")
	}
	if pc.def.AudioURL != "" {
		return strings.TrimRight(pc.def.AudioURL, "/")
	}
	return pc.base()
}

func (pc providerCall) azureURL(deployment, op string) (string, error) {
	if pc.base() == "" {
		return "", errors.New("informe o endpoint do Azure OpenAI")
	}
	ver := pc.prefs.APIVersion
	if ver == "" {
		ver = "2024-10-21"
	}
	return fmt.Sprintf("%s/openai/deployments/%s/%s?api-version=%s", pc.base(), url.PathEscape(deployment), op, url.QueryEscape(ver)), nil
}

func (pc providerCall) auth(req *http.Request) {
	if pc.key == "" {
		return
	}
	switch pc.def.Kind {
	case "azure":
		req.Header.Set("api-key", pc.key)
	case "anthropic":
		req.Header.Set("x-api-key", pc.key)
		req.Header.Set("anthropic-version", "2023-06-01")
	case "elevenlabs":
		req.Header.Set("xi-api-key", pc.key)
	case "deepgram":
		req.Header.Set("Authorization", "Token "+pc.key)
	case "codex":
		req.Header.Set("Authorization", "Bearer "+pc.key)
		if pc.accountID != "" {
			req.Header.Set("chatgpt-account-id", pc.accountID)
		}
		req.Header.Set("originator", "codex_cli_rs")
	default:
		if pc.def.ID == "deepinfra" && strings.Contains(req.URL.Path, "/inference/") {
			req.Header.Set("Authorization", "bearer "+pc.key) // como na documentacao da rota nativa da DeepInfra
			return
		}
		req.Header.Set("Authorization", "Bearer "+pc.key)
	}
}

// friendlyError: mensagens em pt-BR para os erros comuns.
func friendlyError(provider string, status int, body []byte, err error) error {
	if err != nil {
		var ne net.Error
		if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &ne) && ne.Timeout()) {
			return fmt.Errorf("%s não respondeu a tempo", provider)
		}
		return fmt.Errorf("sem conexão com %s (%v)", provider, err)
	}
	detail := strings.TrimSpace(string(body))
	if len(detail) > 300 {
		detail = detail[:300] + "…"
	}
	switch {
	case status == 401 || status == 403:
		return fmt.Errorf("%s recusou a chave (inválida ou sem permissão)", provider)
	case status == 429:
		return fmt.Errorf("%s: limite de uso atingido; tente de novo em instantes", provider)
	case status == 413:
		return fmt.Errorf("%s: áudio grande demais", provider)
	case status == 404:
		return fmt.Errorf("%s: endereço ou modelo não encontrado (%s)", provider, detail)
	case status >= 500:
		return fmt.Errorf("%s está com erro no servidor (%d)", provider, status)
	}
	return fmt.Errorf("%s respondeu %d: %s", provider, status, detail)
}

func (pc providerCall) do(ctx context.Context, req *http.Request) ([]byte, error) {
	pc.auth(req)
	resp, err := pc.client.Do(pc.traced(req.WithContext(ctx)))
	if err != nil {
		return nil, friendlyError(pc.def.Name, 0, nil, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return nil, friendlyError(pc.def.Name, 0, nil, err)
	}
	if resp.StatusCode/100 != 2 {
		return nil, friendlyError(pc.def.Name, resp.StatusCode, body, nil)
	}
	return body, nil
}

func audioFilename(mime string) string {
	switch {
	case strings.Contains(mime, "ogg"):
		return "audio.ogg"
	case strings.Contains(mime, "wav"):
		return "audio.wav"
	case strings.Contains(mime, "mp4") || strings.Contains(mime, "m4a"):
		return "audio.m4a"
	case strings.Contains(mime, "mpeg"):
		return "audio.mp3"
	}
	return "audio.webm"
}

// transcribe manda o audio ao provedor de transcricao.
func (pc providerCall) transcribe(ctx context.Context, model, lang, vocab string, audio []byte, mimeType string) (string, error) {
	if model == "" && len(pc.def.STTModels) > 0 {
		model = pc.def.STTModels[0]
	}
	terms := vocabularyTerms(vocab)
	switch pc.def.Kind {
	case "deepgram":
		q := url.Values{"model": {model}, "smart_format": {"true"}, "punctuate": {"true"}}
		if lang == "" || lang == "auto" {
			q.Set("detect_language", "true")
		} else if lang == "pt" {
			q.Set("language", "pt-BR")
		} else {
			q.Set("language", lang)
		}
		for _, t := range terms {
			q.Add("keyterm", t)
		}
		req, _ := http.NewRequest("POST", pc.base()+"/listen?"+q.Encode(), bytes.NewReader(audio))
		req.Header.Set("Content-Type", mimeType)
		body, err := pc.do(ctx, req)
		if err != nil {
			return "", err
		}
		var r struct {
			Results struct {
				Channels []struct {
					Alternatives []struct {
						Transcript string `json:"transcript"`
					} `json:"alternatives"`
				} `json:"channels"`
			} `json:"results"`
		}
		if json.Unmarshal(body, &r) != nil || len(r.Results.Channels) == 0 || len(r.Results.Channels[0].Alternatives) == 0 {
			return "", fmt.Errorf("%s: resposta inesperada", pc.def.Name)
		}
		return strings.TrimSpace(r.Results.Channels[0].Alternatives[0].Transcript), nil
	}

	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	h := make(textproto.MIMEHeader)
	if pc.sttRoute() == "native" {
		// Rota nativa da DeepInfra: campo "audio" (CreateFormFile),
		// "language"; resposta {"text":..., "segments":[...]}. O vocabulario vai
		// em "initial_prompt" (a API nativa aceita: "optional text to provide as
		// a prompt for the first window").
		fw, _ := mw.CreateFormFile("audio", audioFilename(mimeType))
		_, _ = fw.Write(audio)
		if lang != "" && lang != "auto" {
			_ = mw.WriteField("language", lang)
		}
		if len(terms) > 0 {
			_ = mw.WriteField("initial_prompt", strings.Join(terms, ", "))
		}
		_ = mw.Close()
		req, _ := http.NewRequest("POST", pc.nativeInferenceURL(model), &buf)
		req.Header.Set("Content-Type", mw.FormDataContentType())
		body, err := pc.do(ctx, req)
		if err != nil {
			return "", err
		}
		var r struct {
			Text     string `json:"text"`
			Segments []struct {
				Text string `json:"text"`
			} `json:"segments"`
		}
		if json.Unmarshal(body, &r) != nil {
			return "", fmt.Errorf("%s: resposta inesperada", pc.def.Name)
		}
		if strings.TrimSpace(r.Text) == "" && len(r.Segments) > 0 {
			var sb strings.Builder
			for _, sg := range r.Segments {
				sb.WriteString(sg.Text)
			}
			r.Text = sb.String()
		}
		return strings.TrimSpace(r.Text), nil
	}
	h.Set("Content-Disposition", fmt.Sprintf(`form-data; name="file"; filename="%s"`, audioFilename(mimeType)))
	h.Set("Content-Type", mimeType)
	fw, _ := mw.CreatePart(h)
	_, _ = fw.Write(audio)
	var target string
	switch pc.def.Kind {
	case "elevenlabs":
		_ = mw.WriteField("model_id", model)
		if lang != "" && lang != "auto" {
			_ = mw.WriteField("language_code", lang)
		}
		target = pc.base() + "/speech-to-text"
	case "azure":
		u, err := pc.azureURL(model, "audio/transcriptions")
		if err != nil {
			return "", err
		}
		target = u
	default: // openai compativel
		_ = mw.WriteField("model", model)
		target = pc.audioBase() + "/audio/transcriptions"
	}
	if pc.def.Kind == "openai" || pc.def.Kind == "azure" {
		if lang != "" && lang != "auto" {
			_ = mw.WriteField("language", lang)
		}
		if len(terms) > 0 { // dica de vocabulario
			_ = mw.WriteField("prompt", strings.Join(terms, ", "))
		}
		_ = mw.WriteField("response_format", "json")
	}
	_ = mw.Close()
	req, _ := http.NewRequest("POST", target, &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	body, err := pc.do(ctx, req)
	if err != nil {
		return "", err
	}
	var r struct {
		Text string `json:"text"`
	}
	if json.Unmarshal(body, &r) != nil {
		return "", fmt.Errorf("%s: resposta inesperada", pc.def.Name)
	}
	return strings.TrimSpace(r.Text), nil
}

// correct passa o texto num modelo de linguagem com o prompt de sistema.
func (pc providerCall) correct(ctx context.Context, model, system, text string) (string, error) {
	if pc.def.Kind == "codex" {
		out, _, err := pc.correctStream(ctx, model, system, text, func(string) {})
		return out, err
	}
	if model == "" && len(pc.def.LLMModels) > 0 {
		model = pc.def.LLMModels[0]
	}
	var target string
	var payload any
	switch pc.def.Kind {
	case "anthropic":
		target = pc.base() + "/messages"
		payload = map[string]any{"model": model, "max_tokens": 4096, "system": system,
			"messages": []map[string]string{{"role": "user", "content": text}}}
	case "azure":
		u, err := pc.azureURL(model, "chat/completions")
		if err != nil {
			return "", err
		}
		target = u
		payload = map[string]any{"temperature": 0, "messages": []map[string]string{{"role": "system", "content": system}, {"role": "user", "content": text}}}
	case "openai":
		target = pc.base() + "/chat/completions"
		payload = map[string]any{"model": model, "temperature": 0,
			"messages": []map[string]string{{"role": "system", "content": system}, {"role": "user", "content": text}}}
	default:
		return "", fmt.Errorf("%s não faz correção de texto", pc.def.Name)
	}
	b, _ := json.Marshal(payload)
	req, _ := http.NewRequest("POST", target, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	body, err := pc.do(ctx, req)
	if err != nil {
		return "", err
	}
	if pc.def.Kind == "anthropic" {
		var r struct {
			Content []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
		}
		if json.Unmarshal(body, &r) != nil || len(r.Content) == 0 {
			return "", fmt.Errorf("%s: resposta inesperada", pc.def.Name)
		}
		var sb strings.Builder
		for _, c := range r.Content {
			if c.Type == "" || c.Type == "text" {
				sb.WriteString(c.Text)
			}
		}
		return strings.TrimSpace(sb.String()), nil
	}
	var r struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if json.Unmarshal(body, &r) != nil || len(r.Choices) == 0 {
		return "", fmt.Errorf("%s: resposta inesperada", pc.def.Name)
	}
	return strings.TrimSpace(r.Choices[0].Message.Content), nil
}

// listModels: GET /models (quando o provedor tem).
func (pc providerCall) listModels(ctx context.Context) ([]string, error) {
	if !pc.def.Models {
		return nil, fmt.Errorf("%s não lista modelos", pc.def.Name)
	}
	if pc.base() == "" {
		return nil, errors.New("informe a URL base")
	}
	req, _ := http.NewRequest("GET", pc.base()+"/models", nil)
	body, err := pc.do(ctx, req)
	if err != nil {
		return nil, err
	}
	var r struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
		Models []struct { // Ollama nativo / outros
			Name string `json:"name"`
		} `json:"models"`
	}
	if json.Unmarshal(body, &r) != nil {
		return nil, fmt.Errorf("%s: resposta inesperada", pc.def.Name)
	}
	var out []string
	for _, m := range r.Data {
		out = append(out, m.ID)
	}
	for _, m := range r.Models {
		out = append(out, m.Name)
	}
	sort.Strings(out)
	if len(out) > 500 {
		out = out[:500]
	}
	return out, nil
}

// test: chamada minima para conferir URL e chave.
func (pc providerCall) test(ctx context.Context) (string, error) {
	switch pc.def.Kind {
	case "elevenlabs":
		req, _ := http.NewRequest("GET", pc.base()+"/user", nil)
		if _, err := pc.do(ctx, req); err != nil {
			return "", err
		}
		return "chave aceita", nil
	case "deepgram":
		req, _ := http.NewRequest("GET", pc.base()+"/projects", nil)
		if _, err := pc.do(ctx, req); err != nil {
			return "", err
		}
		return "chave aceita", nil
	case "azure":
		if pc.base() == "" {
			return "", errors.New("informe o endpoint do Azure OpenAI")
		}
		ver := pc.prefs.APIVersion
		if ver == "" {
			ver = "2024-10-21"
		}
		req, _ := http.NewRequest("GET", pc.base()+"/openai/models?api-version="+url.QueryEscape(ver), nil)
		if _, err := pc.do(ctx, req); err != nil {
			return "", err
		}
		return "endpoint e chave aceitos", nil
	case "codex":
		return "conta Codex ligada", nil
	}
	ms, err := pc.listModels(ctx)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("ok — %d modelos disponíveis", len(ms)), nil
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

type providerView struct {
	ProviderDef
	Prefs      ProviderPrefs `json:"prefs"`
	Configured bool          `json:"configured"`
	Masked     string        `json:"masked,omitempty"`
	KeySource  string        `json:"key_source,omitempty"` // salva | env:NOME
}

func voiceSnapshot() map[string]any {
	v := settings.voice()
	var provs []providerView
	for _, d := range providerCatalog {
		key, src := secrets.get(d.ID, d.Env)
		provs = append(provs, providerView{ProviderDef: d, Prefs: v.Providers[d.ID],
			Configured: key != "" || !d.NeedsKey, Masked: maskKey(key), KeySource: src})
	}
	return map[string]any{"settings": v, "providers": provs, "default_prompt": defaultCorrectionPrompt,
		"default_prefix": defaultVoicePrefix, "default_vocabulary": defaultVocabulary}
}

func (s *server) serveVoice(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/api/voice")
	if r.Method == http.MethodGet && path == "" {
		writeJSON(w, http.StatusOK, voiceSnapshot())
		return
	}
	if r.Method == http.MethodGet && path == "/tech-vocab" {
		all := techVocabFlat()
		ph := make([]map[string]string, 0, len(techPhonetic))
		for _, p := range techPhonetic {
			ph = append(ph, map[string]string{"heard": p[0], "term": p[1]})
		}
		writeJSON(w, http.StatusOK, map[string]any{"categories": techVocab, "total": len(all), "top": techTop, "phonetic": ph})
		return
	}
	if r.Method == http.MethodGet && path == "/sample" {
		serveVoiceSample(w)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "método não permitido", http.StatusMethodNotAllowed)
		return
	}
	if path == "/transcribe" {
		s.serveTranscribe(w, r)
		return
	}
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		http.Error(w, "use application/json", http.StatusUnsupportedMediaType)
		return
	}
	var req struct {
		VoiceSettings
		Provider string `json:"provider"`
		Key      string `json:"key"`
		Text     string `json:"text"`
		Refresh  bool   `json:"refresh"`
		Pane     *int   `json:"pane_id"`
		Test     bool   `json:"test"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 256<<10)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "JSON inválido"})
		return
	}
	// Le o corpo ate o fim: so' assim o servidor percebe o navegador
	// desistindo (r.Context() cancelado) e para a chamada ao provedor.
	_, _ = io.Copy(io.Discard, r.Body)
	fail := func(err error) { writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()}) }
	switch path {
	case "/settings":
		if err := settings.setVoice(req.VoiceSettings); err != nil {
			fail(err)
			return
		}
		writeJSON(w, http.StatusOK, voiceSnapshot())
	case "/key":
		if _, ok := providerByID(req.Provider); !ok {
			fail(errors.New("provedor desconhecido"))
			return
		}
		if err := secrets.set(req.Provider, req.Key); err != nil {
			fail(err)
			return
		}
		log.Printf("voz: chave de %s %s", req.Provider, map[bool]string{true: "apagada", false: "gravada (DPAPI)"}[strings.TrimSpace(req.Key) == ""])
		writeJSON(w, http.StatusOK, voiceSnapshot()) // nunca a chave
	case "/account/start":
		st, err := accountStart(r.Context(), req.Provider)
		if err != nil {
			fail(err)
			return
		}
		writeJSON(w, http.StatusOK, st)
	case "/account/poll":
		err := accountPoll(r.Context(), req.Provider)
		if errors.Is(err, errAcctPending) {
			writeJSON(w, http.StatusOK, map[string]string{"status": "pending"})
			return
		}
		if err != nil {
			fail(err)
			return
		}
		deviceMu.Lock()
		delete(deviceWaitBy, req.Provider)
		deviceMu.Unlock()
		writeJSON(w, http.StatusOK, voiceSnapshot())
	case "/account/logout":
		if err := clearAcct(req.Provider); err != nil {
			fail(err)
			return
		}
		writeJSON(w, http.StatusOK, voiceSnapshot())
	case "/test", "/models":
		pc, err := settings.callFor(req.Provider)
		if err != nil {
			fail(err)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
		defer cancel()
		if path == "/test" {
			msg, err := pc.test(ctx)
			if err != nil {
				fail(err)
				return
			}
			writeJSON(w, http.StatusOK, map[string]string{"message": msg})
			return
		}
		ms, err := pc.listModels(ctx)
		if err != nil {
			fail(err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"models": ms})
	case "/open-keys":
		d, ok := providerByID(req.Provider)
		if !ok || d.KeysURL == "" {
			fail(errors.New("sem página de chaves"))
			return
		}
		openInSystemBrowser(d.KeysURL)
		writeJSON(w, http.StatusOK, map[string]string{"url": d.KeysURL})
	case "/open-pricing":
		u := pricingURL(req.Provider)
		if u == "" {
			fail(errors.New("sem página de preços"))
			return
		}
		openInSystemBrowser(u)
		writeJSON(w, http.StatusOK, map[string]string{"url": u})
	case "/catalog":
		if _, ok := providerByID(req.Provider); !ok {
			fail(errors.New("provedor desconhecido"))
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
		defer cancel()
		writeJSON(w, http.StatusOK, modelCatalog(ctx, req.Provider, req.Refresh))
	case "/correct":
		if s.hub.readOnly {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "modo somente leitura"})
			return
		}
		if len(req.Text) == 0 || len(req.Text) > 20000 {
			fail(errors.New("texto vazio ou grande demais"))
			return
		}
		s.serveCorrect(w, r, req.Text, req.Pane, req.Test)
	default:
		http.Error(w, "não encontrado", http.StatusNotFound)
	}
}

const maxAudioBytes = 25 << 20

var allowedAudio = []string{"audio/webm", "audio/ogg", "audio/wav", "audio/x-wav", "audio/mp4", "audio/mpeg", "audio/m4a"}

func (s *server) serveTranscribe(w http.ResponseWriter, r *http.Request) {
	if s.hub.readOnly {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "modo somente leitura"})
		return
	}
	ct := strings.ToLower(strings.TrimSpace(r.Header.Get("Content-Type")))
	base := strings.TrimSpace(strings.Split(ct, ";")[0])
	ok := false
	for _, a := range allowedAudio {
		if base == a {
			ok = true
		}
	}
	if !ok {
		writeJSON(w, http.StatusUnsupportedMediaType, map[string]string{"error": "formato de áudio não aceito: " + base})
		return
	}
	audio, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxAudioBytes))
	if err != nil {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "áudio grande demais (máx. 25 MB, cerca de 10 min)"})
		return
	}
	if len(audio) < 100 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "áudio vazio"})
		return
	}
	s.transcribeAndLog(w, r, audio, ct)
}
