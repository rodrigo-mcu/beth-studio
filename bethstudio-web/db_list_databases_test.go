package main

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"
)

func TestDBTestListDatabasesUnsupportedDriver(t *testing.T) {
	w := httptest.NewRecorder()
	dbTestListDatabases(context.Background(), w, DBConnConfig{Driver: dbSQLite}, "")
	var r struct {
		OK    bool   `json:"ok"`
		Error string `json:"error"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &r); err != nil {
		t.Fatal(err)
	}
	if r.OK || r.Error == "" {
		t.Fatalf("SQLite não tem lista de bancos: %+v", r)
	}
}
