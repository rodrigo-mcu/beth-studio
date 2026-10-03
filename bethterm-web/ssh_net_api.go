package main

// ssh_net_api.go — rotas da tela SSH que conectam de verdade:
//
//	POST /api/ssh/hosts/test        {id?, host?}            -> sshTestResult
//	POST /api/ssh/hosts/trust       {id?, host?, fingerprint} -> sshTestResult
//	POST /api/ssh/hosts/forget-key  {id}                    -> {removed}
//	/api/ssh/sftp/...                                        -> sftp_api.go
//
// Senha / frase-senha digitadas agora (host sem credencial salva) chegam no
// corpo JSON ("password"/"passphrase") ou, no upload (corpo = arquivo), nos
// cabecalhos X-SSH-Password-B64 / X-SSH-Passphrase-B64 (base64 de UTF-8).
// So' em loopback com o token; ficam so' na memoria desta requisicao/conexao.

import (
	"encoding/base64"
	"errors"
	"net/http"
	"strings"
	"time"
)

// sshTestResult: resposta de testar/confiar.
type sshTestResult struct {
	OK      bool            `json:"ok"`
	Code    string          `json:"code,omitempty"` // unknown_host_key | host_key_mismatch | auth | error
	Error   string          `json:"error,omitempty"`
	HostKey *sshHostKeyInfo `json:"host_key,omitempty"`
	Trusted bool            `json:"trusted,omitempty"`
}

func sshHeaderSecret(r *http.Request, name string) string {
	v := strings.TrimSpace(r.Header.Get(name))
	if v == "" {
		return ""
	}
	b, err := base64.StdEncoding.DecodeString(v)
	if err != nil || len(b) > 2048 {
		return ""
	}
	return string(b)
}

// sshReqCreds: corpo JSON (se houver) > cabecalhos.
func sshReqCreds(r *http.Request, password, passphrase string) sshCreds {
	c := sshCreds{Password: password, Passphrase: passphrase}
	if c.Password == "" {
		c.Password = sshHeaderSecret(r, "X-SSH-Password-B64")
	}
	if c.Passphrase == "" {
		c.Passphrase = sshHeaderSecret(r, "X-SSH-Passphrase-B64")
	}
	return c
}

// sshResolveReqHost: host salvo (id) ou o formulario ainda nao salvo (host).
func sshResolveReqHost(id string, form *SSHSavedHost) (SSHSavedHost, error) {
	if form != nil {
		h, err := sshNormalizeHost(*form)
		if err != nil {
			return h, err
		}
		if h.ID != "" && !sshHostIDRe.MatchString(h.ID) {
			return h, errors.New("id inválido")
		}
		return h, nil
	}
	h, ok, err := sshGetHost(id)
	if err != nil {
		return h, err
	}
	if !ok {
		return h, errors.New("host não encontrado")
	}
	return h, nil
}

func sshResultFromErr(err error) sshTestResult {
	var ke *sshHostKeyError
	if errors.As(err, &ke) {
		info := ke.Info
		code := "unknown_host_key"
		if info.Mismatch {
			code = "host_key_mismatch"
		}
		return sshTestResult{Code: code, Error: err.Error(), HostKey: &info}
	}
	code := "error"
	if strings.Contains(err.Error(), "autenticação") || strings.Contains(err.Error(), "senha") || strings.Contains(err.Error(), "chave") {
		code = "auth"
	}
	return sshTestResult{Code: code, Error: sshFriendlyErr(err).Error()}
}

func (s *server) serveSSHNet(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/api/ssh/sftp/") {
		switch r.URL.Path {
		case "/api/ssh/sftp/window":
			s.serveSFTPWindow(w, r)
			return
		case "/api/ssh/sftp/jobs", "/api/ssh/sftp/jobs/enqueue", "/api/ssh/sftp/jobs/cancel", "/api/ssh/sftp/jobs/clear":
			s.serveSFTPJobs(w, r)
			return
		}
		s.serveSFTP(w, r)
		return
	}
	switch r.URL.Path {
	case "/api/ssh/hosts/test", "/api/ssh/hosts/trust":
		var req struct {
			ID          string        `json:"id"`
			Host        *SSHSavedHost `json:"host"`
			Fingerprint string        `json:"fingerprint"`
			Password    string        `json:"password"`
			Passphrase  string        `json:"passphrase"`
		}
		if !sshDecodePOST(w, r, &req) {
			return
		}
		h, err := sshResolveReqHost(req.ID, req.Host)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		trust := r.URL.Path == "/api/ssh/hosts/trust"
		if trust && s.hub != nil && s.hub.readOnly {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "modo somente leitura"})
			return
		}
		trusted := false
		var onUnknown func(sshHostKeyInfo) (bool, error)
		if trust {
			if !strings.HasPrefix(req.Fingerprint, "SHA256:") {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "fingerprint obrigatório"})
				return
			}
			// so' grava se a chave for EXATAMENTE a que o usuario viu
			onUnknown = func(info sshHostKeyInfo) (bool, error) {
				trusted = info.Fingerprint == req.Fingerprint
				return trusted, nil
			}
		}
		cl, err := sshDial(h, sshReqCreds(r, req.Password, req.Passphrase), onUnknown, 15*time.Second)
		if err != nil {
			res := sshResultFromErr(err)
			res.Trusted = trusted
			writeJSON(w, http.StatusOK, res)
			return
		}
		_ = cl.Close()
		writeJSON(w, http.StatusOK, sshTestResult{OK: true, Trusted: trusted})
	case "/api/ssh/hosts/forget-key":
		var req struct {
			ID string `json:"id"`
		}
		if !sshDecodePOST(w, r, &req) {
			return
		}
		h, err := sshResolveReqHost(req.ID, nil)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		n, err := sshForgetKey(sshAddr(h))
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		sftpDrop(h.ID)
		writeJSON(w, http.StatusOK, map[string]int{"removed": n})
	default:
		http.Error(w, "não encontrado", http.StatusNotFound)
	}
}
