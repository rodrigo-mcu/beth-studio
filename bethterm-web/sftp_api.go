package main

// sftp_api.go — navegador de arquivos de um host salvo (github.com/pkg/sftp),
// rodando no processo do bethterm-web (nao no host de terminais).
//
//	POST /api/ssh/sftp/list     {id, path}      -> {path, parent, entries}
//	POST /api/ssh/sftp/download {id, path}      -> {saved} (pasta Downloads)
//	POST /api/ssh/sftp/upload?id=&path=&overwrite=1 (application/octet-stream)
//	POST /api/ssh/sftp/mkdir    {id, path}
//	POST /api/ssh/sftp/rename   {id, from, to}
//	POST /api/ssh/sftp/remove   {id, path, is_dir}
//	POST /api/ssh/sftp/reveal   {path}          -> abre o Explorer no arquivo baixado
//
// Todas as rotas JSON aceitam "password"/"passphrase" (host sem credencial
// salva); o upload usa os cabecalhos X-SSH-*-B64 (ssh_net_api.go).
//
// Uma conexao por host, reaproveitada entre cliques e fechada apos 3 min
// sem uso. Erro de chave do servidor volta como {ok:false, code, host_key}
// para a interface perguntar, igual ao "Testar conexão".

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
	"golang.org/x/sys/windows"
)

const (
	sftpIdle      = 3 * time.Minute
	sftpMaxList   = 20000
	sftpMaxUpload = 16 << 30
)

type sftpConn struct {
	ssh  *ssh.Client
	sftp *sftp.Client
	used time.Time
}

var (
	sftpMu      sync.Mutex
	sftpPool    = map[string]*sftpConn{}
	sftpJanitor sync.Once
)

func sftpDrop(id string) {
	sftpMu.Lock()
	defer sftpMu.Unlock()
	if c := sftpPool[id]; c != nil {
		_ = c.sftp.Close()
		_ = c.ssh.Close()
		delete(sftpPool, id)
	}
}

// sftpGet: cliente vivo para o host (reusa; reconecta se caiu).
func sftpGet(h SSHSavedHost, creds sshCreds) (*sftp.Client, error) {
	sftpJanitor.Do(func() {
		go func() {
			for range time.Tick(30 * time.Second) {
				sftpMu.Lock()
				for id, c := range sftpPool {
					if time.Since(c.used) > sftpIdle {
						_ = c.sftp.Close()
						_ = c.ssh.Close()
						delete(sftpPool, id)
					}
				}
				sftpMu.Unlock()
			}
		}()
	})
	sftpMu.Lock()
	if c := sftpPool[h.ID]; c != nil {
		if _, err := c.sftp.Getwd(); err == nil {
			c.used = time.Now()
			sftpMu.Unlock()
			return c.sftp, nil
		}
		_ = c.sftp.Close()
		_ = c.ssh.Close()
		delete(sftpPool, h.ID)
	}
	sftpMu.Unlock()

	cl, err := sshDial(h, creds, nil, 20*time.Second)
	if err != nil {
		return nil, err
	}
	sc, err := sftp.NewClient(cl)
	if err != nil {
		_ = cl.Close()
		return nil, fmt.Errorf("o servidor não oferece SFTP: %v", err)
	}
	sftpMu.Lock()
	if old := sftpPool[h.ID]; old != nil { // outra requisicao conectou junto
		_ = sc.Close()
		_ = cl.Close()
		old.used = time.Now()
		sftpMu.Unlock()
		return old.sftp, nil
	}
	sftpPool[h.ID] = &sftpConn{ssh: cl, sftp: sc, used: time.Now()}
	sftpMu.Unlock()
	return sc, nil
}

// sftpEntry: um item da listagem.
type sftpEntry struct {
	Name   string `json:"name"`
	Size   int64  `json:"size"`
	IsDir  bool   `json:"is_dir"`
	IsLink bool   `json:"is_link"`
	Mode   string `json:"mode"`
	MTime  int64  `json:"mtime"`
}

// sftpFail: erro de conexao/chave vira JSON que a interface entende.
func sftpFail(w http.ResponseWriter, err error) {
	var ke *sshHostKeyError
	if errors.As(err, &ke) {
		// 200 de proposito: o cliente JSON da interface so' le o corpo de
		// respostas OK; {ok:false, code, host_key} faz ela perguntar.
		writeJSON(w, http.StatusOK, sshResultFromErr(err))
		return
	}
	msg := sshFriendlyErr(err).Error()
	switch {
	case errors.Is(err, os.ErrNotExist):
		msg = "arquivo ou pasta não existe no servidor"
	case errors.Is(err, os.ErrPermission):
		msg = "sem permissão no servidor para esta operação"
	}
	writeJSON(w, http.StatusBadGateway, map[string]string{"error": msg})
}

func sftpCleanRemote(p string) (string, error) {
	p = strings.TrimSpace(p)
	if p == "" || strings.ContainsRune(p, 0) || len(p) > 4096 {
		return "", errors.New("caminho inválido")
	}
	return path.Clean(p), nil
}

func (s *server) serveSFTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/api/ssh/sftp/reveal" {
		s.serveSFTPReveal(w, r)
		return
	}
	var (
		id     string
		body   map[string]any
		upload = r.URL.Path == "/api/ssh/sftp/upload"
	)
	if upload {
		if r.Method != http.MethodPost || r.Header.Get("Content-Type") != "application/octet-stream" {
			http.Error(w, "use POST application/octet-stream", http.StatusUnsupportedMediaType)
			return
		}
		id = r.URL.Query().Get("id")
	} else {
		if !sshDecodePOST(w, r, &body) {
			return
		}
		id, _ = body["id"].(string)
	}
	h, err := sshResolveReqHost(id, nil)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	str := func(k string) string { v, _ := body[k].(string); return v }
	sc, err := sftpGet(h, sshReqCreds(r, str("password"), str("passphrase")))
	if err != nil {
		sftpFail(w, err)
		return
	}

	switch r.URL.Path {
	case "/api/ssh/sftp/list":
		dir := strings.TrimSpace(str("path"))
		if dir == "" {
			dir = h.InitialDir
		}
		if dir == "" {
			if wd, err := sc.Getwd(); err == nil && wd != "" {
				dir = wd
			} else {
				dir = "."
			}
		}
		if real, err := sc.RealPath(dir); err == nil && real != "" {
			dir = real
		}
		infos, err := sc.ReadDir(dir)
		if err != nil {
			sftpFail(w, err)
			return
		}
		if len(infos) > sftpMaxList {
			infos = infos[:sftpMaxList]
		}
		out := make([]sftpEntry, 0, len(infos))
		for _, fi := range infos {
			e := sftpEntry{Name: fi.Name(), Size: fi.Size(), IsDir: fi.IsDir(), IsLink: fi.Mode()&os.ModeSymlink != 0, Mode: fi.Mode().String(), MTime: fi.ModTime().Unix()}
			if e.IsLink { // link para pasta: navegavel
				if st, err := sc.Stat(path.Join(dir, fi.Name())); err == nil && st.IsDir() {
					e.IsDir = true
				}
			}
			out = append(out, e)
		}
		sort.SliceStable(out, func(i, j int) bool {
			if out[i].IsDir != out[j].IsDir {
				return out[i].IsDir
			}
			return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
		})
		parent := path.Dir(dir)
		if parent == dir {
			parent = ""
		}
		writeJSON(w, http.StatusOK, map[string]any{"path": dir, "parent": parent, "entries": out})

	case "/api/ssh/sftp/download":
		p, err := sftpCleanRemote(str("path"))
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		saved, err := sftpDownload(sc, p)
		if err != nil {
			sftpFail(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"saved": saved})

	case "/api/ssh/sftp/upload":
		p, err := sftpCleanRemote(r.URL.Query().Get("path"))
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		if _, err := sc.Lstat(p); err == nil && r.URL.Query().Get("overwrite") != "1" {
			writeJSON(w, http.StatusConflict, map[string]string{"code": "exists", "error": path.Base(p) + " já existe no servidor"})
			return
		}
		n, err := sftpUpload(sc, p, http.MaxBytesReader(w, r.Body, sftpMaxUpload))
		if err != nil {
			sftpFail(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "bytes": n})

	case "/api/ssh/sftp/mkdir":
		p, err := sftpCleanRemote(str("path"))
		if err == nil {
			err = sc.Mkdir(p)
		}
		sftpDone(w, err)

	case "/api/ssh/sftp/rename":
		from, err := sftpCleanRemote(str("from"))
		to, err2 := sftpCleanRemote(str("to"))
		if err == nil {
			err = err2
		}
		if err == nil {
			if _, e := sc.Lstat(to); e == nil {
				err = errors.New(path.Base(to) + " já existe")
			} else {
				err = sc.Rename(from, to)
			}
		}
		sftpDone(w, err)

	case "/api/ssh/sftp/remove":
		p, err := sftpCleanRemote(str("path"))
		if err == nil && (p == "/" || p == ".") {
			err = errors.New("não é possível apagar a raiz")
		}
		if err == nil {
			if isDir, _ := body["is_dir"].(bool); isDir {
				err = sc.RemoveAll(p)
			} else {
				err = sc.Remove(p)
			}
		}
		sftpDone(w, err)

	default:
		http.Error(w, "não encontrado", http.StatusNotFound)
	}
}

func sftpDone(w http.ResponseWriter, err error) {
	if err != nil {
		if strings.Contains(err.Error(), "inválido") || strings.Contains(err.Error(), "já existe") || strings.Contains(err.Error(), "raiz") {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		sftpFail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// sftpUpload grava em "<destino>.bethterm-part" e so' no fim renomeia: uma
// transferencia interrompida nao deixa um arquivo pela metade com o nome final.
func sftpUpload(sc *sftp.Client, dest string, body io.Reader) (int64, error) {
	tmp := dest + ".bethterm-part"
	f, err := sc.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC)
	if err != nil {
		return 0, err
	}
	n, err := io.Copy(f, body)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		_ = sc.Remove(tmp)
		return n, err
	}
	if err := sc.PosixRename(tmp, dest); err != nil {
		_ = sc.Remove(dest)
		if err := sc.Rename(tmp, dest); err != nil {
			_ = sc.Remove(tmp)
			return n, err
		}
	}
	return n, nil
}

// sftpDownloadsDir: pasta Downloads do usuario (BETHTERM_DOWNLOADS nos testes).
func sftpDownloadsDir() (string, error) {
	if v := strings.TrimSpace(os.Getenv("BETHTERM_DOWNLOADS")); v != "" {
		return v, nil
	}
	return windows.KnownFolderPath(windows.FOLDERID_Downloads, 0)
}

func sftpDownload(sc *sftp.Client, remote string) (string, error) {
	st, err := sc.Stat(remote)
	if err != nil {
		return "", err
	}
	if st.IsDir() {
		return "", errors.New("baixar pastas inteiras ainda não é suportado; baixe os arquivos")
	}
	dir, err := sftpDownloadsDir()
	if err != nil {
		return "", fmt.Errorf("pasta Downloads não encontrada: %v", err)
	}
	name := sftpSafeLocalName(path.Base(remote))
	dst := filepath.Join(dir, name)
	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	for i := 1; ; i++ {
		if _, err := os.Lstat(dst); errors.Is(err, os.ErrNotExist) {
			break
		}
		if i > 999 {
			return "", errors.New("nomes demais iguais em Downloads")
		}
		dst = filepath.Join(dir, stem+" ("+strconv.Itoa(i)+")"+ext)
	}
	src, err := sc.Open(remote)
	if err != nil {
		return "", err
	}
	defer src.Close()
	tmp := dst + ".part"
	out, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return "", err
	}
	_, err = io.Copy(out, src)
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(tmp, dst)
	}
	if err != nil {
		_ = os.Remove(tmp)
		return "", err
	}
	return dst, nil
}

// sftpSafeLocalName: nome remoto -> nome valido no Windows.
func sftpSafeLocalName(n string) string {
	n = strings.Map(func(r rune) rune {
		if r < 0x20 || strings.ContainsRune(`<>:"/\|?*`, r) {
			return '_'
		}
		return r
	}, n)
	n = strings.TrimRight(n, ". ")
	switch strings.ToUpper(strings.TrimSuffix(n, filepath.Ext(n))) {
	case "", "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "LPT1", "LPT2", "LPT3":
		n = "_" + n
	}
	return n
}

// serveSFTPReveal abre o Explorer selecionando um arquivo baixado (so'
// arquivos dentro da pasta Downloads).
func (s *server) serveSFTPReveal(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path string `json:"path"`
	}
	if !sshDecodePOST(w, r, &req) {
		return
	}
	dir, err := sftpDownloadsDir()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	p := filepath.Clean(req.Path)
	rel, err := filepath.Rel(dir, p)
	if err != nil || strings.HasPrefix(rel, "..") || filepath.IsAbs(rel) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "só arquivos da pasta Downloads"})
		return
	}
	if _, err := os.Stat(p); err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "arquivo não encontrado"})
		return
	}
	cmd := exec.Command("explorer.exe", "/select,"+p)
	if err := cmd.Start(); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	go func() { _ = cmd.Wait() }()
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
