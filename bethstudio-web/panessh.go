package main

// panessh.go — tipo "SSH" (agrupado por host remoto) para a barra lateral.
//
// Fontes, em ordem:
//  1. pane-commands.json da GUI: argv de ssh.exe/ssh (host = ultimo
//     argumento que nao e' opcao; user@host vira host; -p/-l etc. pulados);
//  2. shell_id do web "ssh.<host>";
//  3. heuristica sobre o que o shell informa agora: cwd OSC 7
//     file://<hostname>/... e titulo "user@host:" com host diferente da
//     maquina local (o nome do Windows, que e' o mesmo que o WSL mostra no
//     cwd, ex. my-desktop — nunca confundir com remoto).

import (
	"os"
	"strings"
	"sync"
)

// ssh.exe: opcoes que levam valor (o valor nao e' o host).
var sshOptsWithValue = map[string]bool{
	"-b": true, "-c": true, "-D": true, "-E": true, "-e": true, "-F": true, "-I": true, "-i": true, "-J": true,
	"-L": true, "-l": true, "-m": true, "-O": true, "-o": true, "-p": true, "-Q": true, "-R": true, "-S": true, "-W": true, "-w": true,
}

// sshHostFromArgv: host de `ssh [opcoes] [user@]host [comando...]`. "" = nao achou.
func sshHostFromArgv(argv []string) string {
	for i := 1; i < len(argv); i++ {
		a := argv[i]
		if a == "--" {
			if i+1 < len(argv) {
				return sshHostPart(argv[i+1])
			}
			return ""
		}
		if strings.HasPrefix(a, "-") && len(a) >= 2 {
			opt := a[:2]
			if sshOptsWithValue[opt] {
				if a[2:] == "" && i+1 < len(argv) {
					i++ // o valor vem no proximo argumento
				}
			}
			continue
		}
		return sshHostPart(a) // primeiro nao-opcao = destino
	}
	return ""
}

func sshHostPart(dest string) string {
	dest = strings.TrimPrefix(dest, "ssh://")
	if i := strings.LastIndexByte(dest, '@'); i >= 0 {
		dest = dest[i+1:]
	}
	if i := strings.LastIndexByte(dest, ':'); i > 0 && !strings.Contains(dest[:i], ":") { // host:porta (ssh://)
		dest = dest[:i]
	}
	dest = strings.Trim(dest, "[]/ ")
	return strings.ToLower(dest)
}

var localNames struct {
	once  sync.Once
	names map[string]bool
}

// isLocalHost: o nome da maquina (Windows == o que o WSL mostra), localhost.
func isLocalHost(h string) bool {
	localNames.once.Do(func() {
		localNames.names = map[string]bool{"": true, "localhost": true, "127.0.0.1": true, "::1": true}
		if n, err := os.Hostname(); err == nil && n != "" {
			n = strings.ToLower(n)
			localNames.names[n] = true
			if i := strings.IndexByte(n, '.'); i > 0 {
				localNames.names[n[:i]] = true
			}
		}
		for _, e := range []string{"COMPUTERNAME", "BETHSTUDIO_LOCAL_HOSTNAMES"} {
			for _, n := range strings.Split(os.Getenv(e), ",") {
				if n = strings.ToLower(strings.TrimSpace(n)); n != "" {
					localNames.names[n] = true
				}
			}
		}
	})
	h = strings.ToLower(strings.TrimSpace(h))
	if i := strings.IndexByte(h, '.'); i > 0 && localNames.names[h[:i]] {
		return true
	}
	return localNames.names[h]
}

// cwdHost: hostname do cwd OSC 7 (file://host/caminho). "" = sem host.
func cwdHost(cwd string) string {
	if !strings.HasPrefix(cwd, "file://") {
		return ""
	}
	rest := cwd[len("file://"):]
	i := strings.IndexByte(rest, '/')
	if i < 0 {
		return strings.ToLower(rest)
	}
	return strings.ToLower(rest[:i])
}

// titleHost: host do titulo "user@host: caminho" (ou "user@host ~"). "" = nao tem.
func titleHost(title string) string {
	t := strings.TrimSpace(title)
	at := strings.IndexByte(t, '@')
	if at <= 0 {
		return ""
	}
	user := t[:at]
	if strings.ContainsAny(user, " \t/\\:") {
		return ""
	}
	rest := t[at+1:]
	end := strings.IndexAny(rest, ": \t")
	if end < 0 {
		return ""
	}
	h := rest[:end]
	if h == "" || strings.ContainsAny(h, "/\\") {
		return ""
	}
	return strings.ToLower(h)
}

// remoteHost: host remoto que o shell esta' informando agora ("" = local).
func remoteHost(title, cwd string) string {
	if h := cwdHost(cwd); h != "" && !isLocalHost(h) {
		return h
	}
	if h := titleHost(title); h != "" && !isLocalHost(h) {
		return h
	}
	return ""
}

func sshKind(host string) PaneKind {
	k := PaneKind{Kind: "ssh", Label: "SSH", Host: host}
	if host != "" {
		k.Label = "SSH · " + host
	}
	return k
}

// sshKindSaved: host do ssh-hosts.json (titulo = user@host:port).
func sshKindSaved(id string) PaneKind {
	k := sshKind(sshLabelFor(id))
	k.HostID = id
	return k
}
