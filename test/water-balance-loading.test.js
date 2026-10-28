'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const turf = require('@turf/turf');
const { createWaterBalanceLoading, cellBounds } = require('../services/water-balance-loading');
const { createLoader, createTransport, retryAfterMs } = require('../public/javascripts/water-balance-loader');
const geometry = turf.bboxPolygon([-46.67,-23.6,-46.652,-23.58]);
const reference = { avg_discharge: 4, q95: 2, q710: 1 };
const feature = (id = 'a', xy = [-46.66,-23.59]) => ({...turf.point(xy),id,
  properties:{STATUS_POR:'Dispensado',tipo_uso:'Captação Superficial',VOLUME_ANU:31536000,Vazão_ins:2}});
const response = (features, total = features.length) => new Response(JSON.stringify({type:'FeatureCollection',features,numberMatched:total,numberReturned:features.length}));

async function collect(service, plan, cells = plan.data.cells, extra = {}) {
  const receipts = []; let start = 0, previous;
  do {
    const result = await service.page({geometry,plan,cells,start_index:start,previous,...extra});
    previous = result.receipt; receipts.push(previous); start = previous.data.next_index;
  } while (!previous.data.complete);
  return receipts;
}
test('stages have independent time budgets, signed receipts and exact final accounting across replicas', async () => {
  const options = {secret:'test-secret',timeoutMs:200,fetchImpl:async () => {await new Promise(resolve=>setTimeout(resolve,15));return response([feature()]);}};
  const first=createWaterBalanceLoading(options), second=createWaterBalanceLoading(options);
  const {plan}=first.start(geometry,reference,'drawn-geometry');
  assert.ok(plan.data.cells.length>1);assert.ok(plan.data.cell_area_km2<=1.01);
  const receipts=[];
  for(const cell of plan.data.cells)receipts.push(...await collect(first,plan,[cell]));
  // Same FID on spatial boundaries is counted once, rather than once per sector.
  const result=second.complete(geometry,{plan,receipts});
  assert.equal(result.counts.in_polygon,1);assert.equal(result.groups.surface_withdrawal.instantaneous_m3s,2);
  assert.equal(result.commitment.references.q95.percent,100);
  assert.equal(result.source.duplicate_boundary_records,plan.data.cells.length-1);
  const cached=second.start(geometry,{...reference,q95:4},'calculated-geometry');
  assert.equal(cached.cache,'HIT');assert.equal(cached.result.commitment.references.q95.percent,50);
});
test('cannot finalize missing, duplicated, altered or foreign stages, or another geometry', async () => {
  const service=createWaterBalanceLoading({secret:'test-secret',fetchImpl:async()=>response([feature()])});
  const {plan}=service.start(geometry,reference,'drawn-geometry');
  const receipts=await collect(service,plan);
  assert.throws(()=>service.complete(geometry,{plan,receipts:[]}),/pendentes/);
  assert.throws(()=>service.complete(geometry,{plan,receipts:[...receipts,...receipts]}),/repetida/);
  const empty=createWaterBalanceLoading({fetchImpl:async()=>response([])}), emptyPlan=empty.start(geometry,reference,'drawn-geometry').plan;
  const emptyReceipts=await collect(empty,emptyPlan);
  assert.throws(()=>empty.complete(geometry,{plan:emptyPlan,receipts:[...emptyReceipts,...emptyReceipts]}),/repetida/);
  const changed=structuredClone(receipts);changed[0].data.features[0].properties.Vazão_ins=99;
  assert.throws(()=>service.complete(geometry,{plan,receipts:changed}),/inválido/);
  const foreign=service.start(geometry,reference,'drawn-geometry').plan;
  assert.throws(()=>service.complete(geometry,{plan:foreign,receipts}),/outra consulta/);
  assert.throws(()=>service.complete(turf.bboxPolygon([-46.68,-23.6,-46.65,-23.58]),{plan,receipts}),/geometria/);
  const forged=structuredClone(plan);forged.data.cells=[];
  await assert.rejects(service.page({geometry,plan:forged,cells:[0]}),/inválido/);
});
test('verifies short WFS pages, changed counts, repeated FIDs and conflicting boundary values', async () => {
  let call=0;
  const service=createWaterBalanceLoading({pageSize:2,fetchImpl:async()=>response([feature(String(++call))],3)});
  const {plan}=service.start(geometry,reference,'drawn-geometry');
  const receipts=await collect(service,plan);
  assert.deepEqual(receipts.map(r=>r.data.start_index),[0,1,2]);
  assert.equal(service.complete(geometry,{plan,receipts}).counts.in_polygon,3);
  const repeated=createWaterBalanceLoading({pageSize:1,fetchImpl:async()=>response([feature()],2)});
  const other=repeated.start(geometry,reference,'drawn-geometry').plan;
  const duplicate=await collect(repeated,other);
  assert.throws(()=>repeated.complete(geometry,{plan:other,receipts:duplicate}),/repetiu/);
  let count=1;
  const changing=createWaterBalanceLoading({pageSize:1,fetchImpl:async()=>response([feature()],++count)});
  const changePlan=changing.start(geometry,reference,'drawn-geometry').plan;
  await assert.rejects(collect(changing,changePlan),/mudou/);
  let instant=1;
  const conflict=createWaterBalanceLoading({fetchImpl:async()=>{const f=feature();f.properties.Vazão_ins=instant++;return response([f]);}});
  const conflictPlan=conflict.start(geometry,reference,'drawn-geometry').plan;
  const conflicts=[];
  for(const cell of conflictPlan.data.cells)conflicts.push(...await collect(conflict,conflictPlan,[cell]));
  assert.throws(()=>conflict.complete(geometry,{plan:conflictPlan,receipts:conflicts}),/fonte mudou/);
});
test('timeout, cancellation, expiration, holes and oversized or inconsistent responses are explicit', async () => {
  let now=0;
  const service=createWaterBalanceLoading({now:()=>now,timeoutMs:5,fetchImpl:async(_url,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}))});
  const {plan}=service.start(geometry,reference,'drawn-geometry');
  await assert.rejects(service.page({geometry,plan,cells:[plan.data.cells[0]]}),e=>e.status===502 && /Tempo/.test(e.message));
  now=31*60*1000;
  await assert.rejects(service.page({geometry,plan,cells:[plan.data.cells[0]]}),e=>e.status===410);
  const invalid=createWaterBalanceLoading({fetchImpl:async()=>response([],1)}), p=invalid.start(geometry,reference,'drawn-geometry').plan;
  await assert.rejects(invalid.page({geometry,plan:p,cells:[-1]}),e=>e.status===400);
  await assert.rejects(collect(invalid,p),e=>e.status===502);
  const holed=turf.polygon([geometry.geometry.coordinates[0],turf.bboxPolygon([-46.665,-23.595,-46.655,-23.585]).geometry.coordinates[0]]);
  const exact=createWaterBalanceLoading({fetchImpl:async()=>response([feature('hole'),feature('inside',[-46.668,-23.598])])});
  const hp=exact.start(holed,reference,'drawn-geometry').plan;
  const page=await exact.page({geometry:holed,plan:hp,cells:hp.data.cells.slice(0,8)});
  assert.deepEqual(page.preview.map(f=>f.id),['inside']);
  assert.ok(cellBounds(hp.data.grid,hp.data.cells[0]).every(Number.isFinite));
});
test('browser loader subdivides failing batches, retains completed stages and resumes without false totals', async () => {
  const cells=[0,1,2,3,4,5,6,7,8], events=[], requests=[];let failed=false, completed=0;
  const loader=createLoader({transportOptions:{pageIntervalMs:0,transientRetries:0},onProgress:p=>events.push(p),request:async(stage,body)=>{
    requests.push({stage,cells:body.cells});
    if(stage==='start')return {plan:{data:{cells,expires_at:Date.now()+60000}}};
    if(stage==='page') {
      if(body.cells.length>2)throw Object.assign(new Error('timeout'),{status:502});
      if(body.cells.includes(8)&&!failed){await new Promise(resolve=>setTimeout(resolve,5));failed=true;throw Object.assign(new Error('offline'),{status:503});}
      return {receipt:{data:{features:body.cells.map(id=>feature(String(id))),next_index:body.cells.length,complete:true}}};
    }
    completed++;assert.ok(body.receipts.length>=5);return {counts:{in_polygon:9}};
  }});
  await assert.rejects(loader.run(geometry,'drawn-geometry'),/offline/);
  assert.equal(completed,0);
  const before=requests.filter(r=>r.stage==='page' && r.cells.includes(0)).length;
  const result=await loader.run(geometry,'drawn-geometry');
  assert.equal(result.counts.in_polygon,9);assert.equal(completed,1);
  assert.equal(requests.filter(r=>r.stage==='page' && r.cells.includes(0)).length,before);
  assert.equal(requests.filter(r=>r.stage==='start').length,1);
  assert.equal(events.at(-1).percent,100);assert.ok(events.some(p=>p.phase==='subdividing'));
  assert.ok(events.filter(p=>p.phase!=='complete').every(p=>p.percent<100));
});
test('browser loader handles cancellation/reset and can retry a failed preparation', async () => {
  let starts=0,finalized=0;
  const loader=createLoader({transportOptions:{pageIntervalMs:0,transientRetries:0},request:async(stage,body,signal)=>{
    if(stage==='start'){if(++starts===1)throw new Error('offline');return {plan:{data:{cells:[0],expires_at:Date.now()+60000}}};}
    if(stage==='page')return new Promise((_resolve,reject)=>{signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true});if(signal.aborted)reject(new DOMException('aborted','AbortError'));});
    finalized++;
  }});
  await assert.rejects(loader.run(geometry,'drawn-geometry'),/offline/);
  const controller=new AbortController(), pending=loader.run(geometry,'drawn-geometry',controller.signal);
  setTimeout(()=>controller.abort(),10);
  await assert.rejects(pending,e=>e.name==='AbortError');assert.equal(starts,2);assert.equal(finalized,0);
  loader.reset();
});

const flush = () => new Promise(resolve => setImmediate(resolve));
test('Retry-After supports seconds and HTTP dates beyond one minute, with safe fallback for invalid values', () => {
  const now = Date.parse('2026-10-28T12:00:00Z');
  assert.equal(retryAfterMs('90',now),90000);
  assert.equal(retryAfterMs('Wed, 28 Oct 2026 12:01:30 GMT',now),90000);
  assert.equal(retryAfterMs('Wed, 28 Oct 2026 11:59:00 GMT',now),0);
  assert.equal(retryAfterMs('0',now),0);
  for(const value of [null,'','invalid','-1','0.5','9999999999999999999999999999'])assert.equal(retryAfterMs(value,now),null);
});
test('a shared cooldown blocks both workers until the longest Retry-After and resumes repeated 429 responses', async t => {
  t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.parse('2026-10-28T12:00:00Z')});
  const start=Date.now(), calls=[], countdown=[];
  const transport=createTransport({pageIntervalMs:0,onCooldown:event=>countdown.push(event.seconds),request:async(_stage,payload)=>{
    calls.push({time:Date.now()-start,id:payload.id});
    if(calls.length<=2)throw Object.assign(new Error('quota'),{status:429,retryAfter:payload.id===1?'2':new Date(start+4000).toUTCString()});
    if(calls.length===3)throw Object.assign(new Error('quota again'),{status:429,retryAfter:'2'});
    return payload.id;
  }});
  const pending=Promise.all([transport.send('page',{id:1}),transport.send('page',{id:2})]);
  await flush();assert.equal(calls.length,2);assert.ok(countdown.includes(4));
  t.mock.timers.tick(3999);await flush();assert.equal(calls.length,2);
  t.mock.timers.tick(1);await flush();assert.ok(calls.length>=3);
  const during=calls.length;t.mock.timers.tick(1999);await flush();assert.equal(calls.length,during);
  t.mock.timers.tick(1);await flush();assert.deepEqual(await pending,[1,2]);
  assert.ok(calls.slice(2).every(call=>call.time>=4000));assert.ok(countdown.includes(1));
});
test('pages are paced across workers and cooldown waits can be aborted without another request', async t => {
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000});
  const times=[],transport=createTransport({request:async()=>{times.push(Date.now());return true;}});
  const pending=Promise.all([1,2,3].map(id=>transport.send('page',{id})));
  await flush();assert.deepEqual(times,[1000]);
  t.mock.timers.tick(400);await flush();assert.deepEqual(times,[1000,1400]);
  t.mock.timers.tick(400);await flush();await pending;assert.deepEqual(times,[1000,1400,1800]);
  let calls=0;
  const limited=createTransport({request:async()=>{calls++;throw Object.assign(new Error('quota'),{status:429});}});
  const controller=new AbortController(), waiting=limited.send('page',{},controller.signal);
  const rejection=assert.rejects(waiting,e=>e.name==='AbortError');
  await flush();assert.equal(calls,1);assert.equal(limited.remainingMs(),60000);
  controller.abort();await rejection;t.mock.timers.tick(60000);await flush();assert.equal(calls,1);
});
test('loader preserves completed batches, progress and pages through cooldown and automatic retry', async t => {
  t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.parse('2026-10-28T12:00:00Z')});
  const calls=[],events=[];let limited=false, completions=0;
  const loader=createLoader({onProgress:event=>events.push(event),request:async(stage,body)=>{
    if(stage==='start')return {plan:{data:{cells:Array.from({length:24},(_,i)=>i),expires_at:Date.now()+60000}}};
    if(stage==='complete'){completions++;assert.equal(body.receipts.length,3);return {counts:{in_polygon:24}};}
    calls.push([...body.cells]);
    if(body.cells[0]===8&&!limited){limited=true;throw Object.assign(new Error('quota'),{status:429,retryAfter:'2'});}
    return {receipt:{data:{features:body.cells.map(id=>feature(String(id))),next_index:body.cells.length,complete:true}}};
  }});
  const pending=loader.run(geometry,'drawn-geometry');await flush();
  t.mock.timers.tick(400);await flush();
  assert.ok(events.some(e=>e.phase==='cooldown'&&e.completed===8&&e.loaded===8&&e.cooldownSeconds===2));
  t.mock.timers.tick(1999);await flush();assert.equal(calls.length,2);assert.equal(completions,0);
  t.mock.timers.tick(1);await flush();t.mock.timers.tick(400);await flush();await pending;
  assert.equal(calls.filter(cells=>cells[0]===0).length,1);
  assert.equal(calls.filter(cells=>cells[0]===8).length,2);
  assert.ok(calls.every(cells=>cells.length===8),'429 must not subdivide spatial batches');
  assert.equal(completions,1);assert.equal(events.at(-1).percent,100);
});
test('GeoServer rate limits propagate as 429 with Retry-After instead of triggering spatial subdivision', async () => {
  let calls=0;
  const service=createWaterBalanceLoading({fetchImpl:async()=>++calls===1?new Response('limited',{status:429,headers:{'Retry-After':'90'}}):response([])});
  const {plan}=service.start(geometry,reference,'drawn-geometry');
  await assert.rejects(service.page({geometry,plan,cells:plan.data.cells}),e=>e.status===429&&e.retryAfter==='90');
  const receipts=await collect(service,plan);
  assert.equal(service.complete(geometry,{plan,receipts}).counts.in_polygon,0);
});
