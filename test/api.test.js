'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const fs = require('node:fs');
const app = require('../app');
const regflow = require('../models/regflow');
const historicalIsohyets = require('../public/layers/rain_isoline.json');
const Ajv = require('ajv');
const ajv = new Ajv({ strict: false, allErrors: true });
require('ajv-formats')(ajv);
const schemas = require('../public/openapi.json').components.schemas;
const validators = new Map();
function assertContract(name, payload) {
  if (!validators.has(name)) validators.set(name, ajv.compile({ components: { schemas }, $ref: `#/components/schemas/${name}` }));
  const validate = validators.get(name);
  assert.ok(validate(payload), JSON.stringify(validate.errors));
}


let server;
let baseUrl;
const nativeFetch = global.fetch;
let testClient = 0;
let testClientIp;
// Isolate per-client quotas between tests without disabling production rate limits.
async function fetch(url, options = {}) {
  const headers = new Headers(options.headers);
  headers.set('x-forwarded-for', testClientIp);
  return nativeFetch(url, { ...options, headers });
}
test.beforeEach(() => { testClientIp = `192.0.2.${++testClient}`; });

test.before(async () => {
  app.set('trust proxy', 'loopback');
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
});

test('serves the main map interface with security headers', async () => {
  const response = await fetch(baseUrl);
  const html = await response.text();
  assert.equal(response.status, 200);
  const contentSecurityPolicy = response.headers.get('content-security-policy');
  assert.match(contentSecurityPolicy, /default-src 'self'/);
  assert.match(contentSecurityPolicy, /connect-src[^;]*https:\/\/unpkg\.com/);
  assert.match(html, /REG-FLOW/);
  assert.match(contentSecurityPolicy, /img-src[^;]*https:\/\/geodados\.daee\.sp\.gov\.br/);
  assert.match(html, /Hidrografia completa \(DAEE\)/);
  assert.match(html, /sibh:hidrografia_completa/);
  assert.match(html, /SP-%C3%81guas-Branco\.png/);
  assert.match(html, /SP-ÁGUAS — REG-FLOW/);
  assert.match(html, /function startNewConsultation\(\)/);
  assert.match(html, /id="start-drawing"/);
  assert.match(html, /Desenhar bacia/);
  assert.match(html, /Minha localização/);
  assert.match(html, /Calcular vazão/);
  assert.match(html, /id="toggle-results-sidebar"/);
  assert.match(html, /id="restore-search-panel"/);
  assert.match(html, /id="toggle-panels-visibility"/);
  assert.match(html, /id="partial-basin"/);
});

test('rejects invalid coordinates with JSON and status 400', async () => {
  const response = await fetch(`${baseUrl}/api/coords_join/not-a-number/-46`);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'Invalid parameter: lat' });
});

test('returns a finite average-discharge calculation', async () => {
  const response = await fetch(`${baseUrl}/api/calculate_discharge_avg/-20/0.03/1500/100`);
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.avg, 2.5);
});

const hasDemData = Boolean(process.env.DEM_D8_PATH && process.env.DEM_ACCUMULATION_PATH &&
  fs.existsSync(process.env.DEM_D8_PATH) && fs.existsSync(process.env.DEM_ACCUMULATION_PATH));

test('calculates coordinates using the nearest D8 drainage without a distance ceiling', { skip: !hasDemData }, async () => {
  const response = await fetch(`${baseUrl}/api/coords_join/-23.55/-46.633309`);
  const data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  assert.equal(response.headers.get('x-cache'), 'MISS');
  assert.equal(data.delineation.method, 'dem_d8_esri');
  const elevationPath = process.env.DEM_ELEVATION_PATH || require('node:path').join(require('node:path').dirname(process.env.DEM_D8_PATH), 'elevation.tif');
  if (fs.existsSync(elevationPath)) {
    assert.ok(data.topography, data.topography_warning);
    assert.equal(data.topography.scope, 'calculated_basin');
    assert.equal(data.topography.display_crs, 'EPSG:3857');
    assert.ok(data.topography.width <= 512 && data.topography.height <= 512);
    assert.equal(Buffer.from(data.topography.image.split(',')[1], 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  }
  assert.equal(data.delineation.snap_method, 'nearest_d8_drainage_cell');
  assert.ok(data.delineation.snap_distance_m > 200);
  assert.ok(data.area_km2 > 0 && data.area_km2 <= data.full_area_km2);
  assert.ok(['LineString', 'MultiLineString'].includes(data.cross_section.line.geometry.type));
  assert.equal(data.cross_section.stream_point.length, 2);
  assert.equal(data.ottobacia.properties.COBACIA, '8669921');
  assert.ok([data.isolines.avg_areas, data.avg_discharge, data.q95, data.q710].every(Number.isFinite));
  assert.equal(data.avg_discharge, regflow.calculateAvgFlowRateLongPeriod(data.rau.avg_a, data.rau.avg_b, data.isolines.avg_areas, data.area_km2));
  const rauArea = data.rau.bands.reduce((sum, band) => sum + band.properties.partial_area, 0);
  assert.ok(Math.abs(rauArea - data.area_km2) / data.area_km2 < 0.02);

  const direct = await fetch(`${baseUrl}/api/dem_delineation/-23.55/-46.633309?snap_distance_m=1`);
  const directData = await direct.json();
  assert.equal(direct.status, 200);
  assert.deepEqual(directData.snapped_point, data.delineation.snapped_point);
  assert.deepEqual(directData.contributing_area.geometry, data.ottobacia.geometry);
  assert.deepEqual(directData.divide, data.cross_section.line);

  const upstream = await fetch(`${baseUrl}/api/coords_join/-23.55/-46.633309?include_upstream=true`);
  const upstreamData = await upstream.json();
  assert.equal(upstream.status, 200, JSON.stringify(upstreamData));
  // This outlet has no D8-connected external feeder: do not add downstream tributaries.
  assert.deepEqual(upstreamData.delineation.contributing_upstream_codes, []);
  assert.equal(upstreamData.upstream_basins.length, 1);
  assert.equal(upstreamData.area_km2, data.area_km2);

  const localFeeder = await fetch(`${baseUrl}/api/coords_join/-23.951116/-47.312622`);
  const localFeederData = await localFeeder.json();
  assert.equal(localFeeder.status, 200, JSON.stringify(localFeederData));
  const connected = await fetch(`${baseUrl}/api/coords_join/-23.951116/-47.312622?include_upstream=true`);
  const connectedData = await connected.json();
  assert.equal(connected.status, 200, JSON.stringify(connectedData));
  assert.ok(connectedData.delineation.contributing_upstream_codes.length > 0);
  for (const code of connectedData.delineation.contributing_upstream_codes) {
    assert.ok(connectedData.upstream_basins.some(basin => basin.COBACIA === code));
  }
  assert.ok(connectedData.area_km2 > localFeederData.area_km2);
  assert.ok(Number.isFinite(connectedData.avg_discharge));
  if (fs.existsSync(elevationPath)) {
    const bounds = require('@turf/turf').bbox(connectedData.ottobacia);
    assert.ok(connectedData.topography, connectedData.topography_warning);
    assert.equal(connectedData.topography.scope,'calculated_basin');
    const image = connectedData.topography.bounds;
    assert.ok(image[0][0] <= bounds[1]+0.00001 && image[0][1] <= bounds[0]+0.00001);
    assert.ok(image[1][0] >= bounds[3]-0.00001 && image[1][1] >= bounds[2]-0.00001);
  }
  const wholeUpstreamResponse = await fetch(`${baseUrl}/api/coords_join/-23.55/-46.633309?partial_basin=false&include_upstream=true`);
  const wholeUpstream = await wholeUpstreamResponse.json();
  assert.equal(wholeUpstreamResponse.status,200,JSON.stringify(wholeUpstream));
  assert.ok(wholeUpstream.upstream_basins.length > 1);
  if (fs.existsSync(elevationPath)) {
    const bounds = require('@turf/turf').bbox(wholeUpstream.ottobacia);
    assert.ok(wholeUpstream.topography,wholeUpstream.topography_warning);
    assert.equal(wholeUpstream.topography.scope,'calculated_basin');
    assert.ok(wholeUpstream.topography.bounds[0][0] <= bounds[1]+0.00001);
    assert.ok(wholeUpstream.topography.bounds[1][0] >= bounds[3]-0.00001);
  }


  const taquari = await fetch(`${baseUrl}/api/coords_join/-24.037685/-48.886414`);
  const partial = await taquari.json();
  assert.equal(taquari.status, 200, JSON.stringify(partial));
  const whole = await fetch(`${baseUrl}/api/coords_join/-24.037685/-48.886414?partial_basin=false`);
  const full = await whole.json();
  assert.equal(whole.status, 200);
  assert.equal(full.cross_section, null);
  assert.equal(full.delineation, null);
  assert.equal(full.include_topography, true);
  if (fs.existsSync(elevationPath)) assert.ok(full.topography, full.topography_warning);
  const withoutTopography = await fetch(`${baseUrl}/api/coords_join/-24.037685/-48.886414?partial_basin=false&include_topography=false`);
  const withoutTopographyData = await withoutTopography.json();
  assert.equal(withoutTopography.status, 200);
  assert.equal(withoutTopographyData.include_topography, false);
  assert.equal(withoutTopographyData.topography, null);
  assert.equal(withoutTopographyData.topography_warning, null);
  assert.deepEqual(withoutTopographyData.ottobacia, full.ottobacia);
  assert.equal(withoutTopographyData.area_km2, full.area_km2);
  assert.equal(withoutTopographyData.avg_discharge, full.avg_discharge);

  assert.equal(full.area_proportion, 1);
  assert.ok(full.area_km2 >= partial.area_km2);
});

test('classifies the highest stream endpoint as upstream and the lowest as downstream', async () => {
  const originalElevation = regflow.getElevationByCoords;
  regflow.getElevationByCoords = async (lat, lon) => ({ min: Math.round(-lat * 100) - 10, max: Math.round(-lat * 100) });
  try {
    const response = await fetch(`${baseUrl}/api/coords_join/-23.551/-46.632?partial_basin=false`);
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    const endpoints = data.ottotrecho[0].properties.stream_endpoints;
    assert.ok(endpoints.upstream.elevation_m >= endpoints.downstream.elevation_m);
    assert.equal(endpoints.elevation_source, 'mapbox-terrain-v2');
  } finally {
    regflow.getElevationByCoords = originalElevation;
  }
});

test('calculates regionalization from the exact user-drawn polygon', async () => {
  const geometry = {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'Polygon',
      coordinates: [[[-46.70, -23.62], [-46.58, -23.62], [-46.58, -23.52], [-46.70, -23.52], [-46.70, -23.62]]]
    }
  };
  const response = await fetch(`${baseUrl}/api/geometry_calculate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ geometry })
  });
  const data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  assert.equal(data.source, 'drawn-geometry');
  const memorial = data.calculation_memorial;
  assert.equal(memorial.area_km2, data.area_km2);
  assert.equal(memorial.results.avg_discharge, data.avg_discharge);
  assert.equal(memorial.results.q95, data.q95);
  assert.equal(memorial.results.q710, data.q710);
  const weighted = (rows, key) => rows.reduce((sum,p)=>sum+p[key]*p.area_km2,0) / rows.reduce((sum,p)=>sum+p.area_km2,0);
  const close = (a,b) => assert.ok(Math.abs(a-b) < 1e-10, `${a} != ${b}`);
  close(weighted(memorial.rainfall_bands, 'rainfall_mm'), data.isolines.avg_areas);
  close(weighted(memorial.regions, 'q95'), data.q95);
  close(weighted(memorial.regions, 'q710'), data.q710);
  close((memorial.coefficients.avg_a + memorial.coefficients.avg_b*memorial.rainfall_mm)*memorial.area_km2/1000, data.avg_discharge);

  assert.deepEqual(data.ottobacia.geometry.coordinates, geometry.geometry.coordinates);
  assert.ok(data.area_km2 > 0);
  assert.ok(data.intersecting_basins.length > 0);
  const turf = require('@turf/turf');
  const officialStreams = require('../public/layers/ottotrechos.json').features;
  const originals = JSON.stringify(officialStreams);
  const expectedStreams = officialStreams.filter(stream => turf.booleanIntersects(geometry, stream));
  assert.ok(expectedStreams.length > 0);
  assert.equal(data.ottotrecho.length, expectedStreams.length);
  assert.deepEqual(data.ottotrecho.map(stream => stream.geometry), expectedStreams.map(stream => stream.geometry));
  assert.ok(data.ottotrecho.every(stream => stream.properties.stream_endpoints?.upstream && stream.properties.stream_endpoints?.downstream));
  assert.equal(JSON.stringify(officialStreams), originals, 'Must not mutate the official stream layer');

  assert.ok(data.intersecting_basins.every(feature => {
    const properties = feature.properties;
    return properties.COBACIA && properties.overlap_area_km2 > 0 && properties.drawn_area_percent > 0 && properties.drawn_area_percent <= 100 && properties.basin_area_percent > 0 && properties.basin_area_percent <= 100;
  }));
  const coveredPercentage = data.intersecting_basins.reduce((sum, feature) => sum + feature.properties.drawn_area_percent, 0);
  assert.ok(coveredPercentage > 99 && coveredPercentage <= 100.01, `Cobertura das ottobacias: ${coveredPercentage}%`);
  assert.ok([data.isolines.avg_areas, data.avg_discharge, data.q95, data.q710].every(Number.isFinite));
});

test('rejects invalid, self-intersecting and out-of-state basin geometries', async () => {
  const cases = [
    {
      geometry: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[-46.7, -23.6], [-46.6, -23.5]] } },
      status: 400,
      error: /Polygon or MultiPolygon/
    },
    {
      geometry: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[-46.70,-23.62],[-46.58,-23.52],[-46.70,-23.52],[-46.58,-23.62],[-46.64,-23.66],[-46.70,-23.62]]] } },
      status: 422,
      error: /self-intersections/
    },
    {
      geometry: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[-43.3,-23.1],[-43.2,-23.1],[-43.2,-23],[-43.3,-23],[-43.3,-23.1]]] } },
      status: 400,
      error: /State of São Paulo/
    }
  ];
  for (const item of cases) {
    const response = await fetch(`${baseUrl}/api/geometry_calculate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ geometry: item.geometry }) });
    const data = await response.json();
    assert.equal(response.status, item.status, JSON.stringify(data));
    assert.match(data.error, item.error);
  }
});

test('validates uploaded isohyet properties, coverage and scenario limits', async () => {
  const geometry = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[-46.70,-23.62],[-46.58,-23.62],[-46.58,-23.52],[-46.70,-23.52],[-46.70,-23.62]]] } };
  const invalidLayer = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name: 'sem precipitação' }, geometry: geometry.geometry }] };
  let response = await fetch(`${baseUrl}/api/isohyet_simulation`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ geometry, scenarios: [{ id: 'invalid', name: 'Inválida', layer: invalidLayer }] }) });
  let data = await response.json();
  assert.equal(response.status, 422, JSON.stringify(data));
  assert.match(data.error, /positive rainfall value/);

  const partialLayer = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { ID: 1500 }, geometry: { type: 'Polygon', coordinates: [[[-46.70,-23.62],[-46.69,-23.62],[-46.69,-23.61],[-46.70,-23.61],[-46.70,-23.62]]] } }] };
  response = await fetch(`${baseUrl}/api/isohyet_simulation`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ geometry, scenarios: [{ id: 'partial', name: 'Parcial', layer: partialLayer }] }) });
  data = await response.json();
  assert.equal(response.status, 422, JSON.stringify(data));
  assert.match(data.error, /less than 95%/);

  const scenarios = Array.from({ length: 7 }, (_, index) => ({ id: 'historical-1980', name: `Cenário ${index + 1}` }));
  response = await fetch(`${baseUrl}/api/isohyet_simulation`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ geometry, scenarios }) });
  data = await response.json();
  assert.equal(response.status, 400, JSON.stringify(data));
  assert.match(data.error, /between 1 and 6/);
});

test('returns 404 for an unknown catalog isohyet', async () => {
  const response = await fetch(`${baseUrl}/api/isohyet_catalog/unknown-layer`);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'Camada de isoietas não encontrada' });
});

test('lists the historical isohyet layer available for simulations', async () => {
  const response = await fetch(`${baseUrl}/api/isohyet_catalog`);
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data[0].id, 'historical-1980');
});

test('applies a percentage variation only inside a drawn region', async () => {
  const layer = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { ID: 1000 }, geometry: { type: 'Polygon', coordinates: [[[-46.8,-23.8],[-46.4,-23.8],[-46.4,-23.4],[-46.8,-23.4],[-46.8,-23.8]]] } }] };
  const region = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[-46.7,-23.7],[-46.5,-23.7],[-46.5,-23.5],[-46.7,-23.5],[-46.7,-23.7]]] } };
  const response = await fetch(`${baseUrl}/api/isohyet_adjust`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ layer, region, percentage: 10 }) });
  const data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  assert.ok(data.features.some(feature => feature.properties.ID === 1100));
  assert.ok(data.features.some(feature => feature.properties.ID === 1000));
});

test('compares the historical isohyets with an uploaded GeoJSON layer', async () => {
  const geometry = {
    type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[-46.70, -23.62], [-46.58, -23.62], [-46.58, -23.52], [-46.70, -23.52], [-46.70, -23.62]]] }
  };
  const uploadedLayer = {
    type: 'FeatureCollection', features: [{
      type: 'Feature', properties: { precipitation: 1800 }, geometry: { type: 'Polygon', coordinates: [[[-47, -24], [-46, -24], [-46, -23], [-47, -23], [-47, -24]]] }
    }]
  };
  const response = await fetch(`${baseUrl}/api/isohyet_simulation`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      geometry,
      scenarios: [
        { id: 'historical-1980', name: 'Histórica' },
        { id: 'uploaded-2020', name: 'Atualizada', layer: uploadedLayer }
      ]
    })
  });
  const data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  assert.equal(data.scenarios.length, 2);
  assert.equal(data.scenarios[1].rainfall, 1800);
  assert.ok(data.scenarios[1].coverage >= 0.95);
  assert.ok(data.scenarios[1].avg_discharge > data.scenarios[0].avg_discharge);
  assert.ok(data.scenarios.every(item => [item.rainfall, item.avg_discharge, item.q95, item.q710].every(Number.isFinite)));
});

test('returns identical results when the uploaded isohyets equal the historical layer', async () => {
  const geometry = {
    type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[-46.70, -23.62], [-46.58, -23.62], [-46.58, -23.52], [-46.70, -23.52], [-46.70, -23.62]]] }
  };
  const response = await fetch(`${baseUrl}/api/isohyet_simulation`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      geometry,
      scenarios: [
        { id: 'historical-1980', name: 'Histórica' },
        { id: 'same-upload', name: 'Mesma camada enviada', layer: historicalIsohyets }
      ]
    })
  });
  const data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  for (const key of ['rainfall', 'avg_discharge', 'q95', 'q710']) {
    assert.equal(data.scenarios[0][key], data.scenarios[1][key], key);
  }
});

test('accepts an official MultiPolygon basin in an isohyet simulation', async () => {
  const basinResponse = await fetch(`${baseUrl}/api/coords_join/-23.55/-46.633309?partial_basin=false`);
  const basin = await basinResponse.json();
  assert.equal(basin.ottobacia.geometry.type, 'MultiPolygon');
  const response = await fetch(`${baseUrl}/api/isohyet_simulation`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      geometry: basin.ottobacia,
      scenarios: [{ id: 'historical-1980', name: 'Histórica' }]
    })
  });
  const data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  assert.equal(data.scenarios.length, 1);
  assert.ok(data.scenarios[0].coverage >= 0.95);
});

test('accepts a gzip-compressed isohyet simulation larger than the previous 6 MB limit', async () => {
  const geometry = {
    type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[-46.70, -23.62], [-46.58, -23.62], [-46.58, -23.52], [-46.70, -23.52], [-46.70, -23.62]]] }
  };
  const body = JSON.stringify({
    geometry,
    scenarios: [{ id: 'historical-1980', name: 'Histórica' }],
    parserLimitFixture: 'x'.repeat(7 * 1024 * 1024)
  });
  assert.ok(Buffer.byteLength(body) > 6 * 1024 * 1024);
  const response = await fetch(`${baseUrl}/api/isohyet_simulation`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }, body: zlib.gzipSync(body)
  });
  const data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  assert.equal(data.scenarios.length, 1);
});

test('accepts official border and self-intersecting ottobacias in editor and simulation', async () => {
  const ottobaciaResponse = await fetch(`${baseUrl}/api/ottobacias/8641113`);
  const [officialBasin] = await ottobaciaResponse.json();
  assert.ok(officialBasin);

  const editorResponse = await fetch(`${baseUrl}/api/isohyet_editor_layer`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ layerId: 'historical-1980', geometry: officialBasin })
  });
  assert.equal(editorResponse.status, 200);
  const clipped = await editorResponse.json();
  assert.ok(clipped.features.length > 0);

  const simResponse = await fetch(`${baseUrl}/api/isohyet_simulation`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ geometry: officialBasin, scenarios: [{ id: 'historical-1980', name: 'Histórica' }] })
  });
  assert.equal(simResponse.status, 200);
});

test('simulates flow regularization scenarios using DAEE Equation 14 and Equation 15 (Rio Buquira example)', async () => {
  const catalogRes = await fetch(`${baseUrl}/api/regularization_catalog`);
  assert.equal(catalogRes.status, 200);
  const catalog = await catalogRes.json();
  assert.equal(catalog.k_seconds_per_month, 2628000);
  assert.equal(catalog.regions.length, 21);
  assert.equal(catalog.example.region, 'H');

  const simRes = await fetch(`${baseUrl}/api/regularization_simulation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      base: { region: 'H', avg_discharge_m3s: 9.48 },
      scenarios: [
        { name: 'Rio Buquira T=10 (10%)', qf_m3s: 5.0, return_period_years: 10 },
        { name: 'Rio Buquira T=25 (4%)', qf_m3s: 5.0, failure_probability_percent: 4 },
        { name: 'Rio Buquira Fio d’água', qf_m3s: 2.0, return_period_years: 10 }
      ]
    })
  });
  assert.equal(simRes.status, 200);
  const simData = await simRes.json();
  assert.equal(simData.scenarios.length, 3);

  const buquira10 = simData.scenarios[0];
  assert.equal(buquira10.xt, 0.748);
  assert.equal(buquira10.coef_a, 0.4951);
  assert.equal(buquira10.coef_b, 0.0279);
  assert.ok(Math.abs(buquira10.q1_t_m3s - 3.7087) < 0.02);
  assert.ok(Math.abs(buquira10.volume_hm3 - 7.3625) < 0.05);
  assert.ok(Math.abs(buquira10.critical_duration_months - 3.7625) < 0.05);
  assert.equal(buquira10.status, 'valid_intra_annual');
  assert.equal(buquira10.monthly_series.length, 12);

  const buquira25 = simData.scenarios[1];
  assert.equal(buquira25.return_period_years, 25);
  assert.ok(buquira25.volume_hm3 > buquira10.volume_hm3);

  const runOfRiver = simData.scenarios[2];
  assert.equal(runOfRiver.status, 'run_of_river');
  assert.equal(runOfRiver.volume_m3, 0);
  assert.equal(runOfRiver.critical_duration_months, 0);
});

test('serves Swagger UI at /api-docs and OpenAPI 3.0 specification at /api/openapi.json', async () => {
  const docsRes = await fetch(`${baseUrl}/api-docs`);
  const docsHtml = await docsRes.text();
  assert.equal(docsRes.status, 200);
  assert.match(docsHtml, /SwaggerUIBundle/);
  assert.match(docsHtml, /\/api\/openapi\.json/);

  const specRes = await fetch(`${baseUrl}/api/openapi.json`);
  const spec = await specRes.json();
  assert.equal(specRes.status, 200);
  assert.equal(spec.openapi, '3.0.3');
  assert.ok(spec.paths['/api/coords_join/{lat}/{lon}']);
  assert.ok(spec.paths['/api/regularization_simulation']);
  assert.ok(spec.paths['/api/health']);

  const healthRes = await fetch(`${baseUrl}/api/health`);
  const health = await healthRes.json();
  assert.equal(healthRes.status, 200);
  assert.equal(health.status, 'ok');
  assert.equal(health.layers_loaded, true);
  assert.ok(health.ottobacias_count > 0);

  const healthzRes = await fetch(`${baseUrl}/healthz`);
  const healthz = await healthzRes.json();
  assert.equal(healthzRes.status, 200);
  assert.equal(healthz.status, 'ok');
});

test('serves application, static assets, APIs and Swagger UI under /reg-flow subpath', async () => {
  const indexRes = await fetch(`${baseUrl}/reg-flow`);
  const indexHtml = await indexRes.text();
  assert.equal(indexRes.status, 200);
  assert.match(indexHtml, /href="\/reg-flow\/stylesheets\/style\.css/);
  assert.match(indexHtml, /src="\/reg-flow\/images\/SP-%C3%81guas-Branco\.png"/);
  assert.match(indexHtml, /const serverBasePath = "\/reg-flow"/);

  const cssRes = await fetch(`${baseUrl}/reg-flow/stylesheets/style.css`);
  assert.equal(cssRes.status, 200);

  const healthRes = await fetch(`${baseUrl}/reg-flow/api/health`);
  const health = await healthRes.json();
  assert.equal(healthRes.status, 200);
  assert.equal(health.status, 'ok');

  const docsRes = await fetch(`${baseUrl}/reg-flow/api-docs`);
  const docsHtml = await docsRes.text();
  assert.equal(docsRes.status, 200);
  assert.match(docsHtml, /href="\/reg-flow\/api\/openapi\.json"/);

  const specRes = await fetch(`${baseUrl}/reg-flow/api/openapi.json`);
  const spec = await specRes.json();
  assert.equal(specRes.status, 200);
  assert.equal(spec.servers[0].url, '/reg-flow');
});

test('MDE endpoint validates coordinates and basin coverage', async () => {
  for (const suffix of ['bad/-46', '91/-46']) {
    const response = await fetch(`${baseUrl}/api/dem_delineation/${suffix}`);
    assert.equal(response.status, 400);
  }
  const outside = await fetch(`${baseUrl}/api/dem_delineation/0/0`);
  assert.equal(outside.status, 404);
});

test('retains small discharge values and their nonzero labels in the regularization API', async () => {
  const average = 0.00021374917284;
  const demand = average * 0.5;
  const response = await fetch(`${baseUrl}/api/regularization_simulation`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base: { region: 'H', avg_discharge_m3s: average }, scenarios: [{ qf_m3s: demand, return_period_years: 10 }] })
  });
  const data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  assert.equal(data.scenarios[0].qf_m3s, demand);
  assert.equal(data.scenarios[0].avg_discharge_m3s, average);
  assert.ok(data.scenarios[0].q1_t_m3s > 0);
  assert.match(data.scenarios[0].name, /0,000107 m³\/s/);
});

test('microbasin endpoint rejects invalid thresholds and unknown basin codes', async () => {
  for(const area of ['0','-1','bad','Infinity']) {
    const response=await fetch(`${baseUrl}/api/ottobacias/8669921/microbasins?min_drainage_area_km2=${area}`);
    assert.equal(response.status,400);
  }
  assert.equal((await fetch(`${baseUrl}/api/ottobacias/unknown/microbasins`)).status,404);
});

test('microbasin endpoint partitions the local raster and caches identical queries', {skip:!hasDemData}, async () => {
  const url=`${baseUrl}/api/ottobacias/8669921/microbasins?min_drainage_area_km2=0.1`;
  const response=await fetch(url);const data=await response.json();
  assert.equal(response.status,200,JSON.stringify(data.metadata||data));
  assert.equal(response.headers.get('x-cache'),'MISS');
  assert.equal(data.type,'FeatureCollection');
  assert.equal(data.metadata.classified_cells,data.metadata.valid_cells);
  assert.ok(data.metadata.microbasins_count>1);
  assert.equal(data.features.length,data.metadata.microbasins_count+data.metadata.residual_count);
  assert.equal(data.features.reduce((sum,f)=>sum+f.properties.cell_count,0),data.metadata.valid_cells);
  const ids=new Set(data.features.map(f=>f.properties.unit_id));
  for(const feature of data.features) {
    assert.ok(feature.properties.area_km2>0);
    assert.ok(!feature.properties.downstream_unit_id||ids.has(feature.properties.downstream_unit_id));
  }
  const cached=await fetch(url);assert.equal(cached.status,200);assert.equal(cached.headers.get('x-cache'),'HIT');
});


test('microbasin requests retain the per-client production rate limit', async () => {
  for (let i=0; i<30; i++) assert.equal((await fetch(`${baseUrl}/api/ottobacias/unknown/microbasins`)).status,404);
  const response = await fetch(`${baseUrl}/api/ottobacias/unknown/microbasins`);
  assert.equal(response.status,429);
  assert.equal(response.headers.get('retry-after'),'60');
});


test('water balance rejects invalid geometry before querying WFS', async () => {
  const response = await fetch(`${baseUrl}/api/water_balance`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({geometry:{type:'Point',coordinates:[-46,-23]}})});
  assert.equal(response.status,400);
});

test('water balance recomputes natural flows for the polygon and uses annual volumes, without trusting client reference values', async () => {
  const originalFetch=global.fetch;
  let called=0;
  global.fetch=async(url,options)=>{
    if(String(url).startsWith('https://geodados.daee.sp.gov.br/geoserver/ows')) {
      called++;
      return new Response(JSON.stringify({type:'FeatureCollection',numberMatched:1,features:[{type:'Feature',id:'outorgas.test',geometry:{type:'Point',coordinates:[-46.64,-23.57]},properties:{tipo_uso:'Captação Superficial',STATUS_POR:'Dispensado',VOLUME_ANU:'31536000',Vazão_ins:'3'}}]}));
    }
    return originalFetch(url,options);
  };
  try {
    const geometry={type:'Feature',properties:{},geometry:{type:'Polygon',coordinates:[[[-46.69,-23.61],[-46.59,-23.61],[-46.59,-23.53],[-46.69,-23.53],[-46.69,-23.61]]]}};
    const response=await fetch(`${baseUrl}/api/water_balance`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({geometry,selection:'drawn-geometry',q95:999999})});
    const data=await response.json();assert.equal(response.status,200,JSON.stringify(data));
    assertContract('WaterBalanceResponse', data);
    assert.equal(called,1);assert.equal(data.groups.surface_withdrawal.annual_equivalent_m3s,1);
    assert.equal(data.groups.surface_withdrawal.instantaneous_m3s,3);
    assert.equal(data.counts.eligible,1);assert.equal(data.selection,'drawn-geometry');
    assert.ok(Number.isFinite(data.reference.q95) && data.reference.q95>0 && data.reference.q95!==999999);
    assert.equal(data.accounting_complete,true);
    assert.equal(data.commitment.basis,'instantaneous_surface_flow');
    assert.equal(data.commitment.net_withdrawal_m3s,3);
    assert.equal(data.commitment.complete,true);
    assert.equal(data.commitment.references.q95.percent,3/data.reference.q95*100);

  } finally {global.fetch=originalFetch;}
});


test('water balance returns 502 with no totals when WFS pagination cannot be verified', async()=>{
  const originalFetch=global.fetch;
  global.fetch=async(url,options)=>String(url).startsWith('https://geodados.daee.sp.gov.br/geoserver/ows')
    ? new Response(JSON.stringify({type:'FeatureCollection',features:[],numberMatched:1})) : originalFetch(url,options);
  try {
    const geometry={type:'Feature',properties:{},geometry:{type:'Polygon',coordinates:[[[-46.68,-23.60],[-46.60,-23.60],[-46.60,-23.54],[-46.68,-23.54],[-46.68,-23.60]]]}};
    const response=await fetch(`${baseUrl}/api/water_balance`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({geometry})});
    const data=await response.json();assert.equal(response.status,502);assert.ok(data.error.includes('todas as outorgas'));
    assert.equal(data.groups,undefined);assert.equal(data.reference,undefined);
  }finally{global.fetch=originalFetch;}
});

test('accepts raw Polygon geometry and ignores client hydrological coefficients and bbox', async () => {
  const geometry = require('@turf/turf').bboxPolygon([-46.67, -23.60, -46.65, -23.58]);
  async function calculate(value) {
    const response = await fetch(`${baseUrl}/api/geometry_calculate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ geometry: value }) });
    assert.equal(response.status, 200, await response.clone().text());
    const data = await response.json(); assertContract('GeometryCalculateResponse', data);
    return data;
  }
  const baseline = await calculate(geometry);
  const raw = await calculate(geometry.geometry);
  const malicious = await calculate({ ...geometry, bbox: [-180, -90, 180, 90],
    properties: { avg_a: 0, avg_b: 1, rain: 1000, region: 'a', partial_area: 1e9, coef_c: 9 } });
  for (const key of ['area_km2', 'avg_discharge', 'q95', 'q710']) {
    assert.equal(raw[key], baseline[key]); assert.equal(malicious[key], baseline[key]);
  }
});

test('upstream flags do not bypass state, self-intersection, vertex or coordinate validation', async () => {
  const turf = require('@turf/turf');
  const cases = [
    [turf.bboxPolygon([-43.3, -23.1, -43.29, -23.09]), 400],
    [turf.polygon([[[-46.70,-23.62],[-46.58,-23.52],[-46.70,-23.52],[-46.58,-23.62],[-46.64,-23.66],[-46.70,-23.62]]]), 422],
    [turf.circle([-46.66,-23.59], .5, { steps: 5001 }), 413],
    [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[181,0],[182,0],[182,1],[181,0]]] } }, 400],
    [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[0,0],[1,0],[1,1],[0,1]]] } }, 400]
  ];
  for (const [geometry, status] of cases) {
    geometry.properties = { COBACIA: '8669921', is_upstream_network: true, is_upstream_subbasin: true, _regflow_geometry_token: '0'.repeat(64) };
    const response = await fetch(`${baseUrl}/api/isohyet_editor_layer`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ geometry, layerId: 'historical-1980' }) });
    assert.equal(response.status, status, await response.text());
  }
});

test('rejects duplicate rainfall bands instead of treating half the basin as full coverage', async () => {
  const turf = require('@turf/turf');
  const geometry = turf.bboxPolygon([-46.67,-23.60,-46.65,-23.58]);
  const half = turf.bboxPolygon([-46.67,-23.60,-46.66,-23.58]); half.properties.ID = 1800;
  const response = await fetch(`${baseUrl}/api/isohyet_simulation`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ geometry,
    scenarios: [{ name: 'Sobreposição', layer: turf.featureCollection([half, half]) }] }) });
  assert.equal(response.status, 422); assert.match((await response.json()).error, /sobrepostas/);
});

test('server-produced upstream geometry remains usable and its proof rejects coordinate tampering', async () => {
  const originalElevation = regflow.getElevationByCoords;
  regflow.getElevationByCoords = async () => null;
  try {
    const result = await fetch(`${baseUrl}/api/coords_join/-23.55/-46.633309?partial_basin=false&include_upstream=true&include_topography=false`);
    const data = await result.json(); assert.equal(result.status, 200);
    assertContract('CoordsJoinResponse', data);
    const geometry = data.ottobacia;
    assert.match(geometry.properties._regflow_geometry_token, /^[a-f0-9]{64}$/);
    async function simulate(feature) {
      return fetch(`${baseUrl}/api/isohyet_simulation`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ geometry: feature,
        scenarios: [{ id: 'historical-1980', name: 'Histórica' }] }) });
    }
    const accepted = await simulate(geometry); assert.equal(accepted.status, 200, await accepted.text());
    const forged = require('@turf/turf').bboxPolygon([-43.3,-23.1,-43.29,-23.09]); forged.properties = geometry.properties;
    const rejected = await simulate(forged); assert.equal(rejected.status, 400);
  } finally { regflow.getElevationByCoords = originalElevation; }
});


test('OpenAPI polygon schema rejects malformed positions and accepts both advertised input forms', () => {
  const geometry = require('@turf/turf').bboxPolygon([-46.67,-23.60,-46.65,-23.58]);
  assertContract('GeoJSONFeatureOrGeometry', geometry);
  assertContract('GeoJSONFeatureOrGeometry', geometry.geometry);
  const validate = validators.get('GeoJSONFeatureOrGeometry');
  assert.equal(validate({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[null, 0]]] } }), false);
  assert.equal(validate({ type: 'LineString', coordinates: [[0, 0], [1, 1]] }), false);
  assert.equal(validate({ type: 'Feature' }), false);
  for (const name of Object.keys(schemas)) {
    assert.doesNotThrow(() => ajv.compile({ components: { schemas }, $ref: `#/components/schemas/${name}` }), name);
  }
});


test('legacy calculations reject fractional indexes, zero denominators and numeric overflow', async () => {
  const cases = [
    ['/calculate_critical_duration/5/.748/.4951/0/9.48', 400],
    ['/calculate_critical_duration/h/0/5/.4951/0/9.48', 400],
    ['/calculate_minimal_discharge/h/0.5/.4951/.0279/1/9.48', 400],
    ['/calculate_minimal_discharge/h/0/.4951/.0279/1.5/9.48', 400],
    ['/calculate_discharge_avg/1e308/1e308/1000/1000', 422],
    ['/calculate_discharge_avg/-26.23/.0278/100/1000', 422],
    ['/calculate_q95/h/-1/100', 400]
  ];
  for (const [route, status] of cases) {
    const response = await fetch(baseUrl + '/api' + route);
    assert.equal(response.status, status, await response.text());
  }
});

test('context microbasins reject invalid geometry and thresholds before processing', async () => {
  const geometry = require('@turf/turf').bboxPolygon([-46.67,-23.6,-46.65,-23.58]);
  const cases = [
    [{ geometry, min_drainage_area_km2: 0 }, 400],
    [{ geometry, min_drainage_area_km2: -1 }, 400],
    [{ geometry, min_drainage_area_km2: 'invalid' }, 400],
    [{ geometry: { type: 'Point', coordinates: [-46,-23] }, min_drainage_area_km2: 1 }, 400],
    [{ geometry: require('@turf/turf').bboxPolygon([-43.3,-23.1,-43.29,-23.09]), min_drainage_area_km2: 1 }, 400]
  ];
  for (const [body, status] of cases) {
    const response = await fetch(`${baseUrl}/api/microbasins`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, status, await response.text());
  }
});

test('microbasins cover all selected upstream ottobasins and keep local point cuts distinct in cache', { skip: !hasDemData }, async () => {
  const turf = require('@turf/turf');
  const originalElevation = regflow.getElevationByCoords;
  regflow.getElevationByCoords = async () => null;
  try {
    const selectedResponse = await fetch(`${baseUrl}/api/coords_join/-23.951116/-47.312622?include_upstream=true&include_topography=false`);
    const selected = await selectedResponse.json(); assert.equal(selectedResponse.status, 200, JSON.stringify(selected));
    assert.ok(selected.upstream_basins.length > 1);
    async function micro(geometry) {
      return fetch(`${baseUrl}/api/microbasins`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ geometry, min_drainage_area_km2: 1 }) });
    }
    const response = await micro(selected.ottobacia), result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result.metadata || result));
    assertContract('MicrobasinsResponse', result);
    assert.equal(result.metadata.scope, 'calculated_basin');
    assert.equal(result.metadata.min_drainage_area_km2, 1);
    assert.equal(result.metadata.classified_cells, result.metadata.valid_cells);
    assert.ok(result.metadata.area_km2 > .98 * selected.area_km2);
    const official = require('../public/layers/ottobacias.json');
    // Interior witnesses avoid fragile polygon clipping at coincident raster/vector edges.
    const units = result.features.map(feature => ({ feature, bounds: turf.bbox(feature), sample: turf.centroid(feature) }))
      .filter(({ feature, sample }) => turf.booleanPointInPolygon(sample, feature, { ignoreBoundary: true }));
    for (const summary of selected.upstream_basins) {
      const basin = official.features.find(feature => feature.properties.COBACIA === summary.COBACIA);
      assert.ok(basin, summary.COBACIA);
      const b = turf.bbox(basin);
      assert.ok(units.some(({ sample, bounds: a }) => {
        if (a[0] > b[2] || a[2] < b[0] || a[1] > b[3] || a[3] < b[1]) return false;
        return turf.booleanPointInPolygon(sample, basin, { ignoreBoundary: true });
      }), `Sem células representadas na ottobacia ${summary.COBACIA}`);
    }
    const cached = await micro(selected.ottobacia); assert.equal(cached.headers.get('x-cache'), 'HIT');
    const localResponse = await fetch(`${baseUrl}/api/coords_join/-23.951116/-47.312622?include_topography=false`);
    const local = await localResponse.json(); assert.equal(localResponse.status, 200);
    assert.equal(local.ottobacia.properties.COBACIA, selected.ottobacia.properties.COBACIA);
    const localResult = await micro(local.ottobacia), data = await localResult.json();
    assert.equal(localResult.status, 200, JSON.stringify(data)); assert.equal(localResult.headers.get('x-cache'), 'MISS');
    assert.ok(data.metadata.basin_area_km2 < result.metadata.basin_area_km2);
    assert.ok(Math.abs(data.metadata.basin_area_km2 / local.area_km2 - 1) < .02);
  } finally { regflow.getElevationByCoords = originalElevation; }
});

test('progressive water balance verifies every spatial stage before returning natural references and totals', async () => {
  const originalFetch=global.fetch, requests=[];
  global.fetch=async(url,options)=>{
    if(String(url).startsWith('https://geodados.daee.sp.gov.br/geoserver/ows')) {
      requests.push(new URL(url));
      return new Response(JSON.stringify({type:'FeatureCollection',numberMatched:1,features:[{type:'Feature',id:'progressive.test',geometry:{type:'Point',coordinates:[-46.66,-23.59]},properties:{tipo_uso:'Captação Superficial',STATUS_POR:'Dispensado',VOLUME_ANU:'31536000',Vazão_ins:'3'}}]}));
    }
    return originalFetch(url,options);
  };
  const geometry=require('@turf/turf').bboxPolygon([-46.67,-23.6,-46.652,-23.58]);
  const post=(stage,body)=>fetch(`${baseUrl}/api/water_balance/${stage}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  try {
    let response=await post('start',{geometry,selection:'drawn-geometry',q95:999999});
    const started=await response.json();assert.equal(response.status,200,JSON.stringify(started));
    assertContract('WaterBalanceStartResponse',started);assert.equal(requests.length,0);
    const plan=started.plan;assert.ok(plan.data.cells.length>1);
    response=await post('complete',{geometry,plan,receipts:[]});assert.equal(response.status,422);
    const receipts=[];
    for (const cell of plan.data.cells) {
      response=await post('page',{geometry,plan,cells:[cell]});const page=await response.json();
      assert.equal(response.status,200,JSON.stringify(page));assertContract('WaterBalancePageResponse',page);receipts.push(page.receipt);
    }
    response=await post('complete',{geometry,plan,receipts,q95:999999});const result=await response.json();
    assert.equal(response.status,200,JSON.stringify(result));assertContract('WaterBalanceResponse',result);
    assert.equal(result.counts.in_polygon,1);assert.equal(result.commitment.net_withdrawal_m3s,3);
    assert.ok(result.reference.q95!==999999);assert.equal(result.source.loading_method,'spatial_batches');
    response=await post('start',{geometry});const cached=await response.json();
    assert.equal(cached.cache,'HIT');assertContract('WaterBalanceStartResponse',cached);
    assert.equal(cached.result.counts.in_polygon,1);
    const changed=structuredClone(plan);changed.data.reference.q95=99999;
    response=await post('page',{geometry,plan:changed,cells:[0]});assert.equal(response.status,400);
  } finally {global.fetch=originalFetch;}
});

test('outorga page quotas return the remaining cooldown and reset after the current window', async () => {
  const originalNow=Date.now;let now=originalNow();Date.now=()=>now;
  const page=()=>fetch(`${baseUrl}/api/water_balance/page`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  try {
    for(let index=0;index<180;index++)assert.equal((await page()).status,400);
    now+=20000;
    const limited=await page();assert.equal(limited.status,429);assert.equal(limited.headers.get('retry-after'),'40');
    now+=40000;assert.equal((await page()).status,400);
  } finally {Date.now=originalNow;}
});
test('outorga pages preserve GeoServer 429 and Retry-After for the browser cooldown', async () => {
  const originalFetch=global.fetch;
  global.fetch=async(url,options)=>String(url).startsWith('https://geodados.daee.sp.gov.br/geoserver/ows')
    ?new Response('<html>Rate limited</html>',{status:429,headers:{'Retry-After':'90'}}):originalFetch(url,options);
  try {
    const geometry=require('@turf/turf').bboxPolygon([-46.68,-23.60,-46.662,-23.58]);
    const post=(stage,body)=>fetch(`${baseUrl}/api/water_balance/${stage}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const started=await post('start',{geometry}),{plan}=await started.json();assert.equal(started.status,200);
    const response=await post('page',{geometry,plan,cells:plan.data.cells.slice(0,8)});
    assert.equal(response.status,429);assert.equal(response.headers.get('retry-after'),'90');
    assert.equal((await response.json()).groups,undefined);
  } finally {global.fetch=originalFetch;}
});
