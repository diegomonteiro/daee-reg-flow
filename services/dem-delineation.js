'use strict';

const { execFile } = require('node:child_process');
const path = require('node:path');
const debug = require('debug')('daee-reg-flow:dem');

function createDelineator({ env = process.env, execute = execFile } = {}) {
  let busy = false;
  async function run(script, args, payload) {
    if (busy) throw Object.assign(new Error('Serviço MDE ocupado; tente novamente.'), { status: 503 });
    busy = true;
    try {
      return await new Promise((resolve, reject) => {
        const child = execute(env.DEM_PYTHON || 'python3', [
          path.join(__dirname, '../scripts/hydrology/', script), ...args
        ], { timeout: 8500, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
          if (error) {
            debug('Worker MDE: %s; %s', error.message, String(stderr || '').slice(0, 4000));
            return reject(Object.assign(new Error('Falha no processamento MDE ou limite de 8,5 segundos excedido. Verifique dependências e rasters no servidor.'), { status: 503 }));
          }
          try {
            const result = JSON.parse(stdout);
            if (result.error) return reject(Object.assign(new Error(result.error), { status: 422 }));
            resolve(result);
          } catch (parseError) { reject(parseError); }
        });
        child.stdin.on('error', () => {});
        child.stdin.end(JSON.stringify(payload));
      });
    } finally { busy = false; }
  }
  const elevationPath = () => env.DEM_ELEVATION_PATH || (env.DEM_D8_PATH ? path.join(path.dirname(env.DEM_D8_PATH), 'elevation.tif') : null);
  async function delineate(basin, point, streams = [], inflowBasins = [], options = {}) {
    if (!env.DEM_D8_PATH || !env.DEM_ACCUMULATION_PATH) {
      throw Object.assign(new Error('Configure DEM_D8_PATH e DEM_ACCUMULATION_PATH; consulte docs/DEM_DELINEATION.md.'), { status: 503 });
    }
    const minDrainageArea = Number(env.DEM_MIN_DRAINAGE_AREA_KM2 || 0.1);
    if (!Number.isFinite(minDrainageArea) || minDrainageArea <= 0) {
      throw Object.assign(new Error('DEM_MIN_DRAINAGE_AREA_KM2 deve ser um número positivo.'), { status: 503 });
    }
    return run('delineate.py', [env.DEM_D8_PATH, env.DEM_ACCUMULATION_PATH, elevationPath()],
      { basin, point, streams, inflow_basins: inflowBasins, min_drainage_area_km2: minDrainageArea,
        include_topography: options.includeTopography !== false });
  }
  delineate.topography = async function(basin) {
    if (!elevationPath()) throw Object.assign(new Error('Configure DEM_ELEVATION_PATH ou DEM_D8_PATH para visualizar a topografia.'), { status: 503 });
    return run('topography.py', [elevationPath()], { basin });
  };
  const microbasinCache = new Map();
  let cacheBytes = 0;
  delineate.microbasins = async function(basin, minArea) {
    if (!Number.isFinite(minArea) || minArea <= 0) throw Object.assign(new Error('Área mínima de drenagem deve ser positiva.'), { status: 400 });
    if (!env.DEM_D8_PATH || !env.DEM_ACCUMULATION_PATH) throw Object.assign(new Error('Configure DEM_D8_PATH e DEM_ACCUMULATION_PATH.'), { status: 503 });
    const { stat } = require('node:fs/promises');
    let versions;
    try { versions = await Promise.all([stat(env.DEM_D8_PATH), stat(env.DEM_ACCUMULATION_PATH)]); }
    catch { throw Object.assign(new Error('Rasters D8/acumulação indisponíveis.'), { status: 503 }); }
    const key = JSON.stringify([basin.properties.COBACIA, minArea, env.DEM_D8_PATH, env.DEM_ACCUMULATION_PATH, ...versions.map(v => [v.mtimeMs, v.size])]);
    const cached = microbasinCache.get(key);
    if (cached && Date.now()-cached.createdAt < 15*60*1000) {
      microbasinCache.delete(key); microbasinCache.set(key,cached);
      return { value: cached.value, cache: 'HIT' };
    }
    if (cached) { microbasinCache.delete(key); cacheBytes -= cached.bytes; }
    const value = await run('microbasins.py', [env.DEM_D8_PATH,env.DEM_ACCUMULATION_PATH], { basin, min_drainage_area_km2:minArea });
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes <= 16*1024*1024) {
      while (microbasinCache.size && (microbasinCache.size>=8 || cacheBytes+bytes>16*1024*1024)) {
        const oldest = microbasinCache.keys().next().value;
        cacheBytes -= microbasinCache.get(oldest).bytes; microbasinCache.delete(oldest);
      }
      microbasinCache.set(key,{value,bytes,createdAt:Date.now()});cacheBytes += bytes;
    }
    return {value,cache:'MISS'};
  };
  return delineate;
}

module.exports = { createDelineator };
