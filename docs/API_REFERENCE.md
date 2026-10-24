# Referência Completa da API REST — REG-FLOW

A API do **REG-FLOW** está documentada segundo o padrão **OpenAPI 3.0.3** e pode ser explorada e testada interativamente pelo navegador:

- **Swagger UI Interativo**: [`GET /api-docs`](http://localhost:3001/api-docs) (ou `/api/docs`)
- **Especificação OpenAPI 3.0 (JSON)**: [`GET /api/openapi.json`](http://localhost:3001/api/openapi.json) (arquivo fonte em [`public/openapi.json`](file:///home/diego-monteiro/apps/daee-reg-flow/public/openapi.json))

---

## 1. Resumo dos Endpoints

### 1.1. Consulta Espacial e Bacias

| Método | Rota | Descrição | Rate Limit |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/coords_join/:lat/:lon` | Calcula a regionalização completa por coordenada geográfica. Suporta `?partial_basin=true\|false` e `?include_upstream=true\|false`. | 30 req/min |
| `POST` | `/api/geometry_calculate` | Calcula a regionalização e interseções de ottobacias a partir de um polígono GeoJSON desenhado (`{ geometry }`). | 30 req/min |

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

