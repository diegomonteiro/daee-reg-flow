# AGENTS.md — Instruções para Agentes de IA (Vibecoding)

Este arquivo fornece o contexto essencial do projeto **SP-ÁGUAS | REG-FLOW** para agentes de codificação autônomos.

## 1. Visão Geral do Projeto
- **Domínio**: Sistema web de Regionalização Hidrológica do Estado de São Paulo (DAEE, 1988).
- **Stack**: Node.js `24.x`, Express `4.x`, EJS (`views/index.ejs`, `views/api-docs.ejs`), Turf.js (`@turf/turf` v6.5), Leaflet `1.9.4` + Leaflet-Geoman `2.20.0`.
- **Sem Banco de Dados Externo**: Todas as camadas cartográficas oficiais (`public/layers/*.json`) são carregadas e indexadas em memória na inicialização de `routes/apis.js`.

## 2. Documentação de Referência Interna
Antes de modificar cálculos hidrológicos, algoritmos geométricos ou contratos de API, consulte:
1. [`docs/ARCHITECTURE.md`](file:///home/diego-monteiro/apps/daee-reg-flow/docs/ARCHITECTURE.md) — Arquitetura, índices espaciais em memória, cache e segurança.
2. [`docs/METHODOLOGY.md`](file:///home/diego-monteiro/apps/daee-reg-flow/docs/METHODOLOGY.md) — Equações (1) a (22) do DAEE (1988), delimitação contribuinte pelo MDE D8 e agregação Pfafstetter `collectUpstreamBasinCodes`.
3. [`docs/API_REFERENCE.md`](file:///home/diego-monteiro/apps/daee-reg-flow/docs/API_REFERENCE.md) e [`public/openapi.json`](file:///home/diego-monteiro/apps/daee-reg-flow/public/openapi.json) — Contratos completos dos endpoints e Swagger (`/api-docs`).
4. [`docs/VIBECODING_GUIDE.md`](file:///home/diego-monteiro/apps/daee-reg-flow/docs/VIBECODING_GUIDE.md) — Mapa do código, invariantes e receitas de implementação.

5. [`docs/DEM_DELINEATION.md`](docs/DEM_DELINEATION.md) — Preparação offline do MDE, serviço `/api/dem_delineation`, codificação D8 ESRI, busca sem limite de distância / orçamento de 10 s e restrições de cobertura.

## 3. Comandos de Validação Obrigatórios
Sempre valide qualquer alteração executando:
```bash
npm run check
npm test
```

## 4. Cuidados Críticos
- **Nunca mutar feições das camadas carregadas em memória** (`ottobacias_json`, `ottotrechos_json`, `rau_json`, `rxyz_json`, `isolines_json`).
- **Coordenadas**: Turf.js usa `[lon, lat]`; Leaflet usa `[lat, lon]`.
- **Swagger / OpenAPI**: Sempre que criar ou alterar um endpoint em `routes/apis.js`, mantenha [`public/openapi.json`](file:///home/diego-monteiro/apps/daee-reg-flow/public/openapi.json) sincronizado.
- **Estilo e UI**: Respeite a identidade visual institucional **SP-ÁGUAS | REG-FLOW** (`--teal: #063f4c`, `--blue: #086fc1`) em [`public/stylesheets/style.css`](file:///home/diego-monteiro/apps/daee-reg-flow/public/stylesheets/style.css).


## 5. Serviço de Delimitação MDE
- Delimitador padrão da consulta parcial em `services/dem-delineation.js` e `scripts/hydrology/`; não usar corte geométrico como fallback silencioso.
- Rasters derivados em `data/hydrology/`, fora de `public` e do Git. Original local em `public/layers/mde/`.
- Antes de alterar o algoritmo, executar também os testes Python documentados em `docs/DEM_DELINEATION.md`. Preservar codificação ESRI D8, máscara da ottobacia e seleção da célula D8 de drenagem mais próxima e diagnóstico de alinhamento com a rede oficial.

- A camada visual do MDE é gerada por `scripts/hydrology/topography.py`: preservar alinhamento EPSG:3857, máscara/NoData transparentes e limite de 512 px; não alterar a resolução hidrológica para fins de exibição.

- Microbacias: `microbasins.py` deve particionar células sem sobreposição, separar unidades residuais e rejeitar ciclos. O limiar da rede não é área mínima de cada microbacia. Documentar os limites e as faixas vetoriais de borda sem classificação.
