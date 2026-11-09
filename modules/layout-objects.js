(function(root){
  'use strict';
  const kinds={SLOT:'Miejsce paletowe · 0,8 × 1,2 m',AREA:'Pole odkładcze · własne wymiary',STAGE:'Stage',MASS:'Masa',CONTROL:'Kontrola',PRINTER:'Drukarka',AGV:'Pole AGV'};
  const code=kind=>({STAGE:'ST',AREA:'AREA',MASS:'MASS',CONTROL:'CTRL',PRINTER:'PRN',AGV:'AGV'})[kind];
  const areaTargets=geometry=>[...(geometry.stageAreas||[]),...(geometry.floorAreas||[]),...(geometry.controlAreas||[])].filter(s=>s.temporaryId);
  // Legacy K7 Masa lives in stageAreas for rendering; it is floor storage.
  const shippingStages=geometry=>(geometry.stageAreas||[]).filter(s=>s.kind!=='MASS'&&s.row!=='M'&&!/-MASA\d*$/i.test(s.temporaryId||''));
  const bounds=points=>[Math.min(...points.map(p=>p[0])),Math.min(...points.map(p=>p[1])),Math.max(...points.map(p=>p[0])),Math.max(...points.map(p=>p[1]))];
  const isVisible=(object,showInactive=false)=>showInactive||object.active!==false;
  function validate(objects,geometry){
    if(!Array.isArray(objects)||objects.length>5000)throw Error('Nieprawidłowa lista obiektów układu.');
    const used=new Set([...geometry.rackSlots,...geometry.stageAreas,...(geometry.floorAreas||[]),...(geometry.controlAreas||[])].flatMap(s=>[s.id,s.temporaryId]).filter(Boolean));
    return objects.map(o=>{
      if(o?.operationMode!=null&&(!['INBOUND','OUTBOUND','DYNAMIC'].includes(o.operationMode)||o.kind!=='STAGE'))throw Error('Nieprawidłowy tryb Stage.');
      if(o?.active!=null&&typeof o.active!=='boolean')throw Error('Nieprawidłowy stan aktywności obiektu.');
      if(o?.floorPassage!=null&&(typeof o.floorPassage!=='boolean'||o.kind!=='SLOT'))throw Error('Przejazd można ustawić tylko dla miejsca paletowego.');
      if(o?.name!=null&&(typeof o.name!=='string'||o.name.length>100||/[\x00-\x1f]/.test(o.name)))throw Error('Nieprawidłowa nazwa obiektu.');
      if(!o||!kinds[o.kind]||typeof o.temporaryId!=='string'||o.id!=='USER-'+o.temporaryId||used.has(o.id)||used.has(o.temporaryId)||!Number.isSafeInteger(o.number)||o.number<1)throw Error('Nieprawidłowy lub powtórzony numer obiektu.');
      const ch=geometry.chambers.find(c=>c.id===String(o.physicalChamber)),prefix='K'+o.physicalChamber+'-',suffix=o.kind==='SLOT'?String(o.number).padStart(4,'0'):code(o.kind)+'-U'+String(o.number).padStart(3,'0');
      if(!ch||o.temporaryId!==prefix+suffix||!Array.isArray(o.points)||o.points.length!==4||!o.points.every(p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite)))throw Error('Nieprawidłowa geometria obiektu.');
      const b=bounds(o.points),expected=[[b[0],b[1]],[b[2],b[1]],[b[2],b[3]],[b[0],b[3]]],scale=geometry.unit.cadToMeters;
      if(!scale||o.points.some((p,i)=>p.some((v,j)=>Math.abs(v-expected[i][j])>.01))||(b[2]-b[0])*scale<.05||(b[3]-b[1])*scale<.05)throw Error('Obiekt musi być prostokątem o dodatnich wymiarach (minimum 5 cm).');
      if(b[0]<ch.bounds[0]||b[1]<ch.bounds[1]||b[2]>ch.bounds[2]||b[3]>ch.bounds[3])throw Error('Cały obiekt musi znajdować się we wskazanej komorze.');
      used.add(o.id);used.add(o.temporaryId);return {...o,physicalChamber:String(o.physicalChamber),points:o.points.map(p=>[...p])};
    });
  }
  function create(geometry,objects,counters,kind,ch,a,z){
    if(!kinds[kind])throw Error('Wybierz typ obiektu.');
    const key=String(ch)+':'+kind,existing=kind==='SLOT'?geometry.rackSlots.filter(s=>s.physicalChamber===String(ch)).map(s=>s.number):[];
    const number=Math.max(1,(counters||{})[key]||1,...existing.filter(Number.isSafeInteger).map(n=>n+1),...objects.filter(o=>o.kind===kind&&o.physicalChamber===String(ch)).map(o=>o.number+1));
    const snap=v=>Math.round(v/10)*10,b=[Math.min(a[0],z[0]),Math.min(a[1],z[1]),Math.max(a[0],z[0]),Math.max(a[1],z[1])].map(snap);
    const suffix=kind==='SLOT'?String(number).padStart(4,'0'):code(kind)+'-U'+String(number).padStart(3,'0'),temporaryId='K'+ch+'-'+suffix;
    const object={id:'USER-'+temporaryId,temporaryId,number,kind,physicalChamber:String(ch),points:[[b[0],b[1]],[b[2],b[1]],[b[2],b[3]],[b[0],b[3]]]};
    const next=validate([...objects,object],geometry);return {object:next.at(-1),objects:next,counters:{...counters,[key]:number+1}};
  }
  function editTargets(geometry){return [...(geometry.rackSlots||[]),...areaTargets(geometry)];}
  function validateEdits(edits,geometry){
    if(!edits||typeof edits!=='object'||Array.isArray(edits)||Object.keys(edits).length>25000)throw Error('Nieprawidłowe zmiany obiektów.');
    const targets=new Map(editTargets(geometry).map(o=>[o.id,o])),out={};
    for(const [id,e] of Object.entries(edits)){
      const o=targets.get(id);if(!o)throw Error('Nieznany obiekt edycji: '+id);
      if(e?.operationMode!=null&&(!['INBOUND','OUTBOUND','DYNAMIC'].includes(e.operationMode)||!shippingStages(geometry).some(s=>s.id===id)))throw Error('Nieprawidłowy tryb Stage.');
      if(e?.active!=null&&typeof e.active!=='boolean')throw Error('Nieprawidłowy stan aktywności obiektu.');
      if(e?.floorPassage!=null&&(typeof e.floorPassage!=='boolean'||!o.rackObjectId&&o.kind!=='SLOT'))throw Error('Przejazd można ustawić tylko dla miejsca paletowego.');
      if(!e||typeof e!=='object'||Array.isArray(e)||e.deleted!=null&&typeof e.deleted!=='boolean'||e.name!=null&&(typeof e.name!=='string'||e.name.length>100||/[\x00-\x1f]/.test(e.name)))throw Error('Nieprawidłowa nazwa lub stan obiektu.');
      let points;if(e.points){
        if(!Array.isArray(e.points)||e.points.length!==o.points.length||!e.points.every(p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite)))throw Error('Nieprawidłowy obrys obiektu.');
        const b=bounds(e.points),ch=geometry.chambers.find(c=>String(c.id)===String(o.physicalChamber)),scale=geometry.unit.cadToMeters;
        if(!ch||!scale||(b[2]-b[0])*scale<.05||(b[3]-b[1])*scale<.05||b[0]<ch.bounds[0]-.01||b[1]<ch.bounds[1]-.01||b[2]>ch.bounds[2]+.01||b[3]>ch.bounds[3]+.01)throw Error('Obiekt musi mieścić się w komorze i mieć wymiary minimum 5 cm.');
        const a=bounds(o.points),expected=transform(o.points,b);
        if(e.points.some((p,i)=>p.some((v,j)=>Math.abs(v-expected[i][j])>.1))||a[2]===a[0]||a[3]===a[1])throw Error('Edycja musi zachować kształt obiektu.');
        points=e.points.map(p=>[...p]);
      }
      out[id]={...(points?{points}:{}),...(e.name!=null?{name:e.name.trim()}:{}),...(typeof e.active==='boolean'?{active:e.active}:{}),...(e.operationMode!=null?{operationMode:e.operationMode}:{}),...(typeof e.floorPassage==='boolean'?{floorPassage:e.floorPassage}:{}),...(e.deleted===true?{deleted:true}:{})};
    }return out;
  }
  function transform(points,b){const a=bounds(points);return points.map(p=>[b[0]+(p[0]-a[0])/(a[2]-a[0])*(b[2]-b[0]),b[1]+(p[1]-a[1])/(a[3]-a[1])*(b[3]-b[1])]);}
  function applyEdits(geometry,edits={}){
    if(!Object.keys(edits).length)return geometry;
    const valid=validateEdits(edits,geometry),g={...geometry,footprints:[...geometry.footprints]};
    for(const key of ['rackSlots','stageAreas','floorAreas','controlAreas'])g[key]=(geometry[key]||[]).filter(o=>!valid[o.id]?.deleted).map(o=>{
      const e=valid[o.id];if(!e)return o;const p=e.points||o.points,b=bounds(p),moved=!!e.points;
      const result={...o,points:p,displayName:e.name||o.displayName,...(typeof e.active==='boolean'?{active:e.active}:{}),...(e.operationMode!=null?{operationMode:e.operationMode}:{}),...(typeof e.floorPassage==='boolean'?{floorPassage:e.floorPassage}:{}), ...(moved?{cadX:(b[0]+b[2])/2,cadY:(b[1]+b[3])/2,dimensionsMeters:[(b[2]-b[0])*geometry.unit.cadToMeters,(b[3]-b[1])*geometry.unit.cadToMeters],geometrySource:'USER_EDITED_GEOMETRY',geometryEdited:true,placementValidated:false}:{})};
      if(key==='rackSlots'&&moved){result.rackObjectId='EDIT-'+o.id;g.footprints.push({id:result.rackObjectId,kind:'rack',points:p,physicalChamber:o.physicalChamber,layer:'USER_LAYOUT'});}
      return result;
    });
    return g;
  }
  // Align the moving bounding box to edges/centres of neighbours or a metric grid.
  function snapBounds(b,neighbours,{tolerance=100,grid=0,disabled=false,resize=false,lockedAxis=null}={}){
    if(disabled)return {bounds:[...b],guides:[]};const out=[...b],guides=[];
    for(let axis=0;axis<2;axis++){
      if(axis===lockedAxis)continue;
      const positions=resize?[b[axis+2]]:[b[axis],(b[axis]+b[axis+2])/2,b[axis+2]];let best=null;
      for(const n of neighbours){const nb=n.bounds||bounds(n.points);for(const target of [nb[axis],(nb[axis]+nb[axis+2])/2,nb[axis+2]])for(const value of positions){const delta=target-value;if(Math.abs(delta)<=tolerance&&(!best||Math.abs(delta)<Math.abs(best.delta)))best={delta,target,other:nb};}}
      if(best){if(!resize)out[axis]+=best.delta;out[axis+2]+=best.delta;guides.push({axis,value:best.target,from:Math.min(out[1-axis],best.other[1-axis]),to:Math.max(out[3-axis],best.other[3-axis])});}
      else if(grid>0){const index=resize?axis+2:axis,delta=Math.round(out[index]/grid)*grid-out[index];if(!resize)out[axis]+=delta;out[axis+2]+=delta;}
    }return {bounds:out,guides};
  }
  function apply(geometry,objects=[],edits={}){
    geometry=applyEdits(geometry,edits);
    if(!objects.length)return geometry;
    const rows=validate(objects,geometry),g={...geometry,rackSlots:[...geometry.rackSlots],footprints:[...geometry.footprints],stageAreas:[...geometry.stageAreas],floorAreas:[...(geometry.floorAreas||[])],controlAreas:[...(geometry.controlAreas||[])]};
    for(const o of rows){
      const b=bounds(o.points),s={...o,displayName:o.name||undefined,cadX:(b[0]+b[2])/2,cadY:(b[1]+b[3])/2,dimensionsMeters:[(b[2]-b[0])*geometry.unit.cadToMeters,(b[3]-b[1])*geometry.unit.cadToMeters],userAdded:true,geometrySource:'USER_DRAWN_RECTANGLE',label:o.temporaryId};
      if(o.kind==='SLOT'){s.rackObjectId='RACK-'+o.id;g.rackSlots.push(s);g.footprints.push({id:s.rackObjectId,kind:'rack',points:s.points,physicalChamber:s.physicalChamber,name:s.temporaryId,layer:'USER_LAYOUT'});}
      else if(o.kind==='STAGE')g.stageAreas.push({...s,row:'U'});
      else if(['MASS','AREA','PRINTER','AGV'].includes(o.kind))g.floorAreas.push(s);
      else g.controlAreas.push(s);
    }
    return g;
  }
  function placePallet(geometry,objects,counters,ch,point,rotated=false){const scale=geometry.unit.cadToMeters;return create(geometry,objects,counters,'SLOT',ch,point,[point[0]+(rotated?1.2:.8)/scale,point[1]+(rotated?.8:1.2)/scale]);}
  function assignLocations(geometry,config,locations,targetId,input){
    const targets=areaTargets(geometry),target=targets.find(s=>s.temporaryId===targetId);if(!target)throw Error('Nie znaleziono obiektu do przypisania lokalizacji.');
    const ids=input.toUpperCase().split('|').map(s=>s.trim()).filter(Boolean);
    if(ids.length>1000)throw Error('Do jednego obiektu można przypisać maksymalnie 1000 adresów.');
    if(ids.some(id=>id.length>80||!/^[A-Z0-9][A-Z0-9._/-]*$/.test(id)))throw Error('Użyj identyfikatorów lokalizacji bez spacji; kilka rozdziel znakiem |.');
    if(new Set(ids).size!==ids.length)throw Error('Ta sama lokalizacja występuje więcej niż raz.');
    const all=new Set([...(geometry.rackSlots||[]),...targets].map(s=>s.temporaryId)),owners=new Map();
    for(const [temp,list] of Object.entries({...config.slotMappings,...config.objectMappings}))if(temp!==targetId)for(const id of list)owners.set(id,temp);
    for(const id of ids){if(owners.has(id)||all.has(id)&&id!==targetId)throw Error('Lokalizacja '+id+' jest już przypisana do '+(owners.get(id)||id)+'.');const ch=locations[id]?.physicalChamber;if(ch!=null&&String(ch)!==String(target.physicalChamber))throw Error('Lokalizacja z innej komory: '+id);}
    const mappings={...config.objectMappings};if(ids.length)mappings[targetId]=ids;else delete mappings[targetId];return mappings;
  }
  function validateMappings(mappings,geometry,config,locations,sourceGeometry=geometry){
    if(!mappings||typeof mappings!=='object'||Array.isArray(mappings))throw Error('Nieprawidłowe mapowanie lokalizacji obiektów.');
    // Source deletions retain an empty assignment to prevent defaults returning.
    // These targets are intentionally absent from the effective geometry.
    const deleted=new Set(areaTargets(sourceGeometry).filter(o=>config.objectEdits?.[o.id]?.deleted===true).map(o=>o.temporaryId));
    let result={};for(const [temp,ids] of Object.entries(mappings)){
      if(!Array.isArray(ids)||!ids.every(id=>typeof id==='string'))throw Error('Nieprawidłowe lokalizacje obiektu '+temp);
      if(deleted.has(temp)&&ids.length===0){result[temp]=[];continue;}
      result=assignLocations(geometry,{...config,objectMappings:result},locations,temp,ids.join('|'));
    }return result;
  }
  function pruneRemoved(geometry,config){
    const removed=new Set(geometry.removedObjectIds||[]),replacements=Object.entries(geometry.rackLayoutReplacements||{}).filter(([ch,r])=>config.rackLayoutRevisions?.[ch]!==r.revision);
    if(!removed.size&&!replacements.length)return config;
    const changed=new Set(replacements.filter(([,r])=>!r.preserveMappings).map(([ch])=>ch)),moved=new Set(replacements.filter(([,r])=>r.preserveMappings).flatMap(([,r])=>r.targetIds||[]));
    const oldIds=new Set(Object.entries(config.slotMappings||{}).filter(([temp])=>removed.has(temp)||moved.has(temp)||changed.has(/^K(\d+)-\d+$/.exec(temp)?.[1])).flatMap(([,ids])=>ids)),oldLocation=id=>oldIds.has(id)||[...oldIds].some(value=>value.replace(/[A-Z]$/,'')===id)||changed.has(String(Number(/^(\d{2})R\d{4}/.exec(id)?.[1])));
    const keepSlot=id=>!removed.has(id)&&!changed.has(/^K(\d+)-\d+$/.exec(id)?.[1]);
    const result={...config,layoutObjects:(config.layoutObjects||[]).filter(o=>!removed.has(o.id)&&!removed.has(o.temporaryId)&&!(o.kind==='SLOT'&&changed.has(String(o.physicalChamber)))),objectMappings:Object.fromEntries(Object.entries(config.objectMappings||{}).filter(([id])=>!removed.has(id))),slotMappings:Object.fromEntries(Object.entries(config.slotMappings||{}).filter(([id])=>keepSlot(id))),slotAnnotations:Object.fromEntries(Object.entries(config.slotAnnotations||{}).filter(([id])=>keepSlot(id)))};
    if(config.objectEdits){const targets=new Set((geometry.rackSlots||[]).filter(s=>moved.has(s.temporaryId)).map(s=>s.id));result.objectEdits={};for(const [id,e] of Object.entries(config.objectEdits)){if(removed.has(id))continue;const next={...e};if(targets.has(id))delete next.points;if(Object.keys(next).length)result.objectEdits[id]=next;}}
    if(replacements.length){
      result.rackLayoutRevisions={...config.rackLayoutRevisions,...Object.fromEntries(replacements.map(([ch,r])=>[ch,r.revision]))};
      for(const key of ['locationPoints','locationAccess'])if(config[key])result[key]=Object.fromEntries(Object.entries(config[key]).filter(([id])=>!oldLocation(id)));
      if(config.userLocationDefinitions)result.userLocationDefinitions=Object.fromEntries(Object.entries(config.userLocationDefinitions).map(([id,l])=>[id,oldLocation(id)?{...l,mapped:false,cadX:null,cadY:null,roadNodeId:null,accessValidated:false}:l]));
      if(config.alignmentValidated)result.alignmentValidatedChambers=(config.alignmentValidatedChambers||geometry.chambers.map(c=>c.id)).filter(ch=>!changed.has(String(ch)));
    }
    return result;
  }
  const api={kinds,bounds,isVisible,validate,create,apply,placePallet,areaTargets,shippingStages,assignLocations,validateMappings,pruneRemoved,editTargets,validateEdits,applyEdits,transform,snapBounds};root.DG=root.DG||{};root.DG.LayoutObjects=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
