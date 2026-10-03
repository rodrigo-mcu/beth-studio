package main

// sysmon_windows.go — coleta nativa do Gerenciador de tarefas (sysmon.go).
//
//   - processos: um unico NtQuerySystemInformation(SystemProcessInformation)
//     (nome, pai, criacao, tempos de CPU, working set, privados) — nao abre
//     handle de nenhum processo;
//   - CPU por nucleo: SystemProcessorPerformanceInformation;
//   - RAM/commit: GlobalMemoryStatusEx; disco: GetDiskFreeSpaceEx + PDH;
//   - GPU: PDH (GPU Engine / GPU Adapter Memory) + nvidia-smi a cada 5 s;
//   - titulo do console de cada shell: AttachConsole -> GetConsoleTitleW ->
//     FreeConsole num PROCESSO AUXILIAR (o proprio exe, --console-titles);
//   - WSL: so' se a VM (vmmem) ja' estiver rodando; `wsl -l -v` e, para as
//     distros "Running", free/df/loadavg/ps a cada 5 s (timeout 3 s).

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	smKernel32             = windows.NewLazySystemDLL("kernel32.dll")
	smGlobalMemoryStatusEx = smKernel32.NewProc("GlobalMemoryStatusEx")
	smGetTickCount64       = smKernel32.NewProc("GetTickCount64")
	smAttachConsole        = smKernel32.NewProc("AttachConsole")
	smFreeConsole          = smKernel32.NewProc("FreeConsole")
	smGetConsoleTitleW     = smKernel32.NewProc("GetConsoleTitleW")
	smGetConsoleWindow     = smKernel32.NewProc("GetConsoleWindow")
	smSetConsoleCtrlHandlr = smKernel32.NewProc("SetConsoleCtrlHandler")

	smPdh                          = windows.NewLazySystemDLL("pdh.dll")
	smPdhOpenQueryW                = smPdh.NewProc("PdhOpenQueryW")
	smPdhAddEnglishCounterW        = smPdh.NewProc("PdhAddEnglishCounterW")
	smPdhCollectQueryData          = smPdh.NewProc("PdhCollectQueryData")
	smPdhGetFormattedCounterValue  = smPdh.NewProc("PdhGetFormattedCounterValue")
	smPdhGetFormattedCounterArrayW = smPdh.NewProc("PdhGetFormattedCounterArrayW")
	smPdhCloseQuery                = smPdh.NewProc("PdhCloseQuery")
)

// ------------------------------------------------------------ memoria --

type memoryStatusEx struct {
	Length               uint32
	MemoryLoad           uint32
	TotalPhys            uint64
	AvailPhys            uint64
	TotalPageFile        uint64
	AvailPageFile        uint64
	TotalVirtual         uint64
	AvailVirtual         uint64
	AvailExtendedVirtual uint64
}

func readMemory(s *SysStat) {
	var m memoryStatusEx
	m.Length = uint32(unsafe.Sizeof(m))
	if r, _, _ := smGlobalMemoryStatusEx.Call(uintptr(unsafe.Pointer(&m))); r == 0 {
		return
	}
	s.RAMTotal, s.RAMAvail, s.RAMLoad = m.TotalPhys, m.AvailPhys, m.MemoryLoad
	s.RAMUsed = m.TotalPhys - m.AvailPhys
	s.CommitLimit = m.TotalPageFile
	s.CommitUsed = m.TotalPageFile - m.AvailPageFile
}

func uptimeSec() int64 {
	r, _, _ := smGetTickCount64.Call()
	return int64(r / 1000)
}

// ---------------------------------------------------------------- CPU --

type cpuPerf struct {
	Idle, Kernel, User, Dpc, Interrupt int64
	InterruptCount                     uint32
	_                                  uint32
}

const systemProcessorPerformanceInformation = 8

func readCPUTimes() []cpuPerf {
	buf := make([]cpuPerf, 256)
	var ret uint32
	err := windows.NtQuerySystemInformation(systemProcessorPerformanceInformation,
		unsafe.Pointer(&buf[0]), uint32(len(buf))*uint32(unsafe.Sizeof(buf[0])), &ret)
	if err != nil {
		return nil
	}
	return buf[:ret/uint32(unsafe.Sizeof(buf[0]))]
}

// cpuBusy: % ocupado entre duas leituras (Kernel inclui Idle).
func cpuBusy(a, b cpuPerf) float64 {
	total := (b.Kernel - a.Kernel) + (b.User - a.User)
	idle := b.Idle - a.Idle
	if total <= 0 {
		return 0
	}
	v := float64(total-idle) / float64(total) * 100
	if v < 0 {
		v = 0
	}
	if v > 100 {
		v = 100
	}
	return v
}

// ---------------------------------------------------------- processos --

func readProcesses() ([]*procInfo, error) {
	size := uint32(512 << 10)
	for tries := 0; tries < 6; tries++ {
		buf := make([]byte, size)
		var ret uint32
		err := windows.NtQuerySystemInformation(windows.SystemProcessInformation, unsafe.Pointer(&buf[0]), size, &ret)
		if err == windows.STATUS_INFO_LENGTH_MISMATCH || err == windows.STATUS_BUFFER_TOO_SMALL {
			size = ret + 64<<10
			if size < uint32(len(buf))*2 {
				size = uint32(len(buf)) * 2
			}
			continue
		}
		if err != nil {
			return nil, err
		}
		var out []*procInfo
		off := uintptr(0)
		for {
			if off+unsafe.Sizeof(windows.SYSTEM_PROCESS_INFORMATION{}) > uintptr(len(buf)) {
				break
			}
			e := (*windows.SYSTEM_PROCESS_INFORMATION)(unsafe.Pointer(&buf[off]))
			name := "System Idle Process"
			if e.ImageName.Length > 0 && e.ImageName.Buffer != nil {
				name = windows.UTF16PtrToString(e.ImageName.Buffer)
				if n := int(e.ImageName.Length / 2); n < len(name) {
					name = name[:n]
				}
			}
			out = append(out, &procInfo{
				PID: uint32(e.UniqueProcessID), PPID: uint32(e.InheritedFromUniqueProcessID),
				Name: name, Created: e.CreateTime, CPUTime: e.UserTime + e.KernelTime,
				WS: uint64(e.WorkingSetSize), PrivateWS: uint64(e.WorkingSetPrivateSize), Private: uint64(e.PrivatePageCount),
			})
			if e.NextEntryOffset == 0 {
				break
			}
			off += uintptr(e.NextEntryOffset)
		}
		runtime.KeepAlive(buf)
		return out, nil
	}
	return nil, windows.STATUS_INFO_LENGTH_MISMATCH
}

// ---------------------------------------------------------------- PDH --

const (
	pdhFmtDouble   = 0x00000200
	pdhFmtNoCap100 = 0x00008000
	pdhMoreData    = 0x800007D2
)

type pdhFmtValue struct {
	CStatus uint32
	_       uint32
	Value   float64
}

type pdhQuery struct {
	h        uintptr
	counters map[string]uintptr
}

func openPdh(paths []string) *pdhQuery {
	if smPdh.Load() != nil {
		return nil
	}
	q := &pdhQuery{counters: map[string]uintptr{}}
	if r, _, _ := smPdhOpenQueryW.Call(0, 0, uintptr(unsafe.Pointer(&q.h))); r != 0 {
		return nil
	}
	for _, p := range paths {
		var c uintptr
		pp, _ := windows.UTF16PtrFromString(p)
		if r, _, _ := smPdhAddEnglishCounterW.Call(q.h, uintptr(unsafe.Pointer(pp)), 0, uintptr(unsafe.Pointer(&c))); r == 0 {
			q.counters[p] = c
		}
	}
	return q
}

func (q *pdhQuery) collect() bool {
	if q == nil {
		return false
	}
	r, _, _ := smPdhCollectQueryData.Call(q.h)
	return r == 0
}

func (q *pdhQuery) close() {
	if q != nil && q.h != 0 {
		smPdhCloseQuery.Call(q.h)
		q.h = 0
	}
}

func (q *pdhQuery) value(path string) (float64, bool) {
	if q == nil {
		return 0, false
	}
	c, ok := q.counters[path]
	if !ok {
		return 0, false
	}
	var v pdhFmtValue
	r, _, _ := smPdhGetFormattedCounterValue.Call(c, pdhFmtDouble|pdhFmtNoCap100, 0, uintptr(unsafe.Pointer(&v)))
	if r != 0 || v.CStatus > 1 {
		return 0, false
	}
	return v.Value, true
}

// array: valores de um contador com curinga. O buffer e' []byte (sem
// ponteiros para o GC); os nomes apontam para dentro dele.
func (q *pdhQuery) array(path string) ([]gpuEngineSample, bool) {
	if q == nil {
		return nil, false
	}
	c, ok := q.counters[path]
	if !ok {
		return nil, false
	}
	const itemSize = unsafe.Sizeof(uintptr(0)) + unsafe.Sizeof(pdhFmtValue{})
	for tries := 0; tries < 4; tries++ {
		var size, count uint32
		r, _, _ := smPdhGetFormattedCounterArrayW.Call(c, pdhFmtDouble|pdhFmtNoCap100, uintptr(unsafe.Pointer(&size)), uintptr(unsafe.Pointer(&count)), 0)
		if uint32(r) != pdhMoreData {
			return nil, r == 0
		}
		buf := make([]byte, size+uint32(itemSize))
		r, _, _ = smPdhGetFormattedCounterArrayW.Call(c, pdhFmtDouble|pdhFmtNoCap100, uintptr(unsafe.Pointer(&size)), uintptr(unsafe.Pointer(&count)), uintptr(unsafe.Pointer(&buf[0])))
		if uint32(r) == pdhMoreData {
			continue
		}
		if r != 0 {
			return nil, false
		}
		out := make([]gpuEngineSample, 0, count)
		for i := uint32(0); i < count; i++ {
			if uintptr(i+1)*itemSize > uintptr(len(buf)) {
				break
			}
			item := unsafe.Pointer(&buf[uintptr(i)*itemSize])
			name := *(**uint16)(item)
			val := (*pdhFmtValue)(unsafe.Add(item, unsafe.Sizeof(uintptr(0))))
			if val.CStatus > 1 || name == nil {
				continue
			}
			out = append(out, gpuEngineSample{Instance: windows.UTF16PtrToString(name), Value: val.Value})
		}
		runtime.KeepAlive(buf)
		return out, true
	}
	return nil, false
}

const (
	pdhGPUEngine    = `\GPU Engine(*)\Utilization Percentage`
	pdhGPUDedicated = `\GPU Adapter Memory(*)\Dedicated Usage`
	pdhGPUShared    = `\GPU Adapter Memory(*)\Shared Usage`
	pdhDiskRead     = `\LogicalDisk(C:)\Disk Read Bytes/sec`
	pdhDiskWrite    = `\LogicalDisk(C:)\Disk Write Bytes/sec`
	pdhDiskIdle     = `\LogicalDisk(C:)\% Idle Time`
)

// ------------------------------------------------- titulo do console --
//
// O processo principal NUNCA chama AttachConsole: se o terminal fechasse
// durante o attach (CTRL_CLOSE_EVENT), o Windows encerraria o bethterm-web.
// A leitura roda num processo auxiliar descartavel — o proprio exe com
// `--console-titles <pid,pid,...>` (consoleTitlesHelperMain), sem console
// (DETACHED_PROCESS), que imprime uma linha JSON por pid e sai. Timeout 3 s;
// se ele morrer no meio, vale o que ja' tinha impresso.

var (
	consoleMu       sync.Mutex  // serializa os filhos que este modulo cria
	titlesHelperOK  atomic.Bool // ultimo auxiliar rodou (para o "indisponivel")
	titlesHelperErr atomic.Value
)

func init() { titlesHelperOK.Store(true) }

// consoleTitlesAvailable: o auxiliar esta' funcionando?
func consoleTitlesAvailable() bool { return titlesHelperOK.Load() }

// readConsoleTitles pede os titulos ao processo auxiliar.
func readConsoleTitles(pids []uint32) map[uint32]string {
	out := map[uint32]string{}
	if len(pids) == 0 {
		return out
	}
	exe, err := os.Executable()
	if err != nil {
		titlesHelperOK.Store(false)
		return out
	}
	if len(pids) > maxTitlePIDs {
		pids = pids[:maxTitlePIDs]
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, exe, consoleTitlesFlag, formatPIDList(pids))
	// sem console nenhum: o auxiliar anexa ao console de cada shell
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.DETACHED_PROCESS | windows.CREATE_NEW_PROCESS_GROUP}
	var sb strings.Builder
	cmd.Stdout = &limitedWriter{w: &sb, n: 256 << 10}
	consoleMu.Lock()
	err = cmd.Start()
	consoleMu.Unlock()
	if err != nil {
		titlesHelperOK.Store(false)
		return out
	}
	_ = cmd.Wait() // saida parcial (auxiliar morto/timeout) ainda serve
	got := parseConsoleTitleLines(sb.String(), pids)
	titlesHelperOK.Store(len(got) > 0 || ctx.Err() == nil)
	return got
}

// consoleTitlesHelperMain: corpo do processo auxiliar. So' roda la'.
func consoleTitlesHelperMain(arg string) int {
	pids := parsePIDList(arg)
	// engole Ctrl+C/Break/Close dos consoles anexados; se o Windows encerrar
	// este processo mesmo assim, so' ele morre (e' descartavel)
	cb := windows.NewCallback(func(uint32) uintptr { return 1 })
	smSetConsoleCtrlHandlr.Call(cb, 1)
	smFreeConsole.Call()
	runtime.LockOSThread()
	w := os.Stdout
	buf := make([]uint16, 1024)
	for _, pid := range pids {
		r, _, _ := smAttachConsole.Call(uintptr(pid))
		if r == 0 {
			continue
		}
		n, _, _ := smGetConsoleTitleW.Call(uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
		smFreeConsole.Call()
		if n > 0 && int(n) <= len(buf) {
			line, _ := json.Marshal(consoleTitleLine{PID: pid, Title: windows.UTF16ToString(buf[:n])})
			_, _ = w.Write(append(line, '\n'))
		}
	}
	return 0
}

// ------------------------------------------------- comandos externos --

// runHiddenOutput: como runHidden, capturando stdout.
func runHiddenOutput(timeout time.Duration, name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
	var sb strings.Builder
	cmd.Stdout = &limitedWriter{w: &sb, n: 256 << 10}
	consoleMu.Lock()
	err := cmd.Start()
	consoleMu.Unlock()
	if err != nil {
		return nil, err
	}
	err = cmd.Wait()
	if ctx.Err() != nil {
		err = ctx.Err()
	}
	return []byte(sb.String()), err
}

type limitedWriter struct {
	w *strings.Builder
	n int
}

func (l *limitedWriter) Write(p []byte) (int, error) {
	if l.w.Len() < l.n {
		room := l.n - l.w.Len()
		if len(p) > room {
			l.w.Write(p[:room])
		} else {
			l.w.Write(p)
		}
	}
	return len(p), nil
}

func system32(exe string) string {
	root := os.Getenv("SystemRoot")
	if root == "" {
		root = `C:\Windows`
	}
	return filepath.Join(root, "System32", exe)
}

// --------------------------------------------- coletas lentas (5 s) --

type slowState struct {
	mu        sync.Mutex
	nvidia    []NvidiaGPU
	nvNote    string
	nvBusy    bool
	nvAt      time.Time
	wsl       []WSLDistro
	wslNote   string
	wslBusy   bool
	wslAt     time.Time
	nvidiaExe string
}

func (s *slowState) maybeNvidia() {
	s.mu.Lock()
	if s.nvBusy || time.Since(s.nvAt) < 5*time.Second {
		s.mu.Unlock()
		return
	}
	s.nvBusy = true
	if s.nvidiaExe == "" {
		if p := system32("nvidia-smi.exe"); fileExists(p) {
			s.nvidiaExe = p
		} else if p, err := exec.LookPath("nvidia-smi.exe"); err == nil {
			s.nvidiaExe = p
		} else {
			s.nvidiaExe = "-"
		}
	}
	exe := s.nvidiaExe
	s.mu.Unlock()
	go func() {
		var gpus []NvidiaGPU
		note := ""
		if exe == "-" {
			note = "nvidia-smi não encontrado"
		} else {
			out, err := runHiddenOutput(4*time.Second, exe,
				"--query-gpu=name,temperature.gpu,memory.total,memory.used,utilization.gpu", "--format=csv,noheader,nounits")
			if err != nil {
				note = "nvidia-smi falhou: " + err.Error()
			}
			gpus = parseNvidiaSmi(string(out))
		}
		s.mu.Lock()
		s.nvidia, s.nvNote, s.nvBusy, s.nvAt = gpus, note, false, time.Now()
		s.mu.Unlock()
	}()
}

// maybeWSL: so' com a VM ja' rodando (senao nenhuma distro esta' Running e
// nao chamamos wsl.exe). Distros paradas nunca sao consultadas.
func (s *slowState) maybeWSL(vmRunning bool) {
	s.mu.Lock()
	if !vmRunning {
		s.wsl, s.wslNote = nil, ""
		s.mu.Unlock()
		return
	}
	if s.wslBusy || time.Since(s.wslAt) < 5*time.Second {
		s.mu.Unlock()
		return
	}
	s.wslBusy = true
	prev := map[string]WSLDistro{}
	for _, d := range s.wsl {
		prev[d.Name] = d
	}
	s.mu.Unlock()
	go func() {
		exe := system32("wsl.exe")
		note := ""
		// Quem esta' rodando vem de `wsl -l --running -q` (so' nomes); o
		// `-l -v` fica para versao/estado exibidos.
		running := func() (map[string]bool, bool) {
			o, err := runHiddenOutput(3*time.Second, exe, "-l", "--running", "-q")
			names := parseWSLRunningNames(o)
			if err != nil && len(names) == 0 {
				// sem distro rodando o wsl.exe sai com erro e uma frase: vale "nenhuma"
				return map[string]bool{}, len(o) > 0
			}
			m := map[string]bool{}
			for _, nm := range names {
				m[nm] = true
			}
			return m, true
		}
		run0, runOK := running()
		out, err := runHiddenOutput(3*time.Second, exe, "-l", "-v")
		distros := parseWSLList(out)
		if err != nil && len(distros) == 0 {
			note = "wsl -l -v falhou: " + err.Error()
		}
		for i := range distros {
			d := &distros[i]
			if runOK {
				d.Running = run0[d.Name]
			}
			if !d.Running {
				continue
			}
			if !safeDistroName(d.Name) {
				d.Error = "nome de distro inesperado"
				continue
			}
			// Corrida: `wsl -d X` INICIARIA uma distro que parou nesse meio
			// tempo. Confirma de novo logo antes; parada = pula.
			if now, ok := running(); !ok || !now[d.Name] {
				d.Running = false
				continue
			}
			o, err := runHiddenOutput(3*time.Second, exe, "-d", d.Name, "-e", "sh", "-c",
				"free -b; df -B1 -P / 2>/dev/null || df -P /; cat /proc/loadavg; cat /proc/swaps 2>/dev/null; for z in /sys/block/zram*; do test -r $z/mm_stat && echo ZRAM ${z##*/} $(cat $z/mm_stat); done; ps -eo pid,rss,pcpu,etime,comm --sort=-rss | head -15")
			now := time.Now()
			mem, disk, load, procs := parseDistroProbe(string(o))
			if err != nil && mem == nil {
				d.Error = "consulta falhou: " + err.Error()
				if p, ok := prev[d.Name]; ok { // mantem o ultimo valor bom
					d.Mem, d.Disk, d.Load, d.Top, d.SampledAt = p.Mem, p.Disk, p.Load, p.Top, p.SampledAt
				}
				continue
			}
			d.Mem, d.Disk, d.Load, d.Top, d.SampledAt = mem, disk, load, procs, &now
		}
		s.mu.Lock()
		s.wsl, s.wslNote, s.wslBusy, s.wslAt = distros, note, false, time.Now()
		s.mu.Unlock()
	}()
}

func safeDistroName(n string) bool {
	if n == "" || len(n) > 64 || strings.HasPrefix(n, "-") {
		return false
	}
	for _, r := range n {
		if !(r == '-' || r == '_' || r == '.' || r >= '0' && r <= '9' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z') {
			return false
		}
	}
	return true
}

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}

// ------------------------------------------------------------ sampler --

type titleEntry struct {
	title string
	at    time.Time
}

type sampler struct {
	pdh       *pdhQuery
	prevCPU   []cpuPerf
	prevProc  map[procKey]int64
	prevAt    time.Time
	history   []float64
	wslHist   []WSLPoint
	titles    map[procKey]titleEntry
	stable    map[procKey]paneMatch
	slow      *slowState
	ncpu      int
	hostCache uint32
}

func newSampler() *sampler {
	return &sampler{
		prevProc: map[procKey]int64{},
		titles:   map[procKey]titleEntry{},
		stable:   map[procKey]paneMatch{},
		slow:     &slowState{},
	}
}

func (s *sampler) close() { s.pdh.close() }

func (s *sampler) prime(panes func() []PaneLite) {
	s.pdh = openPdh([]string{pdhGPUEngine, pdhGPUDedicated, pdhGPUShared, pdhDiskRead, pdhDiskWrite, pdhDiskIdle})
	s.pdh.collect()
	s.sample(panes)
	s.history = nil
	s.wslHist = nil
}

func hostPIDFromFile() uint32 {
	b, err := os.ReadFile(filepath.Join(dataDir(), "host.pid"))
	if err != nil {
		return 0
	}
	v, _ := strconv.ParseUint(strings.TrimSpace(string(b)), 10, 32)
	return uint32(v)
}

func (s *sampler) sample(panes func() []PaneLite) *SysmonSnapshot {
	t0 := time.Now()
	snap := &SysmonSnapshot{At: t0}
	readMemory(&snap.System)
	snap.System.UptimeSec = uptimeSec()

	// CPU total e por nucleo.
	cur := readCPUTimes()
	if len(cur) > 0 {
		s.ncpu = len(cur)
		if len(s.prevCPU) == len(cur) {
			var a, b cpuPerf
			snap.System.Cores = make([]float64, len(cur))
			for i := range cur {
				snap.System.Cores[i] = round1(cpuBusy(s.prevCPU[i], cur[i]))
				a.Idle += s.prevCPU[i].Idle
				a.Kernel += s.prevCPU[i].Kernel
				a.User += s.prevCPU[i].User
				b.Idle += cur[i].Idle
				b.Kernel += cur[i].Kernel
				b.User += cur[i].User
			}
			snap.System.CPU = round1(cpuBusy(a, b))
		}
		s.prevCPU = cur
	}
	if s.ncpu == 0 {
		s.ncpu = runtime.NumCPU()
	}

	// Processos + CPU por processo (normalizada pela maquina inteira).
	procs, _ := readProcesses()
	snap.System.Procs = len(procs)
	dt := t0.Sub(s.prevAt)
	next := map[procKey]int64{}
	for _, p := range procs {
		k := p.key()
		next[k] = p.CPUTime
		if old, ok := s.prevProc[k]; ok && !s.prevAt.IsZero() && dt > 0 && p.PID != 0 {
			p.CPU = float64(p.CPUTime-old) / (float64(dt.Nanoseconds()/100) * float64(s.ncpu)) * 100
			if p.CPU < 0 {
				p.CPU = 0
			}
		}
	}
	s.prevProc, s.prevAt = next, t0

	// PDH: GPU e disco.
	var gpuByPID map[uint32]float64
	if s.pdh.collect() {
		if eng, ok := s.pdh.array(pdhGPUEngine); ok {
			var ad map[string]*GPUAdapter
			ad, gpuByPID = aggregateGPU(eng)
			ded, _ := s.pdh.array(pdhGPUDedicated)
			sh, _ := s.pdh.array(pdhGPUShared)
			addMem := func(list []gpuEngineSample, dedicated bool) {
				for _, x := range list {
					l, ok := parseGPUMemInstance(x.Instance)
					if !ok {
						continue
					}
					if ad[l] == nil {
						ad[l] = &GPUAdapter{LUID: l}
					}
					if dedicated {
						ad[l].DedicatedUsed += uint64(x.Value)
					} else {
						ad[l].SharedUsed += uint64(x.Value)
					}
				}
			}
			addMem(ded, true)
			addMem(sh, false)
			for _, a := range ad {
				if a.Util == 0 && a.DedicatedUsed == 0 && a.SharedUsed == 0 {
					continue // adaptador sem uso nenhum (ex. Microsoft Basic Render)
				}
				snap.GPU.Adapters = append(snap.GPU.Adapters, *a)
			}
			sort.Slice(snap.GPU.Adapters, func(i, j int) bool {
				ai, aj := snap.GPU.Adapters[i], snap.GPU.Adapters[j]
				if ai.DedicatedUsed != aj.DedicatedUsed {
					return ai.DedicatedUsed > aj.DedicatedUsed
				}
				return ai.LUID < aj.LUID
			})
			snap.GPU.Available = len(snap.GPU.Adapters) > 0
		}
		r, okR := s.pdh.value(pdhDiskRead)
		w, okW := s.pdh.value(pdhDiskWrite)
		idle, okI := s.pdh.value(pdhDiskIdle)
		if okR && okW {
			snap.Disk.ReadBps, snap.Disk.WriteBps, snap.Disk.Activity = round1(r), round1(w), true
		}
		if okI {
			a := 100 - idle
			if a < 0 {
				a = 0
			}
			if a > 100 {
				a = 100
			}
			snap.Disk.ActivePct = round1(a)
		}
	}
	for _, p := range procs {
		if g, ok := gpuByPID[p.PID]; ok {
			p.GPU = g
		}
	}
	snap.Disk.Drive = "C:"
	{
		var freeCaller, total, free uint64
		root, _ := windows.UTF16PtrFromString(`C:\`)
		if windows.GetDiskFreeSpaceEx(root, &freeCaller, &total, &free) == nil {
			snap.Disk.Total, snap.Disk.Free = total, free
		}
	}

	// nvidia-smi (a cada 5 s, em segundo plano).
	s.slow.maybeNvidia()

	// Arvore, host e terminais.
	tree := buildTree(procs)
	var host *procInfo
	want := hostPIDFromFile()
	var hosts []*procInfo
	for _, p := range procs {
		if strings.EqualFold(p.Name, "bethterm-host.exe") {
			hosts = append(hosts, p)
			if p.PID == want {
				host = p
			}
		}
	}
	if host == nil && len(hosts) > 0 {
		host = hosts[0]
		for _, h := range hosts {
			if len(tree.children[h.PID]) > len(tree.children[host.PID]) {
				host = h
			}
		}
	}
	paneList := panes()
	titles := map[procKey]string{}
	if host != nil {
		// Le o titulo so' dos shells ainda sem associacao estavel, e no
		// maximo a cada 3 s cada um.
		var need []uint32
		needKey := map[uint32]procKey{}
		now := time.Now()
		live := map[procKey]bool{}
		for _, c := range tree.children[host.PID] {
			if isConsoleHost(c.Name) {
				continue
			}
			k := c.key()
			live[k] = true
			te, have := s.titles[k]
			if _, st := s.stable[k]; st && have {
				titles[k] = te.title
				continue
			}
			if have && now.Sub(te.at) < 3*time.Second {
				titles[k] = te.title
				continue
			}
			need = append(need, c.PID)
			needKey[c.PID] = k
		}
		if len(need) > 0 {
			got := readConsoleTitles(need)
			for pid, k := range needKey {
				s.titles[k] = titleEntry{got[pid], now}
				titles[k] = got[pid]
			}
		}
		for k := range s.titles {
			if !live[k] {
				delete(s.titles, k)
			}
		}
	}
	snap.Terminals, snap.Match, s.stable = buildTerminals(tree, host, paneList, titles, s.stable)
	snap.Match.TitlesAvailable = consoleTitlesAvailable()
	if !snap.Match.TitlesAvailable && snap.Match.Note == "" {
		snap.Match.Note = "leitura dos títulos dos consoles indisponível: associação só por ordem de criação"
	}
	snap.BethTerm = buildBethTerm(tree, procs, host)

	// WSL: VM (vmmem/vmmemWSL) + distros.
	var vm []*procInfo
	for _, p := range procs {
		n := strings.ToLower(p.Name)
		if n == "vmmemwsl" || n == "vmmem" || n == "vmmemwsl.exe" || n == "vmmem.exe" {
			vm = append(vm, p)
		}
	}
	if len(vm) > 0 {
		st := sumProcs(vm)
		st.Name = vm[0].Name
		st.PID = vm[0].PID
		// vmmem: o working set e' a RAM da VM (privados nao se aplicam).
		snap.WSL.VM = &st
		snap.WSL.VMRunning = true
	}
	s.slow.maybeWSL(snap.WSL.VMRunning)

	s.slow.mu.Lock()
	snap.GPU.Nvidia = s.slow.nvidia
	if !snap.GPU.Available && len(snap.GPU.Nvidia) == 0 {
		snap.GPU.Note = "indisponível"
		if s.slow.nvNote != "" {
			snap.GPU.Note = "indisponível (" + s.slow.nvNote + ")"
		}
	}
	if len(s.slow.nvidia) == 1 && len(snap.GPU.Adapters) > 0 && snap.GPU.Adapters[0].DedicatedUsed > 0 {
		snap.GPU.Adapters[0].Name = s.slow.nvidia[0].Name + " (provável)"
	}
	snap.WSL.Distros = s.slow.wsl
	snap.WSL.Note = s.slow.wslNote
	s.slow.mu.Unlock()
	if !snap.WSL.VMRunning {
		snap.WSL.Note = "WSL parado (VM não está rodando)"
	}
	for i := range snap.GPU.Adapters {
		if snap.GPU.Adapters[i].Name == "" {
			snap.GPU.Adapters[i].Name = "Adaptador " + strconv.Itoa(i+1)
		}
	}

	s.history = append(s.history, snap.System.CPU)
	if len(s.history) > 60 {
		s.history = s.history[len(s.history)-60:]
	}
	snap.CPUHistory = append([]float64(nil), s.history...)
	snap.WSL.Usage = wslUsage(snap.WSL.VM, snap.WSL.Distros)
	s.wslHist = appendWSLHistory(s.wslHist, WSLPoint{
		RAM: snap.WSL.Usage.RAMPct, RAMOK: snap.WSL.Usage.RAMKnown,
		CPU:  snap.WSL.Usage.CPU,
		Disk: snap.WSL.Usage.DiskPct, DiskOK: snap.WSL.Usage.DiskKnown,
	}, 60)
	snap.WSL.Usage.History = append([]WSLPoint(nil), s.wslHist...)
	snap.SampleMs = round1(float64(time.Since(t0).Microseconds()) / 1000)
	return snap
}
