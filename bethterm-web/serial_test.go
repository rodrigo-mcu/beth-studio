//go:build windows

package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func serialTestDir(t *testing.T) string {
	t.Helper()
	d := t.TempDir()
	t.Setenv("BETHTERM_DATA_DIR", d)
	return d
}

func TestSerialProfilesCRUD(t *testing.T) {
	serialTestDir(t)
	p, err := serialUpsertProfile(SerialProfile{Port: "com7"})
	if err != nil {
		t.Fatal(err)
	}
	if p.Port != "COM7" || p.Baud != 115200 || p.DataBits != 8 || p.Parity != "none" || p.StopBits != "1" || p.Flow != "none" || p.LineEnding != "cr" || p.Name != "COM7" {
		t.Fatalf("padrões errados: %+v", p)
	}
	if !serialProfileIDRe.MatchString(p.ID) {
		t.Fatalf("id: %q", p.ID)
	}
	p.Name, p.Baud, p.Flow, p.LineEnding = "Placa", 921600, "rtscts", "crlf"
	p2, err := serialUpsertProfile(p)
	if err != nil || p2.Baud != 921600 || p2.CreatedAt != p.CreatedAt {
		t.Fatalf("update: %+v %v", p2, err)
	}
	dup, err := serialDuplicateProfile(p.ID)
	if err != nil || dup.ID == p.ID || dup.Name != "Placa (cópia)" {
		t.Fatalf("duplicar: %+v %v", dup, err)
	}
	if err := serialNoteRecent(dup.ID); err != nil {
		t.Fatal(err)
	}
	ps, rec, err := serialListProfiles()
	if err != nil || len(ps) != 2 || len(rec) != 1 || rec[0].ID != dup.ID {
		t.Fatalf("lista: %v %v %v", ps, rec, err)
	}
	if err := serialDeleteProfile(dup.ID); err != nil {
		t.Fatal(err)
	}
	if _, rec, _ := serialListProfiles(); len(rec) != 0 {
		t.Fatalf("recente de perfil apagado ficou: %v", rec)
	}
	for _, bad := range []SerialProfile{
		{Port: "COM0"}, {Port: `\\?\COM3x`}, {Port: "COM3", Baud: 10}, {Port: "COM3", DataBits: 9},
		{Port: "COM3", Parity: "x"}, {Port: "COM3", StopBits: "1.5"}, {Port: "COM3", Flow: "dtr"},
		{Port: "COM3", LineEnding: "\\n"}, {Port: "COM3", LogFile: "relativo.log"}, {Port: "COM3", Color: "red"},
	} {
		if _, err := serialNormalize(bad); err == nil {
			t.Errorf("devia recusar %+v", bad)
		}
	}
	// argv / shell id -> rotulo do tipo "Serial · …"
	label, ok := serialPortForArgv([]string{`C:\x\bethterm-tool.exe`, "--serial", p.ID})
	if !ok || label != "COM7 · Placa" {
		t.Fatalf("argv: %q %v", label, ok)
	}
	if _, ok := serialPortForArgv([]string{"cmd.exe", "--serial", p.ID}); ok {
		t.Fatal("cmd.exe não é o auxiliar")
	}
	if label, ok := serialPortForShellID("serial." + p.ID); !ok || label != "COM7 · Placa" {
		t.Fatalf("shell id: %q %v", label, ok)
	}
}

func TestSerialDCB(t *testing.T) {
	d, err := serialDCB(SerialProfile{Baud: 9600, DataBits: 7, Parity: "even", StopBits: "2", Flow: "rtscts"}, windows.DCB{})
	if err != nil {
		t.Fatal(err)
	}
	if d.BaudRate != 9600 || d.ByteSize != 7 || d.Parity != 2 || d.StopBits != 2 {
		t.Fatalf("dcb: %+v", d)
	}
	if d.Flags&dcbParity == 0 || d.Flags&dcbOutxCtsFlow == 0 || (d.Flags>>dcbRtsControlShift)&3 != rtsControlHandshake || d.Flags&dcbBinary == 0 {
		t.Fatalf("flags: %b", d.Flags)
	}
	d, _ = serialDCB(SerialProfile{Baud: 115200, DataBits: 8, Parity: "none", StopBits: "1", Flow: "xonxoff"}, windows.DCB{})
	if d.Flags&dcbParity != 0 || d.Flags&dcbOutX == 0 || d.Flags&dcbInX == 0 || d.XonChar != 0x11 || d.XoffChar != 0x13 {
		t.Fatalf("xon/xoff: %+v", d)
	}
}

// porta falsa: o que a sessao manda e recebe, sem hardware.
func TestSerialSessionFakePort(t *testing.T) {
	var screen, logb bytes.Buffer
	p := SerialProfile{LineEnding: "crlf", LocalEcho: true, Timestamps: true}
	s := newSerialSession(p, &screen, &logb)
	s.now = func() time.Time { return time.Date(2026, 1, 2, 3, 4, 5, 6_000_000, time.UTC) }

	s.fromPort([]byte("boot ok\r\nre"))
	s.fromPort([]byte("ady\n"))
	if got := logb.String(); got != "[03:04:05.006] boot ok\r\n[03:04:05.006] ready\n" {
		t.Fatalf("log: %q", got)
	}
	if !strings.Contains(screen.String(), "\x1b[90m[03:04:05.006]\x1b[0m boot ok") {
		t.Fatalf("tela: %q", screen.String())
	}
	screen.Reset()
	out, quit := s.fromKeys([]byte("AT\r"))
	if quit || string(out) != "AT\r\n" {
		t.Fatalf("envio: %q %v", out, quit)
	}
	if screen.String() != "AT\r\n" {
		t.Fatalf("eco local: %q", screen.String())
	}
	for le, want := range map[string]string{"cr": "x\r", "lf": "x\n", "crlf": "x\r\n"} {
		s := newSerialSession(SerialProfile{LineEnding: le}, &bytes.Buffer{}, nil)
		if out, _ := s.fromKeys([]byte("x\r")); string(out) != want {
			t.Errorf("%s: %q", le, out)
		}
	}
	out, quit = s.fromKeys([]byte{'a', tcCtrlBracketByte, 'b'})
	if !quit || string(out) != "a" {
		t.Fatalf("Ctrl+]: %q %v", out, quit)
	}
	// sem eco local nada vai para a tela
	var scr2 bytes.Buffer
	s3 := newSerialSession(SerialProfile{LineEnding: "cr"}, &scr2, nil)
	s3.fromKeys([]byte("abc\r"))
	if scr2.Len() != 0 {
		t.Fatalf("eco sem pedir: %q", scr2.String())
	}
	if d := serialDescribe(SerialProfile{Baud: 115200, DataBits: 8, Parity: "none", StopBits: "1", Flow: "none", LineEnding: "cr"}); d != "115200 8N1, sem controle de fluxo, Enter = CR" {
		t.Fatalf("descrição: %q", d)
	}
}

func TestSerialListPortsRuns(t *testing.T) {
	ports, err := serialListPorts()
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range ports {
		if !serialPortRe.MatchString(p.Port) {
			t.Errorf("porta estranha: %+v", p)
		}
		t.Logf("porta: %+v", p)
	}
}

func TestSerialAPIAndSpawn(t *testing.T) {
	serialTestDir(t)
	s := &server{hub: newHub(false)}
	call := func(method, path string, body any) (int, map[string]any) {
		var rd *bytes.Reader
		if body != nil {
			b, _ := json.Marshal(body)
			rd = bytes.NewReader(b)
		} else {
			rd = bytes.NewReader(nil)
		}
		req := httptest.NewRequest(method, path, rd)
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		w := httptest.NewRecorder()
		s.serveSerial(w, req)
		var out map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return w.Code, out
	}
	code, out := call("POST", "/api/serial/profiles/save", map[string]any{"profile": map[string]any{"port": "COM9", "baud": 57600}})
	if code != 200 {
		t.Fatalf("save: %d %v", code, out)
	}
	id := out["profile"].(map[string]any)["id"].(string)
	if code, out = call("GET", "/api/serial/profiles", nil); code != 200 || len(out["profiles"].([]any)) != 1 {
		t.Fatalf("list: %d %v", code, out)
	}
	if code, _ = call("GET", "/api/serial/ports", nil); code != 200 {
		t.Fatalf("ports: %d", code)
	}
	// spawn_tool: mensagem para a ponte + recentes
	msg, shell, err := toolSpawnMessage("serial", id, "r1", nil)
	if err != nil || msg["op"] != "spawn_tool" || msg["kind"] != "serial" || msg["id"] != id || shell != "serial."+id {
		t.Fatalf("spawn: %v %q %v", msg, shell, err)
	}
	if _, _, err := toolSpawnMessage("serial", "0123456789abcdef", "", nil); err == nil {
		t.Fatal("perfil inexistente devia falhar")
	}
	if _, _, err := toolSpawnMessage("cmd", id, "", nil); err == nil {
		t.Fatal("kind inválido devia falhar")
	}
	if _, _, err := toolSpawnMessage("serial", id+"&calc", "", nil); err == nil {
		t.Fatal("id com lixo devia falhar")
	}
	ro := &server{hub: newHub(true)}
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/serial/profiles/delete", strings.NewReader(`{"id":"`+id+`"}`))
	req.Header.Set("Content-Type", "application/json")
	ro.serveSerial(w, req)
	if w.Code != http.StatusForbidden {
		t.Fatalf("read-only apagou: %d", w.Code)
	}
}

// O auxiliar --serial dentro de um ConPTY: perfil apagado = mensagem e espera
// tecla; porta inexistente = espera a porta e sai com Ctrl+].
func TestSerialHelperInConPTY(t *testing.T) {
	dir := serialTestDir(t)
	env := map[string]string{"BETHTERM_DATA_DIR": dir}

	c := startHelperInConPTY(t, 90, 20, env, "--serial", "0123456789abcdef")
	c.waitFor("não existe mais", 10*time.Second)
	c.waitFor("Pressione qualquer tecla", 5*time.Second)
	c.send("x")
	if code := c.exitCode(5 * time.Second); code != 1 {
		t.Fatalf("código %d", code)
	}

	p, err := serialUpsertProfile(SerialProfile{Port: "COM249", Name: "Sem hardware", Timestamps: true})
	if err != nil {
		t.Fatal(err)
	}
	c = startHelperInConPTY(t, 90, 20, env, "--serial", p.ID)
	c.waitFor("115200 8N1", 10*time.Second)
	c.waitFor("COM249 não existe", 10*time.Second)
	c.send("\x1d")
	if code := c.exitCode(5 * time.Second); code != 0 {
		t.Fatalf("Ctrl+] código %d", code)
	}
	_ = os.Remove(serialProfilesPath())
}
