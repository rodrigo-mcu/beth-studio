package main

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"strings"

	"bethstudio-web/phonelink"
)

type installConfig struct {
	Listen  string
	Domain  string
	Data    string
	Service bool
	// Action vazio configura ou executa. start, stop, restart e remove falam com o systemd.
	Action string
	// Purge apaga a pasta de dados ao remover o serviço.
	Purge bool
}

var errNeedFlags = errors.New("faltam opções")

func resolveInstall(preset installConfig, interactive bool, in io.Reader, out io.Writer) (installConfig, error) {
	if complete(preset) {
		return preset, nil
	}
	if !interactive {
		return installConfig{}, errNeedFlags
	}
	return askInstall(bufio.NewReader(in), out, preset)
}

func complete(c installConfig) bool {
	return c.Listen != "" && c.Domain != "" && c.Data != ""
}

func askInstall(in *bufio.Reader, out io.Writer, preset installConfig) (installConfig, error) {
	fmt.Fprintln(out, "Beth Studio — proxy do celular")
	fmt.Fprintln(out, "Aperte Enter para aceitar o que está entre colchetes.")
	fmt.Fprintln(out)
	fmt.Fprintln(out, "O que fazer?")
	fmt.Fprintln(out, "  1) Instalar ou reconfigurar")
	fmt.Fprintln(out, "  2) Iniciar o serviço")
	fmt.Fprintln(out, "  3) Parar o serviço")
	fmt.Fprintln(out, "  4) Reiniciar o serviço")
	fmt.Fprintln(out, "  5) Remover o serviço")
	choice, err := ask(in, out, "Escolha", "1")
	if err != nil {
		return installConfig{}, err
	}
	switch serviceAction(choice) {
	case "start", "stop", "restart":
		return installConfig{Action: serviceAction(choice)}, nil
	case "remove":
		answer, err := ask(in, out, "Apagar também os dados salvos no servidor?", "n")
		if err != nil {
			return installConfig{}, err
		}
		return installConfig{Action: "remove", Purge: yes(answer)}, nil
	}
	for {
		data := preset.Data
		if data == "" {
			v, err := ask(in, out, "Pasta da instalação", "/var/lib/bethstudio-proxy")
			if err != nil {
				return installConfig{}, err
			}
			data = v
		}
		domain := cleanDomain(preset.Domain)
		for phonelink.CheckDomain(domain) != nil {
			if domain != "" {
				fmt.Fprintln(out, "Domínio inválido. Só o nome, sem https:// e sem porta.")
			}
			v, err := ask(in, out, "Domínio que o celular vai abrir", "")
			if err != nil {
				return installConfig{}, err
			}
			domain = cleanDomain(v)
		}
		listen := preset.Listen
		if listen == "" {
			fmt.Fprintln(out, "Como o proxy HTTPS que você já tem chega aqui?")
			fmt.Fprintln(out, "  1) por uma porta neste servidor")
			fmt.Fprintln(out, "  2) por um arquivo socket")
			choice, err := ask(in, out, "Escolha", "1")
			if err != nil {
				return installConfig{}, err
			}
			switch strings.ToLower(choice) {
			case "2", "socket", "unix":
				path, err := ask(in, out, "Arquivo socket", "/run/bethstudio-proxy.sock")
				if err != nil {
					return installConfig{}, err
				}
				listen = normalizeSocket(path)
			default:
				port, err := ask(in, out, "Porta em 127.0.0.1", "8787")
				if err != nil {
					return installConfig{}, err
				}
				listen = normalizePort(port)
			}
		}
		if _, _, err := phonelink.ParseListen(listen); err != nil {
			fmt.Fprintf(out, "Endereço inválido: %s\n", err)
			preset.Listen = ""
			continue
		}
		fmt.Fprintf(out, "\nO celular abre https://%s\nSeu proxy HTTPS aponta para %s\n", domain, listenForPerson(listen))
		ok, err := ask(in, out, "Está certo? (s/n)", "s")
		if err != nil {
			return installConfig{}, err
		}
		if ok == "" || yes(ok) {
			service := preset.Service
			if !service {
				answer, err := ask(in, out, "Subir sozinho quando o servidor ligar?", "s")
				if err != nil {
					return installConfig{}, err
				}
				service = yes(answer)
			}
			return installConfig{Listen: listen, Domain: domain, Data: data, Service: service}, nil
		}
		preset = installConfig{}
	}
}

func listenForPerson(listen string) string {
	if strings.HasPrefix(listen, "unix:") {
		return strings.TrimPrefix(listen, "unix:")
	}
	return listen
}

func pasteInstructions(code, domain string) string {
	return fmt.Sprintf(`Pronto.

No Beth Studio, abra Configurações → Celular.
Cole esta linha no primeiro campo:

%s

Crie a senha do celular nessa mesma tela.
No telefone, abra https://%s e entre com essa senha.
`, code, domain)
}

func serviceAction(choice string) string {
	switch strings.ToLower(strings.TrimSpace(choice)) {
	case "2", "iniciar", "start":
		return "start"
	case "3", "parar", "stop":
		return "stop"
	case "4", "reiniciar", "restart":
		return "restart"
	case "5", "remover", "remove":
		return "remove"
	default:
		return ""
	}
}

func yes(s string) bool {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "", "s", "sim", "y", "yes":
		return true
	default:
		return false
	}
}

func ask(in *bufio.Reader, out io.Writer, label, def string) (string, error) {
	if def != "" {
		fmt.Fprintf(out, "%s [%s]: ", label, def)
	} else {
		fmt.Fprintf(out, "%s: ", label)
	}
	line, err := in.ReadString('\n')
	if err != nil && err != io.EOF {
		return "", err
	}
	line = strings.TrimSpace(line)
	if line == "" {
		return def, nil
	}
	return line, nil
}

func cleanDomain(s string) string {
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(s, "https://")
	s = strings.TrimPrefix(s, "http://")
	s = strings.TrimSuffix(s, "/")
	if i := strings.IndexByte(s, '/'); i >= 0 {
		s = s[:i]
	}
	return s
}

func normalizePort(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return "127.0.0.1:8787"
	}
	if strings.Contains(s, ":") {
		return s
	}
	return "127.0.0.1:" + s
}

func normalizeSocket(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return "unix:/run/bethstudio-proxy.sock"
	}
	if strings.HasPrefix(s, "unix:") {
		return s
	}
	return "unix:" + s
}
