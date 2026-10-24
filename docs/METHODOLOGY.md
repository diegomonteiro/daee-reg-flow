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

Para $P = 95\%$ (índice `18` do vetor `permanence_curve_regions` em `models/regflow.js`):

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

### 3.1. Seccionamento Transversal da Sub-Bacia Contribuinte (`splitBasinUpstreamByPoint`)

Quando o usuário consulta um ponto `(lat, lon)` com o modo **Cálculo parcial da bacia (`partial_basin=true`)** ativo:

1. **Orientação do Trecho de Drenagem**:
   - Os segmentos de `ottotrecho` da ottobacia são concatenados e orientados do **Ponto Montante** (nascente local) para o **Ponto Jusante** (exutório da ottobacia) usando a cota altimétrica (`stream_endpoints`) ou a adjacência topológica com a ottobacia de jusante (`COBACIAJUS`).
2. **Projeção sobre o Rio e Tangente Macro Suavizada**:
   - O ponto clicado é projetado ortogonalmente sobre a polilinha do curso d'água (`snapPointToLineCoords`), determinando a fração longitudinal $f \in [0, 1]$ ao longo do rio.
   - Para evitar que pequenos meandros locais inclinem incorretamente a linha de corte, o algoritmo calcula um vetor tangente suavizado usando uma janela de $\pm 18\%$ do comprimento do trecho (mínimo de $350\text{ m}$) em torno do ponto projetado, combinado com o eixo global montante $\to$ jusante.
3. **Escolha da Menor Corda Transversal Contida na Bacia**:
   - São testados ângulos candidatos em torno da normal ao rio ($0^\circ, \pm 10^\circ, \pm 20^\circ, \pm 35^\circ, \pm 50^\circ$, além dos eixos cardeais).
   - Para cada ângulo, `findContainingChordSegment` intersecta a reta infinita com o contorno da ottobacia e extrai **apenas o segmento de corda contíguo que passa pelo ponto no rio**, descartando lóbulos côncavos externos.
   - É escolhida a corda que minimiza a largura transversal ponderada pelo alinhamento perpendicular ao curso d'água.
4. **Divisão Poligonal (`splitPolygonByChord`)**:
   - O anel externo da ottobacia é dividido nos dois pontos de interseção com a corda transversal (`ringA` e `ringB`), e seleciona-se o polígono que contém o trecho de montante do rio (nascente).

### 3.2. Agregação Multi-Bacias pela Ottocodificação (`collectUpstreamBasinCodes`)

Quando `include_upstream=true` é informado:
- O sistema parte do código `COBACIA` da ottobacia selecionada e busca recursivamente no índice `upstreamBasinsByDownstream` todas as ottobacias cujo atributo `COBACIAJUS` aponta para a bacia atual (e assim sucessivamente até as cabeceiras).
- A geometria resultante (`ottobacia`) torna-se um `MultiPolygon` formado pela sub-bacia contribuinte à montante do ponto (ou 100% da bacia do ponto se `partial_basin=false`) unida a 100% da área de todas as ottobacias tributárias à montante.

