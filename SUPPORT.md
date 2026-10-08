# Suporte

O Beth Studio é mantido por uma pessoa, no tempo livre. Este arquivo diz o que dá para esperar.

## O que é suportado

| | Situação |
| --- | --- |
| **Windows 10 / 11 (64 bits)** | Suportado. É onde o projeto é desenvolvido e testado. |
| **Linux e macOS** | Ainda não. Há um plano em `docs/` e ajuda é bem-vinda (abra uma issue antes). |
| **Janela nativa de terminal** | Removida. O Beth Studio é a interface web (Studio, em janela WebView2 ou no navegador) mais o host persistente. |
| **Versão** | Só a última versão publicada recebe correções. |

## Onde pedir ajuda

1. Leia a **wiki** (pasta `wiki/`): instalação, perguntas frequentes e solução de problemas.
2. Procure nas **issues** se o assunto já apareceu.
3. Abra uma issue nova com: versão (Configurações > Sobre), versão do Windows, o que você esperava, o que aconteceu e, se der, o trecho relevante de `%APPDATA%\bethstudio\host-life.log`. **Não cole senhas, tokens ou chaves.**

Não há prazo de resposta garantido. Pull requests pequenos e com teste costumam ser analisados mais rápido (veja `CONTRIBUTING.md`).

## Segurança

Falhas de segurança **não** vão em issue pública. Use *Security > Advisories > Report a vulnerability* no GitHub (veja `docs/SECURITY.md`).

## O que o projeto não faz

- Não há telemetria nem envio automático de dados. O que sai do seu computador (voz, provedores de IA, acesso remoto) só acontece quando você configura (veja `docs/PRIVACY.md`).
- Não há garantia de nenhum tipo; a licença é a do `LICENSE.md` e a de cada pasta.
