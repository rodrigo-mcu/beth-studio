package vpsinstall

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// WizardComment marca os registros DNS criados pelo assistente. Só eles são
// alterados ou apagados por ele.
const WizardComment = "bethstudio-wizard"

const cfBase = "https://api.cloudflare.com/client/v4"

type Zone struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Status string `json:"status"`
}

type Record struct {
	ID      string `json:"id,omitempty"`
	Type    string `json:"type"`
	Name    string `json:"name"`
	Content string `json:"content"`
	Proxied bool   `json:"proxied"`
	TTL     int    `json:"ttl"`
	Comment string `json:"comment,omitempty"`
}

// CFAPI é o que o assistente usa da API v4 da Cloudflare.
type CFAPI interface {
	VerifyToken(ctx context.Context) error
	ListZones(ctx context.Context) ([]Zone, error)
	GetZone(ctx context.Context, id string) (Zone, error)
	ListRecords(ctx context.Context, zoneID, name string) ([]Record, error)
	CreateRecord(ctx context.Context, zoneID string, r Record) (Record, error)
	UpdateRecord(ctx context.Context, zoneID, id string, r Record) (Record, error)
	DeleteRecord(ctx context.Context, zoneID, id string) error
}

// CFError é um erro da Cloudflare já em linguagem de gente. Nunca contém o token.
type CFError struct {
	Status  int
	Code    int
	Message string
	Hint    string
}

func (e *CFError) Error() string {
	if e.Hint != "" {
		return e.Hint
	}
	return fmt.Sprintf("Cloudflare: %s", e.Message)
}

type cfClient struct {
	token string
	base  string
	hc    *http.Client
}

// NewCloudflare cria o cliente. base vazio usa a API real.
func NewCloudflare(token, base string, hc *http.Client) CFAPI {
	if base == "" {
		base = cfBase
	}
	if hc == nil {
		hc = &http.Client{Timeout: 30 * time.Second}
	}
	return &cfClient{token: strings.TrimSpace(token), base: strings.TrimSuffix(base, "/"), hc: hc}
}

type cfEnvelope struct {
	Success bool            `json:"success"`
	Errors  []cfErrItem     `json:"errors"`
	Result  json.RawMessage `json:"result"`
	Info    struct {
		Page       int `json:"page"`
		TotalPages int `json:"total_pages"`
	} `json:"result_info"`
}

type cfErrItem struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (c *cfClient) do(ctx context.Context, method, path string, q url.Values, body any, hint string) (cfEnvelope, error) {
	var env cfEnvelope
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return env, err
		}
		rd = bytes.NewReader(b)
	}
	u := c.base + path
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, method, u, rd)
	if err != nil {
		return env, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.hc.Do(req)
	if err != nil {
		return env, errors.New("não consegui falar com a Cloudflare (rede ou DNS do PC)")
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	_ = json.Unmarshal(raw, &env)
	if resp.StatusCode >= 200 && resp.StatusCode < 300 && env.Success {
		return env, nil
	}
	e := &CFError{Status: resp.StatusCode}
	if len(env.Errors) > 0 {
		e.Code, e.Message = env.Errors[0].Code, env.Errors[0].Message
	} else {
		e.Message = fmt.Sprintf("HTTP %d", resp.StatusCode)
	}
	switch {
	case resp.StatusCode == http.StatusUnauthorized:
		e.Hint = "A Cloudflare não aceitou o token. Confira se ele foi copiado inteiro e se não expirou."
	case resp.StatusCode == http.StatusForbidden:
		e.Hint = "O token não tem permissão para isso. " + hint
	case resp.StatusCode == http.StatusNotFound:
		e.Hint = "A Cloudflare não encontrou isso (a zona existe nesta conta e o token enxerga ela?)."
	case resp.StatusCode == http.StatusTooManyRequests:
		e.Hint = "A Cloudflare pediu para ir mais devagar. Tente de novo em um minuto."
	}
	return env, e
}

func (c *cfClient) VerifyToken(ctx context.Context) error {
	env, err := c.do(ctx, http.MethodGet, "/user/tokens/verify", nil, nil, "")
	if err != nil {
		return err
	}
	var r struct {
		Status string `json:"status"`
	}
	if err := json.Unmarshal(env.Result, &r); err != nil {
		return errors.New("resposta inesperada da Cloudflare")
	}
	if r.Status != "active" {
		return &CFError{Hint: "O token da Cloudflare não está ativo (estado: " + r.Status + ")."}
	}
	return nil
}

const hintZoneRead = "Ele precisa de Zone → Zone → Read."
const hintDNSEdit = "Ele precisa de Zone → DNS → Edit na zona escolhida."

func (c *cfClient) ListZones(ctx context.Context) ([]Zone, error) {
	var all []Zone
	for page := 1; page <= 20; page++ {
		q := url.Values{"per_page": {"50"}, "page": {fmt.Sprint(page)}, "status": {"active"}}
		env, err := c.do(ctx, http.MethodGet, "/zones", q, nil, hintZoneRead)
		if err != nil {
			return nil, err
		}
		var zs []Zone
		if err := json.Unmarshal(env.Result, &zs); err != nil {
			return nil, errors.New("resposta inesperada da Cloudflare")
		}
		all = append(all, zs...)
		if env.Info.TotalPages <= page {
			break
		}
	}
	return all, nil
}

func (c *cfClient) GetZone(ctx context.Context, id string) (Zone, error) {
	var z Zone
	if err := checkID(id); err != nil {
		return z, err
	}
	env, err := c.do(ctx, http.MethodGet, "/zones/"+id, nil, nil, hintZoneRead)
	if err != nil {
		return z, err
	}
	if err := json.Unmarshal(env.Result, &z); err != nil {
		return z, errors.New("resposta inesperada da Cloudflare")
	}
	return z, nil
}

func checkID(id string) error {
	if id == "" || len(id) > 64 || strings.Trim(id, "0123456789abcdefABCDEF") != "" {
		return errors.New("identificador inválido")
	}
	return nil
}

func (c *cfClient) ListRecords(ctx context.Context, zoneID, name string) ([]Record, error) {
	if err := checkID(zoneID); err != nil {
		return nil, err
	}
	q := url.Values{"name": {name}, "per_page": {"100"}}
	env, err := c.do(ctx, http.MethodGet, "/zones/"+zoneID+"/dns_records", q, nil, hintDNSEdit)
	if err != nil {
		return nil, err
	}
	var rs []Record
	if err := json.Unmarshal(env.Result, &rs); err != nil {
		return nil, errors.New("resposta inesperada da Cloudflare")
	}
	// o filtro do servidor é por nome; confirmo aqui para não depender dele
	out := rs[:0]
	for _, r := range rs {
		if strings.EqualFold(r.Name, name) {
			out = append(out, r)
		}
	}
	return out, nil
}

func (c *cfClient) CreateRecord(ctx context.Context, zoneID string, r Record) (Record, error) {
	if err := checkID(zoneID); err != nil {
		return Record{}, err
	}
	r.ID = ""
	env, err := c.do(ctx, http.MethodPost, "/zones/"+zoneID+"/dns_records", nil, r, hintDNSEdit)
	if err != nil {
		return Record{}, err
	}
	var out Record
	if err := json.Unmarshal(env.Result, &out); err != nil {
		return Record{}, errors.New("resposta inesperada da Cloudflare")
	}
	return out, nil
}

func (c *cfClient) UpdateRecord(ctx context.Context, zoneID, id string, r Record) (Record, error) {
	if err := checkID(zoneID); err != nil {
		return Record{}, err
	}
	if err := checkID(id); err != nil {
		return Record{}, err
	}
	r.ID = ""
	env, err := c.do(ctx, http.MethodPatch, "/zones/"+zoneID+"/dns_records/"+id, nil, r, hintDNSEdit)
	if err != nil {
		return Record{}, err
	}
	var out Record
	if err := json.Unmarshal(env.Result, &out); err != nil {
		return Record{}, errors.New("resposta inesperada da Cloudflare")
	}
	return out, nil
}

func (c *cfClient) DeleteRecord(ctx context.Context, zoneID, id string) error {
	if err := checkID(zoneID); err != nil {
		return err
	}
	if err := checkID(id); err != nil {
		return err
	}
	_, err := c.do(ctx, http.MethodDelete, "/zones/"+zoneID+"/dns_records/"+id, nil, nil, hintDNSEdit)
	return err
}

// DNSOutcome descreve o que EnsureRecord fez.
type DNSOutcome struct {
	RecordID string
	Action   string // "criado", "atualizado", "igual"
}

// EnsureRecord garante um registro A/AAAA para name com o conteúdo desejado.
// Registro do mesmo nome que não seja do assistente (sem WizardComment), ou um
// CNAME, faz parar com erro: nada é tocado.
func EnsureRecord(ctx context.Context, api CFAPI, zoneID, name, typ, content string, proxied bool) (DNSOutcome, error) {
	existing, err := api.ListRecords(ctx, zoneID, name)
	if err != nil {
		return DNSOutcome{}, err
	}
	want := Record{Type: typ, Name: name, Content: content, Proxied: proxied, TTL: 300, Comment: WizardComment}
	if proxied {
		want.TTL = 1
	}
	var mine *Record
	for i, r := range existing {
		switch {
		case r.Type == typ && r.Comment == WizardComment:
			mine = &existing[i]
		case r.Type == typ, r.Type == "CNAME":
			return DNSOutcome{}, fmt.Errorf("já existe um registro %s para %s na Cloudflare que não foi criado por este assistente. Apague-o lá, ou escolha outro subdomínio. Não mexi nele", r.Type, name)
		}
	}
	if mine == nil {
		rec, err := api.CreateRecord(ctx, zoneID, want)
		if err != nil {
			return DNSOutcome{}, err
		}
		return DNSOutcome{RecordID: rec.ID, Action: "criado"}, nil
	}
	if mine.Content == content && mine.Proxied == proxied {
		return DNSOutcome{RecordID: mine.ID, Action: "igual"}, nil
	}
	rec, err := api.UpdateRecord(ctx, zoneID, mine.ID, want)
	if err != nil {
		return DNSOutcome{}, err
	}
	if rec.ID == "" {
		rec.ID = mine.ID
	}
	return DNSOutcome{RecordID: rec.ID, Action: "atualizado"}, nil
}

// RemoveWizardRecords apaga, entre os ids dados, só os que ainda são do assistente.
func RemoveWizardRecords(ctx context.Context, api CFAPI, zoneID, name string, ids []string) (removed int, err error) {
	existing, err := api.ListRecords(ctx, zoneID, name)
	if err != nil {
		return 0, err
	}
	for _, r := range existing {
		if r.Comment != WizardComment {
			continue
		}
		for _, id := range ids {
			if r.ID == id {
				if err := api.DeleteRecord(ctx, zoneID, r.ID); err != nil {
					return removed, err
				}
				removed++
			}
		}
	}
	return removed, nil
}

// DNSResult é o que o passo "Endereço" devolve: os registros criados (ou já
// existentes do assistente) e uma frase por registro.
type DNSResult struct {
	Domain    string   `json:"domain"`
	RecordIDs []string `json:"record_ids"`
	Notes     []string `json:"notes"`
}

// SetupDNS aponta domain para ip (A ou AAAA, sempre "somente DNS"). Repetir não
// duplica nem mexe em registro que não seja do assistente.
func SetupDNS(ctx context.Context, api CFAPI, zoneID, zoneName, domain, ip string) (DNSResult, error) {
	domain = NormalizeDomain(domain)
	if err := ValidateDomain(domain); err != nil {
		return DNSResult{}, err
	}
	if !DomainInZone(domain, zoneName) {
		return DNSResult{}, errors.New("o domínio precisa ser a zona escolhida ou um subdomínio dela")
	}
	addr := net.ParseIP(strings.TrimSpace(ip))
	if addr == nil {
		return DNSResult{}, errors.New("informe o IP do servidor (ex.: 203.0.113.9)")
	}
	z, err := api.GetZone(ctx, zoneID)
	if err != nil {
		return DNSResult{}, err
	}
	if !strings.EqualFold(z.Name, zoneName) {
		return DNSResult{}, errors.New("a zona escolhida não é " + zoneName)
	}
	typ := "AAAA"
	if addr.To4() != nil {
		typ = "A"
	}
	o, err := EnsureRecord(ctx, api, zoneID, domain, typ, addr.String(), false)
	if err != nil {
		return DNSResult{}, err
	}
	return DNSResult{Domain: domain, RecordIDs: []string{o.RecordID},
		Notes: []string{fmt.Sprintf("Registro %s %s → %s: %s.", typ, domain, addr, o.Action)}}, nil
}
