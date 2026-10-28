'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const turf = require('@turf/turf');
const { summarize, parseQuantity, calculateCommitment, createWaterBalanceService, SECONDS_PER_YEAR } = require('../services/water-balance');
const basin = turf.polygon([[[0,0],[5,0],[5,5],[0,5],[0,0]], [[1,1],[2,1],[2,2],[1,2],[1,1]]]);
function record(id, props={}, xy=[3,3]) {
  return { ...turf.point(xy), id, properties: { tipo_uso:'Captação Superficial', STATUS_POR:'Não Vencida', VOLUME_ANU:'31536000', 'Vazão_ins':'2,5', ...props } };
}
const collection = (features, total) => new Response(JSON.stringify({type:'FeatureCollection',features,numberMatched:total}),{status:200});

test('parses source decimal quantities without treating missing or invalid amounts as zero',()=>{
  assert.equal(parseQuantity('1.234,56'),1234.56);
  assert.equal(parseQuantity('0,000277778'),0.000277778);
  assert.equal(parseQuantity('1234.56'),1234.56);
  assert.equal(parseQuantity('0'),0);
  for(const value of [null,undefined,'',' ','abc','1,2,3','-2',-1,Infinity])assert.equal(parseQuantity(value),null);
});
test('selects exact geometry including boundary but excluding holes, and separates statuses and groundwater',()=>{
  const features=[record('a'),record('b',{STATUS_POR:'Dispensado',tipo_uso:'Lançamento'}),
    record('c',{tipo_uso:'Captação Subterrânea'}),record('d',{STATUS_POR:'Vencida'}),record('e',{},[1.5,1.5]),record('f',{},[6,6]),
    record('g',{STATUS_POR:'nao vencida'},[0,3]),record('h',{STATUS_POR:'Cadastro DNPM deferido'}),
    record('i',{tipo_uso:'Interferências',TIPO_USO_E:'Travessia Aérea'})];
  const original=JSON.stringify(features),result=summarize(features,basin,{});
  assert.equal(JSON.stringify(features),original);
  assert.equal(result.counts.in_polygon,7);assert.equal(result.counts.outside_polygon,2);
  assert.equal(result.counts.excluded_status,2);
  assert.equal(result.groups.surface_withdrawal.count,2);
  assert.equal(result.groups.surface_withdrawal.annual_equivalent_m3s,2);
  assert.equal(result.groups.surface_discharge.annual_equivalent_m3s,1);
  assert.equal(result.groups.groundwater_withdrawal.annual_equivalent_m3s,1);
  assert.equal(result.groups.other.count,1);
  assert.equal(result.groups.surface_withdrawal.instantaneous_m3s,5);
  assert.equal(result.seconds_per_year,SECONDS_PER_YEAR);
});
test('missing annual amounts remain missing even with valid instantaneous flow; reports partial accounting',()=>{
  const result=summarize([record('a',{VOLUME_ANU:null})],basin,{});
  assert.equal(result.accounting_complete,false);
  assert.equal(result.groups.surface_withdrawal.annual_volume_m3,null);
  assert.equal(result.groups.surface_withdrawal.annual_equivalent_m3s,null);
  assert.equal(result.groups.surface_withdrawal.instantaneous_m3s,2.5);
  assert.equal(result.groups.surface_withdrawal.annual_missing_count,1);
  const partial=summarize([record('a'),record('b',{VOLUME_ANU:''})],basin,{});
  assert.equal(partial.groups.surface_withdrawal.annual_equivalent_m3s,1);
  assert.equal(partial.accounting_complete,false);
});
test('unknown or invalid locations cannot produce a complete accounting',()=>{
  const result=summarize([{id:'a',geometry:null}],basin,{});
  assert.equal(result.accounting_complete,false);assert.equal(result.counts.invalid_geometry,1);
});
test('WFS pages are verified, short pages are not mistaken for the last page, and successful results are cached',async()=>{
  const urls=[];const features=[record('1'),record('2'),record('3')];
  const service=createWaterBalanceService({pageSize:2,fetchImpl:async url=>{
    urls.push(new URL(url));const start=Number(new URL(url).searchParams.get('startIndex'));
    return collection(features.slice(start,start+1),3);
  }});
  const result=await service(basin);
  assert.equal(result.value.counts.in_polygon,3);assert.equal(urls.length,3);
  assert.deepEqual(urls.map(u=>u.searchParams.get('startIndex')),['0','1','2']);
  assert.equal(urls[0].searchParams.get('srsName'),'CRS:84');
  assert.ok(urls[0].searchParams.get('CQL_FILTER').startsWith('BBOX(the_geom,'));
  assert.ok(!urls[0].searchParams.get('CQL_FILTER').includes('data_publicacao'));
  assert.equal((await service(basin)).cache,'HIT');assert.equal(urls.length,3);
});
test('does not silently accept duplicate pages, changed counts, truncation, missing counts or OGC error responses',async()=>{
  const scenarios=[
    [collection([record('1')],2),collection([record('1')],2)],
    [collection([record('1')],2),collection([record('2')],3)],
    [collection([record('1')],2),collection([],2)],
    [collection([],undefined)],
    [new Response('<ExceptionReport/>',{status:200})],
    [collection([],10001)],
    [new Response('Unavailable',{status:503})],
    [new Response(JSON.stringify({type:'FeatureCollection',features:[],numberMatched:0,numberReturned:2}))]
  ];
  for(const responses of scenarios) {
    const service=createWaterBalanceService({fetchImpl:async()=>responses.shift()});
    await assert.rejects(service(basin),error=>error.status===502);
  }
});
test('aborts a stalled WFS request and does not cache failure',async()=>{
  let calls=0;const service=createWaterBalanceService({timeoutMs:10,fetchImpl:async(_url,{signal})=>{
    calls++;if(calls===2)return collection([],0);
    return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));
  }});
  await assert.rejects(service(basin),error=>error.status===502);
  assert.equal((await service(basin)).cache,'MISS');assert.equal(calls,2);
});


test('empty selections are complete with zero counts, and numeric overflow is rejected',async()=>{
  const service=createWaterBalanceService({fetchImpl:async()=>collection([],0)});
  const result=(await service(basin)).value;
  assert.equal(result.counts.in_polygon,0);assert.equal(result.accounting_complete,true);
  assert.equal(result.groups.surface_withdrawal.annual_volume_m3,0);
  assert.throws(()=>summarize([record('1',{VOLUME_ANU:Number.MAX_VALUE}),record('2',{VOLUME_ANU:Number.MAX_VALUE})],basin,{}));
});


test('instantaneous commitment uses surface withdrawals minus releases, excludes groundwater, and preserves values above 100 percent',()=>{
  const snapshot=summarize([record('a',{Vazão_ins:'10',VOLUME_ANU:null}),record('b',{tipo_uso:'Lançamento',Vazão_ins:'4'}),record('c',{tipo_uso:'Captação Subterrânea',Vazão_ins:'1000'})],basin,{});
  const before=JSON.stringify(snapshot);
  const result=calculateCommitment(snapshot,{avg_discharge:20,q95:4,q710:2});
  assert.equal(result.net_withdrawal_m3s,6);assert.equal(result.withdrawals_m3s,10);assert.equal(result.discharges_m3s,4);
  assert.equal(result.references.avg_discharge.percent,30);assert.equal(result.references.q95.percent,150);assert.equal(result.references.q710.percent,300);
  assert.equal(result.complete,true);assert.equal(snapshot.accounting_complete,false,'Missing annual volume does not make instantaneous commitment incomplete');
  assert.equal(JSON.stringify(snapshot),before,'Do not mutate the cached source');
});
test('negative and zero commitment are not clamped',()=>{
  const snapshot=summarize([record('a',{Vazão_ins:'2'}),record('b',{tipo_uso:'Lançamento',Vazão_ins:'5'})],basin,{});
  assert.equal(calculateCommitment(snapshot,{avg_discharge:1,q95:2,q710:3}).references.avg_discharge.percent,-300);
  const empty=calculateCommitment(summarize([],basin,{}),{avg_discharge:1,q95:2,q710:3});
  assert.equal(empty.references.avg_discharge.percent,0);assert.equal(empty.complete,true);
});
test('missing surface instantaneous data yields partial known percentages or an unavailable result, never annual substitutions',()=>{
  const snapshot=summarize([record('a',{Vazão_ins:'2'}),record('b',{Vazão_ins:''})],basin,{});
  const result=calculateCommitment(snapshot,{avg_discharge:4,q95:2,q710:1});
  assert.equal(result.references.avg_discharge.percent,50);assert.equal(result.references.avg_discharge.status,'partial');
  assert.equal(result.complete,false);assert.equal(result.missing_instantaneous_count,1);
  const missing=summarize([record('a',{Vazão_ins:null})],basin,{});
  const unavailable=calculateCommitment(missing,{avg_discharge:4,q95:2,q710:1});
  assert.equal(unavailable.net_withdrawal_m3s,null);assert.equal(unavailable.references.q95.percent,null);
  assert.equal(unavailable.references.q95.reason,'missing_instantaneous_flow');
});
test('invalid geometry marks instantaneous commitment partial, but missing groundwater flow does not affect surface completeness',()=>{
  const snapshot=summarize([record('a',{Vazão_ins:'2'}),{id:'bad',geometry:null}],basin,{});
  assert.equal(calculateCommitment(snapshot,{avg_discharge:4,q95:2,q710:1}).references.q95.status,'partial');
  const surface=summarize([record('a',{Vazão_ins:'2'}),record('b',{tipo_uso:'Captação Subterrânea',Vazão_ins:null})],basin,{});
  assert.equal(calculateCommitment(surface,{avg_discharge:4,q95:2,q710:1}).complete,true);
});
test('nonpositive or missing natural flow and numeric overflow do not produce infinite or misleading percentages',()=>{
  const snapshot=summarize([record('a',{Vazão_ins:'2'})],basin,{});
  const result=calculateCommitment(snapshot,{avg_discharge:0,q95:-1,q710:NaN});
  assert.equal(result.complete,false);
  for(const value of Object.values(result.references)) {assert.equal(value.percent,null);assert.equal(value.reason,'invalid_natural_reference');}
  const overflow=calculateCommitment(snapshot,{avg_discharge:Number.MIN_VALUE,q95:1,q710:2});
  assert.equal(overflow.references.avg_discharge.percent,null);assert.equal(overflow.references.avg_discharge.reason,'numeric_overflow');
});
