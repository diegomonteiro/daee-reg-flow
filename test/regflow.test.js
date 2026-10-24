'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const turf = require('@turf/turf');
const regflow = require('../models/regflow');

test('calculates a finite weighted average', () => {
  assert.equal(regflow.calculateAvgByWeight([{ value: 10, weight: 1 }, { value: 20, weight: 3 }]), 17.5);
});

test('returns null instead of NaN when no valid weight exists', () => {
  assert.equal(regflow.calculateAvgByWeight([]), null);
  assert.equal(regflow.calculateAvgByWeight([{ value: 10, weight: 0 }]), null);
  assert.equal(regflow.calculateAvgByWeight(null), null);
});

test('ignores invalid values and non-positive weights in weighted averages', () => {
  const values = [
    { value: 10, weight: 2 },
    { value: Number.NaN, weight: 5 },
    { value: 100, weight: -2 },
    { value: '20', weight: '1' }
  ];
  assert.equal(regflow.calculateAvgByWeight(values), 40 / 3);
});

test('uses the documented Q95 permanence index', () => {
  assert.ok(Math.abs(regflow.calculateQ95('a', 10) - 3.48) < Number.EPSILON * 10);
});

test('validates region and return-period indexes', () => {
  assert.equal(regflow.getXTCoef('a', 0), 0.708);
  assert.equal(regflow.getXTCoefByRegions(['a', 'c'], 0), (0.708 + 0.748) / 2);
  assert.throws(() => regflow.getXTCoef('invalid', 0), RangeError);
  assert.throws(() => regflow.getXTCoef('a', 6), RangeError);
  assert.throws(() => regflow.getXTCoefByRegions(['a', 'invalid'], 0), RangeError);
  assert.throws(() => regflow.getPermanenceCurvesByRegionFreqIndex('a', 16), RangeError);
});

test('calculates long-period average discharge with expected units', () => {
  assert.equal(regflow.calculateAvgFlowRateLongPeriod(-20, 0.03, 1500, 100), 2.5);
});

test('calculates Qmin, Q7T, critical duration and regularization volume deterministically', () => {
  assert.ok(Math.abs(regflow.calculateQmin('a', 0, 0.3, 0.02, 10, 2) - 2.4072) < 1e-12);
  assert.ok(Math.abs(regflow.calculateQ7T(0.75, 'a', 0, 0.3, 0.02, 10) - 1.6992) < 1e-12);
  assert.equal(regflow.calculateCriticalDuration(5, 'a', 0, 0.3, 0.02, 10), (5 - 0.708 * 0.3 * 10) / (2 * 0.708 * 0.02 * 10));
  assert.equal(regflow.calculateVolumeRegularization(5, 'a', 0, 0.3, 0.02, 10, 2), (Math.pow(5 - 0.708 * 0.3 * 10, 2) / (4 * 0.708 * 0.02 * 10)) * (2 * 2628000));
});

test('returns documented regional coefficients and rejects unknown regions', () => {
  assert.deepEqual(regflow.getRelationRainToFlowRate('A'), { param_a: -22.14, param_b: 0.0292 });
  assert.deepEqual(regflow.getMeansABCoef('G'), { a: 0.4089, b: 0.0332 });
  assert.equal(regflow.getPermanenceCurvesByRegion('u').length, 16);
  assert.throws(() => regflow.getRelationRainToFlowRate('z'), RangeError);
  assert.throws(() => regflow.getMeansABCoef(null), RangeError);
  assert.throws(() => regflow.getPermanenceCurvesByRegion('z'), RangeError);
});

test('calculates area-weighted rainfall for a polygon smaller than the sampling grid', () => {
  const basin = turf.polygon([[[-46.6005, -23.6005], [-46.5995, -23.6005], [-46.5995, -23.5995], [-46.6005, -23.5995], [-46.6005, -23.6005]]]);
  const rainfall = turf.featureCollection([
    turf.polygon([[[-46.61, -23.61], [-46.59, -23.61], [-46.59, -23.59], [-46.61, -23.59], [-46.61, -23.61]]], { ID: 1234 })
  ]);
  const result = regflow.getMeanRainfallByGeometry(basin, 1, { units: 'kilometers' }, 'area', rainfall);
  assert.equal(result.avg_areas, 1234);
  assert.equal(result.bands.length, 1);
  assert.ok(result.bands[0].properties.partial_area > 0);
});

test('handles Mapbox elevation success, API_TOKEN fallback, malformed responses and invalid coordinates', async () => {
  const originalFetch = global.fetch;
  const originalToken = process.env.MAPBOX_TOKEN;
  const originalApiToken = process.env.API_TOKEN;
  process.env.MAPBOX_TOKEN = 'test token';
  try {
    let requestedUrl;
    global.fetch = async url => {
      requestedUrl = url;
      return { ok: true, json: async () => ({ features: [{ properties: { ele: '730' } }, { properties: { ele: 710 } }, { properties: {} }] }) };
    };
    assert.deepEqual(await regflow.getElevationByCoords(-23.5, -46.6), { min: 710, max: 730 });
    assert.match(requestedUrl, /access_token=test%20token/);

    delete process.env.MAPBOX_TOKEN;
    process.env.API_TOKEN = 'fallback-api-token';
    assert.deepEqual(await regflow.getElevationByCoords(-23.5, -46.6), { min: 710, max: 730 });
    assert.match(requestedUrl, /access_token=fallback-api-token/);

    global.fetch = async () => ({ ok: false });
    assert.equal(await regflow.getElevationByCoords(-23.5, -46.6), null);
    global.fetch = async () => ({ ok: true, json: async () => { throw new SyntaxError('invalid JSON'); } });
    assert.equal(await regflow.getElevationByCoords(-23.5, -46.6), null);
    global.fetch = async () => { throw new Error('network'); };
    assert.equal(await regflow.getElevationByCoords(-23.5, -46.6), null);
    assert.equal(await regflow.getElevationByCoords(100, -46.6), null);
  } finally {
    global.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.MAPBOX_TOKEN;
    else process.env.MAPBOX_TOKEN = originalToken;
    if (originalApiToken === undefined) delete process.env.API_TOKEN;
    else process.env.API_TOKEN = originalApiToken;
  }
});
