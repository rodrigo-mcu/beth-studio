package main

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestTechVocabListAndDedupe(t *testing.T) {
	all := techVocabFlat()
	if len(all) < 300 || len(all) > 550 {
		t.Fatalf("lista técnica com %d termos", len(all))
	}
	seen := map[string]bool{}
	for _, x := range all {
		k := strings.ToLower(x)
		if seen[k] {
			t.Fatalf("repetido: %q", x)
		}
		seen[k] = true
	}
	for _, want := range []string{"C#", "C++", "OpenAI", "DeepSeek", "Wireshark", "kubectl", "PostgreSQL", "CI/CD", "ConPTY"} {
		if !seen[strings.ToLower(want)] {
			t.Errorf("faltou %s", want)
		}
	}
	// o subconjunto da transcricao sai da lista (a UI marca em negrito)
	for _, x := range techTop {
		if !seen[strings.ToLower(x)] {
			t.Errorf("techTop fora da lista: %s", x)
		}
	}
	for _, p := range techPhonetic {
		if !seen[strings.ToLower(p[1])] {
			t.Errorf("exemplo fonético para termo fora da lista: %s", p[1])
		}
	}
	// grafia do usuario vence; sem repetir, sem vazios
	m := mergeVocab([]string{"Openai", "BethTerm", " "}, []string{"OpenAI", "Go", "bethterm", "Go"})
	if strings.Join(m, "|") != "Openai|BethTerm|Go" {
		t.Fatalf("merge = %v", m)
	}
}

func TestCorrectionPromptHasVocabAndPhonetics(t *testing.T) {
	on := VoiceSettings{Vocabulary: "BethTerm\nMeuServiço", Language: "pt"}
	p := buildSystemPrompt("", "pt", correctionVocab(on))
	for _, want := range []string{"BethTerm, MeuServiço, C, C++, C#", "DeepSeek", "Wireshark", `"c sharp / si sharp / cê sharp" → C#`, `→ OpenAI`, "português do Brasil"} {
		if !strings.Contains(p, want) {
			t.Fatalf("prompt sem %q:\n%s", want, p)
		}
	}
	if strings.Contains(p, "{foneticos}") || strings.Contains(p, "{vocabulario}") {
		t.Fatal("variável sem substituir")
	}
	off := false
	on.TechVocab = &off
	p = buildSystemPrompt("", "pt", correctionVocab(on))
	if strings.Contains(p, "Wireshark, ") || !strings.Contains(p, "BethTerm, MeuServiço") {
		t.Fatalf("desligado ainda manda os técnicos:\n%s", p)
	}
	// prompt proprio do usuario pode usar {foneticos}
	if got := buildSystemPrompt("V: {vocabulario}\n{foneticos}", "pt", "X"); !strings.HasPrefix(got, "V: X\n- \"") {
		t.Fatalf("prompt próprio = %q", got)
	}
}

func TestTranscriptionVocabFitsWhisperPrompt(t *testing.T) {
	v := VoiceSettings{Vocabulary: "BethTerm\nMeuServiço"}
	terms := vocabularyTerms(transcriptionVocab(v))
	joined := strings.Join(terms, ", ")
	if utf8.RuneCountInString(joined) > whisperPromptMaxChars {
		t.Fatalf("prompt do Whisper com %d caracteres", utf8.RuneCountInString(joined))
	}
	if terms[0] != "BethTerm" || terms[1] != "MeuServiço" || terms[2] != "OpenAI" {
		t.Fatalf("ordem = %v", terms[:4])
	}
	if len(terms) < 30 {
		t.Fatalf("poucos técnicos: %d", len(terms))
	}
	// usuario com muitos termos: os dele primeiro, corte no limite
	long := strings.Repeat("TermoDoProjetoMuitoComprido\n", 40)
	terms = vocabularyTerms(transcriptionVocab(VoiceSettings{Vocabulary: long + "Outro"}))
	if len(terms) == 0 || terms[0] != "TermoDoProjetoMuitoComprido" || utf8.RuneCountInString(strings.Join(terms, ", ")) > whisperPromptMaxChars {
		t.Fatalf("corte = %v", terms)
	}
	// tecnico desligado: so' os do usuario
	off := false
	if got := transcriptionVocab(VoiceSettings{Vocabulary: "A\nB", TechVocab: &off}); got != "A\nB" {
		t.Fatalf("desligado = %q", got)
	}
	if got := fitTerms([]string{"abc", "de", "fgh"}, 7); strings.Join(got, "|") != "abc|de" {
		t.Fatalf("fitTerms = %v", got)
	}
}
