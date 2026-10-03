package main

import (
	"bytes"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func near(a, b float64) bool { return math.Abs(a-b) < 1e-9 }

func TestDeepInfraPricing(t *testing.T) {
	body := `[
 {"model_name":"meta-llama/Llama-3.3-70B-Instruct-Turbo","type":"text-generation","deprecated":null,"private":0,"max_tokens":131072,
  "pricing":{"type":"tokens","cents_per_input_token":1e-05,"cents_per_output_token":3.2e-05}},
 {"model_name":"openai/whisper-large-v3-turbo","type":"automatic-speech-recognition","deprecated":null,"pricing":{"type":"input_length","cents_per_input_sec":0.000333}},
 {"model_name":"openai/whisper-base","type":"automatic-speech-recognition","deprecated":1722034220,"pricing":{"type":"time","cents_per_sec":0.05}},
 {"model_name":"some/tts","type":"text-to-speech","pricing":{"type":"input_character_length"}},
 {"model_name":"x/private","type":"text-generation","private":1,"pricing":{"type":"tokens"}}
]`
	ms, err := parseDeepInfraModels([]byte(body))
	if err != nil {
		t.Fatal(err)
	}
	if len(ms) != 2 {
		t.Fatalf("modelos = %+v", ms)
	}
	llm, stt := ms[0], ms[1]
	if llm.Func != "llm" || !near(llm.InPerM, 0.10) || !near(llm.OutPerM, 0.32) || llm.Context != 131072 || llm.Name != "Llama 3.3 70B Instruct Turbo" {
		t.Fatalf("llm = %+v", llm)
	}
	// 0.000333 centavos/s = 0.0001998 USD/min
	if stt.Func != "stt" || !near(stt.PerMin, 0.000333*60/100) || stt.InPerM != -1 {
		t.Fatalf("stt = %+v", stt)
	}
}

func TestOpenRouterPricing(t *testing.T) {
	body := `{"data":[{"id":"anthropic/claude-haiku-4.5","name":"Anthropic: Claude Haiku 4.5","context_length":200000,
	  "pricing":{"prompt":"0.000001","completion":"0.000005"}},{"id":"x/free","pricing":{"prompt":"0","completion":"0"}}]}`
	ms, err := parseOpenRouterModels([]byte(body))
	if err != nil {
		t.Fatal(err)
	}
	if len(ms) != 2 || !near(ms[0].InPerM, 1) || !near(ms[0].OutPerM, 5) || ms[0].Name != "Anthropic: Claude Haiku 4.5" {
		t.Fatalf("got %+v", ms)
	}
	if ms[1].InPerM != 0 || ms[1].Name != "Free" {
		t.Fatalf("free = %+v", ms[1])
	}
}

func TestReferenceCatalogHasDateAndLink(t *testing.T) {
	c := referenceCatalog(t.Context(), "groq")
	if c.Source != "reference" || c.AsOf != referencePricesDate || c.PricingURL == "" {
		t.Fatalf("catalogo = %+v", c)
	}
	var stt, llm int
	for _, m := range c.Models {
		switch m.Func {
		case "stt":
			stt++
			if m.InPerM != -1 {
				t.Fatalf("stt com preco de token: %+v", m)
			}
		case "llm":
			llm++
			if m.PerMin != -1 {
				t.Fatalf("llm com preco por minuto: %+v", m)
			}
		}
	}
	if stt == 0 || llm == 0 {
		t.Fatalf("stt=%d llm=%d", stt, llm)
	}
}

func TestUILogEndpoint(t *testing.T) {
	req := httptest.NewRequest("POST", "/api/log", bytes.NewBufferString(`{"msg":"mic: getUserMedia ok\nlinha 2"}`))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	serveUILog(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("status %d", rr.Code)
	}
	if got := cleanLogText("a\nb" + strings.Repeat("x", 400)); strings.Contains(got, "\n") || len([]rune(got)) != 301 {
		t.Fatalf("clean = %q", got)
	}
	bad := httptest.NewRequest("GET", "/api/log", nil)
	rr = httptest.NewRecorder()
	serveUILog(rr, bad)
	if rr.Code == http.StatusOK {
		t.Fatal("GET aceito")
	}
}

func TestVoiceSettingsMicFields(t *testing.T) {
	v := VoiceSettings{MicDeviceID: "abc", MicLabel: "Microfone (USB2.0 MIC)"}
	b, _ := json.Marshal(v)
	if !strings.Contains(string(b), `"mic_device_id":"abc"`) || !strings.Contains(string(b), `"mic_label"`) {
		t.Fatalf("json = %s", b)
	}
	v.MicLabel = strings.Repeat("x", 300)
	if _, err := cleanVoiceSettings(v); err == nil {
		t.Fatal("rótulo gigante aceito")
	}
}
