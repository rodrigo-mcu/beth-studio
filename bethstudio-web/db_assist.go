package main

// Assistente de SQL: corrige sintaxe ou responde uma pergunta usando o
// modelo escolhido em Configurações → Banco de dados. Manda o SQL e os
// nomes do esquema ao provedor; não manda linhas nem senha, e não executa
// o que o modelo devolver.

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

const dbAssistSchemaMax = 12_000

var dbAssistIdent = regexp.MustCompile(`[A-Za-z_][A-Za-z0-9_]*`)

func dbAssistNames(text string) map[string]struct{} {
	out := map[string]struct{}{}
	for _, m := range dbAssistIdent.FindAllString(text, 400) {
		if len(m) > 64 {
			continue
		}
		out[strings.ToLower(m)] = struct{}{}
	}
	return out
}

func stripSQLFence(s string) string {
	s = strings.TrimSpace(s)
	if !strings.HasPrefix(s, "```") {
		return s
	}
	rest := s[3:]
	if i := strings.IndexByte(rest, '\n'); i >= 0 {
		rest = rest[i+1:]
	} else {
		rest = strings.TrimPrefix(strings.TrimPrefix(rest, "sql"), "SQL")
	}
	rest = strings.TrimSpace(rest)
	if strings.HasSuffix(rest, "```") {
		rest = strings.TrimSpace(rest[:len(rest)-3])
	}
	return strings.TrimSpace(rest)
}

func firstSQLFence(s string) string {
	i := strings.Index(s, "```")
	if i < 0 {
		return ""
	}
	rest := s[i+3:]
	if nl := strings.IndexByte(rest, '\n'); nl >= 0 {
		head := strings.TrimSpace(rest[:nl])
		if head == "" || strings.EqualFold(head, "sql") {
			rest = rest[nl+1:]
		}
	}
	j := strings.Index(rest, "```")
	if j < 0 {
		return strings.TrimSpace(rest)
	}
	return strings.TrimSpace(rest[:j])
}

func dbAssistParse(mode, raw string) (sql, answer string) {
	raw = strings.TrimSpace(raw)
	if mode == "fix" {
		return stripSQLFence(raw), ""
	}
	return firstSQLFence(raw), raw
}

func dbAssistSystem(mode, label, schema, note string) string {
	var b strings.Builder
	if mode == "fix" {
		b.WriteString("Você corrige SQL de " + label + ". Responda só com o SQL corrigido, sem explicação e sem markdown. Não invente tabelas nem colunas que não estejam no esquema. Se já estiver certo, devolva o mesmo SQL.\n")
	} else {
		b.WriteString("Você é o assistente de banco do Beth Studio. O dialeto é " + label + ". Responda em português, curto e direto. Pode incluir um bloco ```sql com uma consulta; ela não é executada. Use só tabelas e colunas do esquema. Se a sugestão altera ou apaga dados, avise na primeira frase.\n")
	}
	if note != "" {
		b.WriteString(note + "\n")
	}
	if schema != "" {
		b.WriteString("Esquema:\n")
		b.WriteString(schema)
	}
	return b.String()
}

func dbAssistSchemaText(ctx context.Context, d dbDriver, q queryer, sql, question string) (string, error) {
	schemas, current, err := dbListSchemas(ctx, d, q, false)
	if err != nil {
		return "", err
	}
	ordered := make([]string, 0, 4)
	if current != "" {
		ordered = append(ordered, current)
	}
	for _, s := range schemas {
		if strings.EqualFold(s, current) {
			continue
		}
		ordered = append(ordered, s)
		if len(ordered) >= 4 {
			break
		}
	}
	want := dbAssistNames(sql + "\n" + question)
	info, _ := dbDriverByID(d)
	var b strings.Builder
	b.WriteString("Dialeto: " + info.Label + "\n")
	tables := 0
	withCols := 0
	for _, schema := range ordered {
		if b.Len() > dbAssistSchemaMax {
			break
		}
		objs, err := dbListObjects(ctx, d, q, schema)
		if err != nil {
			continue
		}
		b.WriteString("schema " + schema + ":\n")
		n := 0
		for _, o := range objs {
			if tables >= 80 || n >= 40 {
				b.WriteString("  …\n")
				break
			}
			_, hit := want[strings.ToLower(o.Name)]
			line := "  " + o.Name
			if (hit || len(objs) <= 12) && withCols < 12 {
				if cols, err := dbListColumns(ctx, d, q, schema, o.Name); err == nil {
					withCols++
					parts := make([]string, 0, len(cols))
					for i, c := range cols {
						if i >= 30 {
							parts = append(parts, "…")
							break
						}
						p := c.Name + " " + c.Type
						if c.PK {
							p += " pk"
						}
						parts = append(parts, p)
					}
					line += " (" + strings.Join(parts, ", ") + ")"
				}
			}
			b.WriteString(line + "\n")
			n++
			tables++
			if b.Len() > dbAssistSchemaMax {
				break
			}
		}
	}
	return b.String(), nil
}

func (s *server) dbAssist(w http.ResponseWriter, r *http.Request, body []byte) {
	var req struct {
		ID       string `json:"id"`
		Mode     string `json:"mode"`
		SQL      string `json:"sql"`
		Question string `json:"question"`
		Database string `json:"database"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		dbFail(w, http.StatusBadRequest, errors.New("requisição inválida"))
		return
	}
	mode := strings.ToLower(strings.TrimSpace(req.Mode))
	if mode != "fix" && mode != "ask" {
		dbFail(w, http.StatusBadRequest, errors.New("modo inválido"))
		return
	}
	sqlText := strings.TrimSpace(req.SQL)
	question := strings.TrimSpace(req.Question)
	if len(sqlText) > 32<<10 || len(question) > 4000 {
		dbFail(w, http.StatusBadRequest, errors.New("texto grande demais"))
		return
	}
	if mode == "fix" && sqlText == "" {
		dbFail(w, http.StatusBadRequest, errors.New("escreva o SQL para corrigir"))
		return
	}
	if mode == "ask" && question == "" {
		dbFail(w, http.StatusBadRequest, errors.New("escreva a pergunta"))
		return
	}
	if dbStandalone {
		settings.reloadFromDisk()
	}
	v := settings.voice()
	if !v.DBAssistEnabled || v.DBAssistProvider == "" {
		dbFail(w, http.StatusBadRequest, errors.New("o assistente de banco está desligado — escolha o modelo em Configurações → Banco de dados"))
		return
	}
	pc, err := settings.callFor(v.DBAssistProvider)
	if err != nil {
		dbFail(w, http.StatusBadRequest, err)
		return
	}
	model := v.DBAssistModel
	if model == "" && len(pc.prefs.LLMModels) > 0 {
		model = pc.prefs.LLMModels[0]
	}
	if model == "" && len(pc.def.LLMModels) > 0 {
		model = pc.def.LLMModels[0]
	}
	if model == "" {
		dbFail(w, http.StatusBadRequest, errors.New("escolha o modelo em Configurações → Banco de dados"))
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
	defer cancel()
	t, err := s.dbResolve(ctx, req.ID, req.Database)
	if err != nil {
		dbFail(w, http.StatusBadRequest, err)
		return
	}
	schema := ""
	note := ""
	sctx, scancel := context.WithTimeout(ctx, 8*time.Second)
	db, derr := dbPools.get(sctx, t.cfg, t.password, t.database)
	if derr != nil {
		note = "Não foi possível abrir a conexão para ler o esquema."
	} else if text, serr := dbAssistSchemaText(sctx, t.cfg.Driver, db, sqlText, question); serr != nil {
		note = "Não foi possível ler o esquema."
	} else {
		schema = text
	}
	scancel()

	info, _ := dbDriverByID(t.cfg.Driver)
	label := info.Label
	if label == "" {
		label = string(t.cfg.Driver)
	}
	system := dbAssistSystem(mode, label, schema, note)
	user := sqlText
	if mode == "ask" {
		user = "Pergunta:\n" + question
		if sqlText != "" {
			user += "\n\nSQL atual:\n" + sqlText
		}
	}
	price := startPriceLookup(v.DBAssistProvider, model, "llm")
	start := time.Now()
	out, u, err := pc.correctStream(ctx, model, system, user, func(string) {})
	total := time.Since(start)
	rec := UsageRecord{TS: time.Now(), Func: "banco", Provider: pc.def.ID, Model: model, Ms: total.Milliseconds()}
	if u.Reported {
		rec.InTokens, rec.OutTokens = u.In, u.Out
	} else {
		rec.InTokens, rec.OutTokens, rec.Estimated = estimateTokens(system)+estimateTokens(user), estimateTokens(out), true
	}
	if err != nil || strings.TrimSpace(out) == "" {
		if err == nil {
			err = errors.New("o modelo não respondeu")
		}
		msg := err.Error()
		if utf8.RuneCountInString(msg) > 300 {
			msg = string([]rune(msg)[:300])
		}
		rec.Error = msg
		recordUsage(rec, price)
		dbFail(w, http.StatusBadGateway, errors.New(msg))
		return
	}
	rec.OK = true
	rec = recordUsage(rec, price)
	sqlOut, answer := dbAssistParse(mode, out)
	if len(answer) > 32<<10 {
		answer = answer[:32<<10]
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"sql": sqlOut, "answer": answer, "model": model, "ms": total.Milliseconds(), "cost_usd": rec.CostUSD,
	})
}
