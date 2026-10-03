package main

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGrokDeviceLogin(t *testing.T) {
	withVoiceStores(t)
	var hits []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits = append(hits, r.URL.Path)
		b, _ := io.ReadAll(r.Body)
		switch r.URL.Path {
		case "/oauth2/device/code":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"device_code":"dev-1","user_code":"ABCD-EFGH","verification_uri":"https://accounts.x.ai/oauth2/device","expires_in":60,"interval":1}`))
		case "/oauth2/token":
			w.Header().Set("Content-Type", "application/json")
			if strings.Contains(string(b), "device_code") && len(hits) < 3 {
				w.WriteHeader(http.StatusBadRequest)
				_, _ = w.Write([]byte(`{"error":"authorization_pending"}`))
				return
			}
			_, _ = w.Write([]byte(`{"access_token":"atk","refresh_token":"rtk","expires_in":3600}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	old := grokAuthHost
	grokAuthHost = srv.URL
	t.Cleanup(func() { grokAuthHost = old })

	st, err := accountStart(context.Background(), "grok-build")
	if err != nil || st.UserCode != "ABCD-EFGH" || !strings.Contains(st.VerificationURI, "accounts.x.ai") {
		t.Fatalf("start: %+v %v", st, err)
	}
	if err := accountPoll(context.Background(), "grok-build"); !errors.Is(err, errAcctPending) {
		t.Fatalf("pending: %v", err)
	}
	if err := accountPoll(context.Background(), "grok-build"); err != nil {
		t.Fatal(err)
	}
	tok, ok := loadAcct("grok-build")
	if !ok || tok.AccessToken != "atk" || tok.RefreshToken != "rtk" {
		t.Fatalf("token: %+v %v", tok, ok)
	}
	key, _ := secrets.get("grok-build", nil)
	if key != "atk" {
		t.Fatalf("chave do provedor: %q", key)
	}
}

func TestCodexDevicePending(t *testing.T) {
	withVoiceStores(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/accounts/deviceauth/usercode":
			_, _ = w.Write([]byte(`{"device_auth_id":"id-1","user_code":"WXYZ-1234","interval":"2"}`))
		case "/api/accounts/deviceauth/token":
			w.WriteHeader(http.StatusNotFound)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	old := codexAuthHost
	codexAuthHost = srv.URL
	t.Cleanup(func() { codexAuthHost = old })

	st, err := accountStart(context.Background(), "codex")
	if err != nil || st.UserCode != "WXYZ-1234" || !strings.HasSuffix(st.VerificationURI, "/codex/device") {
		t.Fatalf("start: %+v %v", st, err)
	}
	if err := accountPoll(context.Background(), "codex"); !errors.Is(err, errAcctPending) {
		t.Fatalf("pending: %v", err)
	}
}

func TestReadCodexSSE(t *testing.T) {
	body := strings.NewReader("data: {\"type\":\"response.output_text.delta\",\"delta\":\"ola\"}\n\n" +
		"data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":2,\"output_tokens\":1}}}\n")
	var got []string
	text, u, err := readCodexSSE(body, func(s string) { got = append(got, s) })
	if err != nil || text != "ola" || u.In != 2 || u.Out != 1 || len(got) != 1 {
		t.Fatalf("text=%q usage=%+v deltas=%v err=%v", text, u, got, err)
	}
}
