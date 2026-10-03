package phonelink

import (
	"errors"
	"net"
	"os"
	"strings"
)

// ParseListen aceita "host:porta" ou "unix:/caminho" (também "unix:///caminho").
func ParseListen(spec string) (network, addr string, err error) {
	s := strings.TrimSpace(spec)
	if s == "" {
		return "", "", errors.New("endereço de escuta vazio")
	}
	if strings.HasPrefix(s, "unix://") {
		path := strings.TrimPrefix(s, "unix://")
		if path == "" {
			return "", "", errors.New("socket unix vazio")
		}
		if !strings.HasPrefix(path, "/") {
			path = "/" + path
		}
		return "unix", path, nil
	}
	if strings.HasPrefix(s, "unix:") {
		path := strings.TrimPrefix(s, "unix:")
		if path == "" {
			return "", "", errors.New("socket unix vazio")
		}
		return "unix", path, nil
	}
	if _, _, err := net.SplitHostPort(s); err != nil {
		return "", "", errors.New("use host:porta ou unix:/caminho")
	}
	return "tcp", s, nil
}

// Listen abre a porta TCP ou o unix socket. Um socket antigo no mesmo caminho é removido.
func Listen(spec string) (net.Listener, error) {
	network, addr, err := ParseListen(spec)
	if err != nil {
		return nil, err
	}
	if network == "unix" {
		_ = os.Remove(addr)
	}
	return net.Listen(network, addr)
}
