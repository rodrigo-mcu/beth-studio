//go:build windows

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Teste de integração do controle do host, só com um host DE TESTE: precisa de
// BETHTERM_IT_HOST_EXE apontando para uma cópia do bethterm-host.exe. Usa um
// BETHTERM_HOST_ID único (outro mutex, outro evento de saída, outros arquivos)
// e um diretório de dados temporário curto, então nunca enxerga o host do usuário.
//
//	set BETHTERM_IT_HOST_EXE=C:\bs-t1\app\bethterm-host.exe
//	go test -run HostCtlIntegration .
func TestHostCtlIntegrationStartAndQuit(t *testing.T) {
	exe := os.Getenv("BETHTERM_IT_HOST_EXE")
	if exe == "" {
		t.Skip("defina BETHTERM_IT_HOST_EXE com uma cópia do bethterm-host.exe para rodar")
	}
	id := fmt.Sprintf("it%d", os.Getpid())
	data, err := os.MkdirTemp("", "bsit")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(data)
	t.Setenv("BETHTERM_HOST_ID", id)
	// o host Rust usa %APPDATA%\bethterm; o Go lê o mesmo lugar (dataDir)
	t.Setenv("BETHTERM_DATA_DIR", "")
	t.Setenv("APPDATA", data)
	t.Setenv("BETHTERM_HOST_EXE", exe)
	if hostID() == "" || hostMutex() == hostMutexName {
		t.Fatal("trava de segurança: sem id de host este teste enxergaria o host do usuário")
	}

	ctl := newHostCtl()
	if ctl.Running() {
		t.Fatal("o host de teste não deveria existir ainda")
	}
	if err := ctl.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if !ctl.Running() {
		t.Fatal("depois do Start o host de teste deveria estar rodando")
	}
	if _, err := os.Stat(hostSockPath()); err != nil {
		t.Fatalf("host.sock do host de teste ausente: %v", err)
	}
	if err := ctl.Start(); err != nil {
		t.Fatalf("Start com o host já rodando deve ser um não-evento: %v", err)
	}

	if err := ctl.RequestQuit("teste de integração"); err != nil {
		t.Fatalf("RequestQuit: %v", err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for ctl.Running() && time.Now().Before(deadline) {
		time.Sleep(100 * time.Millisecond)
	}
	if ctl.Running() {
		t.Fatal("o host de teste não saiu depois do pedido")
	}
	// o host apaga o quit-request depois de ler e registra quem pediu
	if _, err := os.Stat(quitRequestPath()); err == nil {
		t.Log("quit-request ainda existe (o host pode ter saído antes de apagá-lo)")
	}
	_ = filepath.Join(data, "x")
}
