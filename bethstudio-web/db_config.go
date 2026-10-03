package main

// db_config.go — saved database connections ("Banco de dados").
//
// The list lives in <data dir>\db-connections.json (atomic writes, no
// secrets). Passwords live only in the DPAPI store (secrets.dat, see
// secrets_windows.go) under the key "db:<id>" and never go back to the page:
// the API only reports whether one is saved plus a mask.

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"
)

const dbConnectionsFile = "db-connections.json"

type dbDriver string

const (
	dbPostgres  dbDriver = "postgres"
	dbMySQL     dbDriver = "mysql"
	dbSQLServer dbDriver = "sqlserver"
	dbSQLite    dbDriver = "sqlite"
)

// dbDriverInfo is what the page needs to build the connection form.
type dbDriverInfo struct {
	ID          dbDriver `json:"id"`
	Label       string   `json:"label"`
	DefaultPort int      `json:"default_port,omitempty"`
	SSLModes    []string `json:"ssl_modes,omitempty"`
	DefaultSSL  string   `json:"default_ssl,omitempty"`
	FileBased   bool     `json:"file_based,omitempty"`
	HasDBLevel  bool     `json:"has_database_level,omitempty"` // tree shows databases above schemas
}

var dbDrivers = []dbDriverInfo{
	{ID: dbPostgres, Label: "PostgreSQL", DefaultPort: 5432, SSLModes: []string{"disable", "prefer", "require", "verify-ca", "verify-full"}, DefaultSSL: "prefer", HasDBLevel: true},
	{ID: dbMySQL, Label: "MySQL / MariaDB", DefaultPort: 3306, SSLModes: []string{"disable", "prefer", "require", "verify-full"}, DefaultSSL: "prefer"},
	{ID: dbSQLServer, Label: "SQL Server", DefaultPort: 1433, SSLModes: []string{"disable", "prefer", "require", "verify-full"}, DefaultSSL: "prefer", HasDBLevel: true},
	{ID: dbSQLite, Label: "SQLite", FileBased: true},
}

func dbDriverByID(id dbDriver) (dbDriverInfo, bool) {
	for _, d := range dbDrivers {
		if d.ID == id {
			return d, true
		}
	}
	return dbDriverInfo{}, false
}

// DBConnConfig is one saved connection (no password here, ever).
type DBConnConfig struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	Group      string   `json:"group,omitempty"`
	Driver     dbDriver `json:"driver"`
	Host       string   `json:"host,omitempty"`
	Port       int      `json:"port,omitempty"`
	Database   string   `json:"database,omitempty"`
	User       string   `json:"user,omitempty"`
	SSLMode    string   `json:"ssl_mode,omitempty"`
	File       string   `json:"file,omitempty"`        // SQLite
	CreateFile bool     `json:"create_file,omitempty"` // SQLite: create the file when missing
	ReadOnly   bool     `json:"read_only"`
	Color      string   `json:"color,omitempty"` // "#rrggbb" tag, "" = none
	// Tunnel is reserved for an SSH tunnel (id of a saved SSH host). It is
	// only honoured when dbTunnelProvider is set (see db_dialer.go).
	Tunnel string `json:"tunnel,omitempty"`
}

// dbConnView is what the page receives: the config plus password state.
type dbConnView struct {
	DBConnConfig
	HasPassword  bool   `json:"has_password"`
	PasswordMask string `json:"password_mask,omitempty"`
}

type dbConnFile struct {
	Version     int            `json:"version"`
	Connections []DBConnConfig `json:"connections"`
}

// dbSecretBackend stores passwords. The default one is the DPAPI store;
// tests swap in a memory map.
type dbSecretBackend interface {
	get(key string) string
	set(key, value string) error
}

type dpapiDBSecrets struct{}

func (dpapiDBSecrets) get(key string) string {
	v, _ := secrets.get(key, nil)
	return v
}
func (dpapiDBSecrets) set(key, value string) error { return secrets.set(key, value) }

func dbSecretKey(id string) string { return "db:" + id }

type dbConnStore struct {
	mu     sync.Mutex
	dir    string // "" = dataDir() on first use
	loaded bool
	conns  []DBConnConfig
	secret dbSecretBackend
	// onChange is called (outside the lock) after a save/delete, with the id,
	// so cached pools for that connection are dropped.
	onChange func(id string)
}

var dbConns = &dbConnStore{secret: dpapiDBSecrets{}}

func (st *dbConnStore) path() string {
	if st.dir == "" {
		st.dir = dataDir()
	}
	return filepath.Join(st.dir, dbConnectionsFile)
}

func (st *dbConnStore) loadLocked() error {
	if st.loaded {
		return nil
	}
	st.conns = nil
	b, err := os.ReadFile(st.path())
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			st.loaded = true
			return nil
		}
		return fmt.Errorf("não foi possível ler %s: %w", dbConnectionsFile, err)
	}
	var f dbConnFile
	if err := json.Unmarshal(b, &f); err != nil {
		return fmt.Errorf("%s inválido: %w", dbConnectionsFile, err)
	}
	for _, c := range f.Connections {
		if dbValidateConfig(&c) == nil && dbIDRe.MatchString(c.ID) {
			st.conns = append(st.conns, c)
		}
	}
	st.loaded = true
	return nil
}

func (st *dbConnStore) saveLocked() error {
	f := dbConnFile{Version: 1, Connections: st.conns}
	if f.Connections == nil {
		f.Connections = []DBConnConfig{}
	}
	b, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	if err := writeAtomic(st.path(), b); err != nil {
		return fmt.Errorf("não foi possível gravar %s: %w", dbConnectionsFile, err)
	}
	return nil
}

func (st *dbConnStore) viewLocked(c DBConnConfig) dbConnView {
	v := dbConnView{DBConnConfig: c}
	if pw := st.secret.get(dbSecretKey(c.ID)); pw != "" {
		v.HasPassword = true
		v.PasswordMask = "••••••"
	}
	return v
}

// list returns every connection, sorted by group then name.
func (st *dbConnStore) list() ([]dbConnView, error) {
	st.mu.Lock()
	defer st.mu.Unlock()
	if err := st.loadLocked(); err != nil {
		return nil, err
	}
	out := make([]dbConnView, 0, len(st.conns))
	for _, c := range st.conns {
		out = append(out, st.viewLocked(c))
	}
	sort.SliceStable(out, func(i, j int) bool {
		gi, gj := strings.ToLower(out[i].Group), strings.ToLower(out[j].Group)
		if gi != gj {
			return gi < gj
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	return out, nil
}

// get returns a connection and its password ("" when none is saved).
func (st *dbConnStore) get(id string) (DBConnConfig, string, error) {
	st.mu.Lock()
	defer st.mu.Unlock()
	if err := st.loadLocked(); err != nil {
		return DBConnConfig{}, "", err
	}
	for _, c := range st.conns {
		if c.ID == id {
			return c, st.secret.get(dbSecretKey(id)), nil
		}
	}
	return DBConnConfig{}, "", errors.New("conexão não encontrada")
}

// dbPasswordChange: nil Set = keep the saved password.
type dbPasswordChange struct {
	Set   *string
	Clear bool
}

// save creates (empty ID) or replaces a connection.
func (st *dbConnStore) save(c DBConnConfig, pw dbPasswordChange) (dbConnView, error) {
	if err := dbValidateConfig(&c); err != nil {
		return dbConnView{}, err
	}
	if pw.Set != nil && (len(*pw.Set) > 1024 || strings.ContainsAny(*pw.Set, "\r\n\x00")) {
		return dbConnView{}, errors.New("senha inválida (quebra de linha ou longa demais)")
	}
	st.mu.Lock()
	if err := st.loadLocked(); err != nil {
		st.mu.Unlock()
		return dbConnView{}, err
	}
	idx := -1
	if c.ID != "" {
		if !dbIDRe.MatchString(c.ID) {
			st.mu.Unlock()
			return dbConnView{}, errors.New("id inválido")
		}
		for i := range st.conns {
			if st.conns[i].ID == c.ID {
				idx = i
				break
			}
		}
		if idx < 0 {
			st.mu.Unlock()
			return dbConnView{}, errors.New("conexão não encontrada")
		}
	} else {
		c.ID = dbNewID()
	}
	// Password first: a failed DPAPI write must not leave a half-saved entry.
	key := dbSecretKey(c.ID)
	switch {
	case pw.Clear:
		if err := st.secret.set(key, ""); err != nil {
			st.mu.Unlock()
			return dbConnView{}, fmt.Errorf("não foi possível apagar a senha: %w", err)
		}
	case pw.Set != nil && *pw.Set != "":
		if err := st.secret.set(key, *pw.Set); err != nil {
			st.mu.Unlock()
			return dbConnView{}, fmt.Errorf("não foi possível guardar a senha: %w", err)
		}
	}
	prev := st.conns
	if idx >= 0 {
		next := append([]DBConnConfig(nil), st.conns...)
		next[idx] = c
		st.conns = next
	} else {
		st.conns = append(append([]DBConnConfig(nil), st.conns...), c)
	}
	if err := st.saveLocked(); err != nil {
		st.conns = prev
		st.mu.Unlock()
		return dbConnView{}, err
	}
	v := st.viewLocked(c)
	cb := st.onChange
	st.mu.Unlock()
	if cb != nil {
		cb(c.ID)
	}
	return v, nil
}

// remove deletes a connection and its password.
func (st *dbConnStore) remove(id string) error {
	st.mu.Lock()
	if err := st.loadLocked(); err != nil {
		st.mu.Unlock()
		return err
	}
	next := make([]DBConnConfig, 0, len(st.conns))
	found := false
	for _, c := range st.conns {
		if c.ID == id {
			found = true
			continue
		}
		next = append(next, c)
	}
	if !found {
		st.mu.Unlock()
		return errors.New("conexão não encontrada")
	}
	prev := st.conns
	st.conns = next
	if err := st.saveLocked(); err != nil {
		st.conns = prev
		st.mu.Unlock()
		return err
	}
	_ = st.secret.set(dbSecretKey(id), "")
	cb := st.onChange
	st.mu.Unlock()
	if cb != nil {
		cb(id)
	}
	return nil
}

var (
	dbIDRe    = regexp.MustCompile(`^[a-f0-9]{16}$`)
	dbColorRe = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)
	dbHostRe  = regexp.MustCompile(`^[A-Za-z0-9._:\-\[\]%\\]{1,255}$`)
)

func dbNewID() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

// dbCleanText trims and rejects control characters / oversize values.
func dbCleanText(field, v string, max int) (string, error) {
	v = strings.TrimSpace(v)
	if !utf8.ValidString(v) || utf8.RuneCountInString(v) > max {
		return "", fmt.Errorf("%s inválido ou longo demais (máx. %d)", field, max)
	}
	for _, r := range v {
		if unicode.IsControl(r) {
			return "", fmt.Errorf("%s contém caracteres de controle", field)
		}
	}
	return v, nil
}

// dbValidateConfig normalizes c in place and checks every field.
func dbValidateConfig(c *DBConnConfig) error {
	var err error
	info, ok := dbDriverByID(c.Driver)
	if !ok {
		return errors.New("tipo de banco inválido")
	}
	if c.Name, err = dbCleanText("nome", c.Name, 80); err != nil {
		return err
	}
	if c.Name == "" {
		return errors.New("dê um nome à conexão")
	}
	if c.Group, err = dbCleanText("grupo", c.Group, 60); err != nil {
		return err
	}
	if c.Color = strings.TrimSpace(c.Color); c.Color != "" && !dbColorRe.MatchString(c.Color) {
		return errors.New("cor inválida (use #rrggbb)")
	}
	c.Color = strings.ToLower(c.Color)
	if c.Tunnel, err = dbCleanText("túnel", c.Tunnel, 128); err != nil {
		return err
	}
	if info.FileBased {
		c.Host, c.Port, c.User, c.Database, c.SSLMode = "", 0, "", "", ""
		if c.File, err = dbCleanText("arquivo", c.File, 1024); err != nil {
			return err
		}
		c.File = strings.Trim(c.File, `"`)
		if c.File == "" {
			return errors.New("informe o arquivo do banco SQLite")
		}
		if strings.ContainsAny(c.File, "?#") {
			return errors.New("o caminho do arquivo não pode conter ? nem #")
		}
		// SQLite remoto pode vir como caminho Unix (/var/...), mesmo no Windows.
		if strings.HasPrefix(c.File, "/") && !strings.Contains(c.File, `\`) {
			c.File = path.Clean(c.File)
			if !strings.HasPrefix(c.File, "/") {
				return errors.New("use o caminho completo do arquivo (ex.: C:\\dados\\banco.db)")
			}
		} else if !filepath.IsAbs(c.File) {
			return errors.New("use o caminho completo do arquivo (ex.: C:\\dados\\banco.db)")
		} else {
			c.File = filepath.Clean(c.File)
		}
		if c.Tunnel != "" {
			return errors.New("SQLite não usa túnel")
		}
		return nil
	}
	c.File, c.CreateFile = "", false
	if c.Host, err = dbCleanText("servidor", c.Host, 255); err != nil {
		return err
	}
	if c.Host == "" {
		return errors.New("informe o servidor (host ou IP)")
	}
	if !dbHostRe.MatchString(c.Host) {
		return errors.New("servidor inválido")
	}
	if c.Port == 0 {
		c.Port = info.DefaultPort
	}
	if c.Port < 1 || c.Port > 65535 {
		return errors.New("porta inválida")
	}
	if c.Database, err = dbCleanText("banco", c.Database, 128); err != nil {
		return err
	}
	if c.User, err = dbCleanText("usuário", c.User, 128); err != nil {
		return err
	}
	if c.SSLMode == "" {
		c.SSLMode = info.DefaultSSL
	}
	okMode := false
	for _, m := range info.SSLModes {
		if m == c.SSLMode {
			okMode = true
			break
		}
	}
	if !okMode {
		return errors.New("modo SSL inválido para este banco")
	}
	return nil
}
