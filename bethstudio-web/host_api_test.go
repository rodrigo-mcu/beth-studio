package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func hostCall(s *server, method, path, remote string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(""))
	rec := httptest.NewRecorder()
	s.serveHost(rec, req, remote)
	return rec
}

func TestHostAPIRemoteForbidden(t *testing.T) {
	s := &server{hub: newHub(false)}
	if rec := hostCall(s, http.MethodPost, "/api/host/retry", "chave"); rec.Code != http.StatusForbidden {
		t.Fatalf("remoto: código %d, quero 403", rec.Code)
	}
}

func TestHostAPIMethods(t *testing.T) {
	s := &server{hub: newHub(false)}
	if rec := hostCall(s, http.MethodPost, "/api/host/state", ""); rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST em state: código %d, quero 405", rec.Code)
	}
	if rec := hostCall(s, http.MethodGet, "/api/host/retry", ""); rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET em retry: código %d, quero 405", rec.Code)
	}
}

func TestHostAPIWithoutSupervisor(t *testing.T) {
	s := &server{hub: newHub(false)}
	rec := hostCall(s, http.MethodGet, "/api/host/state", "")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "unmanaged") {
		t.Fatalf("state sem supervisor: %d %s", rec.Code, rec.Body.String())
	}
	if rec := hostCall(s, http.MethodPost, "/api/host/retry", ""); rec.Code != http.StatusConflict {
		t.Fatalf("retry sem supervisor: código %d, quero 409", rec.Code)
	}
}

func TestHostAPIStateAndRetry(t *testing.T) {
	t.Setenv("BETHSTUDIO_DATA_DIR", t.TempDir())
	ctl := &fakeHostCtl{running: true}
	h := newHub(false)
	h.sup = newSupervisor(ctl, newRestartLimiter(3, 10*time.Minute), time.Now, h.setHost)
	h.sup.Tick()
	s := &server{hub: h}
	rec := hostCall(s, http.MethodGet, "/api/host/state", "")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"running"`) {
		t.Fatalf("state: %d %s", rec.Code, rec.Body.String())
	}
	ctl.running = false
	if rec := hostCall(s, http.MethodPost, "/api/host/retry", ""); rec.Code != http.StatusOK {
		t.Fatalf("retry: código %d", rec.Code)
	}
}

func TestHubSendsHostStateToLateClients(t *testing.T) {
	h := newHub(false)
	h.setHost(hostUnavailable, "O host caiu 3 vezes")
	c := h.add()
	for {
		select {
		case b := <-c.out:
			if strings.Contains(string(b), `"ev":"host"`) && strings.Contains(string(b), "unavailable") {
				return
			}
		default:
			t.Fatal("o cliente novo não recebeu o estado do host")
		}
	}
}
