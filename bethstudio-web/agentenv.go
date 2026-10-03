package main

// agentenv.go: o Studio não repassa a sessão de um agente para os terminais.
//
// O bridge cria cada terminal com o ambiente deste processo (portable_pty
// CommandBuilder copia os.Environ). Quando um agente (Claude Code, Codex)
// reabre o bethstudio-web.exe, o ambiente dele vem junto: NO_COLOR=1 deixava
// o Claude Code do terminal novo sem cor nenhuma, e as CLAUDE_CODE_* (com o
// token de mensagens da sessão) iam parar em terminais que não são dela.
// Visto em 2026-09-27. Só sai o que não está salvo nas variáveis do Windows
// (Usuário ou Máquina): o que a pessoa configurou de propósito fica.

import (
	"os"
	"sort"
	"strings"
)

var agentEnvNames = map[string]bool{
	"NO_COLOR":                           true,
	"FORCE_COLOR":                        true,
	"AI_AGENT":                           true,
	"CLAUDECODE":                         true,
	"CLAUDE_PID":                         true,
	"GIT_EDITOR":                         true,
	"GIT_TERMINAL_PROMPT":                true,
	"GIT_ASKPASS":                        true,
	"GCM_INTERACTIVE":                    true,
	"COREPACK_ENABLE_AUTO_PIN":           true,
	"NODEFAULTCURRENTDIRECTORYINEXEPATH": true,
	"PSEXECUTIONPOLICYPREFERENCE":        true,
}

var agentEnvPrefixes = []string{"CLAUDE_CODE_", "CODEX_"}

func isAgentEnv(name string) bool {
	n := strings.ToUpper(name)
	if agentEnvNames[n] {
		return true
	}
	for _, p := range agentEnvPrefixes {
		if strings.HasPrefix(n, p) {
			return true
		}
	}
	return false
}

// agentEnvToDrop: nomes de sessão de agente presentes em env que não estão
// salvos pela pessoa (persistent, nomes em maiúsculas).
func agentEnvToDrop(env []string, persistent map[string]bool) []string {
	var out []string
	for _, kv := range env {
		name, _, ok := strings.Cut(kv, "=")
		if !ok || name == "" {
			continue
		}
		if isAgentEnv(name) && !persistent[strings.ToUpper(name)] {
			out = append(out, name)
		}
	}
	sort.Strings(out)
	return out
}

// dropAgentEnv tira do processo as variáveis de sessão de agente. Devolve os
// nomes (nunca os valores) para o log.
func dropAgentEnv() []string {
	names := agentEnvToDrop(os.Environ(), persistentEnvNames())
	for _, n := range names {
		_ = os.Unsetenv(n)
	}
	return names
}
