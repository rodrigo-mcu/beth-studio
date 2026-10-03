# Como publicar a wiki no GitHub

A wiki do GitHub é um repositório Git separado, chamado `<repositório>.wiki.git`. As páginas ficam na pasta `wiki/` deste
repositório para serem revisadas junto com o código; para publicar, copie-as para o repositório da wiki.

1. No GitHub, abra a aba **Wiki** do projeto e crie a primeira página (qualquer texto). Isso cria o repositório da wiki.
2. Clone-o: `git clone https://github.com/<usuario>/<repositorio>.wiki.git`.
3. Copie para ele todos os `.md` de `wiki/` (inclusive `_Sidebar.md`) e o que estiver em `wiki/img/`.
4. `git add -A`, `git commit` e `git push`.

Notas:

- Os nomes dos arquivos viram os títulos e os links (`Terminais-e-abas.md` vira "Terminais e abas"). Os links entre páginas
  usam o nome do arquivo sem `.md`, como pede o GitHub.
- As capturas de tela pendentes estão em [`WIKI-CAPTURAS.md`](WIKI-CAPTURAS.md).
- Publicar é uma ação pública: confira o texto antes do `git push`.
