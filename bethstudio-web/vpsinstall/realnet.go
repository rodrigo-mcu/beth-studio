package vpsinstall

import (
	"context"
	"net"
	"net/http"
	"time"
)

type realNet struct{}

// RealNet faz DNS e HTTPS de verdade (com validação de certificado).
func RealNet() NetChecker { return realNet{} }

func (realNet) LookupHost(ctx context.Context, host string) ([]string, error) {
	return net.DefaultResolver.LookupHost(ctx, host)
}

func (realNet) GetHTTPS(ctx context.Context, domain string) (int, error) {
	hc := &http.Client{Timeout: 15 * time.Second}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://"+domain+"/", nil)
	if err != nil {
		return 0, err
	}
	resp, err := hc.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	return resp.StatusCode, nil
}
