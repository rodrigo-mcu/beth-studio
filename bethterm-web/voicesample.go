package main

// voicesample.go — audio de exemplo do "Testar tudo" (voicesample/sample.wav,
// gerado no build por tools/makesample.ps1 com a voz TTS pt-BR do Windows).

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
)

//go:embed voicesample/sample.wav
var sampleWAV []byte

//go:embed voicesample/sample.json
var sampleInfoJSON []byte

type sampleInfo struct {
	Text    string `json:"text"`
	Voice   string `json:"voice"`
	Culture string `json:"culture"`
	Warning string `json:"warning"`
}

func voiceSampleInfo() sampleInfo {
	var i sampleInfo
	_ = json.Unmarshal(bytes.TrimPrefix(sampleInfoJSON, []byte("\xef\xbb\xbf")), &i)
	return i
}

// GET /api/voice/sample → audio/wav; texto e voz nos cabecalhos (URL-encoded).
func serveVoiceSample(w http.ResponseWriter) {
	i := voiceSampleInfo()
	sec, _ := wavSeconds(sampleWAV)
	w.Header().Set("Content-Type", "audio/wav")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Sample-Text", url.QueryEscape(i.Text))
	w.Header().Set("X-Sample-Voice", url.QueryEscape(i.Voice+" ("+i.Culture+")"))
	w.Header().Set("X-Sample-Warning", url.QueryEscape(i.Warning))
	w.Header().Set("X-Audio-Ms", strconv.Itoa(int(sec*1000)))
	_, _ = w.Write(sampleWAV)
}
