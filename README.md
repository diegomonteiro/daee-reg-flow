# REG-FLOW

Sistema web de regionalização de vazões para o Estado de São Paulo.

## Requisitos

- Node.js 24.x
- npm 10 ou superior

## Desenvolvimento

```bash
npm ci
npm run dev
```

A aplicação estará disponível em `http://localhost:3001`.

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
2. Selecione **Calcular vazão**.
3. Confira a bacia, a área de contribuição à montante (e sua proporção em relação à ottobacia completa), regiões, coeficientes, precipitação média, vazão média, Q95% e Q7,10 no painel.

Ao selecionar um ponto por coordenadas ou clique no mapa, o sistema localiza a ottobacia e o ottotrecho associado, projeta o ponto clicado sobre o trecho de drenagem mais próximo e traça uma linha de seção transversal até tocar as duas extremidades laterais mais próximas da bacia (utilizando a tangente macro suavizada do trecho e selecionando a menor corda transversal que intercepta o curso d'água sem cruzar para fora da bacia, evitando distorções por micro-meandros ou lóbulos côncavos). A ottobacia é seccionada por essa linha e os cálculos hidrológicos (área, precipitação média ponderada e coeficientes RAU/XYZ) são realizados espacialmente sobre o **polígono contíguo da sub-bacia de contribuição à montante** do ponto (ou 100% da ottobacia se a projeção coincidir com o extremo do trecho). No mapa são exibidos o contorno tracejado da ottobacia completa, o polígono preenchido da área de contribuição à montante, a linha de seção transversal e o ponto projetado no trecho. Com `MAPBOX_TOKEN` (ou `API_TOKEN`) configurado, a aplicação consulta a elevação do primeiro e do último ponto da linha: o extremo de maior cota é identificado como **Ponto Montante** e o de menor cota como **Ponto Jusante**. Quando a consulta de altitude não estiver disponível ou resultar em empate de cotas, o sentido montante/jusante é determinado pela topologia oficial da rede (`COBACIAJUS`).

Opcionalmente, marque **Considerar bacias à montante até a nascente (ottocodificação)** no painel de consulta para agregar toda a árvore hidrográfica à montante (via relação `COBACIA` / `COBACIAJUS` até as cabeceiras): o sistema mantém o recorte proporcional na ottobacia do ponto selecionado e soma integralmente todas as ottobacias à montante, destacando os múltiplos polígonos e trechos de drenagem no mapa e listando as ottobacias consideradas no painel de resultados.

Como fluxo adicional, selecione **Desenhar bacia**, marque os vértices com o Leaflet-Geoman e feche o polígono clicando no primeiro vértice. Nesse modo, as variáveis são calculadas diretamente a partir da geometria desenhada (até 5.000 vértices, sem autointerseções e contida no Estado de São Paulo); o fluxo por coordenadas utiliza a sub-bacia proporcional à montante do ponto dentro da ottobacia correspondente.

Ao concluir o desenho, o sistema cruza a geometria com a base oficial de ottobacias, colore no mapa cada área de interseção e apresenta uma lista ordenada. Para cada ottobacia são informados o código, a área intersectada, sua participação percentual na área desenhada e o percentual da própria ottobacia coberto pelo desenho.

Após qualquer cálculo, use **Simular outras isoietas** para comparar a camada histórica com até cinco camadas GeoJSON carregadas ou editadas pelo usuário (máximo de seis cenários por simulação). O arquivo deve conter feições `Polygon` ou `MultiPolygon` e informar a precipitação anual em milímetros (entre 1 e 10.000 mm) em uma destas propriedades: `ID`, `rain`, `precipitation`, `precipitacao`, `PRECIPITACAO`, `P` ou `mm`. As camadas precisam cobrir ao menos 95% da bacia. Cada arquivo pode ter até 25 MB, o conjunto de uploads até 50 MB (limite descompactado de 60 MB no servidor) e cada camada até 750 mil coordenadas. Navegadores compatíveis enviam a simulação compactada com gzip. Os uploads são processados em memória e não são armazenados.

A simulação mantém a geometria da bacia e os coeficientes RAU/XYZ constantes, recalculando precipitação média, vazão média, Q95% e Q7,10 para cada cenário. Os resultados são apresentados no gráfico, na tabela acessível e como sobreposições controláveis no mapa.

Na camada histórica, o botão **Editar** abre o editor cartográfico da área da bacia. É possível selecionar uma faixa, alterar sua precipitação em milímetros, ativar a edição de vértices para mudar sua forma ou informar uma variação percentual (maior que -100% e até 500%) e desenhar a região onde ela será aplicada. Ao salvar, o sistema cria um novo cenário sem modificar a camada histórica original.

## Endpoints da API

### Consulta espacial, geometria e simulação

- `GET /api/coords_join/:lat/:lon`: calcula regionalização completa para a ottobacia correspondente às coordenadas, aceitando `?include_upstream=true` para agregar recursivamente todas as ottobacias à montante até a nascente pela ottocodificação (possui cache em memória por 15 minutos, informado no cabeçalho `X-Cache: HIT|MISS`).
- `POST /api/geometry_calculate`: calcula regionalização e interseções com ottobacias oficiais a partir de uma feição GeoJSON (`Polygon` ou `MultiPolygon`) enviada em `{ geometry }`.
- `GET /api/isohyet_catalog`: lista as camadas de isoietas do catálogo (`historical-1980`).
- `GET /api/isohyet_catalog/:id`: retorna o GeoJSON de uma camada do catálogo.
- `POST /api/isohyet_editor_layer`: recorta uma camada do catálogo (`{ layerId, geometry }`) para os limites da bacia.
- `POST /api/isohyet_adjust`: aplica variação percentual (`{ layer, region, percentage }`) sobre as faixas de precipitação dentro da região informada.
- `POST /api/isohyet_simulation`: executa a simulação comparativa de 1 a 6 cenários (`{ geometry, scenarios }`).
- `GET /api/find_coefs/:lat/:lon` e `GET /api/find_coefs_by_region/:lat/:lon`: consultam os coeficientes das regiões hidrológicas (`RAU` e `RXYZ`) por coordenada.
- `GET /api/municipios`, `GET /api/municipios/:cod_ibge`, `GET /api/ottobacias/:cod`, `GET /api/ottotrechos/:cod`: consultam as feições cadastradas nas camadas base.

> As rotas de cálculo espacial e simulação possuem limite de taxa (*rate limit*) de 30 requisições por minuto por IP.

### Cálculos hidrológicos diretos

- `GET /api/calculate_discharge_avg/:coef_a/:coef_b/:avg_rainfall/:area_km2`: calcula a vazão média plurianual ($Q_{\text{média}}$) a partir dos parâmetros chuva-vazão (`A_MEDIA` e `B_MEDIA`), precipitação média (mm) e área ($\text{km}^2$).
- `GET /api/calculate_q95/:region/:qls_m3s/:area_km2`: calcula a vazão com 95% de permanência ($Q_{95\%}$) para uma região (`a`–`u`).
- `GET /api/calculate_qper/:region/:qls_m3s`: retorna a curva de permanência completa (5% a 100%) para a região.
- `GET /api/calculate_q7_10/:region/:c/:val_a/:val_b/:qls_m3s`: calcula a vazão mínima de 7 dias e 10 anos de retorno ($Q_{7,10}$).
- `GET /api/calculate_q7/:region/:c/:val_a/:val_b/:qls_m3s/:area_km2`: calcula as vazões mínimas $Q_{7,T}$ para os períodos de retorno de 10, 15, 20, 25, 50 e 100 anos.
- `GET /api/calculate_minimal_discharge/:region/:time/:a/:b/:dmonth/:qls_m3s`: calcula a vazão mínima mensal ($Q_{\min}$) para índice de período de retorno `time` (`0` a `5`) e duração `dmonth` (`1` a `12` meses).
- `GET /api/calculate_critical_duration/:qf/:xt/:a/:b/:qls_m3s` e `GET /api/calculate_critical_duration/:region/:time/:qf/:a/:b/:qls_m3s`: calculam a duração crítica (em meses).
- `GET /api/calculate_volume_regularization/:qf/:xt/:a/:b/:d/:qls_m3s/:k` e `GET /api/calculate_max_volume_regularization/:qf/:region/:t/:a/:b/:qls_m3s/:months`: calculam o volume de regularização.

Os valores são estimativas e devem ser revisados antes de uso técnico ou decisório.
