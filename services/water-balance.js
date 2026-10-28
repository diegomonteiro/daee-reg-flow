'use strict';
const turf = require('@turf/turf');
const { createHash } = require('node:crypto');
const ENDPOINT = 'https://geodados.daee.sp.gov.br/geoserver/ows';
const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;
const normalize = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().replace(/\s+/g, ' ').toLowerCase();
function parseQuantity(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const raw = value.trim();
  // Accept source decimal commas and pt-BR thousands; reject mixed/ambiguous garbage.
  const normalized = raw.includes(',') && /^(?:\d+|\d{1,3}(?:\.\d{3})+),\d+$/.test(raw)
    ? raw.replace(/\./g, '').replace(',', '.') : raw;
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return null;
  const number = Number(normalized);
  return Number.isFinite(number) && number >= 0 ? number : null;
}
function category(properties) {
  const type = normalize(properties.tipo_uso || properties.TIPO_USO_E);
  if (type === 'captacao superficial') return 'surface_withdrawal';
  if (type === 'captacao subterranea') return 'groundwater_withdrawal';
  if (type === 'lancamento' || type === 'lancamento superficial') return 'surface_discharge';
  return 'other';
}
function summarize(features, basin, source) {
  const groups = Object.fromEntries(['surface_withdrawal', 'surface_discharge', 'groundwater_withdrawal', 'other'].map(key => [key,
    {
      count: 0, annual_volume_m3: 0, annual_known_count: 0, annual_missing_count: 0,
      instantaneous_m3s: 0, instantaneous_known_count: 0, instantaneous_missing_count: 0
    }]));
  const statuses = {}, records = []; let outside = 0, invalidGeometry = 0;
  for (const feature of features) {
    if (feature.geometry?.type !== 'Point' || !Array.isArray(feature.geometry.coordinates) ||
      feature.geometry.coordinates.length < 2 || !feature.geometry.coordinates.slice(0, 2).every(Number.isFinite) ||
      Math.abs(feature.geometry.coordinates[0]) > 180 || Math.abs(feature.geometry.coordinates[1]) > 90) {
      invalidGeometry++; continue;
    }
    if (!turf.booleanPointInPolygon(feature, basin)) { outside++; continue; }
    const p = feature.properties || {}, status = normalize(p.STATUS_POR);
    const eligible = status === 'nao vencida' || status === 'dispensado';
    const kind = category(p), annual = parseQuantity(p.VOLUME_ANU), instantaneous = parseQuantity(p['Vazão_ins']);
    statuses[p.STATUS_POR?.trim() || 'Não informado'] = (statuses[p.STATUS_POR?.trim() || 'Não informado'] || 0) + 1;
    const record = {
      type: 'Feature', id: feature.id, geometry: { type: 'Point', coordinates: feature.geometry.coordinates.slice(0, 2) },
      properties: {
        source_id: feature.id, point_id: p.PTO || null, request_id: p['SOLICITAÇ'] || null,
        use_type: p.tipo_uso || p.TIPO_USO_E || 'Não informado', status: p.STATUS_POR || 'Não informado',
        eligible, category: kind, annual_volume_m3: annual, instantaneous_m3s: instantaneous,
        annual_equivalent_m3s: annual === null ? null : annual / SECONDS_PER_YEAR
      }
    };
    records.push(record);
    if (!eligible) continue;
    const group = groups[kind]; group.count++;
    if (annual === null) group.annual_missing_count++;
    else { group.annual_known_count++; group.annual_volume_m3 += annual; }
    if (instantaneous === null) group.instantaneous_missing_count++;
    else { group.instantaneous_known_count++; group.instantaneous_m3s += instantaneous; }
  }
  for (const group of Object.values(groups)) {
    if (!Number.isFinite(group.annual_volume_m3) || !Number.isFinite(group.instantaneous_m3s)) throw new Error('Volumes ou vazões excedem a precisão numérica suportada');
    // A group with records but no valid data must not look like zero use.
    if (group.count && !group.annual_known_count) group.annual_volume_m3 = null;
    if (group.count && !group.instantaneous_known_count) group.instantaneous_m3s = null;
    group.annual_equivalent_m3s = group.annual_volume_m3 === null ? null : group.annual_volume_m3 / SECONDS_PER_YEAR;
  }
  const primaryMissing = groups.surface_withdrawal.annual_missing_count + groups.surface_discharge.annual_missing_count;
  const warnings = [];
  if (primaryMissing) warnings.push(`${primaryMissing} interferência(s) superficial(is) elegível(is) sem volume anual válido; os totais são parciais.`);
  if (invalidGeometry) warnings.push(`${invalidGeometry} registro(s) retornado(s) pelo WFS sem localização válida; seleção espacial incompleta.`);
  if (Object.values(groups).some(g => g.instantaneous_missing_count)) warnings.push('Há registros sem vazão instantânea válida; as somas instantâneas são parciais.');
  warnings.push('Volumes anuais autorizados não representam uso medido. A vazão equivalente anual usa 365 dias; não representa simultaneidade, sazonalidade ou disponibilidade garantida em estiagem.');
  return {
    source, complete: true, accounting_complete: primaryMissing === 0 && invalidGeometry === 0,
    area_km2: turf.area(basin) / 1e6, units: { annual_volume: 'm3/year', instantaneous: 'm3/s', equivalent: 'm3/s' },
    seconds_per_year: SECONDS_PER_YEAR, included_statuses: ['Não Vencida', 'Dispensado'],
    groups, statuses, counts: {
      bbox_records: features.length, in_polygon: records.length,
      eligible: records.filter(r => r.properties.eligible).length, excluded_status: records.filter(r => !r.properties.eligible).length,
      outside_polygon: outside, invalid_geometry: invalidGeometry
    },
    warnings, outorgas: { type: 'FeatureCollection', features: records }
  };
}
function calculateCommitment(balance, reference) {
  const withdrawal = balance.groups.surface_withdrawal, discharge = balance.groups.surface_discharge;
  const withdrawals = withdrawal.instantaneous_m3s, discharges = discharge.instantaneous_m3s;
  const missing = withdrawal.instantaneous_missing_count + discharge.instantaneous_missing_count;
  const inputsComplete = balance.complete === true && missing === 0 && balance.counts.invalid_geometry === 0;
  const net = Number.isFinite(withdrawals) && Number.isFinite(discharges) ? withdrawals - discharges : null;
  const references = {};
  for (const key of ['avg_discharge', 'q95', 'q710']) {
    const natural = reference[key];
    const percent = net !== null && Number.isFinite(natural) && natural > 0 ? (net / natural) * 100 : null;
    const valid = Number.isFinite(percent);
    references[key] = {
      natural_m3s: Number.isFinite(natural) ? natural : null,
      percent: valid ? percent : null,
      status: !valid ? 'unavailable' : inputsComplete ? 'complete' : 'partial',
      reason: !Number.isFinite(natural) || natural <= 0 ? 'invalid_natural_reference' :
        net === null ? 'missing_instantaneous_flow' : !valid ? 'numeric_overflow' : inputsComplete ? null : 'incomplete_source_data'
    };
  }
  return {
    basis: 'instantaneous_surface_flow', formula: '100 * (withdrawals_m3s - discharges_m3s) / natural_m3s',
    withdrawals_m3s: withdrawals, discharges_m3s: discharges, net_withdrawal_m3s: net,
    missing_instantaneous_count: missing, inputs_complete: inputsComplete,
    complete: inputsComplete && Object.values(references).every(value => value.status === 'complete'), references
  };
}

// Shared transport: each spatial stage uses its own timeout, while the legacy
// all-at-once endpoint keeps its original overall budget.
async function fetchWfsPage({ fetchImpl = (...args) => global.fetch(...args), bounds, pageSize = 500, startIndex = 0, signal }) {
  const url = new URL(ENDPOINT);
  const params = {
    service: 'WFS', version: '2.0.0', request: 'GetFeature', typeNames: 'sibh:outorgas',
    outputFormat: 'application/json', count: String(pageSize), startIndex: String(startIndex), srsName: 'CRS:84',
    propertyName: 'the_geom,PTO,SOLICITAÇ,tipo_uso,TIPO_USO_E,STATUS_POR,Vazão_ins,VOLUME_ANU',
    CQL_FILTER: bounds.map(box => `BBOX(the_geom,${box.join(',')},'CRS:84')`).join(' OR ')
  };
  Object.entries(params).forEach(([name, value]) => url.searchParams.set(name, value));
  const response = await fetchImpl(url.toString(), { signal, headers: { Accept: 'application/json' } });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    if (response.status === 429) throw Object.assign(new Error('Limite de consultas do WFS atingido.'),
      { status: 429, retryAfter: response.headers.get('Retry-After') || '60' });
    throw new Error('WFS indisponível');
  }
  const reader = response.body.getReader(), chunks = []; let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > 4 * 1024 * 1024) throw new Error('Página WFS excessiva');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function createWaterBalanceService({ fetchImpl = (...args) => global.fetch(...args), pageSize = 500,
  maxFeatures = 10000, timeoutMs = 8000, cacheTtlMs = 5 * 60 * 1000 } = {}) {
  const cache = new Map();
  return async function query(basin) {
    const key = createHash('sha256').update(JSON.stringify(basin.geometry)).digest('hex');
    const hit = cache.get(key);
    if (hit && Date.now() - hit.createdAt < cacheTtlMs) return { value: hit.value, cache: 'HIT' };
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const bounds = turf.bbox(basin), all = [], seen = new Set(); let expected = null, fetchedAt = new Date().toISOString();
      for (let page = 0; ; page++) {
        const data = await fetchWfsPage({ fetchImpl, bounds: [bounds], pageSize, startIndex: all.length, signal: controller.signal });
        if (data.numberReturned !== undefined && data.numberReturned !== data.features?.length) throw new Error('Quantidade retornada inconsistente');
        if (data.type !== 'FeatureCollection' || !Array.isArray(data.features)) throw new Error('Resposta WFS inválida');
        const matched = typeof data.numberMatched === 'number' ? data.numberMatched :
          typeof data.totalFeatures === 'number' ? data.totalFeatures : NaN;
        if (!Number.isSafeInteger(matched) || matched < 0) throw new Error('WFS sem contagem verificável');
        if (expected === null) expected = matched;
        if (matched !== expected) throw new Error('A camada mudou durante a paginação');
        if (expected > maxFeatures) throw new Error('Área excede o limite de outorgas da consulta');
        if (data.features.length > pageSize || (expected > all.length && !data.features.length)) throw new Error('WFS retornou página incompleta');
        for (const feature of data.features) {
          if (typeof feature.id !== 'string' || seen.has(feature.id)) throw new Error('WFS repetiu registros ou omitiu identificadores');
          seen.add(feature.id); all.push(feature);
        }
        if (all.length > expected) throw new Error('Contagem WFS inconsistente');
        if (all.length === expected) break;
        if (page >= Math.ceil(maxFeatures / pageSize)) throw new Error('Paginação WFS excedida');
      }
      const value = summarize(all, basin, {
        url: ENDPOINT, layer: 'sibh:outorgas', fetched_at: fetchedAt,
        matched_bbox: expected, wfs_version: '2.0.0', status_filter: 'Não Vencida + Dispensado; sem filtro de data de publicação'
      });
      if (Buffer.byteLength(JSON.stringify(value)) > 3 * 1024 * 1024) throw new Error('Resultado excede 3 MB; reduza a área da consulta');
      // Keep bounded, short-lived process-local cache; never cache failures.
      if (Buffer.byteLength(JSON.stringify(value)) <= 2 * 1024 * 1024) {
        cache.set(key, { createdAt: Date.now(), value });
        while (cache.size > 4) cache.delete(cache.keys().next().value);
      }
      return { value, cache: 'MISS' };
    } catch (error) {
      const failure = new Error(controller.signal.aborted ? 'Tempo de consulta às outorgas excedido. Tente novamente.' :
        `Não foi possível obter todas as outorgas: ${error.message}. Nenhum balanço completo foi produzido.`);
      failure.status = 502; throw failure;
    } finally { clearTimeout(timeout); }
  };
}
module.exports = { createWaterBalanceService, summarize, parseQuantity, calculateCommitment, SECONDS_PER_YEAR, fetchWfsPage, ENDPOINT };
