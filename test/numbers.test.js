'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { format, input } = require('../public/javascripts/numbers');

test('preserves visible small positive and negative quantities, including scientific notation', () => {
  assert.equal(format(0.002137), '0,00214');
  assert.equal(format(0.000412), '0,000412');
  assert.equal(format(0.0009), '0,000900');
  assert.equal(format(-0.002137), '-0,00214');
  assert.match(format(1e-20), /1,00E-20/);
  assert.match(format(Number.MIN_VALUE), /E-324/);
  assert.equal(format(1234.56), '1.234,56');
  assert.equal(format(0), '0,00');
  assert.equal(format(-0), '0,00');
});

test('missing and nonfinite data are not presented as zero', () => {
  for (const value of [null, undefined, '', ' ', false, NaN, Infinity]) {
    assert.equal(format(value), '—');
    assert.equal(input(value), '');
  }
});

test('editable simulator values retain round-trip precision rather than the display rounding', () => {
  for (const value of [0.0021374917284, 0.0000001234567, 0.00123456789, 401.5]) {
    assert.equal(Number(input(value)), value);
  }
});
