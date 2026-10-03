package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/subtle"
	"encoding/base32"
	"encoding/binary"
	"fmt"
	"net/url"
	"strings"
	"time"
)

// Segundo fator do Studio remoto: TOTP (RFC 6238), SHA-1, 6 dígitos, 30 s.
// É o que Google Authenticator, Microsoft Authenticator, 1Password e Aegis
// entendem pelo QR "otpauth://".

const (
	totpStep   = 30
	totpDigits = 6
)

var totpB32 = base32.StdEncoding.WithPadding(base32.NoPadding)

func newTOTPSecret() (string, error) {
	b := make([]byte, 20)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return totpB32.EncodeToString(b), nil
}

func totpKey(secret string) ([]byte, error) {
	s := strings.ToUpper(strings.ReplaceAll(strings.TrimSpace(secret), " ", ""))
	return totpB32.DecodeString(strings.TrimRight(s, "="))
}

func totpAt(key []byte, counter uint64) string {
	var msg [8]byte
	binary.BigEndian.PutUint64(msg[:], counter)
	m := hmac.New(sha1.New, key)
	m.Write(msg[:])
	sum := m.Sum(nil)
	off := sum[len(sum)-1] & 0x0f
	v := binary.BigEndian.Uint32(sum[off:off+4]) & 0x7fffffff
	return fmt.Sprintf("%06d", v%1000000)
}

func totpCounter(t time.Time) uint64 {
	return uint64(t.Unix()) / totpStep
}

// totpCheck aceita o código do passo atual e de um passo antes/depois
// (relógio do celular um pouco fora). Devolve o passo que bateu, para não
// aceitar o mesmo código duas vezes.
func totpCheck(secret, code string, now time.Time) (uint64, bool) {
	code = strings.ReplaceAll(strings.TrimSpace(code), " ", "")
	if len(code) != totpDigits {
		return 0, false
	}
	key, err := totpKey(secret)
	if err != nil || len(key) == 0 {
		return 0, false
	}
	c := totpCounter(now)
	for _, d := range []int64{0, -1, 1} {
		n := uint64(int64(c) + d)
		if subtle.ConstantTimeCompare([]byte(totpAt(key, n)), []byte(code)) == 1 {
			return n, true
		}
	}
	return 0, false
}

// totpURI: o que vai no QR.
func totpURI(secret, account string) string {
	v := url.Values{}
	v.Set("secret", secret)
	v.Set("issuer", "Beth Studio")
	v.Set("algorithm", "SHA1")
	v.Set("digits", "6")
	v.Set("period", "30")
	return "otpauth://totp/" + url.PathEscape("Beth Studio:"+account) + "?" + v.Encode()
}
