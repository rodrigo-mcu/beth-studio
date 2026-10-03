package main

// notes.go — notas do editor "Sem título" (FilePreviewPanel.tsx). Cada nota é
// um arquivo .md em <dados>\notes\ com o nome AAAA-MM-DD_HH-MM-SS (hora local
// em que foi criada), então dá para abrir a pasta no Explorer e achar tudo.
//
//	POST /api/notes          {}                -> {notes:[{id,title,at,size}]}  (mais nova primeiro)
//	POST /api/notes/read     {id}              -> {id,text}
//	POST /api/notes/save     {id?,text}        -> {id,notes}  sem id cria uma nota nova
//	POST /api/notes/delete   {id}              -> {notes}

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	notesDirName  = "notes"
	notesMaxText  = 2 << 20
	notesTitleMax = 80
)

var noteIDRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(-\d{1,3})?$`)

type noteInfo struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	At    string `json:"at"` // última gravação, RFC3339
	Size  int64  `json:"size"`
}

func notesDir() string { return filepath.Join(dataDir(), notesDirName) }

func notePath(dir, id string) (string, error) {
	if !noteIDRe.MatchString(id) {
		return "", errors.New("nota inválida")
	}
	return filepath.Join(dir, id+".md"), nil
}

// noteTitle é a primeira linha com texto (sem "#" de título do Markdown).
func noteTitle(text string) string {
	for _, line := range strings.Split(text, "\n") {
		t := strings.TrimSpace(strings.TrimLeft(strings.TrimSpace(line), "#"))
		if t == "" {
			continue
		}
		if utf8.RuneCountInString(t) > notesTitleMax {
			r := []rune(t)
			t = string(r[:notesTitleMax]) + "…"
		}
		return t
	}
	return "(vazia)"
}

func notesList(dir string) ([]noteInfo, error) {
	ents, err := os.ReadDir(dir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return []noteInfo{}, nil
		}
		return nil, err
	}
	out := []noteInfo{}
	for _, e := range ents {
		name := e.Name()
		id := strings.TrimSuffix(name, ".md")
		if e.IsDir() || id == name || !noteIDRe.MatchString(id) {
			continue
		}
		st, err := e.Info()
		if err != nil {
			continue
		}
		title := "(vazia)"
		if f, err := os.Open(filepath.Join(dir, name)); err == nil {
			buf := make([]byte, 2048)
			n, _ := io.ReadFull(f, buf)
			f.Close()
			head := string(buf[:n])
			for !utf8.ValidString(head) && len(head) > 0 { // corte no meio de um caractere
				head = head[:len(head)-1]
			}
			title = noteTitle(head)
		}
		out = append(out, noteInfo{ID: id, Title: title, At: st.ModTime().UTC().Format(time.RFC3339), Size: st.Size()})
	}
	// a mais recente primeiro; o id (data de criação) desempata
	sort.Slice(out, func(i, j int) bool {
		if out[i].At != out[j].At {
			return out[i].At > out[j].At
		}
		return out[i].ID > out[j].ID
	})
	return out, nil
}

// notesSave grava a nota; id vazio cria uma nova com o horário de now.
func notesSave(dir, id, text string, now time.Time) (string, error) {
	if strings.TrimSpace(text) == "" {
		return "", errors.New("a nota está vazia")
	}
	if len(text) > notesMaxText {
		return "", errors.New("nota grande demais (mais de 2 MB)")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	if id == "" {
		base := now.Format("2006-01-02_15-04-05")
		id = base
		for n := 1; ; n++ {
			if _, err := os.Stat(filepath.Join(dir, id+".md")); errors.Is(err, os.ErrNotExist) {
				break
			}
			if n > 99 {
				return "", errors.New("notas demais no mesmo segundo")
			}
			id = fmt.Sprintf("%s-%d", base, n)
		}
	}
	p, err := notePath(dir, id)
	if err != nil {
		return "", err
	}
	if err := writeAtomic(p, []byte(text)); err != nil {
		return "", err
	}
	return id, nil
}

func notesRead(dir, id string) (string, error) {
	p, err := notePath(dir, id)
	if err != nil {
		return "", err
	}
	b, err := os.ReadFile(p)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", errors.New("a nota não existe mais")
		}
		return "", err
	}
	return string(b), nil
}

func notesDelete(dir, id string) error {
	p, err := notePath(dir, id)
	if err != nil {
		return err
	}
	if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func serveNotes(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost || !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		http.Error(w, "use POST application/json", http.StatusBadRequest)
		return
	}
	var req struct {
		ID   string `json:"id"`
		Text string `json:"text"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 2*notesMaxText)).Decode(&req) != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "JSON inválido (ou nota grande demais)"})
		return
	}
	fail := func(code int, err error) { writeJSON(w, code, map[string]string{"error": err.Error()}) }
	dir := notesDir()
	list := func() []noteInfo {
		l, err := notesList(dir)
		if err != nil {
			return []noteInfo{}
		}
		return l
	}
	switch r.URL.Path {
	case "/api/notes":
		l, err := notesList(dir)
		if err != nil {
			fail(http.StatusInternalServerError, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"notes": l})
	case "/api/notes/read":
		text, err := notesRead(dir, req.ID)
		if err != nil {
			fail(http.StatusNotFound, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"id": req.ID, "text": text})
	case "/api/notes/save":
		id, err := notesSave(dir, req.ID, req.Text, time.Now())
		if err != nil {
			fail(http.StatusBadRequest, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"id": id, "notes": list()})
	case "/api/notes/delete":
		if err := notesDelete(dir, req.ID); err != nil {
			fail(http.StatusBadRequest, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"notes": list()})
	default:
		http.NotFound(w, r)
	}
}
