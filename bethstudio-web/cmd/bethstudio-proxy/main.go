// bethstudio-proxy fica no servidor Linux, atrás do proxy que a pessoa já tem.
// Compilar: GOOS=linux GOARCH=amd64 go build -o bethstudio-proxy ./cmd/bethstudio-proxy
package main

import (
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"time"

	"bethstudio-web/phonelink"
)

func main() {
	listen := flag.String("listen", "", "onde escutar: 127.0.0.1:8787 ou unix:/caminho/do.sock")
	domain := flag.String("domain", "", "domínio que este serviço aceita")
	data := flag.String("data", "", "pasta da instalação (configuração e segredo)")
	asService := flag.Bool("service", false, "instala e inicia como serviço do systemd")
	flag.Parse()
	interactive := false
	if st, err := os.Stdin.Stat(); err == nil && st.Mode()&os.ModeCharDevice != 0 {
		interactive = true
	}
	cfg, err := resolveInstall(installConfig{Listen: *listen, Domain: *domain, Data: *data, Service: *asService}, interactive, os.Stdin, os.Stdout)
	if err != nil {
		fmt.Fprintln(os.Stderr, "uso: bethstudio-proxy")
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
