package main

// Alterações em lote na grade da tabela: apagar, alterar e inserir linhas,
// tudo numa transação. Cada UPDATE/DELETE usa a chave primária e tem que
// atingir exatamente uma linha; se algo falhar, nada é gravado.
//
//	POST /api/db/apply {id, database, schema, table,
//	  deletes: [{where}], updates: [{where, set}], inserts: [{values}]}
//	  -> {ok, deleted, updated, inserted} ou {error, change, index}

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
)

type dbRowWhere map[string]json.RawMessage

type dbApplyReq struct {
	ID       string `json:"id"`
	Database string `json:"database"`
	Schema   string `json:"schema"`
	Table    string `json:"table"`
	Deletes  []struct {
		Where dbRowWhere `json:"where"`
	} `json:"deletes"`
	Updates []struct {
		Where dbRowWhere                 `json:"where"`
		Set   map[string]json.RawMessage `json:"set"`
	} `json:"updates"`
	Inserts []struct {
		Values map[string]json.RawMessage `json:"values"`
	} `json:"inserts"`
}

// dbApplyError diz qual alteração falhou, para a grade apontar a linha.
type dbApplyError struct {
	Change string `json:"change"` // delete | update | insert
	Index  int    `json:"index"`
	Err    error  `json:"-"`
}

func (e *dbApplyError) Error() string {
	what := map[string]string{"delete": "apagar", "update": "alterar", "insert": "inserir"}[e.Change]
	return fmt.Sprintf("ao %s a linha %d: %v", what, e.Index+1, e.Err)
}

const dbMaxApply = 5000

func (s *server) dbApplyRows(w http.ResponseWriter, r *http.Request, body []byte) {
	var req dbApplyReq
	if err := json.Unmarshal(body, &req); err != nil {
		dbFail(w, http.StatusBadRequest, errors.New("requisição inválida"))
		return
	}
	if n := len(req.Deletes) + len(req.Updates) + len(req.Inserts); n == 0 {
		dbFail(w, http.StatusBadRequest, errors.New("nenhuma alteração"))
		return
	} else if n > dbMaxApply {
		dbFail(w, http.StatusBadRequest, fmt.Errorf("alterações demais de uma vez (máx. %d)", dbMaxApply))
		return
	}
	if s.dbAppReadOnly() {
		dbFail(w, http.StatusForbidden, errors.New("o Beth Studio foi aberto em modo somente leitura"))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), dbDefaultTimeout)
	defer cancel()
	t, err := s.dbResolve(ctx, req.ID, req.Database)
	if err != nil {
		dbFail(w, http.StatusBadRequest, err)
		return
	}
	if t.cfg.ReadOnly {
		dbFail(w, http.StatusForbidden, errors.New("esta conexão é somente leitura"))
		return
	}
	db, err := dbPools.get(ctx, t.cfg, t.password, t.database)
	if err != nil {
		dbFail(w, http.StatusBadGateway, dbScrubErr(err, t.password))
		return
	}
	out, err := dbApplyChanges(ctx, db, t.cfg.Driver, t.database, req)
	if err != nil {
		msg := dbScrubErr(err, t.password).Error()
		var ae *dbApplyError
		if errors.As(err, &ae) {
			writeJSON(w, http.StatusOK, map[string]any{"error": msg, "change": ae.Change, "index": ae.Index})
			return
		}
		dbFail(w, http.StatusBadRequest, errors.New(msg))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

type dbApplyOut struct {
	OK       bool `json:"ok"`
	Deleted  int  `json:"deleted"`
	Updated  int  `json:"updated"`
	Inserted int  `json:"inserted"`
}

func dbApplyChanges(ctx context.Context, db *sql.DB, d dbDriver, database string, req dbApplyReq) (dbApplyOut, error) {
	out := dbApplyOut{}
	schema := req.Schema
	if schema == "" {
		schema = dbCurrentSchema(ctx, db, d, database)
	}
	cols, err := dbListColumns(ctx, d, db, schema, req.Table)
	if err != nil {
		return out, err
	}
	if len(cols) == 0 {
		return out, errors.New("tabela não encontrada")
	}
	byName := map[string]dbColumn{}
	var pk []string
	for _, c := range cols {
		byName[c.Name] = c
		if c.PK {
			pk = append(pk, c.Name)
		}
	}
	if len(pk) == 0 && (len(req.Deletes) > 0 || len(req.Updates) > 0) {
		return out, errors.New("esta tabela não tem chave primária: só dá para inserir")
	}
	target := dbQualified(d, schema, req.Table)

	// valor de uma coluna, já no tipo dela; null=true vira NULL
	value := func(name string, raw json.RawMessage) (any, error) {
		col, ok := byName[name]
		if !ok {
			return nil, fmt.Errorf("coluna desconhecida: %s", name)
		}
		if dbLooksBinaryType(col.Type) {
			return nil, fmt.Errorf("coluna binária (%s) não é editada na grade", name)
		}
		v, err := dbDecodeCell(raw)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", name, err)
		}
		if v == nil {
			if !col.Nullable {
				return nil, fmt.Errorf("a coluna %s não aceita NULL", name)
			}
			return nil, nil
		}
		return dbCoerceCell(d, col.Type, v)
	}
	// WHERE pela chave primária; args continua a numeração dos placeholders
	where := func(wh dbRowWhere, args []any) (string, []any, error) {
		var parts []string
		for _, p := range pk {
			raw, ok := wh[p]
			if !ok {
				return "", nil, fmt.Errorf("falta a chave primária (%s)", p)
			}
			v, err := dbDecodeCell(raw)
			if err != nil {
				return "", nil, err
			}
			if v == nil {
				return "", nil, fmt.Errorf("chave primária %s vazia", p)
			}
			if v, err = dbCoerceCell(d, byName[p].Type, v); err != nil {
				return "", nil, err
			}
			args = append(args, v)
			parts = append(parts, dbQuoteIdent(d, p)+" = "+dbPlaceholder(d, len(args)))
		}
		return strings.Join(parts, " AND "), args, nil
	}

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return out, err
	}
	done := false
	defer func() {
		if !done {
			_ = tx.Rollback()
		}
	}()
	one := func(change string, i int, q string, args []any) error {
		res, err := tx.ExecContext(ctx, q, args...)
		if err != nil {
			return &dbApplyError{Change: change, Index: i, Err: err}
		}
		n, err := res.RowsAffected()
		if err != nil {
			return &dbApplyError{Change: change, Index: i, Err: err}
		}
		if change != "insert" && n != 1 {
			if n == 0 {
				return &dbApplyError{Change: change, Index: i, Err: errors.New("a linha não existe mais (outra pessoa alterou ou apagou)")}
			}
			return &dbApplyError{Change: change, Index: i, Err: fmt.Errorf("a chave atingiria %d linhas", n)}
		}
		return nil
	}

	for i, del := range req.Deletes {
		wh, args, err := where(del.Where, nil)
		if err != nil {
			return out, &dbApplyError{Change: "delete", Index: i, Err: err}
		}
		if err := one("delete", i, "DELETE FROM "+target+" WHERE "+wh, args); err != nil {
			return out, err
		}
		out.Deleted++
	}
	for i, up := range req.Updates {
		if len(up.Set) == 0 {
			continue
		}
		var sets []string
		var args []any
		for _, name := range dbSortedKeys(up.Set) {
			v, err := value(name, up.Set[name])
			if err != nil {
				return out, &dbApplyError{Change: "update", Index: i, Err: err}
			}
			args = append(args, v)
			sets = append(sets, dbQuoteIdent(d, name)+" = "+dbPlaceholder(d, len(args)))
		}
		wh, args, err := where(up.Where, args)
		if err != nil {
			return out, &dbApplyError{Change: "update", Index: i, Err: err}
		}
		if err := one("update", i, "UPDATE "+target+" SET "+strings.Join(sets, ", ")+" WHERE "+wh, args); err != nil {
			return out, err
		}
		out.Updated++
	}
	for i, ins := range req.Inserts {
		var names, marks []string
		var args []any
		for _, name := range dbSortedKeys(ins.Values) {
			v, err := value(name, ins.Values[name])
			if err != nil {
				return out, &dbApplyError{Change: "insert", Index: i, Err: err}
			}
			args = append(args, v)
			names = append(names, dbQuoteIdent(d, name))
			marks = append(marks, dbPlaceholder(d, len(args)))
		}
		var q string
		switch {
		case len(names) > 0:
			q = "INSERT INTO " + target + " (" + strings.Join(names, ", ") + ") VALUES (" + strings.Join(marks, ", ") + ")"
		case d == dbMySQL:
			q = "INSERT INTO " + target + " () VALUES ()"
		default:
			q = "INSERT INTO " + target + " DEFAULT VALUES" // só os padrões de cada coluna
		}
		if err := one("insert", i, q, args); err != nil {
			return out, err
		}
		out.Inserted++
	}
	if err := tx.Commit(); err != nil {
		return out, err
	}
	done = true
	out.OK = true
	return out, nil
}

// dbSortedKeys: ordem fixa das colunas (SQL e erros iguais a cada envio).
func dbSortedKeys(m map[string]json.RawMessage) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
