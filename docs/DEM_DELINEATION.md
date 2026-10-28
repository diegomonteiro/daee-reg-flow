# Delimitação hidrológica por MDE

Branch: `feat/dem-watershed-delineation`.

A consulta principal `GET /api/coords_join/:lat/:lon`, com `partial_basin=true` (padrão), usa MDE D8 para delimitar a contribuição ao exutório ajustado. O mapa exibe o divisor resultante no lugar do corte reto; coeficientes e vazões usam o polígono contribuinte. `partial_basin=false` mantém o cálculo da ottobacia inteira. Falhas do MDE retornam erro, sem fallback geométrico.

O endpoint `GET /api/dem_delineation/:lat/:lon` expõe a delimitação local: `divide` (Feature LineString/MultiLineString ou null), `contributing_area` (Feature Polygon/MultiPolygon), `snapped_point` em `[lon,lat]`, distância efetiva, área, resolução e avisos. **Não há limite de distância do ponto à célula de drenagem.** O parâmetro antigo `snap_distance_m` na consulta é ignorado; o campo homônimo na resposta continua informando a distância realmente percorrida.

## Dados encontrados e contexto revisado

Arquivo: `public/layers/mde/MDE_ESP_v2.tif`, 1.128.336.144 bytes; 32.281 × 19.957 células; Float32, SIRGAS 2000 EPSG:4674, resolução angular 0,000277° (~30 m), NoData=0. O XML lateral informa origem em curvas de nível GISAT (IBGE/IGG/DSG), escala 1:50.000 e resolução horizontal de 30 m. Não comprova unidade vertical nem condicionamento hidrológico; registra recorte pelo limite estadual, portanto cabeceiras fora de SP podem faltar. Zero como NoData pode excluir áreas costeiras válidas: o serviço rejeita NoData dentro da máscara da ottobacia.

Foram revisados `AGENTS.md`, arquitetura, metodologia, referência de API e guia de vibecoding. Não foram encontrados arquivos adicionais em `.agents` ou `.codex`. A documentação anterior cita nomes de camadas com sufixo `_sp` e um diretório inexistente; a implementação consulta os nomes efetivamente usados em `routes/apis.js`. Alterações preexistentes do usuário em README e interface foram preservadas.

## Preparação offline

Requer GDAL (`gdalwarp`), GRASS GIS 8 (`grass`), Python e bibliotecas de `scripts/hydrology/requirements.txt`. Esses executáveis não são incluídos no Docker atual ou no ambiente serverless; provisionar um servidor com disco persistente para este serviço.

```bash
python3 -m venv .venv-hydrology
.venv-hydrology/bin/pip install -r scripts/hydrology/requirements.txt
.venv-hydrology/bin/python scripts/hydrology/prepare.py \
  public/layers/mde/MDE_ESP_v2.tif data/hydrology/state-v1
```

O diretório de saída precisa ser novo. A preparação pode levar bastante tempo e consumir dezenas de GB temporários; isso não ocorre por requisição. Rasters ficam fora de `public` e do Git. Não interromper/substituir rasters enquanto houver consultas; gerar versão nova e trocar configuração/reiniciar após conclusão. `manifest.json` só é escrito depois dos dois rasters concluídos e registra fonte, tamanho, data de modificação e método.

O script reprojeta o terreno com interpolação bilinear para SIRGAS 2000 / Brazil Polyconic EPSG:5880, grade de 30 m, e executa `r.watershed -sm` (fluxo único D8, processamento em disco e resolução de depressões/planícies pelo algoritmo A* do GRASS). Não preenche o terreno ou impõe a rede oficial indiscriminadamente. A direção GRASS é convertida explicitamente para ESRI (E=1, SE=2, S=4, SW=8, W=16, NW=32, N=64, NE=128); terminais=0, NoData=255. Acumulações negativas são preservadas e geram aviso de possível contribuição externa ao MDE.

Para teste regional, `--bounds oeste sul leste norte` recebe limites WGS84; incluir cabeceiras e margem. **Recortes arbitrários podem alterar o fluxo e subestimar a bacia**, portanto rasters regionais não substituem a preparação estadual para produção.

Configurar no `.env` com caminhos absolutos:

```dotenv
DEM_PYTHON=/caminho/do/projeto/.venv-hydrology/bin/python
DEM_D8_PATH=/caminho/do/projeto/data/hydrology/state-v1/d8.tif
DEM_ACCUMULATION_PATH=/caminho/do/projeto/data/hydrology/state-v1/accumulation.tif
DEM_MIN_DRAINAGE_AREA_KM2=0.1
```

## Consulta e algoritmo

```bash
curl 'http://localhost:3001/api/coords_join/-23.55/-46.633309'
curl 'http://localhost:3001/api/dem_delineation/-23.55/-46.633309'
```

1. Localizar a ottobacia sem mutar as camadas oficiais.
2. Ler sua janela raster com halo de uma célula para verificar entradas externas. Validar cobertura, CRS métrico, grades, NoData e codificação D8. A janela da bacia permanece limitada a 4 milhões de células.
3. Extrair células de drenagem pela acumulação global absoluta: área contribuinte mínima de `DEM_MIN_DRAINAGE_AREA_KM2` (padrão **0,1 km²**). Esse parâmetro define a rede, não um raio. Na grade de 30 m equivale a pelo menos 112 células. Bacias sem células elegíveis retornam 422, sem selecionar arbitrariamente uma célula de encosta.
4. Buscar em toda a ottobacia a célula elegível de **menor distância métrica ao ponto**, calculada vetorialmente com NumPy. A maior acumulação não pode vencer uma célula mais próxima. Empates numéricos (1e-6 m²) preferem proximidade à drenagem vetorial oficial, depois acumulação e ordem estável da grade. Não há limite de distância até a rede oficial; a distância é reportada e gera aviso se superar duas células.
5. Percorrer o grafo D8 reverso com SciPy, sem atravessar a máscara da ottobacia. Vetorizar e recortar o polígono ao limite oficial. O divisor é a fronteira compartilhada entre células contribuintes e não contribuintes; não inclui o perímetro externo oficial. Pode ser composto ou nulo. A linha passa pela borda da célula do exutório, sem promessa de coincidir com seu centro ou o clique.
6. Nos limites da ottobacia, verificar doadores D8 externos pertencentes a cada ottobacia imediatamente a montante. Retornar `contributing_upstream_codes` somente se o doador deságua numa célula selecionada. Com `include_upstream=true`, a consulta principal agrega esses ramos e seus ancestrais `COBACIAJUS` integralmente. Entradas que deságuam a jusante do exutório não são incluídas. A precisão da ligação depende da resolução e da coincidência entre limites oficiais e terreno.
7. Calcular área e coeficientes/vazões no polígono efetivamente exibido. `/api/coords_join` usa área Turf em WGS84 para manter consistência com as ponderações; o endpoint local informa área no CRS projetado. Diferenças pequenas entre essas áreas são esperadas por projeção. O cache usa coordenadas exatas e limiar da drenagem.

No frontend, `cross_section.line` agora recebe o divisor D8, inclusive MultiLineString, e `cross_section.stream_point` o exutório ajustado. `delineation` contém método, distância efetiva, limiar, entradas contribuintes e avisos, exibidos no painel. O mapa enquadra a área contribuinte para tornar visível o divisor, inclusive em bacias pequenas; em consulta integral ambos são null.

A máscara usa centros de células. Caminhos que saem e reentram na ottobacia são excluídos: trata-se de uma contribuição condicionada ao limite oficial. Não é uma bacia topográfica global completa. A agregação externa usa a topologia oficial e polígonos inteiros, não redesenha cada bacia externa pelo MDE. Resolução de 30 m e origem 1:50.000 exigem validação em planícies, áreas urbanas e confluências. As equações DAEE permanecem iguais.

## Orçamento de desempenho e erros

Uma tarefa por processo, sem fila (concorrente recebe 503); subprocesso Python assíncrono mantém o Node livre. Limite de execução: 8,5 s com encerramento forçado; margem restante do orçamento de 10 s é destinada a validação e resposta. Isso é um orçamento de processamento, não garantia universal de latência de rede ou de sucesso em toda bacia/hardware. Há limite de saída de 16 MB e rate limit já existente. Sem fallback para corte reto.

400: coordenadas inválidas; 404: ottobacia ausente; 422: dados/geometria incompatíveis ou rede de drenagem ausente; 429: rate limit; 503: dados não configurados, ocupação, dependências ausentes ou orçamento excedido. Erros são JSON `{ "error": "..." }`.

## Verificação

```bash
npm run check
npm test
.venv-hydrology/bin/python -m unittest discover -s scripts/hydrology -p 'test_*.py'
```

Os testes Python incluem GeoTIFF sintético, direção D8, restrição pela máscara, vetor da divisão, NoData e rede de drenagem ausente. Testes Node verificam contrato, orçamento, concorrência e liberação após falha. Medições regionais com o MDE real são verificações funcionais; não equivalem a homologação hidrológica estadual.

Referências: [GRASS r.watershed](https://grass.osgeo.org/grass-stable/manuals/r.watershed.html), [r.out.gdal](https://grass.osgeo.org/grass-stable/manuals/r.out.gdal.html), [Whitebox: ajuste de pontos e delimitação](https://jblindsay.github.io/wbt_book/available_tools/hydrological_analysis.html).

## Preparação e medições nesta implementação

O MDE completo foi preparado em `data/hydrology/state-v1/` e as três variáveis DEM foram configuradas no `.env` local, usando `.venv-hydrology/bin/python`. Reiniciar a aplicação para carregar essa configuração. Os rasters e o ambiente virtual são locais e não acompanham o Git.

Na versão inicial (ajuste com raio), o núcleo levou ~0,51–0,66 s em quatro pontos. Na versão atual (busca global da célula D8 mais próxima e integração ao cálculo), seis consultas HTTP locais levaram **0,75–1,35 s** sem carga concorrente. O ponto `[-46.633309,-23.55]` ajustou aproximadamente **390,9 m**, demonstrando a remoção do raio de 200 m. Teste sintético de busca reversa em 4 milhões de células: ~0,50 s, excluindo vetorização/leitura. Esses tempos não são um SLA em produção.

O teste de navegador (Chrome headless via Playwright; plugin Browser indisponível) cobriu consulta por coordenadas → resposta MDE → divisor e exutório no mapa, painel com distância/avisos, e viewport desktop/mobile. Os testes de integração MDE usam rasters locais e são omitidos quando esses dados não estão configurados; os testes sintéticos Python são independentes do MDE estadual.

Limitação observada: há desacordo entre a drenagem vetorial e o MDE em alguns pontos (inclusive Tamanduateí). A célula de drenagem topográfica mais próxima pode pertencer a um afluente ausente da camada vetorial. Distâncias e avisos são explícitos; remover o raio não corrige erros do terreno. Não foi aplicado *stream burning* sem calibração.

## Erro de variáveis DEM não configuradas

Se a API responder `Configure DEM_D8_PATH e DEM_ACCUMULATION_PATH`, reinicie o processo Node após editar o `.env`: variáveis são carregadas na inicialização. A aplicação carrega o `.env` da raiz do projeto com caminho absoluto, independentemente do diretório de execução. Variáveis já definidas no ambiente do processo têm precedência sobre o arquivo. Em Docker, alterações de `env_file` exigem recriar o contêiner, e os caminhos/dados/Python devem existir dentro dele; a imagem padrão não provisiona o runtime geoespacial.

## Camada de topografia considerada

As consultas parciais também retornam `topography`: PNG RGBA com recorte do MDE de entrada na **geometria final do cálculo**, limites Leaflet, rampa de cores, cotas mínima/máxima representadas e resolução nativa da grade. O mapa ativa a camada **Topografia considerada (MDE)**, abaixo das linhas e polígonos, com legenda e controle de opacidade. Pode ser ocultada no seletor de camadas e é removida ao iniciar nova consulta, desenhar uma bacia ou desmarcar “Ver topografia considerada”. Em `/api/coords_join`, a imagem e as curvas são geradas depois do recorte e da agregação, cobrindo a união da área local selecionada com as bacias a montante incluídas. O campo `scope` é `calculated_basin`; a consulta independente `/api/dem_delineation` mantém a visualização local (`clicked_ottobasin`).

O arquivo é `elevation.tif` ao lado de `DEM_D8_PATH`, ou o caminho opcional `DEM_ELEVATION_PATH`. Deve ser a elevação preparada de entrada do mesmo processamento D8, com CRS, dimensões e transformação correspondentes (tolerância de 1e-7 m para arredondamento de exportação GDAL/GRASS). O serviço não usa mapas topográficos externos como substituto, nem reprocessa o MDE estadual para desenhar a camada. O arquivo original não é alterado.

Lê-se apenas a janela da ottobacia, com redução para no máximo 512 amostras por lado e reprojeção bilinear para EPSG:3857. A máscara é reaplicada na grade de exibição; NoData e áreas fora da bacia são transparentes. A imagem tem seus limites retornados em WGS84 para `L.imageOverlay`, evitando deslocamentos causados por tratar a grade projetada como graus. A imagem reduzida não interfere no cálculo D8 em 30 m. As cotas da legenda são valores representados após reamostragem, não extremos garantidos da grade nativa; a unidade vertical permanece conforme a banda fonte, sem atribuir uma unidade não confirmada pelos metadados.

Se o arquivo de elevação estiver ausente, incompatível ou sem dados, o cálculo hidrológico continua e retorna `topography=null` e `topography_warning`. A interface limpa a imagem antiga e apresenta o aviso. O PNG acompanha a resposta e o cache existente, sem criar arquivos públicos por requisição. Em uma medição local do recorte da ottobacia `8669921`, o render levou ~0,14 s e gerou ~108 KB em base64 (472 × 512 px), sem teste de carga.

A validação no Chrome headless cobriu imagem carregada, legenda, mudança de opacidade, ocultar/reexibir a camada e limpeza em nova consulta, em desktop (1440 × 1000) e mobile (390 × 844), sem erros de console. A consulta HTTP com imagem levou ~1,28 s no ensaio local (um ponto, sem carga).

### Visualização independente do cálculo parcial

A opção **Ver topografia considerada**, ativada por padrão, corresponde a `include_topography=true` em `/api/coords_join`. Funciona com `partial_basin=true` e `partial_basin=false`. Ao desativar, a resposta omite a imagem (`topography=null`), evita seu processamento e usa uma chave de cache distinta. Ao reativar, a camada, legenda e opacidade voltam a funcionar.

No modo de ottobacia inteira, o subprocesso executa apenas `topography.py`: lê a elevação configurada, transforma a geometria e gera a imagem reduzida. Não lê acumulação, não ajusta o exutório, não executa o grafo D8 e não depende do limiar de drenagem. Pode funcionar apenas com `DEM_ELEVATION_PATH` configurado, mesmo sem os rasters D8/acumulação. `cross_section` e `delineation` continuam null, e geometria, área e vazões permanecem as do modo integral. Se a imagem falhar, o cálculo integral continua e a interface mostra `topography_warning`. Nesse modo, a camada é uma referência visual do relevo, não uma indicação de que a delimitação integral foi recalculada pelo MDE.

## Microbacias por confluências na área selecionada

`POST /api/microbasins` recebe `{ geometry, min_drainage_area_km2 }` e retorna um `FeatureCollection` WGS84. No painel de resultados, **Identificar microbacias** envia exatamente a geometria final da regionalização, preservando a assinatura: inclui o recorte pelo ponto e todas as ottobacias efetivamente agregadas a montante. Polígonos adjacentes são dissolvidos antes da partição; os fluxos D8 atravessam os limites internos das ottobacias. Não são agregados ramos adicionais fora do contexto selecionado. A resposta informa `metadata.scope=calculated_basin`. O corpo admite até 2 MiB, com os mesmos critérios de validação das demais consultas por geometria. O endpoint `GET /api/ottobacias/:cod/microbasins` continua disponível para consultar uma única ottobacia inteira (`scope=within_ottobasin`). O campo de área controla a extração da rede, não impõe um tamanho fixo ou mínimo às unidades resultantes. A camada pode ser ocultada no seletor do mapa e é limpa ao trocar a consulta. O recorte e as vazões da consulta anterior não são recalculados por essa visualização.

`scripts/hydrology/microbasins.py` identifica cada trecho D8 entre nascentes, confluências e saídas. A célula de confluência pertence ao trecho que começa nela, a jusante; células de encosta são associadas ao primeiro trecho alcançado pelo seu caminho de fluxo. As unidades são **incrementais e disjuntas**, não bacias contribuintes acumuladas e sobrepostas. A organização por identificadores de trechos e suas áreas segue o conceito documentado em [Whitebox Subbasins](https://jblindsay.github.io/wbt_book/available_tools/hydrological_analysis.html#subbasins); esta implementação usa o D8 preparado com GRASS e codificação ESRI já adotados no projeto.

O processamento restringe os caminhos à máscara da área selecionada (ou à ottobacia inteira no GET por código). Uma célula cujo caminho sai da máscara antes de alcançar a rede extraída pertence a uma unidade `residual_outlet`, por saída terminal, desenhada em cinza. **Essas unidades residuais não são contadas como microbacias por confluência.** Podem indicar fluxos menores que o limiar ou divergência entre terreno e limites oficiais. Também não se atribuem artificialmente a uma microbacia as pequenas faixas de borda sem centro de célula dentro da máscara: sua área é informada em `unclassified_boundary_area_km2`. Todas as células válidas são classificadas uma única vez; cobertura raster completa não significa cobertura exata de todo o polígono vetorial.

Cada Feature inclui `unit_id`, `kind` (`stream_reach`/`residual_outlet`), `downstream_unit_id` (ou null na saída), `area_km2`, `cell_count` e `outlet` em `[lon,lat]`. IDs são locais à geometria, escopo, versão dos rasters e limiar; não são ottocódigos ou cadastro oficial. Áreas são calculadas no CRS projetado; `metadata` discrimina número de microbacias/residuais, células válidas/classificadas, área representada e área de borda não classificada. Não expande automaticamente a seleção nem aplica a regionalização DAEE a cada unidade.

A leitura é por janela, até 4 milhões de células. A atribuição das encostas usa salto de ponteiros NumPy; ciclos D8 são rejeitados em vez de gerar áreas fictícias. Há limite de 5000 unidades e de 8,5 s de execução. Bacias/cenários acima desses limites exigem preparação offline; não foi introduzida fila assíncrona. Cache por hash da geometria, escopo, código, limiar, caminhos/tamanho/mtime dos rasters, com TTL de 15 minutos, até 8 resultados e 16 MB serializados no total. O header `X-Cache` distingue MISS e HIT. O rate limit existente é aplicado.

Validação na ottobacia **8669921**, limiar de **0,1 km²**: **376 microbacias por trecho**, **936 áreas residuais**, **98.269 de 98.269 células classificadas**. Área representada ~88,188 km² e borda sem classificação ~0,252 km² no CRS projetado; o total vetorial nesse CRS é ~88,440 km² (difere da área Turf usada na regionalização por distorção cartográfica). A tarefa completa no núcleo levou ~1,24 s neste ambiente, e a repetição foi atendida pelo cache. Esses números não homologam a hidrologia ou a topologia real das unidades.

### Curvas de nível da visualização

A topografia inclui contornos de **10 em 10 m**, em cinza claro tracejado, e curvas mestras em múltiplos de **50 m**, em cinza escuro tracejado e espessura maior. As cotas aparecem ao passar o ponteiro. O mesmo controle de camada **Topografia considerada (MDE)** mostra/oculta raster e contornos; a opacidade da legenda controla apenas a imagem, mantendo as linhas legíveis.

A extração usa [`gdal_contour`](https://gdal.org/en/stable/programs/gdal_contour.html) (`-i 10`, atributo `elevation_m`) no recorte métrico amostrado para exibição (até 512 células por dimensão, sem substituir os rasters dos cálculos D8). Os contornos são recortados à ottobacia, preservando vazios e NoData, e transformados para WGS84. `contour_sample_resolution_m` informa a resolução efetiva. São curvas para visualização: a equidistância de 10 m não representa precisão altimétrica de 10 m nem substitui levantamento topográfico.

O ambiente de execução deve disponibilizar **gdal_contour** (pacote `gdal-bin` no Debian/Ubuntu), além das dependências Python existentes. A extração tem timeout de 3 segundos; se falhar, a imagem continua disponível e `contours_warning` é exibido na legenda.

Os contornos exibem rótulos permanentes no formato **750 m**, orientados na direção local da curva, com halo claro. O posicionamento é recalculado ao mover/aproximar o mapa, com espaçamento de 180 pixels, prioridade para curvas mestras e supressão de colisões. Segmentos curtos podem ficar sem rótulo para preservar legibilidade; a cota continua acessível pelo tooltip. Os rótulos acompanham a visibilidade da camada topográfica.

### Topografia da rede a montante

A consulta por coordenadas primeiro calcula o recorte D8, sem renderizar a imagem intermediária, e monta a geometria final. Só então solicita uma renderização topográfica para essa geometria. Isso vale com cálculo parcial ativado ou desativado, com e sem agregação a montante. Polígonos adjacentes são normalizados e dissolvidos no processamento visual, preservando componentes desconectados e vazios e evitando falhas de interseção nas bordas compartilhadas. A resolução hidrológica, área e vazões não são modificadas por essa normalização visual. A imagem permanece limitada a 512 px, com NoData transparente.

D8 e topografia compartilham o orçamento de 8,5 s; a segunda etapa recebe apenas o tempo restante. Se a renderização exceder o orçamento, falhar ou não tiver cobertura, a resposta mantém o cálculo hidrológico e informa `topography_warning`, sem reaproveitar uma imagem da bacia anterior.

Na visualização agregada, a reprojeção dos vértices das curvas reutiliza um único transformador PyProj. O traçado visual é simplificado com tolerância de 0,1 célula da grade amostrada, **antes** do recorte exato pela área final. Isso reduz custo e tamanho de geometria sem alterar as cotas de 10/50 m, os rasters D8 ou a geometria hidrológica. No modo parcial, a etapa visual continua conferindo alinhamento da elevação com a grade D8; no integral pode funcionar somente com a elevação configurada.


A verificação de ciclos das microbacias agora examina o grafo inteiro de receptores antes da rotulagem, com duplicação vetorizada de ponteiros. Isso rejeita também ciclos alimentados por tributários, mesmo quando todas as células de canal já teriam recebido rótulos. A rede D8 válida e os limites de resolução/janela permanecem os mesmos.
