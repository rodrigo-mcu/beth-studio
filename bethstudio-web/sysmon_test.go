package main

import (
	"encoding/json"
	"testing"
	"unicode/utf16"
)

func TestSysmonNormalizeTitle(t *testing.T) {
	cases := map[string]string{
		"✳ Claude Code":                     "claude code",
		"  ⏺  Claude   Code ":               "claude code",
		"⠋ Refatorar módulo":                "refatorar módulo",
		"◐ build":                           "build",
		"Administrador: Windows PowerShell": "windows powershell",
		"C:\\WINDOWS\\system32\\cmd.exe":    "cmd",
		"claude.exe":                        "claude",
		"node.exe watch":                    "node.exe watch",
		"":                                  "",
	}
	for in, want := range cases {
		if got := normalizeTitle(in); got != want {
			t.Errorf("normalizeTitle(%q) = %q, want %q", in, got, want)
		}
	}
}

// Arvore falsa: host(100) -> OpenConsole + shells; shells com descendentes.
func fakeTree() ([]*procInfo, *procInfo) {
	ps := []*procInfo{
		{PID: 100, PPID: 1, Name: "bethstudio-host.exe", Created: 10, PrivateWS: 50 << 20},
		{PID: 201, PPID: 100, Name: "OpenConsole.exe", Created: 20, PrivateWS: 5 << 20},
		{PID: 202, PPID: 100, Name: "powershell.exe", Created: 21, PrivateWS: 60 << 20, CPU: 1},
		{PID: 203, PPID: 202, Name: "claude.exe", Created: 30, PrivateWS: 300 << 20, CPU: 4},
		{PID: 204, PPID: 203, Name: "node.exe", Created: 31, PrivateWS: 100 << 20, CPU: 2},
		{PID: 211, PPID: 100, Name: "OpenConsole.exe", Created: 40, PrivateWS: 5 << 20},
		{PID: 212, PPID: 100, Name: "wsl.exe", Created: 41, PrivateWS: 3 << 20},
		{PID: 213, PPID: 212, Name: "wsl.exe", Created: 42, PrivateWS: 2 << 20},
		{PID: 221, PPID: 100, Name: "OpenConsole.exe", Created: 50},
		{PID: 222, PPID: 100, Name: "cmd.exe", Created: 51, PrivateWS: 4 << 20},
		// PID reciclado: "pai" criado depois do filho nao conta.
		{PID: 300, PPID: 222, Name: "orfao.exe", Created: 5},
		{PID: 400, PPID: 1, Name: "bethterm-gui.exe", Created: 11, PrivateWS: 200 << 20},
		{PID: 500, PPID: 400, Name: "bethstudio-web.exe", Created: 60, PrivateWS: 30 << 20},
		{PID: 501, PPID: 500, Name: "bethstudio.exe", Created: 61, PrivateWS: 10 << 20},
		{PID: 502, PPID: 500, Name: "msedgewebview2.exe", Created: 62, PrivateWS: 80 << 20},
		{PID: 503, PPID: 502, Name: "msedgewebview2.exe", Created: 63, PrivateWS: 40 << 20},
	}
	return ps, ps[0]
}

func TestSysmonTreeAndTerminals(t *testing.T) {
	ps, host := fakeTree()
	tree := buildTree(ps)
	if n := len(tree.subtree(ps[2])); n != 3 {
		t.Fatalf("subtree(powershell) = %d, want 3", n)
	}
	if n := len(tree.subtree(ps[9])); n != 1 {
		t.Fatalf("pid reciclado entrou na arvore: %d", n)
	}
	panes := []PaneLite{
		{ID: 3, Title: "✻ Claude Code", Kind: "powershell"},
		{ID: 5, Title: "user@pc: ~", Kind: "wsl"},
		{ID: 9, Title: "sem shell", Kind: "cmd"},
		{ID: 10, Title: "outro sem shell", Kind: "cmd"},
	}
	titles := map[procKey]string{
		ps[2].key(): "✳ Claude Code", // aproximado (glifo mudou)
		ps[6].key(): "user@pc: ~",    // exato
		ps[9].key(): "outra coisa",   // sem par
	}
	ts, sum, stable := buildTerminals(tree, host, panes, titles, nil)
	if sum.Shells != 3 || sum.Exact != 1 || sum.Approx != 1 || sum.Unmatched != 1 {
		t.Fatalf("resumo inesperado: %+v", sum)
	}
	byPane := map[int]TermStat{}
	var unmatched []TermStat
	for _, x := range ts {
		if x.PaneID != nil {
			byPane[*x.PaneID] = x
		} else {
			unmatched = append(unmatched, x)
		}
	}
	cl := byPane[3]
	if cl.Match != "aproximado" || cl.Procs != 3 || cl.PrivateWS != 460<<20 || cl.CPU != 7 {
		t.Fatalf("pane 3: %+v", cl)
	}
	if len(cl.Top) != 3 || cl.Top[0].Name != "claude.exe" {
		t.Fatalf("top do pane 3: %+v", cl.Top)
	}
	if w := byPane[5]; w.Match != "exato" || w.Note == "" || w.Procs != 2 {
		t.Fatalf("pane 5: %+v", w)
	}
	if byPane[9].Match != "sem_processo" {
		t.Fatalf("pane 9: %+v", byPane[9])
	}
	if len(unmatched) != 1 || unmatched[0].ShellPID != 222 || unmatched[0].Match != "nao_associado" {
		t.Fatalf("nao associados: %+v", unmatched)
	}
	if len(stable) != 2 {
		t.Fatalf("estaveis = %d, want 2", len(stable))
	}
	// Proxima rodada: associacoes estaveis valem mesmo sem titulo.
	ts2, sum2, _ := buildTerminals(tree, host, panes, map[procKey]string{}, stable)
	if sum2.Exact != 1 || sum2.Approx != 1 {
		t.Fatalf("estaveis perdidos: %+v %+v", sum2, ts2)
	}
}

func TestSysmonMatchDuplicatesAndOrder(t *testing.T) {
	k := func(pid uint32, c int64) procKey { return procKey{pid, c} }
	shells := []shellCand{
		{Key: k(1, 10), Created: 10, Title: "✳ Claude Code"},
		{Key: k(2, 20), Created: 20, Title: "⏺ Claude Code"},
		{Key: k(3, 30), Created: 30, Title: ""},
		{Key: k(4, 40), Created: 40, Title: ""},
	}
	panes := []PaneLite{
		{ID: 7, Title: "✻ Claude Code"},
		{ID: 8, Title: "✳ Claude Code"}, // exato com o shell 1? nao: dois panes com glifos diferentes
		{ID: 12, Title: "a"},
		{ID: 11, Title: "b"},
	}
	m := matchShells(shells, panes)
	// shell 1 tem titulo exato igual ao pane 8 (unico dos dois lados).
	if m[k(1, 10)] != (paneMatch{8, "exato"}) {
		t.Fatalf("shell1: %+v", m[k(1, 10)])
	}
	if m[k(2, 20)] != (paneMatch{7, "aproximado"}) {
		t.Fatalf("shell2: %+v", m[k(2, 20)])
	}
	// sobras sem titulo: pareadas por ordem (criacao x id).
	if m[k(3, 30)] != (paneMatch{11, "ordem"}) || m[k(4, 40)] != (paneMatch{12, "ordem"}) {
		t.Fatalf("ordem: %+v %+v", m[k(3, 30)], m[k(4, 40)])
	}

	// Grupo repetido: dois shells e dois panes "Claude Code" -> por ordem.
	shells2 := []shellCand{
		{Key: k(5, 50), Created: 50, Title: "✳ Claude Code"},
		{Key: k(6, 60), Created: 60, Title: "✳ Claude Code"},
	}
	panes2 := []PaneLite{{ID: 21, Title: "✻ Claude Code"}, {ID: 20, Title: "✻ Claude Code"}}
	m2 := matchShells(shells2, panes2)
	if m2[k(5, 50)] != (paneMatch{20, "aproximado"}) || m2[k(6, 60)] != (paneMatch{21, "aproximado"}) {
		t.Fatalf("grupo: %+v", m2)
	}

	// Sobras desiguais: nada por ordem.
	// Sobras iguais, com titulos diferentes: por ordem (estimado).
	m4 := matchShells([]shellCand{{Key: k(9, 1), Created: 1, Title: "claude"}}, []PaneLite{{ID: 5, Title: "claude.exe"}})
	if m4[k(9, 1)] != (paneMatch{5, "aproximado"}) {
		t.Fatalf("claude.exe: %+v", m4)
	}
	m5 := matchShells([]shellCand{{Key: k(9, 1), Created: 1, Title: "x"}}, []PaneLite{{ID: 5, Title: "y"}})
	if m5[k(9, 1)] != (paneMatch{5, "ordem"}) {
		t.Fatalf("ordem: %+v", m5)
	}
	m3 := matchShells([]shellCand{{Key: k(9, 1), Created: 1}}, []PaneLite{{ID: 1}, {ID: 2}})
	if len(m3) != 0 {
		t.Fatalf("nao devia associar: %+v", m3)
	}
}

func TestSysmonBethStudioRows(t *testing.T) {
	ps, host := fakeTree()
	rows := buildBethStudio(buildTree(ps), ps, host)
	roles := map[string]BethProc{}
	for _, r := range rows {
		roles[r.Role] = r
	}
	for _, want := range []string{"host", "consoles", "gui", "web", "bridge", "webview"} {
		if _, ok := roles[want]; !ok {
			t.Fatalf("falta %s: %+v", want, rows)
		}
	}
	if roles["consoles"].Count != 3 || roles["webview"].Count != 2 || roles["webview"].PrivateWS != 120<<20 {
		t.Fatalf("agregados: %+v %+v", roles["consoles"], roles["webview"])
	}
}

func utf16le(s string, bom bool) []byte {
	var b []byte
	if bom {
		b = append(b, 0xFF, 0xFE)
	}
	for _, u := range utf16.Encode([]rune(s)) {
		b = append(b, byte(u), byte(u>>8))
	}
	return b
}

func TestSysmonParseWSLList(t *testing.T) {
	en := "  NAME            STATE           VERSION\r\n* Debian          Running         2\r\n  Ubuntu-22.04    Stopped         2\r\n  docker-desktop  Running         2\r\n"
	for _, in := range [][]byte{utf16le(en, false), utf16le(en, true), []byte(en)} {
		d := parseWSLList(in)
		if len(d) != 3 {
			t.Fatalf("distros = %+v", d)
		}
		if !d[0].Default || d[0].Name != "Debian" || !d[0].Running || d[0].Version != 2 {
			t.Fatalf("Debian: %+v", d[0])
		}
		if d[1].Running || d[1].Name != "Ubuntu-22.04" || d[1].Default {
			t.Fatalf("Ubuntu: %+v", d[1])
		}
		if !d[2].Running {
			t.Fatalf("docker: %+v", d[2])
		}
	}
	pt := "  NOME      ESTADO           VERSÃO\r\n* Ubuntu    Em execução      2\r\n  Debian    Parado           1\r\n"
	d := parseWSLList(utf16le(pt, false))
	if len(d) != 2 || !d[0].Running || d[0].State != "Em execução" || d[1].Running || d[1].Version != 1 {
		t.Fatalf("pt-BR: %+v", d)
	}
}

func TestSysmonParseDistroProbe(t *testing.T) {
	out := `               total        used        free      shared  buff/cache   available
Mem:     33653080064 10100850688 23749730304      921600  1427623936 23552229376
Swap:    17179865088  5777952768 11401912320
Filesystem     1B-blocks         Used    Available Use% Mounted on
/dev/sdd       1081101176832 45678901248 980000000000  5% /
0.28 0.86 1.07 2/1736 3458350
Filename				Type		Size		Used		Priority
/dev/zram0                              partition	16777212	2983936		100
/swapfile                               file		16777212	0		10
ZRAM zram0 3055542272 651342547 723316736 7516192768 2522202112 25969 45793190 2510 446881
    PID   RSS %CPU     ELAPSED COMMAND
3447249 765392 2.4       11:13 MainThread
4089868 324992 1.0  1-20:35:54 claude
    12   1024 0.0    03:43:32 kworker/u8:1 extra
`
	mem, disk, load, ps := parseDistroProbe(out)
	if mem == nil || mem.Total != 33653080064 || mem.Used != 10100850688 || mem.Available != 23552229376 || mem.SwapUsed != 5777952768 || mem.BuffCache != 1427623936 {
		t.Fatalf("mem: %+v", mem)
	}
	if len(mem.Swaps) != 2 || mem.Swaps[0].Kind != "zram" || mem.Swaps[0].Size != 16777212*1024 || mem.Swaps[0].Used != 2983936*1024 ||
		mem.Swaps[0].Prio != 100 || mem.Swaps[0].ZramPhys != 723316736 || mem.Swaps[0].ZramLimit != 7516192768 ||
		mem.Swaps[1].Kind != "file" || mem.Swaps[1].Name != "/swapfile" || mem.Swaps[1].ZramPhys != 0 || mem.Swaps[1].Prio != 10 {
		t.Fatalf("swaps: %+v", mem.Swaps)
	}
	if len(load) != 3 || load[0] != 0.28 || load[2] != 1.07 {
		t.Fatalf("load: %v", load)
	}
	if len(ps) != 3 || ps[0].PID != 3447249 || ps[0].RSS != 765392*1024 || ps[0].PCPU != 2.4 || ps[1].Comm != "claude" || ps[1].Elapsed != "1-20:35:54" || ps[2].Comm != "kworker/u8:1 extra" {
		t.Fatalf("ps: %+v", ps)
	}
	if disk == nil || disk.Mount != "/" || disk.Total != 1081101176832 || disk.Used != 45678901248 || disk.Avail != 980000000000 {
		t.Fatalf("disk: %+v", disk)
	}
	// df em blocos de 1K (fallback sem -B1).
	_, disk, _, _ = parseDistroProbe("Filesystem 1024-blocks Used Available Use% Mounted on\n/dev/sdd 1000 400 600 40% /\n")
	if disk == nil || disk.Used != 400*1024 || disk.Total != 1000*1024 {
		t.Fatalf("disk 1K: %+v", disk)
	}
	// busybox sem --sort: so' o que der para ler, sem panico.
	mem, disk, load, ps = parseDistroProbe("sh: free: not found\nlixo\n")
	if mem != nil || disk != nil || load != nil || len(ps) != 0 {
		t.Fatalf("lixo virou dado: %+v %v %v %v", mem, disk, load, ps)
	}
}

func TestSysmonWSLUsage(t *testing.T) {
	vm := &ProcStat{WS: 8 << 30, CPU: 12.34}
	distros := []WSLDistro{
		{Name: "docker-desktop", Running: true, Disk: &LinuxDisk{Used: 1 << 30, Total: 2 << 30}, Mem: &LinuxMem{Used: 1 << 30, Total: 4 << 30}},
		{Name: "Debian", Running: true, Default: true, Disk: &LinuxDisk{Used: 40 << 30, Total: 100 << 30}, Mem: &LinuxMem{Used: 10 << 30, Total: 32 << 30}},
		{Name: "Ubuntu", Running: false, Disk: &LinuxDisk{Used: 9 << 30, Total: 10 << 30}, Mem: &LinuxMem{Used: 9 << 30, Total: 10 << 30}},
	}
	u := wslUsage(vm, distros)
	if u.RAMBytes != 8<<30 || !u.RAMKnown || u.RAMUsed != 10<<30 || u.RAMReserved != 32<<30 || u.RAMPct != 31.3 || u.CPU != 12.3 || !u.DiskKnown || u.DiskDistro != "Debian" || u.DiskPct != 40 {
		t.Fatalf("usage: %+v", u)
	}
	// sem padrao: ignora docker se houver outra distro
	distros[1].Default = false
	if _, _, name, ok := pickWSLDisk(distros); !ok || name != "Debian" {
		t.Fatalf("escolheu %q ok=%v", name, ok)
	}
	// so' auxiliar
	only := []WSLDistro{{Name: "docker-desktop", Running: true, Disk: &LinuxDisk{Used: 1, Total: 2}}}
	if _, _, name, ok := pickWSLDisk(only); !ok || name != "docker-desktop" {
		t.Fatalf("auxiliar: %q ok=%v", name, ok)
	}
	hist := appendWSLHistory(nil, WSLPoint{RAM: 1.26, CPU: 0, Disk: 10, DiskOK: false}, 2)
	hist = appendWSLHistory(hist, WSLPoint{RAM: 2, RAMOK: true, CPU: 3.44, Disk: 40.04, DiskOK: true}, 2)
	hist = appendWSLHistory(hist, WSLPoint{RAM: 3, RAMOK: true, CPU: 4, Disk: 41, DiskOK: true}, 2)
	if len(hist) != 2 || hist[0].RAM != 2 || !hist[0].RAMOK || !hist[0].DiskOK || hist[0].Disk != 40 || hist[1].RAM != 3 || hist[0].CPU != 3.4 {
		t.Fatalf("hist: %+v", hist)
	}
}

func TestSysmonParseNvidiaAndGPU(t *testing.T) {
	g := parseNvidiaSmi("NVIDIA GeForce RTX 3060, 54, 12288, 2048, 17\r\n")
	if len(g) != 1 || g[0].Name != "NVIDIA GeForce RTX 3060" || g[0].TempC != 54 || g[0].MemTotal != 12288<<20 || g[0].MemUsed != 2048<<20 || g[0].Util != 17 {
		t.Fatalf("nvidia: %+v", g)
	}
	eng := []gpuEngineSample{
		{"pid_10_luid_0x00000000_0x0000D1B6_phys_0_eng_0_engtype_3D", 20},
		{"pid_11_luid_0x00000000_0x0000D1B6_phys_0_eng_0_engtype_3D", 15},
		{"pid_11_luid_0x00000000_0x0000D1B6_phys_0_eng_5_engtype_VideoDecode", 50},
		{"pid_12_luid_0x00000000_0x0000AAAA_phys_0_eng_0_engtype_3D", 3},
		{"lixo", 99},
	}
	ad, byPID := aggregateGPU(eng)
	a := ad["0x00000000_0x0000D1B6"]
	if a == nil || a.Util != 50 || a.TopEngine != "VideoDecode" {
		t.Fatalf("adaptador: %+v", a)
	}
	if ad["0x00000000_0x0000AAAA"].Util != 3 || byPID[11] != 50 || byPID[10] != 20 {
		t.Fatalf("gpu: %+v %+v", ad, byPID)
	}
	if l, ok := parseGPUMemInstance("luid_0x00000000_0x0000D1B6_phys_0"); !ok || l != "0x00000000_0x0000D1B6" {
		t.Fatalf("mem instance: %q", l)
	}
}

func TestSysmonPanesFromList(t *testing.T) {
	list := []byte(`{"ev":"list","panes":[{"pane_id":4,"title":"✳ x","cwd":"/home/r","kind":"wsl","kind_label":"WSL","window_id":1}]}`)
	p := panesFromList(list)
	if len(p) != 1 || p[0].ID != 4 || p[0].Kind != "wsl" || p[0].CWD != "/home/r" {
		t.Fatalf("panes: %+v", p)
	}
	b, _ := json.Marshal(TermStat{})
	if len(b) == 0 {
		t.Fatal("json")
	}
}
