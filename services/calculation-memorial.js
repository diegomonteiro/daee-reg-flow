'use strict';
const regflow = require('../models/regflow');

// Snapshot of the actual intersections and parameters used by the regionalization.
module.exports = function calculationMemorial(data) {
  const bands = value => (value?.bands || []).map(feature => ({ ...feature.properties }));
  const rain = bands(data.isolines).map(p => ({ area_km2: p.partial_area, rainfall_mm: p.rain }));
  const regions = bands(data.rau).map(p => ({
    region: p.region, area_km2: p.partial_area,
    avg_a: p.avg_a, avg_b: p.avg_b, coef_a: p.coef_a, coef_b: p.coef_b,
    permanence_factor: regflow.getPermanenceCurvesByRegionFreqIndex(p.region, 14),
    xt10: regflow.getXTCoef(p.region, 0),
    q95: regflow.calculateQ95(p.region, data.avg_discharge),
    q710: regflow.calculateQ7T(data.rxyz.coef_c, p.region, 0, p.coef_a, p.coef_b, data.avg_discharge)
  }));
  const xyz = bands(data.rxyz).map(p => ({ id: p.id, area_km2: p.partial_area, coef_c: p.coef_c }));
  return {
    method: 'DAEE (1988)', area_km2: data.area_km2,
    rainfall_bands: rain, regions, xyz_regions: xyz,
    weighting_areas_km2: {
      rainfall: rain.reduce((s, p) => s + p.area_km2, 0),
      rau: regions.reduce((s, p) => s + p.area_km2, 0), xyz: xyz.reduce((s, p) => s + p.area_km2, 0)
    },
    coefficients: {
      avg_a: data.rau.avg_a, avg_b: data.rau.avg_b,
      coef_a: data.rau.coef_a, coef_b: data.rau.coef_b, coef_c: data.rxyz.coef_c
    },
    rainfall_mm: data.isolines.avg_areas,
    results: { avg_discharge: data.avg_discharge, q95: data.q95, q710: data.q710 }
  };
};
