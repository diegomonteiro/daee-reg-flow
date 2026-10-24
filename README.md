# REG-FLOW

Sistema web de regionalização de vazões e simulação de regularização intra-anual para o Estado de São Paulo (**SP-ÁGUAS / DAEE**).

## Documentação Completa e Swagger (OpenAPI 3.0)

Para facilitar o entendimento por servidores, engenheiros e ferramentas de IA (**Vibecoding**), o projeto conta com documentação técnica modular e especificação OpenAPI interativa:

- **Swagger UI Interativo (Browser)**: `http://localhost:3001/api-docs` (ou `/api/docs`)
- **Especificação OpenAPI 3.0.3 (JSON)**: `http://localhost:3001/api/openapi.json` ([`public/openapi.json`](public/openapi.json))
- **[Arquitetura do Sistema (`docs/ARCHITECTURE.md`)](docs/ARCHITECTURE.md)**: Diagramas de arquitetura, índices espaciais em memória (`basinBounds`, `ottotrechosByBasin`, grafo Pfafstetter), fluxo de requisições, segurança (CSP, gzip, rate limit) e estrutura do frontend.
- **[Metodologia Hidrológica e Algoritmos (`docs/METHODOLOGY.md`)](docs/METHODOLOGY.md)**: Detalhamento completo do estudo oficial do DAEE (1988) — Equações (1) a (22), cálculo de $V_c$ e $d_c$, exemplo do Rio Buquira (Região H), algoritmo de corte transversal (`splitBasinUpstreamByPoint`) e agregação à montante por ottocodificação (`collectUpstreamBasinCodes`).
- **[Referência da API REST (`docs/API_REFERENCE.md`)](docs/API_REFERENCE.md)**: Tabela completa dos 21 endpoints, parâmetros de query, payloads, exemplos `curl` e códigos HTTP.
- **[Guia de Vibecoding e Contexto para IA (`docs/VIBECODING_GUIDE.md`)](docs/VIBECODING_GUIDE.md)** e **[`AGENTS.md`](AGENTS.md)**: Mapa rápido de arquivos/funções, invariantes críticos e receitas de prompts para evolução segura assistida por IA.

## Requisitos

- Node.js 24.x
- npm 10 ou superior

## Desenvolvimento

```bash
npm ci
npm run dev
```

- Aplicação principal (Mapa): `http://localhost:3001` (ou `http://localhost:3001/reg-flow`)
- Documentação interativa Swagger UI: `http://localhost:3001/api-docs` (ou `http://localhost:3001/reg-flow/api-docs`)
- Healthcheck da aplicação e camadas em memória: `http://localhost:3001/api/health` (ou `http://localhost:3001/reg-flow/api/health`)

## Execução em Produção com Docker Compose (Subpath `/reg-flow`)

O projeto inclui [`Dockerfile`](Dockerfile) multi-stage otimizado (`node:24-alpine`, usuário não-root `node`, `HEALTHCHECK` nativo e *graceful shutdown* `SIGTERM`/`SIGINT`) e [`docker-compose.yml`](docker-compose.yml) configurado para rodar sob o subpath **`/reg-flow`** (`BASE_PATH=/reg-flow`) atrás do **Nginx já existente no servidor**:

### 1. Subir o container da aplicação
```bash
cp .env.example .env   # Opcional: configure MAPBOX_TOKEN se desejar cota altimétrica
docker compose up -d --build
```
*(Ou via npm: `npm run docker:up`)*

### 2. Configuração recomendada no Nginx existente do servidor
Adicione o bloco abaixo no `server { ... }` do Nginx já instalado no servidor (a aplicação aceita requisições tanto mantendo `/reg-flow` quanto com `X-Forwarded-Prefix`):
```nginx
location = /reg-flow {
    return 301 $scheme://$http_host/reg-flow/;
}

location /reg-flow/ {
    proxy_pass http://127.0.0.1:3001/reg-flow/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Prefix /reg-flow;
    client_max_body_size 65M;
    proxy_read_timeout 120s;
    proxy_send_timeout 120s;
}
```

### 3. Monitoramento e encerramento
```bash
docker compose ps
docker compose logs -f
docker compose down
```

## Verificações

```bash
npm run check
npm test
npm run test:coverage
```

## Configuração opcional

Copie o arquivo `.env.example` para `.env` na raiz do projeto para configurar as variáveis de ambiente locais:

```bash
cp .env.example .env
```

`MAPBOX_TOKEN` (ou `API_TOKEN`) habilita a consulta auxiliar de altitude via Mapbox Terrain v2. Se não estiver configurado ou o serviço estiver indisponível, o cálculo hidrológico continua normalmente sem altitude e o sentido de escoamento utiliza a topologia oficial da rede hidrográfica (`COBACIAJUS`).

## Fluxo principal

1. Informe latitude e longitude em graus decimais, use a localização do dispositivo ou clique no mapa.
2. Escolha se deseja o **Cálculo parcial da bacia (somente área à montante do ponto)** (`#partial-basin`, marcado por padrão) ou desmarque para calcular **100% da ottobacia inteira**.
3. Opcionalmente, marque **Considerar bacias à montante até a nascente (ottocodificação)** (`#include-upstream`) para agregar todas as ottobacias tributárias à montante.
4. Selecione **Calcular vazão**.
5. Confira a bacia, a área de contribuição (e sua proporção em relação à ottobacia completa), regiões, coeficientes, precipitação média, vazão média, Q95% e Q7,10 no painel lateral.

> **Controles de visualização dos painéis**:
> - O sidebar lateral de **Resultados** possui uma aba na borda direita da tela (`#toggle-results-sidebar`) com seta para colapsar e expandir o painel a qualquer momento.
> - O painel **Consultar vazão** pode ser recolhido individualmente pelo botão no canto superior direito do card (`#close-search`) e restaurado pelo botão flutuante **Consultar vazão** (`#restore-search-panel`).
> - O botão **Ocultar painéis / Mostrar painéis** (`#toggle-panels-visibility`) no cabeçalho recolhe ou restaura todos os painéis sobre o mapa de uma só vez.

Ao selecionar um ponto com o **Cálculo parcial da bacia** ativo (`partial_basin=true`), o sistema localiza a ottobacia e o ottotrecho associado, projeta o ponto clicado sobre o trecho de drenagem mais próximo e traça uma linha de seção transversal até tocar as duas extremidades laterais mais próximas da bacia (utilizando a tangente macro suavizada do trecho e selecionando a menor corda transversal que intercepta o curso d'água sem cruzar para fora da bacia). Quando desmarcado (`partial_basin=false`), o cálculo utiliza 100% da geometria oficial da ottobacia.

Opcionalmente, ao marcar **Considerar bacias à montante até a nascente (ottocodificação)** (`include_upstream=true`), o sistema percorre recursivamente a árvore hidrográfica à montante (via relação `COBACIA` / `COBACIAJUS` até as cabeceiras) e soma todas as ottobacias à montante, destacando os polígonos e trechos no mapa e listando cada ottobacia no painel de resultados.

Como fluxo adicional, selecione **Desenhar bacia**, marque os vértices com o Leaflet-Geoman e feche o polígono clicando no primeiro vértice. Nesse modo, as variáveis são calculadas diretamente a partir da geometria desenhada (até 5.000 vértices, sem autointerseções e contida no Estado de São Paulo), exibindo também a lista e participação percentual de cada ottobacia oficial intersectada.

Após qualquer cálculo, use **Simular outras isoietas** para comparar a camada histórica com até cinco camadas GeoJSON carregadas ou editadas pelo usuário (máximo de seis cenários por simulação). O botão **Editar** na camada histórica abre o editor cartográfico para alterar valores de faixas, editar vértices ou aplicar variações percentuais (`-99%` a `500%`) sobre uma sub-região desenhada.

Para avaliar o **Volume de Regularização Intra-Anual**, utilize **Regularização de vazão** no cabeçalho ou **Simular regularização de vazão** no painel de resultados. A funcionalidade implementa as **Equações (12), (13), (14) e (15)** da metodologia oficial do DAEE (*Regionalização Hidrológica no Estado de São Paulo*, 1988), determinando o volume necessário $V_c$ ($\text{m}^3$ e $\text{hm}^3$) e a duração crítica da estiagem $d_c$ (em meses, para $0 < d_c \le 6\text{ meses}$) para regularizar uma demanda firme $Q_F$ ($\text{m}^3/\text{s}$) associada a uma probabilidade $y\% = (100/T)\%$ de não atendimento em um ano qualquer ($T = 10, 15, 20, 25, 50, 100\text{ anos}$ ou personalizado). É possível simular até 12 cenários usando a **vazão calculada da bacia ($\overline{Q}$)**, informar $\overline{Q}$ diretamente, calcular por área e precipitação ou carregar o exemplo de referência do DAEE (Rio Buquira — Região H).

## Endpoints da API

Consulte a documentação completa em [`docs/API_REFERENCE.md`](docs/API_REFERENCE.md) ou acesse `/api-docs` (Swagger UI):

- `GET /api-docs` e `GET /api/openapi.json`: interface Swagger UI e especificação OpenAPI 3.0.3.
- `GET /api/coords_join/:lat/:lon`: calcula regionalização completa para a coordenada informada (aceita `?partial_basin=true|false` e `?include_upstream=true|false`).
- `POST /api/geometry_calculate`: calcula regionalização e interseções com ottobacias oficiais a partir de uma feição GeoJSON (`Polygon` ou `MultiPolygon`).
- `GET /api/regularization_catalog` e `POST /api/regularization_simulation`: catálogo de parâmetros regionais (`A`–`U`) e simulação de 1 a 12 cenários de regularização de vazão (Equações 12 a 15).
- `GET /api/isohyet_catalog`, `GET /api/isohyet_catalog/:id`, `POST /api/isohyet_editor_layer`, `POST /api/isohyet_adjust` e `POST /api/isohyet_simulation`: catálogo, editor cartográfico e simulação comparativa de isoietas.
- `GET /api/find_coefs/:lat/:lon`, `GET /api/find_coefs_by_region/:lat/:lon`, `GET /api/municipios`, `GET /api/municipios/:cod_ibge`, `GET /api/ottobacias/:cod`, `GET /api/ottotrechos/:cod`: consulta às camadas base.
- Rotas de cálculo hidrológico direto: `/api/calculate_discharge_avg/...`, `/api/calculate_q95/...`, `/api/calculate_qper/...`, `/api/calculate_q7_10/...`, `/api/calculate_q7/...`, `/api/calculate_minimal_discharge/...`, `/api/calculate_critical_duration/...`, `/api/calculate_volume_regularization/...`, `/api/calculate_max_volume_regularization/...`.

Os valores são estimativas e devem ser revisados antes de uso técnico ou decisório.
