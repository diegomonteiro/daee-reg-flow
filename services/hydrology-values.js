'use strict';

function finiteResult(value) {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw Object.assign(new RangeError('O cálculo excede o domínio numérico válido; revise os parâmetros e denominadores.'), { status: 422 });
  }
  if (value && typeof value === 'object') Object.values(value).forEach(finiteResult);
  return value;
}

module.exports = { finiteResult };
