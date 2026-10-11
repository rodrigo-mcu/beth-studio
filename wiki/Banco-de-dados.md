# Banco de dados

O Beth Studio traz um cliente de banco de dados embutido, numa janela própria chamada **Banco de dados**. Ele conecta a PostgreSQL, MySQL, SQL Server e SQLite, mostra a árvore de objetos, abre tabelas, roda SQL com autocompletar e guarda suas consultas.

Bancos suportados: **PostgreSQL**, **MySQL**, **SQL Server** e **SQLite**. Não há suporte a Redis, MongoDB nem Oracle.

## Como usar

### Abrir a janela do banco

1. No Studio, clique no botão **Banco de dados** (fica na linha do painel esquerdo, abaixo de "Beth Studio"; com o painel recolhido, vai para a barra de abas).
2. A janela **Banco de dados** abre na barra de tarefas. Se já estiver aberta, o botão só a traz para a frente.
3. Para mudar as cores, clique no botão de paleta da janela. A lista de temas é a mesma dos terminais (busca, filtros claro/escuro e por origem). Passar o mouse mostra uma prévia sem salvar. Clique num tema para aplicar; clique fora do painel para fechar. Veja [Temas e fontes](Temas-e-fontes).

> Captura sugerida: janela "Banco de dados" com a árvore à esquerda e uma tabela aberta.

### Criar uma conexão

1. Clique em **Nova conexão**.
2. Escolha o **Tipo de banco**.
3. Preencha **Nome** (por exemplo, `meu_banco`), **Grupo** (opcional) e, se quiser, a **Cor da etiqueta**.
4. Para PostgreSQL, MySQL e SQL Server, preencha **Servidor** (por exemplo, `localhost`), **Porta**, **Usuário**, **Banco inicial** e **Senha**. Em **Criptografia (SSL/TLS)** escolha o modo.
5. Para SQLite, informe o **Arquivo do banco** (caminho completo). Marque **Criar o arquivo se ele não existir** se quiser um arquivo novo.
6. Marque **Somente leitura** para bancos importantes (recomendado para produção).
7. Clique em **Testar conexão** e depois em **Salvar**.

Para mudar uma conexão, use **Editar conexão**. O botão **Excluir** pede confirmação. Na edição, deixar a **Senha** em branco mantém a senha salva.

> Captura sugerida: diálogo "Nova conexão" preenchido com um servidor `localhost`.

### Navegar pela árvore

1. A árvore mostra: conexão, banco, esquema (schema) e, dentro dele, as pastas **Tables**, **Views**, **Materialized Views** (só PostgreSQL), **Functions** (não existe em SQLite) e **Queries**.
2. Em PostgreSQL e SQL Server, sem **Banco inicial** a árvore lista todos os bancos que o usuário pode acessar.
3. Preencher **Banco inicial** faz a conexão abrir só aquele banco. Em PostgreSQL e SQL Server, o botão **Selecionar** ao lado do campo conecta com os dados do formulário e mostra a lista de bancos para você escolher.
4. Clique numa tabela para abrir uma aba. A pasta **Queries** lista as consultas salvas.

### Ver e filtrar os dados de uma tabela

1. Abra a tabela. A aba **Dados** mostra as linhas; a aba **Estrutura** mostra colunas e índices.
2. Ordene clicando nos cabeçalhos e use **Filtrar…** para filtrar no banco.
3. Mude **Linhas por página** e use **Próxima** e **Página anterior** para paginar.
4. O total de linhas começa como estimativa. Clique em **Contar as linhas** para rodar `COUNT(*)` (pode demorar em tabelas grandes).
5. Para abrir um SELECT da tabela no editor, use **Abrir um SELECT desta tabela no editor**.

### Editar uma célula

1. Dê duplo clique na célula (ou selecione e pressione F2).
2. Digite o novo valor. **Enter** salva e **Esc** cancela. O menu da célula tem a opção de gravar NULL.
3. No navegador de tabela a alteração fica pendente até **Aplicar** (veja abaixo).

### Inserir, duplicar e apagar linhas

1. No navegador de tabela (aba **Dados**), clique em **Nova linha**, **Duplicar** (copia a linha sem a chave) ou **Apagar**. Os mesmos comandos estão no menu de clique direito.
2. Edições, linhas novas e linhas apagadas ficam pendentes e destacadas. Linhas novas mostram `+` e `(padrão)` nas colunas que usarão o valor padrão do banco. Linhas apagadas aparecem riscadas.
3. Clique em **Aplicar** para gravar tudo numa única transação. Cada UPDATE ou DELETE precisa atingir exatamente uma linha pela chave primária. Se algo falhar, nada é gravado.
4. Clique em **Descartar** para jogar fora tudo o que está pendente.
5. Com alterações pendentes, paginação, ordenação, filtros e recarga ficam em espera.

### Apagar várias linhas

1. Clique no número de uma linha para marcá-la. **Shift+clique** marca um intervalo. Clicar no cabeçalho `#` marca todas.
2. Clique em **Apagar N**. Abre uma confirmação com a tabela, as colunas de chave que identificam cada linha e uma amostra das linhas.
3. A partir de 20 linhas, a confirmação pede para digitar a quantidade.
4. Ao confirmar, a exclusão acontece na hora, numa única transação. Ela só é confirmada se cada linha casar exatamente com a chave; senão, nada é apagado.
5. Nos resultados do editor SQL isso só funciona num SELECT simples de uma tabela, com chave primária incluída no resultado (sem apelido nem expressão). Fora disso, o botão fica desabilitado e a dica diz o que falta, por exemplo, incluir `id` no SELECT.

### Escrever e rodar SQL

1. Clique em **Nova consulta** para abrir o **Editor de SQL**.
2. Escolha a conexão e o banco e escreva o SQL. O autocompletar sugere palavras do dialeto, tabelas, views, colunas e esquemas da conexão.
3. Clique em **Executar** (Ctrl+Enter). Com texto selecionado, roda só a seleção.
4. Ajuste o limite de linhas por resultado e o tempo máximo nos campos ao lado. Quando houver mais linhas, use **Carregar mais**.
5. Outros botões do editor: **Formatar o SQL**, **Plano de execução** (não altera dados) e **Localizar e substituir** (Ctrl+F).
6. Na grade de resultados você ajusta a largura das colunas arrastando, copia células e abre um visualizador de valor. A edição de célula funciona num SELECT simples de uma tabela que inclua todas as colunas da chave primária.

> Captura sugerida: editor SQL com a lista de autocompletar aberta e o resultado abaixo.

### Salvar consultas

1. No editor, clique no botão **Salvar esta consulta com um nome**, digite o nome e escolha **Todas as conexões** (padrão) ou **Só esta conexão**.
2. Uma consulta para todas as conexões aparece, com a etiqueta "todas", na lista de salvas de qualquer conexão e banco e na pasta **Queries** da árvore.
3. Pode existir o mesmo nome para todas as conexões e para uma só.
4. Abra a lista pelo botão **Consultas salvas e histórico**.

### Usar o histórico geral

1. Clique no botão **Histórico geral** (ícone de pergaminho) do editor.
2. Digite na busca: todos os termos precisam aparecer no SQL, no nome da conexão ou no banco. Os trechos achados ficam destacados.
3. Use **Filtrar por conexão** e a caixa **só as que deram erro** para reduzir a lista. A lista carrega 200 por vez.
4. Clique numa linha para abrir o SQL na conexão e no banco onde ele rodou. **Só o SQL** cola no editor atual sem trocar de conexão. Também dá para copiar e tirar uma entrada do histórico.
5. **Limpar tudo** pede confirmação antes de apagar.

### Exportar resultados

1. Com um resultado na tela, use os botões **CSV**, **CSV (;)** (abre direto no Excel em português), **JSON** e **SQL** (gera `INSERT` das linhas carregadas).
2. **Copiar** põe o resultado, com cabeçalho, na área de transferência, pronto para colar numa planilha.

### Usar o assistente de IA do banco

1. Abra **Configurações** e vá em **Banco de dados**.
2. Ative **Usar um modelo no Banco de dados** e escolha o **Provedor** e o **Modelo**. A chave é a mesma cadastrada em Provedores de IA. Veja [Agentes e voz](Agentes-e-voz).
3. No editor SQL, use o botão de corrigir a sintaxe (varinha) ou o de perguntar (ponto de interrogação). Para perguntar, digite em "Pergunta sobre este banco ou este SQL" e clique em **Perguntar**.
4. O assistente nunca executa o SQL que devolve. Você revisa e roda.

## Detalhes e limites

- **Onde ficam as conexões.** Em `db-connections.json`, na pasta de dados do Beth Studio (`%APPDATA%\bethstudio`). As senhas não ficam nesse arquivo: vão para o cofre criptografado do Windows (DPAPI).
- **Consultas e histórico.** As consultas salvas ficam em `db-queries.json`. O histórico fica em `db-history.jsonl` e guarda as últimas 5.000 execuções (SQL, conexão, banco, hora, duração, linhas, erro). Só entram instruções que de fato rodaram.
- **Quando uma célula não é editável.** Conexão somente leitura, JOIN, tabela sem chave primária e colunas que não vêm direto da tabela (como `nome AS id` ou `upper(nome)`) ficam só para leitura. No editor SQL a edição altera uma coluna e só confirma se exatamente uma linha casar com a chave.
- **Limites de execução.** Tempo padrão de 60 s (máximo de 600 s); passou disso, a consulta é cancelada. Linhas por pedido: padrão 1.000, máximo 10.000. Com **Carregar mais**, até 100.000 por resultado. Cada célula mostra até 64 KiB de texto (binário, 4 KiB em hexadecimal). O SQL enviado pode ter até 512 KiB e 200 instruções por envio.
- **Exportação.** Exporta só o que já está carregado na grade, dentro do limite de linhas. O botão **SQL** gera `INSERT`, não um dump do banco.
- **Dialetos.** Em MySQL, o comando `DELIMITER` do cliente não é entendido. Em SQL Server, cada lote separado por `GO` é enviado inteiro. Segundo a documentação interna, só o SQLite foi testado de ponta a ponta contra um banco real quando o módulo foi escrito.
- **Fora do escopo.** Não há diagrama ER, BI, agendamento, pasta de backups, nem transferência entre servidores. A janela do banco não existe no celular: ali o banco, o SSH e os arquivos ficam na janela do Studio ([Celular e acesso remoto](Celular-e-acesso-remoto)).

## Segurança e o que sai do computador

**Somente leitura.** Marque **Somente leitura** numa conexão (ou abra o Beth Studio em modo somente leitura, que vale para todas). Então:

1. Qualquer instrução que não seja leitura é recusada antes de ser enviada.
2. O que passa roda numa transação de leitura que é sempre desfeita (rollback). No SQL Server, que não tem transação somente leitura, valem o classificador e o rollback.
3. O SQLite abre o arquivo apenas para leitura.

**Confirmações.**

- Em conexões normais, toda instrução que altera algo (INSERT, UPDATE, DELETE, estrutura, transações, SET/USE) abre o diálogo **Confirmar alteração no banco**, com a lista das instruções. Só o mesmo texto confirmado executa.
- Instruções perigosas (DROP, TRUNCATE, UPDATE ou DELETE sem WHERE) mostram **Atenção: alteração perigosa** e pedem para digitar `CONFIRMAR`. O botão **Cancelar** vem com o foco.
- Apagar várias linhas tem confirmação própria (**Confirmar exclusão de linhas**).
- O classificador não enxerga efeitos colaterais dentro de um SELECT (por exemplo, `nextval`). Em conexão normal eles rodam sem confirmação; em conexão somente leitura a transação de leitura barra a maioria. Para produção, use **Somente leitura**.

**Senhas.** Ficam só no cofre DPAPI, nunca no arquivo de conexões nem nas respostas da API. Mensagens de erro têm a senha trocada por `••••`. O log guarda apenas o id da conexão, o número de instruções, linhas e tempo; não guarda SQL, valores nem erros do servidor.

**O que sai do computador.**

- As consultas vão direto do seu computador ao servidor do banco que você configurou. Nenhum dado de banco passa por serviço do Beth Studio.
- Só o **assistente de IA** envia algo a um provedor externo, e apenas quando você o usa. Vai o SQL do editor (ou a pergunta), o dialeto e os nomes de esquemas, tabelas e colunas (com tipos e marca de chave primária). Não vão linhas da tabela nem senhas.
- Se o assistente estiver desligado em **Configurações**, nada disso é enviado. O uso de cada chamada (provedor, modelo, tempo, custo) é registrado no controle de uso de IA do Beth Studio.
- O histórico e as consultas salvas ficam só neste computador. O histórico guarda o texto do SQL, então evite colocar segredos em instruções. **Limpar tudo** apaga o histórico.

Veja também [Segurança e privacidade](Seguranca-e-privacidade).
