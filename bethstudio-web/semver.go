package main

import (
	"errors"
	"strconv"
	"strings"
	"unicode"
)

// semver é o pedaço do Semantic Versioning 2.0 que a consulta de release
// precisa: MAJOR.MINOR.PATCH, pré-lançamento e metadado de build ignorado
// na comparação. Não é um parser geral de intervalos.
type semver struct {
	major, minor, patch int
	pre                 []string
}

func parseSemver(raw string) (semver, error) {
	s := strings.TrimSpace(raw)
	if s == "" || strings.EqualFold(s, "dev") {
		return semver{}, errors.New("versão de desenvolvimento")
	}
	s = strings.TrimPrefix(s, "v")
	if i := strings.IndexByte(s, '+'); i >= 0 {
		s = s[:i]
	}
	var pre string
	if i := strings.IndexByte(s, '-'); i >= 0 {
		pre = s[i+1:]
		s = s[:i]
		if pre == "" {
			return semver{}, errors.New("pré-lançamento vazio")
		}
	}
	parts := strings.Split(s, ".")
	if len(parts) != 3 {
		return semver{}, errors.New("semver inválida")
	}
	maj, err := parseSemverNum(parts[0])
	if err != nil {
		return semver{}, err
	}
	min, err := parseSemverNum(parts[1])
	if err != nil {
		return semver{}, err
	}
	pat, err := parseSemverNum(parts[2])
	if err != nil {
		return semver{}, err
	}
	var idents []string
	if pre != "" {
		idents = strings.Split(pre, ".")
		for _, id := range idents {
			if id == "" || !semverIdentOK(id) {
				return semver{}, errors.New("pré-lançamento inválido")
			}
		}
	}
	return semver{major: maj, minor: min, patch: pat, pre: idents}, nil
}

func parseSemverNum(s string) (int, error) {
	if s == "" || (len(s) > 1 && s[0] == '0') {
		return 0, errors.New("número inválido")
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return 0, errors.New("número inválido")
		}
	}
	n, err := strconv.Atoi(s)
	if err != nil {
		return 0, errors.New("número inválido")
	}
	return n, nil
}

func semverIdentOK(s string) bool {
	for _, r := range s {
		if !unicode.IsDigit(r) && !unicode.IsLetter(r) && r != '-' {
			return false
		}
	}
	return true
}

func (v semver) cmp(o semver) int {
	if c := cmpInt(v.major, o.major); c != 0 {
		return c
	}
	if c := cmpInt(v.minor, o.minor); c != 0 {
		return c
	}
	if c := cmpInt(v.patch, o.patch); c != 0 {
		return c
	}
	// Sem pré-lançamento é maior do que com pré-lançamento.
	if len(v.pre) == 0 && len(o.pre) == 0 {
		return 0
	}
	if len(v.pre) == 0 {
		return 1
	}
	if len(o.pre) == 0 {
		return -1
	}
	n := len(v.pre)
	if len(o.pre) < n {
		n = len(o.pre)
	}
	for i := 0; i < n; i++ {
		if c := cmpSemverIdent(v.pre[i], o.pre[i]); c != 0 {
			return c
		}
	}
	return cmpInt(len(v.pre), len(o.pre))
}

func cmpInt(a, b int) int {
	if a < b {
		return -1
	}
	if a > b {
		return 1
	}
	return 0
}

func cmpSemverIdent(a, b string) int {
	an, aNum := identNum(a)
	bn, bNum := identNum(b)
	if aNum && bNum {
		return cmpInt(an, bn)
	}
	if aNum && !bNum {
		return -1
	}
	if !aNum && bNum {
		return 1
	}
	if a < b {
		return -1
	}
	if a > b {
		return 1
	}
	return 0
}

func identNum(s string) (int, bool) {
	if s == "" {
		return 0, false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return 0, false
		}
	}
	n, err := strconv.Atoi(s)
	if err != nil {
		return 0, false
	}
	return n, true
}

// compareSemver devolve -1, 0 ou 1. Erro se alguma das duas não for semver
// (inclusive "dev" e vazio).
func compareSemver(a, b string) (int, error) {
	av, err := parseSemver(a)
	if err != nil {
		return 0, err
	}
	bv, err := parseSemver(b)
	if err != nil {
		return 0, err
	}
	return av.cmp(bv), nil
}

// releaseIsNewer diz se o release publicado é mais novo que a cópia que está
// rodando. "dev", vazio ou qualquer texto que não seja semver contam como
// mais antigos que um release válido, para a consulta não quebrar. Uma tag
// ilegível nunca conta como atualização.
func releaseIsNewer(latest, current string) bool {
	if _, err := parseSemver(latest); err != nil {
		return false
	}
	cur := strings.TrimSpace(current)
	if cur == "" || strings.EqualFold(cur, "dev") {
		return true
	}
	cmp, err := compareSemver(latest, current)
	if err != nil {
		return true
	}
	return cmp > 0
}
