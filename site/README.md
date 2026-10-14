# Site de divulgação

Página estática do Beth Studio em dois idiomas:

- `index.html`: português do Brasil
- `en/index.html`: inglês
- `assets/style.css`: estilos compartilhados

Sem build, sem dependências, sem fontes ou scripts externos, sem rastreadores. Dá para abrir os arquivos direto do disco.

## Publicar no GitHub Pages

Isto é só uma instrução; nada foi ativado.

1. No GitHub, abra o repositório e vá em **Settings > Pages**.
2. Em **Build and deployment**, escolha **Deploy from a branch**.
3. Escolha a branch `main` e a pasta `/site` (se o seletor só oferecer `/` ou `/docs`, renomeie `site/` para `docs/` ou publique pela raiz).
4. Salve e espere a publicação. As duas versões ficam em `/` (português) e `/en/` (inglês).

Todos os links internos são relativos, então funcionam tanto na raiz do domínio quanto em subcaminho.

## Capturas de tela (espaços reservados)

A página reserva espaços de proporção fixa para capturas reais. Enquanto o arquivo não existir, aparece um esquema rotulado; quando a imagem carrega, o esquema some. Basta colocar os arquivos em `assets/shots/`:

| Arquivo | Proporção | O que mostrar |
|---|---|---|
| `hero-studio.webp` | 4:3 (1044x788) | Janela do Studio com barra lateral, abas e dois terminais divididos (PowerShell e cmd) |
| `voz-configuracao.webp` | 4:3 (1044x788) | Configurações > Voz e IA: microfone, "Testar tudo", provedor, modelo e idioma da transcrição |
| `tarefas.webp` | 4:3 (1044x788) | Gerenciador de tarefas com CPU, memória, GPUs, disco e o WSL2 em camadas |
| `wsl-ubuntu.webp` | 4:3 (1044x788) | Terminal WSL com Ubuntu aberto na pasta do terminal do Windows |
| `grade-terminais.webp` | 4:3 (1044x788) | "Todos os terminais": grade com prévia, busca e filtros |
| `provedores-ia.webp` | 4:3 (1044x788) | Configurações > Provedores de IA (sem chaves cadastradas) |
| `voz-celular.webp` | 9:19 (ex.: 900x1900) | (ainda sem captura) WebApp do celular com o texto ditado no campo de mensagem |

Tema claro/escuro: segue o sistema e tem botão no cabeçalho; a escolha fica em `localStorage` (a página funciona sem ele).

## Como as capturas foram feitas

Todas vêm de um PC Windows 11 de teste com o Beth Studio instalado a partir do release, em pastas e com prompt neutros (`C:\demo\…`). Antes de publicar uma captura nova, confira que ela não mostra nome de usuário do Windows, nome do computador, caminhos pessoais, senhas nem nomes de clientes ou da empresa.
