package main

import (
	"reflect"
	"testing"
)

func TestAgentEnvToDrop(t *testing.T) {
	env := []string{
		"NO_COLOR=1",
		"CLAUDECODE=1",
		"CLAUDE_CODE_MESSAGING_TOKEN=segredo",
		"CLAUDE_CODE_USE_BEDROCK=1",
		"GIT_EDITOR=true",
		"PATH=/usr/bin",
		"TERM=xterm-256color",
		"COLORTERM=truecolor",
		"WSLENV=x",
	}
	// CLAUDE_CODE_USE_BEDROCK salvo no Windows pela pessoa: fica.
	got := agentEnvToDrop(env, map[string]bool{"CLAUDE_CODE_USE_BEDROCK": true})
	want := []string{"CLAUDECODE", "CLAUDE_CODE_MESSAGING_TOKEN", "GIT_EDITOR", "NO_COLOR"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestAgentEnvKeepsUserNoColor(t *testing.T) {
	if got := agentEnvToDrop([]string{"NO_COLOR=1"}, map[string]bool{"NO_COLOR": true}); len(got) != 0 {
		t.Fatalf("NO_COLOR salvo pela pessoa saiu: %v", got)
	}
}
