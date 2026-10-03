package main

import (
	"errors"
	"strings"
	"testing"
)

func TestPhoneLinkDetail(t *testing.T) {
	if got := phoneLinkDetail(errors.New("dial tcp 1.2.3.4:443: connectex: connection refused")); got != "o proxy recusou a conexão" {
		t.Fatal(got)
	}
	if got := phoneLinkDetail(errors.New("segredo inválido")); got != "o servidor recusou a linha colada" {
		t.Fatal(got)
	}
	if got := phoneLinkDetail(errors.New(strings.Repeat("x", 200))); len(got) != 140 {
		t.Fatal(len(got))
	}
}

func TestPhoneLinkView(t *testing.T) {
	phoneLink.set("up", "")
	link, detail := phoneLinkView()
	if link != "up" || detail != "" {
		t.Fatalf("%s %s", link, detail)
	}
	phoneLink.set("down", "o proxy recusou a conexão")
	link, detail = phoneLinkView()
	if link != "down" || detail == "" {
		t.Fatalf("%s %s", link, detail)
	}
}
