package main

// aiusage.go — registro de custo das chamadas PAGAS de IA (transcricao e
// correcao, inclusive as do "Testar tudo"). Uma linha JSON por chamada em
// %APPDATA%\bethstudio\ai-usage.jsonl (append; rotacao a 5 MB mantendo o
// anterior em .1). NUNCA grava audio nem texto. Catalogo/modelos/testar
// chave sao gratis e nao entram aqui.

import (
	"bufio"
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type UsagePrice struct {
	PerMin  float64 `json:"per_min,omitempty"`
	InPerM  float64 `json:"in_per_m,omitempty"`
	OutPerM float64 `json:"out_per_m,omitempty"`
}

type UsageRecord struct {
	TS          time.Time   `json:"ts"`
	Func        string      `json:"func"` // transcricao | correcao
	Test        bool        `json:"test,omitempty"`
	Provider    string      `json:"provider"`
	Model       string      `json:"model"`
	AudioSec    float64     `json:"audio_sec,omitempty"`
	InTokens    int         `json:"in_tokens,omitempty"`
	OutTokens   int         `json:"out_tokens,omitempty"`
	Estimated   bool        `json:"estimated,omitempty"` // duracao/tokens estimados (a API nao informou)
	Ms          int64       `json:"ms"`
	TTFBMs      int64       `json:"ttfb_ms,omitempty"`
	OK          bool        `json:"ok"`
	Error       string      `json:"error,omitempty"`
	CostUSD     float64     `json:"cost_usd"`
	Price       *UsagePrice `json:"price,omitempty"`
	PriceSource string      `json:"price_source"` // api | reference | none
	Pane        *int        `json:"pane,omitempty"`
}

const usageFileName = "ai-usage.jsonl"
const usageMaxBytes = 5 << 20

var usageLog = &usageStore{}

type usageStore struct {
	mu   sync.Mutex
	path string // vazio = dataDir()/ai-usage.jsonl
	max  int64
}

func (u *usageStore) file() string {
	if u.path != "" {
		return u.path
	}
	return filepath.Join(dataDir(), usageFileName)
}

func (u *usageStore) append(rec UsageRecord) error {
	b, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	b = append(b, '\n')
	u.mu.Lock()
	defer u.mu.Unlock()
	p := u.file()
	max := u.max
	if max <= 0 {
		max = usageMaxBytes
	}
	if st, err := os.Stat(p); err == nil && st.Size()+int64(len(b)) > max {
		_ = os.Remove(p + ".1")
		if err := os.Rename(p, p+".1"); err != nil {
			return err
		}
	}
	_ = os.MkdirAll(filepath.Dir(p), 0o700)
	f, err := os.OpenFile(p, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.Write(b)
	return err
}

// readAll: o anterior (.1) e o atual, em ordem de gravacao.
func (u *usageStore) readAll() []UsageRecord {
	u.mu.Lock()
	defer u.mu.Unlock()
	var out []UsageRecord
	for _, p := range []string{u.file() + ".1", u.file()} {
		f, err := os.Open(p)
		if err != nil {
			continue
		}
		sc := bufio.NewScanner(f)
		sc.Buffer(make([]byte, 64<<10), 1<<20)
		for sc.Scan() {
			var r UsageRecord
			if json.Unmarshal(sc.Bytes(), &r) == nil && !r.TS.IsZero() {
				out = append(out, r)
			}
		}
		f.Close()
	}
	return out
}

// --- preco e custo ------------------------------------------------------

type priceResult struct {
	card   ModelCard
	source string // api | reference | none
}

// startPriceLookup busca o preco em paralelo com a chamada ao provedor
// (catalogo em cache; DeepInfra/OpenRouter podem ir a' API, com prazo).
func startPriceLookup(provider, model, fn string) <-chan priceResult {
	ch := make(chan priceResult, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
		defer cancel()
		ch <- lookupPrice(ctx, provider, model, fn)
	}()
	return ch
}

func lookupPrice(ctx context.Context, provider, model, fn string) priceResult {
	var cat ModelCatalog
	if provider == "deepinfra" || provider == "openrouter" {
		cat = modelCatalog(ctx, provider, false)
	} else {
		cat = ModelCatalog{Source: "reference", Models: referencePrices[provider]}
	}
	for _, m := range cat.Models {
		if m.ID == model && (m.Func == fn || m.Func == "") {
			if (fn == "stt" && m.PerMin >= 0) || (fn == "llm" && (m.InPerM >= 0 || m.OutPerM >= 0)) {
				return priceResult{m, cat.Source}
			}
		}
	}
	return priceResult{source: "none"}
}

// costUSD: audio (minutos × preco/min) ou tokens (× preco por 1M).
func costUSD(rec UsageRecord, p ModelCard) float64 {
	var c float64
	if rec.Func == "transcricao" {
		if p.PerMin > 0 {
			c = rec.AudioSec / 60 * p.PerMin
		}
	} else {
		if p.InPerM > 0 {
			c += float64(rec.InTokens) / 1e6 * p.InPerM
		}
		if p.OutPerM > 0 {
			c += float64(rec.OutTokens) / 1e6 * p.OutPerM
		}
	}
	return math.Round(c*1e8) / 1e8
}

// recordUsage completa o custo (espera o preco por ate 1,5 s) e grava.
func recordUsage(rec UsageRecord, price <-chan priceResult) UsageRecord {
	var pr priceResult
	select {
	case pr = <-price:
	case <-time.After(1500 * time.Millisecond):
		pr = priceResult{source: "none"}
	}
	rec.PriceSource = pr.source
	if pr.source != "none" {
		rec.Price = &UsagePrice{PerMin: math.Max(0, pr.card.PerMin), InPerM: math.Max(0, pr.card.InPerM), OutPerM: math.Max(0, pr.card.OutPerM)}
		if rec.Func == "transcricao" {
			rec.Price.InPerM, rec.Price.OutPerM = 0, 0
		} else {
			rec.Price.PerMin = 0
		}
		rec.CostUSD = costUSD(rec, pr.card)
	}
	if err := usageLog.append(rec); err != nil {
		log.Printf("uso de IA: não foi possível gravar: %v", err)
	}
	return rec
}

// --- resumo ---------------------------------------------------------------

type UsageTotals struct {
	USD   float64 `json:"usd"`
	Calls int     `json:"calls"`
}

type UsageGroup struct {
	Key string `json:"key"`
	UsageTotals
}

type UsageSummary struct {
	Today      UsageTotals   `json:"today"`
	Week       UsageTotals   `json:"week"`
	Month      UsageTotals   `json:"month"`
	All        UsageTotals   `json:"all"`
	ByProvider []UsageGroup  `json:"by_provider"`
	ByModel    []UsageGroup  `json:"by_model"`
	ByFunc     []UsageGroup  `json:"by_func"`
	Daily      []UsageGroup  `json:"daily"` // ultimos 30 dias (AAAA-MM-DD)
	Recent     []UsageRecord `json:"recent"`
	LimitUSD   float64       `json:"limit_usd"`
	OverLimit  bool          `json:"over_limit"`
	File       string        `json:"file"`
}

func summarize(recs []UsageRecord, now time.Time, limit float64, recentN int) UsageSummary {
	var s UsageSummary
	loc := now.Location()
	day0 := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, loc)
	week0 := day0.AddDate(0, 0, -6)
	month0 := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, loc)
	from30 := day0.AddDate(0, 0, -29)
	prov, model, fn, daily := map[string]*UsageTotals{}, map[string]*UsageTotals{}, map[string]*UsageTotals{}, map[string]*UsageTotals{}
	add := func(m map[string]*UsageTotals, k string, c float64) {
		t := m[k]
		if t == nil {
			t = &UsageTotals{}
			m[k] = t
		}
		t.USD += c
		t.Calls++
	}
	for _, r := range recs {
		t := r.TS.In(loc)
		c := r.CostUSD
		s.All.USD += c
		s.All.Calls++
		if !t.Before(day0) {
			s.Today.USD += c
			s.Today.Calls++
		}
		if !t.Before(week0) {
			s.Week.USD += c
			s.Week.Calls++
		}
		if !t.Before(month0) {
			s.Month.USD += c
			s.Month.Calls++
		}
		add(prov, r.Provider, c)
		add(model, r.Provider+" · "+r.Model, c)
		add(fn, r.Func, c)
		if !t.Before(from30) {
			add(daily, t.Format("2006-01-02"), c)
		}
	}
	groups := func(m map[string]*UsageTotals) []UsageGroup {
		out := make([]UsageGroup, 0, len(m))
		for k, v := range m {
			out = append(out, UsageGroup{k, *v})
		}
		sort.Slice(out, func(i, j int) bool {
			if out[i].USD != out[j].USD {
				return out[i].USD > out[j].USD
			}
			return out[i].Key < out[j].Key
		})
		return out
	}
	s.ByProvider, s.ByModel, s.ByFunc = groups(prov), groups(model), groups(fn)
	for d := from30; !d.After(day0); d = d.AddDate(0, 0, 1) {
		k := d.Format("2006-01-02")
		g := UsageGroup{Key: k}
		if t := daily[k]; t != nil {
			g.UsageTotals = *t
		}
		s.Daily = append(s.Daily, g)
	}
	n := len(recs)
	for i := n - 1; i >= 0 && len(s.Recent) < recentN; i-- {
		s.Recent = append(s.Recent, recs[i])
	}
	s.LimitUSD = limit
	s.OverLimit = limit > 0 && s.Month.USD >= limit
	return s
}

func serveAIUsage(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.URL.Path == "/api/ai-usage" && r.Method == http.MethodGet:
		n := 300
		if v, err := strconv.Atoi(r.URL.Query().Get("recent")); err == nil && v >= 0 && v <= 5000 {
			n = v
		}
		s := summarize(usageLog.readAll(), time.Now(), settings.voice().MonthlyLimitUSD, n)
		s.File = usageLog.file()
		writeJSON(w, http.StatusOK, s)
	case r.URL.Path == "/api/ai-usage/export" && r.Method == http.MethodPost:
		p, err := exportUsageCSV(usageLog.readAll())
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		_ = revealInExplorer(p, true)
		writeJSON(w, http.StatusOK, map[string]string{"path": p})
	case r.URL.Path == "/api/ai-usage/open" && r.Method == http.MethodPost:
		p := usageLog.file()
		_, err := os.Stat(p)
		if err := revealInExplorer(p, err == nil); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"path": p})
	default:
		http.Error(w, "método não permitido", http.StatusMethodNotAllowed)
	}
}

func usageCSVRows(recs []UsageRecord) [][]string {
	rows := [][]string{{"data_hora", "funcao", "teste", "provedor", "modelo", "audio_s", "tokens_entrada", "tokens_saida", "estimado",
		"tempo_ms", "primeiro_byte_ms", "ok", "erro", "custo_usd", "preco_min", "preco_entrada_1M", "preco_saida_1M", "fonte_preco", "terminal"}}
	f := func(v float64) string { return strconv.FormatFloat(v, 'f', -1, 64) }
	for _, r := range recs {
		pane := ""
		if r.Pane != nil {
			pane = strconv.Itoa(*r.Pane)
		}
		var p UsagePrice
		if r.Price != nil {
			p = *r.Price
		}
		rows = append(rows, []string{r.TS.Format(time.RFC3339), r.Func, strconv.FormatBool(r.Test), r.Provider, r.Model, f(r.AudioSec),
			strconv.Itoa(r.InTokens), strconv.Itoa(r.OutTokens), strconv.FormatBool(r.Estimated), strconv.FormatInt(r.Ms, 10),
			strconv.FormatInt(r.TTFBMs, 10), strconv.FormatBool(r.OK), r.Error, f(r.CostUSD), f(p.PerMin), f(p.InPerM), f(p.OutPerM), r.PriceSource, pane})
	}
	return rows
}

func exportUsageCSV(recs []UsageRecord) (string, error) {
	p := filepath.Join(dataDir(), fmt.Sprintf("ai-usage-%s.csv", time.Now().Format("20060102-150405")))
	var sb strings.Builder
	sb.WriteString(string(rune(0xFEFF))) // Excel reconhece UTF-8
	cw := csv.NewWriter(&sb)
	cw.Comma = ';'
	if err := cw.WriteAll(usageCSVRows(recs)); err != nil {
		return "", err
	}
	return p, os.WriteFile(p, []byte(sb.String()), 0o600)
}
