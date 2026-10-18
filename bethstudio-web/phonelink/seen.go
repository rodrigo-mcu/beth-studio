package phonelink

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Última vez que o PC foi visto ligado ao proxy, e o teto de tentativas de
// login por IP. O proxy não conhece aparelhos nem cookies do Studio: a página
// offline pública mostra só a hora.

const (
	seenFile        = "last-seen"
	seenTick        = 30 * time.Second
	loginCapPerMin  = 20
	loginCapWindow  = time.Minute
	loginCapMaxKeys = 10000
)

func (p *Proxy) clock() time.Time {
	if p.Now != nil {
		return p.Now()
	}
	return time.Now()
}

func (p *Proxy) seenPath() string {
	if p.DataDir == "" {
		return ""
	}
	return filepath.Join(p.DataDir, seenFile)
}

// LastSeen devolve quando o PC foi visto pela última vez (zero = nunca).
func (p *Proxy) LastSeen() time.Time {
	p.seenMu.Lock()
	defer p.seenMu.Unlock()
	if !p.seenLoaded {
		p.seenLoaded = true
		if path := p.seenPath(); path != "" {
			if b, err := os.ReadFile(path); err == nil {
				if t, err := time.Parse(time.RFC3339, strings.TrimSpace(string(b))); err == nil {
					p.seen = t
				}
			}
		}
	}
	return p.seen
}

// markSeen grava agora como "visto" (memória e arquivo pequeno).
func (p *Proxy) markSeen() {
	p.LastSeen() // carrega antes de sobrescrever
	now := p.clock().UTC().Truncate(time.Second)
	p.seenMu.Lock()
	p.seen = now
	path := p.seenPath()
	p.seenMu.Unlock()
	if path == "" {
		return
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(now.Format(time.RFC3339)+"\n"), 0o644); err != nil {
		return
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
	}
}

// watchSeen mantém a hora fresca enquanto a sessão está ligada e grava a da queda.
func (p *Proxy) watchSeen(closed <-chan struct{}) {
	p.markSeen()
	t := time.NewTicker(seenTick)
	defer t.Stop()
	for {
		select {
		case <-closed:
			p.markSeen()
			return
		case <-t.C:
			p.markSeen()
		}
	}
}

const offlineHead = `<!DOCTYPE html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="20"><title>Beth Studio</title><body style="font-family:sans-serif;background:#111;color:#eee;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0"><div style="text-align:center;padding:0 16px"><p>O computador está desconectado.</p>`

const offlineScript = `<script>(function(){var e=document.getElementById("t");if(!e)return;var d=new Date(e.getAttribute("datetime"));if(isNaN(d))return;function z(n){return(n<10?"0":"")+n}e.textContent=z(d.getHours())+":"+z(d.getMinutes())+" de "+z(d.getDate())+"/"+z(d.getMonth()+1)})()</script>`

// OfflineHTML é a página pública quando o PC não está ligado. Só a hora.
func OfflineHTML(seen time.Time) string {
	var b strings.Builder
	b.WriteString(offlineHead)
	if !seen.IsZero() {
		u := seen.UTC()
		fmt.Fprintf(&b, `<p style="color:#999">Visto pela última vez às <time id="t" datetime="%s">%s UTC de %s</time></p>`,
			u.Format(time.RFC3339), u.Format("15:04"), u.Format("02/01"))
	}
	b.WriteString(`<p style="color:#999;font-size:14px">Tentando de novo sozinho.</p></div>`)
	b.WriteString(offlineScript)
	return b.String()
}

// serveOffline: HTML para quem abre a página, JSON para o app do celular (/api/*).
func (p *Proxy) serveOffline(w http.ResponseWriter, r *http.Request) {
	seen := p.LastSeen()
	w.Header().Set("Cache-Control", "no-store")
	if strings.HasPrefix(r.URL.Path, "/api/") {
		out := map[string]any{"offline": true}
		if !seen.IsZero() {
			out["last_seen"] = seen.UTC().Format(time.RFC3339)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		_ = json.NewEncoder(w).Encode(out)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusServiceUnavailable)
	_, _ = w.Write([]byte(OfflineHTML(seen)))
}

func loginCapPath(r *http.Request) bool {
	return r.Method == http.MethodPost && (r.URL.Path == "/api/phone/login" || r.URL.Path == "/api/phone/pair")
}

// allowLogin: no máximo loginCapPerMin tentativas por minuto e por IP. A
// conta definitiva (travas crescentes) é do Studio; isto só poupa o PC.
func (p *Proxy) allowLogin(ip string) bool {
	now := p.clock()
	cut := now.Add(-loginCapWindow)
	p.capMu.Lock()
	defer p.capMu.Unlock()
	if p.caps == nil || len(p.caps) > loginCapMaxKeys {
		p.caps = map[string][]time.Time{}
	}
	var hits []time.Time
	for _, t := range p.caps[ip] {
		if t.After(cut) {
			hits = append(hits, t)
		}
	}
	if len(hits) >= loginCapPerMin {
		p.caps[ip] = hits
		return false
	}
	p.caps[ip] = append(hits, now)
	return true
}
