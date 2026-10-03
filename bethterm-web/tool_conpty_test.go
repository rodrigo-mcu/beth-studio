//go:build windows

package main

// tool_conpty_test.go â€” roda os auxiliares --ssh/--serial dentro de um
// pseudo console (ConPTY) criado pelo proprio teste, como o host faz: o
// binario de teste e' um exe de console, e o init() abaixo o transforma no
// auxiliar quando BETHTERM_TOOL_TEST_HELPER=1.

import (
	"os"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"
)

func init() {
	if os.Getenv("BETHTERM_TOOL_TEST_HELPER") == "1" {
		args := strings.Fields(os.Getenv("BETHTERM_TOOL_TEST_ARGS"))
		code, ok := toolHelperMain(args)
		if !ok {
			code = 99
		}
		os.Exit(code)
	}
}

type conpty struct {
	t    *testing.T
	hpc  windows.Handle
	inW  windows.Handle
	outR windows.Handle
	proc windows.Handle

	mu  sync.Mutex
	out []byte
}

var toolTestAnsiRe = regexp.MustCompile(`\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][0-9A-Za-z]|\x1b[=>]`)

// startHelperInConPTY: o binario de teste como auxiliar, num ConPTY cols x rows.
func startHelperInConPTY(t *testing.T, cols, rows int, env map[string]string, args ...string) *conpty {
	t.Helper()
	var inR, inW, outR, outW windows.Handle
	if err := windows.CreatePipe(&inR, &inW, nil, 0); err != nil {
		t.Fatal(err)
	}
	if err := windows.CreatePipe(&outR, &outW, nil, 0); err != nil {
		t.Fatal(err)
	}
	c := &conpty{t: t, inW: inW, outR: outR}
	if err := windows.CreatePseudoConsole(windows.Coord{X: int16(cols), Y: int16(rows)}, inR, outW, 0, &c.hpc); err != nil {
		t.Fatal(err)
	}
	windows.CloseHandle(inR)
	windows.CloseHandle(outW)

	attrs, err := windows.NewProcThreadAttributeList(1)
	if err != nil {
		t.Fatal(err)
	}
	defer attrs.Delete()
	if err := attrs.Update(windows.PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, unsafe.Pointer(c.hpc), unsafe.Sizeof(c.hpc)); err != nil {
		t.Fatal(err)
	}
	si := &windows.StartupInfoEx{ProcThreadAttributeList: attrs.List()}
	si.Cb = uint32(unsafe.Sizeof(*si))
	si.Flags = windows.STARTF_USESTDHANDLES
	si.StdInput, si.StdOutput, si.StdErr = windows.InvalidHandle, windows.InvalidHandle, windows.InvalidHandle

	exe, _ := os.Executable()
	cmdline, _ := windows.UTF16PtrFromString(syscall.EscapeArg(exe))
	full := map[string]string{}
	for _, kv := range os.Environ() {
		if i := strings.IndexByte(kv, '='); i > 0 {
			full[kv[:i]] = kv[i+1:]
		}
	}
	for k, v := range env {
		full[k] = v
	}
	full["BETHTERM_TOOL_TEST_HELPER"] = "1"
	full["BETHTERM_TOOL_TEST_ARGS"] = strings.Join(args, " ")
	var block []uint16
	for k, v := range full {
		block = append(block, utf16.Encode([]rune(k+"="+v))...)
		block = append(block, 0)
	}
	block = append(block, 0)

	var pi windows.ProcessInformation
	flags := uint32(windows.EXTENDED_STARTUPINFO_PRESENT | windows.CREATE_UNICODE_ENVIRONMENT)
	if err := windows.CreateProcess(nil, cmdline, nil, nil, false, flags, &block[0], nil, &si.StartupInfo, &pi); err != nil {
		t.Fatal(err)
	}
	windows.CloseHandle(pi.Thread)
	c.proc = pi.Process
	go func() {
		buf := make([]byte, 8192)
		for {
			var n uint32
			if err := windows.ReadFile(c.outR, buf, &n, nil); err != nil || n == 0 {
				return
			}
			c.mu.Lock()
			c.out = append(c.out, buf[:n]...)
			c.mu.Unlock()
		}
	}()
	t.Cleanup(c.close)
	return c
}

func (c *conpty) text() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return toolTestAnsiRe.ReplaceAllString(string(c.out), "")
}

// waitFor espera o texto aparecer na tela (sem sequencias de escape).
func (c *conpty) waitFor(substr string, d time.Duration) {
	c.t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if strings.Contains(strings.ReplaceAll(c.text(), "\r\n", "\n"), substr) {
			return
		}
		time.Sleep(30 * time.Millisecond)
	}
	c.t.Fatalf("nÃ£o apareceu %q na tela; tela atÃ© agora:\n%s", substr, c.text())
}

func (c *conpty) send(s string) {
	c.t.Helper()
	var n uint32
	if err := windows.WriteFile(c.inW, []byte(s), &n, nil); err != nil {
		c.t.Fatal(err)
	}
}

func (c *conpty) resize(cols, rows int) {
	c.t.Helper()
	if err := windows.ResizePseudoConsole(c.hpc, windows.Coord{X: int16(cols), Y: int16(rows)}); err != nil {
		c.t.Fatal(err)
	}
}

// exitCode espera o processo terminar.
func (c *conpty) exitCode(d time.Duration) int {
	c.t.Helper()
	ev, err := windows.WaitForSingleObject(c.proc, uint32(d/time.Millisecond))
	if err != nil || ev != windows.WAIT_OBJECT_0 {
		c.t.Fatalf("o auxiliar nÃ£o terminou em %s; tela:\n%s", d, c.text())
	}
	var code uint32
	_ = windows.GetExitCodeProcess(c.proc, &code)
	return int(code)
}

func (c *conpty) close() {
	if c.proc != 0 {
		if ev, _ := windows.WaitForSingleObject(c.proc, 0); ev != windows.WAIT_OBJECT_0 {
			_ = windows.TerminateProcess(c.proc, 1) // so' o processo que o teste criou
		}
		windows.CloseHandle(c.proc)
		c.proc = 0
	}
	if c.hpc != 0 {
		windows.ClosePseudoConsole(c.hpc)
		c.hpc = 0
	}
	windows.CloseHandle(c.inW)
	windows.CloseHandle(c.outR)
}
