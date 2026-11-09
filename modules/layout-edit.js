(function(root){
  'use strict';
  const DG=root.DG=root.DG||{},L=DG.LayoutObjects||(typeof require==='function'?require('./layout-objects.js'):null);
  const clone=value=>JSON.parse(JSON.stringify(value));
  function change(base,config,sketch,target,patch){
    const next=clone(config),shapeChanged=!!patch.points||patch.deleted===true,temp=target.temporaryId;
    if(target.userAdded){
      next.layoutObjects=(next.layoutObjects||[]).filter(o=>!patch.deleted||o.id!==target.id).map(o=>o.id===target.id?{...o,...(patch.points?{points:patch.points}:{}),...(patch.name!=null?{name:patch.name}:{}),...(patch.active!=null?{active:patch.active}:{}),...(patch.operationMode!=null?{operationMode:patch.operationMode}:{}),...(typeof patch.floorPassage==='boolean'?{floorPassage:patch.floorPassage}:{})}:o);
      L.validate(next.layoutObjects,base.geometry);
    }else{next.objectEdits={...next.objectEdits,[target.id]:{...next.objectEdits?.[target.id],...patch}};L.validateEdits(next.objectEdits,base.geometry);}
    if(patch.operationMode!=null){next.shipdocks={...next.shipdocks};for(const id of next.objectMappings?.[temp]?.length?next.objectMappings[temp]:[temp])next.shipdocks[id]={...next.shipdocks[id],operationMode:patch.operationMode};}
    if(typeof patch.floorPassage==='boolean'){if(!target.rackObjectId&&target.kind!=='SLOT')throw Error('Przejazd dotyczy tylko miejsca paletowego.');next.slotAnnotations={...next.slotAnnotations,[temp]:{...next.slotAnnotations?.[temp],floorPassage:patch.floorPassage}};}
    if(typeof patch.active==='boolean'&&(target.kind==='STAGE'||L.shippingStages(base.geometry).some(s=>s.id===target.id))){next.shipdocks={...next.shipdocks};for(const id of next.objectMappings?.[temp]||[])next.shipdocks[id]={...next.shipdocks[id],active:patch.active};}
    const ids=[...(next.slotMappings?.[temp]||[]),...(next.objectMappings?.[temp]||[])],accessIds=[...new Set(ids.flatMap(id=>[id,base.locations[id]?.baseLocation].filter(Boolean)))];
    if(shapeChanged){
      next.documentaryGeometryValidated={...next.documentaryGeometryValidated,[temp]:false};
      for(const key of ['locationAccess','shipdockAccess']){next[key]={...next[key]};for(const id of accessIds){next[key][id]={...next[key][id],accessValidated:false,roadNodeId:null,accessPath:[]};}}
      next.shipdocks={...next.shipdocks};for(const [id,dock] of Object.entries(next.shipdocks))if(ids.includes(id)||dock.temporaryObjectId===temp)next.shipdocks[id]={...dock,cadX:null,cadY:null,mapped:false,accessValidated:false,roadNodeId:null,temporaryObjectId:null};
      if(patch.deleted){if(target.userAdded){delete next.slotMappings?.[temp];delete next.objectMappings?.[temp];}else if(target.rackObjectId){next.slotMappings={...next.slotMappings,[temp]:[]};}else{next.objectMappings={...next.objectMappings,[temp]:[]};}}
    }
    const removed=shapeChanged?(sketch.accessPoints||[]).filter(a=>a.targetId===temp):[];
    const nextSketch=removed.length?{...sketch,accessPoints:sketch.accessPoints.filter(a=>a.targetId!==temp),archivedAccessPoints:[...(sketch.archivedAccessPoints||[]),...removed.map(access=>({access,reason:'Zmiana geometrii obiektu '+temp,revision:'USER_OBJECT_EDIT'}))]}:sketch;
    return {config:next,sketch:nextSketch,invalidatedAccess:removed.length};
  }
  function duplicate(base,config,target,bounds){
    const kind=target.rackObjectId?'SLOT':target.kind||((target.row==='M'||/-MASA\d*$/i.test(target.temporaryId||''))?'MASS':'STAGE');
    const created=L.create(base.geometry,config.layoutObjects||[],config.layoutCounters||{},kind,target.physicalChamber,[bounds[0],bounds[1]],[bounds[2],bounds[3]]);
    created.objects.at(-1).name=(target.displayName||target.documentaryLabel||target.temporaryId).slice(0,92)+' — kopia';
    return {config:{...config,layoutObjects:created.objects,layoutCounters:created.counters},object:created.object};
  }
  const api={change,duplicate};DG.LayoutEdit=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
