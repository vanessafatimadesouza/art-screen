# Art Screen

Art Screen transforma uma guia do navegador em uma galeria digital minimalista. A tela inicial permite escolher uma atmosfera; depois de Start, a interface desaparece e obras Open Access do Metropolitan Museum of Art alternam com um crossfade lento.

O projeto é inteiramente estático: HTML, CSS e JavaScript puro. Não há build, dependências, conta ou backend.

## Como funciona

- A página consulta a [Collection API do Metropolitan Museum of Art](https://metmuseum.github.io/).
- Primeiro busca identificadores relacionados à atmosfera escolhida e depois carrega apenas os dados necessários de uma obra por vez.
- Toda obra é validada individualmente e só entra na sequência quando `isPublicDomain === true`; `hasImages=true` é apenas um filtro preliminar.
- A imagem seguinte é carregada e decodificada antes da troca.
- O filtro aceita somente imagens horizontais de obras bidimensionais, descartando esculturas, fotografias de objetos, arquitetura e instalações. A obra atual permanece visível se a API ou a imagem seguinte falhar.
- Favoritos, categoria, intervalo, pausa e um histórico recente ficam apenas neste navegador, em `localStorage`.
- O histórico reduz repetições recentes. Somente a obra atual e a próxima imagem preparada ficam carregadas.
- A API do Met é pública, não exige chave e permite chamadas diretas do navegador (CORS).

As atmosferas Landscape, Impressionism, Nature, Portraits, Classics e Surprise me são buscas temáticas na coleção do Met. Classics combina termos de pintura com o intervalo de 1200 a 1800; Surprise me alterna entre consultas variadas. Como a catalogação é feita pelo museu, os resultados podem incluir técnicas próximas à categoria, não apenas pinturas.

## Controles

Mova o mouse para revelar os controles. Após alguns segundos sem interação, interface e cursor desaparecem.

- `→`: próxima obra
- `←`: obra anterior nesta sessão
- `Espaço`: pausar ou continuar
- `F`: tela cheia pela API do navegador
- `I`: mostrar ou esconder as informações da obra
- `Esc`: voltar à escolha de atmosfera
- `F11`: tela cheia nativa do navegador (recomendado para uso prolongado)

O coração salva ou remove a obra dos favoritos. Quando houver itens salvos, a opção **Favorites** aparece discretamente na tela de atmosferas.

## Testar localmente

Como o site é estático, você pode abrir `index.html` diretamente. Alguns navegadores aplicam restrições extras a páginas abertas com `file://`; por isso, a forma mais confiável é usar um servidor estático local.

Com Python instalado, na pasta do projeto:

```bash
python3 -m http.server 8000
```

Depois acesse `http://localhost:8000`.

## Publicar no GitHub Pages

1. Entre no GitHub e crie um repositório novo, por exemplo `art-screen`. Não é necessário adicionar arquivos automáticos se você já tem esta pasta.
2. Na pasta do projeto, execute:

```bash
git init
git add .
git commit -m "Cria Art Screen"
git branch -M main
git remote add origin https://github.com/SEU-USUARIO/art-screen.git
git push -u origin main
```

3. No repositório, abra **Settings → Pages**.
4. Em **Build and deployment**, escolha **Deploy from a branch**.
5. Selecione a branch `main`, a pasta `/ (root)` e clique em **Save**.
6. Aguarde a publicação. A página normalmente ficará em:

```text
https://SEU-USUARIO.github.io/art-screen/
```

Nenhum caminho absoluto ou configuração de servidor é usado, então o projeto funciona em um subdiretório do GitHub Pages.

## Alterar configurações

As constantes principais ficam no começo de `script.js`:

- `DEFAULT_INTERVAL`: intervalo padrão, em milissegundos. O valor inicial é `5 * 60 * 1000` (5 minutos).
- `UI_HIDE_DELAY`: tempo até controles e cursor sumirem.
- `INFO_HIDE_DELAY`: tempo de exibição das informações.
- `RECENT_LIMIT`: quantidade de obras mantidas no histórico antirrepetição.
- `FETCH_TIMEOUT`: limite de espera para cada chamada da API.

Para alterar o tempo do crossfade, mude `--fade` no início de `style.css`.

> Preferências já salvas no navegador prevalecem sobre o novo intervalo padrão. Para recomeçar, limpe os dados do site no navegador ou remova a chave `artScreen.interval` do `localStorage`.

## Privacidade e disponibilidade

O Art Screen não envia favoritos nem preferências a nenhum servidor. As únicas chamadas externas são para a API e para as imagens hospedadas pelo Met. A disponibilidade das obras depende desse serviço público; falhas são tratadas silenciosamente e uma nova tentativa é feita sem remover a obra atual.
