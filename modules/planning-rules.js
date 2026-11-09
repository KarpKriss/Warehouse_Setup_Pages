(function(root){
  'use strict';
  const DG=root.DG=root.DG||{};
  const text=v=>String(v??'').trim();
  const store=v=>text(v).toUpperCase();
  function normalize(value={}){
    if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Nieprawidłowe zasady planowania.');
    const result={referenceAssignments:{},resourceRules:{},joinGroups:[],controlRules:[]};
    if(value.customerNames!=null){
      if(typeof value.customerNames!=='object'||Array.isArray(value.customerNames))throw Error('Nieprawidłowy słownik nazw klientów.');result.customerNames={};
      for(const [key,name]of Object.entries(value.customerNames)){if(!store(key)||store(key).length>200||typeof name!=='string'||!text(name)||name.length>200||/[\x00-\x1f\ufffd]/.test(key+name))throw Error('Nieprawidłowy kod lub nazwa klienta.');result.customerNames[store(key)]=text(name);}
    }
    for(const [key,id]of Object.entries(value.referenceAssignments||{})){
      if(!store(key)||!text(id)||text(id).length>160)throw Error('Nieprawidłowe przypisanie referencyjne.');
      result.referenceAssignments[store(key)]=text(id).toUpperCase();
    }
    for(const [key,r]of Object.entries(value.resourceRules||{})){
      if(!key||!r||!['FIX','DYNAMIC'].includes(r.directionMode||'DYNAMIC'))throw Error('Nieprawidłowa reguła obiektu.');
      const capacity=r.capacity==null||r.capacity===''?null:Number(r.capacity);
      if(capacity!=null&&(!Number.isInteger(capacity)||capacity<1||capacity>1000000))throw Error('Pojemność musi być dodatnią liczbą całkowitą palet.');
      if(r.directionMode==='FIX'&&!store(r.store))throw Error('Kierunek fix wymaga sklepu.');
      result.resourceRules[key]={directionMode:r.directionMode||'DYNAMIC',store:store(r.store),capacity};
    }
    if(!Array.isArray(value.joinGroups||[])||!Array.isArray(value.controlRules||[]))throw Error('Nieprawidłowe listy reguł.');
    result.joinGroups=(value.joinGroups||[]).map(g=>{
      if(!Array.isArray(g)||g.length<2||g.length>100)throw Error('Grupa łączenia wymaga co najmniej dwóch sklepów.');
      const ids=[...new Set(g.map(store))];if(ids.length<2||ids.some(s=>!s))throw Error('Nieprawidłowa grupa sklepów.');return ids;
    });
    result.controlRules=(value.controlRules||[]).map(r=>{
      if(!text(r.column)||!text(r.value)||text(r.column).length>160||text(r.value).length>500)throw Error('Reguła kontroli wymaga kolumny i wartości.');
      return {column:text(r.column),value:text(r.value),enabled:r.enabled!==false};
    });
    if(value.printerRules!=null){
      if(!Array.isArray(value.printerRules)||value.printerRules.length>1000)throw Error('Nieprawidłowe reguły drukarki.');
      const rows=value.printerRules.map(r=>{if(!r||!text(r.column)||!text(r.value)||text(r.column).length>160||text(r.value).length>500||/[\x00-\x1f]/.test(text(r.column)+text(r.value)))throw Error('Reguła drukarki wymaga pola i wartości.');return {column:text(r.column),value:text(r.value),enabled:r.enabled!==false};});
      if(rows.length)result.printerRules=rows;
    }
    return result;
  }
  const sameStores=(a,b,p={})=>!!store(a)&&!!store(b)&&(store(a)===store(b)||(p.joinGroups||[]).some(g=>g.map(store).includes(store(a))&&g.map(store).includes(store(b))));
  const resource=(p,kind,id)=>p?.resourceRules?.[kind+':'+id]||{};
  function allowedDirection(load,dock,policy={}){
    const sr=resource(policy,'STAGE',dock.temporaryObjectId||dock.shipDockId),gr=resource(policy,'GATE',dock.physicalGateId);
    return [sr,gr].every(r=>r.directionMode!=='FIX'||sameStores(load.store,r.store,policy));
  }
  const quantity=load=>(load.tasks||[]).reduce((sum,t)=>sum+(Number(t.quantity)>0?Number(t.quantity):0),0);
  function storeFor(load){if(load.workloadSource==='LAST_PICK_POC'){const L=DG.LastPickImport||(typeof require==='function'?require('./last-pick-import.js'):null);if(!L?.storeReady(load))return '';}if(load.workloadSource==='MTM'){const M=DG.MTMImport||(typeof require==='function'?require('./mtm-import.js'):null);if(!M?.storeReady(load))return '';}return store(load.store);}
  function orderType(load){
    if(load.workloadSource==='LAST_PICK_POC'){
      const L=DG.LastPickImport||(typeof require==='function'?require('./last-pick-import.js'):null);if(!L)throw Error('Brak walidatora Last Pick.');L.validateLoad(load);return load.order_type;
    }
    const types=[...new Set([load.order_type,...(load.tasks||[]).map(t=>t.order_type)].map(store).filter(Boolean))];
    if(types.length>1)throw Error('Consignment '+load.load_id+' ma różne typy zamówienia. Cały consignment musi mieć jeden typ.');
    return types[0]||'';
  }
  const shipment=load=>text(load.shipmentId)||load.load_id;
  const released=(snapshot,id)=>!!snapshot.decisions?.[id]?.stageReleasedAt;
  const dockFor=(snapshot,load)=>snapshot.assignments?.[load.load_id]||load.existingShipDockId||load.current_shipdock||((snapshot.decisions?.[load.load_id]?.accepted||snapshot.decisions?.[load.load_id]?.overridden||snapshot.decisions?.[load.load_id]?.locked)&&snapshot.decisions[load.load_id].chosen_shipdock)||'';
  // These are proposal constraints, not new operational assignments.
  function arrivalLoads(snapshot,model,onlyId=null){
    const live=(snapshot.loads||[]).filter(l=>!released(snapshot,l.load_id)&&dockFor(snapshot,l));
    const byStore=new Map(),byShipment=new Map();for(const l of live){const key=storeFor(l);if(!key)continue;if(!byStore.has(key))byStore.set(key,[]);byStore.get(key).push(l);const group=shipment(l);if(!byShipment.has(group))byShipment.set(group,[]);byShipment.get(group).push(l);}
    return (snapshot.loads||[]).map(original=>{
      if(onlyId&&original.load_id!==onlyId)return original;
      const load={...original};for(const key of ['arrivalSourceIds','arrivalStageIds','arrivalGateIds','arrivalBlockedReason','arrivalCancelledIds','inheritedAssignment'])delete load[key];
      if(snapshot.decisions?.[load.load_id]?.cancelledAt){load.cancelled=true;load.loadingScheduled=false;}
      if(dockFor(snapshot,load)||released(snapshot,load.load_id)||load.cancelled||snapshot.decisions?.[load.load_id]?.cancelledAt)return load;
      const related=[...new Map([...(byStore.get(storeFor(load))||[]),...(storeFor(load)?byShipment.get(shipment(load))||[]:[])].map(l=>[l.load_id,l])).values()].filter(l=>l.load_id!==load.load_id&&(!l.vehicleId||!load.vehicleId||l.vehicleId===load.vehicleId));
      const active=related.filter(l=>!l.cancelled&&!snapshot.decisions?.[l.load_id]?.cancelledAt),cancelled=related.filter(l=>l.cancelled||snapshot.decisions?.[l.load_id]?.cancelledAt),sources=active.length?active:cancelled;
      if(!sources.length)return load;
      load.arrivalSourceIds=sources.map(l=>l.load_id);load.arrivalCancelledIds=active.length?[]:load.arrivalSourceIds;
      const docks=sources.map(l=>model.shipdocks[dockFor(snapshot,l)]).filter(Boolean),stages=[...new Set(docks.map(d=>d.temporaryObjectId||d.shipDockId))],gates=[...new Set(docks.map(d=>d.physicalGateId))],pin=snapshot.proposalPins?.[load.load_id],choice=snapshot.decisions?.[load.load_id]?.arrivalGoods;
      load.arrivalStageIds=stages;load.arrivalGateIds=gates;load.inheritedAssignment=true;
      if(!active.length&&!(choice?.action==='KEEP'&&cancelled.every(l=>choice.sourceLoadIds?.includes(l.load_id))))load.arrivalBlockedReason='ARRIVAL_GOODS_CONFIRMATION_REQUIRED';
      else if(gates.length!==1||stages.length!==1&&!pin)load.arrivalBlockedReason='ACTIVE_ASSIGNMENT_AMBIGUOUS';
      else if(pin){
        const gate=model.shipdocks[pin.shipDockId]?.physicalGateId;
        if(!gates.includes(gate)&&!pin.allowGateChange)load.arrivalBlockedReason='ARRIVAL_GATE_CHANGE_CONFIRMATION_REQUIRED';
        else if(!gates.includes(gate)&&load.vehicleId&&active.some(l=>l.vehicleId===load.vehicleId))load.arrivalBlockedReason='ARRIVAL_GATE_CHANGE_VEHICLE_REQUIRED';
        else{load.arrivalStageIds=[model.shipdocks[pin.shipDockId]?.temporaryObjectId||pin.shipDockId];load.arrivalGateIds=[gate];}
      }
      if(active.length&&!pin?.allowGateChange){const groups=[...new Set(active.map(shipment))];if(groups.length===1)load.shipmentId=groups[0];else if(!load.vehicleId)load.arrivalBlockedReason='ACTIVE_ASSIGNMENT_AMBIGUOUS';}
      return load;
    });
  }
  function resolveArrivalGoods(snapshot,id,cleared,model,now=Date.now()){
    const load=(snapshot.loads||[]).find(l=>l.load_id===id);if(!load||dockFor(snapshot,load))throw Error('Decyzja dotyczy nowego, niezatwierdzonego zamówienia.');
    const context=arrivalLoads(snapshot,model).find(l=>l.load_id===id),sourceLoadIds=context?.arrivalCancelledIds||[];
    if(!sourceLoadIds.length)throw Error('Brak anulowanego towaru do potwierdzenia. Przelicz propozycję.');
    const decisions={...snapshot.decisions},at=new Date(now).toISOString();
    if(cleared){const stages=new Set(sourceLoadIds.map(sourceId=>{const source=snapshot.loads.find(l=>l.load_id===sourceId),dock=model.shipdocks[dockFor(snapshot,source)];return dock?.temporaryObjectId||dock?.shipDockId;}));
      if(snapshot.loads.some(l=>!released(snapshot,l.load_id)&&dockFor(snapshot,l)&&!sourceLoadIds.includes(l.load_id)&&stages.has(model.shipdocks[dockFor(snapshot,l)]?.temporaryObjectId||dockFor(snapshot,l))))throw Error('Stage zawiera również inny aktywny towar. Potwierdź właściwy zakres usunięcia w szczegółach.');
      for(const sourceId of sourceLoadIds)decisions[sourceId]={...decisions[sourceId],stageReleasedAt:at};
    }
    decisions[id]={...decisions[id],arrivalGoods:{action:cleared?'CLEARED':'KEEP',sourceLoadIds,at}};
    return {...snapshot,decisions};
  }
  function cancel(snapshot,id,now=Date.now()){
    const load=snapshot.loads.find(l=>l.load_id===id);if(!load)throw Error('Nie znaleziono zamówienia.');
    return {...snapshot,decisions:{...snapshot.decisions,[id]:{...snapshot.decisions?.[id],cancelledAt:new Date(now).toISOString()}}};
  }
  function release(snapshot,id,now=Date.now(),model=null){
    const load=snapshot.loads.find(l=>l.load_id===id);if(!load||!dockFor(snapshot,load))throw Error('Zamówienie nie ma przypisanego Stage’a.');
    const dock=dockFor(snapshot,load),stage=model?.shipdocks[dock]?.temporaryObjectId||dock,time=new Date(now).toISOString(),decisions={...snapshot.decisions};
    for(const l of snapshot.loads){const assigned=dockFor(snapshot,l),other=model?.shipdocks[assigned]?.temporaryObjectId||assigned;if(assigned&&other===stage&&!released(snapshot,l.load_id))decisions[l.load_id]={...decisions[l.load_id],stageReleasedAt:time};}
    return {...snapshot,decisions};
  }
  function due(snapshot,schedule,policy={},now=Date.now()){
    const S=DG.GateSchedule;return (snapshot.loads||[]).filter(l=>dockFor(snapshot,l)&&!released(snapshot,l.load_id)).flatMap(load=>{
      const d=snapshot.decisions?.[load.load_id]||{},a=schedule.appointments.find(a=>a.status==='ACTIVE'&&a.loadId===load.load_id)||(schedule.requests||[]).find(a=>a.status==='ACTIVE'&&a.loadIds.includes(load.load_id)),w=a?S.appointmentWindow(a):S.loadWindow(load,policy);
      return d.cancelledAt||w&&w.end<=now?[{loadId:load.load_id,store:load.store,shipDockId:dockFor(snapshot,load),cancelled:!!d.cancelledAt,expectedEnd:w?.end??null}]:[];
    });
  }
  function join(snapshot,id,targetId,policy={}){
    const load=snapshot.loads.find(l=>l.load_id===id),target=snapshot.loads.find(l=>l.load_id===targetId);
    if(!load||!target||id===targetId||!sameStores(storeFor(load),storeFor(target),policy))throw Error('Wybierz wysyłkę tego samego sklepu lub dozwolonej grupy sklepów.');
    if(dockFor(snapshot,load)||released(snapshot,targetId)||snapshot.decisions?.[targetId]?.cancelledAt)throw Error('Nie można dołączyć tego zamówienia do wskazanej wysyłki.');
    const group=shipment(target);
    // Vehicle membership must still pass the ordinary proposal/approval path.
    // In particular, an occupied target Stage does not authorize an overflow.
    return {...snapshot,loads:snapshot.loads.map(l=>l.load_id===id||l.load_id===targetId?{...l,shipmentId:group}:l)};
  }
  // Historical assignmentChanges remain readable, but cannot authorize a new
  // change of an accepted assignment. Keep the old API fail-closed for callers.
  function reassign(){throw Error('Zatwierdzony przydział Stage/Gate jest niezmienny. Korektę można wprowadzić tylko przed zatwierdzeniem planu.');}
  function proposalPins(snapshot){
    const input=snapshot.proposalPins??{};
    if(!input||typeof input!=='object'||Array.isArray(input))throw Error('Nieprawidłowe przypięcia propozycji.');
    const loads=new Map((snapshot.loads||[]).map(l=>[l.load_id,l])),result={};
    for(const [id,p]of Object.entries(input)){
      if(!p||typeof p!=='object'||typeof p.shipDockId!=='string'||!text(p.shipDockId)||p.shipDockId.length>160||typeof(p.reason??'')!=='string'||(p.reason||'').length>500)throw Error('Nieprawidłowe przypięcie propozycji: '+id);
      const load=loads.get(id);if(!load)continue;
      const chosen=text(p.shipDockId).toUpperCase(),existing=text(dockFor(snapshot,load)).toUpperCase();
      if(existing){if(existing!==chosen)throw Error('Zatwierdzony przydział Stage/Gate jest niezmienny: '+id);continue;}
      if(p.allowGateChange!=null&&typeof p.allowGateChange!=='boolean')throw Error('Nieprawidłowe potwierdzenie zmiany rampy w propozycji.');
      result[id]={shipDockId:chosen,reason:text(p.reason),...(p.allowGateChange?{allowGateChange:true}:{}),...(p.at?{at:p.at}:{})};
    }
    return result;
  }
  function pin(snapshot,id,dock,reason='',now=Date.now(),allowGateChange=false){
    const load=(snapshot.loads||[]).find(l=>l.load_id===id);
    if(!load)throw Error('Nie znaleziono zamówienia.');
    if(dockFor(snapshot,load))return reassign();
    const next={...snapshot,proposalPins:{...snapshot.proposalPins,[id]:{shipDockId:dock,reason,allowGateChange,at:new Date(now).toISOString()}}};
    return {...next,proposalPins:proposalPins(next)};
  }
  function unpin(snapshot,id){
    const load=(snapshot.loads||[]).find(l=>l.load_id===id);
    if(!load)throw Error('Nie znaleziono zamówienia.');
    if(dockFor(snapshot,load))return reassign();
    const pins={...snapshot.proposalPins};delete pins[id];
    return {...snapshot,proposalPins:pins};
  }
  function sourcePriorities(task,load,cache){
    if(load.workloadSource==='LS'){
      const LS=DG.LSImport||(typeof require==='function'?require('./ls-import.js'):null);let policies=cache?.get(load);if(!policies){policies=LS.controlPolicies(load);cache?.set(load,policies);}return policies.get(task.list_id)?.priorities||[];
    }
    if(load.workloadSource==='MTM')return Object.hasOwn(task,'wms_priority')?[task.wms_priority]:[];
    return [];
  }
  function priorityType(value){const v=text(value);if(!/^\d+(?:\.\d+)?$/.test(v)||v.length>32)return '';const n=Number(v.replace(',','.'));return Number.isFinite(n)?([0,150].includes(n)?'LS':'CC'):'';}
  function businessType(task,load,cache){
    if(['LS','MTM'].includes(load.workloadSource)){const rows=sourcePriorities(task,load,cache),types=rows.map(priorityType);return types.includes('CC')?'CC':types.length&&types.every(t=>t==='LS')?'LS':'';}
    return store(load.workloadSource==='LAST_PICK_POC'?task.order_type:orderType(load));
  }
  function ruleValues(task,load,column,cache){
    const key=text(column).toLowerCase().replace(/[\s-]+/g,'_');
    if(['business_type','typ_zamowienia','klasa_zamowienia'].includes(key))return [businessType(task,load,cache)].filter(Boolean);
    if(['wms_priority','priority_wms'].includes(key)||key==='priority'&&['LS','MTM'].includes(load.workloadSource))return (['LS','MTM'].includes(load.workloadSource)?sourcePriorities(task,load,cache):[task.attributes?.wms_priority??task.wms_priority??load.wms_priority]).map(text).filter(Boolean);
    if(['store','sklep','customer','customer_id'].includes(key))return [text(storeFor(load))].filter(Boolean);
    const ownValue=task.attributes?.[key]??task[key]??load[key];if(ownValue!=null&&text(ownValue))return [text(ownValue)];
    if(load.workloadSource==='LS'){
      const LS=DG.LSImport||(typeof require==='function'?require('./ls-import.js'):null),rows=LS.sourceRows(load).filter(r=>r.list_id===task.list_id);return [...new Set(rows.map(r=>text(r[key])).filter(Boolean))];
    }
    return [];
  }
  function printing(task,load,engine,policy={},indexCache,priorityCache){
    const rules=(policy.printerRules||[]).filter(r=>r.enabled!==false);if(!rules.length)return {required:false,unknown:false,ids:[]};
    let matches=false,unknown=false;for(const rule of rules){const values=ruleValues(task,load,rule.column,priorityCache);if(!values.length)unknown=true;else if(values.some(v=>{const key=text(rule.column).toLowerCase().replace(/[\s-]+/g,'_'),numeric=['priority','wms_priority','priority_wms'].includes(key)&&priorityType(v)&&priorityType(rule.value);return numeric?Number(v)===Number(rule.value):store(v)===store(rule.value);} ))matches=true;}
    if(!matches)return {required:false,unknown,ids:[]};
    if(indexCache?.has(engine))return {required:true,unknown:false,ids:indexCache.get(engine)};
    const areas=(engine.model.geometry.floorAreas||[]).filter(a=>a.kind==='PRINTER'&&a.active!==false),ids=[];
    for(const area of areas){const candidates=[area.temporaryId,...Object.entries(engine.model.locations||{}).filter(([,l])=>l.temporaryObjectId===area.temporaryId).map(([id])=>id)],id=candidates.find(id=>{const e=engine.endpoint?.(id);return e?.mapped&&e.active!==false;});if(id)ids.push(id);}
    indexCache?.set(engine,ids);return {required:true,unknown:false,ids};
  }
  function controlExempt(task,load,cache){
    if(!['LS','MTM'].includes(load.workloadSource))return false;
    return businessType(task,load,cache)==='LS';
  }
  function isControlPoint(id,engine){const endpoint=engine.endpoint?.(id);return String(id).toUpperCase()==='KONTROLA'||(engine.model.geometry.controlAreas||[]).some(a=>a.temporaryId&&[endpoint?.temporaryObjectId,endpoint?.temporarySlotId,id].includes(a.temporaryId));}
  function controls(task,load,engine,policy={},indexCache,priorityCache){
    if(controlExempt(task,load,priorityCache))return null;
    const matches=(policy.controlRules||[]).some(r=>r.enabled!==false&&store(task.attributes?.[r.column]??task[r.column]??load[r.column])===store(r.value));
    // CC is a confirmed business class, independent of editable custom rules.
    // WMS business class comes from Priority; Task Type O remains the process phase.
    const cc=businessType(task,load,priorityCache)==='CC';
    if(!matches&&!task.controlRequired&&!cc)return null;
    if(indexCache?.has(engine))return indexCache.get(engine);
    const areas=new Map((engine.model.geometry.controlAreas||[]).filter(a=>a.temporaryId&&a.active!==false).map(a=>[a.temporaryId,a]));
    const ids=Object.entries(engine.model.locations||{}).filter(([,l])=>l.mapped&&l.active!==false&&areas.has(l.temporaryObjectId)).map(([id])=>id);
    indexCache?.set(engine,ids);return ids;
  }
  function validateSafety(before,after,oldSketch,newSketch,snapshot,policy={},schedule={appointments:[]},timingPolicy=DG.AlgorithmSettings?.DEFAULTS||{defaultLoadingMinutes:60,gateBufferMinutes:120}){
    const Domain=DG.ShipDockDomain;
    for(const a of DG.GateSchedule.entries(before.model,snapshot,schedule,timingPolicy).entries){
      if(!a.actual&&(a.reservationEnd??a.end)<=Date.now())continue;
      const old=before.model.gates[a.physicalGateId],next=after.model.gates[a.physicalGateId];
      if(old?.active!==false&&(!next||next.active===false))throw Error('Rampa ma aktywną rezerwację: '+a.truckLabel);
      if(Domain.allows(old,Domain.activity(a),'DYNAMIC')&&!Domain.allows(next,Domain.activity(a),'DYNAMIC'))throw Error('Przeznaczenie rampy jest wymagane przez aktywną rezerwację: '+a.truckLabel);
    }
    for(const [id,state]of Object.entries(snapshot.gateStates||{}))if((state.leftovers||state.state==='OCCUPIED')&&after.model.gates[id]?.active===false)throw Error('Nie można dezaktywować zajętej rampy '+id+'.');
    const live=(snapshot?.loads||[]).filter(l=>!released(snapshot,l.load_id)&&dockFor(snapshot,l));
    const beforeCostOptions={includeStageToGate:false,planningRules:policy,distanceCache:new Map()},afterCostOptions={includeStageToGate:false,planningRules:policy,distanceCache:new Map()};
    for(const load of live){
      const id=dockFor(snapshot,load),old=before.getShipDock(id),next=after.getShipDock(id);
      if(!next?.active||!after.getGateForShipDock(id)?.active||next.temporaryObjectId!==old?.temporaryObjectId||next.physicalGateId!==old?.physicalGateId)throw Error('Nie można wyłączyć ani zmienić Stage’a lub rampy używanej przez '+load.load_id+'.');
      const flow=Domain.activity(load),cancelled=load.cancelled||snapshot.decisions?.[load.load_id]?.cancelledAt;if(!cancelled&&(Domain.allows(old,flow)&&!Domain.allows(next,flow)||Domain.allows(before.getGateForShipDock(id),flow,'DYNAMIC')&&!Domain.allows(after.getGateForShipDock(id),flow,'DYNAMIC')))throw Error('Przeznaczenie Stage’a lub rampy jest wymagane przez '+load.load_id+'.');
      const endpoints=[id,...(load.tasks||[]).flatMap(t=>[t.source_location,...(t.required_waypoints||[])])].filter(Boolean);
      for(const endpoint of endpoints){const a=before.endpoint(endpoint),b=after.endpoint(endpoint);if(a?.active!==false&&b?.active===false||a?.mapped&&!b?.mapped)throw Error('Obiekt ma aktywne zadania: '+endpoint);}
      const R=DG.ShipDockOptimizer;if(!R)continue;
      const a=R.costFor(load,id,before,beforeCostOptions),b=R.costFor(load,id,after,afterCostOptions);
      if(a.cost!=null&&b.cost==null)throw Error('Zmiana odcina pełną trasę zamówienia '+load.load_id+'. Zachowaj dostęp podczas pracy.');
    }
  }
  const labels={APPOINTMENT_SELECTION_REQUIRED:'Kilka aut sklepu — wybierz całe consignmenty w Awizacjach',ARRIVAL_GOODS_CONFIRMATION_REQUIRED:'Potwierdź, czy usunięto stary towar po anulowanej wysyłce',ACTIVE_ASSIGNMENT_AMBIGUOUS:'Kilka aktywnych przydziałów sklepu — wymagana decyzja operatora',ARRIVAL_GATE_CHANGE_CONFIRMATION_REQUIRED:'Inna rampa wymaga jawnego odstępstwa w propozycji',ARRIVAL_GATE_CHANGE_VEHICLE_REQUIRED:'Auto ma już inną rampę — wybierz osobne auto w Awizacjach',ARRIVAL_STAGE_REQUIRED:'Nowy napływ musi użyć aktywnego Stage’a i rampy sklepu',ARRIVAL_STAGE_FULL:'Brak miejsca na aktywnym Stage’u — zamówienie czeka na decyzję operatora',VEHICLE_PRIORITY_REQUIRED:'Wybierz ręcznie priorytet starszego auta w Awizacjach',BUFFER_OVERLAP:'Nakładanie na bufor rampy — czasy obsługi nie kolidują',ORDER_TYPE_CONFLICT:'Consignment zawiera różne typy zamówienia',STORE_REQUIRED:'Uzupełnij sklep docelowy zamówienia',FIXED_DIRECTION_MISMATCH:'Niezgodny stały kierunek Stage’a lub rampy',STAGE_OCCUPIED:'Stage jest zajęty lub zarezerwowany',SHIPMENT_STAGE_CONFLICT:'Wysyłka ma już inny Stage',GATE_LOADING_CONFLICT:'Rampa ma inne auto w tym czasie',GATE_ACTIVITY_CONFLICT:'Konflikt inbound i outbound',GATE_CALENDAR_BLOCKED:'Rampa zablokowana w kalendarzu',GATE_UNAVAILABLE:'Rampa niedostępna',SHIPDOCK_UNAVAILABLE:'Stage niedostępny',INACTIVE_RESOURCE:'Obiekt jest nieaktywny',STAGE_ACTIVITY_MISMATCH:'Stage nie obsługuje tej operacji',GATE_ACTIVITY_MISMATCH:'Rampa nie obsługuje tej operacji',PRINTER_RULE_DATA_UNAVAILABLE:'Brak danych do oceny reguły drukarki',REQUIRED_PRINTER_UNAVAILABLE:'Brak dostępnej drukarki',REQUIRED_PRINTER_ROUTE_UNAVAILABLE:'Brak pełnej trasy przez drukarkę i wymagane punkty',REQUIRED_CONTROL_UNAVAILABLE:'Brak dostępnej kontroli z pełną trasą',STAGE_GATE_ROUTE_UNAVAILABLE:'Brak pełnej trasy Stage → Gate',SPATIAL_COST_NEEDS_VALIDATION:'Brak potwierdzonego dystansu',SHIPMENT_CANCELLED:'Wysyłka anulowana — Stage czeka na potwierdzenie usunięcia towaru'};
  Object.assign(labels,{
    STAGE_NOT_MAPPED:'Stage nie ma potwierdzonego miejsca na mapie',
    TASK_LOCATION_MISSING:'W zadaniu brakuje adresu początku lub końca trasy',
    SHIPDOCK_NEEDS_VALIDATION:'Stage nie ma potwierdzonego przypisania do rampy',
    SPATIAL_COST_NEEDS_VALIDATION:'Nie można obliczyć pełnego dystansu dla wszystkich zadań',
    SPATIAL_ROUTE_UNAVAILABLE:'Brak pełnej trasy do Stage’a',
    REQUIRED_WAYPOINT_ROUTE_UNAVAILABLE:'Brak pełnej trasy przez wymagany punkt pośredni',
    REQUIRED_WAYPOINT_INVALID:'Nieprawidłowa lista wymaganych punktów trasy'
  });
  const reasonLabel=value=>labels[value]||DG.MTMImport?.labels[value]||(String(value).startsWith('NO_FEASIBLE_SHIPDOCK')?'Brak dostępnego Stage’a z pełną trasą i zgodnym kalendarzem':value);
  // Presentation only: a failed leg is evidence from one unsuccessful route,
  // not a promise that repairing this one leg makes the whole candidate feasible.
  function exclusionDetail(candidate,endpointLabel=id=>String(id).replace(/^GATE:/,'rampa ')){
    const c=candidate,leg=c.failedLeg,from=leg&&endpointLabel(leg.from),to=leg&&endpointLabel(leg.to);
    const causes={
      SOURCE_NOT_MAPPED:['Początek odcinka nie jest zmapowany: '+from+'.','Przypisz ten adres do obiektu na mapie.'],
      DESTINATION_NOT_MAPPED:['Koniec odcinka nie jest zmapowany: '+to+'.','Przypisz ten adres do obiektu na mapie.'],
      MISSING_ACTIVE_ACCESS:['Brak aktywnego, potwierdzonego wyjazdu z początku lub wjazdu do końca odcinka.','Sprawdź Dostępy obu obiektów, kierunki wjazdu/wyjazdu i włączenie przypisanych linii.'],
      SOURCE_ROAD_ACCESS_NOT_VALIDATED:['Brak potwierdzonego dojazdu dla: '+from+'.','Sprawdź przypisanie tego obiektu do drogi.'],
      DESTINATION_ROAD_ACCESS_NOT_VALIDATED:['Brak potwierdzonego dojazdu dla: '+to+'.','Sprawdź przypisanie tego obiektu do drogi.'],
      NO_ALLOWED_ROUTE:['Brak przejezdnego połączenia między dojazdami.','Sprawdź ciągłość dróg i kierunki ruchu między wskazanymi obiektami.'],
      NO_ALLOWED_ROAD_PATH:['Brak przejezdnego połączenia w sieci dróg.','Sprawdź ciągłość dróg i kierunki ruchu.'],
      LINES_NOT_CONNECTED:['Odcinki dróg nie są połączone.','Połącz drogi między wskazanymi obiektami.'],
      SKETCH_ACCESS_NOT_VALIDATED:['Szkic lub zapisane dojazdy nie przeszły walidacji.','Sprawdź komunikaty walidacji szkicu w Warehouse Setup.'],
      INACTIVE_OBJECT:['Jeden z obiektów odcinka jest nieaktywny.','Sprawdź właściwości obu obiektów.'],
      SHIPDOCK_NEEDS_VALIDATION:['Brak potwierdzonego przypisania Stage’a do rampy.','Sprawdź przypisanie rampy w Warehouse Setup.'],
      SOURCE_COORDINATES_INVALID:['Nieprawidłowe współrzędne początku odcinka.','Sprawdź położenie obiektu na mapie.'],
      DESTINATION_COORDINATES_INVALID:['Nieprawidłowe współrzędne końca odcinka.','Sprawdź położenie obiektu na mapie.'],
      DISTANCE_NOT_CALIBRATED:['Trasa istnieje, ale nie można przeliczyć jej długości na metry.','Sprawdź skalę planu magazynu.']
    };
    const tips={STAGE_NOT_MAPPED:'W Warehouse Setup przypisz adres Stage’a do właściwego obiektu i potwierdź jego położenie.',TASK_LOCATION_MISSING:'Uzupełnij adres w danych zadania.',SHIPDOCK_NEEDS_VALIDATION:'Sprawdź przypisanie Stage’a do rampy w Warehouse Setup.',REQUIRED_CONTROL_UNAVAILABLE:'Sprawdź aktywne pola kontroli i ich dojazdy.',REQUIRED_PRINTER_UNAVAILABLE:'Sprawdź aktywne drukarki i regułę wymagającą wydruku.',PRINTER_RULE_DATA_UNAVAILABLE:'Uzupełnij pole wymagane przez regułę drukarki.',SPATIAL_COST_NEEDS_VALIDATION:'Sprawdź adresy, ilości i mapowanie wszystkich zadań.'};
    const cause=leg&&(causes[leg.reason]||['Nie udało się potwierdzić przejazdu na tym odcinku.','Sprawdź mapowanie, dojazdy oraz połączenie dróg.']);
    return {title:reasonLabel(c.reason),segment:leg?from+' → '+to:null,detail:cause?.[0]||null,hint:cause?.[1]||tips[c.reason]||null,code:leg?.reason||c.reason};
  }
  function sameProposal(shown,fresh){
    if(!Array.isArray(shown)||!Array.isArray(fresh)||shown.some(r=>!r)||fresh.some(r=>!r))return false;
    const Domain=DG.ShipDockDomain||(typeof require==='function'?require('./shipdock-domain.js'):null);
    const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
    const describe=rows=>rows.map(r=>({id:r.load.load_id,store:r.load.store,picks:(r.load.tasks||[]).map(t=>JSON.stringify(canonical(t))).sort(),activity:Domain.activity(r.load),fixed:!!r.fixed,stage:r.recommendedShipdock,gate:r.gate,chamber:r.physicalChamber,feasible:r.feasible,units:r.totalUnits,reference:r.referenceShipdock,currentCost:r.currentCost,cost:r.optimizedCost,saving:r.saving,window:r.window,warnings:[...new Set(r.warnings||[])].sort(),vehicle:r.load.vehicleId,priority:r.load.vehiclePriority,shipment:r.load.shipmentId,loading:r.load.loadingWindow,staging:r.load.stagingWindow,scheduled:r.load.loadingScheduled,reservationEnd:r.load.gateReservationEnd})).sort((a,b)=>String(a.id).localeCompare(String(b.id)));
    return JSON.stringify(describe(shown))===JSON.stringify(describe(fresh));
  }
  const api={normalize,sameStores,resource,allowedDirection,quantity,storeFor,orderType,shipment,released,dockFor,arrivalLoads,resolveArrivalGoods,cancel,release,due,join,reassign,proposalPins,pin,unpin,controls,controlExempt,isControlPoint,priorityType,sourcePriorities,businessType,ruleValues,printing,validateSafety,reasonLabel,exclusionDetail,sameProposal};DG.PlanningRules=api;
  if(typeof module!=='undefined')module.exports=api;
})(globalThis);
