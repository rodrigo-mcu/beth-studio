package main

// sftp_window.go — abre uma janela OS separada para SFTP (estilo Bitvise).
//
//	CLI: bethstudio-web.exe --sftp <hostId>
//	API: POST /api/ssh/sftp/window {id}  -> {ok:true} (novo processo deste exe)
//
// Cada clique = um processo novo (varias janelas ao mesmo tempo). Nao passa
// pelo bethstudio-host; so' usa ssh-hosts.json + secrets.dat + pkg/sftp.

import (
	"context"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"time"
)

func (s *server) serveSFTPWindow(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "use POST", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		ID string `json:"id"`
	}
	if !sshDecodePOST(w, r, &req) {
		return
	}
	id := strings.TrimSpace(req.ID)
	if !sshHostIDRe.MatchString(id) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "id de host inválido"})
		return
	}
	if _, ok, err := sshGetHost(id); err != nil || !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "host não encontrado"})
		return
	}
	if err := launchSFTPWindow(id); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func runSFTPModeWindows(hostID string, noWindow, devtools bool, port int, winSize, devOrig string) {
	hostID = strings.TrimSpace(hostID)
	if !sshHostIDRe.MatchString(hostID) {
		fatal("--sftp: id de host inválido")
	}
	attachParentConsole()
	logClose := setupLog()
	defer logClose()

	settings.load(dataDir())
	secrets.load(dataDir())

	h, ok, err := sshGetHost(hostID)
	if err != nil || !ok {
		fatal("host SFTP não encontrado: %v", err)
	}

	token := randomToken()
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		fatal("não foi possível abrir a porta local: %v", err)
	}
	addr := ln.Addr().(*net.TCPAddr)
	base := fmt.Sprintf("http://127.0.0.1:%d", addr.Port)
	url := fmt.Sprintf("%s/?t=%s&mode=sftp&host=%s", base, token, hostID)

	hub := newHub(false)
	srv := &http.Server{
		Handler:           newServer(token, addr.Port, strings.TrimSpace(devOrig), hub),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
			log.Printf("http: %v", err)
		}
	}()

	title := sshEndpointLabel(h)
	windowTitle = "SFTP · " + title
	log.Printf("bethstudio-web sftp: host=%s label=%s em %s", hostID, title, base)
	fmt.Fprintln(os.Stdout, url)

	if noWindow {
		select {}
	}
	w, ht := 1100, 720
	if _, err := fmt.Sscanf(winSize, "%dx%d", &w, &ht); err != nil || w < 600 || ht < 400 {
		w, ht = 1100, 720
	}
	if err := openWindow(url, devtools, w, ht); err != nil {
		messageBox("Beth Studio SFTP · "+title, "Não foi possível abrir a janela (WebView2):\n\n"+err.Error())
	}
	log.Printf("bethstudio-web sftp: encerrando")
	shutCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutCtx)
}
