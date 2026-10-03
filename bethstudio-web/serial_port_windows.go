//go:build windows

package main

// serial_port_windows.go — porta COM pela API Win32 (sem dependencias alem de
// golang.org/x/sys): abrir com a configuracao do perfil e listar as portas
// presentes com nome amigavel e VID:PID (registro do Windows, so' leitura).

import (
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// Bits do campo Flags do DCB (winbase.h).
const (
	dcbBinary           = 1 << 0
	dcbParity           = 1 << 1
	dcbOutxCtsFlow      = 1 << 2
	dcbOutxDsrFlow      = 1 << 3
	dcbDtrControlShift  = 4 // 2 bits
	dcbOutX             = 1 << 8
	dcbInX              = 1 << 9
	dcbRtsControlShift  = 12 // 2 bits
	dtrControlEnable    = 1
	rtsControlEnable    = 1
	rtsControlHandshake = 2
)

// serialDCB preenche o DCB a partir do perfil (funcao pura, testada).
func serialDCB(p SerialProfile, base windows.DCB) (windows.DCB, error) {
	d := base
	d.BaudRate = uint32(p.Baud)
	d.ByteSize = uint8(p.DataBits)
	switch p.Parity {
	case "none":
		d.Parity = 0
	case "odd":
		d.Parity = 1
	case "even":
		d.Parity = 2
	case "mark":
		d.Parity = 3
	case "space":
		d.Parity = 4
	default:
		return d, errors.New("paridade inválida")
	}
	switch p.StopBits {
	case "1":
		d.StopBits = 0
	case "1.5":
		d.StopBits = 1
	case "2":
		d.StopBits = 2
	default:
		return d, errors.New("bits de parada inválidos")
	}
	f := uint32(dcbBinary) | dtrControlEnable<<dcbDtrControlShift
	if p.Parity != "none" {
		f |= dcbParity
	}
	switch p.Flow {
	case "none":
		f |= rtsControlEnable << dcbRtsControlShift
	case "rtscts":
		f |= dcbOutxCtsFlow | rtsControlHandshake<<dcbRtsControlShift
	case "xonxoff":
		f |= dcbOutX | dcbInX | rtsControlEnable<<dcbRtsControlShift
		d.XonChar, d.XoffChar = 0x11, 0x13
		d.XonLim, d.XoffLim = 2048, 512
	default:
		return d, errors.New("controle de fluxo inválido")
	}
	d.Flags = f
	return d, nil
}

// winSerialPort: io.ReadWriteCloser sobre o HANDLE da porta.
type winSerialPort struct{ h windows.Handle }

func (s *winSerialPort) Read(b []byte) (int, error) {
	for {
		var n uint32
		if err := windows.ReadFile(s.h, b, &n, nil); err != nil {
			return 0, err
		}
		if n > 0 {
			return int(n), nil
		}
		// timeout sem dados: confere se a porta ainda existe (USB removido)
		var errs uint32
		var st windows.ComStat
		if err := windows.ClearCommError(s.h, &errs, &st); err != nil {
			return 0, err
		}
	}
}

func (s *winSerialPort) Write(b []byte) (int, error) {
	var n uint32
	err := windows.WriteFile(s.h, b, &n, nil)
	return int(n), err
}

func (s *winSerialPort) Close() error { return windows.CloseHandle(s.h) }

// serialOpen abre e configura a porta. Erros em pt-BR.
func serialOpen(p SerialProfile) (*winSerialPort, error) {
	name, _ := windows.UTF16PtrFromString(`\\.\` + p.Port)
	h, err := windows.CreateFile(name, windows.GENERIC_READ|windows.GENERIC_WRITE, 0, nil, windows.OPEN_EXISTING, 0, 0)
	if err != nil {
		switch {
		case errors.Is(err, windows.ERROR_ACCESS_DENIED):
			return nil, fmt.Errorf("%s está em uso por outro programa", p.Port)
		case errors.Is(err, windows.ERROR_FILE_NOT_FOUND):
			return nil, fmt.Errorf("%s não existe (dispositivo desconectado?)", p.Port)
		}
		return nil, fmt.Errorf("não foi possível abrir %s: %v", p.Port, err)
	}
	var base windows.DCB
	base.DCBlength = uint32(unsafe.Sizeof(base))
	if err := windows.GetCommState(h, &base); err != nil {
		windows.CloseHandle(h)
		return nil, fmt.Errorf("%s: não foi possível ler a configuração: %v", p.Port, err)
	}
	d, err := serialDCB(p, base)
	if err != nil {
		windows.CloseHandle(h)
		return nil, err
	}
	d.DCBlength = base.DCBlength
	if err := windows.SetCommState(h, &d); err != nil {
		windows.CloseHandle(h)
		return nil, fmt.Errorf("%s recusou a configuração (%d baud, %d%s%s): %v", p.Port, p.Baud, p.DataBits, strings.ToUpper(p.Parity[:1]), p.StopBits, err)
	}
	// Leitura: volta assim que houver bytes, ou apos 200 ms sem nada.
	to := windows.CommTimeouts{ReadIntervalTimeout: 0xFFFFFFFF, ReadTotalTimeoutMultiplier: 0xFFFFFFFF, ReadTotalTimeoutConstant: 200, WriteTotalTimeoutConstant: 5000}
	if err := windows.SetCommTimeouts(h, &to); err != nil {
		windows.CloseHandle(h)
		return nil, fmt.Errorf("%s: %v", p.Port, err)
	}
	_ = windows.PurgeComm(h, 0x0008|0x0004) // PURGE_RXCLEAR|PURGE_TXCLEAR
	return &winSerialPort{h: h}, nil
}

// --- listagem de portas --------------------------------------------------------

// SerialPortInfo: uma porta presente agora.
type SerialPortInfo struct {
	Port         string `json:"port"`
	FriendlyName string `json:"friendly_name,omitempty"`
	Manufacturer string `json:"manufacturer,omitempty"`
	VID          string `json:"vid,omitempty"`
	PID          string `json:"pid,omitempty"`
	Serial       string `json:"serial_number,omitempty"`
}

var serialVidPidRe = regexp.MustCompile(`(?i)VID_([0-9A-F]{4})[&+]PID_([0-9A-F]{4})`)

// serialListPorts: portas em HARDWARE\DEVICEMAP\SERIALCOMM (as que existem
// agora), enriquecidas pelo cadastro de dispositivos (Enum\...\Device
// Parameters\PortName).
func serialListPorts() ([]SerialPortInfo, error) {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, `HARDWARE\DEVICEMAP\SERIALCOMM`, registry.QUERY_VALUE)
	if err != nil {
		if errors.Is(err, registry.ErrNotExist) {
			return []SerialPortInfo{}, nil // nenhuma porta
		}
		return nil, err
	}
	names, _ := k.ReadValueNames(-1)
	present := map[string]bool{}
	for _, n := range names {
		if v, _, err := k.GetStringValue(n); err == nil && serialPortRe.MatchString(v) {
			present[strings.ToUpper(v)] = true
		}
	}
	k.Close()
	info := serialDeviceInfo(present)
	out := make([]SerialPortInfo, 0, len(present))
	for p := range present {
		it := info[p]
		it.Port = p
		out = append(out, it)
	}
	sort.Slice(out, func(i, j int) bool { return serialPortNum(out[i].Port) < serialPortNum(out[j].Port) })
	return out, nil
}

func serialPortNum(p string) int {
	n, _ := strconv.Atoi(strings.TrimPrefix(strings.ToUpper(p), "COM"))
	return n
}

// serialDeviceInfo percorre Enum\<barramento>\<dispositivo>\<instancia> ate'
// achar as portas procuradas (limite de tempo: a lista nunca trava a tela).
func serialDeviceInfo(want map[string]bool) map[string]SerialPortInfo {
	out := map[string]SerialPortInfo{}
	if len(want) == 0 {
		return out
	}
	deadline := time.Now().Add(1500 * time.Millisecond)
	root, err := registry.OpenKey(registry.LOCAL_MACHINE, `SYSTEM\CurrentControlSet\Enum`, registry.ENUMERATE_SUB_KEYS)
	if err != nil {
		return out
	}
	defer root.Close()
	buses, _ := root.ReadSubKeyNames(-1)
	// barramentos onde portas COM costumam estar primeiro
	sort.SliceStable(buses, func(i, j int) bool { return serialBusRank(buses[i]) < serialBusRank(buses[j]) })
	for _, bus := range buses {
		bk, err := registry.OpenKey(root, bus, registry.ENUMERATE_SUB_KEYS)
		if err != nil {
			continue
		}
		devs, _ := bk.ReadSubKeyNames(-1)
		for _, dev := range devs {
			if time.Now().After(deadline) || len(out) == len(want) {
				bk.Close()
				return out
			}
			dk, err := registry.OpenKey(bk, dev, registry.ENUMERATE_SUB_KEYS)
			if err != nil {
				continue
			}
			insts, _ := dk.ReadSubKeyNames(-1)
			for _, inst := range insts {
				pk, err := registry.OpenKey(dk, inst+`\Device Parameters`, registry.QUERY_VALUE)
				if err != nil {
					continue
				}
				port, _, perr := pk.GetStringValue("PortName")
				pk.Close()
				port = strings.ToUpper(port)
				if perr != nil || !want[port] {
					continue
				}
				it := SerialPortInfo{}
				if ik, err := registry.OpenKey(dk, inst, registry.QUERY_VALUE); err == nil {
					it.FriendlyName = serialRegText(ik, "FriendlyName")
					if it.FriendlyName == "" {
						it.FriendlyName = serialRegText(ik, "DeviceDesc")
					}
					it.Manufacturer = serialRegText(ik, "Mfg")
					ik.Close()
				}
				if m := serialVidPidRe.FindStringSubmatch(dev); m != nil {
					it.VID, it.PID = strings.ToUpper(m[1]), strings.ToUpper(m[2])
					if !strings.Contains(inst, "&") {
						it.Serial = inst // instancia sem '&' = numero de serie do USB
					}
				}
				out[port] = it
			}
			dk.Close()
		}
		bk.Close()
	}
	return out
}

func serialBusRank(bus string) int {
	switch strings.ToUpper(bus) {
	case "USB":
		return 0
	case "FTDIBUS":
		return 1
	case "ACPI", "PCI", "BTHENUM", "ROOT":
		return 2
	}
	return 3
}

// serialRegText: valores como "@oem12.inf,%desc%;Nome legivel" viram o nome.
func serialRegText(k registry.Key, name string) string {
	v, _, err := k.GetStringValue(name)
	if err != nil {
		return ""
	}
	if i := strings.LastIndexByte(v, ';'); i >= 0 && strings.HasPrefix(v, "@") {
		v = v[i+1:]
	}
	return strings.TrimSpace(v)
}
