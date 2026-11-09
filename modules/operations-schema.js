(function(root){
 'use strict';const DG=root.DG=root.DG||{},object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v),text=v=>typeof v==='string'&&v.trim().length>0;
 function validate(value){
  const fail=path=>{throw Error('Nieprawidłowy zapis Operations: '+path);},date=v=>typeof v==='string'&&Number.isFinite(Date.parse(v));
  if(!object(value)||value.version!=null&&![1,2,3,4,5].includes(value.version)||!Array.isArray(value.loads)||value.loads.length>100000)fail('wersja lub lista zamówień');
  if(value.loads.some(l=>l?.consignmentCycle)&&![3,4,5].includes(value.version))fail('kolejne wysyłki wymagają wersji zapisu 3 lub nowszej');
  if(value.loads.some(l=>l?.workloadSource==='MTM'&&l.mtm?.storeIdentity)&&![4,5].includes(value.version))fail('potwierdzenie sklepu MTM wymaga wersji zapisu 4 lub5');
  if(value.loads.some(l=>l?.ls?.routingPolicyVersion===1||l?.workloadSource==='MTM'&&Array.isArray(l.tasks)&&l.tasks.some(t=>t&&Object.hasOwn(t,'wms_priority')))&&value.version!==5)fail('reguły WMS Priority wymagają wersji zapisu 5');
  const ids=new Set();for(const load of value.loads){
   if(!object(load)||!text(load.load_id)||load.load_id.length>200||ids.has(load.load_id))fail('ID zamówienia');ids.add(load.load_id);
   if(load.store!=null&&typeof load.store!=='string'||load.tasks!=null&&(!Array.isArray(load.tasks)||load.tasks.length>100000))fail(load.load_id+' / sklep lub picki');
   if(load.workloadSource==='LAST_PICK_POC'){const L=DG.LastPickImport||(typeof require==='function'?require('./last-pick-import.js'):null);if(!L)fail('brak walidatora Last Pick');L.validateLoad(load);}
   if(load.workloadSource==='LS'){const L=DG.LSImport||(typeof require==='function'?require('./ls-import.js'):null);if(!L)fail('brak walidatora LS');L.validateLoad(load);}
   if(load.workloadSource==='MTM'){const M=DG.MTMImport||(typeof require==='function'?require('./mtm-import.js'):null);if(!M)fail('brak walidatora MTM');M.validateStoreIdentity(load);}
   for(const task of load.tasks||[]){if(!object(task)||!text(task.source_location)&&!text(task.destination_location)||!Number.isFinite(task.quantity)||task.quantity<0)fail(load.load_id+' / pick');if(task.required_waypoints!=null&&(!Array.isArray(task.required_waypoints)||task.required_waypoints.some(id=>!text(id))))fail(load.load_id+' / punkty trasy');}
  }
  for(const field of ['decisions','assignments','assignmentBindings','proposalPins','gateStates','vehicleStates'])if(value[field]!=null&&!object(value[field]))fail(field);
  const released=id=>date(value.decisions?.[id]?.stageReleasedAt);
  for(const [id,d]of Object.entries(value.decisions||{})){if(!object(d)||!ids.has(id)&&!released(id))fail('decyzja / '+id);for(const key of ['accepted','overridden','locked'])if(d[key]!=null&&typeof d[key]!=='boolean')fail('decyzja / '+id+' / '+key);if(d.chosen_shipdock!=null&&typeof d.chosen_shipdock!=='string')fail('decyzja / '+id+' / Stage');}
  for(const [id,stage]of Object.entries(value.assignments||{}))if(!text(stage)||!ids.has(id)&&!released(id))fail('przydział / '+id);
  for(const [id,b]of Object.entries(value.assignmentBindings||{}))if(!object(b)||!text(b.shipDockId)||!text(b.physicalGateId)||!ids.has(id)&&!released(id))fail('powiązanie Stage/Gate / '+id);
  for(const [id,pin]of Object.entries(value.proposalPins||{}))if(!ids.has(id)||!object(pin)||!text(pin.shipDockId))fail('przypięcie / '+id);
  for(const [id,state]of Object.entries(value.gateStates||{}))if(!text(id)||!object(state))fail('stan rampy / '+id);
  for(const [id,state]of Object.entries(value.vehicleStates||{})){if(!object(state)||!text(state.physicalGateId)||!['INBOUND','OUTBOUND'].includes(state.activity)||!Array.isArray(state.loadIds)||state.loadIds.some(id=>!text(id)))fail('stan auta / '+id);for(const field of ['startedAt','completedAt','cancelledAt'])if(state[field]!=null&&!date(state[field]))fail('stan auta / '+id+' / '+field);}
  if(value.vehicleEvents!=null&&(!Array.isArray(value.vehicleEvents)||value.vehicleEvents.length>100000))fail('zdarzenia aut');
  for(const event of value.vehicleEvents||[])if(!object(event)||!text(event.id)||!['START','COMPLETE','CANCEL'].includes(event.type)||!date(event.at))fail('zdarzenie auta');
  for(const [field,globalName,file]of [['metricsHistory','MetricsHistory','metrics-history'],['queueHistory','ControlQueue','control-queue']])if(value[field]!=null){const validator=DG[globalName]||(typeof require==='function'?require('./'+file+'.js'):null);if(!validator)fail(field+' / brak walidatora');validator.validate(value[field]);}
  (DG.ShipmentCycles||(typeof require==='function'?require('./shipment-cycles.js'):null)).validate(value);
  return value;
 }
 // Normal writes preserve accepted physical identity. Full backup restore is a
 // separate, explicit recovery operation and does not use this transition.
 function validateTransition(previous,next){
  validate(next);if(previous!=null)validate(previous);
  if((previous?.version===5||next.loads.some(l=>['LS','MTM'].includes(l.workloadSource)))&&next.version!==5)throw Error('Reguły WMS Priority wymagają wersji zapisu 5; zwykły zapis nie może jej obniżyć.');
  const M=DG.MTMImport||(typeof require==='function'?require('./mtm-import.js'):null),priorById=new Map((previous?.loads||[]).map(l=>[l.load_id,l])),keyM=v=>String(v??'').trim().toUpperCase(),claim=(s,l)=>keyM(s?.assignments?.[l.load_id]||l.existingShipDockId||l.current_shipdock||((s?.decisions?.[l.load_id]?.accepted||s?.decisions?.[l.load_id]?.locked||s?.decisions?.[l.load_id]?.overridden)&&s.decisions[l.load_id].chosen_shipdock)||'');
  for(const load of next.loads){const prior=priorById.get(load.load_id);if(prior?.workloadSource==='MTM'&&M.storeConfirmed(prior)&&(!M.storeConfirmed(load)||keyM(load.store)!==keyM(prior.store)||JSON.stringify(load.mtm.storeIdentity)!==JSON.stringify(prior.mtm.storeIdentity)))throw Error('MTM: potwierdzony sklep jest niezmienny: '+load.load_id);if(load.workloadSource==='MTM'&&claim(next,load)&&! (prior&&claim(previous,prior))&&(!M.storeReady(load)||!next.decisions?.[load.load_id]?.accepted||keyM(next.decisions[load.load_id].chosen_shipdock)!==claim(next,load)))throw Error('MTM: nowy Stage/Gate wymaga potwierdzonego sklepu i zatwierdzenia propozycji: '+load.load_id);}
  if(previous==null)return next;
  (DG.ShipmentCycles||(typeof require==='function'?require('./shipment-cycles.js'):null)).validateTransition(previous,next);
  const key=v=>String(v??'').trim().toUpperCase(),fail=id=>{throw Error('Zatwierdzony Stage/Gate jest niezmienny (assignment cannot change): '+id);};
  const beforeLoads=new Map(previous.loads.map(l=>[l.load_id,l])),afterLoads=new Map(next.loads.map(l=>[l.load_id,l]));
  const fixed=new Map();
  for(const [id,alias]of Object.entries(previous.assignments||{}))fixed.set(id,key(alias));
  for(const load of previous.loads){const id=load.load_id,d=previous.decisions?.[id];for(const alias of [load.existingShipDockId,load.current_shipdock,...(d?.accepted||d?.overridden||d?.locked?[d.chosen_shipdock]:[])])if(key(alias)){if(fixed.has(id)&&fixed.get(id)!==key(alias))fail(id);fixed.set(id,key(alias));}}
  for(const [id,binding]of Object.entries(previous.assignmentBindings||{})){if(fixed.has(id)&&fixed.get(id)!==key(binding.shipDockId))fail(id);fixed.set(id,key(binding.shipDockId));}
  for(const [id,alias]of fixed){
   const load=afterLoads.get(id),oldDecision=previous.decisions?.[id]||{},decision=next.decisions?.[id]||{},binding=previous.assignmentBindings?.[id],afterBinding=next.assignmentBindings?.[id];
   const prior=beforeLoads.get(id);if(prior?.workloadSource==='LS'&&load){
    const signature=l=>{const LS=DG.LSImport||(typeof require==='function'?require('./ls-import.js'):null),p=LS.controlPolicies(l);return JSON.stringify([l.workloadSource,l.ls?.shipmentDay,l.mtm?.quantityConfirmed,l.tasks.map(t=>[t.list_id,t.source_location,t.source_location_candidates,t.quantity,t.controlRequired,t.required_waypoints,p.get(t.list_id)?.exempt]).sort((a,b)=>a[0].localeCompare(b[0]))]);};
    if(signature(prior)!==signature(load))throw Error('Last picki zatwierdzonej grupy LS są niezmienne: '+id);
   }
   if(load&&beforeLoads.has(id)&&key(load.store)!==key(beforeLoads.get(id).store))throw Error('Sklep zatwierdzonego consignmentu jest niezmienny: '+id);
   const claims=[next.assignments?.[id],load?.existingShipDockId,load?.current_shipdock,decision.chosen_shipdock,afterBinding?.shipDockId].filter(v=>key(v));
   if(!claims.length||claims.some(v=>key(v)!==alias))fail(id);
   if(previous.assignments?.[id]&&key(next.assignments?.[id])!==alias)fail(id);
   if(binding&&(!afterBinding||key(afterBinding.shipDockId)!==key(binding.shipDockId)||key(afterBinding.physicalGateId)!==key(binding.physicalGateId)||(afterBinding.temporaryObjectId??null)!==(binding.temporaryObjectId??null)))fail(id);
   if(beforeLoads.has(id)&&!load&&!Number.isFinite(Date.parse(decision.stageReleasedAt)))fail(id);
   for(const field of ['stageReleasedAt','completedAt','cancelledAt']){if(oldDecision[field]&&decision[field]!==oldDecision[field])fail(id);if(decision[field]!=null&&(typeof decision[field]!=='string'||!Number.isFinite(Date.parse(decision[field]))))fail(id);}
   const numeric=/^([0-9]+)[A-Z]*$/.exec(alias),expectedGate=binding?.physicalGateId??(numeric?String(Number(numeric[1])):null);
   if(expectedGate!=null)for(const gate of [afterBinding?.physicalGateId,load?.requestedGateId,decision.physicalGateId,decision.physical_gate_id,decision.requestedGateId])if(gate!=null&&key(gate)!==key(expectedGate))fail(id);
  }
  return next;
 }
 function validateCalendarAssignments(operations,calendar){
  if(operations==null||calendar==null)return;validate(operations);
  const key=v=>String(v??'').trim().toUpperCase(),fixed=new Map(),fail=id=>{throw Error('Zatwierdzony Stage/Gate jest niezmienny w kalendarzu: '+id);};
  for(const load of operations.loads){const id=load.load_id,d=operations.decisions?.[id],binding=operations.assignmentBindings?.[id],alias=key(operations.assignments?.[id]||load.existingShipDockId||load.current_shipdock||((d?.accepted||d?.overridden||d?.locked)&&d.chosen_shipdock)||binding?.shipDockId);if(!alias)continue;const numeric=/^([0-9]+)[A-Z]*$/.exec(alias);fixed.set(id,{alias,gate:binding?.physicalGateId??(numeric?String(Number(numeric[1])):null)});}
  for(const record of Array.isArray(calendar.appointments)?calendar.appointments:[]){if(record?.status!=='ACTIVE')continue;const expected=fixed.get(record.loadId);if(!expected)continue;if(expected.gate!=null&&key(record.physicalGateId)!==key(expected.gate)||record.shipDockId&&key(record.shipDockId)!==expected.alias)fail(record.loadId);}
  for(const record of Array.isArray(calendar.requests)?calendar.requests:[]){if(record?.status!=='ACTIVE')continue;const gates=new Set((Array.isArray(record.loadIds)?record.loadIds:[]).map(id=>fixed.get(id)?.gate).filter(g=>g!=null).map(key));if(gates.size>1)fail(record.id);}
 }
 const api={validate,validateTransition,validateCalendarAssignments};DG.OperationsSchema=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
