package main

// ssh_localfwd.go — quando um programa no servidor SSH imprime um link
// http(s)://localhost:PORTA/... (login de Codex, Claude, etc.), o navegador
// deste PC não alcança essa porta: ela existe só na máquina remota.
//
// A sessão abre a mesma porta em 127.0.0.1 aqui e encaminha cada conexão
// pelo SSH já aberto (direct-tcpip para 127.0.0.1:PORTA no servidor).
// Só portas explícitas >= 1024, e só o que apareceu num URL http(s).

import (
	"context"
	"io"
	"net"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

type localFwdHit struct {
	URL  string
	Port int
}

var (
	httpURLRe    = regexp.MustCompile(`https?://[^\s<>"']+`)
	plainLocalRe = regexp.MustCompile(`(?i)https?://(?:localhost|127\.0\.0\.1|\[::1\]):(\d{2,5})`)
	encLocalRe   = regexp.MustCompile(`(?i)https?%3A%2F%2F(?:localhost|127\.0\.0\.1)%3A(\d{2,5})`)
)

func localPortsIn(s string) []int {
	var out []int
	seen := map[int]bool{}
	add := func(raw string) {
		p, err := strconv.Atoi(raw)
		if err != nil || p < 1024 || p > 65535 || seen[p] {
			return
		}
		seen[p] = true
		out = append(out, p)
	}
	for _, m := range plainLocalRe.FindAllStringSubmatch(s, -1) {
		add(m[1])
	}
	for _, m := range encLocalRe.FindAllStringSubmatch(s, -1) {
		add(m[1])
	}
	return out
}

// localFwdWatch junta pedaços da saída do SSH e devolve cada URL nova que
// aponta (ou redireciona) para localhost:PORTA. A URL devolvida é a que o
// navegador deve abrir: o link https://… da tela, não só o callback.
type localFwdWatch struct {
	buf  string
	seen map[string]bool
}

func (w *localFwdWatch) feed(chunk string) []localFwdHit {
	if w.seen == nil {
		w.seen = map[string]bool{}
	}
	plain := ansiRe.ReplaceAllString(chunk, "")
	plain = strings.ReplaceAll(plain, "\r", "")
	w.buf += plain
	if len(w.buf) > 16384 {
		w.buf = w.buf[len(w.buf)-16384:]
	}
	var out []localFwdHit
	for _, url := range httpURLRe.FindAllString(w.buf, -1) {
		if w.seen[url] {
			continue
		}
		ports := localPortsIn(url)
		if len(ports) == 0 {
			continue
		}
		w.seen[url] = true
		for _, p := range ports {
			out = append(out, localFwdHit{URL: url, Port: p})
		}
	}
	return out
}

// sshLocalForward escuta 127.0.0.1:port neste PC e liga cada conexão ao
// 127.0.0.1:port (ou [::1]) do servidor, pelo cliente SSH já autenticado.
func sshLocalForward(ctx context.Context, cl *ssh.Client, port int) error {
	ln, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(port))
	if err != nil {
		return err
	}
	go func() {
		<-ctx.Done()
		_ = ln.Close()
	}()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go sshBridgeOne(cl, c, port)
		}
	}()
	return nil
}

func sshBridgeOne(cl *ssh.Client, local net.Conn, port int) {
	defer local.Close()
	_ = local.SetDeadline(time.Now().Add(30 * time.Second))
	target := "127.0.0.1:" + strconv.Itoa(port)
	remote, err := cl.Dial("tcp", target)
	if err != nil {
		remote, err = cl.Dial("tcp", "[::1]:"+strconv.Itoa(port))
		if err != nil {
			return
		}
	}
	defer remote.Close()
	_ = local.SetDeadline(time.Time{})
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { _, _ = io.Copy(remote, local); wg.Done() }()
	go func() { _, _ = io.Copy(local, remote); wg.Done() }()
	wg.Wait()
}
