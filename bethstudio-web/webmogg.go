package main

// webmogg.go - o MediaRecorder grava Opus dentro de webm (Matroska). A
// MiniMax (asr-1.0) so' aceita wav, aiff, flac, alac, mp3, aac, opus e ogg.
// Aqui os pacotes Opus do webm sao remontados em Ogg Opus (RFC 7845), sem
// recodificar: o audio e' o mesmo, so' muda o conteiner. Testado em
// webmogg_test.go.

import (
	"encoding/binary"
)

const (
	ebmlID          = 0x1A45DFA3
	ebmlSegment     = 0x18538067
	ebmlTracks      = 0x1654AE6B
	ebmlTrackEntry  = 0xAE
	ebmlTrackNumber = 0xD7
	ebmlCodecID     = 0x86
	ebmlCodecPriv   = 0x63A2
	ebmlAudio       = 0xE1
	ebmlChannels    = 0x9F
	ebmlCluster     = 0x1F43B675
	ebmlSimpleBlock = 0xA3
	ebmlBlockGroup  = 0xA0
	ebmlBlock       = 0xA1
)

// readVint le' um inteiro de tamanho variavel do EBML. keepMarker=true para
// IDs (o primeiro bit fica no valor); false para tamanhos.
func readVint(b []byte, keepMarker bool) (v uint64, n int, ok bool) {
	if len(b) == 0 || b[0] == 0 {
		return 0, 0, false
	}
	for n = 1; n <= 8 && b[0]&(0x80>>(n-1)) == 0; n++ {
	}
	if n > 8 || len(b) < n {
		return 0, 0, false
	}
	v = uint64(b[0])
	if !keepMarker {
		v &= uint64(0xFF >> n)
	}
	for _, c := range b[1:n] {
		v = v<<8 | uint64(c)
	}
	return v, n, true
}

// ebmlHeader: id, tamanho dos dados (-1 = desconhecido) e tamanho do cabecalho.
func ebmlHeader(b []byte, off int) (id uint64, size int64, hdr int, ok bool) {
	id, n, ok := readVint(b[off:], true)
	if !ok {
		return 0, 0, 0, false
	}
	sz, m, ok := readVint(b[off+n:], false)
	if !ok {
		return 0, 0, 0, false
	}
	if sz == 1<<(7*uint(m))-1 {
		return id, -1, n + m, true
	}
	return id, int64(sz), n + m, true
}

func ebmlUint(b []byte) uint64 {
	var v uint64
	for _, c := range b {
		v = v<<8 | uint64(c)
	}
	return v
}

// ebmlChildren chama f para cada filho de tamanho conhecido em b; false se a estrutura nao fecha.
func ebmlChildren(b []byte, f func(id uint64, data []byte)) bool {
	for p := 0; p < len(b); {
		id, sz, hdr, ok := ebmlHeader(b, p)
		if !ok || sz < 0 || p+hdr+int(sz) > len(b) {
			return false
		}
		f(id, b[p+hdr:p+hdr+int(sz)])
		p += hdr + int(sz)
	}
	return true
}

var clusterChild = map[uint64]bool{0xE7: true, ebmlSimpleBlock: true, ebmlBlockGroup: true, 0xA7: true, 0xAB: true, 0xEC: true, 0xBF: true}

// webmOpus: faixa Opus do webm (numero, CodecPrivate = OpusHead, canais) e
// os pacotes dela na ordem. ok=false se nao for webm com Opus sem lacing.
func webmOpus(b []byte) (head []byte, channels int, packets [][]byte, ok bool) {
	id, size, hdr, ok := ebmlHeader(b, 0)
	if !ok || id != ebmlID || size < 0 || int64(hdr)+size > int64(len(b)) {
		return nil, 0, nil, false
	}
	segOff := hdr + int(size)
	id, segSize, segHdr, ok := ebmlHeader(b, segOff)
	if !ok || id != ebmlSegment {
		return nil, 0, nil, false
	}
	end := len(b)
	if segSize >= 0 && int64(segOff+segHdr)+segSize < int64(end) {
		end = segOff + segHdr + int(segSize)
	}
	track := uint64(0)
	channels = 1
	addBlock := func(d []byte) bool {
		tn, n, ok := readVint(d, false)
		if !ok || len(d) < n+3 {
			return false
		}
		if tn != track {
			return true
		}
		if d[n+2]&0x06 != 0 { // lacing: o MediaRecorder nao usa
			return false
		}
		packets = append(packets, d[n+3:])
		return true
	}
	for off := segOff + segHdr; off < end; {
		id, size, hdr, ok := ebmlHeader(b, off)
		if !ok {
			return nil, 0, nil, false
		}
		data := off + hdr
		switch {
		case id == ebmlTracks && size >= 0 && data+int(size) <= end:
			ebmlChildren(b[data:data+int(size)], func(id uint64, entry []byte) {
				if id != ebmlTrackEntry || track != 0 {
					return
				}
				var num uint64
				var codec string
				var priv []byte
				ch := 0
				ebmlChildren(entry, func(id uint64, d []byte) {
					switch id {
					case ebmlTrackNumber:
						num = ebmlUint(d)
					case ebmlCodecID:
						codec = string(d)
					case ebmlCodecPriv:
						priv = d
					case ebmlAudio:
						ebmlChildren(d, func(id uint64, a []byte) {
							if id == ebmlChannels {
								ch = int(ebmlUint(a))
							}
						})
					}
				})
				if codec == "A_OPUS" && num > 0 {
					track, head = num, priv
					if ch > 0 {
						channels = ch
					}
				}
			})
			off = data + int(size)
		case id == ebmlCluster:
			if track == 0 {
				return nil, 0, nil, false
			}
			cend := end
			if size >= 0 {
				cend = min(end, data+int(size))
			}
			p := data
			for p < cend {
				cid, csz, chdr, ok := ebmlHeader(b, p)
				if !ok || (size < 0 && !clusterChild[cid]) {
					break // cluster de tamanho desconhecido termina no proximo elemento de nivel 1
				}
				if csz < 0 || p+chdr+int(csz) > cend {
					return nil, 0, nil, false
				}
				d := b[p+chdr : p+chdr+int(csz)]
				switch cid {
				case ebmlSimpleBlock:
					if !addBlock(d) {
						return nil, 0, nil, false
					}
				case ebmlBlockGroup:
					good := true
					ebmlChildren(d, func(id uint64, blk []byte) {
						if id == ebmlBlock && !addBlock(blk) {
							good = false
						}
					})
					if !good {
						return nil, 0, nil, false
					}
				}
				p += chdr + int(csz)
			}
			off = p
		default:
			if size < 0 {
				return nil, 0, nil, false
			}
			off = data + int(size)
		}
	}
	if track == 0 || len(packets) == 0 {
		return nil, 0, nil, false
	}
	return head, channels, packets, true
}

// opusSamples: amostras (a 48 kHz) de um pacote Opus, pelo byte TOC (RFC 6716 3.1).
func opusSamples(p []byte) int {
	if len(p) == 0 {
		return 0
	}
	config := p[0] >> 3
	var frame int
	switch {
	case config < 12: // SILK: 10, 20, 40, 60 ms
		frame = []int{480, 960, 1920, 2880}[config&3]
	case config < 16: // hibrido: 10, 20 ms
		frame = []int{480, 960}[config&1]
	default: // CELT: 2,5, 5, 10, 20 ms
		frame = []int{120, 240, 480, 960}[config&3]
	}
	switch p[0] & 3 {
	case 0:
		return frame
	case 1, 2:
		return 2 * frame
	}
	if len(p) < 2 {
		return 0
	}
	return frame * int(p[1]&0x3F)
}

var oggCRCTable = func() (t [256]uint32) {
	for i := range t {
		r := uint32(i) << 24
		for range 8 {
			if r&0x80000000 != 0 {
				r = r<<1 ^ 0x04C11DB7
			} else {
				r <<= 1
			}
		}
		t[i] = r
	}
	return
}()

func oggCRC(b []byte) uint32 {
	var c uint32
	for _, x := range b {
		c = c<<8 ^ oggCRCTable[byte(c>>24)^x]
	}
	return c
}

// oggPage: uma pagina com um pacote inteiro (pacotes Opus cabem em 255 segmentos).
func oggPage(out []byte, typ byte, granule uint64, serial, seq uint32, packet []byte) []byte {
	start := len(out)
	out = append(out, 'O', 'g', 'g', 'S', 0, typ)
	out = binary.LittleEndian.AppendUint64(out, granule)
	out = binary.LittleEndian.AppendUint32(out, serial)
	out = binary.LittleEndian.AppendUint32(out, seq)
	out = append(out, 0, 0, 0, 0) // CRC, preenchido no fim
	nseg := len(packet)/255 + 1
	out = append(out, byte(nseg))
	for range nseg - 1 {
		out = append(out, 255)
	}
	out = append(out, byte(len(packet)%255))
	out = append(out, packet...)
	binary.LittleEndian.PutUint32(out[start+22:], oggCRC(out[start:]))
	return out
}

// webmToOgg devolve o Opus do webm num arquivo Ogg Opus. ok=false (e nada
// muda) quando nao e' webm com Opus que de' para ler.
func webmToOgg(b []byte) ([]byte, bool) {
	head, channels, packets, ok := webmOpus(b)
	if !ok {
		return nil, false
	}
	for _, p := range packets {
		if len(p) > 255*254 {
			return nil, false
		}
	}
	if len(head) < 19 || string(head[:8]) != "OpusHead" {
		head = []byte{'O', 'p', 'u', 's', 'H', 'e', 'a', 'd', 1, byte(channels), 0, 0, 0x80, 0xBB, 0, 0, 0, 0, 0}
	}
	tags := append([]byte("OpusTags"), 11, 0, 0, 0)
	tags = append(tags, "Beth Studio"...)
	tags = append(tags, 0, 0, 0, 0)

	const serial = 0x42455448 // "BETH"
	out := make([]byte, 0, len(b)+len(packets)*28+256)
	out = oggPage(out, 0x02, 0, serial, 0, head)
	out = oggPage(out, 0x00, 0, serial, 1, tags)
	var granule uint64
	for i, p := range packets {
		granule += uint64(opusSamples(p))
		typ := byte(0)
		if i == len(packets)-1 {
			typ = 0x04
		}
		out = oggPage(out, typ, granule, serial, uint32(i+2), p)
	}
	return out, true
}
