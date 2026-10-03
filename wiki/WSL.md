# WSL

O Beth Studio abre terminais WSL só depois de o WSL estar pronto. Isso evita terminais que fecham logo ao abrir ou que caem na pasta errada quando a distro está parada.

## Como funciona

Antes de abrir um terminal WSL, o Studio faz quatro passos, sempre sem abrir janelas e com limite de tempo por comando (20 segundos):

1. **Espera a distro responder.** Ele pergunta ao Windows quais distros estão rodando (`wsl.exe -l --running -q`). Se a sua não está, executa `wsl.exe -d <distro> --exec true` e repete com intervalos crescentes, por até **60 segundos**. Se a distro não responder nesse prazo, o terminal não abre e o Studio mostra o motivo ("a distro X não respondeu em 60 s").
2. **Roda o comando de inicialização, se existir** (opcional, veja abaixo). Ele roda **uma vez por boot da VM do WSL**.
3. **Espera a pasta existir.** Se o terminal deve abrir numa pasta Linux, o Studio testa `wsl.exe -d <distro> --exec test -d <pasta>` a cada 1 segundo, por até **30 segundos**. Isso cobre pastas em montagens (por exemplo `/mnt/d/...`) que demoram a aparecer.
4. **Abre o terminal** com `wsl.exe -d <distro> --cd <pasta>`. A pasta Linux vai em `--cd` (e não como diretório do Windows) e a distro vai em `-d`. Sem pasta, abre na pasta inicial da distro.

**Fallback para a home.** Se a pasta não aparecer em 30 segundos, o terminal abre na pasta inicial (home) da distro, nunca em `/` e nunca numa pasta do Windows. Na restauração depois de uma queda, o resumo final avisa: "A pasta … ainda não existia; o terminal abriu na pasta inicial."

O mesmo cuidado vale em dois lugares:

- **Novo terminal WSL** (menu de novo terminal da interface e item **Novo terminal** da bandeja).
- **Restauração** de terminais depois de uma queda do host (veja [Host persistente e restauração](Host-persistente-e-restauracao)). Nesse caso a espera pela distro roda uma vez para cada distro envolvida, e os terminais são recriados até 3 ao mesmo tempo.

Durante a restauração, a faixa no alto do Studio mostra "Aguardando o WSL (Debian)…" enquanto a distro sobe.

> Captura sugerida: faixa "Aguardando o WSL (Debian)…" no alto do Studio.

### Comando de inicialização por distro

Algumas distros precisam de um comando depois de subir (iniciar serviços, montar um disco). Você o define no arquivo `%APPDATA%\bethstudio\wsl-distros.json`:

```json
{
  "Debian": { "init": "service ssh start", "user": "root", "timeout_sec": 60 }
}
```

- `init`: o comando, executado com `sh -c` dentro da distro.
- `user`: o usuário que o executa. Se faltar, usa `root`.
- `timeout_sec`: tempo máximo. Se faltar ou for zero, usa 60 segundos.
- O nome da distro é comparado sem diferenciar maiúsculas de minúsculas.

Como o Studio sabe "uma vez por boot": ele lê `/proc/sys/kernel/random/boot_id` da distro e guarda em que boot o comando já rodou. Depois de um `wsl --shutdown`, o identificador muda e o comando roda de novo. Se o comando falhar, o Studio registra o aviso e não o repete a cada terminal.

## Como usar

1. Abra o menu de novo terminal da interface (ou o item **Novo terminal** da bandeja) e escolha o WSL ou uma distro nomeada.
2. Se a distro estava parada, aguarde: o terminal aparece quando ela responde. Não é preciso abrir a distro antes.
3. Para um comando de inicialização, crie ou edite `%APPDATA%\bethstudio\wsl-distros.json` com o formato acima. O arquivo é lido quando o Studio inicia; reabra o Studio depois de alterá-lo.

## Limites e comportamentos a conhecer

- **Distro que não sobe em 60 segundos:** os terminais dela não abrem. Num novo terminal, o motivo aparece como erro; na restauração, o terminal conta como "não voltou" no resumo, com o motivo.
- **Pasta que não aparece em 30 segundos:** o terminal abre na home da distro. Para pasta vazia ou `~`, o Studio não espera nada.
- **Falha no comando de inicialização:** vira aviso (no resumo da restauração) e o terminal abre mesmo assim.
- **`wsl-distros.json` inválido** é ignorado, com uma linha no log do Studio. O arquivo aceita BOM UTF-8 (o Bloco de Notas e o Windows PowerShell 5.1 o gravam).
- **Nome de distro:** só letras, números, ponto, sublinhado e hífen, até 64 caracteres. Outros nomes são recusados.
- **Pasta do Windows num shell WSL** continua sendo diretório de trabalho do Windows; só pastas Linux (começando com `/`, ou `~`) viram `--cd`.
- **Uma ponte antiga** ignora o campo de distro sem dar erro.
- Não há tela para editar o `wsl-distros.json`; a edição é manual no arquivo.

Veja também: [Host persistente e restauração](Host-persistente-e-restauracao), [Terminais e abas](Terminais-e-abas), [Monitor do sistema](Monitor-do-sistema), [Perguntas frequentes](Perguntas-frequentes).
