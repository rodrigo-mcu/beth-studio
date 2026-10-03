package main

import (
	"os"
	"reflect"
	"strings"
	"testing"
	"unicode/utf16"
)

func TestSysmonPIDList(t *testing.T) {
	if got := parsePIDList("12, 7,x,0,12,-3,4294967295,99999999999"); !reflect.DeepEqual(got, []uint32{12, 7, 4294967295}) {
		t.Fatalf("parsePIDList = %v", got)
	}
	if got := formatPIDList([]uint32{1, 22, 333}); got != "1,22,333" {
		t.Fatalf("formatPIDList = %q", got)
	}
	many := make([]string, 100)
	for i := range many {
		many[i] = formatPIDList([]uint32{uint32(i + 1)})
	}
	if n := len(parsePIDList(strings.Join(many, ","))); n != maxTitlePIDs {
		t.Fatalf("limite = %d", n)
	}
}

func TestSysmonTitleLines(t *testing.T) {
	out := `{"pid":10,"title":"Windows PowerShell"}
{"pid":11,"title":"✳ Claude Code"}
{"pid":99,"title":"nao pedido"}
{"pid":12,"tit` // auxiliar morreu no meio
	got := parseConsoleTitleLines(out, []uint32{10, 11, 12})
	want := map[uint32]string{10: "Windows PowerShell", 11: "✳ Claude Code"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v", got)
	}
}

func TestSysmonWSLRunningNames(t *testing.T) {
	enc := func(s string) []byte {
		u := utf16.Encode([]rune(string(rune(0xFEFF)) + s))
		b := make([]byte, 0, len(u)*2)
		for _, c := range u {
			b = append(b, byte(c), byte(c>>8))
		}
		return b
	}
	if got := parseWSLRunningNames(enc("Ubuntu\r\ndocker-desktop\r\n")); !reflect.DeepEqual(got, []string{"Ubuntu", "docker-desktop"}) {
		t.Fatalf("utf16 = %v", got)
	}
	if got := parseWSLRunningNames(enc("Não há distribuições em execução.\r\n")); len(got) != 0 {
		t.Fatalf("frase virou nome: %v", got)
	}
	if got := parseWSLRunningNames([]byte("Ubuntu\n")); !reflect.DeepEqual(got, []string{"Ubuntu"}) {
		t.Fatalf("utf8 = %v", got)
	}
}

// O processo principal nunca anexa a console de terminal: AttachConsole so'
// aparece dentro do corpo do auxiliar (consoleTitlesHelperMain).
func TestSysmonNoAttachInMainProcess(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		b, _ := os.ReadFile(name)
		src := string(b)
		for i := 0; ; {
			k := strings.Index(src[i:], "smAttachConsole.Call")
			if k < 0 {
				break
			}
			at := i + k
			fn := strings.LastIndex(src[:at], "\nfunc ")
			if name != "sysmon_windows.go" || fn < 0 || !strings.HasPrefix(src[fn+1:], "func consoleTitlesHelperMain(") {
				t.Fatalf("%s: AttachConsole fora do processo auxiliar", name)
			}
			i = at + 1
		}
	}
	b, _ := os.ReadFile("main.go")
	if !strings.Contains(string(b), "os.Args[1] == consoleTitlesFlag") {
		t.Fatal("main.go nao despacha --console-titles")
	}
}
