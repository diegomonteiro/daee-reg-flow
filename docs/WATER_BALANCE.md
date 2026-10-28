# Oferta natural e usos outorgados

Após calcular uma bacia por ponto ou desenho, **Consultar outorgas e balanço hídrico** abre um modal com os registros selecionados, volumes anuais por grupo, vazões instantâneas à parte e referências naturais (Q média, Q95 e Q7,10). O comprometimento superficial é calculado pelas vazões instantâneas, conforme regra confirmada pelo responsável; não constitui avaliação regulatória de outorga.

## Fonte e campos

- Serviço: https://geodados.daee.sp.gov.br/geoserver/ows
- Tipo de feição: `sibh:outorgas`; geometria `the_geom` (Point).
- `STATUS_POR`: elegíveis **Não Vencida** (normalizando acentuação, caixa e espaços) e **Dispensado**. Vencida e demais valores são excluídos dos totais e permanecem na memória de registros.
- `tipo_uso`: Captação Superficial, Lançamento/Lançamento Superficial, Captação Subterrânea; demais tipos são agrupados em outros usos/interferências. Se vazio, usa `TIPO_USO_E`. Tipos não reconhecidos não são adivinhados como retiradas ou lançamentos.
- `VOLUME_ANU`: m³/ano; `Vazão_ins`: m³/s. Unidades confirmadas pelo responsável pelo projeto, pois o DescribeFeatureType declara campos textuais, sem unidade física.
- Identificadores: FID WFS (`id`), `PTO`, `SOLICITAÇ`. Os registros da fonte são considerados únicos conforme confirmação do responsável; não são deduplicados por proximidade, nome ou vazão. Repetição do mesmo FID entre páginas invalida a consulta.
- Não aplicar filtro por `data_publicacao`: publicações antigas podem corresponder a atos ainda elegíveis.

## Seleção espacial

A aplicação envia a **geometria final usada na regionalização**, preservando recorte por MDE e bacias a montante agregadas. No desenho, usa exatamente o polígono enviado: é seleção espacial, não uma nova verificação de conectividade. A BBOX reduz o volume consultado no WFS; todos os pontos retornados são novamente filtrados com `booleanPointInPolygon`, incluindo limites e excluindo interiores de vazios. As coordenadas são solicitadas em CRS:84, com longitude antes de latitude.

## Contas e ausência de dados

Por grupo elegível: `volume anual conhecido = soma dos VOLUME_ANU válidos`; `vazão equivalente anual = volume anual / (365 × 24 × 60 × 60)`. Não se usa o número de dias do ano de publicação: é um ano convencional de 365 dias para comparar volumes autorizados, sem reproduzir sazonalidade.

`Vazão_ins` é apresentada como soma separada dos valores conhecidos. Não é usada para estimar volume ausente, nem interpretada como operação simultânea ou vazão medida. Os grupos subterrâneo e outros não entram nas somas de captação superficial/lançamento. As vazões naturais são recalculadas no backend para a geometria recebida; valores de vazão enviados pelo cliente não são aceitos como referência.

Campos nulos, vazios, inválidos, negativos ou não finitos são dados ausentes, não zero. Aceitam-se números JSON, decimais com ponto, decimais com vírgula e agrupamento brasileiro com milhar e vírgula decimal. Uma string com apenas ponto é interpretada como decimal (não se adivinha agrupamento de milhar). Valores científicos textuais e formatos ambíguos são recusados.

Cada grupo informa contagens de valores conhecidos/ausentes. Um grupo sem registros tem total zero. Um grupo com registros mas nenhum valor válido tem total `null`; com parte conhecida apresenta soma parcial e os respectivos contadores. `accounting_complete` exige volume anual de todas as captações/lançamentos superficiais elegíveis e nenhuma localização inválida nos candidatos da BBOX. Pendências subterrâneas e instantâneas também são explicitadas nos seus grupos, sem invalidar artificialmente o volume superficial conhecido.

O comprometimento usa **vazões instantâneas**, independentemente dos volumes anuais: `demanda líquida = ΣVazão_ins(captações superficiais) − ΣVazão_ins(lançamentos superficiais)`; `% = 100 × demanda líquida / Qnatural`. São apresentados três percentuais: Q média, Q95 e Q7,10. Captações subterrâneas e outros usos ficam separados. Valores negativos (lançamentos maiores que captações) e acima de 100% (demanda líquida maior que a referência) são preservados. Não se presume operação efetivamente simultânea, qualidade adequada dos lançamentos ou disponibilidade garantida.

`commitment` é calculado após obter as referências naturais atualizadas, sem alterar o objeto em cache. Se alguma vazão instantânea superficial estiver ausente ou houver geometria inválida, percentuais conhecidos têm status `partial`. Se nenhum valor de um grupo puder ser determinado, a demanda líquida e os percentuais são `null`. Denominadores nulos, negativos, não finitos ou resultados numericamente não representáveis geram percentual `null` e status `unavailable`, com motivo explícito. Ausência de registros em um grupo equivale a soma zero; ausência de valores em registros existentes não equivale a zero. Pendências de volume anual e de vazão subterrânea não invalidam o comprometimento instantâneo superficial. `commitment.complete` é distinto de `accounting_complete`, que continua informando a cobertura dos volumes anuais superficiais.

## Integridade e limites

WFS 2.0.0, `count=500` e `startIndex` crescente, mantendo a ordem natural fornecida pelo serviço (sem ordenação por PTO, pois há identificadores vazios na fonte). Não se considera uma página curta como fim: a soma dos registros deve alcançar a contagem declarada. Mudança de contagem, páginas repetidas, falta de FID, resposta OGC/XML de erro ou interrupção da paginação geram HTTP 502 e não devolvem totais como consulta completa. A camada não oferece aqui um snapshot transacional; contagens estáveis e FIDs únicos não garantem ausência de alterações concorrentes. Para auditoria legal é necessário um extrato versionado da fonte.

Limites: 8 s para a consulta WFS inteira, 10000 candidatos na BBOX, 4 MB por página e 3 MB de resultado. Cache por geometria exata por 5 minutos, até quatro entradas de no máximo 2 MB cada. `X-Cache` indica esse cache, não o cálculo das vazões naturais. As respostas trazem a data da coleta da fonte; falhas não entram no cache. A chamada completa também inclui o tempo de regionalização, portanto o limite WFS não é garantia universal de latência de 10 s.

Corpo HTTP limitado a 2 MB; desenho segue limite de 5000 coordenadas. A geometria oficial/final reconhecida pode usar o caminho existente de validação oficial, limitado adicionalmente a 100000 coordenadas nesta operação. A consulta está sob o rate limit existente de 30 requisições/minuto/cliente.

A interface cancela/descarta solicitações anteriores ao trocar a bacia. Pontos da consulta ficam no seletor **Outorgas na área calculada**: azul para captação superficial, verde para lançamento, roxo para subterrânea, laranja para outros tipos e cinza para status excluído. A tabela e os tooltips usam texto seguro, sem interpretar HTML vindo da fonte.

## Cards, informações dos pontos e legenda

O modal destaca as três referências naturais em cards e os quatro grupos de usos em cards separados. Cada grupo mostra volume anual conhecido, equivalente anual, soma instantânea, quantidade de registros e pendências. A memória detalhada permanece acessível em **Ver registros e memória da consulta**.

Os pontos usam os dados já retornados pelo WFS: ao passar o ponteiro, mostram tipo, status, inclusão nos totais, identificadores de ponto/WFS/solicitação, volume, vazões e coordenadas. Um clique abre as mesmas informações em popup, inclusive em dispositivos de toque. Não há GetFeatureInfo ou outra consulta por ponto, evitando latência adicional e mantendo coerência com o extrato usado no modal.

A legenda **Outorgas na área** apresenta as cinco cores e respectivas contagens, separando visualmente os registros de status excluído. A legenda acompanha a visibilidade da camada **Outorgas na área calculada** e é removida ao limpar/trocar a consulta. As cores são compartilhadas com os cards. Pontos ficam em pane próprio acima das camadas temáticas e não propagam cliques para seleção de um novo exutório.

## Carregamento progressivo (interface padrão)

A interface agora usa três operações: `POST /api/water_balance/start`, `/page` e `/complete`. O endpoint legado `/api/water_balance` permanece compatível, com seu orçamento total de 8 s. A interface não o utiliza para o carregamento por etapas.

1. **Preparação:** envia a geometria final e recalcula as referências naturais. O servidor produz uma grade regular com setores de aproximadamente 1 km² que intersectam a seleção. São setores de consulta de pontos, não microbacias hidrológicas: não dependem de Python, MDE ou do limiar D8. A área real dos setores é informada; em seleções excepcionais a grade é ampliada para limitar o retângulo a 4096 células. Vazios, componentes e recorte pelo ponto são preservados no filtro exato dos pontos.
2. **Coleta:** o navegador usa duas requisições simultâneas, cada uma consultando até oito setores com `OR` de BBOXs CRS:84. Cada página tem até 500 feições, 4 MiB e orçamento WFS independente de 8 s. Os offsets usam a quantidade efetivamente devolvida; páginas curtas não encerram a consulta. Falhas transitórias são repetidas uma vez; falhas de lote reduzem seu tamanho até um setor. A paginação de cada lote é conferida por contagem e comprovante da página anterior.
3. **Progresso:** informa setores concluídos/planejados, percentual e candidatos carregados. Não é percentual de um total de outorgas conhecido antecipadamente. A barra permanece em até 99% até a conferência final. Pontos de lotes concluídos aparecem progressivamente, com tooltip e legenda; esses pontos são uma prévia, sem totais de balanço. Pausar aborta as chamadas ativas e permite retomar os lotes pendentes. Trocar a bacia cancela e descarta todo o estado anterior. A retomada fica na memória da página, não sobrevive a recarregamento/fechamento do navegador.
4. **Conclusão:** envia a geometria, o plano e os recibos das páginas para o servidor. Assinaturas HMAC vinculam parâmetros, referências naturais, geometria, contagens e registros à consulta. O servidor exige todos os setores exatamente uma vez e todas as páginas contíguas. FIDs repetidos entre páginas do mesmo lote são erro; FIDs idênticos entre setores de borda são deduplicados. Dados divergentes para o mesmo FID exigem reinício. Somente então são apresentados os totais e percentuais de comprometimento, usando as mesmas regras de status, volume e vazão anteriores.

Os comprovantes duram **30 minutos**. Defina **GEOMETRY_SIGNING_SECRET** com o mesmo segredo em todas as réplicas/instâncias (incluindo Vercel); sem configuração, a assinatura é válida apenas no processo que a emitiu. Não há tarefa em background, sessão de servidor persistente ou dependência de afinidade entre requisições. O cache completo é uma otimização local de 5 minutos; não é necessário para a continuação. Limites: 2 MiB para preparação/página; 8 MiB para conclusão; 10000 FIDs únicos; 3 MiB no resultado. O limite específico das páginas é 180 requisições/minuto/IP (`Retry-After` em 429); preparação/conclusão mantêm 30/minuto/IP. Planos expirados, limites excedidos ou conflitos exigem reiniciar/reduzir a seleção.

O prazo total depende do número de setores, páginas e disponibilidade do WFS; não há promessa de conclusão global em 8 ou 10 segundos. A fonte continua sem snapshot transacional. A estabilidade das contagens e conferência dos FIDs reduzem inconsistências, mas não substituem um extrato oficial versionado. A consulta espacial utiliza [BBOX/expressões ECQL](https://docs.geoserver.org/3.0.x/en/user/filter/ecql_reference/) e [paginação WFS](https://docs.geoserver.org/main/en/user/services/wfs/reference/).


### Cooldown e respostas 429

Uma resposta 429 da API ou do WFS oficial suspende todas as novas requisições do carregamento. A interface mostra o percentual já concluído, registros preservados e a contagem regressiva até a retomada automática; o botão de pausa continua disponível. Requisições que já estavam em andamento podem terminar, mas nenhuma nova chamada começa durante o cooldown. O prazo é compartilhado pelos dois workers e nunca é encurtado por outra resposta.

`Retry-After` aceita segundos ou data HTTP, conforme [RFC 9110, §10.2.3](https://www.rfc-editor.org/rfc/rfc9110.html#name-retry-after). Prazos maiores que um minuto são respeitados integralmente. Sem cabeçalho válido, a espera começa em 60 segundos e aumenta em bloqueios consecutivos, até 5 minutos. Novos 429 prolongam a espera, sem consumir as tentativas de falhas 502/503 nem subdividir os setores. A API devolve o tempo restante real da janela local de 180 chamadas/minuto/IP; o 429 remoto e seu Retry-After são repassados ao navegador.

Pausar cancela as esperas e chamadas em andamento; retomar preserva as etapas concluídas e respeita o cooldown ainda ativo. Trocar a bacia descarta as etapas antigas, mantendo o controle de frequência da aba. O carregamento pode levar mais tempo devido ao limite compartilhado por IP/serviço; os comprovantes continuam sujeitos à validade de 30 minutos.
