// ws.go — minimal RFC 6455 WebSocket server in plain stdlib.
//
// Zero third-party deps. Notes: negative-length guard, and control frames
// (ping/close) interleaved inside a fragmented message are returned on
// their own instead of clobbering the partial message.
package main

import (
	"bufio"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
)

const (
	wsGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11" // RFC 6455 §1.3

	wsOpContinuation = 0x0
	wsOpText         = 0x1
	wsOpBinary       = 0x2
	wsOpClose        = 0x8
	wsOpPing         = 0x9
	wsOpPong         = 0xa

	wsMaxFrameBytes = 32 << 20 // 32 MiB
)

// wsMessage: um frame (ou unica mensagem concatenada) lido do cliente.
// Op = opCode, Data = payload.
type wsMessage struct {
	Op   byte
	Data []byte
}

// httpError devolve erro HTTP com mensagem; usado pelos handlers de upgrade.
func wsHTTPError(w http.ResponseWriter, status int, msg string) {
	http.Error(w, msg, status)
}

// upgradeResponseController: tenta o caminho "moderno" (Go 1.20+),
// cai de volta no Hijacker interface (mais antigo) se nao estiver disponivel.
func upgradeHijack(w http.ResponseWriter, r *http.Request) (net.Conn, *bufio.ReadWriter, error) {
	// Caminho preferido: http.NewResponseController (Go 1.20+).
	// Ele cobre TLS unwrapping e HTTP/2 (que nao pode ser hijacked; retornara
	// erro, e a gente tenta a via classica).
	if rc := http.NewResponseController(w); rc != nil {
		conn, rw, err := rc.Hijack()
		if err == nil {
			return conn, rw, nil
		}
		// HTTP/2 nao suporta hijack — cai pro fallback abaixo.
	}
	// Fallback classico: type-assert para Hijacker.
	hj, ok := w.(http.Hijacker)
	if !ok {
		return nil, nil, errors.New("websocket: ResponseWriter nao suporta Hijack")
	}
	return hj.Hijack()
}

// wsUpgrade: faz o handshake HTTP -> WebSocket. Retorna o net.Conn e um
// bufio.Reader/Writer para I/O. O caller e' dono do conn.
func wsUpgrade(w http.ResponseWriter, r *http.Request) (net.Conn, *bufio.ReadWriter, error) {
	// Validações minimas antes de gastar o upgrade.
	if strings.ToLower(r.Header.Get("Upgrade")) != "websocket" {
		wsHTTPError(w, http.StatusBadRequest, "header Upgrade: websocket ausente")
		return nil, nil, errors.New("missing Upgrade header")
	}
	if !strings.Contains(strings.ToLower(r.Header.Get("Connection")), "upgrade") {
		wsHTTPError(w, http.StatusBadRequest, "header Connection: upgrade ausente")
		return nil, nil, errors.New("missing Connection: upgrade")
	}
	key := r.Header.Get("Sec-WebSocket-Key")
	if key == "" {
		wsHTTPError(w, http.StatusBadRequest, "Sec-WebSocket-Key ausente")
		return nil, nil, errors.New("missing Sec-WebSocket-Key")
	}

	conn, rw, err := upgradeHijack(w, r)
	if err != nil {
		// Nao conseguimos responder 400 porque o handshake ja' foi
		// parcialmente processado; apenas propagamos o erro.
		return nil, nil, fmt.Errorf("hijack: %w", err)
	}

	// Calcula Sec-WebSocket-Accept = base64(sha1(key + GUID))
	h := sha1.New()
	h.Write([]byte(key))
	h.Write([]byte(wsGUID))
	accept := base64.StdEncoding.EncodeToString(h.Sum(nil))

	resp := "HTTP/1.1 101 Switching Protocols\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Accept: " + accept + "\r\n" +
		"\r\n"
	if _, err := rw.WriteString(resp); err != nil {
		_ = conn.Close()
		return nil, nil, fmt.Errorf("write 101: %w", err)
	}
	if err := rw.Flush(); err != nil {
		_ = conn.Close()
		return nil, nil, fmt.Errorf("flush 101: %w", err)
	}
	return conn, rw, nil
}

// wsWriteFrame: escreve um unico frame (server -> client, nao precisa mask).
func wsWriteFrame(w *bufio.Writer, op byte, data []byte) error {
	var header []byte
	// 1 bit FIN + 4 bits RSV/Op. RSV sempre 0.
	header = append(header, 0x80|op) // FIN=1
	// Length. 7-bit se < 126; 16-bit extended se <= 65535; 64-bit senao.
	n := len(data)
	switch {
	case n < 126:
		header = append(header, byte(n))
	case n <= 0xFFFF:
		header = append(header, 126, 0, 0)
		binary.BigEndian.PutUint16(header[len(header)-2:], uint16(n))
	default:
		header = append(header, 127, 0, 0, 0, 0, 0, 0, 0, 0)
		binary.BigEndian.PutUint64(header[len(header)-8:], uint64(n))
	}
	if _, err := w.Write(header); err != nil {
		return err
	}
	if n > 0 {
		if _, err := w.Write(data); err != nil {
			return err
		}
	}
	return w.Flush()
}

// wsWriteText/Close/Ping: helpers que ja' montam op code.
func wsWriteText(w *bufio.Writer, data []byte) error   { return wsWriteFrame(w, wsOpText, data) }
func wsWriteBinary(w *bufio.Writer, data []byte) error { return wsWriteFrame(w, wsOpBinary, data) }
func wsWriteClose(w *bufio.Writer, code int, reason string) error {
	buf := make([]byte, 2+len(reason))
	binary.BigEndian.PutUint16(buf[:2], uint16(code))
	copy(buf[2:], reason)
	return wsWriteFrame(w, wsOpClose, buf)
}
func wsWritePing(w *bufio.Writer, data []byte) error { return wsWriteFrame(w, wsOpPing, data) }

// wsReadMessage: le UMA mensagem (pode consistir de varios frames se a
// fragmentacao for usada). Para nosso caso (terminal), quase sempre sera
// 1 frame = 1 mensagem.
//
// Mascara: cliente -> server SEMPRE e' masked (RFC 6455 §5.1). O servidor
// tem que validar isso e retornar 1002 (protocol error) se nao estiver.
func wsReadMessage(r *bufio.Reader) (wsMessage, error) {
	var msg wsMessage
	for {
		var hdr [2]byte
		if _, err := io.ReadFull(r, hdr[:]); err != nil {
			return msg, err
		}
		fin := hdr[0]&0x80 != 0
		op := hdr[0] & 0x0F
		masked := hdr[1]&0x80 != 0
		plen := int(hdr[1] & 0x7F)
		switch plen {
		case 126:
			var ext [2]byte
			if _, err := io.ReadFull(r, ext[:]); err != nil {
				return msg, err
			}
			plen = int(binary.BigEndian.Uint16(ext[:]))
		case 127:
			var ext [8]byte
			if _, err := io.ReadFull(r, ext[:]); err != nil {
				return msg, err
			}
			plen = int(binary.BigEndian.Uint64(ext[:]))
		}
		if plen < 0 || plen > wsMaxFrameBytes {
			return msg, fmt.Errorf("frame payload %d > max %d", plen, wsMaxFrameBytes)
		}
		var maskKey [4]byte
		if masked {
			if _, err := io.ReadFull(r, maskKey[:]); err != nil {
				return msg, err
			}
		} else {
			// Server exige mask de cliente. Se faltar, fecha.
			return msg, errors.New("cliente mandou frame nao-mascarado")
		}
		payload := make([]byte, plen)
		if plen > 0 {
			if _, err := io.ReadFull(r, payload); err != nil {
				return msg, err
			}
			if masked {
				for i, b := range payload {
					payload[i] = b ^ maskKey[i%4]
				}
			}
		}
		// Control frame (close/ping/pong) may arrive between fragments:
		// return it on its own (control frames are never fragmented).
		if op >= wsOpClose {
			return wsMessage{Op: op, Data: payload}, nil
		}
		// Continuation frame de uma mensagem fragmentada: concatenamos.
		if op == wsOpContinuation {
			msg.Data = append(msg.Data, payload...)
		} else {
			// Primeiro frame de uma mensagem nova (text/binary/close/ping/pong).
			msg.Op = op
			msg.Data = payload
		}
		if fin {
			return msg, nil
		}
	}
}

// wsWritePong: helper. Como wsReadMessage nao tem acesso ao writer,
// chamamos isso externamente quando recebemos um ping.
func wsWritePong(w *bufio.Writer, data []byte) error { return wsWriteFrame(w, wsOpPong, data) }
