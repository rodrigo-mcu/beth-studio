// bethstudio-proxy fica no servidor Linux. Dois modos:
//   - -listen: escuta em 127.0.0.1:porta ou unix:, atrás do proxy HTTPS que a pessoa já tem;
//   - -tls: atende HTTPS sozinho (portas 443 e 80), com certificado Let's Encrypt
//     automático. Nenhum outro programa é necessário no servidor.
//
// Compilar: GOOS=linux GOARCH=amd64 go build -o bethstudio-proxy ./cmd/bethstudio-proxy
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"time"

	"bethstudio-web/phonelink"
)

func main() {
	listen := flag.String("listen", "", "onde escutar atrás de um proxy HTTPS seu: 127.0.0.1:8787 ou unix:/caminho/do.sock")
	useTLS := flag.Bool("tls", false, "atender HTTPS sozinho (443, e 80 para o desafio e o redirecionamento), com certificado Let's Encrypt automático; não use junto com -listen")
	acmeEmail := flag.String("acme-email", "", "e-mail de contato para a Let's Encrypt (opcional, só com -tls)")
	acmeStaging := flag.Bool("acme-staging", false, "usa a Let's Encrypt de testes (certificado que o navegador não aceita; para ensaiar sem estourar o limite de pedidos; só com -tls)")
	httpsAddr := flag.String("https-addr", ":443", "endereço HTTPS no modo -tls (só para testes)")
	httpAddr := flag.String("http-addr", ":80", "endereço HTTP no modo -tls (só para testes)")
	domain := flag.String("domain", "", "domínio que este serviço aceita")
	data := flag.String("data", "", "pasta da instalação (configuração e segredo)")
	asService := flag.Bool("service", false, "instala e inicia como serviço do systemd")
	flag.Parse()
	interactive := false
	if st, err := os.Stdin.Stat(); err == nil && st.Mode()&os.ModeCharDevice != 0 {
		interactive = true
	}
	cfg, err := resolveInstall(installConfig{Listen: *listen, TLS: *useTLS, Email: *acmeEmail, Staging: *acmeStaging, Domain: *domain, Data: *data, Service: *asService}, interactive, os.Stdin, os.Stdout)
	if err != nil {
		fmt.Fprintln(os.Stderr, "uso: bethstudio-proxy")
		if err != errNeedFlags {
			fmt.Fprintln(os.Stderr, "erro:", err)
		}
		fmt.Fprintln(os.Stderr, "     bethstudio-proxy -tls -domain agentes.exemplo.com -data /var/lib/bethstudio-proxy [-acme-email eu@exemplo.com] [-acme-staging]")
		fmt.Fprintln(os.Stderr, "     bethstudio-proxy -listen 127.0.0.1:8787 -domain agentes.exemplo.com -data /var/lib/bethstudio-proxy")
		fmt.Fprintln(os.Stderr, "     bethstudio-proxy -listen unix:/run/bethstudio-proxy.sock -domain agentes.exemplo.com -data /var/lib/bethstudio-proxy")
		os.Exit(2)
	}
	switch cfg.Action {
	case "start", "stop", "restart":
		if err := runCmd("systemctl", cfg.Action, "bethstudio-proxy"); err != nil {
			log.Fatal(err)
		}
		fmt.Println(serviceDone(cfg.Action))
		return
	case "remove":
		if err := removeService(serviceBin, serviceUnit, cfg.Purge, runCmd); err != nil {
			log.Fatal(err)
		}
		fmt.Println(serviceDone(cfg.Action))
		if cfg.Purge {
			fmt.Println("Pasta de dados apagada.")
		}
		return
	}
	if err := phonelink.CheckDomain(cfg.Domain); err != nil {
		log.Fatal(err)
	}
	secret, err := phonelink.LoadOrCreateSecret(cfg.Data)
	if err != nil {
		log.Fatal(err)
	}
	code := phonelink.FormatCode(cfg.Domain, secret)
	if cfg.Service {
		exe, err := os.Executable()
		if err != nil {
			log.Fatal(err)
		}
		if err := installService(cfg, exe, serviceBin, serviceUnit, runCmd); err != nil {
			log.Fatal(err)
		}
		fmt.Print(pasteInstructions(code, cfg.Domain))
		return
	}
	if cfg.TLS {
		if err := runTLS(cfg, secret, code, *httpsAddr, *httpAddr); err != nil {
			log.Fatal(err)
		}
		return
	}
	ln, err := phonelink.Listen(cfg.Listen)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Print(pasteInstructions(code, cfg.Domain))
	log.Printf("bethstudio-proxy: %s em %s, domínio %s", ln.Addr().Network(), ln.Addr().String(), cfg.Domain)
	p := &phonelink.Proxy{Domain: cfg.Domain, Secret: secret, DataDir: cfg.Data}
	srv := &http.Server{Handler: p, ReadHeaderTimeout: 15 * time.Second}
	if err := srv.Serve(ln); err != nil {
		log.Fatal(err)
	}
}

// runTLS atende HTTPS e HTTP direto na internet. O proxy roda em modo Direct:
// o IP do cliente é o da conexão, nunca um cabeçalho.
func runTLS(cfg installConfig, secret, code, httpsAddr, httpAddr string) error {
	m, err := phonelink.NewAutocert(cfg.Domain, cfg.Data, cfg.Email, cfg.Staging)
	if err != nil {
		return err
	}
	p := &phonelink.Proxy{Domain: cfg.Domain, Secret: secret, DataDir: cfg.Data, Direct: true}
	// HSTS só com certificado de produção: o de teste não é confiável no navegador.
	srvs := phonelink.NewTLSServers(p, m, cfg.Domain, !cfg.Staging)
	lnS, err := net.Listen("tcp", httpsAddr)
	if err != nil {
		return fmt.Errorf("abrir %s (a porta 443 precisa estar livre; sem ser root, o serviço precisa de CAP_NET_BIND_SERVICE): %w", httpsAddr, err)
	}
	lnH, err := net.Listen("tcp", httpAddr)
	if err != nil {
		return fmt.Errorf("abrir %s (a porta 80 precisa estar livre): %w", httpAddr, err)
	}
	fmt.Print(pasteInstructions(code, cfg.Domain))
	mode := "Let's Encrypt"
	if cfg.Staging {
		mode += " (STAGING: certificado de teste)"
	}
	log.Printf("bethstudio-proxy: HTTPS direto em %s, HTTP em %s, domínio %s, %s", lnS.Addr(), lnH.Addr(), cfg.Domain, mode)
	errc := make(chan error, 2)
	go func() { errc <- srvs.HTTP.Serve(lnH) }()
	go func() { errc <- srvs.HTTPS.ServeTLS(lnS, "", "") }()
	// pede o certificado já, sem esperar o primeiro visitante
	go func() {
		_ = phonelink.WarmCerts(context.Background(), srvs.Cfg, cfg.Domain, phonelink.DefaultWarmDelays, log.Printf)
	}()
	return <-errc
}
