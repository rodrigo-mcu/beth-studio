package main

// ssh_config_import.go — importar hosts do ~/.ssh/config (formato OpenSSH).
//
// Le blocos `Host`, com a regra do OpenSSH de "o primeiro valor vale" (um
// `Host *` no fim so' completa o que faltou). Aliases com curinga (*, ?, !)
// nao viram hosts. Nao seguimos `Include` nem `Match`; ProxyJump/ProxyCommand
// nao sao suportados e aparecem como aviso no candidato.

import (
	"bufio"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// SSHConfigCandidate: um alias do arquivo, pronto para importar.
type SSHConfigCandidate struct {
	Alias    string       `json:"alias"`
	Host     SSHSavedHost `json:"host"`
	Exists   bool         `json:"exists"` // ja' ha' host salvo com o mesmo endereco/usuario/porta
	Warnings []string     `json:"warnings,omitempty"`
}

type sshCfgBlock struct {
	patterns []string
	opts     [][2]string // chave em minusculas, valor
}

func sshConfigPath() string {
	if v := strings.TrimSpace(os.Getenv("BETHSTUDIO_SSH_CONFIG")); v != "" {
		return v // testes
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".ssh", "config")
}

// sshParseConfig: blocos na ordem do arquivo; opcoes antes do primeiro Host
// valem para todos (bloco com padrao "*").
func sshParseConfig(text string) []sshCfgBlock {
	blocks := []sshCfgBlock{{patterns: []string{"*"}}}
	skip := false // dentro de um bloco Match
	sc := bufio.NewScanner(strings.NewReader(text))
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, val := line, ""
		if i := strings.IndexAny(line, " \t="); i >= 0 {
			key, val = line[:i], strings.TrimSpace(strings.TrimLeft(line[i:], " \t="))
		}
		key = strings.ToLower(key)
		val = strings.Trim(val, `"`)
		switch key {
		case "host":
			skip = false
			blocks = append(blocks, sshCfgBlock{patterns: strings.Fields(val)})
			continue
		case "match":
			skip = true
			continue
		}
		if skip {
			continue
		}
		b := &blocks[len(blocks)-1]
		b.opts = append(b.opts, [2]string{key, val})
	}
	return blocks
}

// sshCfgMatch: padroes do OpenSSH (* ? e negacao com !).
func sshCfgMatch(patterns []string, alias string) bool {
	matched := false
	for _, p := range patterns {
		neg := strings.HasPrefix(p, "!")
		p = strings.TrimPrefix(p, "!")
		if ok, _ := filepath.Match(strings.ToLower(p), strings.ToLower(alias)); ok {
			if neg {
				return false
			}
			matched = true
		}
	}
	return matched
}

// sshConfigCandidates: um candidato por alias literal.
func sshConfigCandidates(text string, existing []SSHSavedHost) []SSHConfigCandidate {
	blocks := sshParseConfig(text)
	var out []SSHConfigCandidate
	seen := map[string]bool{}
	localUser := os.Getenv("USERNAME")
	for _, b := range blocks[1:] {
		for _, alias := range b.patterns {
			if strings.ContainsAny(alias, "*?!") || seen[strings.ToLower(alias)] {
				continue
			}
			seen[strings.ToLower(alias)] = true
			vals := map[string]string{}
			var warns []string
			for _, bb := range blocks {
				if !sshCfgMatch(bb.patterns, alias) {
					continue
				}
				for _, kv := range bb.opts {
					if _, have := vals[kv[0]]; !have {
						vals[kv[0]] = kv[1]
					}
				}
			}
			h := SSHSavedHost{Name: alias, Host: alias, Port: 22, User: localUser, Auth: sshAuthPassword}
			if v := vals["hostname"]; v != "" {
				h.Host = strings.ReplaceAll(v, "%h", alias)
			}
			if v := vals["user"]; v != "" {
				h.User = v
			}
			if v, err := strconv.Atoi(vals["port"]); err == nil && v > 0 && v < 65536 {
				h.Port = v
			}
			if v := vals["identityfile"]; v != "" && !strings.EqualFold(v, "none") {
				h.Auth, h.KeyPath = sshAuthKey, v
			} else if v := vals["identityagent"]; v != "" && !strings.EqualFold(v, "none") {
				h.Auth = sshAuthAgent
			}
			if vals["proxyjump"] != "" || vals["proxycommand"] != "" {
				warns = append(warns, "ProxyJump/ProxyCommand não é suportado: a conexão será direta")
			}
			if vals["localforward"] != "" || vals["remoteforward"] != "" || vals["dynamicforward"] != "" {
				warns = append(warns, "redirecionamentos de porta não são importados")
			}
			h.Group = "Importados do ~/.ssh/config"
			c := SSHConfigCandidate{Alias: alias, Host: h, Warnings: warns}
			for _, e := range existing {
				if strings.EqualFold(e.Host, h.Host) && e.Port == h.Port && e.User == h.User {
					c.Exists = true
					break
				}
			}
			out = append(out, c)
		}
	}
	return out
}
