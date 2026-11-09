(function(root){
  'use strict';
  const DG=root.DG=root.DG||{},ZONE='Europe/Warsaw',KEY='dynamic-gates-schedule-v1',MINUTE=60000;
  const Domain=DG.ShipDockDomain||(typeof require==='function'?require('./shipdock-domain.js'):null);
  const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:ZONE,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  function localValue(ms){const p=Object.fromEntries(formatter.formatToParts(new Date(ms)).map(x=>[x.type,x.value]));return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;}
  function parseLocal(value){
    const m=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(value||''));if(!m)throw Error('Podaj datę i godzinę przyjazdu.');
    const target=Date.UTC(...[Number(m[1]),Number(m[2])-1,Number(m[3]),Number(m[4]),Number(m[5])]);
    const asUTC=s=>Date.parse(s+':00Z'),offsets=new Set([-86400000,0,86400000].map(d=>asUTC(localValue(target+d))-(target+d))),matches=[...offsets].map(o=>target-o).filter(t=>localValue(t)===value);
    if(!matches.length)throw Error('Nieprawidłowa data lub godzina nieistniejąca przy zmianie czasu.');
    if(matches.length>1)throw Error('Ta godzina występuje dwa razy przy zmianie czasu. Wybierz jednoznaczną godzinę poza powtarzanym przedziałem.');
    return matches[0];
  }
  function timestamp(value,date=''){
    if(Number.isFinite(value))return value*MINUTE;
    const s=String(value||'');if(!s)return null;
    if(/^\d{1,2}:\d{2}$/.test(s)){date=String(date||'');if(/^\d{8}$/.test(date))date=date.slice(0,4)+'-'+date.slice(4,6)+'-'+date.slice(6,8);if(!date)return null;return parseLocal(date+'T'+s.padStart(5,'0'));}
    if(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s))return parseLocal(s);
    const iso=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/.exec(s);if(!iso)return null;
    const dateCheck=new Date(0);dateCheck.setUTCFullYear(Number(iso[1]),Number(iso[2])-1,Number(iso[3]));if(dateCheck.getUTCFullYear()!==Number(iso[1])||dateCheck.getUTCMonth()!==Number(iso[2])-1||dateCheck.getUTCDate()!==Number(iso[3])||Number(iso[4])>23||Number(iso[5])>59||Number(iso[6]||0)>59)return null;
    const t=Date.parse(s);return Number.isFinite(t)?t:null;
  }
  function nextDate(day){const d=new Date(day+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+1);return d.toISOString().slice(0,10);}
  function dayRange(ms){const day=localValue(ms).slice(0,10);return {start:parseLocal(day+'T00:00'),end:parseLocal(nextDate(day)+'T00:00')};}
  const overlap=(a,b)=>a.start<b.end&&b.start<a.end;
  const covers=(e,t)=>e.start<=t&&t<e.end;
  const priorityValue=value=>['NORMAL','PRIORITY'].includes(value)?value:null;
  const priorityLabel=value=>value==='PRIORITY'?'Priorytetowa':value==='NORMAL'?'Zwykła':'Wybierz priorytet auta';
  function savedPriority(input,old){
    const value=input.priority??old?.priority;
    if(priorityValue(value))return value;
    if(input.priorityReviewRequired)return null;
    if(!old&&input.priority==null)return 'NORMAL';
    throw Error('Wybierz priorytet auta: zwykły albo priorytetowy.');
  }
  const legacyPriority=(input,old)=>old?.legacyPriority??(!priorityValue(old?.priority)?old?.priority:undefined)??input.legacyPriority??(input.priorityReviewRequired&&!priorityValue(input.priority)?input.priority:undefined);
  const occupancyWindow=entry=>({start:entry.start,end:entry.actual?Infinity:entry.end});
  function runtimeEntry(entry,snapshot){
    const state=snapshot.vehicleStates?.[entry.id];
    if(state?.completedAt||state?.cancelledAt)return null;
    if(state&&state.physicalGateId!==entry.physicalGateId)throw Error('Faktycznie obsługiwane auto nie może zmienić rampy: '+entry.id);
    if(!state?.startedAt)return entry;
    const start=Date.parse(state.startedAt);return {...entry,start,end:start+entry.loadingMinutes*MINUTE,actual:true,actualStartedAt:state.startedAt};
  }
  function transitionVehicle(snapshot,domain,schedule,id,action,now=Date.now(),policy={}){
    if(!['START','COMPLETE','CANCEL'].includes(action)||!Number.isFinite(now))throw Error('Nieprawidłowa operacja auta.');
    const previous=snapshot.vehicleStates?.[id]||{};
    if(action==='COMPLETE'&&previous.completedAt||action==='CANCEL'&&previous.cancelledAt)return snapshot;
    const all=entries(domain,snapshot,schedule,policy).entries,entry=all.find(a=>a.id===id);
    if(!entry)throw Error('Nie znaleziono aktywnego auta. Odśwież dane.');
    const members=entry.loadIds||[entry.loadId].filter(Boolean),time=new Date(now).toISOString();
    if(action==='CANCEL'&&entry.actual&&Domain.activity(entry)==='INBOUND')throw Error('Trwający rozładunek wymaga potwierdzenia zakończenia.');
    if(Domain.activity(entry)==='OUTBOUND'&&action!=='CANCEL')for(const loadId of members){const load=(snapshot.loads||[]).find(l=>l.load_id===loadId),dock=load&&domain.shipdocks[assignedDock(load,snapshot)];if(!dock||dock.physicalGateId!==entry.physicalGateId)throw Error('Zamówienia auta muszą mieć zatwierdzone Stage’e przy tej samej rampie.');}
    if(action==='START'){
      if(previous.startedAt)return snapshot;
      if(!priorityValue(entry.priority))throw Error('Przed rozpoczęciem wybierz priorytet starszego auta w Awizacjach.');
      const info=gateAt(domain,snapshot,all,entry.physicalGateId,now,policy);
      if(info.active.some(a=>a.id!==id)||info.manual||info.blocks.length||domain.gates[entry.physicalGateId]?.active===false)throw Error('Rampa jest zajęta. Auto musi poczekać.');
      const gate=domain.gates[entry.physicalGateId],meta=snapshot.gateStates?.[entry.physicalGateId]||{},service={start:now,end:now+entry.loadingMinutes*MINUTE},manual=manualWindow(gate,meta);
      const capacity=meta.loadingCapacity??gate.loadingCapacity??(meta.allowConcurrentLoading||gate.allowConcurrentLoading?Infinity:1);
      if(!(capacity>=1))throw Error('Rampa nie ma dostępnej pojemności załadunkowej.');
      if(manual&&overlap(service,manual)||calendarWindows(gate,meta).some(block=>overlap(service,block)))throw Error('Przewidywana obsługa koliduje z blokadą rampy. Auto musi poczekać.');
      if(all.some(a=>a.id!==id&&a.physicalGateId===entry.physicalGateId&&overlap(occupancyWindow(a),{start:now,end:now+entry.loadingMinutes*MINUTE})))throw Error('Wcześniejsza obsługa koliduje z zaplanowanym autem. Auto musi poczekać.');
      if(!Domain.allows(domain.gates[entry.physicalGateId],Domain.activity(entry),'DYNAMIC'))throw Error('Rampa nie obsługuje tego rodzaju transportu.');
    }
    const next={...previous,physicalGateId:entry.physicalGateId,activity:Domain.activity(entry),loadIds:[...members],truckLabel:entry.truckLabel,[action==='START'?'startedAt':action==='COMPLETE'?'completedAt':'cancelledAt']:time};
    const decisions={...snapshot.decisions};
    if(action==='COMPLETE'||action==='CANCEL')for(const loadId of members){
      const load=(snapshot.loads||[]).find(l=>l.load_id===loadId);if(!load)continue;
      decisions[loadId]={...decisions[loadId],...(action==='COMPLETE'?{completedAt:time,...(Domain.activity(entry)==='OUTBOUND'?{stageReleasedAt:time}:{})}:{cancelledAt:time})};
    }
    const event={id:id+':'+action,vehicleId:id,type:action,at:time,physicalGateId:entry.physicalGateId,activity:Domain.activity(entry),loadIds:[...members]};
    return {...snapshot,decisions,vehicleStates:{...snapshot.vehicleStates,[id]:next},vehicleEvents:[...(snapshot.vehicleEvents||[]),event]};
  }
  const assignedDock=(load,snapshot)=>{const d=snapshot.decisions?.[load.load_id];return load.existingShipDockId||load.current_shipdock||snapshot.assignments?.[load.load_id]||((d?.accepted||d?.overridden||d?.locked)&&d.chosen_shipdock)||'';};
  function delayValue(value){const n=Number(value??0);if(!Number.isInteger(n)||n<0||n>10080)throw Error('Opóźnienie musi wynosić od 0 do 10080 minut.');return n;}
  function reservationWindow(window,activity,policy={}){
    const minutes=activity==='INBOUND'?0:Number(policy.gateBufferMinutes||0),plannedEnd=window.plannedEnd??(window.plannedStart??window.start)+(window.durationMinutes??window.loadingMinutes??((window.end-window.start)/MINUTE))*MINUTE;
    return {...window,plannedEnd,bufferMinutes:minutes,reservationEnd:Math.max(plannedEnd+minutes*MINUTE,window.end)};
  }
  function appointmentWindow(a,policy={}){const plannedStart=Date.parse(a.arrivalAt),delayMinutes=delayValue(a.delayMinutes);return reservationWindow({plannedStart,plannedEnd:plannedStart+a.loadingMinutes*MINUTE,start:plannedStart+delayMinutes*MINUTE,end:plannedStart+(delayMinutes+a.loadingMinutes)*MINUTE,durationMinutes:a.loadingMinutes,delayMinutes,delayReason:a.delayReason||''},Domain.activity(a),policy);}
  function loadWindow(load,policy={}){
    const w=load.loadingWindow||load.loading_window,date=load.loading_date||load.date;
    const plannedStart=timestamp(load.estimated_arrival_at||load.eta||(w?.start??load.loading_start??load.loading_time),date);if(plannedStart==null)return null;const start=plannedStart;
    const duration=Number(load.loading_duration_minutes??policy.defaultLoadingMinutes??60);if(!Number.isFinite(duration)||duration<1||duration>10080)throw Error('Nieprawidłowy czas załadunku: '+load.load_id);
    let end=timestamp(w?.end??load.loading_end,date);
    if(end!=null&&end<=start&&/^\d{1,2}:\d{2}$/.test(String(w?.end??load.loading_end))){end=timestamp(w?.end??load.loading_end,nextDate(localValue(start).slice(0,10)));}
    if(end==null)end=start+duration*MINUTE;if(end<=start)throw Error('Nieprawidłowy przedział załadunku: '+load.load_id);
    const delayMinutes=delayValue(load.delay_minutes);return reservationWindow({plannedStart,plannedEnd:end,start:start+delayMinutes*MINUTE,end:end+delayMinutes*MINUTE,delayMinutes,delayReason:load.delay_reason||'',durationMinutes:(end-start)/MINUTE,estimated:!load.loading_duration_minutes&&!(w?.end??load.loading_end)},Domain.activity(load),policy);
  }
  // Presentation uses the already resolved window from optimizerContext. Do
  // not add source delay again or infer ETA from MTM report/deadline metadata.
  function serviceWindow(load,policy={}){
    const offset=ms=>{const local=localValue(ms),minutes=(Date.parse(local+':00Z')-Math.floor(ms/MINUTE)*MINUTE)/MINUTE;return 'UTC'+(minutes<0?'-':'+')+String(Math.floor(Math.abs(minutes)/60)).padStart(2,'0')+':'+String(Math.abs(minutes)%60).padStart(2,'0');};
    if(load.actualStartedAt){const start=Date.parse(load.actualStartedAt);if(Number.isFinite(start))try{return {label:'Od '+localValue(start).replace('T',' ')+' ('+offset(start)+') · do potwierdzenia',start,end:null};}catch(_){} }
    const raw=load.loadingWindow||load.loading_window;let w=null;
    try{if(load.schedulingDateValidated&&Number.isFinite(raw?.start)&&Number.isFinite(raw?.end))w={start:raw.start*MINUTE,end:raw.end*MINUTE};else w=loadWindow(load,policy);}catch(_){}
    if(!w||!Number.isFinite(w.start)||!Number.isFinite(w.end)||w.end<=w.start)return {label:load.loading_time?String(load.loading_time)+' · brak daty':'Brak terminu',start:null,end:null};
    try{
      const start=localValue(w.start),end=localValue(w.end),a=offset(w.start),b=offset(w.end),until=start.slice(0,10)===end.slice(0,10)?end.slice(11):end.replace('T',' ');
      return {label:start.replace('T',' ')+(a===b?'':' ('+a+')')+'–'+until+' ('+b+')',start:w.start,end:w.end};
    }catch(_){return {label:'Brak poprawnego terminu',start:null,end:null};}
  }
  function validate(value){
    if(value?.version!==1||!Array.isArray(value.appointments)||value.appointments.length>10000)throw Error('Nieprawidłowy kalendarz ramp.');
    const validRequestStart=v=>typeof v==='string'&&/(?:Z|[+-]\d{2}:\d{2})$/.test(v)&&Number.isFinite(timestamp(v));
    const ids=new Set(),appointments=value.appointments.map(a=>{
      if(!/^R\d+$/.test(a?.id||'')||ids.has(a.id)||typeof a.physicalGateId!=='string'||!a.physicalGateId||!['ACTIVE','CANCELLED'].includes(a.status)||typeof a.truckLabel!=='string'||!a.truckLabel.trim()||a.truckLabel.length>160||!Number.isFinite(a.loadingMinutes)||a.loadingMinutes<1||a.loadingMinutes>10080||!/^\d{4}-\d{2}-\d{2}T.*Z$/.test(a.arrivalAt||'')||!Number.isFinite(Date.parse(a.arrivalAt))||new Date(a.arrivalAt).toISOString()!==a.arrivalAt)throw Error('Nieprawidłowa rezerwacja rampy.');
      if(a.shipDockId!=null&&(typeof a.shipDockId!=='string'||a.shipDockId.length>160))throw Error('Nieprawidłowy stage rezerwacji.');
      Domain.activity(a);delayValue(a.delayMinutes);if(a.delayReason!=null&&(typeof a.delayReason!=='string'||a.delayReason.length>160))throw Error('Nieprawidłowy powód opóźnienia.');
      ids.add(a.id);return {...a};
    });const requests=value.requests||[];if(!Array.isArray(requests)||requests.length>10000)throw Error('Nieprawidłowa lista awizacji.');const requestIds=new Set();for(const a of requests){if(!/^A\d+$/.test(a?.id)||requestIds.has(a.id)||!['ACTIVE','CANCELLED'].includes(a.status)||!Array.isArray(a.loadIds)||a.loadIds.some(id=>typeof id!=='string'||!id||id.length>200)||typeof a.truckLabel!=='string'||!a.truckLabel.trim()||a.truckLabel.length>160||!validRequestStart(a.arrivalAt)||!Number.isInteger(a.loadingMinutes)||a.loadingMinutes<1||a.loadingMinutes>10080)throw Error('Nieprawidłowa awizacja auta.');requestIds.add(a.id);}
    for(const a of [...appointments,...requests])if(a.sourceId!=null&&(typeof a.sourceId!=='string'||!a.sourceId.trim()||a.sourceId.length>160))throw Error('Nieprawidłowe źródłowe ID awizacji.');
    return {...value,appointments,requests:requests.map(a=>({...a,physicalGateId:null})),revision:Number.isSafeInteger(value.revision)&&value.revision>=0?value.revision:0,nextNumber:Math.max(Number.isSafeInteger(value.nextNumber)?value.nextNumber:1,1,...appointments.map(a=>Number(a.id.slice(1))+1),...requests.map(a=>Number(a.id.slice(1))+1))};
  }
  class Store{
    constructor(storage){this.storage=storage;}
    policy(){return DG.AlgorithmSettings?new DG.AlgorithmSettings.Store(this.storage).read().values:{};}
    read(){const raw=this.storage?.getItem(KEY);return raw?validate(JSON.parse(raw)):{version:1,revision:0,nextNumber:1,appointments:[]};}
    write(value,expectedRevision){const original=this.storage?.getItem(KEY)??null,latest=this.read();if(latest.revision!==expectedRevision)throw Error('Kalendarz zmienił się w innym oknie. Odśwież widok i spróbuj ponownie.');const next=validate({...value,revision:latest.revision+1,updatedAt:new Date().toISOString()});if(!this.storage)throw Error('Brak zapisu lokalnego.');const raw=JSON.stringify(next);if(this.storage.compareAndSet){if(!this.storage.compareAndSet(KEY,original,raw))throw Error('Kalendarz zmienił się w innym oknie. Odśwież widok i spróbuj ponownie.');}else{if((this.storage.getItem(KEY)??null)!==original)throw Error('Kalendarz zmienił się w innym oknie. Odśwież widok i spróbuj ponownie.');this.storage.setItem(KEY,raw);}root.dispatchEvent?.(new Event('dynamic-gates-schedule-change'));return next;}
  }
  function stageFor(domain,snapshot,appointment){
    if(Domain.activity(appointment)==='INBOUND')return {shipDockId:null,stageName:null,stageTemporaryId:null};
    const load=appointment.loadId&&(snapshot.loads||[]).find(l=>l.load_id===appointment.loadId),id=String(load?assignedDock(load,snapshot):appointment.shipDockId||'').toUpperCase(),dock=domain.shipdocks[id];
    return dock?.physicalGateId===appointment.physicalGateId?{shipDockId:id,stageName:dock.name||dock.label||id,stageTemporaryId:dock.temporaryObjectId||null}:{shipDockId:null,stageName:null,stageTemporaryId:null};
  }
  function stageWindow(entry,domain,snapshot,policy={}){
    if(policy.stageWindowMode==='CONFIRMED_RELEASE')return {start:-Infinity,end:Infinity};
    const load=(snapshot.loads||[]).find(l=>l.load_id===entry.loadId),dock=domain.shipdocks[entry.shipDockId],flow=Domain.activity(load||entry),explicit=load&&(load.stagingWindow||load.staging_window||load.staging_start||load.staging_end);
    if(load&&!explicit&&flow==='OUTBOUND'&&Domain.operationMode(dock)!=='DYNAMIC'&&policy.stageWindowMode!=='ETA')return {start:-Infinity,end:Infinity};
    const raw=load?.stagingWindow||load?.staging_window,date=load?.loading_date||load?.date,rawEnd=raw?.end??load?.staging_end;
    const start=timestamp(raw?.start??load?.staging_start,date)??entry.start-(flow==='OUTBOUND'?(policy.stagingBeforeMinutes||0)*MINUTE:0);let end=timestamp(rawEnd,date);
    if(end!=null&&end<=start&&/^\d{1,2}:\d{2}$/.test(String(rawEnd)))end=timestamp(rawEnd,nextDate(localValue(start).slice(0,10)));
    return {start,end:Math.max(end??entry.end+(policy.stagingAfterMinutes||0)*MINUTE,entry.end)};
  }
  function requestMembers(a,snapshot){
    const ids=a.loadIds||[a.loadId].filter(Boolean),groups=new Set((snapshot.loads||[]).filter(l=>ids.includes(l.load_id)).map(l=>DG.PlanningRules.shipment(l)));
    return [...new Set([...ids,...(snapshot.loads||[]).filter(l=>(l.shipmentId==='AWIZ:'+a.id||groups.has(DG.PlanningRules.shipment(l)))&&assignedDock(l,snapshot)&&!DG.PlanningRules?.released(snapshot,l.load_id)&&!snapshot.decisions?.[l.load_id]?.cancelledAt).map(l=>l.load_id)])];
  }
  function knownStoreSnapshot(snapshot){const R=DG.PlanningRules||(typeof require==='function'?require('./planning-rules.js'):null);return {...snapshot,loads:(snapshot.loads||[]).map(l=>l.workloadSource==='LAST_PICK_POC'&&!R?.storeFor(l)&&l.store?{...l,store:''}:l)};}
  function appointmentLinks(snapshot,schedule,domain){
    snapshot=knownStoreSnapshot(snapshot);
    const ended=a=>snapshot.vehicleStates?.[a.id]?.completedAt||snapshot.vehicleStates?.[a.id]?.cancelledAt;
    const candidates=[...(schedule.requests||[]),...schedule.appointments.filter(a=>a.loadId&&Domain.activity(a)==='OUTBOUND')].filter(a=>a.status==='ACTIVE'&&!ended(a)).filter(a=>{const members=a.loadIds||[a.loadId].filter(Boolean);return !members.length||members.some(id=>(snapshot.loads||[]).some(l=>l.load_id===id&&!DG.PlanningRules?.released(snapshot,id)&&!snapshot.decisions?.[id]?.cancelledAt));});
    const links=new Map(),ambiguous=new Map();
    for(const load of snapshot.loads||[]){
      if(Domain.activity(load)==='INBOUND'||DG.PlanningRules?.released(snapshot,load.load_id)||snapshot.decisions?.[load.load_id]?.cancelledAt)continue;
      const explicit=candidates.filter(a=>(a.loadIds||[a.loadId].filter(Boolean)).includes(load.load_id)||load.shipmentId==='AWIZ:'+a.id);
      const matches=explicit.length?explicit:candidates.filter(a=>{
        const members=(snapshot.loads||[]).filter(l=>(a.loadIds||[a.loadId]).includes(l.load_id)),ownGate=domain?.shipdocks[assignedDock(load,snapshot)]?.physicalGateId,gates=new Set(members.map(l=>domain?.shipdocks[assignedDock(l,snapshot)]?.physicalGateId).filter(Boolean));
        const stores=[a.store,...members.map(l=>l.store)].map(s=>String(s||'').trim().toUpperCase());
        return (!ownGate||!gates.size||gates.size===1&&gates.has(ownGate))&&String(load.store||'').trim()&&stores.includes(String(load.store).trim().toUpperCase());
      });
      if(matches.length===1)links.set(load.load_id,matches[0]);else if(matches.length>1)ambiguous.set(load.load_id,matches.map(a=>a.id));
    }
    return {links,ambiguous};
  }
  function entries(domain,snapshot,schedule,policy={}){
    const requestEntries=(schedule.requests||[]).filter(a=>a.status==='ACTIVE').flatMap(a=>{const loadIds=requestMembers(a,snapshot),load=loadIds.map(id=>(snapshot.loads||[]).find(l=>l.load_id===id)).find(l=>l&&!DG.PlanningRules?.released(snapshot,l.load_id)&&!snapshot.decisions?.[l.load_id]?.cancelledAt&&assignedDock(l,snapshot)),dock=load&&domain.shipdocks[assignedDock(load,snapshot)];return dock?[{...a,loadIds,loadId:load.load_id,physicalGateId:dock.physicalGateId,activity:'OUTBOUND',source:'REQUEST'}]:[];});
    const manual=[...schedule.appointments.filter(a=>a.status==='ACTIVE'&&(!a.loadId||!DG.PlanningRules?.released(snapshot,a.loadId)&&!snapshot.decisions?.[a.loadId]?.cancelledAt)).map(a=>a.loadId?{...a,loadIds:requestMembers({...a,loadIds:[a.loadId]},snapshot)}:a),...requestEntries].map(a=>({...a,...stageFor(domain,snapshot,a),...appointmentWindow(a,policy),activity:Domain.activity((snapshot.loads||[]).find(l=>l.load_id===a.loadId)||a),source:a.source||'MANUAL'})),linked=new Set(manual.flatMap(a=>[a.loadId,...(a.loadIds||[])]).filter(Boolean)),result=[...manual],issues=[];
    for(const a of manual)if(!domain.gates[a.physicalGateId])issues.push(a.id+': nieznana rampa '+a.physicalGateId);
    for(const load of snapshot.loads||[]){if(linked.has(load.load_id)||DG.PlanningRules?.released(snapshot,load.load_id)||snapshot.decisions?.[load.load_id]?.cancelledAt)continue;const dock=domain.shipdocks[String(assignedDock(load,snapshot)).toUpperCase()];if(!dock?.physicalGateId)continue;
      try{const w=loadWindow(load,policy);if(!w){issues.push(load.load_id+': brak konkretnej daty i godziny');continue;}result.push({...w,...stageFor(domain,snapshot,{loadId:load.load_id,physicalGateId:dock.physicalGateId}),activity:Domain.activity(load),priority:priorityValue(load.vehiclePriority),id:'IMPORT:'+load.load_id,loadId:load.load_id,physicalGateId:dock.physicalGateId,truckLabel:load.truck_label||load.store||load.load_id,loadingMinutes:w.durationMinutes,source:'OPERATIONS',status:'ACTIVE'});}catch(e){issues.push(e.message);}
    }return {entries:result.map(a=>runtimeEntry(a,snapshot)).filter(Boolean).sort((a,b)=>a.start-b.start),issues};
  }
  function manualWindow(gate,meta={}){
    const status=meta.leftovers?'OCCUPIED':meta.state||gate.state||'AVAILABLE';if(status==='AVAILABLE'&&!['READY','LOADING'].includes(meta.operational_status))return null;
    const state=status==='BLOCKED'?'BLOCKED':'OCCUPIED',end=meta.leftovers?Infinity:meta.state_until?Date.parse(meta.state_until):Infinity,start=meta.state_since?Date.parse(meta.state_since):-Infinity;
    const activity=state==='BLOCKED'||meta.leftovers?'OTHER':meta.occupancy_kind==='OTHER'?'OTHER':meta.occupancy_kind==='LOADING'||['READY','LOADING'].includes(meta.operational_status)?'LOADING':meta.blocked_reason?.trim()?'OTHER':'LOADING';
    return {start:Number.isFinite(start)?start:-Infinity,end:Number.isFinite(end)?end:Infinity,status:state,activity,truckLabel:meta.blocked_reason||'Stan ręczny rampy',source:'STATE',id:'STATE:'+gate.gateId};
  }
  function calendarWindows(gate,meta){
    const result=[];for(const c of [...(gate.calendar||[]),...(meta?.calendar||[])]){if(c.available===true||c.reservation)continue;
      try{const w=c.loadingWindow||c.loading_window||c,date=c.loading_date||c.date,rawEnd=w.end??c.loading_end,start=timestamp(w.start??c.loading_start??c.loading_time,date);let end=timestamp(rawEnd,date);
        if(start!=null&&end!=null&&end<=start&&/^\d{1,2}:\d{2}$/.test(String(rawEnd)))end=timestamp(rawEnd,nextDate(localValue(start).slice(0,10)));
        if(start!=null&&end!=null&&end<=start)throw Error('Invalid calendar window');
        result.push({start:start??-Infinity,end:end??Infinity,status:'BLOCKED',source:'CALENDAR',id:'CAL:'+result.length,truckLabel:c.reason||'Blokada kalendarza'});
      }catch(_) {result.push({start:-Infinity,end:Infinity,status:'BLOCKED',source:'CALENDAR',truckLabel:'Kalendarz wymaga korekty'});}
    }return result;
  }
  function bufferWindows(bookings,policy={}){return bookings.flatMap(a=>{if(a.actual)return [];const w=reservationWindow(a,Domain.activity(a),policy);return w.reservationEnd>w.end?[{id:'BUFFER:'+a.id,physicalGateId:a.physicalGateId,start:w.end,end:w.reservationEnd,status:'BUFFER',source:'BUFFER',truckLabel:'Bufor po '+a.truckLabel}]:[];});}
  function gateAt(domain,snapshot,all,gateId,at,policy={}){
    const gate=domain.gates[gateId],meta=snapshot.gateStates?.[gateId]||{},manual=manualWindow(gate,meta),bookings=all.filter(a=>a.physicalGateId===gateId),active=bookings.filter(a=>covers(occupancyWindow(a),at)),hardBlocks=calendarWindows(gate,meta).filter(a=>covers(a,at)),buffers=bufferWindows(bookings,policy).filter(a=>covers(a,at)),state=manual&&covers(manual,at)?manual:null;
    const capacity=meta.loadingCapacity??gate.loadingCapacity??(meta.allowConcurrentLoading||gate.allowConcurrentLoading?Infinity:1);
    const status=gate.active===false||hardBlocks.length||state?.status==='BLOCKED'?'BLOCKED':state||active.length?'OCCUPIED':buffers.length?'BUFFER':'AVAILABLE',blocks=hardBlocks;
    const conflict=new Set(active.map(a=>Domain.activity(a))).size>1||active.length>capacity||!!active.length&&(!!hardBlocks.length||state?.status==='BLOCKED');
    const displayStatus=status==='OCCUPIED'&&state?.activity==='OTHER'?'OTHER':status;
    return {gateId,physicalChamber:gate.physicalChamber,status,displayStatus,active,next:bookings.find(a=>a.start>at),manual:state,blocks,buffers,conflict,bufferWarning:!!buffers.length&&!!active.length};
  }
  function timingConflicts(domain,snapshot,all,policy={}){const ids=new Set(),gates=new Map();for(const gateId of new Set(all.map(a=>a.physicalGateId))){const gate=domain.gates[gateId];if(!gate)continue;const bookings=all.filter(a=>a.physicalGateId===gateId),meta=snapshot.gateStates?.[gateId]||{},manual=manualWindow(gate,meta),points=[...bookings.flatMap(a=>[a.start,a.end]),...calendarWindows(gate,meta).map(a=>a.start),manual?.start].filter(Number.isFinite);for(const t of points){const info=gateAt(domain,snapshot,bookings,gateId,t,policy);if(info.conflict){const affected=[...info.active.map(a=>a.id),...info.buffers.map(a=>a.id.replace(/^BUFFER:/,''))];const set=gates.get(gateId)||new Set();for(const id of affected){ids.add(id);set.add(id);}gates.set(gateId,set);}}}return {count:ids.size,byGate:new Map([...gates].map(([id,set])=>[id,set.size]))};}
  function checkAvailability(schedule,candidate,domain,snapshot,policy={},skip={}){
    const gate=domain.gates[candidate.physicalGateId],ids=new Set(skip.loadIds||[]);
    if(!gate||gate.active===false)throw Error('Wybierz aktywną rampę.');
    if(!Domain.allows(gate,Domain.activity(candidate),'DYNAMIC'))throw Error('Przeznaczenie rampy nie dopuszcza tej aktywności.');
    const meta=snapshot.gateStates?.[gate.gateId]||{},manual=manualWindow(gate,meta),hard=[...(manual&&overlap(candidate,manual)?[manual]:[]),...calendarWindows(gate,meta).filter(a=>overlap(candidate,a))];
    const other=entries(domain,snapshot,schedule,policy).entries.filter(a=>a.physicalGateId===gate.gateId&&a.id!==skip.id&&![a.loadId,...(a.loadIds||[])].filter(Boolean).some(id=>ids.has(id)));
    const competing=other.map(a=>({...a,...occupancyWindow(a)})).filter(a=>overlap(candidate,a)),capacity=meta.loadingCapacity??gate.loadingCapacity??(meta.allowConcurrentLoading||gate.allowConcurrentLoading?Infinity:1);
    const events=competing.flatMap(a=>[[Math.max(a.start,candidate.start),1],[Math.min(a.end,candidate.end),-1]]).sort((a,b)=>a[0]-b[0]||a[1]-b[1]);let count=0,collision=!(capacity>=1);for(const[,delta]of events){count+=delta;if(count>=capacity)collision=true;}
    const describe=a=>a.truckLabel+' ('+(Number.isFinite(a.start)?localValue(a.start).replace('T',' '):'bez początku')+' – '+(Number.isFinite(a.end)?localValue(a.end).replace('T',' '):'do potwierdzenia')+')';
    const mixed=competing.some(a=>Domain.activity(a)!==Domain.activity(candidate));
    let problem=!(capacity>=1)?'Rampa nie ma dostępnej pojemności załadunkowej.':hard.length?'Rampa jest zajęta lub zablokowana w tym terminie: '+hard.map(describe).join(', '):mixed?'Konflikt czasowy: rampa nie może jednocześnie obsługiwać załadunku i rozładunku.':collision?'Konflikt czasowy z rezerwacją: '+competing.map(describe).join(', '):'';
    for(const shipDockId of candidate.shipDockIds||[]){
      const dock=Domain.validateAssignment(domain,shipDockId,gate.gateId),stage=dock.temporaryObjectId||shipDockId,range=stageWindow({...candidate,shipDockId,loadId:candidate.loadIds?.[0]},domain,snapshot,policy);
      if(!dock.active||!Domain.allows(dock,Domain.activity(candidate)))problem='Stage jest nieaktywny lub nie dopuszcza tej aktywności.';
      if(other.some(a=>{
        const docks=[a.shipDockId,...(a.loadIds||[]).map(id=>{const load=(snapshot.loads||[]).find(l=>l.load_id===id);return load?assignedDock(load,snapshot):'';})].filter(Boolean);
        return docks.some(id=>(domain.shipdocks[id]?.temporaryObjectId||id)===stage)&&overlap(stageWindow(a,domain,snapshot,policy),range);
      }))problem='Konflikt czasowy: Stage pozostaje zajęty przez inny transport.';
    }
    if(problem){const error=Error(problem);error.code='SCHEDULING_CONFLICT';error.canRecordDelay=false;throw error;}
    const buffers=other.filter(a=>{const w=reservationWindow(a,Domain.activity(a),policy),own={start:candidate.end,end:candidate.reservationEnd},theirs={start:a.end,end:w.reservationEnd};return own.end>own.start&&overlap(own,{start:a.start,end:w.reservationEnd})||theirs.end>theirs.start&&overlap(theirs,{start:candidate.start,end:candidate.reservationEnd});});
    const bufferNote=buffers.length?'Nakładanie wyłącznie na bufor rampy: '+buffers.map(describe).join(', '):null;
    if(bufferNote&&!candidate.acknowledgeBufferConflict){const error=Error(bufferNote);error.code='BUFFER_OVERLAP';error.canAcknowledgeBuffer=true;throw error;}
    return {bufferNote};
  }
  function saveRequest(schedule,input,domain,snapshot,now=Date.now(),policy={}){
    const old=(schedule.requests||[]).find(a=>a.id===input.id);if(input.id&&!old)throw Error('Ta awizacja nie istnieje.');
    if(input.activity&&input.activity!=='OUTBOUND')throw Error('Awizacja outbound wymaga właściwej aktywności.');
    const id=old?.id||'A'+schedule.nextNumber,loadIds=[...new Set(input.loadIds||[])],loads=[];
    if(!Array.isArray(input.loadIds||[])||loadIds.some(id=>typeof id!=='string'||!id))throw Error('Nieprawidłowa lista zamówień.');
    const progress=snapshot.vehicleStates?.[id];if(old?.status==='CANCELLED'||progress?.completedAt||progress?.cancelledAt)throw Error('Zakończonej lub anulowanej awizacji nie można edytować.');
    if(old&&requestMembers(old,snapshot).some(member=>!loadIds.includes(member)&&(snapshot.loads||[]).some(l=>l.load_id===member&&assignedDock(l,snapshot))))throw Error('Zatwierdzonego zamówienia auta nie można odłączyć tym formularzem.');
    if(progress?.startedAt&&(old.loadIds||[]).some(id=>!loadIds.includes(id)))throw Error('Nie można odebrać zamówień autu podczas obsługi.');
    for(const loadId of loadIds){const load=(snapshot.loads||[]).find(l=>l.load_id===loadId);
      if(!load||Domain.activity(load)!=='OUTBOUND'||DG.PlanningRules.released(snapshot,loadId)||snapshot.decisions?.[loadId]?.cancelledAt)throw Error('Nieprawidłowe zamówienie: '+loadId);
      if((schedule.requests||[]).some(a=>a.id!==id&&a.status==='ACTIVE'&&requestMembers(a,snapshot).includes(loadId))||schedule.appointments.some(a=>a.status==='ACTIVE'&&a.loadId===loadId))throw Error('Zamówienie '+loadId+' jest już przypisane do innego auta.');loads.push(load);
    }
    const store=String(input.store||old?.store||loads[0]?.store||'').trim(),stores=[store,...loads.map(l=>l.store)].filter(Boolean);
    if(stores.some(a=>stores.some(b=>!DG.PlanningRules.sameStores(a,b,policy.planningRules))))throw Error('Sklepy nie mogą jechać razem według ustawień.');
    const docks=[...new Set(loads.map(l=>assignedDock(l,snapshot)).filter(Boolean))],gates=new Set(docks.map(d=>Domain.validateAssignment(domain,d).physicalGateId));
    if(gates.size>1)throw Error('Zamówienia mają różne zatwierdzone rampy. Rozdziel je na właściwe auta; przydziały pozostają niezmienne.');
    const plannedStart=typeof input.arrivalAt==='number'?input.arrivalAt:timestamp(input.arrivalAt),loadingMinutes=Number(input.loadingMinutes),delayMinutes=delayValue(input.delayMinutes),truckLabel=String(input.truckLabel||'').trim(),delayReason=String(input.delayReason||'').trim(),priority=savedPriority(input,old);
    if(!Number.isFinite(plannedStart)||!Number.isInteger(loadingMinutes)||loadingMinutes<1||loadingMinutes>10080||!truckLabel||truckLabel.length>160||delayReason.length>160||store.length>160)throw Error('Podaj auto, poprawny termin i czas obsługi.');
    const record={...old,id,status:'ACTIVE',activity:'OUTBOUND',physicalGateId:null,loadIds,store,truckLabel,arrivalAt:new Date(plannedStart).toISOString(),loadingMinutes,delayMinutes,delayReason,priority,legacyPriority:legacyPriority(input,old),priorityReviewRequired:priority==null,createdAt:old?.createdAt||new Date(now).toISOString(),updatedAt:new Date(now).toISOString()};
    const physicalGateId=[...gates][0];let bufferNote=null;
    if(progress?.startedAt&&progress.physicalGateId!==physicalGateId)throw Error('Faktycznie obsługiwane auto nie może zmienić rampy.');
    if(physicalGateId){const candidate={...record,...appointmentWindow(record,policy),physicalGateId,shipDockIds:docks,acknowledgeBufferConflict:input.acknowledgeBufferConflict};bufferNote=checkAvailability(schedule,candidate,domain,snapshot,policy,{id,loadIds}).bufferNote;}
    return validate({...schedule,nextNumber:old?schedule.nextNumber:schedule.nextNumber+1,requests:[...(schedule.requests||[]).filter(a=>a.id!==id),{...record,bufferConflictNote:bufferNote,bufferAcknowledgedAt:bufferNote?new Date(now).toISOString():null}]});
  }
  function saveAppointment(schedule,input,domain,snapshot,now=Date.now(),policy={}){
    const gate=domain.gates[input.physicalGateId];if(!gate||gate.active===false)throw Error('Wybierz aktywną rampę.');
    const plannedArrival=typeof input.arrivalAt==='number'?input.arrivalAt:timestamp(input.arrivalAt);if(!Number.isFinite(plannedArrival))throw Error('Podaj konkretną datę i godzinę ETA.');const delayMinutes=delayValue(input.delayMinutes),delayReason=String(input.delayReason||'').trim();if(delayReason.length>160)throw Error('Powód opóźnienia może mieć do 160 znaków.');const arrival=plannedArrival+delayMinutes*MINUTE;
    const loadingMinutes=Number(input.loadingMinutes),truckLabel=String(input.truckLabel||'').trim();if(!truckLabel||truckLabel.length>160)throw Error('Podaj opis lub numer ciężarówki (do 160 znaków).');if(!Number.isFinite(loadingMinutes)||loadingMinutes<1||loadingMinutes>10080)throw Error('Czas załadunku musi wynosić od 1 do 10080 minut.');
    const old=schedule.appointments.find(a=>a.id===input.id);if(input.id&&!old)throw Error('Ta rezerwacja nie istnieje.');
    const progress=old&&snapshot.vehicleStates?.[old.id];if(progress?.completedAt||progress?.cancelledAt)throw Error('Zakończonego auta nie można edytować.');
    if(progress?.startedAt&&(old.physicalGateId!==input.physicalGateId||input.shipDockId!=null&&input.shipDockId!==(old.shipDockId||'')))throw Error('Nie można zmienić Stage’a ani rampy podczas obsługi auta.');
    const loadId=input.loadId||null;if(loadId){const load=(snapshot.loads||[]).find(l=>l.load_id===loadId),dock=load&&domain.shipdocks[String(assignedDock(load,snapshot)).toUpperCase()];if(dock?.physicalGateId!==input.physicalGateId)throw Error('Rampa powiązanego loadu wynika z jego ShipDocku.');if(schedule.appointments.some(a=>a.id!==old?.id&&a.status==='ACTIVE'&&a.loadId===loadId))throw Error('Ten load ma już ręczną rezerwację.');}
    if(loadId&&(schedule.requests||[]).some(a=>a.status==='ACTIVE'&&requestMembers(a,snapshot).includes(loadId)))throw Error('Ten consignment ma już awizację. Edytuj całe auto w Awizacjach.');
    const derived=loadId?stageFor(domain,snapshot,{loadId,physicalGateId:gate.gateId}).shipDockId:null;let shipDockId=String(input.shipDockId??derived??old?.shipDockId??'').trim().toUpperCase()||null;
    if(shipDockId&&domain.shipdocks[shipDockId]?.physicalGateId!==gate.gateId)throw Error('Stage musi być przypisany do wybranej rampy.');
    if(loadId&&shipDockId!==derived)throw Error('Stage powiązanego loadu wynika z jego ShipDocku.');
    const linkedLoad=(snapshot.loads||[]).find(l=>l.load_id===loadId),activity=Domain.activity(linkedLoad||{activity:input.activity||old?.activity});
    if(activity==='INBOUND')shipDockId=null;
    if(!Domain.allows(gate,activity,'DYNAMIC')||shipDockId&&!Domain.allows(domain.shipdocks[shipDockId],activity))throw Error('Przeznaczenie rampy lub Stage nie dopuszcza tej aktywności.');
    const store=String(input.store??old?.store??'').trim();if(store.length>160)throw Error('Sklep może mieć do 160 znaków.');
    const priority=savedPriority(input,old),candidate={...appointmentWindow({arrivalAt:new Date(plannedArrival).toISOString(),loadingMinutes,delayMinutes,activity},policy),physicalGateId:gate.gateId,activity,shipDockIds:shipDockId?[shipDockId]:[],loadIds:loadId?[loadId]:[],acknowledgeBufferConflict:input.acknowledgeBufferConflict};
    const {bufferNote}=checkAvailability(schedule,candidate,domain,snapshot,policy,{id:old?.id,loadIds:loadId?[loadId]:[]});
    const id=old?.id||'R'+schedule.nextNumber,record={...old,id,activity,store,priority,legacyPriority:legacyPriority(input,old),priorityReviewRequired:priority==null,physicalGateId:gate.gateId,truckLabel,arrivalAt:new Date(plannedArrival).toISOString(),loadingMinutes,loadId,shipDockId,delayMinutes,delayReason,bufferConflictNote:bufferNote,bufferAcknowledgedAt:bufferNote?new Date(now).toISOString():null,delayConflictNote:null,delayConflictAcknowledgedAt:null,status:'ACTIVE',createdAt:old?.createdAt||new Date(now).toISOString(),updatedAt:new Date(now).toISOString()};
    return validate({...schedule,nextNumber:old?schedule.nextNumber:schedule.nextNumber+1,appointments:[...schedule.appointments.filter(a=>a.id!==id),record]});
  }
  function mergeAppointments(schedule,incoming,domain,snapshot,policy={}){
    const fingerprint=a=>JSON.stringify([a.physicalGateId,a.truckLabel,a.arrivalAt,a.loadingMinutes,Domain.activity(a),a.loadId||null,stageFor(domain,snapshot,a).shipDockId||a.shipDockId||null,a.delayMinutes||0,a.delayReason||'',a.priority||null]);
    let next=validate(schedule);const seen=new Set(next.appointments.filter(a=>a.status==='ACTIVE').map(fingerprint));
    for(const a of validate(incoming).appointments.filter(a=>a.status==='ACTIVE')){if(seen.has(fingerprint(a)))continue;next=saveAppointment(next,{...a,id:null,priorityReviewRequired:!priorityValue(a.priority)},domain,snapshot,Date.now(),policy);seen.add(fingerprint(a));}
    return next;
  }
  function televisionPlan(domain,snapshot,schedule,gateId,now=Date.now(),policy={}){
    const gate=domain.gates[gateId];if(!gate)throw Error('Nieznana rampa: '+gateId);
    const result=entries(domain,snapshot,schedule,policy),bookings=result.entries.filter(a=>a.physicalGateId===gateId),state=gateAt(domain,snapshot,bookings,gateId,now,policy),range={start:now,end:now+1440*MINUTE},meta=snapshot.gateStates?.[gateId]||{},manual=manualWindow(gate,meta);
    const timeline=[...bookings,...bufferWindows(bookings,policy),...calendarWindows(gate,meta),...(manual?[manual]:[])].filter(e=>overlap(occupancyWindow(e),range)).map(e=>({...e,displayStart:Math.max(e.start,range.start),displayEnd:Math.min(occupancyWindow(e).end,range.end)})).sort((a,b)=>a.displayStart-b.displayStart);
    return {gate,state,range,timeline,current:state.active,next:bookings.find(a=>a.start>now)||null,timingConflicts:timingConflicts(domain,snapshot,bookings.filter(a=>overlap(a,range)),policy).count,undatedCount:(snapshot.loads||[]).filter(l=>domain.shipdocks[String(assignedDock(l,snapshot)).toUpperCase()]?.physicalGateId===gateId&&!bookings.some(a=>a.loadId===l.load_id)).length};
  }
  function optimizerContext(domain,snapshot,schedule,now=Date.now(),policy={}){
    snapshot=knownStoreSnapshot(snapshot);
    const active=entries(domain,snapshot,schedule,policy).entries.filter(a=>a.source==='MANUAL'||a.source==='REQUEST'||a.activity==='INBOUND'||a.actual),byLoad=new Map(),gateStates={};
    for(const a of active)for(const id of a.loadIds||[a.loadId].filter(Boolean))byLoad.set(id,a);
    for(const a of schedule.requests||[])if(a.status==='ACTIVE'&&!snapshot.vehicleStates?.[a.id]?.completedAt&&!snapshot.vehicleStates?.[a.id]?.cancelledAt)for(const id of a.loadIds)if(!byLoad.has(id))byLoad.set(id,a);
    const matches=appointmentLinks(snapshot,schedule,domain);for(const [id,a]of matches.links)if(!byLoad.has(id))byLoad.set(id,a);
    let datedConstraints=active.length>0;
    for(const [id,gate]of Object.entries(domain.gates)){const meta=snapshot.gateStates?.[id]||{},state={...meta,calendar:calendarWindows(gate,meta).map(w=>({loadingWindow:{start:w.start/MINUTE,end:w.end/MINUTE}})),scheduleCalendar:true},manual=manualWindow(gate,meta);
      if(state.calendar.length)datedConstraints=true;
      if(manual&&Number.isFinite(manual.end)){state.state='AVAILABLE';state.operational_status='';if(manual.end>now)state.calendar.push({loadingWindow:{start:(Number.isFinite(manual.start)?manual.start:0)/MINUTE,end:manual.end/MINUTE}});}
      if(manual&&Number.isFinite(manual.end)&&manual.end>now)datedConstraints=true;
      for(const a of active.filter(a=>a.physicalGateId===id)){const w=a.actual?{...a,end:Infinity,reservationEnd:Infinity}:appointmentWindow(a,policy);if(a.actual){state.occupiedVehicle=a.id;state.occupiedLoadIds=a.loadIds||[a.loadId].filter(Boolean);state.occupiedShipment=a.loadIds?"AWIZ:"+a.id:((snapshot.loads||[]).find(l=>l.load_id===a.loadId)?.shipmentId||a.loadId);}state.calendar.push({reservation:true,shipment:a.loadIds?'AWIZ:'+a.id:((snapshot.loads||[]).find(l=>l.load_id===a.loadId)?.shipmentId||a.loadId),activity:Domain.activity((snapshot.loads||[]).find(l=>l.load_id===a.loadId)||a),loadId:a.loadId,reservationId:a.id,loadingWindow:{start:w.start/MINUTE,end:w.end/MINUTE},bufferWindow:{start:w.end/MINUTE,end:w.reservationEnd/MINUTE}});}gateStates[id]=state;
    }
    const loads=(snapshot.loads||[]).filter(load=>!DG.PlanningRules?.released(snapshot,load.load_id)&&Domain.activity(load)!=='INBOUND').map(load=>{const groupLoad=(snapshot.loads||[]).find(l=>(l.shipmentId||l.load_id)===(load.shipmentId||load.load_id)&&byLoad.has(l.load_id)),a=byLoad.get(load.load_id)||byLoad.get(groupLoad?.load_id),w=a?appointmentWindow(a,policy):loadWindow(load,policy);let result={...load,loadingScheduled:!!w,cancelled:!!snapshot.decisions?.[load.load_id]?.cancelledAt};
      if(w)result={...load,schedulingDateValidated:true,loadingWindow:{start:w.start/MINUTE,end:w.end/MINUTE},gateReservationEnd:w.reservationEnd/MINUTE};
      else if(datedConstraints)result={...result,loadingWindow:{start:'UNKNOWN_DATE',end:'UNKNOWN_DATE'}};
      
      for(const kind of ['staging']){const rawWindow=load[kind+'Window']||load[kind+'_window'],rawEnd=rawWindow?.end??load[kind+'_end'],start=timestamp(rawWindow?.start??load[kind+'_start'],load.loading_date||load.date);let end=timestamp(rawEnd,load.loading_date||load.date);if(start!=null){if(end!=null&&end<=start&&/^\d{1,2}:\d{2}$/.test(String(rawEnd)))end=timestamp(rawEnd,nextDate(localValue(start).slice(0,10)));result={...result,[kind+'Window']:{start:start/MINUTE,end:end==null?null:end/MINUTE}};}}
      const hasStageWindow=load.stagingWindow||load.staging_window||load.staging_start||load.staging_end;
      if(hasStageWindow&&!result.stagingWindow&&w&&load.staging_end&&!load.staging_start){const end=timestamp(load.staging_end,load.loading_date||load.date);if(end==null||end<=w.start)throw Error('Nieprawidłowy koniec zajęcia Stage: '+load.load_id);result={...result,stagingWindow:{start:w.start/MINUTE,end:end/MINUTE}};}
      if((policy.stageWindowMode==='ETA'||Domain.activity(load)==='INBOUND')&&!hasStageWindow){if(w)result={...result,stagingWindow:{start:(w.plannedStart??w.start)/MINUTE-(Domain.activity(load)==='INBOUND'?0:(policy.stagingBeforeMinutes||0)),end:w.end/MINUTE+(policy.stagingAfterMinutes||0)}};else result={...result,stagingWindow:{start:'UNKNOWN_DATE',end:'UNKNOWN_DATE'},validation:[result.validation,'ETA_REQUIRED_FOR_STAGE_WINDOW'].filter(Boolean).join(' · ')};}
      if(w?.delayMinutes&&hasStageWindow){const stage=DG.ShipDockOptimizer.interval(result,'staging');if(Number.isFinite(stage.start))result={...result,stagingWindow:{start:stage.start,end:Math.max(stage.end,w.end/MINUTE)}};}
      if(policy.stageWindowMode==='CONFIRMED_RELEASE')result={...result,stagingWindow:{start:-Infinity,end:Infinity}};
      result.cancelled=!!snapshot.decisions?.[load.load_id]?.cancelledAt;if(w)result.loadingScheduled=true;if(result.cancelled)result.loadingScheduled=false;
      if(a&&(a.loadIds||a.loadId)&&Domain.activity(a)==='OUTBOUND')result.shipmentId='AWIZ:'+a.id;
      result.appointmentSelectionRequired=matches.ambiguous.has(load.load_id);result.appointmentCandidates=matches.ambiguous.get(load.load_id)||[];
      result.vehicleId=a?.id||null;
      result.actualStartedAt=a?.actualStartedAt||null;
      const reportPriority=load.workloadSource==='MTM'&&load.mtm?.prioritySource==='REPORT';
      result.vehiclePriority=priorityValue(a?.priority)||(a?null:priorityValue(load.vehiclePriority)||(reportPriority||load.priority==null||String(load.priority).trim()===''?'NORMAL':null));
      result.priorityReviewRequired=!result.vehiclePriority;

      return result;
    });const reservations=active.flatMap(a=>{const stage=stageFor(domain,snapshot,a),dock=domain.shipdocks[stage.shipDockId];if(!dock)return [];const w=appointmentWindow(a),hold=stageWindow({...a,...stage,...w},domain,snapshot,policy);return [{loadId:a.loadId||'@RES:'+a.id,shipment:a.loadIds?'AWIZ:'+a.id:((snapshot.loads||[]).find(l=>l.load_id===a.loadId)?.shipmentId||a.loadId),store:(snapshot.loads||[]).find(l=>l.load_id===a.loadId)?.store,stage:dock.temporaryObjectId||dock.shipDockId,gate:null,loading:{start:w.start/MINUTE,end:w.end/MINUTE},staging:{start:hold.start/MINUTE,end:hold.end/MINUTE}}];});return {loads,gateStates,reservations};
  }
  const api={ZONE,KEY,MINUTE,priorityValue,priorityLabel,requestMembers,appointmentLinks,saveRequest,checkAvailability,localValue,parseLocal,timestamp,dayRange,overlap,occupancyWindow,transitionVehicle,assignedDock,delayValue,reservationWindow,appointmentWindow,loadWindow,serviceWindow,validate,Store,stageFor,stageWindow,entries,manualWindow,calendarWindows,bufferWindows,gateAt,timingConflicts,saveAppointment,mergeAppointments,televisionPlan,optimizerContext};DG.GateSchedule=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
