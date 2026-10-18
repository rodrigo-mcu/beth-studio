package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/bcrypt"
)

// Vitrine manual do Studio remoto num navegador (não roda no `go test` comum):
//
//	BETH_REMOTE_PREVIEW=1 BETHSTUDIO_DATA_DIR=<pasta temporária> BETHSTUDIO_EXE=<bethstudio.exe> \
//	  go test -run TestRemotePreview -timeout 0 .
//
// Sobe https://127.0.0.1:<porta>/studio/ (certificado de teste) com a mesma
// porta de entrada do túnel. Senha "senha-de-teste"; o código TOTP vai no log.
// Não liga no servidor do celular. A ponte só lê o host (o remoto não muda
// tamanho); nada aqui para ou reinicia o host.
func TestRemotePreview(t *testing.T) {
	if os.Getenv("BETH_REMOTE_PREVIEW") != "1" {
		t.Skip("só manual")
	}
	settings.load(dataDir())
	hash, _ := bcrypt.GenerateFromPassword([]byte("senha-de-teste"), bcrypt.MinCost)
	hub := newHub(false)
	srv := newServer(randomToken(), 0, "", hub).(*server)
	if exe := os.Getenv("BETHSTUDIO_EXE"); exe != "" {
		br := newBridge(exe, hub)
		hub.bridge = br
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		go br.run(ctx)
		defer br.stop()
	}
	ts := httptest.NewUnstartedServer(http.HandlerFunc(srv.servePhonePublic))
	ts.StartTLS()
	defer ts.Close()
	domain := strings.TrimPrefix(ts.URL, "https://")
	phone = &phoneAuth{domain: domain, secret: "x", hash: hash, now: time.Now}
	remote = &remoteAuth{enabled: true, totp: testTOTP, sessions: map[string]*remoteSession{}, limit: newLoginLimiter(), now: time.Now, onDrop: hub.dropRemote}
	key, _ := totpKey(testTOTP)
	t.Logf("abra %s/studio/  senha: senha-de-teste", ts.URL)
	for {
		t.Logf("código agora: %s", totpAt(key, totpCounter(time.Now())))
		time.Sleep(10 * time.Second)
	}
}
