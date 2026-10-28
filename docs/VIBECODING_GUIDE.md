# Guia de Vibecoding e Contexto para IA — REG-FLOW

Este documento foi preparado para engenheiros, desenvolvedores e agentes de Inteligência Artificial (Cursor, GitHub Copilot, Claude Code, Windsurf, Google Antigravity) para acelerar a manutenção e evolução do **REG-FLOW** com segurança, previsibilidade e aderência às regras de negócio do **SP-ÁGUAS / DAEE**.

---

## 1. Mapa Rápido do Código (Onde Editar o Quê)

| Objetivo / Funcionalidade | Arquivo Principal | Funções / Seletores Chave |
| :--- | :--- | :--- |
| **Precisão e formatação numérica** | `public/javascripts/numbers.js`, `test/numbers.test.js` | Formatação adaptativa em pt-BR; `input()` preserva o número completo em campos editáveis; não reutilizar texto arredondado em cálculos |
| **Fórmulas hidrológicas (DAEE 1988)** | [`models/regflow.js`](file:///home/diego-monteiro/apps/daee-reg-flow/models/regflow.js) | `calculateAvgFlowRateLongPeriod`, `calculateQ95`, `calculateQ7T`, `calculateQmin`, `calculateRegularizationScenario`, `resolveXTForReturnPeriod` |
| **Interseção espacial e ponderação por área** | [`models/regflow.js`](file:///home/diego-monteiro/apps/daee-reg-flow/models/regflow.js) | `getRegionsCoeficientsByGeometry`, `getMeanRainfallByGeometry`, `intersectPolygonFeatures` |
| **Delimitação da bacia no ponto** | `routes/apis.js`, `services/dem-delineation.js`, `scripts/hydrology/delineate.py` | MDE D8 na consulta parcial padrão; exutório mais próximo sem raio, entradas contribuintes e geometria exibida |
| **Divisor hidrológico por MDE** | `services/dem-delineation.js`, `scripts/hydrology/` | `/api/dem_delineation/:lat/:lon`; preparação e limites em `docs/DEM_DELINEATION.md` |
| **Recorte visual da topografia considerada** | `scripts/hydrology/topography.py`, `views/index.ejs` | `topography`, `L.imageOverlay`, legenda e controle de opacidade; grade de cálculo preservada |
| **Microbacias por confluências** | `scripts/hydrology/microbasins.py`, `services/dem-delineation.js`, `views/index.ejs` | `/api/ottobacias/:cod/microbasins`; partição incremental, resíduos explícitos, limite de unidades e cache |
| **Árvore de ottobacias à montante (Pfafstetter)** | [`routes/apis.js`](file:///home/diego-monteiro/apps/daee-reg-flow/routes/apis.js) | `upstreamBasinsByDownstream`, `collectUpstreamBasinCodes` |
| **Rotas REST da API** | [`routes/apis.js`](file:///home/diego-monteiro/apps/daee-reg-flow/routes/apis.js) | `GET /api/coords_join/:lat/:lon`, `POST /api/geometry_calculate`, `POST /api/regularization_simulation`, `POST /api/isohyet_simulation` |
| **Interface do Mapa, Painéis e Modais** | [`views/index.ejs`](file:///home/diego-monteiro/apps/daee-reg-flow/views/index.ejs) | `#search-panel`, `#results-panel`, `#toggle-results-sidebar`, `#toggle-panels-visibility`, `#regularization-dialog`, `#simulation-dialog` |
| **Estilos e Responsividade** | [`public/stylesheets/style.css`](file:///home/diego-monteiro/apps/daee-reg-flow/public/stylesheets/style.css) | `.search-panel`, `.results-panel`, `.results-edge-toggle`, `.regularization-dialog` |
| **Documentação Swagger / OpenAPI** | [`public/openapi.json`](file:///home/diego-monteiro/apps/daee-reg-flow/public/openapi.json) e [`views/api-docs.ejs`](file:///home/diego-monteiro/apps/daee-reg-flow/views/api-docs.ejs) | Rota `GET /api-docs` em [`routes/index.js`](file:///home/diego-monteiro/apps/daee-reg-flow/routes/index.js) |
| **Segurança, CSP e Limites de Body** | [`app.js`](file:///home/diego-monteiro/apps/daee-reg-flow/app.js) | Headers `Content-Security-Policy`, `standardJsonParser`, `simulationJsonParser` |

---

## 2. Regras de Ouro e Invariantes do Sistema (Crítico para IA)

1. **Imutabilidade das Camadas em Memória**:
   - Os objetos `ottobacias_json`, `ottotrechos_json`, `rau_json`, `rxyz_json` e `isolines_json` são carregados uma única vez em memória via `require()`. **Nunca modifique suas geometrias ou propriedades in-place** durante uma requisição; sempre crie clones ou novos objetos GeoJSON (`{ ...feature, properties: { ...feature.properties } }`).
2. **Ordem de Coordenadas GeoJSON vs. Leaflet**:
   - **Turf.js / GeoJSON**: sempre `[longitude, latitude]` (`[lon, lat]`).
   - **Leaflet (`L.marker`, `L.latLng`, `map.setView`)**: sempre `[latitude, longitude]` (`[lat, lon]`).
3. **Cache-Busting do CSS e Atributo `[hidden]`**:
   - Em `public/stylesheets/style.css`, classes com `display: flex`, `display: inline-flex` ou `display: grid` sobrescrevem o estilo nativo `[hidden]` do navegador se não houver regra explícita. Sempre garanta que elementos ocultáveis tenham suporte a `[hidden] { display: none !important; }`.
   - Ao alterar `public/stylesheets/style.css`, atualize o sufixo de versão em `views/index.ejs` (`<link rel="stylesheet" href="/stylesheets/style.css?v=...">`).
4. **Content Security Policy (CSP) em `app.js`**:
   - O header `Content-Security-Policy` em `app.js` restringe origens de scripts, estilos, imagens e `fetch`. Se adicionar uma nova biblioteca CDN ou serviço WMS/API externo, atualize a diretiva correspondente em `app.js` e valide em `test/api.test.js`.
5. **Verificação Obrigatória Após Qualquer Alteração**:
   - Sempre execute `npm run check && npm test` após editar qualquer arquivo. Todos os testes em `test/api.test.js` e `test/regflow.test.js` devem passar sem erros.

---

## 3. Receitas Práticas para Vibecoding (Prompts Recomendados)

### Receita A — Adicionar um novo indicador ou equação hidrológica
> **Prompt sugerido para IA**:
> *"Seguindo `docs/METHODOLOGY.md` e `models/regflow.js`, implemente a função `calculateNovaVazao(...)` em `models/regflow.js`, exponha no payload de `GET /api/coords_join/:lat/:lon` e `POST /api/geometry_calculate` em `routes/apis.js`, exiba um novo card `.metric` dentro de `#results-content` em `views/index.ejs`, documente em `public/openapi.json` e adicione testes unitários em `test/regflow.test.js` e `test/api.test.js`."*

### Receita B — Adicionar uma nova camada WMS/Tile ou GeoJSON no mapa
> **Prompt sugerido para IA**:
> *"Adicione a camada WMS/GeoJSON `<NOME>` no controle `layerControl` em `views/index.ejs`. Caso a origem seja um domínio externo novo, adicione o domínio em `img-src` / `connect-src` do header `Content-Security-Policy` em `app.js` e rode `npm test`."*

### Receita C — Evoluir o Simulador de Regularização de Vazão
> **Prompt sugerido para IA**:
> *"No modal `#regularization-dialog` em `views/index.ejs` e na rota `POST /api/regularization_simulation` em `routes/apis.js` (`calculateRegularizationScenario` em `models/regflow.js`), adicione suporte a `<NOVA_FUNCIONALIDADE>`, mantendo a compatibilidade com as Equações (12) a (15) do DAEE (1988) e atualizando os testes em `test/api.test.js`."*


- **Oferta/outorgas:** `services/water-balance.js`, `POST /api/water_balance`, modal e camada de pontos em `views/index.ejs`. Preservar consulta paginada completa, recorte pelo polígono final, separação de status/usos e ausência de dados distinta de zero. Ver `docs/WATER_BALANCE.md`.
