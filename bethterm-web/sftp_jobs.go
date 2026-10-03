package main

// sftp_jobs.go — fila de transferencia SFTP com progresso (janela dual-pane).
//
//	POST /api/ssh/sftp/jobs/enqueue  {id, direction, local, remote, overwrite?}
//	GET  /api/ssh/sftp/jobs?id=      -> {jobs:[...]}
//	POST /api/ssh/sftp/jobs/cancel   {job_id}
//	POST /api/ssh/sftp/jobs/clear    {id?, done_only?}

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pkg/sftp"
)

type sftpJobDir string

const (
	sftpJobUpload   sftpJobDir = "upload"
	sftpJobDownload sftpJobDir = "download"
)

type sftpJobState string

const (
	sftpJobQueued  sftpJobState = "queued"
	sftpJobRunning sftpJobState = "running"
	sftpJobDone    sftpJobState = "done"
	sftpJobError   sftpJobState = "error"
	sftpJobCancel  sftpJobState = "cancelled"
)

type sftpJob struct {
	ID          string       `json:"id"`
	HostID      string       `json:"host_id"`
	Direction   sftpJobDir   `json:"direction"`
	Local       string       `json:"local"`
	Remote      string       `json:"remote"`
	State       sftpJobState `json:"state"`
	Total       int64        `json:"total"`
	Transferred int64        `json:"transferred"`
	SpeedBps    int64        `json:"speed_bps"`
	Message     string       `json:"message,omitempty"`
	Started     int64        `json:"started,omitempty"`
	Finished    int64        `json:"finished,omitempty"`
	cancel      context.CancelFunc
}

type sftpJobPublic struct {
	ID          string       `json:"id"`
	HostID      string       `json:"host_id"`
	Direction   sftpJobDir   `json:"direction"`
	Local       string       `json:"local"`
	Remote      string       `json:"remote"`
	State       sftpJobState `json:"state"`
	Total       int64        `json:"total"`
	Transferred int64        `json:"transferred"`
	SpeedBps    int64        `json:"speed_bps"`
	Message     string       `json:"message,omitempty"`
	Started     int64        `json:"started,omitempty"`
	Finished    int64        `json:"finished,omitempty"`
}

var (
	sftpJobsMu sync.Mutex
	sftpJobs   = map[string]*sftpJob{}
	sftpJobSeq uint64
)

func (s *server) serveSFTPJobs(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/api/ssh/sftp/jobs":
		if r.Method != http.MethodGet {
			http.Error(w, "use GET", http.StatusMethodNotAllowed)
			return
		}
		hostFilter := r.URL.Query().Get("id")
		sftpJobsMu.Lock()
		out := make([]sftpJobPublic, 0, len(sftpJobs))
		for _, j := range sftpJobs {
			if hostFilter != "" && j.HostID != hostFilter {
				continue
			}
			out = append(out, j.public())
		}
		sftpJobsMu.Unlock()
		writeJSON(w, http.StatusOK, map[string]any{"jobs": out})

	case "/api/ssh/sftp/jobs/enqueue":
		if r.Method != http.MethodPost {
			http.Error(w, "use POST", http.StatusMethodNotAllowed)
			return
		}
		var body map[string]any
		if !sshDecodePOST(w, r, &body) {
			return
		}
		id, _ := body["id"].(string)
		dir, _ := body["direction"].(string)
		local := strings.TrimSpace(strMap(body, "local"))
		remote := strings.TrimSpace(strMap(body, "remote"))
		overwrite, _ := body["overwrite"].(bool)
		h, ok, err := sshGetHost(id)
		if err != nil || !ok {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "host inválido"})
			return
		}
		if local == "" || remote == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "local e remote obrigatórios"})
			return
		}
		var direction sftpJobDir
		switch dir {
		case "upload":
			direction = sftpJobUpload
			if _, err := localFSClean(local); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
			if _, err := sftpCleanRemote(remote); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
		case "download":
			direction = sftpJobDownload
			if _, err := sftpCleanRemote(remote); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
			parent := filepath.Dir(local)
			if _, err := localFSClean(parent); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
		default:
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "direction: upload|download"})
			return
		}
		job := &sftpJob{
			ID:        fmt.Sprintf("j%d", atomic.AddUint64(&sftpJobSeq, 1)),
			HostID:    h.ID,
			Direction: direction,
			Local:     local,
			Remote:    remote,
			State:     sftpJobQueued,
		}
		sftpJobsMu.Lock()
		sftpJobs[job.ID] = job
		sftpJobsMu.Unlock()
		go sftpRunJob(job, h, overwrite, sshReqCreds(r, strMap(body, "password"), strMap(body, "passphrase")))
		writeJSON(w, http.StatusOK, map[string]any{"job": job.public()})

	case "/api/ssh/sftp/jobs/cancel":
		var req struct {
			JobID string `json:"job_id"`
		}
		if !sshDecodePOST(w, r, &req) {
			return
		}
		sftpJobsMu.Lock()
		j := sftpJobs[req.JobID]
		sftpJobsMu.Unlock()
		if j == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "job não encontrado"})
			return
		}
		if j.cancel != nil {
			j.cancel()
		}
		sftpJobsMu.Lock()
		if j.State == sftpJobQueued || j.State == sftpJobRunning {
			j.State = sftpJobCancel
			j.Finished = time.Now().Unix()
			j.Message = "cancelado"
		}
		sftpJobsMu.Unlock()
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})

	case "/api/ssh/sftp/jobs/clear":
		var req struct {
			ID       string `json:"id"`
			DoneOnly bool   `json:"done_only"`
		}
		_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&req)
		sftpJobsMu.Lock()
		for id, j := range sftpJobs {
			if req.ID != "" && j.HostID != req.ID {
				continue
			}
			done := j.State == sftpJobDone || j.State == sftpJobError || j.State == sftpJobCancel
			if req.DoneOnly && !done {
				continue
			}
			if j.State == sftpJobRunning {
				continue
			}
			delete(sftpJobs, id)
		}
		sftpJobsMu.Unlock()
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})

	default:
		http.NotFound(w, r)
	}
}

func (j *sftpJob) public() sftpJobPublic {
	return sftpJobPublic{
		ID: j.ID, HostID: j.HostID, Direction: j.Direction,
		Local: j.Local, Remote: j.Remote, State: j.State,
		Total: j.Total, Transferred: atomic.LoadInt64(&j.Transferred),
		SpeedBps: atomic.LoadInt64(&j.SpeedBps), Message: j.Message,
		Started: j.Started, Finished: j.Finished,
	}
}

func strMap(m map[string]any, k string) string {
	v, _ := m[k].(string)
	return v
}

func sftpRunJob(job *sftpJob, h SSHSavedHost, overwrite bool, creds sshCreds) {
	ctx, cancel := context.WithCancel(context.Background())
	job.cancel = cancel
	defer cancel()

	sftpJobsMu.Lock()
	job.State = sftpJobRunning
	job.Started = time.Now().Unix()
	sftpJobsMu.Unlock()

	err := sftpDoTransfer(ctx, job, h, overwrite, creds)

	sftpJobsMu.Lock()
	defer sftpJobsMu.Unlock()
	job.Finished = time.Now().Unix()
	if job.State == sftpJobCancel {
		return
	}
	if ctx.Err() != nil {
		job.State = sftpJobCancel
		job.Message = "cancelado"
		return
	}
	if err != nil {
		job.State = sftpJobError
		job.Message = err.Error()
		return
	}
	job.State = sftpJobDone
	job.Message = "ok"
}

func sftpDoTransfer(ctx context.Context, job *sftpJob, h SSHSavedHost, overwrite bool, creds sshCreds) error {
	sc, err := sftpGet(h, creds)
	if err != nil {
		return err
	}
	switch job.Direction {
	case sftpJobUpload:
		return sftpJobUploadFile(ctx, job, sc, overwrite)
	case sftpJobDownload:
		return sftpJobDownloadFile(ctx, job, sc, overwrite)
	default:
		return errors.New("direção inválida")
	}
}

type progressCounter struct {
	job  *sftpJob
	ctx  context.Context
	last time.Time
	mark int64
	n    int64
}

func (p *progressCounter) Write(b []byte) (int, error) {
	if err := p.ctx.Err(); err != nil {
		return 0, err
	}
	n := len(b)
	atomic.AddInt64(&p.job.Transferred, int64(n))
	p.n += int64(n)
	now := time.Now()
	if now.Sub(p.last) >= 200*time.Millisecond {
		elapsed := now.Sub(p.last).Seconds()
		if elapsed > 0 {
			atomic.StoreInt64(&p.job.SpeedBps, int64(float64(p.n-p.mark)/elapsed))
		}
		p.mark = p.n
		p.last = now
	}
	return n, nil
}

func sftpJobUploadFile(ctx context.Context, job *sftpJob, sc *sftp.Client, overwrite bool) error {
	st, err := os.Stat(job.Local)
	if err != nil {
		return err
	}
	if st.IsDir() {
		return errors.New("upload de pasta ainda não suportado — escolha um arquivo")
	}
	job.Total = st.Size()
	if !overwrite {
		if _, err := sc.Stat(job.Remote); err == nil {
			return errors.New("arquivo remoto já existe (marque sobrescrever)")
		}
	}
	src, err := os.Open(job.Local)
	if err != nil {
		return err
	}
	defer src.Close()
	_ = sc.MkdirAll(path.Dir(job.Remote))
	dst, err := sc.OpenFile(job.Remote, os.O_WRONLY|os.O_CREATE|os.O_TRUNC)
	if err != nil {
		return err
	}
	defer dst.Close()
	pw := &progressCounter{job: job, ctx: ctx, last: time.Now()}
	_, err = io.Copy(io.MultiWriter(dst, pw), src)
	return err
}

func sftpJobDownloadFile(ctx context.Context, job *sftpJob, sc *sftp.Client, overwrite bool) error {
	st, err := sc.Stat(job.Remote)
	if err != nil {
		return err
	}
	if st.IsDir() {
		return errors.New("download de pasta ainda não suportado — escolha um arquivo")
	}
	job.Total = st.Size()
	if !overwrite {
		if _, err := os.Stat(job.Local); err == nil {
			return errors.New("arquivo local já existe (marque sobrescrever)")
		}
	}
	if err := os.MkdirAll(filepath.Dir(job.Local), 0o755); err != nil {
		return err
	}
	src, err := sc.Open(job.Remote)
	if err != nil {
		return err
	}
	defer src.Close()
	dst, err := os.OpenFile(job.Local, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	defer dst.Close()
	pw := &progressCounter{job: job, ctx: ctx, last: time.Now()}
	_, err = io.Copy(io.MultiWriter(dst, pw), src)
	return err
}
