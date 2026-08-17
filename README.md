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

`MAPBOX_TOKEN` habilita a consulta auxiliar de altitude. Se não estiver configurado ou o serviço estiver indisponível, o cálculo hidrológico continua normalmente sem altitude.

## Fluxo principal

1. Informe latitude e longitude em graus decimais, use a localização do dispositivo ou clique no mapa.
2. Selecione **Calcular vazão**.
3. Confira a bacia, regiões, coeficientes, precipitação média, vazão média, Q95% e Q7,10 no painel.

Ao selecionar uma ottobacia, o mapa também destaca o ottotrecho associado e apresenta o nome do curso d'água e a extensão cadastrada. Com `MAPBOX_TOKEN` configurado, a aplicação consulta a elevação do primeiro e do último ponto da linha: o extremo de maior cota é identificado como **Ponto Montante** e o de menor cota como **Ponto Jusante**. Se a consulta não estiver disponível, os extremos continuam visíveis como ponto inicial e final, sem presumir o sentido do escoamento.

Como fluxo adicional, selecione **Desenhar bacia**, marque os vértices com o Leaflet-Geoman e feche o polígono clicando no primeiro vértice. Nesse modo, as variáveis são calculadas diretamente a partir da geometria desenhada; o fluxo por coordenadas continua usando a ottobacia correspondente ao ponto.

Ao concluir o desenho, o sistema cruza a geometria com a base oficial de ottobacias, colore no mapa cada área de interseção e apresenta uma lista ordenada. Para cada ottobacia são informados o código, a área intersectada, sua participação percentual na área desenhada e o percentual da própria ottobacia coberto pelo desenho.

Após qualquer cálculo, use **Simular outras isoietas** para comparar a camada histórica com até cinco camadas GeoJSON carregadas pelo usuário. O arquivo deve conter feições `Polygon` ou `MultiPolygon` e informar a precipitação anual em milímetros em uma destas propriedades: `ID`, `rain`, `precipitation`, `precipitacao`, `P` ou `mm`. As camadas precisam cobrir ao menos 95% da bacia. Cada arquivo pode ter até 25 MB, o conjunto de uploads até 50 MB e cada camada até 750 mil coordenadas. Navegadores compatíveis enviam a simulação compactada com gzip. Os uploads são processados em memória e não são armazenados.

A simulação mantém a geometria da bacia e os coeficientes RAU/XYZ constantes, recalculando precipitação média, vazão média, Q95% e Q7,10 para cada cenário. Os resultados são apresentados no gráfico, na tabela acessível e como sobreposições controláveis no mapa.

Na camada histórica, o botão **Editar** abre o editor cartográfico da área da bacia. É possível selecionar uma faixa, alterar sua precipitação em milímetros, ativar a edição de vértices para mudar sua forma ou informar uma variação percentual e desenhar a região onde ela será aplicada. Ao salvar, o sistema cria um novo cenário sem modificar a camada histórica original.

Os valores são estimativas e devem ser revisados antes de uso técnico ou decisório.
