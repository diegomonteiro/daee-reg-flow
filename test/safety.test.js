'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const turf = require('@turf/turf');
const { JsonCache } = require('../services/json-cache');
const { createGeometryProof } = require('../services/geometry-proof');
const { rainfallCoverage } = require('../services/rainfall-coverage');
const { createScope } = require('../public/javascripts/request-scope');

test('cache enforces bytes, entry size, LRU and expiry, without retaining caller mutations', () => {
  let now = 0;
  const cache = new JsonCache({ maxBytes: 60, maxEntryBytes: 30, ttlMs: 10, now: () => now });
  const input = { value: '1234567890' }; // 22 bytes
  cache.set('a', input); input.value = 'changed'; cache.set('b', { value: '1234567890' });
  assert.equal(cache.get('a').value, '1234567890');
  cache.set('c', { value: '1234567890' });
  assert.equal(cache.get('b'), undefined);
  assert.ok(cache.bytes <= 60);
  assert.equal(cache.set('large', { value: 'x'.repeat(100) }), false);
  const returned = cache.get('a'); returned.value = 'mutated';
  assert.equal(cache.get('a').value, '1234567890');
  now = 10; cache.prune(); assert.equal(cache.entries.size, 0); assert.equal(cache.bytes, 0);
});

test('geometry proofs reject changed coordinates, types, forged metadata and another secret', () => {
  const signer = createGeometryProof('test-secret');
  const polygon = turf.bboxPolygon([-46.7, -23.6, -46.6, -23.5]);
  const signed = signer.sign(polygon);
  assert.ok(signer.verify(signed));
  assert.equal(signer.verify(polygon), false);
  assert.equal(createGeometryProof('other-secret').verify(signed), false);
  const changed = structuredClone(signed); changed.geometry.coordinates[0][1][0] += .001;
  assert.equal(signer.verify(changed), false);
  const forged = structuredClone(polygon); forged.properties = { COBACIA: '8669921', is_upstream_network: true };
  assert.equal(signer.verify(forged), false);
  assert.equal(polygon.properties._regflow_geometry_token, undefined);
});

test('rainfall coverage respects gaps, holes, disjoint polygons and rejects any meaningful overlaps', () => {
  const left = turf.bboxPolygon([-46.7, -23.6, -46.65, -23.5]);
  const right = turf.bboxPolygon([-46.65, -23.6, -46.6, -23.5]);
  const area = turf.area(left) / 1e6 + turf.area(right) / 1e6;
  assert.ok(Math.abs(rainfallCoverage([left], area) - .5) < 1e-10);
  assert.ok(Math.abs(rainfallCoverage([left, right], area) - 1) < 1e-10);
  assert.throws(() => rainfallCoverage([left, left], area), { status: 422 });
  const overlapping = turf.bboxPolygon([-46.675, -23.6, -46.6, -23.5]);
  assert.throws(() => rainfallCoverage([left, overlapping], area), { status: 422 });
  const outer = turf.bboxPolygon([-46.7, -23.6, -46.6, -23.5]);
  const hole = turf.bboxPolygon([-46.68, -23.58, -46.62, -23.52]);
  const donut = turf.difference(outer, hole);
  assert.ok(rainfallCoverage([donut], turf.area(outer) / 1e6) < 1);
});

test('superseded and canceled requests remain stale even when a transport resolves after abort', async () => {
  const scope = createScope();
  let resolve;
  const delayed = new Promise(r => { resolve = r; });
  const old = scope.begin();
  let rendered = false;
  const pending = delayed.then(() => { if (old.isCurrent()) rendered = true; });
  const current = scope.begin();
  assert.equal(old.signal.aborted, true); assert.equal(current.isCurrent(), true);
  resolve(); await pending; assert.equal(rendered, false);
  scope.cancel(); assert.equal(current.signal.aborted, true); assert.equal(current.isCurrent(), false);
});
