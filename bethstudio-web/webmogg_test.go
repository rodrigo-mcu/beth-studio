package main

import (
	"bytes"
	"encoding/binary"
	"testing"
)

// el monta um elemento EBML: id (com o marcador) + tamanho de 8 bytes (ou desconhecido) + dados.
func el(id uint32, data []byte, unknown bool) []byte {
	var b bytes.Buffer
	switch {
	case id > 0xFFFFFF:
		b.Write([]byte{byte(id >> 24), byte(id >> 16), byte(id >> 8), byte(id)})
	case id > 0xFFFF:
		b.Write([]byte{byte(id >> 16), byte(id >> 8), byte(id)})
	case id > 0xFF:
		b.Write([]byte{byte(id >> 8), byte(id)})
	default:
		b.WriteByte(byte(id))
	}
	if unknown {
		b.Write([]byte{0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF})
	} else {
		var sz [8]byte
		binary.BigEndian.PutUint64(sz[:], uint64(len(data)))
		sz[0] = 0x01
		b.Write(sz[:])
	}
	b.Write(data)
	return b.Bytes()
}

func uintEl(id uint32, v uint64) []byte {
	var d [8]byte
	binary.BigEndian.PutUint64(d[:], v)
	return el(id, d[:], false)
}

// opusPkt: pacote CELT de 20 ms (config 31, um quadro) com um byte de conteudo.
func opusPkt(n byte) []byte { return []byte{0xF8, n} }

func block(track byte, rel int16, pkt []byte) []byte {
	d := append([]byte{0x80 | track, byte(uint16(rel) >> 8), byte(rel), 0x80}, pkt...)
	return el(0xA3, d, false)
}

var testOpusHead = []byte{'O', 'p', 'u', 's', 'H', 'e', 'a', 'd', 1, 1, 0x38, 0x01, 0x80, 0xBB, 0, 0, 0, 0, 0}

// fakeWebm imita o MediaRecorder: Segment e Clusters de tamanho desconhecido,
// Info sem Duration, uma faixa A_OPUS com OpusHead no CodecPrivate.
func fakeWebm(packets int) []byte {
	info := append(uintEl(0x2AD7B1, 1000000), el(0x4D80, []byte("Chrome"), false)...)
	entry := append(append(append(uintEl(0xD7, 1), el(0x86, []byte("A_OPUS"), false)...),
		el(0x63A2, testOpusHead, false)...), el(0xE1, uintEl(0x9F, 1), false)...)
	tracks := el(0x1654AE6B, el(0xAE, entry, false), false)
	seg := append(el(0x1549A966, info, false), tracks...)
	var c []byte
	for i := 0; i < packets; i++ {
		if i%50 == 0 { // um cluster por segundo
			if c != nil {
				seg = append(seg, el(0x1F43B675, c, true)...)
			}
			c = uintEl(0xE7, uint64(i*20))
		}
		c = append(c, block(1, int16(i%50*20), opusPkt(byte(i)))...)
	}
	seg = append(seg, el(0x1F43B675, c, true)...)
	return append(el(0x1A45DFA3, el(0x4282, []byte("webm"), false), false), el(0x18538067, seg, true)...)
}

type oggPageInfo struct {
	typ     byte
	granule uint64
	seq     uint32
	packet  []byte
}

// parseOgg le' as paginas e confere o CRC de cada uma.
func parseOgg(t *testing.T, b []byte) []oggPageInfo {
	t.Helper()
	var pages []oggPageInfo
	for p := 0; p < len(b); {
		if len(b)-p < 27 || string(b[p:p+4]) != "OggS" {
			t.Fatalf("pagina sem OggS em %d", p)
		}
		nseg := int(b[p+26])
		size := 0
		for _, s := range b[p+27 : p+27+nseg] {
			size += int(s)
		}
		end := p + 27 + nseg + size
		page := append([]byte{}, b[p:end]...)
		want := binary.LittleEndian.Uint32(page[22:])
		copy(page[22:26], []byte{0, 0, 0, 0})
		if oggCRC(page) != want {
			t.Fatalf("CRC errado na pagina %d", len(pages))
		}
		pages = append(pages, oggPageInfo{b[p+5], binary.LittleEndian.Uint64(b[p+6:]), binary.LittleEndian.Uint32(b[p+18:]), b[p+27+nseg : end]})
		p = end
	}
	return pages
}

func TestWebmToOggKeepsEveryOpusPacket(t *testing.T) {
	ogg, ok := webmToOgg(fakeWebm(120))
	if !ok {
		t.Fatal("deveria converter")
	}
	pages := parseOgg(t, ogg)
	if len(pages) != 2+120 {
		t.Fatalf("%d paginas", len(pages))
	}
	if pages[0].typ != 0x02 || !bytes.Equal(pages[0].packet, testOpusHead) || pages[0].granule != 0 {
		t.Fatalf("primeira pagina: %+v", pages[0])
	}
	if !bytes.HasPrefix(pages[1].packet, []byte("OpusTags")) {
		t.Fatal("segunda pagina sem OpusTags")
	}
	for i, pg := range pages[2:] {
		if !bytes.Equal(pg.packet, opusPkt(byte(i))) || pg.seq != uint32(i+2) || pg.granule != uint64((i+1)*960) {
			t.Fatalf("pacote %d: %+v", i, pg)
		}
	}
	if last := pages[len(pages)-1]; last.typ != 0x04 || last.granule != 120*960 {
		t.Fatalf("ultima pagina: typ=%x granule=%d (2,4 s = %d)", last.typ, last.granule, 120*960)
	}
}

func TestWebmToOggRefusesWhatItCannotRead(t *testing.T) {
	for name, in := range map[string][]byte{
		"wav":        []byte("RIFF....WAVEfmt "),
		"vazio":      nil,
		"cortado":    fakeWebm(3)[:30],
		"sem pacote": fakeWebm(0),
	} {
		if _, ok := webmToOgg(in); ok {
			t.Fatalf("%s: nao deveria converter", name)
		}
	}
}

func TestOpusSamplesFromTOC(t *testing.T) {
	for _, c := range []struct {
		pkt  []byte
		want int
	}{
		{[]byte{0xF8}, 960},        // CELT 20 ms, 1 quadro
		{[]byte{0xF9}, 1920},       // CELT 20 ms, 2 quadros
		{[]byte{0xFB, 0x03}, 2880}, // CELT 20 ms, codigo 3 com 3 quadros
		{[]byte{0x08}, 960},        // SILK 20 ms
		{[]byte{0x18}, 2880},       // SILK 60 ms
		{[]byte{0x60}, 480},        // hibrido 10 ms
		{nil, 0},
	} {
		if got := opusSamples(c.pkt); got != c.want {
			t.Errorf("%x: %d, queria %d", c.pkt, got, c.want)
		}
	}
}
