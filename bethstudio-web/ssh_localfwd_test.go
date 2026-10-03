package main

import "testing"

func TestLocalFwdWatchCodexRedirect(t *testing.T) {
	var w localFwdWatch
	// Como o Codex imprime: o link é o auth.openai.com e o localhost vai
	// percent-encoded dentro do redirect_uri.
	raw := "open https://auth.openai.com/oauth/authorize?response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=abc fim"
	hits := w.feed(raw)
	if len(hits) != 1 || hits[0].Port != 1455 {
		t.Fatalf("hits: %+v", hits)
	}
	if hits[0].URL == "" || hits[0].URL[:8] != "https://" {
		t.Fatalf("devia abrir o link externo, não o callback: %q", hits[0].URL)
	}
	if again := w.feed(raw); len(again) != 0 {
		t.Fatalf("repetiu: %+v", again)
	}
}

func TestLocalFwdWatchPlainAndSplit(t *testing.T) {
	var w localFwdWatch
	if hits := w.feed("http://localhost:22/x http://localhost/y"); len(hits) != 0 {
		t.Fatalf("não devia: %+v", hits)
	}
	var w2 localFwdWatch
	if len(w2.feed("veja http://localhost:14")) != 0 {
		t.Fatal("cedo demais")
	}
	hits := w2.feed("55/cb?x=1 fim")
	if len(hits) != 1 || hits[0].Port != 1455 {
		t.Fatalf("partido: %+v", hits)
	}
}
