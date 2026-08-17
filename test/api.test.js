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

test('calculates a real São Paulo basin with finite area-weighted results', async () => {
  const response = await fetch(`${baseUrl}/api/coords_join/-23.55/-46.633309`);
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-cache'), 'MISS');
  assert.ok(data.area_km2 > 0);
  assert.ok(data.rau.bands.length > 0);
  assert.equal(data.ottotrecho[0].properties.NOCOMPLETO, 'Rio Tamanduateí');
  assert.equal(data.ottotrecho[0].geometry.type, 'MultiLineString');
  assert.equal(data.ottotrecho[0].properties.stream_endpoints.first.coordinates.length, 2);
  assert.ok(data.rxyz.bands.length > 0);
  assert.ok([data.isolines.avg_areas, data.avg_discharge, data.q95, data.q710].every(Number.isFinite));
  const rauArea = data.rau.bands.reduce((sum, band) => sum + band.properties.partial_area, 0);
  assert.ok(Math.abs(rauArea - data.area_km2) / data.area_km2 < 0.02);
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
  assert.ok([data.isolines.avg_areas, data.avg_discharge, data.q95, data.q710].every(Number.isFinite));
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
