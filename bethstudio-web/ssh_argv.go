package main

// ssh_argv.go — como um terminal SSH salvo aparece no host e como a
// interface reconhece esses panes.
//
// O pane roda `<pasta do bethstudio.exe>\bethstudio-tool.exe --ssh <id>`
// (tool_spawn.go). Aqui: reconhecer esse argv / shell_id e dar o rotulo
// user@host:port (estilo Bitvise) e o id do host salvo.

import (
	"fmt"
	"os"
	"strings"
	"sync"
	"time"
)

const (
	sshHelperFlag    = "--ssh"
	sshShellIDPrefix = "ssh."
)

// sshShellIDFor: shell_id guardado para panes criados pelo web ("ssh.<id>");
// casa com shellIDRe do server.go.
func sshShellIDFor(hostID string) string { return sshShellIDPrefix + hostID }

// sshHostForArgv mapeia `bethstudio-tool.exe --ssh <id>` (ou o mesmo com
// bethstudio-web.exe) para o rotulo de exibicao. ok=false para qualquer outro
// comando. Host apagado: ok=true com um rotulo generico.
func sshHostForArgv(argv []string) (label string, ok bool) {
	id, ok := toolArgvID(argv, sshHelperFlag, sshHostIDRe)
	if !ok {
		return "", false
	}
	return sshLabelFor(id), true
}

// sshHostIDForArgv: o id hex do host salvo, se o argv for bethstudio-tool --ssh.
func sshHostIDForArgv(argv []string) (id string, ok bool) {
	return toolArgvID(argv, sshHelperFlag, sshHostIDRe)
}

// sshHostForShellID: o mesmo para o shell_id "ssh.<id>" gravado no spawn.
func sshHostForShellID(shellID string) (label string, ok bool) {
	id := strings.TrimPrefix(shellID, sshShellIDPrefix)
	if id == shellID || !sshHostIDRe.MatchString(id) {
		return "", false
	}
	return sshLabelFor(id), true
}

// sshHostIDFromShellID: id hex a partir de "ssh.<id>".
func sshHostIDFromShellID(shellID string) (id string, ok bool) {
	id = strings.TrimPrefix(shellID, sshShellIDPrefix)
	if id == shellID || !sshHostIDRe.MatchString(id) {
		return "", false
	}
	return id, true
}

// cache pelo mtime do arquivo: a lista de panes e' reclassificada a cada
// poucos segundos.
var sshLabels struct {
	mu    sync.Mutex
	path  string
	mtime time.Time
	size  int64
	byID  map[string]SSHSavedHost
}

func sshLabelCacheReload() {
	var mt time.Time
	var sz int64
	path := sshHostsPath()
	if st, err := os.Stat(path); err == nil {
		mt, sz = st.ModTime(), st.Size()
	}
	if sshLabels.byID != nil && path == sshLabels.path && mt.Equal(sshLabels.mtime) && sz == sshLabels.size {
		return
	}
	sshLabels.path, sshLabels.mtime, sshLabels.size = path, mt, sz
	sshLabels.byID = map[string]SSHSavedHost{}
	sshStoreMu.Lock()
	doc, err := sshLoadDocLocked()
	sshStoreMu.Unlock()
	if err == nil {
		for _, h := range doc.Hosts {
			sshLabels.byID[h.ID] = h
		}
	}
}

func sshLabelFor(id string) string {
	sshLabels.mu.Lock()
	defer sshLabels.mu.Unlock()
	sshLabelCacheReload()
	if h, ok := sshLabels.byID[id]; ok {
		return sshEndpointLabel(h)
	}
	return "host removido"
}

// sshEndpointLabel: titulo estilo Bitvise (user@host:port).
func sshEndpointLabel(h SSHSavedHost) string {
	user := strings.TrimSpace(h.User)
	host := strings.TrimSpace(h.Host)
	port := h.Port
	if port <= 0 {
		port = 22
	}
	if user != "" && host != "" {
		return fmt.Sprintf("%s@%s:%d", user, host, port)
	}
	if host != "" {
		return fmt.Sprintf("%s:%d", host, port)
	}
	if n := strings.TrimSpace(h.Name); n != "" {
		return n
	}
	return "SSH"
}
