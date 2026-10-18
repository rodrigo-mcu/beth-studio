package vpsinstall

import "testing"

func TestValidateDomain(t *testing.T) {
	ok := []string{"agentes.exemplo.com", "A.B-c.Exemplo.com.", "x1.io"}
	bad := []string{"", "localhost", "1.2.3.4", "a b.com", "https://a.com", "a.com:80", "a.com/x", "-a.com", "a..com", "a.com;rm -rf /", "a_b.com", "$(id).com", "a.com\nb"}
	for _, d := range ok {
		if err := ValidateDomain(d); err != nil {
			t.Errorf("%q deveria valer: %v", d, err)
		}
	}
	for _, d := range bad {
		if ValidateDomain(d) == nil {
			t.Errorf("%q deveria ser recusado", d)
		}
	}
}

func TestValidateHostUserPort(t *testing.T) {
	for _, h := range []string{"203.0.113.9", "2001:db8::1", "vps.exemplo.com"} {
		if err := ValidateHost(h); err != nil {
			t.Errorf("host %q: %v", h, err)
		}
	}
	for _, h := range []string{"", "a b", "ssh://x.com", "x.com:22", "x;y", "[::1]"} {
		if ValidateHost(h) == nil {
			t.Errorf("host %q deveria falhar", h)
		}
	}
	for _, u := range []string{"root", "ubuntu", "deploy_1", "a-b"} {
		if ValidateUser(u) != nil {
			t.Errorf("user %q", u)
		}
	}
	for _, u := range []string{"", "Root", "a b", "a;b", "$x", "a\nb", "-x", "1a"} {
		if ValidateUser(u) == nil {
			t.Errorf("user %q deveria falhar", u)
		}
	}
	if ValidatePort(0) == nil || ValidatePort(70000) == nil || ValidatePort(22) != nil {
		t.Error("porta")
	}
}

func TestDomainInZone(t *testing.T) {
	if !DomainInZone("a.exemplo.com", "exemplo.com") || !DomainInZone("exemplo.com", "exemplo.com") {
		t.Error("deveria estar")
	}
	if DomainInZone("aexemplo.com", "exemplo.com") || DomainInZone("a.outro.com", "exemplo.com") {
		t.Error("não deveria estar")
	}
}

func TestShQuote(t *testing.T) {
	if got := shQuote("a'b"); got != `'a'\''b'` {
		t.Fatal(got)
	}
}
