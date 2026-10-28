'use strict';
const turf = require('@turf/turf');
const { createHash, createHmac, randomBytes, timingSafeEqual } = require('node:crypto');
const { fetchWfsPage, summarize, calculateCommitment, ENDPOINT } = require('./water-balance');
const { JsonCache } = require('./json-cache');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const fields = ['PTO', 'SOLICITAÇ', 'tipo_uso', 'TIPO_USO_E', 'STATUS_POR', 'Vazão_ins', 'VOLUME_ANU'];

function cellBounds(grid, index) {
  const [west, south, east, north] = grid.bounds, x = index % grid.columns, y = Math.floor(index / grid.columns);
  const dx = (east - west) / grid.columns, dy = (north - south) / grid.rows;
  return [west + x * dx, south + y * dy, x + 1 === grid.columns ? east : west + (x + 1) * dx,
    y + 1 === grid.rows ? north : south + (y + 1) * dy];
}
function spatialGrid(basin) {
  const bounds = turf.bbox(basin), latitude = (bounds[1] + bounds[3]) / 2;
  const width = (bounds[2] - bounds[0]) * 111.195 * Math.cos(latitude * Math.PI / 180);
  const height = (bounds[3] - bounds[1]) * 111.195;
  // Approximately 1 km² cells; coarsen exceptionally large selections to bound work.
  let side = Math.max(1, Math.sqrt(width * height / 3500));
  let columns = Math.max(1, Math.ceil(width / side)), rows = Math.max(1, Math.ceil(height / side));
  while (columns * rows > 4096) { side *= 1.05; columns = Math.max(1, Math.ceil(width / side)); rows = Math.max(1, Math.ceil(height / side)); }
  const grid = { bounds, columns, rows }, cells = [];
  for (let index = 0; index < rows * columns; index++) {
    if (turf.booleanIntersects(basin, turf.bboxPolygon(cellBounds(grid, index)))) cells.push(index);
  }
  if (!cells.length) throw failure('Nenhum setor espacial encontrado na bacia.', 422);
  return { grid, cells, cell_area_km2: width * height / (rows * columns) };
}
function createWaterBalanceLoading({ secret = process.env.GEOMETRY_SIGNING_SECRET || randomBytes(32),
  fetchImpl = (...args) => global.fetch(...args), now = Date.now, timeoutMs = 8000, pageSize = 500, maxFeatures = 10000 } = {}) {
  const cache = new JsonCache({ maxBytes: 8 * 1024 * 1024, maxEntryBytes: 2 * 1024 * 1024, maxEntries: 4, ttlMs: 5 * 60 * 1000, now });
  const sign = data => ({ data, signature: createHmac('sha256', secret).update(JSON.stringify(data)).digest('hex') });
  function verify(envelope, kind) {
    if (!envelope?.data || typeof envelope.signature !== 'string' || !/^[a-f0-9]{64}$/.test(envelope.signature)) throw failure('Comprovante de carregamento inválido.');
    const expected = sign(envelope.data).signature;
    if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(envelope.signature, 'hex')) || envelope.data.kind !== kind) throw failure('Comprovante de carregamento inválido.');
    if (envelope.data.expires_at <= now()) throw failure('Consulta expirada. Inicie um novo carregamento.', 410);
    return envelope.data;
  }
  return {
    start(basin, reference, selection) {
      const geometryHash = hash(basin.geometry), cached = cache.get(geometryHash);
      if (cached) return { result: { ...cached, reference, selection, commitment: calculateCommitment(cached, reference) }, cache: 'HIT' };
      const spatial = spatialGrid(basin);
      return { plan: sign({ kind: 'plan', id: randomBytes(16).toString('hex'), geometry_hash: geometryHash,
        ...spatial, reference, selection, started_at: new Date(now()).toISOString(), expires_at: now() + 30 * 60 * 1000 }), cache: 'MISS' };
    },
    async page(input, signal) {
      const plan = verify(input.plan, 'plan'), cells = input.cells, start = input.start_index ?? 0;
      if (!input.geometry) throw failure('Geometria do carregamento ausente.');
      const geometry = input.geometry.type === 'Feature' ? input.geometry : turf.feature(input.geometry);
      if (hash(geometry.geometry) !== plan.geometry_hash) throw failure('A geometria não corresponde ao carregamento.');
      if (!Array.isArray(cells) || !cells.length || cells.length > 8 || new Set(cells).size !== cells.length || cells.some(cell => !Number.isSafeInteger(cell) || !plan.cells.includes(cell)) ||
          !Number.isSafeInteger(start) || start < 0 || start > maxFeatures) throw failure('Etapa espacial inválida.');
      let previous;
      if (start > 0) {
        previous = verify(input.previous, 'page');
        if (previous.plan_id !== plan.id || previous.cells.join(',') !== [...cells].sort((a,b) => a-b).join(',') ||
            previous.next_index !== start || previous.complete) throw failure('Sequência de páginas inválida.');
      }
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
      const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) controller.abort();
      try {
        const data = await fetchWfsPage({ fetchImpl, bounds: cells.map(cell => cellBounds(plan.grid, cell)), pageSize, startIndex: start, signal: controller.signal });
        const expected = typeof data.numberMatched === 'number' ? data.numberMatched : data.totalFeatures;
        if (data.type !== 'FeatureCollection' || !Array.isArray(data.features) || !Number.isSafeInteger(expected) || expected < 0 || expected > maxFeatures ||
            data.features.length > pageSize || (data.numberReturned !== undefined && data.numberReturned !== data.features.length) ||
            start + data.features.length > expected || (start < expected && !data.features.length)) throw new Error('Contagem ou página WFS inválida');
        if (previous && previous.expected !== expected) throw new Error('A camada mudou durante a paginação');
        const seen = new Set();
        const features = data.features.map(feature => {
          if (typeof feature.id !== 'string' || seen.has(feature.id)) throw new Error('Identificadores WFS ausentes ou repetidos');
          seen.add(feature.id);
          const properties = Object.fromEntries(fields.map(field => [field, ['string', 'number'].includes(typeof feature.properties?.[field]) ? feature.properties[field] : null]));
          return { type: 'Feature', id: feature.id, geometry: feature.geometry, properties };
        });
        const next = start + features.length;
        return { preview: summarize(features, geometry, {}).outorgas.features, receipt: sign({ kind: 'page', plan_id: plan.id, expires_at: plan.expires_at,
          cells: [...cells].sort((a,b) => a-b), start_index: start, expected, next_index: next,
          complete: next === expected, features }) };
      } catch (error) {
        if (signal?.aborted) throw failure('Consulta cancelada.', 499);
        if (error.status === 429) throw error;
        throw failure(controller.signal.aborted ? 'Tempo da etapa excedido; reduza o lote ou tente novamente.' : `Falha na etapa de outorgas: ${error.message}`, 502);
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    },
    complete(basin, input) {
      const plan = verify(input.plan, 'plan');
      if (hash(basin.geometry) !== plan.geometry_hash) throw failure('A geometria não corresponde ao carregamento.');
      if (!Array.isArray(input.receipts) || input.receipts.length > 20000) throw failure('Comprovantes das etapas inválidos.');
      const groups = new Map(), features = new Map(), covered = new Set(); let duplicates = 0;
      for (const envelope of input.receipts) {
        const page = verify(envelope, 'page');
        if (page.plan_id !== plan.id) throw failure('Etapa de outra consulta.');
        const key = page.cells.join(',');
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(page);
      }
      for (const pages of groups.values()) {
        pages.sort((a,b) => a.start_index-b.start_index); let offset = 0;
        const expected = pages[0].expected, local = new Set(), offsets = new Set();
        for (const page of pages) {
          if (offsets.has(page.start_index) || page.start_index !== offset || page.expected !== expected) throw failure('Paginação incompleta, repetida ou alterada.', 422);
          offsets.add(page.start_index);
          for (const feature of page.features) {
            if (local.has(feature.id)) throw failure('WFS repetiu registros entre páginas; reinicie a consulta.', 409);
            local.add(feature.id);
            if (features.has(feature.id)) {
              if (hash(features.get(feature.id)) !== hash(feature)) throw failure('A fonte mudou entre setores; reinicie a consulta.', 409);
              duplicates++;
            } else features.set(feature.id, feature);
            if (features.size > maxFeatures) throw failure('Área excede 10000 outorgas; reduza a seleção.', 422);
          }
          offset = page.next_index;
        }
        if (offset !== expected || !pages.at(-1).complete) throw failure('Ainda há páginas de outorgas pendentes.', 422);
        for (const cell of pages[0].cells) {
          if (covered.has(cell)) throw failure('Setor espacial repetido.', 422);
          covered.add(cell);
        }
      }
      if (covered.size !== plan.cells.length || plan.cells.some(cell => !covered.has(cell))) throw failure('Ainda há setores de outorgas pendentes.', 422);
      const value = summarize([...features.values()], basin, { url: ENDPOINT, layer: 'sibh:outorgas', fetched_at: plan.started_at,
        completed_at: new Date(now()).toISOString(), matched_bbox: features.size, wfs_version: '2.0.0',
        loading_method: 'spatial_batches', cells: covered.size, cell_area_km2: plan.cell_area_km2,
        duplicate_boundary_records: duplicates, status_filter: 'Não Vencida + Dispensado; sem filtro de data de publicação' });
      if (Buffer.byteLength(JSON.stringify(value)) > 3 * 1024 * 1024) throw failure('Resultado excede 3 MB; reduza a área.', 422);
      cache.set(plan.geometry_hash, value);
      return { ...value, reference: plan.reference, selection: plan.selection, commitment: calculateCommitment(value, plan.reference) };
    }
  };
}
module.exports = { createWaterBalanceLoading, spatialGrid, cellBounds };
