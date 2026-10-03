// probe: read-only headless check of a running bethterm-web.
//
// It NEVER sends input to a pane: the only requests it can make are
// {"op":"list"} and {"op":"watch"}.
//
//	go run ./tools/probe -url "http://127.0.0.1:PORT/?t=TOKEN" -pane 9
package main

import (
	"bufio"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"
)

func main() {
	rawURL := flag.String("url", "", "URL impressa pelo bethterm-web (com ?t=)")
	pane := flag.Int("pane", 9, "pane a observar (somente leitura)")
	scrollTo := flag.Int("scroll", -1, "depois do 1o screen, pede {op:scroll,offset:N} (so muda a visualizacao, nao e entrada) e espera o screen rolado")
	hold := flag.Duration("hold", 0, "depois do OK, continua conectado e imprime status/erros por este tempo")
	flag.Parse()
	u, err := url.Parse(*rawURL)
	if err != nil || u.Query().Get("t") == "" {
		fail("passe -url com ?t=TOKEN")
	}
	token := u.Query().Get("t")
	base := u.Scheme + "://" + u.Host
	ok := true
	check := func(name string, got, want int) {
		mark := "OK "
		if got != want {
			mark, ok = "ERR", false
		}
		fmt.Printf("[%s] %-38s HTTP %d (esperado %d)\n", mark, name, got, want)
	}

	check("GET / sem token", status(base+"/", nil), 401)
	check("GET / token errado", status(base+"/?t=errado", nil), 401)
	check("GET /ws sem token", status(base+"/ws", map[string]string{"Origin": base}), 401)
	check("GET / Origin estranha", status(base+"/?t="+token, map[string]string{"Origin": "http://evil.example"}), 403)
	check("GET / com token", status(base+"/?t="+token, nil), 200)
	check("GET /healthz via header", status(base+"/healthz", map[string]string{"X-BethTerm-Token": token}), 200)
	if code := wsHandshakeStatus(u.Host, "/ws?t="+token, "http://evil.example"); code != 101 {
		fmt.Printf("[OK ] %-38s HTTP %d (recusado)\n", "WS Origin estranha", code)
	} else {
		fmt.Printf("[ERR] WS Origin estranha foi aceita\n")
		ok = false
	}

	conn, rd, err := wsDial(u.Host, "/ws?t="+token, base)
	if err != nil {
		fail("ws: %v", err)
	}
	defer conn.Close()
	fmt.Println("[OK ] WebSocket conectado")

	start := time.Now()
	sentWatch := false
	sentScroll := false
	gotList, gotScreen := false, false
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) && !(gotList && gotScreen) {
		_ = conn.SetReadDeadline(deadline)
		op, data, err := wsRead(rd)
		if err != nil {
			fail("ws read: %v", err)
		}
		if op != 1 {
			continue
		}
		var ev map[string]any
		if json.Unmarshal(data, &ev) != nil {
			continue
		}
		ms := time.Since(start).Milliseconds()
		switch ev["ev"] {
		case "status":
			fmt.Printf("  +%4dms status: state=%v read_only=%v msg=%q\n", ms, ev["state"], ev["read_only"], ev["message"])
		case "list":
			panes, _ := ev["panes"].([]any)
			fmt.Printf("  +%4dms list: %d panes\n", ms, len(panes))
			for _, p := range panes {
				m, _ := p.(map[string]any)
				sz, _ := m["size"].(map[string]any)
				fmt.Printf("           pane %v win %v tab %v %vx%v %q\n", m["pane_id"], m["window_id"], m["tab_id"], sz["cols"], sz["rows"], m["title"])
			}
			gotList = true
			if !sentWatch {
				sentWatch = true
				req, _ := json.Marshal(map[string]any{"op": "watch", "pane_ids": []int{*pane}})
				if err := wsWriteMasked(conn, req); err != nil {
					fail("ws write: %v", err)
				}
				fmt.Printf("  enviado: %s\n", req)
			}
		case "screen":
			text, _ := ev["text"].(string)
			first := stripSGR(strings.SplitN(text, "\r\n", 2)[0])
			fmt.Printf("  +%4dms screen: pane=%v %vx%v cursor=(%v,%v) visible=%v text=%d bytes; 1a linha: %q\n",
				ms, ev["pane_id"], ev["cols"], ev["rows"], ev["cursor_x"], ev["cursor_y"], ev["cursor_visible"], len(text), trunc(first, 60))
			fmt.Printf("           offset=%v scrollback=%v\n", ev["offset"], ev["scrollback"])
			if int(ev["pane_id"].(float64)) == *pane {
				if *scrollTo < 0 {
					gotScreen = true
				} else if !sentScroll {
					sentScroll = true
					req, _ := json.Marshal(map[string]any{"op": "scroll", "pane_id": *pane, "offset": *scrollTo})
					if err := wsWriteMasked(conn, req); err != nil {
						fail("ws write: %v", err)
					}
					fmt.Printf("  enviado: %s\n", req)
				} else if off, _ := ev["offset"].(float64); int(off) == *scrollTo || (*scrollTo > 0 && off > 0) {
					gotScreen = true
				}
			}
		case "error":
			fmt.Printf("  +%4dms error: %v\n", ms, ev["message"])
		}
	}
	if !gotList || !gotScreen {
		fmt.Printf("[ERR] list=%v screen=%v\n", gotList, gotScreen)
		ok = false
	} else {
		fmt.Println("[OK ] list recebido e screen do pane observado recebido")
	}
	if ok && *hold > 0 {
		end := time.Now().Add(*hold)
		screens := 0
		for time.Now().Before(end) {
			_ = conn.SetReadDeadline(end)
			op, data, err := wsRead(rd)
			if err != nil {
				break
			}
			if op != 1 {
				continue
			}
			var ev map[string]any
			if json.Unmarshal(data, &ev) != nil {
				continue
			}
			switch ev["ev"] {
			case "screen":
				screens++
			case "list":
				fmt.Printf("  +%4dms list\n", time.Since(start).Milliseconds())
			default:
				fmt.Printf("  +%4dms %v: %v %v\n", time.Since(start).Milliseconds(), ev["ev"], ev["state"], ev["message"])
			}
		}
		fmt.Printf("  hold: %d screens em %s\n", screens, *hold)
	}
	if !ok {
		os.Exit(1)
	}
}

var sgrRe = regexp.MustCompile("\x1b\\[[0-9;:?]*[A-Za-z]")

func stripSGR(s string) string { return strings.TrimRight(sgrRe.ReplaceAllString(s, ""), " ") }

func trunc(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n]) + "…"
	}
	return s
}

func fail(f string, a ...any) {
	fmt.Fprintf(os.Stderr, "probe: "+f+"\n", a...)
	os.Exit(2)
}

func status(u string, hdr map[string]string) int {
	req, _ := http.NewRequest("GET", u, nil)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return -1
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	return resp.StatusCode
}

func handshake(host, path, origin string) (net.Conn, *bufio.Reader, int, error) {
	conn, err := net.DialTimeout("tcp", host, 5*time.Second)
	if err != nil {
		return nil, nil, 0, err
	}
	k := make([]byte, 16)
	_, _ = rand.Read(k)
	fmt.Fprintf(conn, "GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"+
		"Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\nOrigin: %s\r\n\r\n",
		path, host, base64.StdEncoding.EncodeToString(k), origin)
	rd := bufio.NewReader(conn)
	resp, err := http.ReadResponse(rd, nil)
	if err != nil {
		conn.Close()
		return nil, nil, 0, err
	}
	return conn, rd, resp.StatusCode, nil
}

func wsHandshakeStatus(host, path, origin string) int {
	conn, _, code, err := handshake(host, path, origin)
	if err != nil {
		return -1
	}
	conn.Close()
	return code
}

func wsDial(host, path, origin string) (net.Conn, *bufio.Reader, error) {
	conn, rd, code, err := handshake(host, path, origin)
	if err != nil {
		return nil, nil, err
	}
	if code != 101 {
		conn.Close()
		return nil, nil, fmt.Errorf("handshake HTTP %d", code)
	}
	return conn, rd, nil
}

func wsWriteMasked(conn net.Conn, data []byte) error {
	hdr := []byte{0x81}
	n := len(data)
	switch {
	case n < 126:
		hdr = append(hdr, 0x80|byte(n))
	case n <= 0xFFFF:
		hdr = append(hdr, 0x80|126, byte(n>>8), byte(n))
	default:
		hdr = append(hdr, 0x80|127)
		var b [8]byte
		binary.BigEndian.PutUint64(b[:], uint64(n))
		hdr = append(hdr, b[:]...)
	}
	var mask [4]byte
	_, _ = rand.Read(mask[:])
	hdr = append(hdr, mask[:]...)
	out := make([]byte, n)
	for i := range data {
		out[i] = data[i] ^ mask[i%4]
	}
	_, err := conn.Write(append(hdr, out...))
	return err
}

func wsRead(rd *bufio.Reader) (byte, []byte, error) {
	var h [2]byte
	if _, err := io.ReadFull(rd, h[:]); err != nil {
		return 0, nil, err
	}
	op := h[0] & 0x0f
	n := uint64(h[1] & 0x7f)
	switch n {
	case 126:
		var b [2]byte
		if _, err := io.ReadFull(rd, b[:]); err != nil {
			return 0, nil, err
		}
		n = uint64(binary.BigEndian.Uint16(b[:]))
	case 127:
		var b [8]byte
		if _, err := io.ReadFull(rd, b[:]); err != nil {
			return 0, nil, err
		}
		n = binary.BigEndian.Uint64(b[:])
	}
	if n > 64<<20 {
		return 0, nil, errors.New("frame grande demais")
	}
	buf := make([]byte, n)
	_, err := io.ReadFull(rd, buf)
	return op, buf, err
}
