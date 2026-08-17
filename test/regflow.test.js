'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const regflow = require('../models/regflow');

test('calculates a finite weighted average', () => {
  assert.equal(regflow.calculateAvgByWeight([{ value: 10, weight: 1 }, { value: 20, weight: 3 }]), 17.5);
});

test('returns null instead of NaN when no valid weight exists', () => {
  assert.equal(regflow.calculateAvgByWeight([]), null);
  assert.equal(regflow.calculateAvgByWeight([{ value: 10, weight: 0 }]), null);
});

test('uses the documented Q95 permanence index', () => {
  assert.ok(Math.abs(regflow.calculateQ95('a', 10) - 3.48) < Number.EPSILON * 10);
});

test('validates region and return-period indexes', () => {
  assert.equal(regflow.getXTCoef('a', 0), 0.708);
  assert.throws(() => regflow.getXTCoef('invalid', 0), RangeError);
  assert.throws(() => regflow.getXTCoef('a', 6), RangeError);
});

test('calculates long-period average discharge with expected units', () => {
  assert.equal(regflow.calculateAvgFlowRateLongPeriod(-20, 0.03, 1500, 100), 2.5);
});
