package main

import (
	"reflect"
	"testing"
)

type fakeTerm struct{ focused, killed int }

func (f *fakeTerm) Focus() { f.focused++ }
func (f *fakeTerm) Kill()  { f.killed++ }

func TestTermRegistryAddDuplicateFocusesExisting(t *testing.T) {
	r := newTermRegistry(nil)
	a, b := &fakeTerm{}, &fakeTerm{}
	if r.Add(7, a) {
		t.Fatal("primeiro Add não pode ser duplicata")
	}
	if !r.Add(7, b) {
		t.Fatal("segundo Add do mesmo pane deve ser duplicata")
	}
	if a.focused != 1 || b.focused != 0 {
		t.Fatalf("deveria focar só a janela original: a=%d b=%d", a.focused, b.focused)
	}
}

func TestTermRegistryRemoveNotifies(t *testing.T) {
	var got [][]int
	r := newTermRegistry(func(p []int) { got = append(got, p) })
	r.Add(9, &fakeTerm{})
	r.Add(3, &fakeTerm{})
	if !r.Remove(9) {
		t.Fatal("Remove do pane existente deve devolver true")
	}
	if r.Remove(9) {
		t.Fatal("Remove repetido deve devolver false")
	}
	want := [][]int{{9}, {3, 9}, {3}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("notificações = %v, quero %v", got, want)
	}
	if r.Has(9) || !r.Has(3) {
		t.Fatal("Has inconsistente")
	}
}

func TestTermRegistryCloseAll(t *testing.T) {
	r := newTermRegistry(nil)
	a, b := &fakeTerm{}, &fakeTerm{}
	r.Add(1, a)
	r.Add(2, b)
	r.CloseAll()
	if a.killed != 1 || b.killed != 1 {
		t.Fatalf("CloseAll deve encerrar as duas janelas: %d %d", a.killed, b.killed)
	}
}
