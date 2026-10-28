'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDelineator } = require('../services/dem-delineation');
const env = { DEM_D8_PATH: '/data/d8.tif', DEM_ACCUMULATION_PATH: '/data/accumulation.tif' };
const basin = { type: 'Feature', properties: { COBACIA: '1' }, geometry: {} };

test('MDE requires preprocessed data without falling back to the geometric cut', async () => {
  await assert.rejects(createDelineator({ env: {} })(basin, [0, 0]), { status: 503 });
});

test('MDE isolates worker input and enforces a bounded execution budget', async () => {
  let received;
  const execute = (python, args, options, callback) => {
    assert.equal(options.timeout, 8500);
    assert.deepEqual(args.slice(1), [env.DEM_D8_PATH, env.DEM_ACCUMULATION_PATH, '/data/elevation.tif']);
    return { stdin: { on() {}, end(input) {
      received = JSON.parse(input);
      callback(null, JSON.stringify({ method: 'dem_d8_esri' }));
    } } };
  };
  const result = await createDelineator({ env, execute })(basin, [-46, -23]);
  assert.equal(result.method, 'dem_d8_esri');
  assert.deepEqual(received.point, [-46, -23]);
  assert.equal(received.min_drainage_area_km2, 0.1);
  assert.equal('snap_distance_m' in received, false);
  assert.deepEqual(received.inflow_basins, []);
});

test('MDE rejects concurrent work and releases capacity after failure', async () => {
  let finish;
  const execute = (python, args, options, callback) => {
    finish = callback;
    return { stdin: { on() {}, end() {} } };
  };
  const delineate = createDelineator({ env, execute });
  const first = delineate(basin, [0, 0]);
  await assert.rejects(delineate(basin, [0, 0]), { status: 503 });
  finish(new Error('timeout'));
  await assert.rejects(first, { status: 503 });
  const next = delineate(basin, [0, 0]);
  finish(null, JSON.stringify({ error: 'NoData' }));
  await assert.rejects(next, { status: 422, message: 'NoData' });
});


test('topography-only rendering does not require D8, accumulation or a drainage threshold', async () => {
  const execute = (python, args, options, callback) => {
    assert.match(args[0], /topography\.py$/);
    assert.deepEqual(args.slice(1), ['/data/elevation.tif']);
    return { stdin: { on() {}, end(input) {
      assert.deepEqual(JSON.parse(input), { basin });
      callback(null, JSON.stringify({ topography: { image: 'png' }, topography_warning: null }));
    } } };
  };
  const render = createDelineator({ env: { DEM_ELEVATION_PATH: '/data/elevation.tif', DEM_MIN_DRAINAGE_AREA_KM2: 'invalid' }, execute });
  const result = await render.topography(basin);
  assert.equal(result.topography.image, 'png');
});

test('microbasin cache distinguishes thresholds and invalidates when rasters change', async () => {
  const fs = require('node:fs/promises');const os = require('node:os');const path = require('node:path');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'regflow-micro-cache-'));
  try {
    const flow = path.join(directory,'flow.tif'), accumulation = path.join(directory,'acc.tif');
    await fs.writeFile(flow,'a');await fs.writeFile(accumulation,'b');let calls=0;
    const execute = (python,args,options,callback) => ({stdin:{on(){},end(input){
      calls++;assert.match(args[0],/microbasins\.py$/);
      callback(null,JSON.stringify({type:'FeatureCollection',features:[],metadata:{threshold:JSON.parse(input).min_drainage_area_km2}}));
    }}});
    const worker = createDelineator({env:{DEM_D8_PATH:flow,DEM_ACCUMULATION_PATH:accumulation},execute});
    assert.equal((await worker.microbasins(basin,.1)).cache,'MISS');
    assert.equal((await worker.microbasins(basin,.1)).cache,'HIT');
    assert.equal((await worker.microbasins(basin,.2)).cache,'MISS');
    await fs.writeFile(flow,'changed');
    assert.equal((await worker.microbasins(basin,.1)).cache,'MISS');
    assert.equal(calls,3);
  } finally {await fs.rm(directory,{recursive:true,force:true});}
});
