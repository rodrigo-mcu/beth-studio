# Integração do painel "Banco de dados"

O módulo está ligado ao Beth Studio (sem tag `dbtools`). A janela do
sistema é `bethstudio-web.exe --db`; o botão no Studio chama
`POST /api/db/window` e foca a janela se ela já estiver aberta. O catálogo
do que a pessoa pode usar está em `FEATURES.md` (seção 18). Os passos de
gancho mais abaixo descrevem como o módulo foi encaixado; a tag de build
e o diálogo dentro do `App.tsx` não são mais o caminho.

Edição de célula: `POST /api/db/row` grava uma coluna quando a tabela tem
chave primária. Um SELECT simples de uma tabela, que inclua cada coluna
da chave, volta com `results[].edit` para a grade saber que pode editar.
JOIN, tabela sem chave e conexão somente leitura não editam. O UPDATE
corre numa transação e só confirma se `RowsAffected` for 1.

## Arquivos novos

| Arquivo | O que é |
|---|---|
| `db_config.go` | conexões salvas (`%APPDATA%\bethstudio\db-connections.json`, gravação atômica via `writeAtomic`), validação dos campos, senha no cofre DPAPI existente (`secrets.set/get`, chave `db:<id>`), catálogo de drivers |
| `db_dialer.go` | gancho `DBDialer` / `dbTunnelProvider` para túnel SSH (ver abaixo) |
| `db_dialect.go` | abertura dos pools (pgx, go-sql-driver/mysql, go-mssqldb, modernc sqlite), aspas de identificador, placeholders, consultas de catálogo (bancos, schemas, tabelas/views com estimativa de linhas, colunas, índices) |
| `db_sqlclass.go` | divisor de script em instruções e classificador (leitura, escrita, estrutura, transação, sessão), detecção de UPDATE/DELETE sem WHERE, DROP, TRUNCATE |
| `db_exec.go` | cache de pools, execução com limites, cancelamento, cursor de "carregar mais", visão de tabela (página, ordenação, filtros com parâmetros), conversão de valores para JSON, metadado `edit` no resultado |
| `db_row.go` | `POST /api/db/row`: UPDATE de uma célula pela chave primária |
| `db_api.go` | rotas HTTP `/api/db/*` (`(*server).serveDB`) |
| `db_sqlclass_test.go`, `db_sqlite_test.go`, `db_row_test.go` | testes (classificador, montagem de SQL, valores, ponta a ponta com SQLite, parser do SELECT editável e UPDATE de célula) |
| `frontend/src/lib/dbApi.ts` | tipos e chamadas das rotas |
| `frontend/src/lib/dbFormat.ts` | formatação, CSV/JSON/TSV, nomes de arquivo (funções puras) |
| `frontend/src/lib/dbSqlHighlight.ts` | realce de sintaxe SQL (função pura) |
| `frontend/src/components/DbManager.tsx` | o painel (árvore + abas de tabela e de consulta) |
| `frontend/src/components/DbSchemaTree.tsx` | árvore conexões → bancos → schemas → tabelas/views → colunas/índices |
| `frontend/src/components/DbConnectionDialog.tsx` | criar/editar/testar/excluir conexão |
| `frontend/src/components/DbTableView.tsx` | dados de uma tabela (página, ordenação, filtros, contagem) e aba "Estrutura" |
| `frontend/src/components/DbQueryPanel.tsx` | editor + resultados (vários conjuntos, tempo, carregar mais, cancelar) |
| `frontend/src/components/DbSqlEditor.tsx` | editor leve (textarea + realce por baixo, numeração de linhas) |
| `frontend/src/components/DbResultGrid.tsx` | grade com rolagem virtual, largura ajustável, menu de cópia, visualizador de valor, edição inline (duplo clique / F2) |
| `frontend/src/components/DbThemeButton.tsx` | lista de temas igual à do terminal; clique fora fecha o painel |
| `frontend/src/components/DbWindowApp.tsx` | processo `--db`: só a janela Banco de dados |
| `frontend/src/components/DbConfirmDialog.tsx` | confirmação de instruções que alteram algo |
| `frontend/src/components/DbExportButtons.tsx` | exportar CSV / CSV (;) / JSON e copiar |
| `frontend/tests/dbFormat.test.ts` | testes das funções puras |

## 1. Dependências Go (`go.mod`)

```powershell
go get github.com/jackc/pgx/v5@v5.8.0 github.com/go-sql-driver/mysql@v1.8.1 github.com/microsoft/go-mssqldb@v1.8.2 modernc.org/sqlite@v1.41.0
go mod tidy
```

Isso também sobe `golang.org/x/sys` de v0.30.0 para v0.36.0 e `golang.org/x/text`
para v0.29.0 (exigência do modernc sqlite). Todas as versões acima funcionam
com o `go 1.24.1` atual (versões mais novas do pgx e do sqlite pedem go 1.24.0
também; não precisa trocar de toolchain).

| Módulo | Licença | Para quê |
|---|---|---|
| github.com/jackc/pgx/v5 | MIT | PostgreSQL |
| github.com/go-sql-driver/mysql | **MPL-2.0** | MySQL / MariaDB |
| github.com/microsoft/go-mssqldb | BSD-3-Clause | SQL Server |
| modernc.org/sqlite | BSD-3-Clause | SQLite (Go puro, sem cgo) |
| indiretos: jackc/pgpassfile, jackc/pgservicefile, jackc/puddle/v2, dustin/go-humanize, mattn/go-isatty, ncruces/go-strftime | MIT | |
| indiretos: filippo.io/edwards25519, golang-sql/sqlexp, google/uuid, remyoudompheng/bigfft, modernc.org/libc, modernc.org/mathutil, modernc.org/memory, golang.org/x/crypto, x/exp, x/sync, x/text | BSD-3-Clause | |
| indireto: github.com/golang-sql/civil | Apache-2.0 | |

Observações:
- **MPL-2.0** (driver MySQL) é copyleft fraco por arquivo: pode ser usado sem
  restrição num projeto aberto de outra licença, desde que o código do próprio
  driver, se modificado, continue MPL. Não modificamos nada. Se o projeto
  quiser só licenças permissivas, o MySQL é o único ponto a rever.
- `golang.org/x/crypto` entra em v0.24.0 (indireto, via driver MySQL). Vale
  subir para a versão mais nova compatível com o toolchain antes de publicar.
- O executável cresce bastante (o SQLite em Go puro é grande): o binário de
  teste sem `-ldflags "-s -w"` foi de ~9,8 MB para ~27,9 MB.

## 2. Ligar os arquivos Go

Feito: os `db_*.go` compilam no pacote normal, sem `//go:build dbtools`.
O texto abaixo é o passo original.

Depois do `go get`, apague a primeira linha `//go:build dbtools` (e a linha em
branco seguinte) destes arquivos:

```
db_api.go db_config.go db_dialect.go db_dialer.go db_exec.go db_sqlclass.go
db_sqlclass_test.go db_sqlite_test.go
```

(Alternativa: manter a tag e compilar/testar com `-tags dbtools`.)

## 3. `server.go`: a rota (4 linhas)

Feito: `ServeHTTP` já chama `serveDB` para `/api/db/`.

O `ServeHTTP` usa um `switch r.URL.Path` com caminhos exatos. As rotas do
banco são um prefixo, então o gancho vai **antes** do `switch` (depois da
checagem de Host, Origin e token, que continuam valendo):

```go
	if strings.HasPrefix(r.URL.Path, "/api/db/") {
		s.serveDB(w, r)
		return
	}
	switch r.URL.Path {
```

`main.go` não muda: `secrets.load(dataDir())` já roda no início, e o painel
usa esse mesmo cofre. O modo `--read-only` do app vale para o banco também:
todas as conexões passam a ser tratadas como somente leitura.

## 4. `TabBar.tsx`: o botão "Banco de dados"

Feito. O botão abre a janela do sistema (`POST /api/db/window`), não um
diálogo dentro do Studio.

Na importação do lucide, acrescente `Database`. Em `Props`, acrescente
`onDatabase?: () => void;` e desestruture `onDatabase`. Ao lado dos botões
"Buscar"/"Tarefas":

```tsx
      {onDatabase && (
        <button
          className="mb-0.5 flex h-7 shrink-0 items-center gap-1.5 rounded px-2 text-text-2 hover:bg-bg-hover hover:text-text-1"
          title="Banco de dados: conexões salvas, tabelas e consultas SQL"
          onClick={onDatabase}
        >
          <Database size={14} /> Banco de dados
        </button>
      )}
```

## 5. `App.tsx`: estado e montagem

Superado pela janela `--db` (`DbWindowApp`). O Studio não monta o
`DbManager` por cima dos terminais.

```tsx
import { DbManager } from "@/components/DbManager";
// ...
const [dbOpen, setDbOpen] = useState(false);
// ...
<TabBar /* ... */ onDatabase={() => setDbOpen(true)} />
// ...junto dos outros diálogos:
{dbOpen && <DbManager conn={conn} onClose={() => setDbOpen(false)} />}
```

Fechar o painel desmonta tudo (as abas de consulta se perdem e os cursores
abertos são fechados). Se quiserem manter as abas entre aberturas, troquem por
`<div hidden={!dbOpen}><DbManager .../></div>` montado sempre.

## 6. `package.json` (opcional): o teste

No script `"test"`, acrescente ` tests/dbFormat.test.ts`.

**Nenhum pacote npm novo.** O editor de SQL é próprio (textarea transparente
por cima do realce), para não obrigar a mexer no `package.json` nem no
`pnpm-lock.yaml` enquanto outros agentes editam o frontend. Se um dia
quiserem CodeMirror 6 (`@codemirror/state`, `@codemirror/view`,
`@codemirror/commands`, `@codemirror/lang-sql`, `@codemirror/language`,
`@lezer/highlight`, todos MIT), basta trocar `DbSqlEditor.tsx` mantendo a
mesma interface (`value`, `onChange`, `driver`, `onRun` e o `ref` com
`runnableText()`).

## Rotas

Todas passam pela autenticação do `server.go` (token, Host, Origin).

| Rota | Corpo | Resposta |
|---|---|---|
| `GET /api/db/connections` | | conexões (sem senha, só `has_password`), grupos, drivers, limites, `app_read_only`, `tunnel_ready` |
| `POST /api/db/connections/save` | `{connection, password?, clear_password?}` | `{connection}` |
| `POST /api/db/connections/delete` | `{id}` | `{ok}` (apaga também a senha) |
| `POST /api/db/test` | `{id?}` ou `{connection, password?}` | `{ok, version, elapsed_ms}` ou `{ok:false, error}` |
| `POST /api/db/databases` | `{id}` | `{databases, current}` (PostgreSQL, SQL Server) |
| `POST /api/db/schemas` | `{id, database?, system?}` | `{schemas, current}` |
| `POST /api/db/objects` | `{id, database?, schema}` | `{objects:[{name,type,rows_estimate}]}` |
| `POST /api/db/columns` | `{id, database?, schema, table}` | `{columns, indexes}` |
| `POST /api/db/table` | `{id, database?, schema, table, sort, filters, limit, offset, count, query_id}` | `{columns, rows, has_more, total?}` |
| `POST /api/db/query` | `{id, database?, sql, max_rows, timeout_s, confirm?, query_id}` | resultados (SELECT simples de uma tabela com chave inclui `edit`); ou `{needs_confirm, confirm_token, statements, danger}`; ou `{blocked, error, read_only}` |
| `POST /api/db/row` | `{id, database?, schema, table, column, value?, null?, where}` | `{ok, affected}` se uma linha mudou; 400 se a chave não confere, a coluna não existe ou a tabela não tem chave; 403 se somente leitura |
| `POST /api/db/window` | `{}` | `{ok}` — abre ou foca a janela Banco de dados |
| `POST /api/db/more` | `{more_id, max_rows, timeout_s}` | `{rows, has_more}` |
| `POST /api/db/cancel` | `{query_id}` (ou um `more_id`) | `{cancelled}` |
| `POST /api/db/close` | `{more_id}` | `{ok}` |

## Segurança e limites

- **Senhas** só no cofre DPAPI (`secrets.dat`), nunca no JSON de conexões nem
  nas respostas. Mensagens de erro passam por um filtro que troca a senha
  (também na forma codificada em URL) por `••••`. O log só registra id da
  conexão, número de instruções, linhas e tempo. Não registra SQL, valores
  nem erros do servidor.
- **Somente leitura** (por conexão, ou o app inteiro com `--read-only`):
  1. o classificador recusa qualquer instrução que não seja leitura, antes de
     enviar qualquer coisa;
  2. o que passa roda numa transação aberta com `ReadOnly` (PostgreSQL
     `BEGIN READ ONLY`, MySQL `START TRANSACTION READ ONLY`, SQLite), e essa
     transação é **sempre desfeita** (rollback). SQL Server não tem transação
     somente leitura: vale o classificador mais o rollback;
  3. SQLite abre o arquivo com `mode=ro` e `PRAGMA query_only`.
  O teste `TestDBSQLiteReadOnly` força um DELETE por baixo do classificador e
  confere que o banco recusa.
- **Confirmação:** em conexões normais, toda instrução que não é leitura
  (INSERT/UPDATE/DELETE/MERGE, DDL, BEGIN/COMMIT, SET/USE, desconhecida)
  exige confirmação. O Go devolve a lista e um `confirm_token` (hash do
  script + conexão + banco). Só o mesmo texto com o mesmo token executa. As
  perigosas (DROP, TRUNCATE, UPDATE/DELETE sem WHERE) pedem para digitar
  CONFIRMAR.
- **Filtros da visão de tabela:** nomes de coluna são conferidos contra o
  catálogo e vão entre aspas; valores vão sempre como parâmetros; `%`, `_`
  (e `[` no SQL Server) do valor são literais.
- **Limites:** tempo máximo padrão 60 s (máx. 600 s). O cancelamento é feito
  via context: pgx e go-mssqldb avisam o servidor, e o SQLite é interrompido.
  O driver MySQL fecha a conexão, e o servidor pode terminar a instrução
  sozinho. Linhas por resultado por pedido: padrão 1 000, máx. 10 000.
  Pelo "carregar mais": até 100 000 por resultado. Resposta: ~16 MiB de dados
  por pedido. Célula: 64 KiB de texto (binário: 4 KiB em hex). SQL enviado:
  512 KiB. Instruções por envio: 200. Cursores de "carregar mais" abertos:
  8, fechados após 3 min parados. Pools parados: fechados após 10 min.
- Conexões usadas por scripts com BEGIN/SET/USE/instrução desconhecida são
  **descartadas** no fim (não voltam ao pool), então uma transação esquecida
  aberta é desfeita pelo servidor e nunca vaza para a próxima consulta.

## Gancho para túnel SSH (futuro)

`db_dialer.go` define:

```go
type DBDialer interface {
	DialContext(ctx context.Context, network, address string) (net.Conn, error)
}
var dbTunnelProvider func(ctx context.Context, c DBConnConfig) (DBDialer, error)
```

O campo `tunnel` da conexão (já salvo e validado) guarda o id de um host SSH.
Quando `dbTunnelProvider` é nil, uma conexão com túnel falha com uma mensagem
clara, nunca cai para conexão direta. O módulo SSH só precisa, num arquivo
dele:

```go
func init() {
	dbTunnelProvider = func(ctx context.Context, c DBConnConfig) (DBDialer, error) {
		client, err := sshClientFor(ctx, c.Tunnel) // cliente SSH já autenticado
		if err != nil {
			return nil, err
		}
		return sshDialer{client}, nil // DialContext -> client.DialContext("tcp", address)
	}
}
```

O dialer já é usado nos três drivers de rede: pgx (`ConnConfig.DialFunc`, com
`LookupFunc` que não resolve DNS localmente), MySQL (`RegisterDialContext`
com uma rede própria por conexão) e SQL Server (`Connector.Dialer`). Com o
provider definido, a UI mostra o campo "Túnel SSH" no formulário
(`tunnel_ready`). O ideal é trocar esse campo por um seletor dos hosts SSH
salvos.

## Como verificar

```powershell
go vet .
go test -run TestDB -count=1 .
cd frontend; npx tsc --noEmit; node --test tests/dbFormat.test.ts
```

Os testes Go usam só arquivos SQLite em pasta temporária e um cofre de senhas
em memória. Eles não tocam `%APPDATA%` nem se conectam a nenhum servidor.

## Limitações conhecidas

- PostgreSQL, MySQL e SQL Server foram compilados e têm as consultas de
  catálogo escritas, mas só o SQLite foi testado de verdade (não havia
  servidor descartável na máquina). Antes de liberar, vale rodar contra
  containers de teste.
- MySQL: o `DELIMITER` do cliente não é entendido. Procedures com
  BEGIN...END são reconhecidas sem ele.
- SQL Server: cada lote separado por `GO` é enviado inteiro. A detecção de
  UPDATE/DELETE sem WHERE é heurística em lotes sem `;`.
- Funções com efeito colateral dentro de um SELECT (ex.: `nextval`,
  `pg_terminate_backend`) não são detectadas pelo classificador. Em conexão
  somente leitura, a transação de leitura do PostgreSQL/MySQL barra a maioria.
  Em conexão normal, rodam sem confirmação.
- "Carregar mais" continua só o último resultado do script. Resultados
  anteriores cortados mostram "limitado; o resto foi descartado".
- A exportação é do que já foi carregado na grade (até o limite). O botão
  SQL gera `INSERT` dessas linhas, não um dump do banco.
- Edição na grade: uma célula por vez, só com chave primária no resultado.
  Não tem diagrama ER, transferência entre servidores, sincronização de
  estrutura, gerador de dados, backup agendado nem BI. Isso existe no
  grandes clientes de banco e fica de fora de propósito: o módulo aqui é o trabalho
  do dia (consultar, ver tabela, corrigir uma célula, exportar o que está
  na tela), não um modelador nem um agendador.

## O que entrou neste módulo

O que vale no uso diário e cabe aqui (modelagem, painéis de gráficos,
MongoDB/Redis/Oracle, colaboração e agendamento ficam de fora):

| Recurso | Situação |
|---|---|
| Conexões várias, túnel SSH, grupos | já tinha (túnel quando o provider SSH está ligado) |
| Árvore, filtro de objeto, grade, ordenar/filtrar | já tinha |
| Editor com realce, várias instruções, cancelar | já tinha |
| Exportar CSV/JSON | já tinha; agora também SQL (`INSERT` do que está na grade) |
| SQL beautifier | botão de formatar na consulta |
| Localizar e substituir | Ctrl+F no editor |
| Histórico e consultas salvas | painel do ícone de histórico (fica neste navegador) |
| Explain | botão de plano (`EXPLAIN` / `EXPLAIN QUERY PLAN` / `SHOWPLAN_TEXT`) |
