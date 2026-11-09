(function(root){
 'use strict';
 const DG=root.DG=root.DG||{};
 const dependency=name=>DG[name]||(typeof require==='function'?require('./'+({'LayoutObjects':'layout-objects','LineSketch':'line-sketch','SketchAccess':'sketch-access'}[name]||name)+'.js'):null);
 const keys={calibration:'dynamic-gates-spatial-calibration-v1',sketch:'dynamic-gates-line-sketch-v1',layers:'dynamic-gates-warehouse-layers-v1',view:'dynamic-gates-warehouse-view-v1'};
 function protectSketchStorage(backend){
  let error='';
  const assertWritable=()=>{if(error)throw Error(error);};
  const storage={getItem:key=>backend.getItem(key),setItem(key,value){if(key===keys.sketch)assertWritable();backend.setItem(key,value);},removeItem(key){if(key===keys.sketch)assertWritable();backend.removeItem(key);},get sketchReadError(){return error;}};
  if(backend.batch)storage.batch=fn=>backend.batch(fn);
  return {storage,assertWritable,isBlocked:()=>!!error,block(){error='Nie odczytano szkicu dróg. Zapis zablokowany, aby zachować oryginał. Narzędzia → Opcje linii → Eksport szkicu pobiera oryginalny zapis.';return error;},replace(action){
   if(!error)return action();
   // Only an explicit validated import may replace an unreadable sketch.
   // Preserve its original bytes first; failure to archive aborts the import.
   const raw=backend.getItem(keys.sketch),previousError=error;
   if(raw!==null){let key=keys.sketch+'-recovery-'+Date.now(),n=0;while(backend.getItem(key)!==null)key=keys.sketch+'-recovery-'+Date.now()+'-'+(++n);backend.setItem(key,raw);}
   error='';try{return action();}catch(e){error=previousError;throw e;}
  }};
 }
 function migrateAccess(sketch,geometry){
  const revision=geometry.layoutGeometryRevision;
  if(!revision||sketch.layoutGeometryRevision===revision)return sketch;
  const index=dependency('SketchAccess').create(geometry),accessPoints=[],archivedAccessPoints=[...(sketch.archivedAccessPoints||[])];
  for(const access of sketch.accessPoints||[]){try{index.checkSaved({...sketch,accessPoints:[access]});accessPoints.push(access);}catch(error){archivedAccessPoints.push({access,reason:error.message,revision});}}
  return {...sketch,accessPoints,archivedAccessPoints,layoutGeometryRevision:revision};
 }
 function capture(base,config,sketch,storage){
  if(storage.sketchReadError)throw Error(storage.sketchReadError);
  return {kind:'DYNAMIC_GATES_WAREHOUSE_BACKUP',version:1,createdAt:new Date().toISOString(),source:base.geometry.source,geometryRevision:base.geometry.layoutGeometryRevision||null,calibration:config,sketch,layers:storage.getItem(keys.layers),view:storage.getItem(keys.view),archivedAccessPoints:sketch.archivedAccessPoints||[]};
 }
 function prepare(file,base){
  if(file?.kind!=='DYNAMIC_GATES_WAREHOUSE_BACKUP'||file.version!==1||file.source?.sha256!==base.geometry.source.sha256)throw Error('Kopia nie pasuje do tego planu magazynu.');
  const Engine=DG.SpatialEngine||(typeof require==='function'?require('./spatial-engine.js').SpatialEngine:null),apply=DG.applyCalibration||(typeof require==='function'?require('./spatial-engine.js').applyCalibration:null),merge=DG.mergeSourceSlotMappings||(typeof require==='function'?require('./spatial-engine.js').mergeSourceSlotMappings:null);
  if(!file.calibration||typeof file.calibration!=='object'||Array.isArray(file.calibration))throw Error('Nieprawidłowa konfiguracja Warehouse Setup.');
  const config=merge(file.calibration,base.calibration,base.geometry),model=apply(base,config),Sketch=dependency('LineSketch');
  let sketch=Sketch.validate(file.sketch);if(sketch.source?.sha256&&sketch.source.sha256!==base.geometry.source.sha256)throw Error('Szkic pochodzi z innego planu CAD.');
  sketch=migrateAccess(Sketch.pruneTargets(sketch,model.geometry.removedObjectIds,model.geometry.rackLayoutReplacements),model.geometry);
  const engine=new Engine(model).setSketch(sketch);if(engine.sketchError)throw Error(engine.sketchError);
  const mappingEntries=Object.entries({...config.slotMappings,...config.objectMappings}),known=new Set([...model.geometry.rackSlots,...dependency('LayoutObjects').areaTargets(model.geometry)].map(s=>s.temporaryId)),owners=new Set();
  const hidden=new Set(dependency('LayoutObjects').editTargets(base.geometry).filter(o=>config.objectEdits?.[o.id]?.deleted).map(o=>o.temporaryId));
  for(const[temp,ids]of mappingEntries){if(!Array.isArray(ids)||!known.has(temp)&&!(hidden.has(temp)&&ids.length===0))throw Error('Nieznany obiekt w kopii: '+temp);for(const id of ids){if(owners.has(id))throw Error('Powtórzona lokalizacja w kopii: '+id);if(!model.locations[id]&&!model.shipdocks[id])throw Error('Nieznana lokalizacja w kopii: '+id);owners.add(id);}}
  if(file.view!=null&&file.view!==''&&!/^([1-9]|10|11)$/.test(file.view))throw Error('Nieprawidłowy podgląd komory.');
  if(file.layers!=null){const layers=JSON.parse(file.layers);if(!layers||typeof layers!=='object'||Array.isArray(layers)||Object.values(layers).some(v=>typeof v!=='boolean'))throw Error('Nieprawidłowe filtry w kopii.');}
  return {config,sketch,layers:file.layers??null,view:file.view??null,sourceCalibration:base.calibration};
 }
 function store(value,storage){
  const serialize=DG.serializeCalibration||(typeof require==='function'?require('./spatial-engine.js').serializeCalibration:JSON.stringify);
  const writes={calibration:serialize(value.config,value.sourceCalibration),sketch:JSON.stringify(value.sketch),layers:value.layers,view:value.view},before=Object.fromEntries(Object.entries(keys).map(([name,key])=>[name,storage.getItem(key)]));
  if(storage.batch)return storage.batch(()=>{for(const[name,text]of Object.entries(writes)){if(text==null)storage.removeItem(keys[name]);else storage.setItem(keys[name],text);}});
  try{for(const[name,text]of Object.entries(writes)){if(text==null)storage.removeItem(keys[name]);else storage.setItem(keys[name],text);}}
  catch(error){for(const[name,text]of Object.entries(before))try{if(text==null)storage.removeItem(keys[name]);else storage.setItem(keys[name],text);}catch(_){}throw Error('Nie zapisano kopii: '+error.message);}
 }
 function validateChange(base,beforeValues,nextValues,{allowUnreadableSketch=false}={}){
  if(typeof require==='function')for(const file of ['core','planning-rules','gate-schedule','algorithm-settings','shipdock-optimizer'])require('./'+file+'.js');
  const get=key=>beforeValues[key]??null,raw=get('dynamic-gates-v01');let snapshot;
  try{snapshot=raw===null?{loads:[],decisions:{},assignments:{},gateStates:{}}:JSON.parse(raw);if(!snapshot||!Array.isArray(snapshot.loads))throw Error('Nieprawidłowy schemat.');if(raw!==null)(DG.OperationsSchema||(typeof require==='function'?require('./operations-schema.js'):null)).validate(snapshot);}catch(error){throw Error('Nie odczytano Operations. Zmiana Warehouse została zatrzymana: '+error.message);}
  const storage={getItem:get},schedule=new DG.GateSchedule.Store(storage).read(),settings=DG.AlgorithmSettings?new DG.AlgorithmSettings.Store(storage).read().values:{planningRules:{}};
  const sp=typeof require==='function'?require('./spatial-engine.js'):DG,Engine=DG.SpatialEngine||sp.SpatialEngine,apply=DG.applyCalibration||sp.applyCalibration,merge=DG.mergeSourceSlotMappings||sp.mergeSourceSlotMappings;
  function compile(values,tolerate=false){const rawConfig=values[keys.calibration],config=merge(rawConfig?JSON.parse(rawConfig):base.calibration,base.calibration,base.geometry);let sketch=null;try{if(values[keys.sketch])sketch=dependency('LineSketch').validate(JSON.parse(values[keys.sketch]));}catch(error){if(!tolerate)throw error;}const engine=new Engine(apply(base,config));if(sketch)engine.setSketch(sketch);return {engine,sketch:sketch||{version:1,segments:[],accessPoints:[]}};}
  const before=compile(beforeValues,allowUnreadableSketch),after=compile({...beforeValues,...nextValues});
  const L=dependency('LayoutObjects'),Access=dependency('SketchAccess'),oldTargets=new Map(L.editTargets(before.engine.model.geometry).map(o=>[o.id,o]));
  for(const o of L.editTargets(after.engine.model.geometry)){
    const a=oldTargets.get(o.id),changed=!a||JSON.stringify(a.points)!==JSON.stringify(o.points)||a.active===false&&o.active!==false||a.floorPassage&&!o.floorPassage;
    if(!changed||o.active===false||o.floorPassage===true&&(o.rackObjectId||o.kind==='SLOT')||o.documentaryOnly&&!o.placementValidated)continue;
    const line=after.sketch.segments.find(line=>line.enabled!==false&&Access.hitsLine(line.points,L.bounds(o.points)));if(line)throw Error('Obiekt przecina linię '+line.id+'. Zmień obiekt lub wyłącz linię.');
  }
  const oldLines=new Map(before.sketch.segments.map(line=>[line.id,line])),obstacles=Access.create(after.engine.model.geometry).obstacles;
  for(const line of after.sketch.segments){const old=oldLines.get(line.id);if(line.enabled===false||old&&old.enabled!==false&&JSON.stringify(old.points)===JSON.stringify(line.points))continue;if(obstacles.some(o=>Access.hitsLine(line.points,o.bounds)))throw Error('Linia '+line.id+' przecina aktywny obiekt.');}
  DG.PlanningRules.validateSafety(before.engine,after.engine,before.sketch,after.sketch,snapshot,settings.planningRules,schedule,settings);
 }
 const api={keys,capture,prepare,store,migrateAccess,protectSketchStorage,validateChange};DG.WarehouseBackup=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
