package phonelink

import (
	"bufio"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

const wsGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

var randReader io.Reader = rand.Reader

func wsAccept(key string) string {
	sum := sha1.Sum([]byte(key + wsGUID))
	return base64.StdEncoding.EncodeToString(sum[:])
}

// wsPipe é um net.Conn em cima de frames binários de WebSocket.
// client=true mascara o que escreve (papel do Beth Studio).
type wsPipe struct {
	conn    net.Conn
	r       *bufio.Reader
	w       *bufio.Writer
	client  bool
	readMu  sync.Mutex
	writeMu sync.Mutex
	pend    []byte
}

func newWSPipe(conn net.Conn, r *bufio.Reader, w *bufio.Writer, client bool) *wsPipe {
	if r == nil {
		r = bufio.NewReader(conn)
	}
	if w == nil {
		w = bufio.NewWriter(conn)
	}
	return &wsPipe{conn: conn, r: r, w: w, client: client}
}

func (p *wsPipe) Read(b []byte) (int, error) {
	p.readMu.Lock()
	defer p.readMu.Unlock()
	for len(p.pend) == 0 {
		data, err := p.readData()
		if err != nil {
			return 0, err
		}
		p.pend = data
	}
	n := copy(b, p.pend)
	p.pend = p.pend[n:]
	return n, nil
}

func (p *wsPipe) Write(b []byte) (int, error) {
	p.writeMu.Lock()
	defer p.writeMu.Unlock()
	if err := p.writeFrame(0x2, b); err != nil {
		return 0, err
	}
	return len(b), nil
}

func (p *wsPipe) Close() error                       { return p.conn.Close() }
func (p *wsPipe) LocalAddr() net.Addr                { return p.conn.LocalAddr() }
func (p *wsPipe) RemoteAddr() net.Addr               { return p.conn.RemoteAddr() }
func (p *wsPipe) SetDeadline(t time.Time) error      { return p.conn.SetDeadline(t) }
func (p *wsPipe) SetReadDeadline(t time.Time) error  { return p.conn.SetReadDeadline(t) }
func (p *wsPipe) SetWriteDeadline(t time.Time) error { return p.conn.SetWriteDeadline(t) }

func (p *wsPipe) readData() ([]byte, error) {
	var out []byte
	for {
		fin, op, payload, err := p.readFrame()
		if err != nil {
			return nil, err
		}
		switch op {
		case 0x9: // ping
			p.writeMu.Lock()
			err = p.writeFrame(0xA, payload)
			p.writeMu.Unlock()
			if err != nil {
				return nil, err
			}
			continue
		case 0xA: // pong
			continue
		case 0x8: // close
			return nil, io.EOF
		case 0x0, 0x1, 0x2:
			out = append(out, payload...)
			if fin {
				return out, nil
			}
		default:
			continue
		}
	}
}

func (p *wsPipe) readFrame() (fin bool, op byte, payload []byte, err error) {
	var hdr [2]byte
	if _, err = io.ReadFull(p.r, hdr[:]); err != nil {
		return
	}
	fin = hdr[0]&0x80 != 0
	op = hdr[0] & 0x0F
	masked := hdr[1]&0x80 != 0
	if p.client == masked {
		// O Studio (client) lê frames sem máscara. O proxy lê frames com máscara.
		err = errors.New("máscara de websocket inesperada")
		return
	}
	n := int(hdr[1] & 0x7F)
	switch n {
	case 126:
		var ext [2]byte
		if _, err = io.ReadFull(p.r, ext[:]); err != nil {
			return
		}
		n = int(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err = io.ReadFull(p.r, ext[:]); err != nil {
			return
		}
		n = int(binary.BigEndian.Uint64(ext[:]))
	}
	if n < 0 || n > 32<<20 {
		err = fmt.Errorf("frame grande demais (%d)", n)
		return
	}
	var mask [4]byte
	if masked {
		if _, err = io.ReadFull(p.r, mask[:]); err != nil {
			return
		}
	}
	payload = make([]byte, n)
	if n > 0 {
		if _, err = io.ReadFull(p.r, payload); err != nil {
			return
		}
		if masked {
			for i := range payload {
				payload[i] ^= mask[i%4]
			}
		}
	}
	return
}

func (p *wsPipe) writeFrame(op byte, data []byte) error {
	header := []byte{0x80 | op}
	n := len(data)
	maskBit := byte(0)
	if p.client {
		maskBit = 0x80
	}
	switch {
	case n < 126:
		header = append(header, maskBit|byte(n))
	case n <= 0xFFFF:
		header = append(header, maskBit|126, 0, 0)
		binary.BigEndian.PutUint16(header[len(header)-2:], uint16(n))
	default:
		header = append(header, maskBit|127, 0, 0, 0, 0, 0, 0, 0, 0)
		binary.BigEndian.PutUint64(header[len(header)-8:], uint64(n))
	}
	var mask [4]byte
	if p.client {
		if _, err := io.ReadFull(randReader, mask[:]); err != nil {
			return err
		}
		header = append(header, mask[:]...)
		data = append([]byte(nil), data...)
		for i := range data {
			data[i] ^= mask[i%4]
		}
	}
	if _, err := p.w.Write(header); err != nil {
		return err
	}
	if len(data) > 0 {
		if _, err := p.w.Write(data); err != nil {
			return err
		}
	}
	return p.w.Flush()
}

// upgradeServer conclui o handshake WebSocket. O caller fica dono do pipe.
func upgradeServer(w http.ResponseWriter, r *http.Request) (*wsPipe, error) {
	if strings.ToLower(r.Header.Get("Upgrade")) != "websocket" {
		http.Error(w, "header Upgrade: websocket ausente", http.StatusBadRequest)
		return nil, errors.New("sem upgrade")
	}
	if !strings.Contains(strings.ToLower(r.Header.Get("Connection")), "upgrade") {
		http.Error(w, "header Connection: upgrade ausente", http.StatusBadRequest)
		return nil, errors.New("sem connection")
	}
	key := r.Header.Get("Sec-WebSocket-Key")
	if key == "" {
		http.Error(w, "Sec-WebSocket-Key ausente", http.StatusBadRequest)
		return nil, errors.New("sem key")
	}
	hj, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "hijack indisponível", http.StatusInternalServerError)
		return nil, errors.New("sem hijack")
	}
	conn, rw, err := hj.Hijack()
	if err != nil {
		return nil, err
	}
	accept := wsAccept(key)
	if _, err := rw.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n"); err != nil {
		_ = conn.Close()
		return nil, err
	}
	if err := rw.Flush(); err != nil {
		_ = conn.Close()
		return nil, err
	}
	return newWSPipe(conn, rw.Reader, rw.Writer, false), nil
}
