package main

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestUIBootInjection(t *testing.T) {
	dir := t.TempDir()
	old := settings
	settings = &settingsStore{}
	settings.load(dir)
	defer func() { settings = old }()

	// sem cache: nada injetado, fundo neutro para o WebView2
	if bootStyle(settings.uiCSS()) != "" || webviewBackground(nil) != "FF1E1E1E" {
		t.Fatal("defaults")
	}
	bad := []UICSS{
		{Vars: map[string]string{"bg-body": "1 2"}, Bg: "#ffffff"},
		{Vars: map[string]string{"bg body;}": "1 2 3"}, Bg: "#ffffff"},
		{Vars: map[string]string{"bg-body": "1 2 3"}, Bg: "red</style>"},
	}
	for i, u := range bad {
		if err := settings.setUICSS(u); err == nil {
			t.Fatalf("case %d accepted", i)
		}
	}
	if err := settings.setUICSS(UICSS{Vars: map[string]string{"bg-body": "247 247 244", "text-1": "15 23 41"}, Bg: "#F7F7F4"}); err != nil {
		t.Fatal(err)
	}
	st2 := &settingsStore{}
	st2.load(dir)
	css := bootStyle(st2.uiCSS())
	if !strings.Contains(css, "--bt-bg-body:247 247 244;") || !strings.Contains(css, "background:#F7F7F4") {
		t.Fatalf("css = %s", css)
	}
	if webviewBackground(st2.uiCSS()) != "FFF7F7F4" {
		t.Fatal("webview bg")
	}
	// o index.html servido ja' traz o <style> no <head>
	h := newHub(true)
	srv := newServer("tok", 5555, "", h)
	req := httptest.NewRequest("GET", "http://127.0.0.1:5555/?t=tok", nil)
	req.Host = "127.0.0.1:5555"
	rr := httptest.NewRecorder()
	srv.ServeHTTP(rr, req)
	body := rr.Body.String()
	if rr.Code != 200 || !strings.Contains(body, `<style id="bt-boot">`) || strings.Index(body, "bt-boot") > strings.Index(body, "</head>") {
		t.Fatalf("index: %d %s", rr.Code, body[:min(300, len(body))])
	}
}
