package main

// tool_spawn.go — terminais "de ferramenta" (SSH salvo, porta serial) que
// rodam DENTRO do host como terminais comuns: sobrevivem a reinicios do web
// e da GUI e aparecem nos dois.
//
// O pane executa `<pasta do bethstudio.exe>\bethstudio-tool.exe --ssh <id>` ou
// `... --serial <id>`. bethstudio-tool.exe e' a MESMA fonte Go deste pacote,
// ligada como programa de console (sem -H windowsgui): um exe windowsgui
// criado num ConPTY nao recebe console nenhum (verificado), entao nao
// conseguiria ler teclas nem escrever na tela do pane.
//
// Quem monta a linha de comando e' a ponte (`{"op":"spawn_tool"}`), a partir
// de um kind fixo e de um id validado — nunca um comando vindo do navegador.

import (
	"errors"
	"regexp"
	"strings"
)

const toolHelperExe = "bethstudio-tool.exe"

// toolKinds: kind da ponte -> flag do auxiliar e formato do id.
var toolKinds = map[string]struct {
	flag string
	re   *regexp.Regexp
}{
	"ssh":    {sshHelperFlag, sshHostIDRe},
	"serial": {serialHelperFlag, serialProfileIDRe},
}

// toolHelperMain: chamado no inicio de main(). handled=false = siga o fluxo
// normal do bethstudio-web.
func toolHelperMain(args []string) (code int, handled bool) {
	if len(args) != 2 {
		return 0, false
	}
	switch args[0] {
	case sshHelperFlag:
		return sshHelperMain(args[1]), true
	case serialHelperFlag:
		return serialHelperMain(args[1]), true
	}
	return 0, false
}

// toolArgvID: id de `<bethstudio-tool|bethstudio-web>.exe <flag> <id>`.
func toolArgvID(argv []string, flag string, re *regexp.Regexp) (string, bool) {
	if len(argv) < 3 {
		return "", false
	}
	base := strings.TrimSuffix(exeBase(argv[0]), ".exe")
	base = strings.TrimSuffix(base, ".old") // rename-while-running
	switch base {
	case "bethstudio-tool", "bethstudio-web":
	default:
		return "", false
	}
	for i := 1; i+1 < len(argv); i++ {
		if argv[i] == flag && re.MatchString(argv[i+1]) {
			return argv[i+1], true
		}
	}
	return "", false
}

// toolSpawnMessage valida o pedido do navegador e monta a linha para a ponte:
//
//	{"op":"spawn_tool","kind":"ssh"|"serial","id":"<id>","request_id":"…","window_id":N}
//
// Tambem devolve o shell_id a guardar (hub.noteSpawn) para o tipo do pane.
func toolSpawnMessage(kind, id, requestID string, windowID *int) (msg map[string]any, shellID string, err error) {
	k, ok := toolKinds[kind]
	if !ok {
		return nil, "", errors.New("kind inválido")
	}
	if !k.re.MatchString(id) {
		return nil, "", errors.New("id inválido")
	}
	switch kind {
	case "ssh":
		if _, found, err := sshGetHost(id); err != nil {
			return nil, "", err
		} else if !found {
			return nil, "", errors.New("host SSH não encontrado (talvez tenha sido apagado)")
		}
		shellID = sshShellIDFor(id)
	case "serial":
		if _, found, err := serialGetProfile(id); err != nil {
			return nil, "", err
		} else if !found {
			return nil, "", errors.New("perfil serial não encontrado (talvez tenha sido apagado)")
		}
		shellID = serialShellIDFor(id)
	}
	msg = map[string]any{"op": "spawn_tool", "kind": kind, "id": id}
	if requestID != "" {
		if !reqIDRe.MatchString(requestID) {
			return nil, "", errors.New("request_id inválido")
		}
		msg["request_id"] = requestID
	}
	if windowID != nil {
		if *windowID < 0 {
			return nil, "", errors.New("window_id inválido")
		}
		msg["window_id"] = *windowID
	}
	if kind == "ssh" {
		_ = sshNoteRecent(id)
	} else {
		_ = serialNoteRecent(id)
	}
	return msg, shellID, nil
}

// toolSpawnError: texto do erro para o navegador, com "(request <id>)" para
// a interface associar ao pedido pendente (requestIdFromError).
func toolSpawnError(requestID string, err error) string {
	if requestID != "" && reqIDRe.MatchString(requestID) {
		return "spawn_tool (request " + requestID + "): " + err.Error()
	}
	return "spawn_tool: " + err.Error()
}
