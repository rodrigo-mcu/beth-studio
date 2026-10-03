# SSH, serial e SFTP

O Beth Studio guarda hosts SSH e portas seriais, abre cada um como um terminal comum e tem uma janela própria de SFTP para enviar e baixar arquivos. Tudo isso funciona no Windows, pela tela **SSH e Serial** do Studio.

Uma sessão SSH ou serial roda dentro do [host persistente](Host-persistente-e-restauracao), como qualquer outro terminal. Fechar a aba do Studio não derruba a sessão.

> Captura sugerida: tela "SSH e Serial" com a lista de hosts à esquerda e os detalhes de um host à direita.

## Como usar

### Salvar e abrir um host SSH

1. No painel lateral do Studio, clique no botão **SSH e Serial**.
2. Na aba **SSH**, clique em **Novo host**.
3. Preencha **Nome na lista**, **Endereço (host ou IP)**, **Usuário** e **Porta**. Se quiser, preencha também **Grupo**, **Etiqueta**, **Cor**, **Notas** e **Pasta inicial dos arquivos (SFTP)**.
4. Em **Autenticação**, escolha um método:
   - **Senha**: marque **Salvar a senha (cifrada com a conta do Windows)** para não digitar de novo. Sem isso, o terminal pergunta a senha ao conectar.
   - **Arquivo de chave**: informe o **Arquivo da chave privada** (por exemplo `~/.ssh/id_ed25519`). Se a chave tem frase-senha, você pode guardá-la com **Salvar a frase-senha (cifrada)**.
   - **Agente SSH do Windows**: usa as chaves carregadas no serviço "OpenSSH Authentication Agent" (adicione com `ssh-add`). Nenhuma credencial é guardada pelo Beth Studio.
5. Clique em **Testar conexão** para conferir se o servidor responde e depois em **Salvar**.
6. Na lista, dê um duplo clique no host, ou selecione-o e clique em **Conectar**. O terminal abre numa aba nova.

Para trazer hosts que você já tem, clique em **Importar** (**Importar do ~/.ssh/config**), marque os que quer e confirme. Você também pode **Duplicar**, **Editar** e **Apagar** um host. A busca no topo da lista procura por nome, endereço e grupo.

### Abrir uma porta serial

1. Em **SSH e Serial**, abra a aba **Serial**.
2. Clique em **Novo perfil serial**, ou clique em uma das **Portas detectadas** para criar um perfil a partir dela. O botão de atualizar procura as portas de novo.
3. Ajuste **Porta** (por exemplo `COM3`), **Velocidade (baud)**, **Bits de dados**, **Paridade**, **Bits de parada** e **Controle de fluxo** (**Nenhum**, **Hardware (RTS/CTS)** ou **Software (XON/XOFF)**). Os padrões são 115200 8N1, sem controle de fluxo.
4. Escolha o que o Enter envia (**Enter envia**: CR, LF ou CR+LF). Se quiser, marque **Eco local (mostrar o que eu digito)** e **Hora em cada linha recebida**.
5. Opcionalmente, preencha **Salvar o que chegar em arquivo (opcional)** com um caminho completo. O texto recebido é acrescentado ao fim desse arquivo.
6. Clique em **Salvar** e depois em **Conectar**.

Para encerrar a sessão serial pelo teclado, use `Ctrl+]` (como no telnet). Fechar o terminal pelo Studio também encerra.

### Enviar e baixar arquivos (SFTP)

1. Em **SSH e Serial**, selecione um host SSH.
2. Clique em **Janela SFTP**. Abre uma janela do Windows separada, com botão próprio na barra de tarefas. Você pode abrir várias ao mesmo tempo.
3. A janela mostra dois painéis, **Local** e **Remoto**, e uma fila de envios e downloads com progresso, velocidade e opção de cancelar.
4. Se preferir ficar dentro do Studio, clique em **Arquivos (SFTP)**. É um navegador de arquivos simples do host: arraste arquivos para a pasta para enviar e use os ícones para baixar (vai para a pasta Downloads), renomear, apagar, criar pasta e subir um nível.

Com um terminal SSH aberto, o botão de SFTP no cabeçalho do terminal abre a mesma janela. Isso só funciona se o terminal veio de um host salvo. Pela linha de comando: `bethstudio-web.exe --sftp <id-do-host>`.

### Login de agente em um servidor remoto

Quando você roda um agente de IA dentro de uma sessão SSH, ele costuma imprimir um link `http://localhost:PORTA/...` para você entrar na conta. Esse link não funciona no seu PC, porque a porta existe só no servidor. O Beth Studio resolve sozinho:

1. A sessão detecta o link impresso.
2. Abre a mesma porta neste PC e encaminha cada conexão pela sessão SSH que já está aberta.
3. Abre o link no navegador padrão do Windows.
4. O terminal mostra uma linha cinza avisando que a porta foi encaminhada.

Você não precisa configurar nada.

## O executável `bethstudio-tool.exe`

`bethstudio-tool.exe` é o programa que roda dentro do terminal de uma sessão SSH ou serial. O host cria o terminal executando `bethstudio-tool.exe --ssh <id>` ou `bethstudio-tool.exe --serial <id>`, onde `<id>` é o identificador do host ou perfil salvo.

O que ele faz:

- Lê o host ou perfil salvo e, no caso do SSH, a credencial guardada no cofre do Windows.
- Conecta, pede um terminal remoto do tamanho do seu e acompanha o redimensionamento.
- Liga teclado e tela à sessão remota (ou à porta COM) até o outro lado sair.
- Faz as perguntas no próprio terminal: confirmar a chave de um servidor novo e pedir senha sem eco.
- No serial, se a porta não existe ou some (cabo USB removido), espera ela voltar sem fechar o terminal.
- Em caso de erro, mostra uma mensagem em português e espera uma tecla antes de fechar.

Ele é compilado do mesmo código do `bethstudio-web.exe`, mas como programa de console. Isso é necessário porque um programa sem console não consegue ler teclas dentro de um terminal. Normalmente você não o executa à mão. O navegador nunca manda uma linha de comando: só o tipo (`ssh` ou `serial`) e o identificador salvo, que o programa confere antes de abrir.

## Detalhes e limites

**Onde ficam os dados**

- Hosts SSH: `%APPDATA%\bethstudio\ssh-hosts.json`. Só metadados (nome, endereço, usuário, método, caminho da chave).
- Perfis seriais: `%APPDATA%\bethstudio\serial-profiles.json`.
- Chaves de servidores confirmadas: `%APPDATA%\bethstudio\ssh_known_hosts` (formato OpenSSH).
- Senha e frase-senha: `%APPDATA%\bethstudio\secrets.dat`, cifradas com a proteção de dados do Windows (DPAPI), presas à sua conta de usuário. Elas nunca voltam para a tela: a interface só sabe se existe uma senha salva. O mesmo cofre guarda as chaves dos provedores de IA (veja [Agentes e voz](Agentes-e-voz)).

**O que sai do computador**

- A sessão SSH e o SFTP falam só com o servidor que você escolheu.
- SSH e arquivos não passam pelo acesso remoto: em [Celular e acesso remoto](Celular-e-acesso-remoto) eles continuam só na janela do Studio.
- Portas seriais são locais.

**Confiança na chave do servidor**

- Na primeira conexão, o terminal mostra o tipo e a impressão digital da chave e pergunta "Confiar nesta chave e continuar? (s/N)". Confira com quem administra o servidor.
- Se a chave mudar depois, a conexão é recusada, sem opção de continuar na hora. Se a troca é legítima (servidor reinstalado), clique em **Esquecer chave salva…** no host e conecte de novo.

**Limites e comportamentos**

- Só Windows.
- Na importação do `~/.ssh/config`, são lidos os blocos `Host`. `Include` e `Match` não são seguidos, e `ProxyJump` e `ProxyCommand` não são suportados (aparecem como aviso no candidato). Aliases com curinga não viram hosts.
- O encaminhamento de porta só vale para links `http(s)` com porta explícita 1024 ou maior. Se a porta já estiver em uso neste PC, o terminal avisa e sugere usar o código de dispositivo do agente, se ele oferecer.
- O envio por SFTP aceita até 16 GB por arquivo. Sobrescrever um arquivo que já existe pede confirmação. A conexão do navegador de arquivos é encerrada depois de 3 minutos sem uso.
- A janela SFTP não passa pelo host: ela usa só os dados salvos e abre a própria conexão.
- Com o host em modo somente leitura, criar terminal SSH ou serial fica desabilitado.
- Se o host reiniciar vazio, o Studio recria os terminais SSH e serial a partir do host ou porta salvos (veja [Host persistente e restauração](Host-persistente-e-restauracao)).
- O título do terminal SSH é `usuario@host:porta`.

## Veja também

- [Terminais e abas](Terminais-e-abas)
- [Terminal destacado](Terminal-destacado)
- [Segurança e privacidade](Seguranca-e-privacidade)
- [Referência da CLI e API](Referencia-da-CLI-e-API)
