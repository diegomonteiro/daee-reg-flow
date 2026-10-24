'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const app = require('../app');
const regflow = require('../models/regflow');
const historicalIsohyets = require('../public/layers/rain_isoline.json');

let server;
let baseUrl;

test.before(async () => {
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

test('calculates a real São Paulo basin with finite area-weighted results and proportional upstream sub-basin', async () => {
  const response = await fetch(`${baseUrl}/api/coords_join/-23.55/-46.633309`);
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-cache'), 'MISS');
  assert.ok(data.area_km2 > 0);
  assert.ok(data.full_area_km2 > data.area_km2);
  assert.ok(data.area_proportion > 0 && data.area_proportion < 1);
  assert.ok(data.ottobacia_full);
  assert.ok(data.cross_section);
  assert.equal(data.cross_section.line.geometry.type, 'LineString');
  assert.equal(data.cross_section.stream_point.length, 2);
  assert.ok(data.rau.bands.length > 0);
  assert.equal(data.ottotrecho[0].properties.NOCOMPLETO, 'Rio Tamanduateí');
  assert.equal(data.ottotrecho[0].geometry.type, 'MultiLineString');
  assert.equal(data.ottotrecho[0].properties.stream_endpoints.first.coordinates.length, 2);
  assert.ok(data.rxyz.bands.length > 0);
  assert.ok([data.isolines.avg_areas, data.avg_discharge, data.q95, data.q710].every(Number.isFinite));
  assert.equal(data.avg_discharge, regflow.calculateAvgFlowRateLongPeriod(data.rau.avg_a, data.rau.avg_b, data.isolines.avg_areas, data.area_km2));
  const rauArea = data.rau.bands.reduce((sum, band) => sum + band.properties.partial_area, 0);
  assert.ok(Math.abs(rauArea - data.area_km2) / data.area_km2 < 0.02);

  const guarulhosResp = await fetch(`${baseUrl}/api/coords_join/-23.434899/-46.476631`);
  const guarulhosData = await guarulhosResp.json();
  assert.equal(guarulhosResp.status, 200);
  assert.equal(guarulhosData.ottobacia.properties.COBACIA, '8669936');
  assert.ok(guarulhosData.area_km2 > 0 && guarulhosData.area_km2 < guarulhosData.full_area_km2);
  assert.equal(guarulhosData.cross_section.border_points.length, 2);
  assert.ok(guarulhosData.cross_section.line.geometry.coordinates.length >= 3);

  const juquiaResp = await fetch(`${baseUrl}/api/coords_join/-23.951116/-47.312622`);
  const juquiaData = await juquiaResp.json();
  assert.equal(juquiaResp.status, 200);
  assert.equal(juquiaData.ottobacia.properties.COBACIA, '77944933');
  assert.equal(juquiaData.ottobacia.geometry.coordinates.length, 1);
  assert.equal(juquiaData.area_km2, juquiaData.full_area_km2);
  assert.equal(juquiaData.area_proportion, 1);
  assert.equal(juquiaData.include_upstream, false);
  assert.equal(juquiaData.available_upstream_basins_count, 12);

  const upstreamTreeResp = await fetch(`${baseUrl}/api/coords_join/-23.55/-46.633309?include_upstream=true`);
  const upstreamTreeData = await upstreamTreeResp.json();
  assert.equal(upstreamTreeResp.status, 200);
  assert.equal(upstreamTreeData.include_upstream, true);
  assert.equal(upstreamTreeData.available_upstream_basins_count, 2);
  assert.equal(upstreamTreeData.upstream_basins.length, 3);
  assert.deepEqual(upstreamTreeData.upstream_basins.map(b => b.COBACIA), ['8669921', '8669922', '8669923']);
  assert.ok(upstreamTreeData.area_km2 > data.area_km2);
  assert.ok(upstreamTreeData.full_area_km2 > data.full_area_km2);
  assert.ok(upstreamTreeData.avg_discharge > data.avg_discharge);
  assert.equal(upstreamTreeData.ottobacia_full.type, 'FeatureCollection');
  assert.equal(upstreamTreeData.ottobacia_full.features.length, 3);

  const jacupirangaResp = await fetch(`${baseUrl}/api/coords_join/-24.665738/-47.992401?include_upstream=true`);
  const jacupirangaData = await jacupirangaResp.json();
  assert.equal(jacupirangaResp.status, 200);
  assert.equal(jacupirangaData.include_upstream, true);
  assert.equal(jacupirangaData.available_upstream_basins_count, 10);
  assert.equal(jacupirangaData.upstream_basins.length, 11);
  assert.ok(jacupirangaData.area_km2 > 930);
  assert.ok(jacupirangaData.full_area_km2 > 935);

  const taquariResp = await fetch(`${baseUrl}/api/coords_join/-24.037685/-48.886414`);
  const taquariData = await taquariResp.json();
  assert.equal(taquariResp.status, 200);
  assert.equal(taquariData.partial_basin, true);
  assert.equal(taquariData.ottobacia.properties.COBACIA, '8649298');
  assert.ok(taquariData.area_km2 > 260 && taquariData.area_km2 < taquariData.full_area_km2);
  assert.ok(taquariData.area_proportion > 0.88 && taquariData.area_proportion < 0.96);

  const taquariFullResp = await fetch(`${baseUrl}/api/coords_join/-24.037685/-48.886414?partial_basin=false`);
  const taquariFullData = await taquariFullResp.json();
  assert.equal(taquariFullResp.status, 200);
  assert.equal(taquariFullData.partial_basin, false);
  assert.equal(taquariFullData.area_proportion, 1);
  assert.equal(taquariFullData.cross_section, null);
  assert.ok(Math.abs(taquariFullData.area_km2 - taquariFullData.full_area_km2) < 1e-6);
  assert.ok(taquariFullData.avg_discharge > taquariData.avg_discharge);
});

test('classifies the highest stream endpoint as upstream and the lowest as downstream', async () => {
  const originalElevation = regflow.getElevationByCoords;
  regflow.getElevationByCoords = async (lat, lon) => ({ min: Math.round(-lat * 100) - 10, max: Math.round(-lat * 100) });
  try {
    const response = await fetch(`${baseUrl}/api/coords_join/-23.551/-46.632`);
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
  assert.deepEqual(data.ottobacia.geometry.coordinates, geometry.geometry.coordinates);
  assert.ok(data.area_km2 > 0);
  assert.ok(data.intersecting_basins.length > 0);
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
  const basinResponse = await fetch(`${baseUrl}/api/coords_join/-23.55/-46.633309`);
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
