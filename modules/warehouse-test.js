(function(root){
 'use strict';
 const DG=root.DG=root.DG||{},dep=(name,file)=>DG[name]||(typeof require==='function'?require('./'+file+'.js'):null),key=v=>String(v??'').trim().toUpperCase();
 function point(input,engine,index,config={}){
  const label=key(input);if(!label)throw Error('Wskaż lokalizację.');
  const endpoint=engine.endpoint(label),id=index.targets.has(label)?label:endpoint?.temporaryObjectId||endpoint?.temporarySlotId||Object.keys({...config.slotMappings,...config.objectMappings}).find(id=>(config.slotMappings?.[id]||config.objectMappings?.[id]||[]).includes(label)),target=index.targets.get(id);
  if(!target)throw Error('Nie znaleziono miejsca na planie dla '+label+'.');
  if(target.active===false||endpoint?.active===false)throw Error('Obiekt '+label+' jest nieaktywny.');
  if(target.documentaryOnly&&!target.placementValidated)throw Error('Potwierdź geometrię obiektu '+label+'.');
  return {id,label:target.displayName||label,target};
 }
 function fit({engine,points,config={},snapshot={loads:[],decisions:{},assignments:{}},schedule={appointments:[],requests:[]},values,store='',orderType='LS',wmsPriority='',now=Date.now(),id='DG-MAP-TEST'}){
  const Access=dep('SketchAccess','sketch-access'),Rules=dep('PlanningRules','planning-rules'),A=dep('AlgorithmSettings','algorithm-settings'),S=dep('GateSchedule','gate-schedule'),O=dep('ShipDockOptimizer','shipdock-optimizer'),policy=A.normalize(values);
  if(!points.length)throw Error('Dodaj co najmniej jeden punkt.');
  if(engine.sketchError||!engine.sketch)throw Error('Test wymaga poprawnego szkicu i potwierdzonych dojazdów.');
  const index=engine.accessIndex||Access.create(engine.model.geometry),selected=points.map(p=>point(typeof p==='string'?p:p.id,engine,index,config));
  const testStore=key(store),priority=String(wmsPriority??'').trim();if(priority&&!Rules.priorityType(priority))throw Error('Priority WMS musi być poprawną liczbą.');
  if(!testStore&&[...(policy.planningRules.printerRules||[]),...(policy.planningRules.controlRules||[])].some(r=>r.enabled!==false&&['store','sklep','customer','customer_id'].includes(String(r.column).toLowerCase())))throw Error('Podaj sklep, aby ocenić reguły przejazdu dla sklepu.');
  const type=priority?Rules.priorityType(priority):key(orderType);if(!['CC','LS'].includes(type))throw Error('Wybierz typ CC lub LS.');
  let testId=id;const used=new Set((snapshot.loads||[]).map(l=>l.load_id));while(used.has(testId))testId+='-TEST';
  const aliases={},tasks=selected.map((p,i)=>{let alias='DG_MAP_SOURCE_'+i;while(engine.endpoint(alias)||aliases[alias])alias+='_';const b=Access.box(p.target.points);aliases[alias]={mapped:true,active:true,cadX:(b[0]+b[2])/2,cadY:(b[1]+b[3])/2,physicalChamber:p.target.physicalChamber,temporaryObjectId:p.id,accessValidated:false};return {source_location:alias,quantity:1,order_type:type,attributes:{...(priority?{wms_priority:priority}:{})}};});
  // A private view over the engine supplies only explicitly selected map sources.
  // Its model, workload and routing context never enter storage or the live plan.
  const testEngine=Object.create(engine);testEngine.model={...engine.model,locations:{...engine.model.locations,...aliases}};
  const load={load_id:testId,store:testStore||'__MAP_TEST__'+testId,activity:'OUTBOUND',order_type:type,loadingScheduled:false,tasks},context=S.optimizerContext(testEngine.model,snapshot,schedule,now,policy),loads=[...context.loads,load],options={...A.optimizerOptions(policy),planningRules:priority&&type==='LS'?{...policy.planningRules,controlRules:[]}:policy.planningRules,reservations:context.reservations,proposalPins:snapshot.proposalPins||{}};
  const result=O.proposalChoices(testId,loads,{engine:testEngine,assignments:snapshot.assignments||{}},context.gateStates,snapshot.decisions||{},options);
  const stageId=id=>engine.getShipDock(id)?.temporaryObjectId||id,seen=new Set(),choices=result.choices.sort((a,b)=>a.cost-b.cost||a.shipDockId.localeCompare(b.shipDockId,undefined,{numeric:true})).filter(c=>{const stage=stageId(c.shipDockId);if(seen.has(stage))return false;seen.add(stage);return true;});
  return {choices,excluded:result.excluded,points:selected.map(p=>({id:p.id,label:p.label})),load,engine:testEngine,options,storeKnown:!!testStore,orderType:type,now};
 }
 function paths(result,shipDockId){
  if(!result.choices.some(c=>c.shipDockId===shipDockId))throw Error('Stage nie jest dostępną opcją tego testu.');
  const O=dep('ShipDockOptimizer','shipdock-optimizer'),cost=O.costFor(result.load,shipDockId,result.engine,{...result.options,captureRoutes:true}),lines=[];
  if(cost.cost==null)throw Error('Pełna trasa nie jest już dostępna. Przelicz test.');
  for(const task of cost.routes||[]){const add=leg=>{if(!leg.mapped)throw Error('Brak pełnej trasy.');lines.push({points:leg.points||(leg.routeCoordinates||[]).map(p=>[p.x,p.y]),source:result.points[task.taskIndex].id});};for(let i=1;i<task.waypoints.length;i++){if(task.waypoints[i-1]===task.waypoints[i])continue;add(result.engine.distance(task.waypoints[i-1],task.waypoints[i]));}if(result.options.includeStageToGate)add(result.engine.distanceShipDockToGate(shipDockId));}
  return {cost:cost.cost,lines};
 }
 function exclusionGroups(result){
  const Rules=dep('PlanningRules','planning-rules'),groups=new Map(),sources=new Map(result.load.tasks.map((t,i)=>[t.source_location,'Punkt '+(i+1)+' ('+result.points[i].label+')']));
  const stageNames=new Map((result.engine.model.geometry.stageAreas||[]).map(o=>[o.temporaryId,o.displayName||o.temporaryId]));
  const label=id=>sources.get(id)||(String(id).startsWith('GATE:')?'Rampa '+String(id).slice(5):stageNames.get(result.engine.getShipDock(id)?.temporaryObjectId)||result.engine.getShipDock(id)?.temporaryObjectId||id);
  for(const c of result.excluded){
   const stage=label(c.shipDockId),detail=Rules.exclusionDetail(c,label),gate=c.physicalGateId||null;
   // Merge only equivalent explanations for the same physical Stage AND Gate.
   // Different failed legs or gates remain visible as separate groups.
   const key=JSON.stringify([stage,gate,detail,c.taskIndex??null]);let group=groups.get(key);
   if(!group){group={stage,gate,...detail,variants:[]};groups.set(key,group);}
   group.variants.push(c.shipDockId);
  }
  return [...groups.values()];
 }
 const api={point,fit,paths,exclusionGroups};DG.WarehouseTest=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
