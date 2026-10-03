package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func termTestServer(t *testing.T) (*server, *int) {
	t.Helper()
	opened := 0
	prev := openTermWindow
	openTermWindow = func(s *server, pane int) error {
		opened++
		s.hub.term.Add(pane, &fakeTerm{})
		return nil
	}
	t.Cleanup(func() { openTermWindow = prev })
	return &server{hub: newHub(false)}, &opened
}

func termCall(s *server, method, path, body, remote string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	rec := httptest.NewRecorder()
	s.serveTerm(rec, req, remote)
	return rec
}

func TestTermDetachRejectsBadPane(t *testing.T) {
	s, opened := termTestServer(t)
	for _, body := range []string{`{}`, `{"pane_id":-1}`, `nope`} {
		if rec := termCall(s, http.MethodPost, "/api/term/detach", body, ""); rec.Code != http.StatusBadRequest {
			t.Fatalf("%q: código %d, quero 400", body, rec.Code)
		}
	}
	if *opened != 0 {
		t.Fatal("nenhuma janela deveria abrir")
	}
}

func TestTermRemoteForbidden(t *testing.T) {
	s, opened := termTestServer(t)
	if rec := termCall(s, http.MethodPost, "/api/term/detach", `{"pane_id":3}`, "chave"); rec.Code != http.StatusForbidden {
		t.Fatalf("remoto: código %d, quero 403", rec.Code)
	}
	if *opened != 0 {
		t.Fatal("remoto não pode abrir janela")
	}
}

func TestTermDetachMethodAndDuplicate(t *testing.T) {
	s, opened := termTestServer(t)
	if rec := termCall(s, http.MethodGet, "/api/term/detach", "", ""); rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET: código %d, quero 405", rec.Code)
	}
	for i := 0; i < 2; i++ {
		if rec := termCall(s, http.MethodPost, "/api/term/detach", `{"pane_id":3}`, ""); rec.Code != http.StatusOK {
			t.Fatalf("detach: código %d", rec.Code)
		}
	}
	if *opened != 1 {
		t.Fatalf("janela aberta %d vezes, quero 1 (a repetição só foca)", *opened)
	}
	if rec := termCall(s, http.MethodGet, "/api/term/list", "", ""); !strings.Contains(rec.Body.String(), "[3]") {
		t.Fatalf("list = %s", rec.Body.String())
	}
}

func TestTermDragConvertsToStudioClient(t *testing.T) {
	s, _ := termTestServer(t)
	prev := screenToStudioClient
	screenToStudioClient = func(x, y int) (int, int, bool) { return x - 100, y - 50, true }
	t.Cleanup(func() { screenToStudioClient = prev })
	c := s.hub.add()
	rec := termCall(s, http.MethodPost, "/api/term/drag", `{"pane_id":4,"x":300,"y":200,"end":true}`, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("código %d", rec.Code)
	}
	for {
		select {
		case b := <-c.out:
			if !strings.Contains(string(b), "term_drag") {
				continue // eventos iniciais (status etc.)
			}
			if !strings.Contains(string(b), `"x":200`) || !strings.Contains(string(b), `"y":150`) || !strings.Contains(string(b), `"end":true`) {
				t.Fatalf("evento = %s", b)
			}
			return
		default:
			t.Fatal("o evento term_drag não chegou ao cliente")
		}
	}

}
