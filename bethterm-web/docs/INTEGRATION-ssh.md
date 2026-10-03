# Integração: SSH salvo, arquivos (SFTP) e terminal serial

Este documento lista exatamente o que falta ligar para a tela **SSH e
Serial** funcionar no `bethterm-web`. Todo o código novo está em arquivos
próprios; os arquivos existentes (`main.go`, `server.go`, `panekind.go`,
`App.tsx`, `connection.ts`, `build.ps1`, `package.json`, `go.mod`) só
recebem os ganchos abaixo.

## Modelo

```
tela SSH/Serial (React)  --spawn_tool-->  bethterm-web (Go)  --spawn_tool-->  bethterm cli bridge
                                                                                  |
                                             bethterm-host.exe  <-- cria pane: <pasta do bethterm.exe>\bethterm-tool.exe --ssh|--serial <id>
```

- A sessão SSH e a sessão serial rodam **dentro do host**, como terminais
  comuns: sobrevivem a reinícios da interface web e da GUI e aparecem nas
  duas. O processo do pane é `bethterm-tool.exe --ssh <id>` ou
  `bethterm-tool.exe --serial <id>`.
- `bethterm-tool.exe` é **a mesma fonte Go** do `bethterm-web`, ligada como
  programa de **console** (sem `-H windowsgui`). Verificado: um exe
  `windowsgui` criado com `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE` não recebe
  console nenhum (`GetStdHandle` = 0, `CONOUT$` inválido), então
  `bethterm-web.exe --ssh` não funcionaria dentro do pane.
- O navegador nunca manda linha de comando: só `kind` (`ssh`|`serial`) e o
  `id` salvo (16 hex). O Go confere se o host/perfil existe; a ponte monta o
  comando.
- O navegador de arquivos (SFTP), o "Testar conexão" e a lista de portas
  COM rodam no processo do `bethterm-web`, não no host.

## Arquivos novos

| Arquivo | Papel |
|---|---|
| `tool_spawn.go` | `toolHelperMain` (despacho `--ssh`/`--serial`), `toolSpawnMessage`, `toolSpawnError`, `toolArgvID` |
| `tool_console_windows.go` | console do pane: modo cru, UTF-8, teclas VT, eventos de tamanho, perguntas (s/N, senha sem eco) |
| `ssh_hosts.go` | `ssh-hosts.json` (gravação atômica), cofre (`ssh.pw.<id>`, `ssh.pp.<id>` em `secrets.dat`), recentes |
| `ssh_argv.go` | `sshHostForArgv`, `sshHostForShellID`, `sshShellIDFor` |
| `ssh_config_import.go` | importar `Host` do `~/.ssh/config` |
| `ssh_api.go` | rotas `/api/ssh/hosts…`, `/api/ssh/config-import` |
| `ssh_dial.go` | conexão (known_hosts/TOFU, senha, chave, agente) — tag `bethterm_ssh` |
| `ssh_helper_windows.go` | `bethterm-tool.exe --ssh <id>` — tag `bethterm_ssh` |
| `ssh_net_api.go` | testar / confiar na chave / esquecer chave — tag `bethterm_ssh` |
| `sftp_api.go` | navegador de arquivos — tag `bethterm_ssh` |
| `ssh_nodeps.go` | substitutos enquanto o build não tem as dependências (tag `!bethterm_ssh`) |
| `serial_profiles.go` | `serial-profiles.json`, `serialPortForArgv`, `serialPortForShellID` |
| `serial_port_windows.go` | porta COM via Win32 (DCB, timeouts) e lista de portas (registro) |
| `serial_session.go` | porta -> tela/log (hora opcional); teclado -> porta (fim de linha, eco) |
| `serial_helper_windows.go` | `bethterm-tool.exe --serial <id>` |
| `serial_api.go` | rotas `/api/serial/…` |
| testes | `ssh_hosts_test.go`, `ssh_test.go` (tag), `serial_test.go`, `tool_conpty_test.go` |
| `frontend/src/lib/sshApi.ts`, `sshUtil.ts` | tipos e chamadas; funções puras |
| `frontend/src/components/SshScreen.tsx` | tela (abas SSH e Serial) |
| `frontend/src/components/SshHostEditor.tsx`, `SshFilesPanel.tsx`, `SshSerialPanel.tsx`, `SshCommon.tsx` | partes da tela |
| `frontend/tests/sshUtil.test.ts` | testes das funções puras |
| `tools/fakebridge/main.go` (alterado) | op `spawn_tool` falsa |

## 1. Dependências (`go.mod`)

```
go get github.com/pkg/sftp@v1.13.7
```

`golang.org/x/crypto` já está no `go.mod` (v0.45.0, hoje indireta; passa a
direta) e `golang.org/x/sys` (v0.38.0) já cobre tudo. O `go get` traz
também `github.com/kr/fs v0.1.0` (indireta). Licenças:
`golang.org/x/crypto` e `golang.org/x/sys` BSD-3-Clause;
`github.com/pkg/sftp` BSD-2-Clause; `github.com/kr/fs` BSD-3-Clause.
O serial não usa dependência nova (só `golang.org/x/sys/windows` e
`golang.org/x/sys/windows/registry`). Verificado: `go test -tags
bethterm_ssh` passa com o `go.mod` atual + `pkg/sftp`.

Depois:

1. apagar `ssh_nodeps.go`;
2. apagar a linha `//go:build bethterm_ssh` de `ssh_dial.go`,
   `ssh_net_api.go`, `sftp_api.go` e trocar
   `//go:build bethterm_ssh && windows` por `//go:build windows` em
   `ssh_helper_windows.go` e `ssh_test.go`.

(Alternativa sem mexer nos arquivos: compilar e testar com
`-tags bethterm_ssh`.)

## 2. `main.go` — primeira coisa de `main()`

```go
	// Terminais de ferramenta (bethterm-tool.exe --ssh|--serial <id>) rodando
	// no pane do host. Antes de tudo: sem log, sem porta, sem janela.
	if code, ok := toolHelperMain(os.Args[1:]); ok {
		os.Exit(code)
	}
```

## 3. `server.go`

Em `ServeHTTP`, logo antes de `switch r.URL.Path {` (depois do cookie):

```go
	// SSH salvo / porta serial (docs/INTEGRATION-ssh.md)
	if strings.HasPrefix(r.URL.Path, "/api/ssh/") {
		s.serveSSH(w, r)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/api/serial/") {
		s.serveSerial(w, r)
		return
	}
```

Em `clientRequest`:

```go
	Kind    string  `json:"kind"` // spawn_tool: ssh | serial
	ID      string  `json:"id"`   // spawn_tool: id do host/perfil salvo
```

Em `handle`, um caso novo (por exemplo antes de `case "send", "paste":`):

```go
	case "spawn_tool":
		// Terminal de ferramenta no host (SSH salvo / porta serial). O comando
		// e' montado pela ponte a partir de kind + id validados.
		if s.hub.readOnly {
			sendErr("modo somente leitura: criar terminal desabilitado")
			return
		}
		msg, shellID, err := toolSpawnMessage(req.Kind, req.ID, req.ReqID, req.Window)
		if err != nil {
			sendErr(toolSpawnError(req.ReqID, err))
			return
		}
		s.hub.noteSpawn(req.ReqID, shellID)
		if err := b.write(msg); err != nil {
			userErr(err)
		}
```

`toolSpawnMessage` também registra o host/perfil nos "recentes". O
`shellID` guardado é `ssh.<id>` ou `serial.<id>` (casa com `shellIDRe`).

## 4. Tipo do pane (`panekind.go`)

No começo de `classifyArgv` (depois do teste de `len(argv) == 0`):

```go
	if l, ok := sshHostForArgv(argv); ok {
		return sshKind(l)
	}
	if l, ok := serialPortForArgv(argv); ok {
		return PaneKind{Kind: "serial", Label: "Serial · " + l}
	}
```

No começo de `classifyShellID`:

```go
	if l, ok := sshHostForShellID(id); ok {
		return sshKind(l)
	}
	if l, ok := serialPortForShellID(id); ok {
		return PaneKind{Kind: "serial", Label: "Serial · " + l}
	}
```

- `sshHostForArgv([]string) (label string, ok bool)`: reconhece
  `…\bethterm-tool.exe --ssh <id>` (e `bethterm-web.exe --ssh <id>`) e
  devolve o **nome de exibição** do host salvo ("host removido" se ele foi
  apagado). Lê `ssh-hosts.json` com cache pelo mtime.
- `serialPortForArgv` devolve `COM3` ou `COM3 · Nome do perfil`.
- A ordem importa: tem que vir antes do `ssh.exe`/`other`. Com isso o
  resultado é `kind:"ssh", kind_label:"SSH · <nome>", ssh_host:"<nome>"` e
  `kind:"serial", kind_label:"Serial · COM3"` (verificado ponta a ponta com a
  fakebridge). O front precisa conhecer o kind `serial` em `kinds.ts` /
  `KindIcon.tsx` (ícone sugerido: `Cable` ou `Usb` do lucide).

## 5. Front

`connection.ts`, junto de `spawn()`:

```ts
  /** Terminal de ferramenta no host (SSH salvo / porta serial): a ponte monta
   *  o comando `bethterm-tool.exe --ssh|--serial <id>`; espera o `spawned`. */
  spawnTool(opts: { kind: "ssh" | "serial"; id: string; window_id?: number }): Promise<SpawnedEvent> {
    const request_id = `w${Date.now().toString(36)}${(this.reqSeq++).toString(36)}`;
    const p = this.spawns.add(request_id, 20000);
    const req: Record<string, unknown> = { op: "spawn_tool", kind: opts.kind, id: opts.id, request_id };
    if (opts.window_id !== undefined) req.window_id = opts.window_id;
    if (!this.raw(req)) this.spawns.reject(request_id, new Error("sem conexão"));
    return p;
  }
```

`App.tsx`:

```tsx
import { SshScreen, type ToolKind } from "@/components/SshScreen";
…
const [toolScreen, setToolScreen] = useState<ToolKind | null>(null);
…
{toolScreen && (
  <SshScreen
    conn={conn}
    readOnly={readOnly}
    initialTab={toolScreen}
    onConnect={async (kind, id, name) => {
      const ev = await conn.spawnTool({ kind, id });
      setPendingSpawn({ pane: ev.pane_id, name, at: Date.now() }); // mesma aba nova do "Novo terminal"
    }}
    onClose={() => setToolScreen(null)}
  />
)}
```

Botão: na barra de abas / barra lateral, ao lado de "Nova aba", um botão
**"SSH e Serial"** (ícone `Server` do lucide) com `onClick={() =>
setToolScreen("ssh")}`. Se o "Novo terminal" tiver um atalho, dá para
oferecer também "Conexão SSH salva…" e "Porta serial…" abrindo
`setToolScreen("ssh" | "serial")`.

`package.json`, no script `test`: acrescentar `tests/sshUtil.test.ts`.

## 6. Build (`build.ps1`)

Depois do `go build` do `bethterm-web.exe`, ligar o mesmo pacote como
console:

```powershell
go build -trimpath -ldflags "-s -w" -o bethterm-tool.exe .
```

(com as mesmas flags/tags do build do `bethterm-web.exe`, só sem
`-H windowsgui`). O instalador copia `bethterm-tool.exe` para a mesma pasta
do `bethterm.exe` / `bethterm-gui.exe` / `bethterm-web.exe`. O host não
precisa ser parado para isso.

## 7. Ponte (`upstream-wezterm`, patch nova)

Uma operação só para os dois tipos:

```
{"op":"spawn_tool","kind":"ssh"|"serial","id":"<16 hex>","window_id":W?,"request_id":"r1"?}
  -> {"ev":"spawned","request_id":"r1","pane_id":…,"tab_id":…,"window_id":…}
  or {"ev":"error","message":"spawn_tool <kind> (request r1): <motivo>"}
```

- `kind` -> flag fixa: `ssh` -> `--ssh`, `serial` -> `--serial`; qualquer
  outro valor é recusado.
- `id` tem que casar `^[a-f0-9]{16}$` (recusar o resto: é o único texto do
  cliente que entra na linha de comando).
- Comando: `[<dir de std::env::current_exe()>\bethterm-tool.exe, <flag>, <id>]`
  via `CommandBuilder::from_argv`; se o arquivo não existir, erro
  `bethterm-tool.exe não encontrado em <dir>`.
- `cwd`: nenhum (o auxiliar não depende da pasta); `window_id` igual ao
  `spawn` (patch 0176); depois do spawn, mandar a próxima `list` na hora.
- A mensagem de erro precisa conter `(request <id>)` para a interface
  associar ao pedido.

## Dados (`%APPDATA%\bethterm\`)

| Arquivo | Conteúdo |
|---|---|
| `ssh-hosts.json` | hosts (nome, grupo, endereço, porta, usuário, método, caminho da chave, cor, etiqueta, notas, pasta inicial do SFTP) e recentes — sem credenciais |
| `secrets.dat` | também `ssh.pw.<id>` / `ssh.pp.<id>` (senha / frase-senha, base64 dentro do DPAPI) |
| `ssh_known_hosts` | chaves de servidor confirmadas (formato OpenSSH; `host` na porta 22, `[host]:porta` nas outras) |
| `serial-profiles.json` | perfis seriais e recentes |

Downloads do SFTP vão para a pasta Downloads do usuário (nome repetido vira
`nome (1).ext`; baixa em `.part` e renomeia no fim). Upload grava em
`<destino>.bethterm-part` e renomeia no fim.

## Comportamento

**SSH no pane**: título `SSH · <nome>`; "Conectando a user@host:porta…";
primeira conexão mostra tipo + impressão digital SHA256 e pergunta
`Confiar nesta chave e continuar? (s/N)`; chave diferente da salva = recusa
com explicação (sem opção de continuar) e "Pressione qualquer tecla";
senha salva, digitada no terminal (sem eco, 3 tentativas) ou
keyboard-interactive; chave com frase-senha salva ou perguntada; agente do
Windows (`\\.\pipe\openssh-ssh-agent`, ou `SSH_AUTH_SOCK` se for um pipe).
PTY `xterm-256color` do tamanho do console; redimensionar o pane manda
`window-change`; keepalive a cada 30 s. Saída do shell remoto fecha o pane
com o mesmo código.

**Serial no pane**: título `Serial · COM3`; mostra `115200 8N1, sem
controle de fluxo, Enter = CR`; porta ausente/removida = espera ela voltar
(sem fechar o terminal); `Ctrl+]` encerra; eco local, hora por linha e log
(acrescenta ao arquivo, com cabeçalho por sessão) conforme o perfil.

**Não suportado (de propósito)**: ProxyJump / ProxyCommand / túneis de
porta (o importador avisa), certificados SSH, `.ppk` (converter no
PuTTYgen), baixar pasta inteira no SFTP.
