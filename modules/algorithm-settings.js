(function(root){
  'use strict';const DG=root.DG=root.DG||{},KEY='dynamic-gates-algorithm-settings-v1';
  const DEFAULTS=Object.freeze({includeStageToGate:false,defaultLoadingMinutes:60,gateBufferMinutes:120,stageWindowMode:'CONFIRMED_RELEASE',stagingBeforeMinutes:0,stagingAfterMinutes:0,allowedChambers:null,allowedGateIds:null,solveMode:'STANDARD',planningRules:{referenceAssignments:{},resourceRules:{},joinGroups:[],controlRules:[]}});
  const PROFILES=Object.freeze({FAST:{maxExactLoads:12,maxSearchNodes:3000},STANDARD:{maxExactLoads:32,maxSearchNodes:25000},THOROUGH:{maxExactLoads:48,maxSearchNodes:100000}});
  function normalize(value={}){
    if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Nieprawidłowe ustawienia algorytmu.');const v={...DEFAULTS,...value};
    if(typeof v.includeStageToGate!=='boolean'||!['IMPORTED','ETA','CONFIRMED_RELEASE'].includes(v.stageWindowMode)||!['FAST','STANDARD','THOROUGH'].includes(v.solveMode))throw Error('Nieprawidłowy tryb algorytmu.');
    const rules=DG.PlanningRules||(typeof require==='function'?require('./planning-rules.js'):null);v.planningRules=rules.normalize(v.planningRules);
    for(const [key,min,max]of [['defaultLoadingMinutes',1,10080],['gateBufferMinutes',0,1000000],['stagingBeforeMinutes',0,1440],['stagingAfterMinutes',0,1440]])if(!Number.isInteger(v[key])||v[key]<min||v[key]>max)throw Error('Nieprawidłowa wartość: '+key+' ('+min+'–'+max+' min).');
    v.includeStageToGate=false;v.stageWindowMode='CONFIRMED_RELEASE';v.stagingBeforeMinutes=0;v.stagingAfterMinutes=0;
    for(const key of ['allowedChambers','allowedGateIds']){if(v[key]!==null){if(!Array.isArray(v[key])||v[key].length>1000||v[key].some(id=>typeof id!=='string'||!id.trim()||id.length>80))throw Error('Nieprawidłowa lista dozwolonych miejsc załadunku.');v[key]=[...new Set(v[key].map(id=>id.trim()))].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));}}
    return Object.fromEntries(Object.keys(DEFAULTS).map(k=>[k,v[k]]));
  }
  function validateDomain(values,domain){const v=normalize(values);for(const id of v.allowedGateIds||[])if(!domain.gates[id])throw Error('Nieznana rampa w ustawieniach: '+id);const chambers=new Set(Object.values(domain.gates).map(g=>String(g.physicalChamber)));for(const id of v.allowedChambers||[])if(!chambers.has(id))throw Error('Nieznana komora załadunku: K'+id);return v;}
  function allowed(gate,values){return !!gate&&(values.allowedGateIds==null||values.allowedGateIds.includes(gate.gateId))&&(values.allowedChambers==null||values.allowedChambers.includes(String(gate.physicalChamber)));}
  function optimizerOptions(values){const v=normalize(values);return {...v,...PROFILES[v.solveMode]};}
  class Store{
    constructor(storage){this.storage=storage;}
    read(){const raw=this.storage?.getItem(KEY);if(!raw)return {version:1,revision:0,values:normalize()};const value=JSON.parse(raw);if(![1,2].includes(value.version)||!Number.isSafeInteger(value.revision)||value.revision<0)throw Error('Nieprawidłowy zapis ustawień algorytmu.');return {...value,values:normalize(value.values)};}
    write(values,expectedRevision){const original=this.storage?.getItem(KEY)??null,latest=this.read();if(latest.revision!==expectedRevision)throw Error('Ustawienia zmieniły się w innym oknie. Wczytaj je i wykonaj nową próbę.');const normalized=normalize(values),next={version:latest.version===2||normalized.planningRules.printerRules?.length?2:1,revision:latest.revision+1,values:normalized,updatedAt:new Date().toISOString()};if(!this.storage)throw Error('Brak zapisu lokalnego.');const raw=JSON.stringify(next);if(this.storage.compareAndSet){if(!this.storage.compareAndSet(KEY,original,raw))throw Error('Ustawienia zmieniły się w innym oknie. Wczytaj je i wykonaj nową próbę.');}else{if((this.storage.getItem(KEY)??null)!==original)throw Error('Ustawienia zmieniły się w innym oknie. Wczytaj je i wykonaj nową próbę.');this.storage.setItem(KEY,raw);}root.dispatchEvent?.(new Event('dynamic-gates-algorithm-settings-change'));return next;}
  }
  function run(values,input){
    const v=validateDomain(values,input.engine.model),context=DG.GateSchedule.optimizerContext(input.engine.model,input.snapshot,input.schedule,input.now,v);
    const data={...(input.data||{}),engine:input.engine,assignments:input.snapshot.assignments||{}};
    return DG.optimize(context.loads,data,context.gateStates,input.snapshot.decisions||{},{...optimizerOptions(v),reservations:context.reservations,proposalPins:input.snapshot.proposalPins||{}});
  }
  function compare(applied,draft,input){
    const now=input.now??Date.now(),snapshot=structuredClone(input.snapshot),schedule=structuredClone(input.schedule),shared={...input,now,snapshot,schedule};
    const baseline=run(applied,shared),candidate=run(draft,shared),valid=r=>!!r&&!!r.recommendedShipdock&&r.feasible&&r.optimizedCost!=null;
    const oldRows=new Map(baseline.rows.map(r=>[r.load.load_id,r])),newRows=new Map(candidate.rows.map(r=>[r.load.load_id,r]));
    const common=baseline.rows.filter(r=>valid(r)&&valid(newRows.get(r.load.load_id))).map(r=>r.load.load_id);
    function metrics(result){
      const handled=result.rows.filter(valid),gates=new Map(),counted=new Set(result.rows.filter(r=>r.fixed&&r.recommendedShipdock).map(r=>r.load.load_id));
      function add(id,minutes,conflict=false){if(!id)return;const item=gates.get(id)||{gateId:id,loads:0,loadingMinutes:0,unknownWindows:0,conflicts:0};item.loads++;if(Number.isFinite(minutes))item.loadingMinutes+=minutes;else item.unknownWindows++;if(conflict)item.conflicts++;gates.set(id,item);}
      for(const r of result.rows){if(!r.gate)continue;const w=DG.ShipDockOptimizer.interval(r.load,'loading'),end=r.load.gateReservationEnd??w.end;add(r.gate,!r.load.actualStartedAt&&Number.isFinite(w.start)&&Number.isFinite(end)?end-w.start:null,!valid(r));}
      const policy=result===baseline?normalize(applied):normalize(draft);
      const traffic=DG.GateSchedule.entries(input.engine.model,snapshot,schedule,policy).entries;
      for(const r of result.rows.filter(r=>!r.fixed&&valid(r))){const original=snapshot.loads.find(l=>l.load_id===r.load.load_id),w=DG.GateSchedule.loadWindow(original,policy);if(w)traffic.push({...w,activity:DG.ShipDockDomain.activity(r.load),id:'PROPOSED:'+r.load.load_id,physicalGateId:r.gate,truckLabel:r.load.load_id});}
      const timing=DG.GateSchedule.timingConflicts(input.engine.model,snapshot,traffic,policy);
      // Use the live scheduler projection: inbound has no outbound buffer,
      // delay consumes its original buffer, and actual service has no known end.
      for(const a of traffic.filter(a=>(['MANUAL','REQUEST'].includes(a.source)||a.actual||DG.ShipDockDomain.activity(a)==='INBOUND')&&![a.loadId,...(a.loadIds||[])].some(id=>counted.has(id))&&(a.actual||a.reservationEnd>now)))add(a.physicalGateId,a.actual?null:(a.reservationEnd-a.start)/DG.GateSchedule.MINUTE);
      const rows=new Map(result.rows.map(r=>[r.load.load_id,r]));
      const commonCost=common.length?common.reduce((sum,id)=>{const r=rows.get(id);return sum+r.optimizedCost;},0):null;
      return {handled:handled.length,conflicts:result.rows.filter(r=>r.recommendedShipdock&&!valid(r)).length,timingConflicts:timing.count,unassigned:result.rows.filter(r=>!r.recommendedShipdock).length,warnings:result.rows.filter(r=>r.warnings.length).length,commonCost,commonCount:common.length,gates:[...gates.values()].map(g=>({...g,conflicts:Math.max(g.conflicts,timing.byGate.get(g.gateId)||0)})),optimal:result.optimal};
    }
    const changes=candidate.rows.map(r=>({loadId:r.load.load_id,fixed:r.fixed,before:oldRows.get(r.load.load_id),after:r}));
    if(changes.some(c=>c.fixed&&c.before?.recommendedShipdock!==c.after.recommendedShipdock))throw Error('Próba zmieniła istniejące przypisanie.');
    return {baseline,candidate,before:metrics(baseline),after:metrics(candidate),changes,values:normalize(draft),now};
  }
  const api={KEY,DEFAULTS,PROFILES,normalize,validateDomain,allowed,optimizerOptions,Store,run,compare};DG.AlgorithmSettings=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
