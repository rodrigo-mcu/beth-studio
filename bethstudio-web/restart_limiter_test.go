package main

import (
	"testing"
	"time"
)

func TestRestartLimiterAllowsThreeInWindow(t *testing.T) {
	l := newRestartLimiter(3, 10*time.Minute)
	t0 := time.Date(2026, 10, 3, 12, 0, 0, 0, time.UTC)
	for i := 0; i < 3; i++ {
		if !l.Allow(t0.Add(time.Duration(i) * time.Minute)) {
			t.Fatalf("o reinício %d deveria ser permitido", i+1)
		}
	}
	if l.Allow(t0.Add(3 * time.Minute)) {
		t.Fatal("o 4º reinício dentro de 10 min deveria ser negado")
	}
}

func TestRestartLimiterWindowSlides(t *testing.T) {
	l := newRestartLimiter(3, 10*time.Minute)
	t0 := time.Date(2026, 10, 3, 12, 0, 0, 0, time.UTC)
	for i := 0; i < 3; i++ {
		l.Allow(t0)
	}
	if l.Allow(t0.Add(9 * time.Minute)) {
		t.Fatal("ainda dentro da janela: deveria negar")
	}
	if !l.Allow(t0.Add(10*time.Minute + time.Second)) {
		t.Fatal("passada a janela: deveria permitir de novo")
	}
}

func TestRestartLimiterDeniedAttemptDoesNotExtendTheWindow(t *testing.T) {
	l := newRestartLimiter(3, 10*time.Minute)
	t0 := time.Date(2026, 10, 3, 12, 0, 0, 0, time.UTC)
	for i := 0; i < 3; i++ {
		l.Allow(t0)
	}
	for i := 0; i < 20; i++ { // tentativas negadas não contam
		l.Allow(t0.Add(time.Duration(i) * 20 * time.Second))
	}
	if !l.Allow(t0.Add(10*time.Minute + time.Second)) {
		t.Fatal("tentativas negadas não podem empurrar o fim da janela")
	}
}

func TestRestartLimiterResetAndRetryAt(t *testing.T) {
	l := newRestartLimiter(2, 10*time.Minute)
	t0 := time.Date(2026, 10, 3, 12, 0, 0, 0, time.UTC)
	if !l.RetryAt(t0).IsZero() {
		t.Fatal("sem uso, RetryAt deve ser zero")
	}
	l.Allow(t0)
	l.Allow(t0.Add(2 * time.Minute))
	if got, want := l.RetryAt(t0.Add(3*time.Minute)), t0.Add(10*time.Minute); !got.Equal(want) {
		t.Fatalf("RetryAt = %v, quero %v (quando o mais antigo sai da janela)", got, want)
	}
	l.Reset()
	if !l.Allow(t0.Add(3 * time.Minute)) {
		t.Fatal("depois do Reset deve permitir")
	}
	if !l.RetryAt(t0.Add(3 * time.Minute)).IsZero() {
		t.Fatal("com espaço livre, RetryAt deve ser zero")
	}
}
