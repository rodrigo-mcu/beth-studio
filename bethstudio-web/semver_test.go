package main

import "testing"

func TestCompareSemverOrder(t *testing.T) {
	// Ordem do semver 2.0: número maior vence; pré-lançamento fica atrás
	// da versão final; 0.10.0 não é "menor" que 0.9.0 por texto.
	pairs := []struct{ a, b string }{
		{"0.10.0", "0.9.0"},
		{"0.2.0", "0.2.0-rc.1"},
		{"1.0.0", "1.0.0-rc.1"},
		{"1.0.0-alpha.1", "1.0.0-alpha"},
		{"1.0.0-beta.11", "1.0.0-beta.2"},
		{"1.0.0-alpha.beta", "1.0.0-alpha.1"},
		{"1.0.0-beta", "1.0.0-alpha.beta"},
		{"1.0.0-rc.1", "1.0.0-beta.11"},
		{"v0.2.0", "0.2.0"},
		{"1.0.0+aaa", "1.0.0+bbb"},
	}
	for _, p := range pairs {
		cmp, err := compareSemver(p.a, p.b)
		if err != nil {
			t.Fatalf("%s ? %s: %v", p.a, p.b, err)
		}
		want := 1
		if p.a == "v0.2.0" || p.a == "1.0.0+aaa" {
			want = 0
		}
		if cmp != want {
			t.Fatalf("compare(%s, %s) = %d, quero %d", p.a, p.b, cmp, want)
		}
	}
}

func TestReleaseIsNewerDevAndEmpty(t *testing.T) {
	if !releaseIsNewer("0.2.0", "dev") {
		t.Fatal("dev deveria ser mais antiga que um release")
	}
	if !releaseIsNewer("v0.2.0", "") {
		t.Fatal("versão vazia deveria ser mais antiga que um release")
	}
	if !releaseIsNewer("0.2.0", "não-é-versão") {
		t.Fatal("versão ilegível não pode quebrar a consulta")
	}
	if releaseIsNewer("0.2.0", "0.2.0") {
		t.Fatal("a mesma versão não é atualização")
	}
	if releaseIsNewer("0.2.0", "0.10.0") {
		t.Fatal("0.2.0 não é mais nova que 0.10.0")
	}
	if releaseIsNewer("0.2.0-rc.1", "0.2.0") {
		t.Fatal("pré-lançamento não é mais novo que a final")
	}
	if releaseIsNewer("dev", "0.1.0") {
		t.Fatal("tag ilegível não conta como atualização")
	}
}
