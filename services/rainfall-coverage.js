'use strict';
const turf = require('@turf/turf');

function rainfallCoverage(bands, referenceAreaKm2) {
  const failure = message => Object.assign(new Error(message), { status: 422 });
  let union = null, summedArea = 0;
  try {
    for (const band of bands) {
      summedArea += turf.area(band) / 1e6;
      union = union ? turf.union(union, band) : band;
    }
  } catch (_) {
    throw failure('Não foi possível validar a cobertura das isoietas; revise as geometrias da camada.');
  }
  const unionArea = union ? turf.area(union) / 1e6 : 0;
  // Ignore only numerical slivers at shared boundaries, never meaningful overlap.
  const toleranceKm2 = Math.max(1e-10, unionArea * 1e-8);
  if (summedArea - unionArea > toleranceKm2) {
    throw failure('A camada de isoietas contém faixas sobrepostas na bacia; corrija a sobreposição antes de calcular.');
  }
  return Math.min(unionArea / referenceAreaKm2, 1);
}

module.exports = { rainfallCoverage };
