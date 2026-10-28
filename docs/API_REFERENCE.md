# Referência Completa da API REST — REG-FLOW

A API do **REG-FLOW** está documentada segundo o padrão **OpenAPI 3.0.3** e pode ser explorada e testada interativamente pelo navegador:

- **Swagger UI Interativo**: [`GET /api-docs`](http://localhost:3001/api-docs) (ou `/api/docs`)
- **Especificação OpenAPI 3.0 (JSON)**: [`GET /api/openapi.json`](http://localhost:3001/api/openapi.json) (arquivo fonte em [`public/openapi.json`](file:///home/diego-monteiro/apps/daee-reg-flow/public/openapi.json))

---

## 1. Resumo dos Endpoints

### 1.1. Consulta Espacial e Bacias

O modo parcial padrão usa MDE D8: busca a célula de drenagem mais próxima em toda a ottobacia, sem limite de distância. `include_upstream=true` inclui somente os ramos cujas entradas D8 alcançam a área local selecionada. Requer runtime e rasters MDE; não há fallback geométrico. `cross_section.line` agora é LineString/MultiLineString (ou null), e `delineation` informa ajuste, método e avisos.

| Método | Rota | Descrição | Rate Limit |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/coords_join/:lat/:lon` | Calcula a regionalização completa por coordenada geográfica. Suporta `?partial_basin=true\|false` e `?include_upstream=true\|false`. | 30 req/min |
| `POST` | `/api/geometry_calculate` | Calcula a regionalização e interseções de ottobacias a partir de um polígono GeoJSON desenhado (`{ geometry }`), com os ottotrechos oficiais que intersectam o desenho em `ottotrecho` (geometrias integrais e extremos para conferência). | 30 req/min |

#### Exemplo — Consulta com recorte parcial + bacias à montante:
```bash
curl "http://localhost:3001/api/coords_join/-24.665738/-47.992401?partial_basin=true&include_upstream=true"
```

#### Exemplo — Consulta da ottobacia inteira (sem corte parcial):
```bash
curl "http://localhost:3001/api/coords_join/-24.037685/-48.886414?partial_basin=false"
```

---

### 1.2. Regularização de Vazão (DAEE Equações 12, 13, 14 e 15)

| Método | Rota | Descrição | Rate Limit |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/regularization_catalog` | Retorna a tabela oficial das 21 regiões (`A`–`U`), períodos de retorno (`10`–`100` anos), $K = 2.628.000\text{ s/mês}$ e exemplo do Rio Buquira. | Livre |
| `POST` | `/api/regularization_simulation` | Simula de 1 a 12 cenários de regularização intra-anual ($V_c$, $d_c$, $Q_{1,T}$, série de 1 a 12 meses). | 30 req/min |

#### Exemplo — Simulação de Regularização (Exemplo Rio Buquira — Região H):
```bash
curl -X POST "http://localhost:3001/api/regularization_simulation" \
  -H "Content-Type: application/json" \
  -d '{
    "base": {
      "region": "H",
      "avg_discharge_m3s": 9.48,
      "area_km2": 401.5,
      "rainfall_mm": 1685
    },
    "scenarios": [
      { "name": "Rio Buquira 10% (T=10 anos)", "qf_m3s": 5.0, "return_period_years": 10 },
      { "name": "Rio Buquira 4% (T=25 anos)", "qf_m3s": 5.0, "return_period_years": 25 }
    ]
  }'
```

---

### 1.3. Simulação e Editor Cartográfico de Isoietas

| Método | Rota | Descrição | Limite de Body |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/isohyet_catalog` | Lista camadas de isoietas do catálogo (`historical-1980`). | — |
| `GET` | `/api/isohyet_catalog/:id` | Retorna o GeoJSON completo da camada do catálogo. | — |
| `POST` | `/api/isohyet_editor_layer` | Recorta uma camada de isoietas para os limites da bacia (`{ layerId, geometry }`). | 512 KB |
| `POST` | `/api/isohyet_adjust` | Aplica variação percentual (`-99%` a `+500%`) nas faixas de chuva dentro de uma sub-região (`{ layerId, layer, region, percentage }`). | 60 MB |
| `POST` | `/api/isohyet_simulation` | Compara de 1 a 6 cenários de isoietas sobre a mesma bacia (`{ geometry, scenarios }`). Aceita `Content-Encoding: gzip`. | 60 MB |

---

### 1.4. Cálculos Hidrológicos Diretos

| Método | Rota | Equação DAEE (1988) |
| :--- | :--- | :--- |
| `GET` | `/api/calculate_discharge_avg/:coef_a/:coef_b/:avg_rainfall/:area_km2` | Equação (1) — Vazão média plurianual ($\overline{Q}$) |
| `GET` | `/api/calculate_q95/:region/:qls_m3s/:area_km2` | Equação (18) — Vazão de permanência $Q_{95\%}$ |
| `GET` | `/api/calculate_qper/:region/:qls_m3s` | Equação (16) — Curva de permanência ($5\%$ a $100\%$) |
| `GET` | `/api/calculate_q7_10/:region/:c/:val_a/:val_b/:qls_m3s` | Equação (22) — Vazão mínima $Q_{7,10}$ |
| `GET` | `/api/calculate_q7/:region/:c/:val_a/:val_b/:qls_m3s/:area_km2` | Equação (22) — Vazões mínimas $Q_{7,T}$ ($T = 10..100$) |
| `GET` | `/api/calculate_minimal_discharge/:region/:time/:a/:b/:dmonth/:qls_m3s` | Equação (12) — Vazão mínima mensal $Q_{d,T}$ |
| `GET` | `/api/calculate_critical_duration/:qf/:xt/:a/:b/:qls_m3s` | Equação (15) — Duração crítica $d_c$ (com $X_T$ explícito) |
| `GET` | `/api/calculate_critical_duration/:region/:time/:qf/:a/:b/:qls_m3s` | Equação (15) — Duração crítica $d_c$ (por região e índice $T$) |
| `GET` | `/api/calculate_volume_regularization/:qf/:xt/:a/:b/:d/:qls_m3s/:k` | Equação (13) — Volume de regularização $V(d)$ |
| `GET` | `/api/calculate_max_volume_regularization/:qf/:region/:t/:a/:b/:qls_m3s/:months` | Equação (14) — Volume máximo intra-anual $V_c$ |

---

### 1.5. Camadas Base e Cadastros

| Método | Rota | Descrição |
| :--- | :--- | :--- |
| `GET` | `/api/find_coefs/:lat/:lon` | Retorna as propriedades brutas das feições `RAU` e `RXYZ` que contêm o ponto. |
| `GET` | `/api/find_coefs_by_region/:lat/:lon` | Retorna a ottobacia, ottotrecho e coeficientes ponderados da ottobacia inteira. |
| `GET` | `/api/municipios` | Lista todas as feições de municípios paulistas (`municipios_sp.json`). |
| `GET` | `/api/municipios/:cod_ibge` | Filtra feições municipais pelo código IBGE (`COD_IBGE`). |
| `GET` | `/api/ottobacias/:cod` | Retorna a feição da ottobacia pelo código `COBACIA`. |
| `GET` | `/api/ottotrechos/:cod` | Retorna os trechos de drenagem associados ao código `COBACIA`. |

---

## 2. Códigos de Status HTTP e Tratamento de Erros

Todas as respostas de erro em `/api/*` retornam JSON no formato `{ "error": "Mensagem descritiva" }`:

- `200 OK`: Processamento concluído com sucesso.
- `400 Bad Request`: Parâmetro ausente/inválido, coordenada fora do Estado de São Paulo (`Point outside SP`) ou geometria inválida.
- `404 Not Found`: Ottobacia, camada de isoietas ou coeficientes não encontrados.
- `413 Payload Too Large`: Payload excede 60 MB descompactados.
- `422 Unprocessable Entity`: Geometria com autointerseções ou camada de isoietas cobrindo menos de 95% da bacia.
- `429 Too Many Requests`: Limite de 30 requisições por minuto atingido.


## Delimitação por MDE

`GET /api/dem_delineation/:lat/:lon` retorna divisor interno (`divide`), polígono local (`contributing_area`), exutório ajustado, distância efetiva e entradas a montante conectadas. Sem limite de distância; rede extraída por área contribuinte mínima `DEM_MIN_DRAINAGE_AREA_KM2=0.1`. O parâmetro antigo `snap_distance_m` na query é ignorado; na resposta continua representando a distância efetiva. O mesmo algoritmo substitui a linha reta em `/api/coords_join` com `partial_basin=true`. Uma tarefa por processo, execução Python limitada a 8,5 s; erros 422/503 são propagados. Consulte [preparação e limitações](DEM_DELINEATION.md).

As respostas de `/api/coords_join` no modo parcial e `/api/dem_delineation` incluem `topography` (PNG data URI, bounds Leaflet, cotas representadas, resolução nativa e tamanho até 512 px) e `topography_warning`. A imagem representa o MDE de entrada na ottobacia do ponto; os polígonos externos agregados por `include_upstream` não ampliam o recorte. Consulte o schema `TopographyOverlay` em OpenAPI.

`GET /api/coords_join/:lat/:lon?partial_basin=false&include_topography=true` permite visualizar a topografia da ottobacia inteira sem executar a delimitação D8. `include_topography` é independente de `partial_basin`, vale true por padrão e aceita false/0 para não gerar a imagem. A geometria e as vazões do modo integral não são alteradas.

Os campos numéricos principais de vazão, área e volume são brutos, sem arredondamento para a interface. A apresentação usa casas adaptativas para valores pequenos. Na regularização, nomes gerados automaticamente também preservam a leitura de demandas positivas pequenas. Campos legados com sufixo `_rounded` são apenas alternativas explícitas de exibição; não os usar como entrada dos cálculos.

## Microbacias de uma ottobacia

`GET /api/ottobacias/:cod/microbasins?min_drainage_area_km2=0.1` retorna `FeatureCollection` de unidades incrementais D8 com `metadata`. `kind=stream_reach` identifica microbacias por trecho; `kind=residual_outlet` identifica saídas sem passagem pela rede acima do limiar. `downstream_unit_id` liga as unidades e não é ottocódigo. As feições são disjuntas, recortadas à ottobacia e não incluem bacias externas. O limiar é positivo, em km², e vale `DEM_MIN_DRAINAGE_AREA_KM2` ou 0,1 por padrão. Cache HIT/MISS por header; 400 para limiar inválido, 404 para código ausente, 422 para dados inválidos/ciclos/limites espaciais, 429 para rate limit e 503 para indisponibilidade/ocupação/limite de execução. Ver OpenAPI e [metodologia detalhada](DEM_DELINEATION.md).

### Memorial da consulta

`GET /api/coords_join/:lat/:lon` e `POST /api/geometry_calculate` incluem `calculation_memorial`: área final, interseções das isoietas, regiões RAU/XYZ, denominadores das ponderações, coeficientes utilizados e fatores f95/X10 com vazões por região, além dos resultados finais. O modal **Ver memorial de cálculo** apresenta essas etapas da consulta corrente com fórmulas e unidades. A memória usa os parâmetros da resposta; a apresentação arredonda valores, sem alterar as equações ou entradas de cálculo.

### Oferta natural e usos outorgados

`POST /api/water_balance` recebe `{ geometry: Feature<Polygon|MultiPolygon>, selection?: "drawn-geometry" | "calculated-geometry" }`. Usa a geometria final do cálculo, incluindo corte MDE e bacias agregadas; no desenho a seleção é espacial pelo polígono. Recalcula vazões naturais DAEE e consulta WFS 2.0.0 da SP-ÁGUAS. Devolve `reference`, `groups`, `commitment`, `counts`, `statuses`, `outorgas`, `warnings`, `complete` e `accounting_complete`. `commitment` usa exclusivamente vazões instantâneas superficiais (captações − lançamentos), com percentuais para Q média/Q95/Q7,10 sem limitar a faixa 0–100; informa status e motivos quando parcial ou não calculável. Ver [WATER_BALANCE.md](WATER_BALANCE.md) para critérios, unidades, limites e diferenças entre ausência de registros e dados ausentes. Erros: 400/413/422 de geometria, 429 de rate limit, 502 quando não é possível conferir a consulta inteira ao WFS. Header `X-Cache` corresponde apenas aos dados de outorgas.

Na consulta `/api/coords_join`, `topography.scope=calculated_basin` identifica o raster e as curvas recortados à geometria final após delimitação e agregação a montante. A imagem acompanha `include_upstream` com cálculo parcial ligado ou desligado; uma falha visual gera `topography_warning` e não substitui a imagem por um recorte local. O endpoint independente `/api/dem_delineation` mantém `scope=clicked_ottobasin`.


## Validação e compatibilidade das correções de integridade

- As rotas por geometria aceitam Feature ou Geometry Polygon/MultiPolygon. O schema OpenAPI define anéis e posições; contenção em SP, fechamento e topologia também são verificados pelo servidor.
- Para reutilizar redes a montante e recortes MDE retornados pelo servidor, manter a geometria e `_regflow_geometry_token` intactos. Marcadores booleanos e coeficientes enviados não dispensam validação nem alteram o cálculo natural.
- Isoietas enviadas para simulação devem formar faixas sem sobreposição significativa dentro da bacia. A cobertura é calculada pela união geométrica; duplicatas ou faixas conflitantes retornam 422, mesmo quando a chuva é igual.
- Índices de período de retorno e quantidades de meses inteiros rejeitam decimais com 400. Divisões por zero e resultados não finitos retornam 422 nas APIs de cálculo direto, em vez de valores `null` com status 200.
- Na rota legada `calculate_max_volume_regularization`, `months` é mantido na URL e validado, mas não multiplica mais o resultado: o máximo da Equação (14) usa somente K = 2.628.000 s/mês. Para séries de déficit por duração, usar `regularization_simulation` ou a Equação (13).


### Microbacias da área final da regionalização

`POST /api/microbasins`, corpo `{ "geometry": <resultado.ottobacia>, "min_drainage_area_km2": 1 }`, retorna as microbacias de toda a área considerada: recorte pelo ponto mais os ramos a montante efetivamente selecionados. Preservar `_regflow_geometry_token`. A resposta contém `metadata.scope = "calculated_basin"`. Polígonos adjacentes são dissolvidos antes do grafo D8, permitindo conexões através de limites internos. Unidades são incrementais/disjuntas, com residuais explícitos; o limiar de 1 km² extrai a rede e não é um tamanho mínimo das unidades.

O GET por código permanece restrito à ottobacia oficial inteira (`scope = "within_ottobasin"`). Os resultados dos dois escopos e de diferentes recortes não compartilham indevidamente a mesma entrada de cache. POST: até 2 MiB, validação de geometria, 30 requisições/min/IP, códigos 400/413/422/429/503. Mantidos limites de 4 milhões de células, 5.000 unidades e 8,5 segundos de execução; não há retorno truncado de apenas parte das bacias.

### Outorgas por etapas

- `POST /api/water_balance/start`: `{ geometry, selection }` → `{ plan, cache: "MISS" }` ou `{ result: WaterBalanceResponse, cache: "HIT" }`. Referências naturais recalculadas; plano espacial assinado por 30 minutos.
- `POST /api/water_balance/page`: `{ geometry, plan, cells: [índices do plano, até 8], start_index: 0, previous? }` → `{ receipt, preview }`. Paginação de 500 registros com orçamento independente de 8 s; enviar o recibo anterior para continuar. O preview já contém pontos normalizados e filtrados pela geometria final. 180 chamadas/min/IP.
- `POST /api/water_balance/complete`: `{ geometry, plan, receipts: [...] }` → `WaterBalanceResponse`. Exige cobertura completa do plano e assinaturas válidas; deduplica FIDs de borda e mantém regras do balanço. 409 para conflito na fonte; 410 para plano expirado; 422 para etapas pendentes/limites. Somente esta resposta ou um cache completo autoriza apresentar o balanço como consulta concluída.

Corpos: 2 MiB em start/page, 8 MiB em complete. Não alterar o conteúdo assinado; preservar o plano e recibos integralmente. Configurar GEOMETRY_SIGNING_SECRET comum às réplicas. Progresso corresponde a setores concluídos, limitado a 99% até complete. Ver [detalhes, retomada e limites](WATER_BALANCE.md#carregamento-progressivo-interface-padrão) e os contratos OpenAPI.

Nas consultas de outorgas por etapas, HTTP 429 inclui `Retry-After` (segundos ou data HTTP do WFS). O navegador compartilha o cooldown entre workers, exibe contagem regressiva e retoma automaticamente a etapa bloqueada. Páginas são espaçadas em ao menos 400 ms; 429 não provoca subdivisão de setores. O limitador local informa os segundos restantes da janela; o bloqueio remoto é repassado. Ver [cooldown](WATER_BALANCE.md#cooldown-e-respostas-429).
