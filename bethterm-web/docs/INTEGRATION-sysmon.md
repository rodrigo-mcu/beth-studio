# Integração do "Gerenciador de tarefas" (sysmon)

Tudo o que é do módulo já está em arquivos novos. Faltam só quatro ganchos
pequenos em arquivos que outro agente está editando. Nenhuma dependência nova:
só stdlib e `golang.org/x/sys/windows` (já está no `go.mod`); no frontend só
`lucide-react`, que já é dependência.

## Arquivos novos

| Arquivo | O que é |
|---|---|
| `sysmon.go` | tipos JSON, árvore de processos, associação shell → terminal, parsers (WSL, free/ps, nvidia-smi, instâncias PDH da GPU), cache e laço de 1 s, `registerSysmonRoutes`, `(*server).serveSysmon`, `(*hub).sysmonPanes` |
| `sysmon_windows.go` | coleta nativa: NtQuerySystemInformation (processos e CPU por núcleo), GlobalMemoryStatusEx, GetDiskFreeSpaceEx, PDH (GPU e disco), leitura do título do console, nvidia-smi e wsl.exe |
| `sysmon_test.go` | testes com dados falsos (associação, normalização de título, parsers) |
| `sysmon_real_test.go` | amostra real desta máquina, só com `SYSMON_REAL=1` |
| `frontend/src/lib/sysmon.ts` | tipos, `fetchSysmon(conn)`, formatação pt-BR e ordenação |
| `frontend/src/components/TaskManager.tsx` | o painel |
| `frontend/tests/sysmon.test.ts` | testes de formatação e ordenação |

## 1. `server.go`: a rota (1 linha)

O `server.go` usa um `switch r.URL.Path` depois de conferir Host, Origin e
token. Acrescente um case (qualquer lugar do switch, por exemplo antes de
`case "/api/content":`):

```go
	case "/api/sysmon":
		s.serveSysmon(w, r)
```

`serveSysmon` (em `sysmon.go`) cria o serviço na primeira chamada e usa
`s.hub.sysmonPanes`, que lê a última lista da ponte (`hub.lastList`, que já
vem com `kind`/`kind_label` da `panekind.go`). Só aceita GET. Não precisa
mexer em `main.go`, `hub.go` nem `api.go`.

(Se um dia o servidor passar a usar `http.ServeMux`, use
`registerSysmonRoutes(mux, auth, hub.sysmonPanes)`.)

## 2. `package.json`: o teste (opcional)

No script `"test"`, acrescente ` tests/sysmon.test.ts` ao final da lista.

## 3. `TabBar.tsx`: o botão

Na importação do lucide, acrescente `Activity`. Em `Props`, acrescente
`onTaskManager?: () => void;` e desestruture `onTaskManager` na função. Ao
lado do botão "Buscar":

```tsx
      {onTaskManager && (
        <button
          className="mb-0.5 flex h-7 shrink-0 items-center gap-1.5 rounded px-2 text-text-2 hover:bg-bg-hover hover:text-text-1"
          title="Gerenciador de tarefas: memória, CPU, GPU, disco, consumo de cada terminal e do WSL"
          onClick={onTaskManager}
        >
          <Activity size={14} /> Tarefas
        </button>
      )}
```

## 4. `App.tsx`: estado, callback e montagem

```tsx
import { TaskManager } from "@/components/TaskManager";
// ...
const [taskManager, setTaskManager] = useState(false);
// ...
<TabBar /* ... */ onTaskManager={() => setTaskManager(true)} />
// ...junto dos outros diálogos (perto de <KillDialog>):
{taskManager && (
  <TaskManager
    conn={conn}
    onClose={() => setTaskManager(false)}
    onGoToPane={(id) => {
      setTaskManager(false);
      act?.open(id); // mesma ação do clique na barra lateral
    }}
  />
)}
```

O painel consulta `/api/sysmon` a cada 1 s só enquanto está montado. Fechado,
não faz nada, e o Go para o laço de amostragem 10 s depois da última consulta.

## Como verificar

```powershell
go vet ./...
go test -run Sysmon ./...
$env:SYSMON_REAL=1; go test -run SysmonRealSample -v .   # imprime a amostra real e grava %TEMP%\sysmon-sample.json
cd frontend; npx tsc --noEmit; node --test tests/sysmon.test.ts
```

## Comportamento e limites (para quem for mexer)

- **Custo:** um NtQuerySystemInformation por segundo cobre todos os
  processos. Nenhum handle de processo é aberto. A consulta PDH mede GPU e
  disco. A amostra real levou cerca de 20 ms. `nvidia-smi` e o WSL rodam em
  segundo plano a cada 5 s, com timeout (4 s e 3 s).
- **Associação processo → terminal:** os shells são os filhos diretos do
  `bethterm-host.exe` (o do `%APPDATA%\bethterm\host.pid`) que não são
  `OpenConsole.exe`. O título de cada um vem de `AttachConsole(pid)` →
  `GetConsoleTitleW` → `FreeConsole`, numa goroutine com `LockOSThread` e um
  pid por vez. A ordem de associação é: título exato, depois título
  normalizado (sem glifos ✳ ✻ ◐ ◑ ◒ ◓ ⏺ nem spinner braille, sem
  "Administrador:", com `claude.exe` igual a `claude`). Títulos repetidos são
  pareados pela ordem (id do pane contra hora de criação). Por último, se
  sobrarem tantos shells quanto panes, eles são pareados por ordem de criação
  ("estimado"). A associação por título exato ou único fica guardada enquanto
  o processo existir, e só os shells ainda sem par são relidos (no máximo a
  cada 3 s).
- **Attach isolado (integração):** o processo principal nunca chama
  `AttachConsole`. A leitura dos títulos roda num processo auxiliar
  descartável, o próprio exe com `--console-titles <pid,...>` (tratado no
  início de `main`), criado com `DETACHED_PROCESS`. Ele imprime uma linha JSON
  por pid e sai, com timeout de 3 s. Se um terminal fechar durante o attach,
  só o auxiliar morre, e vale o que ele já tinha impresso. O teste
  `TestSysmonNoAttachInMainProcess` garante isso.
- **WSL (integração):** quem está rodando vem de `wsl -l --running -q`, e a
  lista é conferida de novo imediatamente antes de cada `wsl -d X`. Se a
  distro parou, ela é pulada e nunca é reiniciada.
- **RAM** = working set privado, a coluna "Memória" do Gerenciador de
  Tarefas. O working set e os bytes privados (commit) aparecem no tooltip.
  **CPU** = % da máquina inteira (soma de todos os núcleos = 100%).
- **WSL:** se não houver processo `vmmem`/`vmmemWSL`, nada é consultado e o
  `wsl.exe` nem é chamado. Distros paradas nunca recebem comando. Existe uma
  pequena corrida: uma distro que para entre o `-l -v` e o `-d X` seria
  iniciada de novo por aquele comando. As distros WSL2 compartilham a VM, então
  o `free` de cada uma mostra a VM. O `%CPU` do `ps` é a média desde o início
  do processo. Terminais WSL só têm o lado Windows (wsl.exe) na tabela.
- **GPU:** a utilização por adaptador é a do motor mais ocupado (como no
  Gerenciador de Tarefas). O nome do adaptador vem do nvidia-smi quando há uma
  só NVIDIA, e ele é marcado "(provável)" porque a correlação LUID → nome é
  heurística. Sem PDH e sem nvidia-smi, o painel mostra "indisponível".
