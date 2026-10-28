# Metodologia Hidrológica e Algoritmos Espaciais — REG-FLOW

Este documento detalha o embasamento teórico-metodológico implementado no **REG-FLOW**, baseado no estudo oficial do **DAEE (1988)** — *Regionalização Hidrológica no Estado de São Paulo* (publicado na revista *Águas e Energia Elétrica*, Ano 5, nº 14, pelos engenheiros Alexandre Liazi, João Gilberto Lotufo Conejo, José Carlos Francisco Palos e Paulo Sergio Cintra), bem como os algoritmos geométricos desenvolvidos para seccionamento transversal de sub-bacias e agregação por ottocodificação.

---

## 1. Fundamentos da Regionalização Hidrológica do DAEE (1988)

O estudo do DAEE analisou séries pluviométricas de 488 postos (mapa de isoietas na escala $1:1.000.000$), séries de descargas médias mensais de 219 estações fluviométricas e séries diárias de 88 postos no Estado de São Paulo, dividindo o território paulista em:
- **21 regiões hidrologicamente homogêneas (`A` a `U`)** na camada `rau.json`, que agrupam os parâmetros de regressão chuva-vazão (`A_MEDIA`, `B_MEDIA`), regressão de vazões mínimas (`A`, `B`), fatores adimensionais de período de retorno ($X_T$) e curvas de permanência ($q_p$).
- **3 regiões homogêneas (`X`, `Y`, `Z`)** na camada `rxyz.json`, que definem o fator de conversão $C = \overline{Q}_7 / \overline{Q}_M$ entre a vazão mínima de 7 dias e a média mensal de 1 mês.

### 1.1. Precipitação Média Anual Ponderada por Área — Equação (2)

Para qualquer bacia ou sub-bacia de área total $A_{\text{total}} = \sum A_i$, a precipitação média plurianual $\overline{P}$ ($\text{mm/ano}$) é obtida pela ponderação das áreas $A_i$ intersectadas por cada faixa de isoieta $P_i^*$:

$$\overline{P} = \frac{\sum (A_i \cdot P_i^*)}{\sum A_i}$$

- **Implementação**: [`getMeanRainfallByGeometry`](file:///home/diego-monteiro/apps/daee-reg-flow/models/regflow.js#L184-L202) e [`getRegionsCoeficientsByGeometry`](file:///home/diego-monteiro/apps/daee-reg-flow/models/regflow.js#L129-L182) em `models/regflow.js`.
- Caso uma bacia cruze mais de uma região hidrográfica (`RAU` ou `RXYZ`), todos os coeficientes regionais ($a, b, A, B, C, X_T$) também são calculados por média ponderada pela área de interseção de cada região com a bacia.

---

### 1.2. Vazão Média de Longo Período ($\overline{Q}$) — Equação (1)

A descarga específica média plurianual $q_{\text{esp}}$ ($\text{L}/(\text{s}\cdot\text{km}^2)$) relaciona-se linearmente com a precipitação média anual $\overline{P}$ ($\text{mm/ano}$):

$$q_{\text{esp}} = a + b \cdot \overline{P} \quad [\text{L}/(\text{s}\cdot\text{km}^2)]$$

Multiplicando-se pela área de drenagem $A_{\text{bacia}}$ ($\text{km}^2$) e convertendo de $\text{L/s}$ para $\text{m}^3/\text{s}$ ($\div 1000$), obtém-se a vazão média de longo período $\overline{Q}$:

$$\overline{Q} = \frac{(a + b \cdot \overline{P}) \cdot A_{\text{bacia}}}{1000} \quad [\text{m}^3/\text{s}]$$

Onde $a$ (`A_MEDIA`) e $b$ (`B_MEDIA`) são os parâmetros da reta de regressão regional.
- **Implementação**: [`calculateAvgFlowRateLongPeriod`](file:///home/diego-monteiro/apps/daee-reg-flow/models/regflow.js#L211-L216) em `models/regflow.js`.

---

### 1.3. Vazões Mínimas de $d$ Meses Consecutivos ($Q_{d,T}$) — Equações (3) a (12)

A variável aleatória padronizada $X = Q_d / \overline{Q}_d$ segue a distribuição de **Extremos Tipo III (Weibull)** para os períodos de retorno $T \in \{10, 15, 20, 25, 50, 100\}\text{ anos}$, gerando o fator adimensional $X_T$ tabelado por região.

A média das vazões mínimas de duração $d$ meses ($1 \le d \le 6$) adimensionalizada pela vazão média plurianual $\overline{Q}$ é expressa linearmente pelos coeficientes regionais $A$ e $B$:

$$\overline{Q}_d = (A + B \cdot d) \cdot \overline{Q} \quad \text{(Equação 11)}$$

Substituindo na relação de frequência $Q_{d,T} = X_T \cdot \overline{Q}_d$, obtém-se a **Equação (12)** para a vazão mínima de duração $d$ meses e período de retorno $T$ anos (probabilidade anual de ocorrência $1/T$):

$$Q_{d,T} = X_T \cdot (A + B \cdot d) \cdot \overline{Q} \quad [\text{m}^3/\text{s}] \quad \text{(Equação 12)}$$

- **Implementação**: [`calculateQmin`](file:///home/diego-monteiro/apps/daee-reg-flow/models/regflow.js#L244-L250) em `models/regflow.js`.

---

### 1.4. Volume de Regularização Intra-Anual ($V_c$) e Duração Crítica ($d_c$) — Equações (13), (14) e (15)

Quando uma demanda firme a ser regularizada $Q_F$ ($\text{m}^3/\text{s}$) supera a vazão mínima natural do curso d'água, mas é inferior à vazão média de longo período ($Q_F < \overline{Q}$), o déficit sazonal intra-anual para uma estiagem de duração $d$ meses e período de retorno $T$ anos (risco anual de não atendimento $y\% = \frac{100}{T}\%$) é dado pela diferença entre o volume demandado ($Q_F \cdot K \cdot d$) e o volume disponível naturalmente ($Q_{d,T} \cdot K \cdot d$):

$$V(d) = \left[ Q_F - X_T \cdot (A + B \cdot d) \cdot \overline{Q} \right] \cdot K \cdot d \quad [\text{m}^3] \quad \text{(Equação 13)}$$

Onde $K = 2.628.000\text{ s/mês}$ ($30,4167\text{ dias} \times 86.400\text{ s/dia}$).

Derivando $V(d)$ em relação a $d$ ($\frac{\partial V}{\partial d} = 0$) para encontrar o déficit máximo (ver **Figura 4** do artigo do DAEE), obtém-se:

1. **Duração Crítica da Estiagem ($d_c$, em meses) — Equação (15)**:
   $$d_c = \frac{Q_F - (X_T \cdot A \cdot \overline{Q})}{2 \cdot X_T \cdot B \cdot \overline{Q}} \quad [\text{meses}]$$

2. **Volume Necessário de Regularização Intra-Anual ($V_c$, em $\text{m}^3$) — Equação (14)**:
   $$V_c = \frac{\left[ Q_F - (X_T \cdot A \cdot \overline{Q}) \right]^2}{4 \cdot X_T \cdot B \cdot \overline{Q}} \cdot K \quad [\text{m}^3]$$
   *(Em hectômetros cúbicos: $V_c\text{ [hm}^3] = V_c\text{ [m}^3] / 10^6$).*

#### Condições de Contorno e Domínio de Validade (implementadas em [`calculateRegularizationScenario`](file:///home/diego-monteiro/apps/daee-reg-flow/models/regflow.js#L347-L433)):
- **`run_of_river` ($Q_F \le X_T \cdot A \cdot \overline{Q} \implies d_c \le 0$)**: A demanda firme $Q_F$ é atendida a fio d'água sem necessidade de reservatório de acumulação ($V_c = 0$, $d_c = 0$).
- **`valid_intra_annual` ($0 < d_c \le 6\text{ meses}$ e $Q_F < \overline{Q}$)**: Domínio estrito de validade da metodologia intra-anual do DAEE (1988).
- **`exceeds_6_months` ($d_c > 6\text{ meses}$ e $Q_F < \overline{Q}$)**: A duração crítica ultrapassa 6 meses ($Q_F > Q_{F,\text{máx}(d_c=6)} = X_T \cdot (A + 12B) \cdot \overline{Q}$), exigindo análise de regularização plurianual.
- **`exceeds_average_flow` ($Q_F \ge \overline{Q}$)**: A demanda iguala ou supera a vazão média plurianual da bacia (inviável hidrologicamente sem transposição).

#### Interpolação para Períodos de Retorno Personalizados (`resolveXTForReturnPeriod`):
- Para $T \in \{10, 15, 20, 25, 50, 100\}$, utiliza-se o valor exato tabelado de $X_T$.
- Para valores intermediários de $T$ (ou probabilidade $y\% = 100/T$), realiza-se interpolação linear no domínio transformado de Weibull $u = [-\ln(1 - 1/T)]$, preservando o comportamento assintótico da Equação (7) do DAEE.

---

### 1.5. Curva de Permanência ($Q_p$ e $Q_{95\%}$) — Equações (16) a (18)

A vazão associada a uma permanência $P\%$ (de $5\%$ a $100\%$) é obtida multiplicando-se a vazão adimensional regionalizada $q_p$ pela vazão média plurianual $\overline{Q}$:

$$Q_p = q_p \cdot \overline{Q} \quad [\text{m}^3/\text{s}]$$

Para $P = 95\%$ (índice `14` (base zero) do vetor de permanência em `models/regflow.js`):

$$Q_{95\%} = q_{95\%} \cdot \overline{Q}$$

---

### 1.6. Vazão Mínima de 7 Dias Consecutivos ($Q_{7,T}$ e $Q_{7,10}$) — Equações (19) a (22)

A vazão mínima anual de 7 dias consecutivos e período de retorno $T$ anos é obtida relacionando a vazão mínima de 1 mês ($d = 1 \implies A + B$) com o coeficiente $C = \overline{Q}_7 / \overline{Q}_M$ das regiões `X` ($0,75$), `Y` ($0,80$) e `Z` ($0,85$):

$$Q_{7,T} = C \cdot X_T \cdot (A + B) \cdot \overline{Q} \quad [\text{m}^3/\text{s}] \quad \text{(Equação 22)}$$

Para $T = 10\text{ anos}$ ($X_{10}$):

$$Q_{7,10} = C \cdot X_{10} \cdot (A + B) \cdot \overline{Q} \quad [\text{m}^3/\text{s}]$$

---

## 2. Exemplo de Referência Oficial do DAEE (Rio Buquira — Página 8 do Artigo)

| Parâmetro | Valor de Referência (DAEE, 1988) | Valor Calculado pelo REG-FLOW |
| :--- | :--- | :--- |
| **Bacia / Região** | Rio Buquira (Paraíba do Sul) — Região `H` / Região `Z` | Região `H` / Região `Z` |
| **Área de Drenagem ($A_{\text{bacia}}$)** | $401,5\text{ km}^2$ | $401,5\text{ km}^2$ |
| **Precipitação Média ($\overline{P}$)** | $1.685\text{ mm/ano}$ | $1.685\text{ mm/ano}$ |
| **Parâmetros `a`, `b`, `A`, `B`, `X10`, `C`** | $a = -29,47$; $b = 0,0315$; $A = 0,4951$; $B = 0,0279$; $X_{10} = 0,748$; $C = 0,85$ | Idênticos |
| **Vazão Média Plurianual ($\overline{Q}$)** | $23,61\text{ L}/(\text{s}\cdot\text{km}^2) \implies 9,48\text{ m}^3/\text{s}$ | $9,48\text{ m}^3/\text{s}$ |
| **Vazão Mínima Mensal ($Q_{1,10}$)** | $3,70\text{ m}^3/\text{s}$ | $3,71\text{ m}^3/\text{s}$ |
| **Vazão $Q_{95\%}$ ($q_{95} = 0,434$)** | $4,11\text{ m}^3/\text{s}$ | $4,11\text{ m}^3/\text{s}$ |
| **Vazão Mínima $Q_{7,10}$** | $3,15\text{ m}^3/\text{s}$ | $3,15\text{ m}^3/\text{s}$ |
| **Volume de Regularização ($Q_F = 5,0\text{ m}^3/\text{s}$, $T = 10\text{ anos}$)** | $V_c = 7,4 \times 10^6\text{ m}^3$ ($7,4\text{ hm}^3$) | $7,36\text{ hm}^3$ ($7.362.520\text{ m}^3$) |
| **Duração Crítica ($d_c$)** | $3,8\text{ meses}$ | $3,76\text{ meses}$ |

---

## 3. Algoritmos Geométricos e Topológicos (`routes/apis.js`)

### 3.1. Delimitação contribuinte pelo MDE D8

Com `partial_basin=true`, a consulta usa `services/dem-delineation.js` e `scripts/hydrology/delineate.py`. Células de drenagem são extraídas pela acumulação global equivalente a uma área mínima configurável (padrão 0,1 km²). Escolhe-se a célula mais próxima do ponto dentro da ottobacia inteira, sem raio máximo; empates preferem proximidade à rede oficial e maior acumulação. O grafo D8 reverso define a área contribuinte local, limitada à máscara oficial. A fronteira interna entre células contribuintes e não contribuintes substitui a antiga corda transversal. Distância à drenagem oficial é diagnóstico, sem restrição de busca.

### 3.2. Agregação das bacias contribuintes

Com `include_upstream=true`, entradas D8 de ottobacias imediatamente a montante são verificadas num halo de uma célula. Somente doadores que deságuam na área selecionada habilitam seu ramo. Cada ramo é expandido pela árvore `COBACIAJUS`, com proteção contra ciclos, e seus polígonos são agregados integralmente. Evita-se agregar tributários cuja entrada está a jusante do ponto. Essa combinação depende da resolução e da concordância da topologia oficial com o MDE.

Com `partial_basin=false`, mantém-se a ottobacia inteira e a árvore completa a montante. As equações DAEE e a ponderação por interseção permanecem iguais, aplicadas à geometria resultante. Não há fallback para o delimitador reto. Consulte [preparação, algoritmo, desempenho e limitações](DEM_DELINEATION.md).

## Precisão numérica e apresentação de bacias pequenas

As equações e as ponderações usam números JavaScript em dupla precisão e os campos numéricos da API não são truncados para duas casas decimais. A interface aplica formatação apenas ao texto apresentado. Para magnitudes entre zero e um, mantém ao menos três algarismos significativos (respeitando o mínimo de casas solicitado); se isso exigir mais de 12 casas, usa notação científica. Zero real continua zero; valores ausentes/não finitos aparecem como travessão. Mais casas na tela não significam maior precisão topográfica ou estatística da regionalização. As unidades permanecem m³/s e km².

O simulador recebe os valores completos de vazão, área e chuva da bacia, usando representação numérica que permite reconstruir o mesmo número. Demandas padrão e atalhos percentuais usam a proporção solicitada sem impor mínimo artificial de 0,01 m³/s. Limites positivos são verificados na validação do cálculo; os campos aceitam decimais pequenos. Os gráficos escalam ao máximo dos dados, sem piso fixo de 1 hm³ ou 0,01 que achate resultados pequenos. Os campos legados explicitamente denominados `_rounded` na API continuam sendo arredondamentos opcionais; para cálculo, usar os campos brutos.

## Microbacias incrementais por trecho D8

A funcionalidade de microbacias identifica links da rede extraída por acumulação mínima e separa-os nas confluências. A contribuição incremental de cada link é formada por suas células e pelas encostas cujo primeiro link alcançado é esse. Uma célula de confluência inicia o trecho a jusante. Os polígonos resultantes são disjuntos; contribuições acumuladas exigiriam percorrer `downstream_unit_id` e unir as unidades correspondentes. Saídas da ottobacia antes de alcançar a rede são residuais explicitamente separadas. A máscara por centros de células pode deixar uma faixa vetorial de borda não classificada, informada nos metadados. Detalhes, limites e validação em [DEM_DELINEATION.md](DEM_DELINEATION.md).

### Ottotrechos na bacia desenhada

`POST /api/geometry_calculate` seleciona espacialmente todos os ottotrechos oficiais que intersectam o Polygon/MultiPolygon enviado, usando pré-filtro por bounding box e `booleanIntersects` (inclui contato com a borda; respeita os vazios do polígono). Não restringe a seleção ao centróide ou aos vértices da linha, pois um trecho pode atravessar o desenho com os dois extremos externos. As linhas são devolvidas integralmente para conferência, com `NUCOMPTREC` e extremos referentes ao trecho oficial completo; não representam comprimento recortado dentro do desenho. Nenhuma feição oficial é alterada e nenhuma bacia adicional é agregada ao cálculo de vazões. O mapa desenha a drenagem sobre os preenchimentos das bacias.

No desenho, a classificação dos extremos usa a topologia oficial, sem chamadas externas de elevação por trecho; cotas indisponíveis são retornadas como `null`.

### Visualização das isoietas

A opção **Exibir isoietas no mapa**, ativada por padrão, controla as faixas históricas e as camadas dos cenários simulados, inclusive após uma nova consulta por ponto ou desenho. A mudança é local e não refaz nem altera cálculos de precipitação ou vazões. As isoietas usam um pane próprio acima dos polígonos de bacia e abaixo dos ottotrechos. As camadas de edição continuam visíveis durante a edição.

### Memorial da regionalização

O modal **Ver memorial de cálculo** detalha a delimitação, a área final, a média de precipitação ponderada pelas interseções, a ponderação dos coeficientes RAU e XYZ, a vazão média e as vazões regionais Q95/Q7,10 com os fatores reais das tabelas DAEE. `services/calculation-memorial.js` registra esses parâmetros na API; o frontend apresenta as fórmulas e substituições com até oito casas decimais (mais casas para números pequenos). As vazões regionais usam a mesma vazão média global e o mesmo C ponderado utilizados no algoritmo da consulta. Simulações pluviométricas e de regularização continuam tendo resultados próprios e não substituem o memorial da consulta base.

### Oferta natural e usos outorgados (primeira etapa do balanço)

A geometria final seleciona pontos da camada oficial `sibh:outorgas`; o recorte calculado por MDE e a agregação a montante são preservados. Uma bacia desenhada seleciona espacialmente seus pontos, sem presumir conectividade hidrológica além do polígono. São incluídos nos grupos elegíveis os status **Não Vencida** (inclusive variações sem acento/caixa) e **Dispensado**, conforme regra solicitada. A data de publicação não restringe a consulta.

O volume anual em `VOLUME_ANU` (m³/ano) é somado por grupo. Sua vazão equivalente anual é `ΣVOLUME_ANU / 31536000` (365 dias). `Vazão_ins` (m³/s) é somada à parte, sem preencher volumes ausentes ou inferir simultaneidade de operação. Captações superficiais, lançamentos superficiais, captações subterrâneas e demais interferências ficam separados; o comprometimento utiliza a demanda líquida instantânea superficial (captações menos lançamentos), sem incluir poços ou outros usos. Q média, Q95 e Q7,10 são apresentadas como referências da regionalização, recalculadas para a geometria no servidor. O equivalente anual dos usos não demonstra disponibilidade em estiagem nem é demanda medida. Dados ausentes ficam identificados e totais parcialmente conhecidos não são apresentados como completos.

O comprometimento em cada referência é `100 × (ΣQins_captação_superficial − ΣQins_lançamento_superficial) / Qnatural`, calculado com **Vazão_ins** e não com o equivalente anual. Preservar percentuais negativos e superiores a 100%, sinalizando dados parciais e impedindo divisão por vazão natural não positiva ou indisponível. Trata-se de cenário de soma das vazões outorgadas, sem garantia de simultaneidade, qualidade de retorno ou atendimento em estiagem.


## Controle de integridade e pendências de homologação

A precipitação e os coeficientes oficiais prevalecem sobre os metadados do polígono. Simulações rejeitam faixas de chuva sobrepostas e verificam cobertura pela união das áreas recortadas. O volume máximo da Equação (14), inclusive na função/rota legada, não contém multiplicador adicional pela duração. Resultados não finitos são recusados explicitamente.

A revisão identificou divergências ainda dependentes de fonte/valores homologados: XT da região P para T=50/100 anos; permanências 80/85% da região A; QP95 entre RAU e tabela de cálculo nas regiões I e U. Os valores dessas tabelas permanecem inalterados enquanto a fonte é fornecida. A duplicação da tabela XT foi removida: médias por região delegam à mesma consulta individual. Os testes de software não equivalem à homologação desses parâmetros.


Na consulta de microbacias pelo painel, a máscara de subdivisão agora é o polígono final usado na regionalização (recorte local e ottobacias contribuintes selecionadas). Os polígonos adjacentes são dissolvidos antes de formar o grafo de receptores D8: limites internos de ottobacias não interrompem artificialmente a drenagem. O algoritmo e os parâmetros hidrológicos permanecem iguais. O GET por código continua a representar apenas a ottobacia oficial inteira.

A coleta progressiva de outorgas usa uma grade espacial aproximada de 1 km² apenas para repartir consultas WFS. Não altera a delimitação, rede hidrológica, área ou as equações do balanço. A seleção final continua pelo mesmo Polygon/MultiPolygon; FIDs presentes em setores adjacentes são contados uma vez. Totais só são calculados após conferir todas as etapas assinadas.
