package main

import (
	"context"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"bethstudio-web/phonelink"
)

var phoneKick = make(chan struct{}, 1)

type phoneSession struct {
	mu sync.Mutex
	s  io.Closer
}

func (p *phoneSession) store(s io.Closer) {
	p.mu.Lock()
	p.s = s
	p.mu.Unlock()
}

func (p *phoneSession) close() {
	p.mu.Lock()
	s := p.s
	p.s = nil
	p.mu.Unlock()
	if s != nil {
		_ = s.Close()
	}
}

var phoneSess phoneSession

type phoneLinkState struct {
	mu     sync.Mutex
	link   string
	detail string
}

var phoneLink phoneLinkState

func (s *phoneLinkState) set(link, detail string) {
	s.mu.Lock()
	s.link, s.detail = link, detail
	s.mu.Unlock()
}

func (s *phoneLinkState) get() (string, string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	link := s.link
	if link == "" {
		link = "off"
	}
	return link, s.detail
}

func phoneLinkView() (string, string) {
	link, detail := phoneLink.get()
	if link == "off" {
		if _, ok := phone.configured(); ok {
			return "connecting", ""
		}
	}
	return link, detail
}

func phoneLinkDetail(err error) string {
	if err == nil {
		return ""
	}
	s := err.Error()
	switch {
	case strings.Contains(s, "connection refused"):
		return "o proxy recusou a conexão"
	case strings.Contains(s, "no such host"):
		return "domínio não encontrado"
	case strings.Contains(s, "i/o timeout"), strings.Contains(s, "deadline exceeded"):
		return "o proxy não respondeu"
	case strings.Contains(s, "segredo inválido"):
		return "o servidor recusou a linha colada"
	}
	if len(s) > 140 {
		s = s[:140]
	}
	return s
}

func kickPhoneLink() {
	phoneSess.close()
	select {
	case phoneKick <- struct{}{}:
	default:
	}
}

// runPhoneLink liga neste PC para o domínio do bethstudio-proxy e reconecta se cair.
func (s *server) runPhoneLink(ctx context.Context) {
	phone.load()
	backoff := time.Second
	for {
		if ctx.Err() != nil {
			return
		}
		domain, secret := phone.creds()
		if domain == "" || secret == "" {
			phoneLink.set("off", "")
			select {
			case <-ctx.Done():
				return
			case <-phoneKick:
				phone.load()
			case <-time.After(3 * time.Second):
				phone.load()
			}
			continue
		}
		phoneLink.set("connecting", "")
		dialCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
		sess, err := phonelink.Dial(dialCtx, "wss://"+domain+phonelink.LinkPath, secret)
		cancel()
		if err != nil {
			log.Printf("celular: %v", err)
			phoneLink.set("down", phoneLinkDetail(err))
			select {
			case <-ctx.Done():
				return
			case <-phoneKick:
			case <-time.After(backoff):
			}
			if backoff < 15*time.Second {
				backoff *= 2
			}
			phone.load()
			continue
		}
		backoff = time.Second
		log.Printf("celular: ligado em %s", domain)
		phoneSess.store(sess)
		phoneLink.set("up", "")
		err = phonelink.Serve(sess, http.HandlerFunc(s.servePhonePublic))
		_ = sess.Close()
		if ctx.Err() != nil {
			return
		}
		log.Printf("celular: ligação caiu: %v", err)
		phoneLink.set("connecting", "")
	}
}
