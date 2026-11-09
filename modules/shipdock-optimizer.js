(function(root){
  'use strict';
  const DG=root.DG=root.DG||{},Domain=DG.ShipDockDomain||(typeof require==='function'?require('./shipdock-domain.js'):null),Rules=DG.PlanningRules||(typeof require==='function'?require('./planning-rules.js'):null);
  const empty=load=>({cost:null,mappedUnits:0,proxyUnits:0,totalUnits:(load.tasks||[]).reduce((s,t)=>{const q=Number(t.quantity);return s+(Number.isFinite(q)&&q>0?q:0);},0)});
  function planningReasons(load,{time=true,cache}={}){
    if(!cache)return computePlanningReasons(load,time);
    let reasons=cache.get(load);if(!reasons){reasons=new Map();cache.set(load,reasons);}
    if(!reasons.has(time))reasons.set(time,computePlanningReasons(load,time));
    return [...reasons.get(time)];
  }
  function computePlanningReasons(load,time){
    if(load.cancelled)return ['SHIPMENT_CANCELLED'];
    if(time&&load.priorityReviewRequired)return ['VEHICLE_PRIORITY_REQUIRED'];
    if(time&&load.appointmentSelectionRequired)return ['APPOINTMENT_SELECTION_REQUIRED'];
    if(time&&load.arrivalBlockedReason)return [load.arrivalBlockedReason];
    if(time&&load.workloadSource==='LAST_PICK_POC'){const L=DG.LastPickImport||(typeof require==='function'?require('./last-pick-import.js'):null);if(!L?.storeReady(load))return ['STORE_REQUIRED'];}
    try{Rules.orderType(load);}catch(_){return ['ORDER_TYPE_CONFLICT'];}
    if(load.workloadSource==='LS'){
      const L=DG.LSImport||(typeof require==='function'?require('./ls-import.js'):null);
      try{L.validateLoad(load);}catch(_){return ['LS_CONTRACT_INVALID'];}
      return [...new Set([...(load.mtm?.reviewReasons||[]),...(load.mtm?.absent?['MTM_ABSENT']:[]),...(load.mtm?.quantityConfirmed===true?[]:['LS_PALLET_UNIT_UNCONFIRMED'])])];
    }
    if(load.workloadSource!=='MTM')return [];
    const m=load.mtm||{},reasons=[...(m.reviewReasons||[])];
    if(time&&!(DG.MTMImport||(typeof require==='function'?require('./mtm-import.js'):null))?.storeConfirmed(load))reasons.push('MTM_STORE_UNCONFIRMED');
    if(m.absent)reasons.push('MTM_ABSENT');
    if(m.quantityConfirmed!==true)reasons.push('MTM_TOTAL_UNCONFIRMED');
    for(const t of load.tasks||[]){if(t.mtm_status==='Hold')reasons.push('MTM_HOLD');else if(t.mtm_status==='In Progress')reasons.push('MTM_IN_PROGRESS');else if(t.mtm_status!=='Released')reasons.push('MTM_STATUS_UNKNOWN');}
    const dated=load.schedulingDateValidated||load.loading_date&&load.loading_time||/^\d{4}-\d{2}-\d{2}T/.test(String(load.estimated_arrival_at||load.eta||load.loading_start||load.loadingWindow?.start||''));
    return [...new Set(reasons)];
  }
  function leg(engine,from,to,options){
    const cache=options.distanceCache,key=JSON.stringify([from,to]);if(cache?.has(key))return cache.get(key);
    const result=engine.distance(from,to,options.routingContext);if(cache&&cache.size<30000)cache.set(key,{mapped:result?.mapped,distanceMeters:result?.distanceMeters,reason:result?.reason});return result;
  }
  function costFor(load,shipDockId,engine,options={}){
    const result=empty(load);let sum=0;
    if(planningReasons(load,{time:false,cache:options.planningReasonCache}).length)return result;
    if(load.workloadSource==='LS')for(const task of load.tasks)if(!DG.LSImport.sameEndpoint(task.source_location_candidates,engine))return {...result,reason:'LS_LAST_PICK_AMBIGUOUS'};
    if(!engine.getShipDock(shipDockId)?.mapped)return {...result,reason:'STAGE_NOT_MAPPED',endpointId:shipDockId};
    for(const task of load.tasks||[]){const quantity=Number(task.quantity);if(!Number.isFinite(quantity)||quantity<=0)continue;
      const inbound=Domain.activity(load)==='INBOUND',location=inbound?task.destination_location:task.source_location;
      if(!location){if(!result.reason)Object.assign(result,{reason:'TASK_LOCATION_MISSING',taskIndex:load.tasks.indexOf(task)});continue;}
      const rawWaypoints=task.required_waypoints||[];
      if(!Array.isArray(rawWaypoints)||rawWaypoints.length>20||rawWaypoints.some(id=>typeof id!=='string'||!id)){result.reason??='REQUIRED_WAYPOINT_INVALID';continue;}
      const exempt=Rules.controlExempt(task,load,options.priorityControlCache),waypoints=exempt?rawWaypoints.filter(id=>!Rules.isControlPoint(id,engine)):rawWaypoints;
      const controls=Rules.controls(task,load,engine,options.planningRules||{},options.controlIndexCache,options.priorityControlCache);
      const printing=Rules.printing(task,load,engine,options.planningRules||{},options.printerIndexCache,options.priorityControlCache);
      if(printing.unknown){result.reason??='PRINTER_RULE_DATA_UNAVAILABLE';continue;}
      if(printing.required&&!printing.ids.length){result.reason??='REQUIRED_PRINTER_UNAVAILABLE';continue;}
      if(controls&&!controls.length){result.reason??='REQUIRED_CONTROL_UNAVAILABLE';continue;}
      let best=null,failure=null;
      for(const printer of printing.required?printing.ids:[null])for(const control of controls||[null]){
        const middle=[...(printer?[printer]:[]),...waypoints,...(control?[control]:[])],path=inbound?[shipDockId,...middle,location]:[location,...middle,shipDockId];let meters=0,complete=true;
        for(let i=1;i<path.length;i++){if(path[i-1]===path[i])continue;const d=leg(engine,path[i-1],path[i],options);if(!d?.mapped||!Number.isFinite(d.distanceMeters)||d.distanceMeters<0){failure??={from:path[i-1],to:path[i],reason:d?.reason||(d?.mapped&&d.distanceMeters==null?'DISTANCE_NOT_CALIBRATED':'SPATIAL_ROUTE_UNAVAILABLE')};complete=false;break;}meters+=d.distanceMeters;}
        if(complete&&(!best||meters<best.meters))best={printer,control,path,meters};
      }
      if(!best){if(!result.reason){result.reason=printing.required?'REQUIRED_PRINTER_ROUTE_UNAVAILABLE':controls?'REQUIRED_CONTROL_UNAVAILABLE':waypoints.length?'REQUIRED_WAYPOINT_ROUTE_UNAVAILABLE':'SPATIAL_ROUTE_UNAVAILABLE';result.taskIndex=load.tasks.indexOf(task);if(failure)result.failedLeg=failure;}continue;}
      sum+=quantity*best.meters;result.mappedUnits+=quantity;
      if(best.printer){(result.printingRoutes??=[]).push({taskIndex:load.tasks.indexOf(task),printerId:best.printer,controlId:best.control,waypoints:best.path,meters:best.meters,quantity});}
      if(options.captureRoutes)(result.routes??=[]).push({taskIndex:load.tasks.indexOf(task),waypoints:best.path,meters:best.meters,quantity});

    }
    // A partial cost cannot be compared with the full workload of another candidate.
    if(!result.totalUnits||result.mappedUnits!==result.totalUnits)return result;
    if(options.includeStageToGate){const inbound=Domain.activity(load)==='INBOUND',leg=inbound?engine.distanceGateToShipDock?.(shipDockId,options.routingContext):engine.distanceShipDockToGate?.(shipDockId,options.routingContext);if(!leg?.mapped||!Number.isFinite(leg.distanceMeters)||leg.distanceMeters<0){const gate=engine.getGateForShipDock?.(shipDockId)?.gateId||engine.getShipDock(shipDockId)?.physicalGateId;result.reason='STAGE_GATE_ROUTE_UNAVAILABLE';result.failedLeg={from:inbound?'GATE:'+(gate||'?'):shipDockId,to:inbound?shipDockId:'GATE:'+(gate||'?'),reason:leg?.reason||'SPATIAL_ROUTE_UNAVAILABLE'};return result;}sum+=result.totalUnits*leg.distanceMeters;}
    result.cost=sum;return result;
  }
  function interval(load,kind,options={}){
    if(kind==='staging'&&Domain.activity(load)==='INBOUND'&&!load.stagingWindow&&!load.staging_window&&!load.staging_start&&!load.staging_end){const w=interval(load,'loading',options);return {start:w.start,end:w.end+(options.stagingAfterMinutes||0)};}
    const w=load[kind+'Window']||load[kind+'_window']||((load.start!=null||load.end!=null)?load:null);
    const parse=value=>{
      if(value==null||value==='')return null;if(typeof value==='number'&&!Number.isNaN(value))return value;
      const s=String(value),m=/^(\d{1,2}):(\d{2})$/.exec(s);
      if(m){
        if(Number(m[1])>23||Number(m[2])>59)Domain.invalid('Invalid clock time for '+load.load_id);
        let day=String(load.loading_date||load.date||'');if(/^\d{8}$/.test(day))day=day.slice(0,4)+'-'+day.slice(4,6)+'-'+day.slice(6,8);
        const origin=day?Date.parse(day+'T00:00:00Z')/60000:0;
        if(!Number.isFinite(origin)||day&&new Date(origin*60000).toISOString().slice(0,10)!==day)Domain.invalid('Invalid date for '+load.load_id);
        return origin+Number(m[1])*60+Number(m[2]);
      }
      const t=Date.parse(s);return Number.isFinite(t)?t/60000:null;
    };
    const start=parse(w?.start??load[kind+'_start']??(kind==='loading'?(load.estimated_arrival_at||load.eta||load.loading_time):null));
    let end=parse(w?.end??load[kind+'_end']);
    if(start==null)return {start:-Infinity,end:Infinity};
    if(end==null&&kind==='loading')end=start+Number(load.loading_duration_minutes??options.defaultLoadingMinutes??60);
    if(end!=null&&end<start&&/^\d{1,2}:\d{2}$/.test(String(w?.end??load[kind+'_end'])))end+=1440;
    if(end==null&&kind==='staging')end=Infinity;
    if(!(Number.isFinite(end)||end===Infinity&&(kind==='staging'||w?.end===Infinity))||end<=start)Domain.invalid('Invalid '+kind+' window for '+load.load_id);
    return {start,end};
  }
  function stageInterval(load,dock,options={}){
    if(options.stageWindowMode==='CONFIRMED_RELEASE')return {start:-Infinity,end:Infinity};
    const explicit=load.stagingWindow||load.staging_window||load.staging_start||load.staging_end;
    if(!explicit&&Domain.operationMode(dock)==='DYNAMIC'){const w=interval(load,'loading',options);return {start:w.start-(Domain.activity(load)==='OUTBOUND'?(options.stagingBeforeMinutes||0):0),end:w.end+(options.stagingAfterMinutes||0)};}
    return interval(load,'staging',options);
  }
  const overlaps=(a,b)=>a.start<b.end&&b.start<a.end;
  function feasible(load,dock,model,gateStates,shipDockStates,reservations,options,fixedAssignment=false){
    const problems=planningReasons(load,{cache:options.planningReasonCache});if(problems.length)return problems[0];
    if(options.planningRules&&!String(load.store||'').trim())return 'STORE_REQUIRED';
    if(!dock?.physicalGateId)return 'SHIPDOCK_NEEDS_VALIDATION';
    const gate=model.gates[dock.physicalGateId],gs=gateStates[dock.physicalGateId]||{},ss=shipDockStates[dock.shipDockId]||{};
    if(!dock.active||!gate?.active)return 'INACTIVE_RESOURCE';
    if(!Rules.allowedDirection(load,dock,options.planningRules))return 'FIXED_DIRECTION_MISMATCH';
    const flow=Domain.activity(load);
    if(!Domain.allows(dock,flow))return 'STAGE_ACTIVITY_MISMATCH';
    if(!Domain.allows(gate,flow,'DYNAMIC'))return 'GATE_ACTIVITY_MISMATCH';
    if((gs.state||gate.state||'AVAILABLE')!=='AVAILABLE'||gs.leftovers)return 'GATE_UNAVAILABLE';
    if((ss.state||dock.state||'AVAILABLE')!=='AVAILABLE')return 'SHIPDOCK_UNAVAILABLE';
    if(gs.occupiedVehicle&&!gs.occupiedLoadIds?.includes(load.load_id)&&gs.occupiedShipment!==Rules.shipment(load))return 'GATE_UNAVAILABLE';
    const loading=interval(load,'loading',options),staging=stageInterval(load,dock,options),stage=dock.temporaryObjectId||dock.shipDockId;
    if(load.inheritedAssignment&&(!load.arrivalStageIds?.includes(stage)||!load.arrivalGateIds?.includes(gate.gateId)))return 'ARRIVAL_STAGE_REQUIRED';
    if(flow==='INBOUND'&&(!Number.isFinite(loading.start)||!Number.isFinite(loading.end)))return 'INBOUND_ETA_REQUIRED';
    const entries=reservations.filter(r=>r.loadId!==load.load_id);
    if(entries.some(r=>r.shipment===Rules.shipment(load)&&r.stage!==stage&&(!fixedAssignment||(r.gate||Object.values(model.shipdocks).find(s=>(s.temporaryObjectId||s.shipDockId)===r.stage)?.physicalGateId)!==gate.gateId))&&!load.inheritedAssignment)return 'SHIPMENT_STAGE_CONFLICT';
    if(entries.some(r=>r.stage===stage&&overlaps(r.staging,staging)&&!(r.shipment===Rules.shipment(load)&&Rules.sameStores(r.store,load.store,options.planningRules))&&!load.arrivalSourceIds?.includes(r.loadId)))return 'STAGE_OCCUPIED';
    const stageCapacity=Rules.resource(options.planningRules,'STAGE',stage).capacity;
    if(load.inheritedAssignment&&stageCapacity!=null&&Rules.quantity(load)+[...new Map(entries.filter(r=>r.stage===stage&&overlaps(r.staging,staging)).map(r=>[r.loadId,r])).values()].reduce((sum,r)=>sum+(r.quantity||0),0)>stageCapacity)return 'ARRIVAL_STAGE_FULL';
    for(const entry of [...(ss.calendar||[]),...(dock.calendar||[])])if(overlaps(interval(entry,'staging',options),staging)&&entry.available!==true)return 'STAGE_CALENDAR_BLOCKED';
    if(load.loadingScheduled===false)return null;
    const capacity=gs.loadingCapacity??gate.loadingCapacity??(gs.allowConcurrentLoading===true||gate.allowConcurrentLoading===true?Infinity:1);
    if(!(capacity>=1))return 'GATE_UNAVAILABLE';
    const calendars=gs.scheduleCalendar?(gs.calendar||[]):[...(gs.calendar||[]),...(gate.calendar||[])];
    const booked=calendars.filter(r=>r.reservation&&r.loadId!==load.load_id&&r.shipment!==Rules.shipment(load)&&(!r.loadId||!entries.some(e=>e.loadId===r.loadId&&e.gate===gate.gateId))).map(r=>({loading:interval(r,'loading',options),activity:Domain.activity(r)}));
    const conflicts=[...new Map(entries.filter(r=>r.gate===gate.gateId&&r.shipment!==Rules.shipment(load)).map(r=>[r.shipment||r.loadId,r])).values(),...booked].filter(r=>overlaps(r.loading,loading));
    if(conflicts.some(r=>Domain.activity(r)!==flow))return 'GATE_ACTIVITY_CONFLICT';
    // Sweep the clipped windows: pairwise overlaps need not be simultaneous.
    const events=conflicts.flatMap(r=>[[Math.max(r.loading.start,loading.start),1],[Math.min(r.loading.end,loading.end),-1]]).sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
    let count=0;for(const [,delta]of events){count+=delta;if(count>=capacity)return 'GATE_LOADING_CONFLICT';}
    for(const entry of calendars)if(!entry.reservation&&overlaps(interval(entry,'loading',options),loading)&&entry.available!==true)return 'GATE_CALENDAR_BLOCKED';
    return null;
  }
  function chooseShipDock(load,candidates,getCost,isFeasible){
    let best=null;for(const dock of candidates){if(isFeasible(dock))continue;const cost=getCost(dock.shipDockId);if(cost.cost!=null&&(!best||cost.cost<best.cost.cost))best={shipDock:dock,cost};}return best;
  }
  function proposalChoices(loadId,loads,data,gateStates={},decisions={},options={}){
    const engine=data.engine||data.distanceProvider?.engine;if(!engine?.model)Domain.invalid('SpatialEngine is required for proposal choices');
    const snapshot={loads:loads.filter(l=>!Rules.released({decisions},l.load_id)),assignments:data.assignments,decisions,proposalPins:options.proposalPins||{}},target=snapshot.loads.find(l=>l.load_id===loadId);
    if(!target)return {choices:[],excluded:[],reason:'LOAD_NOT_ACTIVE'};
    const fixed=l=>Domain.key(Rules.dockFor(snapshot,l));
    if(fixed(target))return {choices:[],excluded:[],reason:'ACCEPTED_ASSIGNMENT_IS_IMMUTABLE'};
    const pins=Rules.proposalPins(snapshot),base=Rules.arrivalLoads(snapshot,engine.model),claims=[...(options.reservations||[])],opts={...options,distanceCache:new Map(),planningReasonCache:new WeakMap(),controlIndexCache:new WeakMap(),printerIndexCache:new WeakMap(),priorityControlCache:new WeakMap(),routingContext:engine.createRoutingContext?.()||null},choices=[],excluded=[];
    for(const l of base){const id=fixed(l)||(l.load_id!==loadId?pins[l.load_id]?.shipDockId:'');
      if(id){const dock=engine.getShipDock(id);if(dock?.physicalGateId)claims.push(reservation(l,dock,opts));}
      if(l.workloadSource==='MTM'&&(l.mtm?.quarantined||l.mtm?.reviewReasons?.includes('MTM_FINAL_CONFLICT')))for(const observed of l.mtm.observedShipDocks||[]){if(observed===fixed(l))continue;const dock=engine.getShipDock(observed);if(dock?.physicalGateId)claims.push({...reservation(l,dock,opts),observation:true});}
    }
    for(const dock of Object.values(engine.model.shipdocks).sort((a,b)=>a.shipDockId.localeCompare(b.shipDockId,undefined,{numeric:true}))){
      const candidatePins={...pins,[loadId]:{shipDockId:dock.shipDockId,reason:'',allowGateChange:!!options.allowGateChange}},load=Rules.arrivalLoads({...snapshot,proposalPins:candidatePins},engine.model,loadId).find(l=>l.load_id===loadId),gate=engine.model.gates[dock.physicalGateId];
      let reason=(options.allowedGateIds!=null&&!options.allowedGateIds.includes(gate?.gateId)||options.allowedChambers!=null&&!options.allowedChambers.includes(String(gate?.physicalChamber)))?'RESOURCE_EXCLUDED_BY_SETTINGS':feasible(load,dock,engine.model,gateStates,data.shipDockStates||{},claims,opts);
      const cost=reason?null:costFor(load,dock.shipDockId,engine,opts);if(!reason&&cost?.cost==null)reason=cost.reason||'SPATIAL_COST_NEEDS_VALIDATION';
      if(reason){excluded.push({shipDockId:dock.shipDockId,physicalGateId:dock.physicalGateId,reason,...(cost?.failedLeg?{failedLeg:{...cost.failedLeg}}:{}),...(cost?.endpointId?{endpointId:cost.endpointId}:{}),...(cost?.taskIndex!=null?{taskIndex:cost.taskIndex}:{})});continue;}
      const capacity=Rules.resource(opts.planningRules,'STAGE',dock.temporaryObjectId||dock.shipDockId).capacity;
      choices.push({shipDockId:dock.shipDockId,physicalGateId:dock.physicalGateId,physicalChamber:dock.physicalChamber,cost:cost.cost,bufferOverlap:bufferOverlap(load,dock,gateStates,claims,opts),capacityWarning:capacity!=null&&Rules.quantity(load)>capacity});
    }
    return {choices,excluded,reason:null};
  }
  const reservation=(load,dock,options)=>{const loading=interval(load,'loading',options);return {loadId:load.load_id,shipment:Rules.shipment(load),store:load.store,quantity:Rules.quantity(load),activity:Domain.activity(load),stage:dock.temporaryObjectId||dock.shipDockId,gate:load.loadingScheduled===false?null:dock.physicalGateId,loading,bufferEnd:load.gateReservationEnd??loading.end+(Domain.activity(load)==='OUTBOUND'?(options.gateBufferMinutes||0):0),staging:stageInterval(load,dock,options)};};
  function bufferOverlap(load,dock,gateStates,reservations,options){
    if(load.loadingScheduled===false)return false;
    const own=reservation(load,dock,options),range={start:own.loading.start,end:own.bufferEnd};
    const others=reservations.filter(r=>r.gate===own.gate&&r.loadId!==load.load_id&&r.shipment!==own.shipment).map(r=>({start:r.loading.start,end:r.bufferEnd??r.loading.end}));
    for(const r of gateStates[own.gate]?.calendar||[])if(r.reservation&&r.loadId!==load.load_id&&r.shipment!==own.shipment){const w=interval(r,'loading',options);others.push({start:w.start,end:r.bufferWindow?.end??w.end});}
    return others.some(other=>overlaps(range,other));
  }
  function allocate(pending,candidates,getCost,isFeasible,existing,options){
    options.onProgress?.({stage:'allocation'});
    // Decisions are concrete ShipDocks. Gate calendars only constrain them.
    const priority=load=>load.vehiclePriority==='PRIORITY'?1:0;
    const work=pending.map(load=>({load,choices:candidates.filter(s=>!isFeasible(load,s,existing)&&getCost(load,s.shipDockId).cost!=null).map(s=>({dock:s,cost:getCost(load,s.shipDockId).cost})).sort((a,b)=>a.cost-b.cost)})).filter(w=>w.choices.length);
    work.sort((a,b)=>priority(b.load)-priority(a.load)||interval(a.load,'loading',options).start-interval(b.load,'loading',options).start);
    const levels=[...new Set(work.map(w=>priority(w.load)))].sort((a,b)=>b-a);
    const vehicle=load=>load.vehicleId?'VEHICLE:'+load.vehicleId:'SHIPMENT:'+Rules.shipment(load);
    // Count vehicles before consignments: extra groups of a later car cannot
    // outrank an earlier car at the same priority. Undated ties stay neutral.
    const rank=map=>levels.map(level=>{const members=work.filter(w=>priority(w.load)===level&&map.has(w.load.load_id)),vehicles=new Map();for(const {load}of members){const id=vehicle(load),time=load.loadingScheduled===false?Infinity:interval(load,'loading',options).start;vehicles.set(id,Math.min(vehicles.get(id)??Infinity,time));}return {vehicles:vehicles.size,rows:members.length,times:[...vehicles.values()].filter(Number.isFinite).sort((a,b)=>a-b)};});
    const compare=(a,b)=>{for(let i=0;i<a.length;i++){if(a[i].vehicles!==b[i].vehicles)return a[i].vehicles-b[i].vehicles;if(a[i].times.length===b[i].times.length)for(let j=0;j<a[i].times.length;j++)if(a[i].times[j]!==b[i].times[j])return b[i].times[j]-a[i].times[j];if(a[i].rows!==b[i].rows)return a[i].rows-b[i].rows;}return 0;};
    const greedy=new Map(),claims=[...existing];let bestCost=0;
    const groups=new Map(),stageId=d=>d.temporaryObjectId||d.shipDockId;for(const w of work){const id=vehicle(w.load);if(!groups.has(id))groups.set(id,[]);groups.get(id).push(w);}
    for(const members of groups.values()){
      if(members.length===1){const w=members[0],c=w.choices.find(c=>!isFeasible(w.load,c.dock,claims));if(c){greedy.set(w.load.load_id,c.dock);bestCost+=c.cost;claims.push(reservation(w.load,c.dock,options));}continue;}
      let selected=[],selectedCost=Infinity;
      for(const stage of new Set(members.flatMap(w=>w.choices.map(c=>stageId(c.dock))))){const trial=[],holds=[...claims];let cost=0;for(const w of members){const c=w.choices.find(c=>stageId(c.dock)===stage&&!isFeasible(w.load,c.dock,holds));if(c){trial.push({w,c});cost+=c.cost;holds.push(reservation(w.load,c.dock,options));}}if(trial.length>selected.length||trial.length===selected.length&&cost<selectedCost){selected=trial;selectedCost=cost;}}
      for(const {w,c}of selected){greedy.set(w.load.load_id,c.dock);bestCost+=c.cost;claims.push(reservation(w.load,c.dock,options));}
    }
    let best=greedy,bestCount=best.size,bestScore=rank(best),visited=0,limited=false;
    if(work.length>(options.maxExactLoads??32)){
      // Seed large plans with a joint minimum-cost matching, then validate Gate
      // calendars. Never report the bounded result as a proven global optimum.
      if(DG.minCostAssignment){
        const stages=[...new Set(candidates.map(d=>d.temporaryObjectId||d.shipDockId))];let max=1;for(const w of work)for(const c of w.choices)max=Math.max(max,c.cost);
        const penalty=(max+1)*(work.length+1),lookup=work.map(w=>{const map=new Map();for(const c of w.choices){const id=c.dock.temporaryObjectId||c.dock.shipDockId;if(!map.has(id))map.set(id,c);}return map;}),unassigned=w=>penalty*(1+levels.length-levels.indexOf(priority(w.load))),transpose=stages.length<work.length;
        // With many loads and fewer Stages, match Stage rows to load columns.
        // An assigned load removes its unassigned penalty. Dummy Stage columns
        // cost zero. This is the same matching seed without N-load dummy rows;
        // the vehicle/ETA rank is checked against the grouped greedy seed below.
        const matrix=transpose?stages.map(id=>[...work.map((w,i)=>{const c=lookup[i].get(id);return c?c.cost-unassigned(w):penalty*10000;}),...stages.map(()=>0)]):work.map((w,i)=>[...stages.map(id=>lookup[i].get(id)?.cost??penalty*10000),...work.map(()=>unassigned(w))]);
        const match=DG.minCostAssignment(matrix),matched=transpose?new Map((match||[]).flatMap((column,row)=>column<work.length?[[column,stages[row]]]:[])):new Map((match||[]).map((column,row)=>[row,stages[column]])),proposed=new Map(),claims=[...existing];let sum=0;
        // Recheck Gate/calendar constraints in the established priority/ETA
        // order; matching itself only owns Stage capacity.
        if(match)for(let i=0;i<work.length;i++){const c=lookup[i].get(matched.get(i));if(c&&!isFeasible(work[i].load,c.dock,claims)){proposed.set(work[i].load.load_id,c.dock);claims.push(reservation(work[i].load,c.dock,options));sum+=c.cost;}}
        const difference=compare(rank(proposed),bestScore);if(difference>0||difference===0&&sum<bestCost)best=proposed;
      }
      return {assignments:best,exact:false,visited};
    }
    work.sort((a,b)=>a.choices.length-b.choices.length||interval(a.load,'loading',options).start-interval(b.load,'loading',options).start);
    const suffix=Array(work.length+1).fill(0);for(let i=work.length-1;i>=0;i--)suffix[i]=suffix[i+1]+work[i].choices[0].cost;
    const chosen=new Map(),reservations=[...existing],budget=options.maxSearchNodes??25000;
    function search(i,count,cost){
      if(visited%1024===0)options.onProgress?.({stage:'allocation',visited,limit:budget});
      if(++visited>budget){limited=true;return;}
      const remaining=work.length-i;
      if(bestCount===work.length&&cost+suffix[i]>=bestCost)return;
      if(i===work.length){const nextScore=rank(chosen),difference=compare(nextScore,bestScore);if(difference>0||difference===0&&cost<bestCost){best=new Map(chosen);bestCount=count;bestCost=cost;bestScore=nextScore;}return;}
      const w=work[i];
      for(const c of w.choices){if(limited)return;if(isFeasible(w.load,c.dock,reservations))continue;chosen.set(w.load.load_id,c.dock);reservations.push(reservation(w.load,c.dock,options));search(i+1,count+1,cost+c.cost);reservations.pop();chosen.delete(w.load.load_id);}
      if(!limited)search(i+1,count,cost);
    }
    search(0,0,0);return {assignments:best,exact:!limited,visited};
  }
  function optimize(loads,data,gateStates={},decisions={},options={}){
    options={...options,distanceCache:new Map(),planningReasonCache:new WeakMap(),controlIndexCache:new WeakMap(),printerIndexCache:new WeakMap(),priorityControlCache:new WeakMap()};
    const engine=data.engine||data.distanceProvider?.engine;
    if(!engine?.getShipDock||!engine?.getGateForShipDock)Domain.invalid('SpatialEngine is required for Load × ShipDock costs');
    options.routingContext=engine.createRoutingContext?.()||null;
    const seen=new Set();for(const l of loads){Domain.activity(l);if(seen.has(l.load_id))Domain.invalid('Duplicate load ID: '+l.load_id);seen.add(l.load_id);}
    loads=Rules.arrivalLoads({loads:loads.filter(l=>!Rules.released({decisions},l.load_id)),assignments:data.assignments,decisions,proposalPins:options.proposalPins},engine.model);
    const model=engine.model,shipDockStates=data.shipDockStates||{},issues=[],reservations=[...(options.reservations||[])],rows=[],cache=new WeakMap(),totals=new WeakMap(loads.map(l=>[l,empty(l)]));
    if(data.aliases)Domain.normalize({gates:model.gates,aliases:data.aliases,shipdocks:model.shipdocks});
    if(data.assignments)recordAssignments(data.assignments,loads,decisions);
    const isAllowed=gate=>(options.allowedGateIds==null||options.allowedGateIds.includes(gate?.gateId))&&(options.allowedChambers==null||options.allowedChambers.includes(String(gate?.physicalChamber)));
    const candidates=Object.values(model.shipdocks).filter(s=>s.active&&s.physicalGateId&&isAllowed(model.gates[s.physicalGateId])).sort((a,b)=>a.shipDockId.localeCompare(b.shipDockId,undefined,{numeric:true}));
    const cost=(load,id)=>{if(!engine.getShipDock(id)?.mapped)return totals.get(load);if(!cache.has(load))cache.set(load,new Map());const map=cache.get(load);if(!map.has(id))map.set(id,costFor(load,id,engine,options));return map.get(id);};
    const fixedId=load=>Domain.key(data.assignments?.[load.load_id]||load.existingShipDockId||load.current_shipdock||(decisions[load.load_id]?.accepted||decisions[load.load_id]?.overridden||decisions[load.load_id]?.locked?decisions[load.load_id].chosen_shipdock:''));
    const pins=Rules.proposalPins({loads,decisions,assignments:data.assignments,proposalPins:options.proposalPins||{}}),pinnedId=load=>pins[load.load_id]?.shipDockId||'';
    // Unreliable transport identity must not silently make its observed Stage
    // available. Keep a conservative resource claim without creating a WMS assignment.
    for(const load of loads)if(load.workloadSource==='MTM'&&(load.mtm?.quarantined||load.mtm?.reviewReasons?.includes('MTM_FINAL_CONFLICT'))){
      for(const id of load.mtm.observedShipDocks||[]){if(id===fixedId(load))continue;const dock=engine.getShipDock(id);if(dock?.physicalGateId)reservations.push({...reservation(load,dock,options),observation:true});}
    }
    const rank=load=>fixedId(load)?2:pinnedId(load)?1:0;
    const ordered=[...loads].sort((a,b)=>rank(b)-rank(a)||interval(a,'loading',options).start-interval(b,'loading',options).start||String(a.load_id).localeCompare(String(b.load_id)));
    options.onProgress?.({stage:'routes',completed:0,total:loads.length});
    const costMatrix={shipDockIds:candidates.map(s=>s.shipDockId),loadIds:loads.map(l=>l.load_id),values:loads.map((l,i)=>{const values=candidates.map(s=>cost(l,s.shipDockId).cost);options.onProgress?.({stage:'routes',completed:i+1,total:loads.length});return values;})};
    let newPlan=null;
    for(const load of ordered){
      const decision=decisions[load.load_id]||{},existing=Domain.key(data.assignments?.[load.load_id]||load.existingShipDockId||load.current_shipdock),fixed=fixedId(load),warnings=planningReasons(load,{cache:options.planningReasonCache});
      if(decision.invalidated)warnings.push('Earlier override invalidated: existing ShipDock retained');
      const pinned=pinnedId(load);let dock=fixed||pinned?engine.getShipDock(fixed||pinned):null,status='UNASSIGNED',blocked=warnings.length>0;
      const requested=decision.physicalGateId??decision.physical_gate_id??decision.requestedGateId??load.requestedGateId??load.requested_gate??load.physicalGateId;
      if(existing&&decision.chosen_shipdock&&Domain.key(decision.chosen_shipdock)!==existing){warnings.push('INVALID_CONFIGURATION: existing ShipDock is fixed');blocked=true;}
      if(load.validation)warnings.push(load.validation);
      if(fixed||pinned){
        if(!dock?.physicalGateId){warnings.push('SHIPDOCK_NEEDS_VALIDATION');blocked=true;}
        else{Domain.validateAssignment(model,fixed||pinned,requested);const reason=!existing&&!isAllowed(model.gates[dock.physicalGateId])?'RESOURCE_EXCLUDED_BY_SETTINGS':feasible(load,dock,model,gateStates,shipDockStates,reservations,options,!!fixed);if(reason){warnings.push(reason);blocked=true;}else status=fixed?'FIXED':'PINNED';}
      }else{
        if(requested!=null)Domain.invalid('A new load must choose ShipDock; Gate is derived');
        if(!newPlan)newPlan=allocate(ordered.filter(l=>!fixedId(l)&&!pinnedId(l)),candidates,cost,(l,s,claims)=>feasible(l,s,model,gateStates,shipDockStates,claims,options),reservations,options);
        dock=newPlan.assignments.get(load.load_id)||null;
        if(dock)status='RECOMMENDED';else{const reasons=new Set(candidates.map(s=>feasible(load,s,model,gateStates,shipDockStates,reservations,options)).filter(Boolean));warnings.push(...reasons);warnings.push('NO_FEASIBLE_SHIPDOCK: verify stage mapping, access and calendars');blocked=true;}
      }
      if(dock?.physicalGateId){
        // Preserve resource claims even when an existing assignment has a conflict.
        reservations.push(reservation(load,dock,options));
        if(bufferOverlap(load,dock,gateStates,reservations,options))warnings.push('BUFFER_OVERLAP');
      }
      const reference=options.planningRules?options.planningRules.referenceAssignments?.[Rules.storeFor(load)]:existing;
      const current=reference?cost(load,reference):empty(load),optimized=dock?cost(load,dock.shipDockId):empty(load);
      if(current.cost==null)warnings.push('Brak możliwości porównania');
      const capacity=dock?Rules.resource(options.planningRules,'STAGE',dock.temporaryObjectId||dock.shipDockId).capacity:null;
      const stagedUnits=dock?reservations.filter(r=>r.stage===(dock.temporaryObjectId||dock.shipDockId)&&r.shipment===Rules.shipment(load)).reduce((sum,r)=>sum+(r.quantity||0),0):0;
      if(capacity!=null&&stagedUnits>capacity)warnings.push('Zamówienie może nie zmieścić się na Stage’u');
      const routeProblem=optimized.reason||(!dock?[...(cache.get(load)?.values()||[])].find(c=>c.reason)?.reason:null);if(routeProblem&&!warnings.includes(routeProblem))warnings.push(routeProblem);
      const failed=optimized.failedLeg||(!dock?[...(cache.get(load)?.values()||[])].find(c=>c.failedLeg)?.failedLeg:null);if(failed)warnings.push('Brak trasy '+failed.from+' → '+failed.to+(failed.reason?' · '+failed.reason:''));
      if(dock&&optimized.cost==null){warnings.push('SPATIAL_COST_NEEDS_VALIDATION');blocked=true;}
      if(blocked)status='CONFLICT';
      if(warnings.length)issues.push('Load '+load.load_id+': '+warnings.join('; '));
      const gate=dock?.physicalGateId??null;
      if(dock&&gate)Domain.validateAssignment(model,dock.shipDockId,gate);
      const service=(DG.GateSchedule||(typeof require==='function'?require('./gate-schedule.js'):null)).serviceWindow(load,options);
      rows.push({load,capacity,referenceShipdock:reference||null,window:service.label,windowStart:service.start,windowEnd:service.end,currentGate:engine.getShipDock(reference)?.physicalGateId??null,gate,
        recommendedShipdock:dock?.shipDockId||'',physicalChamber:dock?.physicalChamber??null,fixed:!!fixed,pinned:!!pinned,status,feasible:!blocked,
        currentCost:current.cost,optimizedCost:optimized.cost,saving:current.cost>0&&optimized.cost!=null?(current.cost-optimized.cost)/current.cost:null,
        mappedUnits:optimized.mappedUnits,proxyUnits:0,totalUnits:optimized.totalUnits,decision,warnings});
    }
    options.onProgress?.({stage:'validation'});
    const positions=new Map(loads.map((l,i)=>[l.load_id,i]));rows.sort((a,b)=>positions.get(a.load.load_id)-positions.get(b.load.load_id));
    for(const row of rows)if(row.recommendedShipdock){const stage=engine.getShipDock(row.recommendedShipdock)?.temporaryObjectId||row.recommendedShipdock;row.stageUnits=rows.filter(r=>r.recommendedShipdock&&(engine.getShipDock(r.recommendedShipdock)?.temporaryObjectId||r.recommendedShipdock)===stage).reduce((sum,r)=>sum+r.totalUnits,0);if(row.capacity!=null&&row.stageUnits>row.capacity&&!row.warnings.includes('Zamówienie może nie zmieścić się na Stage’u'))row.warnings.push('Zamówienie może nie zmieścić się na Stage’u');}
    const comparable=rows.filter(r=>r.feasible&&r.currentCost!=null&&r.optimizedCost!=null),validCosts=rows.filter(r=>r.feasible&&r.optimizedCost!=null);
    const currentTotal=comparable.length?comparable.reduce((s,r)=>s+r.currentCost,0):null,optimizedTotal=validCosts.length?validCosts.reduce((s,r)=>s+r.optimizedCost,0):null;
    const matchedOptimized=comparable.reduce((s,r)=>s+r.optimizedCost,0),accepted=comparable.filter(r=>r.fixed),acceptedTotal=accepted.length===comparable.length&&accepted.length?accepted.reduce((s,r)=>s+r.optimizedCost,0):null;
    return {rows,issues,costMatrix,distanceUnit:'METERS',costUnit:'PALLET_METERS',matchedOptimizedTotal:comparable.length?matchedOptimized:null,algorithm:newPlan?.exact===false?'BOUNDED_FEASIBLE_SHIPDOCK':'MIN_COST_FEASIBLE_SHIPDOCK',optimal:newPlan?.exact!==false,searchNodes:newPlan?.visited||0,currentTotal,optimizedTotal,
      potentialSaving:currentTotal>0?(currentTotal-matchedOptimized)/currentTotal:null,acceptedTotal,acceptedSaving:acceptedTotal!=null&&currentTotal>0?(currentTotal-acceptedTotal)/currentTotal:null,acceptedCount:accepted.length,comparableCount:comparable.length};
  }
  const taskSku=t=>t.sku||['sku','sku_id','item_id','article'].map(k=>t.attributes?.[k]).find(Boolean);
  const taskKey=t=>t.move_task_id?'ID:'+t.move_task_id:JSON.stringify([t.source_location,t.destination_location,taskSku(t),t.quantity,t.order_type||'',t.carrier_type||'']);
  function additionalCollisions(previous,incoming){
    const old=new Map(previous.map(l=>[l.load_id,l])),collisions=[];
    for(const load of incoming){const prior=old.get(load.load_id);if(!prior)continue;const counts=new Map(),groups=new Map();
      for(const task of prior.tasks||[])if(!task.move_task_id){const key=taskKey(task);counts.set(key,(counts.get(key)||0)+1);}
      for(const task of load.tasks||[])if(!task.move_task_id){const key=taskKey(task);if(counts.has(key)){const group=groups.get(key)||{key:JSON.stringify([load.load_id,key]),loadId:load.load_id,task,existing:counts.get(key),incoming:0};group.incoming++;groups.set(key,group);}}
      collisions.push(...groups.values());
    }
    return collisions;
  }
  // Assignment stays fixed. Only explicit pick IDs can be replayed automatically;
  // otherwise the operator identifies new rows before the merge can proceed.
  function mergeWorkload(previous,incoming,decisions={},options={}){
    const old=new Map(previous.map(l=>[l.load_id,l]));
    const added=options.mode==='ADDITIONAL',result=added?new Map(old):new Map(previous.filter(l=>decisions[l.load_id]?.stageReleasedAt||options.activity&&Domain.activity(l)!==options.activity||!decisions[l.load_id]?.stageReleasedAt&&(options.assignments?.[l.load_id]||l.existingShipDockId||l.current_shipdock||decisions[l.load_id]?.accepted||decisions[l.load_id]?.overridden||decisions[l.load_id]?.locked)).map(l=>[l.load_id,l]));
    const newCounts=new Map();if(added)for(const c of additionalCollisions(previous,incoming)){const count=options.duplicatePickCounts?.[c.key];if(!Number.isInteger(count)||count<Math.max(0,c.incoming-c.existing)||count>c.incoming)Domain.invalid('CSV: wybierz liczbę nowych identycznych picków dla '+c.loadId);newCounts.set(c.key,count);}
    for(const load of incoming){const prior=old.get(load.load_id),fixed=Domain.key(options.assignments?.[load.load_id]||prior?.existingShipDockId||prior?.current_shipdock||(decisions[load.load_id]?.accepted||decisions[load.load_id]?.overridden||decisions[load.load_id]?.locked?decisions[load.load_id].chosen_shipdock:''));
      if(fixed&&prior&&String(load.store||'').trim()&&Domain.key(load.store)!==Domain.key(prior.store))Domain.invalid('Sklep zatwierdzonego consignmentu jest niezmienny: '+load.load_id);
      if(fixed&&load.current_shipdock&&load.shipdockSource!=='SCHEDULE'&&Domain.key(load.current_shipdock)!==fixed)Domain.invalid('Imported ShipDock changed for '+load.load_id);
      if(prior&&Domain.activity(prior)!==Domain.activity(load))Domain.invalid('Cannot change transport activity for '+load.load_id);
      const merged={...prior,...load};
      for(const field of ['store','loading_time','loading_date','loading_end','staging_start','staging_end','estimated_arrival_at','truck_label'])if(!merged[field]&&prior?.[field])merged[field]=prior[field];
      if(load.loading_duration_minutes==null&&prior?.loading_duration_minutes!=null)merged.loading_duration_minutes=prior.loading_duration_minutes;
      if(fixed){merged.current_shipdock=fixed;merged.existingShipDockId=fixed;}
      if(added&&prior){const tasks=[...(prior.tasks||[])],slots=new Map(),seen=new Map(),incomingCounts=new Map();for(const t of load.tasks||[]){const key=taskKey(t);incomingCounts.set(key,(incomingCounts.get(key)||0)+1);}for(let i=0;i<tasks.length;i++){const key=taskKey(tasks[i]),list=slots.get(key)||[];list.push(i);slots.set(key,list);}for(const t of load.tasks||[]){const key=taskKey(t),n=seen.get(key)||0,newCount=newCounts.get(JSON.stringify([load.load_id,key])),matches=newCount==null?Infinity:incomingCounts.get(key)-newCount,index=n<matches?slots.get(key)?.[n]:null;seen.set(key,n+1);if(index==null)tasks.push(t);else tasks[index]=t;}merged.tasks=tasks;}
      Rules.orderType(merged);
      result.set(load.load_id,merged);
    }
    return [...result.values()];
  }
  function recordAssignments(previous,loads,decisions={}){
    const ledger={...previous};for(const load of loads){const d=decisions[load.load_id],id=Domain.key(load.existingShipDockId||load.current_shipdock||(d?.accepted||d?.overridden||d?.locked?d.chosen_shipdock:''));if(!id)continue;
      if(ledger[load.load_id]&&Domain.key(ledger[load.load_id])!==id)Domain.invalid('Existing assignment cannot change for '+load.load_id);ledger[load.load_id]=id;}
    return ledger;
  }
  function planCoverage(rows){let totalUnits=0,fullRouteUnits=0;for(const row of rows){const units=Number.isFinite(row.totalUnits)&&row.totalUnits>0?row.totalUnits:0;totalUnits+=units;if(row.feasible===true&&row.recommendedShipdock&&Number.isFinite(row.optimizedCost)&&row.optimizedCost>=0)fullRouteUnits+=units;}return {totalUnits,fullRouteUnits,ratio:totalUnits?fullRouteUnits/totalUnits:null};}
  const api={costFor,interval,stageInterval,planningReasons,overlaps,feasible,chooseShipDock,proposalChoices,optimize,additionalCollisions,mergeWorkload,recordAssignments,planCoverage};DG.ShipDockOptimizer=api;
  if(typeof module==='object'&&module.exports)module.exports=api;
})(globalThis);
