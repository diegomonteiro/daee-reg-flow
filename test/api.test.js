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
  assert.match(html, /Calcular vazão/);
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
  assert.equal(taquariData.ottobacia.properties.COBACIA, '8649298');
  assert.ok(taquariData.area_km2 > 260 && taquariData.area_km2 < taquariData.full_area_km2);
  assert.ok(taquariData.area_proportion > 0.88 && taquariData.area_proportion < 0.96);
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
