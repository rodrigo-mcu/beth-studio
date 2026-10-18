// Package vpsinstall instala o bethstudio-proxy num VPS Linux limpo (com Caddy
// e DNS na Cloudflare). Nada aqui grava segredo em disco nem em log.
package vpsinstall

import (
	"errors"
	"net"
	"regexp"
	"strings"
)

var (
	labelRe = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)
	userRe  = regexp.MustCompile(`^[a-z_][a-z0-9_-]{0,31}$`)
)

// NormalizeDomain devolve o nome em minúsculas, sem ponto final.
func NormalizeDomain(d string) string {
	return strings.TrimSuffix(strings.ToLower(strings.TrimSpace(d)), ".")
}

// ValidateDomain aceita só nomes DNS com letras, dígitos e hífen (sem IP, sem porta,
// sem esquema), com pelo menos dois rótulos.
func ValidateDomain(d string) error {
	d = NormalizeDomain(d)
	if d == "" || len(d) > 253 {
		return errors.New("domínio inválido")
	}
	if net.ParseIP(d) != nil {
		return errors.New("use um nome (agentes.exemplo.com), não um IP")
	}
	labels := strings.Split(d, ".")
	if len(labels) < 2 {
		return errors.New("o domínio precisa ter pelo menos dois pedaços (agentes.exemplo.com)")
	}
	for _, l := range labels {
		if !labelRe.MatchString(l) {
			return errors.New("domínio inválido: só letras, números e hífen, sem espaço, esquema nem porta")
		}
	}
	return nil
}

// ValidateHost aceita IP (v4 ou v6, sem colchetes) ou nome DNS.
func ValidateHost(h string) error {
	h = strings.TrimSpace(h)
	if h == "" {
		return errors.New("informe o IP ou o nome do servidor")
	}
	if net.ParseIP(h) != nil {
		return nil
	}
	if err := ValidateDomain(h); err != nil {
		return errors.New("endereço do servidor inválido: use um IP ou um nome sem esquema nem porta")
	}
	return nil
}

func ValidateUser(u string) error {
	if !userRe.MatchString(u) {
		return errors.New("usuário inválido: letras minúsculas, números, _ e -")
	}
	return nil
}

func ValidatePort(p int) error {
	if p < 1 || p > 65535 {
		return errors.New("porta inválida")
	}
	return nil
}

// DomainInZone confere que o domínio é a zona ou um subdomínio dela.
func DomainInZone(domain, zone string) bool {
	domain, zone = NormalizeDomain(domain), NormalizeDomain(zone)
	return zone != "" && (domain == zone || strings.HasSuffix(domain, "."+zone))
}

// shQuote protege um argumento para o shell (aspas simples). Só serve para
// valores já validados; comandos são fixos.
func shQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
