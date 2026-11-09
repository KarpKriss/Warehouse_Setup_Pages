(function (root) {
  'use strict';
  const DG = root.DG = root.DG || {};
  const Layout=DG.LayoutObjects||(typeof require==='function'?require('./layout-objects.js'):null);
  const Domain=DG.ShipDockDomain||(typeof require==='function'?require('./shipdock-domain.js'):null);
  const fail = (reason, sourceId, destinationId) => ({ mapped: false, reason, sourceId, destinationId, confidence: 'NEEDS_VALIDATION', distanceMeters: null, routeNodeIds: [] });
  class SpatialEngine {
    constructor(model) {
      this.model = Domain.normalize(model);
      this.nodes = new Map(model.roadGraph.nodes.map(n => [n.id, n]));
      this.adj = new Map([...this.nodes.keys()].map(id => [id, []]));
      const scale = model.geometry.unit.cadToMeters;
      for (const e of model.roadGraph.edges) {
        if (!e.enabled || !this.nodes.has(e.from) || !this.nodes.has(e.to)) continue;
        const length = e.lengthCadUnits ?? (scale ? e.lengthMeters / scale : null);
        if (!Number.isFinite(length) || length < 0) continue;
        const arc = (from, to) => this.adj.get(from).push({ to, length, direction: e.direction });
        if (['BOTH', 'UNKNOWN', 'FORWARD'].includes(e.direction)) arc(e.from, e.to);
        if (['BOTH', 'UNKNOWN', 'REVERSE'].includes(e.direction)) arc(e.to, e.from);
      }
    }
    getShipDock(id){return this.model.shipdocks[Domain.key(id)]||null;}
    getPhysicalGate(id){return this.model.gates[Domain.key(id)]||null;}
    getGateForShipDock(id){const dock=this.getShipDock(id);return dock?.physicalGateId?this.getPhysicalGate(dock.physicalGateId):null;}
    validateAssignment(id,requestedGate){return Domain.validateAssignment(this.model,id,requestedGate);}
    distanceShipDockToGate(id,context){const gate=this.getGateForShipDock(id);return gate?this.route(id,'GATE:'+gate.gateId,context):fail('SHIPDOCK_NEEDS_VALIDATION',id);}
    distanceGateToShipDock(id,context){const gate=this.getGateForShipDock(id);return gate?this.route('GATE:'+gate.gateId,id,context):fail('SHIPDOCK_NEEDS_VALIDATION',id);}
    createRoutingContext(){if(!this.sketch||this.sketchError)return null;const Sketch=DG.LineSketch||(typeof require==='function'?require('./line-sketch.js'):null);return {sketch:this.sketch,router:Sketch.createAccessRouter(this.sketch)};}
    setSketch(sketch){
      const Sketch=DG.LineSketch||(typeof require==='function'?require('./line-sketch.js'):null),Access=DG.SketchAccess||(typeof require==='function'?require('./sketch-access.js'):null);
      this.sketchError=null;
      try{this.sketch=Sketch.validate(Sketch.pruneTargets(sketch,this.model.geometry.removedObjectIds,this.model.geometry.rackLayoutReplacements));if(this.sketch.source?.sha256&&this.sketch.source.sha256!==this.model.geometry.source?.sha256)throw Error('Szkic pochodzi z innego planu CAD.');this.accessIndex=Access.create(this.model.geometry);this.accessIndex.checkSaved(this.sketch);}
      catch(error){this.sketchError=error.message;this.sketch=null;}
      return this;
    }
    withDraftSketch(sketch){
      // Editor preview only. Persistent writes and planning still use setSketch
      // and the complete Warehouse validator at the explicit Save boundary.
      const Sketch=DG.LineSketch||(typeof require==='function'?require('./line-sketch.js'):null);
      const next=Sketch.validate(Sketch.pruneTargets(sketch,this.model.geometry.removedObjectIds,this.model.geometry.rackLayoutReplacements));
      if(next.source?.sha256&&next.source.sha256!==this.model.geometry.source?.sha256)throw Error('Szkic pochodzi z innego planu CAD.');
      if(!this.sketch||this.sketchError)return new SpatialEngine(this.model).setSketch(next);
      this.accessIndex.checkChanges(this.sketch,next);
      return Object.assign(Object.create(Object.getPrototypeOf(this)),this,{sketch:next,sketchError:null});
    }
    endpoint(id) {
      id = String(id || '').trim().toUpperCase();
      if (id.startsWith('GATE:')) return this.model.gates[id.slice(5)];
      if (id.startsWith('NODE:')) { const n = this.nodes.get(id.slice(5)); return n && { cadX:n.x, cadY:n.y, mapped:n.confidence!=='NEEDS_VALIDATION', confidence:n.confidence||'MANUALLY_VALIDATED', roadNodeId:n.id, physicalChamber:n.physicalChamber, accessLengthCadUnits:0, accessValidated:n.confidence!=='NEEDS_VALIDATION', mappingSource:n.mappingSource||'VALIDATED_ROAD_NODE' }; }
      return this.model.shipdocks[id] || this.model.locations[id] || this.model.gates[id];
    }
    physicalChamber(id) { return this.endpoint(id)?.physicalChamber ?? null; }
    nearestRoadNode(id) {
      const e = this.endpoint(id);
      if (!e?.mapped) return fail('ENDPOINT_NOT_MAPPED', id);
      // A nearest geometric point is not evidence of traversable access through walls/racks.
      if (!e.accessValidated || !this.nodes.has(e.roadNodeId)) return fail('ROAD_ACCESS_NOT_VALIDATED', id);
      return { mapped:true, node:this.nodes.get(e.roadNodeId), confidence:e.confidence, mappingSource:e.mappingSource };
    }
    distance(sourceId, destinationId, context) { return this.route(sourceId, destinationId, context); }
    route(sourceId, destinationId, context) {
      const source=this.endpoint(sourceId), destination=this.endpoint(destinationId);
      if(source?.active===false||destination?.active===false)return fail('INACTIVE_OBJECT',sourceId,destinationId);
      if(source?.shipDockId&&!source.physicalGateId||destination?.shipDockId&&!destination.physicalGateId)return fail('SHIPDOCK_NEEDS_VALIDATION',sourceId,destinationId);
      if (!source?.mapped) return fail('SOURCE_NOT_MAPPED', sourceId, destinationId);
      if (!destination?.mapped) return fail('DESTINATION_NOT_MAPPED', sourceId, destinationId);
      const from=source.temporaryObjectId||source.temporarySlotId,to=destination.temporaryObjectId||destination.temporarySlotId;
      if(from&&to&&(this.sketch||this.sketchError)){
        if(this.sketchError)return fail('SKETCH_ACCESS_NOT_VALIDATED',sourceId,destinationId);
        const Sketch=DG.LineSketch||(typeof require==='function'?require('./line-sketch.js'):null),scale=this.model.geometry.unit.cadToMeters;
        const route=from===to?{connected:true,lengthCadUnits:0,lengthMeters:scale>0?0:null,points:[[source.cadX,source.cadY]]}:context?.sketch===this.sketch?context.router.route(from,to,scale):Sketch.accessRoute(this.sketch,from,to,scale);
        if(!route.connected)return fail(route.reason,sourceId,destinationId);
        return {mapped:true,sourceId,destinationId,distanceMeters:route.lengthMeters,distanceCadUnits:route.lengthCadUnits,routeNodeIds:[],routeCoordinates:route.points.map(([x,y])=>({x,y})),confidence:'USER_CONFIRMED_ACCESS',mappingSource:'VALIDATED_LINE_SKETCH',directionValidation:'USER_CONFIRMED',...route};
      }
      for (const [e,side] of [[source,'SOURCE'],[destination,'DESTINATION']]) {
        if (!Number.isFinite(e.cadX) || !Number.isFinite(e.cadY)) return fail(side+'_COORDINATES_INVALID',sourceId,destinationId);
        if (!e.accessValidated || !this.nodes.has(e.roadNodeId) || !Number.isFinite(e.accessLengthCadUnits) || e.accessLengthCadUnits<0) return fail(side+'_ROAD_ACCESS_NOT_VALIDATED',sourceId,destinationId);
      }
      const path=this.routeNodes(source.roadNodeId,destination.roadNodeId);
      if (!path.mapped) return fail(path.reason,sourceId,destinationId);
      const length=path.distanceCadUnits+source.accessLengthCadUnits+destination.accessLengthCadUnits;
      const scale=this.model.geometry.unit.cadToMeters;
      return { sourceId,destinationId,mapped:true,distanceMeters:scale ? length*scale : null,distanceCadUnits:length,distanceUnit:scale ? 'METERS' : 'UNCALIBRATED_CAD_UNIT',routeNodeIds:path.routeNodeIds,routeCoordinates:path.routeNodeIds.map(id=>this.nodes.get(id)),confidence:[source.confidence,destination.confidence,'MANUALLY_VALIDATED_NETWORK'].join(' / '),mappingSource:[source.mappingSource,destination.mappingSource],sourceCoordinates:[source.cadX,source.cadY],destinationCoordinates:[destination.cadX,destination.cadY],accessPaths:[source.accessPath || [],destination.accessPath || []],directionValidation:this.model.roadGraph.directionValidation || 'UNKNOWN' };
    }
    routeNodes(from,to) {
      if (!this.nodes.has(from) || !this.nodes.has(to)) return {mapped:false,reason:'ROAD_NODE_NOT_FOUND'};
      const distances=new Map([[from,0]]), previous=new Map(), queue=[[0,from]],visited=new Set();
      // Binary heap keeps route testing practical for a full warehouse network.
      const push=item=>{queue.push(item);let i=queue.length-1;while(i){let p=(i-1)>>1;if(queue[p][0]<=item[0])break;queue[i]=queue[p];i=p;}queue[i]=item;};
      const pop=()=>{const first=queue[0],last=queue.pop();if(queue.length){let i=0;while(i*2+1<queue.length){let c=i*2+1;if(c+1<queue.length&&queue[c+1][0]<queue[c][0])c++;if(queue[c][0]>=last[0])break;queue[i]=queue[c];i=c;}queue[i]=last;}return first;};
      while(queue.length){const [cost,id]=pop();if(visited.has(id))continue;visited.add(id);if(id===to)break;for(const edge of this.adj.get(id)){const next=cost+edge.length;if(next<(distances.get(edge.to)??Infinity)){distances.set(edge.to,next);previous.set(edge.to,id);push([next,edge.to]);}}}
      if(!visited.has(to))return {mapped:false,reason:'NO_ALLOWED_ROAD_PATH'};
      const ids=[to];while(ids[0]!==from)ids.unshift(previous.get(ids[0]));
      return {mapped:true,distanceCadUnits:distances.get(to),routeNodeIds:ids};
    }
  }
  class DistanceProvider {
    constructor(engine){this.engine=engine;}
    distance(sourceId,destinationId){return this.engine.distance(sourceId,destinationId);}
    route(sourceId,destinationId){return this.engine.route(sourceId,destinationId);}
  }
  // Least squares affine fit; reject collinear grid anchors instead of fabricating a transform.
  function fitAlignment(anchors,locations) {
    const valid=anchors.map(a=>({a,l:Object.values(locations).find(l=>l.baseLocation===a.baseLocation&&l.gridX!=null)})).filter(v=>v.l);
    if(valid.length<3)return {status:'ANCHORS_REQUIRED',anchorCount:valid.length};
    const M=Array.from({length:3},()=>Array(5).fill(0));
    for(const {a,l} of valid){const x=[l.gridX,l.gridY,1];for(let i=0;i<3;i++){for(let j=0;j<3;j++)M[i][j]+=x[i]*x[j];M[i][3]+=x[i]*a.cadX;M[i][4]+=x[i]*a.cadY;}}
    for(let col=0;col<3;col++){let p=col;for(let r=col+1;r<3;r++)if(Math.abs(M[r][col])>Math.abs(M[p][col]))p=r;[M[p],M[col]]=[M[col],M[p]];if(Math.abs(M[col][col])<1e-8)return {status:'COLLINEAR_ANCHORS',anchorCount:valid.length};const divisor=M[col][col];M[col]=M[col].map(v=>v/divisor);for(let r=0;r<3;r++)if(r!==col){const factor=M[r][col];M[r]=M[r].map((v,i)=>v-factor*M[col][i]);}}
    const matrix=M.map(r=>r.slice(3));const project=l=>[0,1].map(j=>l.gridX*matrix[0][j]+l.gridY*matrix[1][j]+matrix[2][j]);
    const errors=valid.map(({a,l})=>{const p=project(l);return Math.hypot(p[0]-a.cadX,p[1]-a.cadY);});
    return {status:'FIT_AVAILABLE',anchorCount:valid.length,matrix,rmseCadUnits:Math.sqrt(errors.reduce((s,e)=>s+e*e,0)/errors.length),maxErrorCadUnits:Math.max(...errors),anchors};
  }
  function applyCalibration(base,config) {
    config=Layout.pruneRemoved(base.geometry,config);
    const controls=new Map((base.geometry.controlAreas||[]).map(a=>[a.id,a]));for(const a of config.controlAreas||[])controls.set(a.id,a);
    const geometry=Layout.apply({...base.geometry,controlAreas:[...controls.values()]},config.layoutObjects||[],config.objectEdits||{});
    for(const key of ['stageAreas','floorAreas','controlAreas'])geometry[key]=(geometry[key]||[]).map(area=>area.documentaryOnly?{...area,placementValidated:config.documentaryGeometryValidated?.[area.temporaryId]===true}:area);
    const m={...base,geometry,locations:{...config.userLocationDefinitions,...base.locations},gates:{...base.gates},shipdocks:{...base.shipdocks},roadGraph:config.roadGraph||base.roadGraph};
      // Source slot mappings are recalculated, so removing a local assignment also
      // removes its approved coordinates instead of retaining a stale ETL endpoint.
      const sourceSlotMappings=new Set(['USER_SLOT_MAPPING','MASTER_OVERHEAD_BOUNDED_SEQUENCE','USER_APPROVED_K2_PASSAGE_2026-10-24']);
      for(const [id,l]of Object.entries(base.locations))if(sourceSlotMappings.has(l.mappingSource))m.locations[id]={...l,cadX:null,cadY:null,cadSlotId:null,temporarySlotId:null,mapped:false,confidence:'NEEDS_VALIDATION',mappingSource:'WMS_MASTER_ONLY',accessValidated:false,roadNodeId:null};
    const fit=fitAlignment(config.anchors||[],base.locations),b=base.geometry.bounds;
    if(fit.matrix)for(const [id,l] of Object.entries(base.locations)){if(l.gridX==null||(config.projectionChambers&&!config.projectionChambers.includes(l.physicalChamber)))continue;const xy=[0,1].map(j=>l.gridX*fit.matrix[0][j]+l.gridY*fit.matrix[1][j]+fit.matrix[2][j]);const ch=m.geometry.chambers.find(c=>c.id===l.physicalChamber),inside=xy[0]>=b[0]&&xy[0]<=b[2]&&xy[1]>=b[1]&&xy[1]<=b[3],inChamber=!ch||(xy[0]>=ch.bounds[0]&&xy[0]<=ch.bounds[2]&&xy[1]>=ch.bounds[1]&&xy[1]<=ch.bounds[3]);const scope=!config.alignmentValidatedChambers||config.alignmentValidatedChambers.includes(l.physicalChamber),mapped=!!config.alignmentValidated&&inside&&inChamber&&scope;m.locations[id]={...l,cadX:xy[0],cadY:xy[1],mapped,confidence:mapped?'MANUALLY_VALIDATED':'NEEDS_VALIDATION',mappingSource:'XLSB_CAD_ANCHORS'};}
    const locationIndex=new Map();if(Object.keys(config.locationPoints||{}).length||Object.keys(config.locationAccess||{}).length)for(const [id,l]of Object.entries(m.locations)){if(!locationIndex.has(id))locationIndex.set(id,[id]);const list=locationIndex.get(l.baseLocation)||[];if(!list.includes(id))list.push(id);locationIndex.set(l.baseLocation,list);}
    for(const [table,key] of [['gates','gates'],['shipdocks','shipdocks'],['locations','locationPoints'],['locations','locationAccess'],['gates','gateAccess'],['shipdocks','shipdockAccess']])for(const [id,patch]of Object.entries(config[key]||{})){
      if(table==='shipdocks'&&key==='shipdocks'&&!m.shipdocks[id])m.shipdocks[id]={shipDockId:id,active:true,physicalGateId:null,cadX:null,cadY:null,mapped:false,confidence:'NEEDS_VALIDATION',mappingSource:'USER_DEFINED_SHIPDOCK'};
      if(table==='locations'){for(const lid of locationIndex.get(id)||[])m.locations[lid]={...m.locations[lid],...patch};}
      else if(m[table][id]){if(table==='shipdocks'){
        Domain.assertPatch(id,m[table][id],patch);const gate=m.gates[Domain.prefix(id)||patch.physicalGateId||m[table][id].physicalGateId];
        if(patch.physicalChamber!=null&&gate&&String(patch.physicalChamber)!==String(gate.physicalChamber))Domain.invalid('Physical chamber must come from Gate for '+id);
        const ch=m.geometry.chambers.find(c=>String(c.id)===String(gate?.physicalChamber)),x=patch.cadX??m[table][id].cadX,y=patch.cadY??m[table][id].cadY;
        if(patch.mapped&&ch&&Number.isFinite(x)&&Number.isFinite(y)&&(x<ch.bounds[0]-1||x>ch.bounds[2]+1||y<ch.bounds[1]-1||y>ch.bounds[3]+1))Domain.invalid('ShipDock coordinates are outside its Gate physical chamber: '+id);
      }m[table][id]={...m[table][id],...patch};}
    }
    m.roadGraph={...m.roadGraph,nodes:m.roadGraph.nodes.map(n=>{const ch=m.geometry.chambers.find(c=>n.x>=c.bounds[0]&&n.x<=c.bounds[2]&&n.y>=c.bounds[1]&&n.y<=c.bounds[3]);return {...n,physicalChamber:ch?.id??null};})};
      m.geometry.rackSlots=(m.geometry.rackSlots||[]).map(s=>({...s,...config.slotAnnotations?.[s.temporaryId]}));
      for(const slot of m.geometry.rackSlots||[]){
        if(!slot.temporaryId)continue;
        const ids=config.slotMappings?.[slot.temporaryId]||[];
        for(const id of ids){if(m.shipdocks[id])Domain.invalid('ShipDock '+id+' must map to Stage, not a pallet slot');const l=m.locations[id];if(!l)continue;const access=config.locationAccess?.[id]||config.locationAccess?.[l.baseLocation],start=access?.accessPath?.[0],same=l.cadSlotId===slot.id||!!(start&&Math.hypot(start[0]-slot.cadX,start[1]-slot.cadY)<.01);
          m.locations[id]={...l,cadX:slot.cadX,cadY:slot.cadY,cadSlotId:slot.id,temporarySlotId:slot.temporaryId,physicalChamber:slot.physicalChamber,active:slot.active!==false,mapped:true,confidence:'USER_CONFIRMED_SLOT',mappingSource:'USER_SLOT_MAPPING',accessValidated:same&&!!l.accessValidated,roadNodeId:same?l.roadNodeId:null};
        }
      }
      const shippingStages=Layout.shippingStages(m.geometry),shippingIds=new Set(shippingStages.map(s=>s.id));
      for(const area of Layout.areaTargets(m.geometry))for(const id of [...new Set([...(config.objectMappings?.[area.temporaryId]||[]),...(['PRINTER','AGV'].includes(area.kind)?[area.temporaryId]:[])])]){
        if(m.shipdocks[id]&&!shippingIds.has(area.id))Domain.invalid('ShipDock '+id+' must map to Stage');
        const location=m.locations[id]||{location_id:id,baseLocation:id,chamber:area.physicalChamber,gridX:null,gridY:null,loc_type:area.kind==='CONTROL'?'Control':area.kind==='PRINTER'?'Printer':area.kind==='AGV'?'AGV':area.kind==='STAGE'?'Stage':'FloorStorage'};
        const placementValidated=!area.documentaryOnly||config.documentaryGeometryValidated?.[area.temporaryId]===true;
        m.locations[id]={...location,cadX:area.cadX??(Layout.bounds(area.points)[0]+Layout.bounds(area.points)[2])/2,cadY:area.cadY??(Layout.bounds(area.points)[1]+Layout.bounds(area.points)[3])/2,temporaryObjectId:area.temporaryId,active:area.active!==false,physicalChamber:area.physicalChamber,mapped:placementValidated,confidence:placementValidated?'USER_CONFIRMED_OBJECT':'DOCUMENTARY_SCHEMATIC',mappingSource:placementValidated?'USER_OBJECT_MAPPING':'DOCUMENTARY_OBJECT_MAPPING',accessValidated:false,roadNodeId:null};
      }
      // A physical stage is its own endpoint, never the coordinate of its Gate.
      const canonical=Domain.normalize(m),owners=new Map();m.shipdocks={...canonical.shipdocks};
      for(const area of shippingStages){
        const ids=config.objectMappings?.[area.temporaryId]||[];
        // Documentary names/city codes are not WMS ShipDock IDs. Keep them out
        // of the operational endpoint registry until the operator assigns an ID.
        if(area.documentaryOnly&&!ids.length)continue;
        const boundGates=new Set(ids.map(id=>canonical.shipdocks[id]?.physicalGateId).filter(Boolean));if(boundGates.size>1)Domain.invalid('Adresy jednego Stage muszą należeć do tej samej rampy: '+area.temporaryId);
        for(const id of ids.length?ids:[area.temporaryId]){
          if(!id)continue;
          if(owners.has(id))Domain.invalid('ShipDock '+id+' assigned to two stages');owners.set(id,area.temporaryId);
          const old=m.shipdocks[id]||{shipDockId:id,active:true,physicalGateId:Domain.prefix(id)};
          const gate=canonical.gates[old.physicalGateId],b=Layout.bounds(area.points),valid=!!gate&&String(gate.physicalChamber)===String(area.physicalChamber);
          if(gate&&!valid)Domain.invalid(id+' stage is in K'+area.physicalChamber+' but its Gate is in K'+gate.physicalChamber);
          const x=area.cadX??(b[0]+b[2])/2,y=area.cadY??(b[1]+b[3])/2,start=config.shipdockAccess?.[id]?.accessPath?.[0];
          const samePoint=Number.isFinite(old.cadX)&&Number.isFinite(old.cadY)&&Math.hypot(old.cadX-x,old.cadY-y)<.01,
            explicitPort=Array.isArray(start)&&start.every(Number.isFinite)&&start[0]>=b[0]&&start[0]<=b[2]&&start[1]>=b[1]&&start[1]<=b[3],access=valid&&old.accessValidated&&(samePoint||explicitPort);
          const placementValidated=!area.documentaryOnly||config.documentaryGeometryValidated?.[area.temporaryId]===true,mapped=valid&&placementValidated;
          m.shipdocks[id]={...old,active:area.active!==false&&old.active!==false,operationMode:Domain.operationMode(area,old.operationMode||'OUTBOUND'),physicalGateId:gate?.gateId??null,physicalChamber:gate?.physicalChamber??null,cadX:x,cadY:y,temporaryObjectId:area.temporaryId,mapped,confidence:mapped?'USER_CONFIRMED_OBJECT':valid?'DOCUMENTARY_SCHEMATIC':'NEEDS_VALIDATION',mappingSource:mapped?'USER_STAGE_MAPPING':valid?'DOCUMENTARY_STAGE_MAPPING':'UNRESOLVED_STAGE',accessValidated:!!(access&&mapped),roadNodeId:access&&mapped?old.roadNodeId:null};
        }
      }
      // Labels are a projection of current addresses unless the operator has
      // explicitly supplied a different name. Stable technical IDs never change.
      const userNames=new Map((config.layoutObjects||[]).map(o=>[o.id,o.name]));
      for(const key of ['rackSlots','stageAreas','floorAreas','controlAreas'])m.geometry[key]=(m.geometry[key]||[]).map(o=>{
        const first=(config.slotMappings?.[o.temporaryId]||config.objectMappings?.[o.temporaryId]||[])[0],fallback=o.documentaryLabel||o.label||o.temporaryId||o.id;
        const saved=config.objectEdits?.[o.id]?.name??userNames.get(o.id),custom=typeof saved==='string'&&saved.trim()&&![o.temporaryId,o.id,o.documentaryLabel,o.label].includes(saved.trim())?saved.trim():'';
        return {...o,defaultName:first||fallback,displayName:custom||first||fallback,nameIsCustom:!!custom,...(config.documentaryGeometryValidated?.[o.temporaryId]===true?{placementValidated:true}:{})};
      });
      m.geometry.gateAccessTargets=Object.entries(m.gates).filter(([,g])=>Number.isFinite(g.cadX)&&Number.isFinite(g.cadY)).map(([id,g])=>({...g,temporaryId:'GATE:'+id,id:'GATE:'+id,kind:'GATE',points:Array.from({length:4},()=>[g.cadX,g.cadY])}));
      m.alignment=fit;return Domain.normalize(m);
  }
    function bindStageToGate(base,config,temporaryId,shipDockId,physicalGateId){
      const current=applyCalibration(base,config),id=Domain.key(shipDockId),gateId=Domain.key(physicalGateId),gate=current.gates[gateId],area=Layout.shippingStages(current.geometry).find(s=>s.temporaryId===temporaryId);
      if(!area)Domain.invalid('Nieznany stage: '+temporaryId);
      if(!id||id.length>80||!/^[A-Z0-9][A-Z0-9._/-]*$/.test(id))Domain.invalid('Wpisz poprawny numer / kod ShipDocku.');
      if(!gate||gate.active===false)Domain.invalid('Nieznana lub nieaktywna rampa: '+gateId);
      if(String(area.physicalChamber)!==String(gate.physicalChamber))Domain.invalid('Stage i rampa muszą być w tej samej komorze.');
      const existing=current.shipdocks[id];Domain.assertPatch(id,existing,{physicalGateId:gateId});
      const oldStage=existing?.temporaryObjectId;if(oldStage&&oldStage!==temporaryId)Domain.invalid(id+' jest już przypisany do '+oldStage);
      for(const [temp,ids]of Object.entries({...config.slotMappings,...config.objectMappings}))if(temp!==temporaryId&&ids.includes(id))Domain.invalid(id+' jest już przypisany do '+temp);
      if(current.locations[id]&&!existing)Domain.invalid(id+' jest lokalizacją magazynową. Wybierz osobny kod ShipDocku.');
      const objectMappings=Layout.assignLocations(current.geometry,config,{...current.locations,...current.shipdocks},temporaryId,id);
      const next={...config,objectMappings,shipdocks:{...config.shipdocks,[id]:{...config.shipdocks?.[id],physicalGateId:gateId,bindingValidated:true,mappingSource:'USER_CONFIRMED_GATE_STAGE',operationMode:Domain.operationMode(area),active:existing?.active!==false}}};
      applyCalibration(base,next);return next;
    }
    function exportSlotCsv(geometry,mappings={}){
      return '\uFEFFTEMP_ID;LOCATION_IDS\r\n'+(geometry.rackSlots||[]).filter(s=>s.temporaryId).sort((a,b)=>a.number-b.number).map(s=>s.temporaryId+';'+(mappings[s.temporaryId]||[]).join('|')).join('\r\n')+'\r\n';
    }
    function mergeOverheadMappings(config,source,geometry){
      for(const[revisionKey,mapKey]of [['overheadMappingRevision','overheadSlotMappings'],['k2PassageMappingRevision','k2PassageSlotMappings']]){
      if(source[revisionKey]&&config[revisionKey]!==source[revisionKey]){
        const mappings={...config.slotMappings},owned=new Set(Object.values({...mappings,...config.objectMappings}).flat()),targets=geometry?new Set(geometry.rackSlots.map(s=>s.temporaryId)):null;
        for(const[temp,ids]of Object.entries(source[mapKey]||{})){
          if(targets&&!targets.has(temp)||config.objectEdits?.[temp]?.deleted||Object.hasOwn(mappings,temp)&&mappings[temp].length===0)continue;
          // An existing unrelated assignment is an operator's decision.
          if(mappings[temp]?.some(id=>!ids.includes(id)))continue;
          const additional=ids.filter(id=>!owned.has(id));
          if(additional.length){mappings[temp]=[...(mappings[temp]||[]),...additional];additional.forEach(id=>owned.add(id));}
        }
        config={...config,slotMappings:mappings,[revisionKey]:source[revisionKey]};
      }
      }
      return config;
    }
    function mergeHeightMappings(config,source,geometry){
      config=mergeOverheadMappings(config,source,geometry);
      if(!source.heightMappingRevision||config.heightMappingRevision===source.heightMappingRevision)return config;
      const groups=new Map(),pattern=/^(\d{2}R\d{4}[A-Z])(\d+)$/;
      for(const ids of Object.values(source.slotMappings||{}))for(const id of ids){const match=pattern.exec(id);if(match){if(!groups.has(match[1]))groups.set(match[1],[]);groups.get(match[1]).push(id);}}
      const slots=geometry?new Map((geometry.rackSlots||[]).map(s=>[s.temporaryId,s])):null;
      const mappings={...config.slotMappings},owned=new Set(Object.values({...mappings,...config.objectMappings}).flat());
      for(const[temp,ids]of Object.entries(mappings)){
        if(slots&&!slots.has(temp))continue;
        const additional=[];
        for(const id of ids)for(const height of groups.get(id)||[])if(!owned.has(height)){
          if(slots&&String(Number(id.slice(0,2)))!==String(slots.get(temp).physicalChamber))continue;
          additional.push(height);owned.add(height);
        }
        if(additional.length)mappings[temp]=[...ids,...additional];
      }
      return {...config,slotMappings:mappings,heightMappingRevision:source.heightMappingRevision};
    }
    function mergeSourceSlotMappings(config,source,geometry){
      config=expandCalibration(config,source);
      if(geometry)config=Layout.pruneRemoved(geometry,config);
      // A restored physical slot fills its former WMS defaults once. Respect
      // locally cleared targets and addresses already assigned elsewhere.
      const restored=geometry?.restoredSlotDefaults;
      if(restored&&config.restoredSlotDefaultsRevision!==restored.revision){
        const slotMappings={...config.slotMappings},owned=new Set(Object.values({...slotMappings,...config.objectMappings}).flat());
        for(const[temp,ids]of Object.entries(restored.mappings||{}))if(!Object.hasOwn(slotMappings,temp)){
          const available=ids.filter(id=>!owned.has(id));if(available.length){slotMappings[temp]=available;available.forEach(id=>owned.add(id));}
        }
        config={...config,slotMappings,restoredSlotDefaultsRevision:restored.revision};
      }
      if(source.objectMappingRevision&&config.objectMappingRevision!==source.objectMappingRevision){
        // Documentary defaults fill empty targets once. Existing ownership and
        // locally cleared/reassigned fields remain the operator's decision.
        const objectMappings={...config.objectMappings},owned=new Set(Object.values({...config.slotMappings,...objectMappings}).flat());
        for(const[temp,ids]of Object.entries(source.objectMappings||{}))if(!Object.hasOwn(objectMappings,temp)&&!ids.some(id=>owned.has(id))){objectMappings[temp]=[...ids];ids.forEach(id=>owned.add(id));}
        config={...config,objectMappings,objectMappingRevision:source.objectMappingRevision};
      }
      if(source.gateMappingRevision&&config.gateMappingRevision!==source.gateMappingRevision){
        const ids=source.gateMappingChangedIdsByRevision?.[config.gateMappingRevision]||(source.gateMappingPreviousRevision===config.gateMappingRevision?source.gateMappingChangedIds:null);
        const updates=Array.isArray(ids)?Object.fromEntries(ids.filter(id=>source.gates?.[id]).map(id=>[id,source.gates[id]])):source.gates;
        config={...config,gates:{...config.gates,...updates},gateMappingRevision:source.gateMappingRevision};
      }
      if(!source.slotMappingRevision||config.slotMappingRevision===source.slotMappingRevision)return mergeHeightMappings(config,source,geometry);
      const changeIds=source.slotMappingChangedIdsByRevision?.[config.slotMappingRevision]||(source.slotMappingPreviousRevision===config.slotMappingRevision?source.slotMappingChangedIds:null);
      const changed=Array.isArray(changeIds)?new Set(changeIds):null;
      const pendingHeights=source.heightMappingRevision&&config.heightMappingRevision!==source.heightMappingRevision;
      // Independently versioned passage defaults must keep their own ownership
      // and clearing rules. Filtering their height-only IDs here would create
      // an empty mapping indistinguishable from an operator's explicit removal.
      const extensionTargets=new Set([...Object.keys(source.overheadSlotMappings||{}),...Object.keys(source.k2PassageSlotMappings||{})]);
      const incoming=Object.fromEntries(Object.entries(source.slotMappings||{}).filter(([temp])=>!extensionTargets.has(temp)&&(!changed||changed.has(temp))).map(([temp,ids])=>[temp,pendingHeights?ids.filter(id=>!/^\d{2}R\d{4}[A-Z]\d+$/.test(id)):ids])),annotations=Object.fromEntries(Object.entries(source.slotAnnotations||{}).filter(([temp])=>(!changed||changed.has(temp))&&(!extensionTargets.has(temp)||!Object.hasOwn(config.slotAnnotations||{},temp)))),owned=new Set(Object.values(incoming).flat()),mappings={};
      // An explicit empty mapping is an operator decision, not a missing
      // source default. Keep it when migrating unrelated source targets.
      for(const [temp,ids]of Object.entries(config.slotMappings||{})){const kept=ids.filter(id=>!owned.has(id));if(kept.length||ids.length===0)mappings[temp]=kept;}
      if(changed)for(const temp of changed)if(!extensionTargets.has(temp))delete mappings[temp];
      for(const temp of Object.keys(annotations))if(!extensionTargets.has(temp))delete mappings[temp];
      const keptAnnotations={...config.slotAnnotations};if(changed)for(const temp of changed)if(!extensionTargets.has(temp))delete keptAnnotations[temp];
      return mergeHeightMappings({...config,slotMappings:{...mappings,...incoming},slotAnnotations:{...keptAnnotations,...annotations},userLocationDefinitions:{...config.userLocationDefinitions,...source.userLocationDefinitions},rackLayoutRevisions:{...config.rackLayoutRevisions,...source.rackLayoutRevisions},...(source.k1ExcelLayout?{k1ExcelLayout:source.k1ExcelLayout,k1CopyLayout:source.k1CopyLayout}:{}),...(source.k2ExcelCompletion?{k2ExcelCompletion:source.k2ExcelCompletion}:{}),...(source.sourceLayoutCorrections?{sourceLayoutCorrections:source.sourceLayoutCorrections}:{}),slotMappingRevision:source.slotMappingRevision},source,geometry);
    }
    function expandCalibration(config,source){
      if(config.sourceDefaultsVersion!==1)return config;
      const expanded={...config};
      for(const key of ['slotMappings','slotAnnotations','userLocationDefinitions']){
        expanded[key]={...source[key],...config[key]};
        for(const id of config.sourceDefaultsDeleted?.[key]||[])delete expanded[key][id];
      }
      delete expanded.sourceDefaultsVersion;delete expanded.sourceDefaultsDeleted;
      return expanded;
    }
    // Explicit one-time operator approval of the current geometry. This does
    // not infer addresses, Gate bindings, road access or future approvals.
    function approveCurrentGeometry(base,config){
      const model=applyCalibration(base,config),documentaryGeometryValidated={...config.documentaryGeometryValidated},gates={...config.gates};
      for(const o of Layout.editTargets(model.geometry))if(o.temporaryId)documentaryGeometryValidated[o.temporaryId]=true;
      for(const [id,g]of Object.entries(model.gates)){
        if(!Number.isFinite(g.cadX)||!Number.isFinite(g.cadY))continue;
        gates[id]={...gates[id],mapped:true};
      }
      return {...config,documentaryGeometryValidated,gates};
    }
    function serializeCalibration(config,source){
      // Migration history belongs to the bundled source. Local updates only
      // need their revision stamps; keep all operator data and current mappings.
      const saved={...config};
      for(const key of ['slotMappingChangedIdsByRevision','slotMappingChangedIds','slotMappingPreviousRevision','gateMappingChangedIdsByRevision','gateMappingChangedIds','gateMappingPreviousRevision'])delete saved[key];
      if(source){
        saved.sourceDefaultsVersion=1;saved.sourceDefaultsDeleted={};
        for(const key of ['slotMappings','slotAnnotations','userLocationDefinitions']){
          const current=config[key]||{},defaults=source[key]||{};
          saved[key]=Object.fromEntries(Object.entries(current).filter(([id,value])=>JSON.stringify(value)!==JSON.stringify(defaults[id])));
          saved.sourceDefaultsDeleted[key]=Object.keys(defaults).filter(id=>!Object.hasOwn(current,id));
        }
      }
      return JSON.stringify(saved);
    }
    function importSlotCsv(text,geometry,locations,previous={},objectMappings={}){
      const lines=text.replace(/^\uFEFF/,'').trim().split(/\r?\n/),separator=lines[0]?.includes(';')?';':',';
      const split=line=>{const result=[];let field='',quote=false;for(let i=0;i<line.length;i++){const c=line[i];if(c==='"'){if(quote&&line[i+1]==='"'){field+='"';i++;}else quote=!quote;}else if(c===separator&&!quote){result.push(field.trim());field='';}else field+=c;}if(quote)throw Error('Niezamknięty cudzysłów w CSV.');result.push(field.trim());return result;};
      const header=split(lines.shift()),a=header.indexOf('TEMP_ID'),b=header.indexOf('LOCATION_IDS');if(a<0||b<0)throw Error('Wymagane kolumny: TEMP_ID i LOCATION_IDS.');
      const slots=new Map((geometry.rackSlots||[]).filter(s=>s.temporaryId).map(s=>[s.temporaryId,s])),result={...previous},seen=new Set();
      for(const line of lines){if(!line.trim())continue;const row=split(line),temp=row[a]?.toUpperCase(),slot=slots.get(temp);if(!slot)throw Error('Nieznany numer miejsca: '+temp);if(seen.has(temp))throw Error('Powtórzony numer miejsca: '+temp);seen.add(temp);const ids=(row[b]||'').toUpperCase().split('|').map(s=>s.trim()).filter(Boolean);
        for(const id of ids){const l=locations[id];if(!l)throw Error('Nieznana lokalizacja WMS: '+id);if(l.physicalChamber!==slot.physicalChamber)throw Error('Lokalizacja z innej komory: '+id);}
        if(new Set(ids).size!==ids.length)throw Error('Powtórzona lokalizacja dla '+temp);if(ids.length)result[temp]=ids;else delete result[temp];
      }
      const owners=new Map(Object.entries(objectMappings||{}).flatMap(([temp,ids])=>ids.map(id=>[id,temp])));for(const [temp,ids]of Object.entries(result))for(const id of ids){if(owners.has(id))throw Error('Lokalizacja '+id+' przypisana do dwóch miejsc.');owners.set(id,temp);}return result;
    }
  Object.assign(DG,{SpatialEngine,DistanceProvider,fitAlignment,applyCalibration,approveCurrentGeometry,bindStageToGate,exportSlotCsv,importSlotCsv,mergeSourceSlotMappings,serializeCalibration,expandCalibration});
  if(typeof module==='object'&&module.exports)module.exports={SpatialEngine,DistanceProvider,fitAlignment,applyCalibration,approveCurrentGeometry,bindStageToGate,exportSlotCsv,importSlotCsv,mergeSourceSlotMappings,serializeCalibration,expandCalibration};
})(globalThis);
