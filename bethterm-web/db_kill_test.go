package main

import (
	"sync/atomic"
	"testing"
	"time"
)

// O KILL QUERY (MySQL) só sai para uma consulta ainda rodando, e uma vez:
// depois do finish a conexão pode estar com outra consulta.
func TestDBRunningKillOnlyWhileRunning(t *testing.T) {
	var kills, cancels atomic.Int32
	wait := func(want int32) {
		t.Helper()
		for i := 0; i < 100 && kills.Load() != want; i++ {
			time.Sleep(5 * time.Millisecond)
		}
		if got := kills.Load(); got != want {
			t.Fatalf("kills = %d, queria %d", got, want)
		}
	}
	r := &dbRunning{cancel: func() { cancels.Add(1) }, kill: func() { kills.Add(1) }}
	r.stop()
	r.stop()
	wait(1)
	if cancels.Load() != 2 {
		t.Fatalf("cancel: %d", cancels.Load())
	}

	kills.Store(0)
	done := &dbRunning{cancel: func() {}, kill: func() { kills.Add(1) }}
	done.finish()
	done.stop()
	time.Sleep(30 * time.Millisecond)
	if kills.Load() != 0 {
		t.Fatal("matou depois de terminar")
	}
}
