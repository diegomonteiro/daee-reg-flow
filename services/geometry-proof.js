'use strict';

const { createHmac, randomBytes, timingSafeEqual } = require('node:crypto');
const PROPERTY = '_regflow_geometry_token';

// Bind the exception for server-produced geometries to their actual coordinates.
// Configure the same secret on every replica; without it proofs last this process.
function createGeometryProof(secret = process.env.GEOMETRY_SIGNING_SECRET || randomBytes(32)) {
  const signature = geometry => createHmac('sha256', secret)
    .update(JSON.stringify([geometry.type, geometry.coordinates])).digest('hex');
  return {
    sign(feature) {
      return { type: 'Feature', geometry: feature.geometry,
        properties: { ...feature.properties, [PROPERTY]: signature(feature.geometry) } };
    },
    verify(feature) {
      const token = feature.properties?.[PROPERTY];
      if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return false;
      return timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(signature(feature.geometry), 'hex'));
    }
  };
}

module.exports = { createGeometryProof };
