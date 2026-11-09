(function(root){
  'use strict';
  const DG=root.DG=root.DG||{};
  const key=id=>String(id??'').trim().toUpperCase();
  const validatedStatus=value=>['VALIDATED','MANUALLY_VALIDATED','USER_CONFIRMED','USER_CONFIRMED_MAPPING'].includes(value);
  function invalid(message){const error=new Error('INVALID_CONFIGURATION: '+message);error.code='INVALID_CONFIGURATION';throw error;}
  function activity(load){const value=load?.activity||'OUTBOUND';if(!['INBOUND','OUTBOUND'].includes(value))invalid('Unknown transport activity: '+value);return value;}
  function operationMode(resource,fallback='OUTBOUND'){const value=resource?.operationMode??fallback;if(!['INBOUND','OUTBOUND','DYNAMIC'].includes(value))invalid('Unknown operation mode: '+value);return value;}
  const allows=(resource,flow,fallback='OUTBOUND')=>{const mode=operationMode(resource,fallback);return mode==='DYNAMIC'||mode===flow;};
  const activityLabel=load=>activity(load)==='INBOUND'?'Inbound · rozładunek':'Outbound · załadunek';
  function prefix(id){const match=/^([0-9]+)([A-Z]*)$/.exec(key(id));return match?String(Number(match[1])):null;}
  function gateId(value){return value==null||value===''?null:String(value);}
  function physicalGate(id,aliases){
    const a=aliases?.[key(id)],assigned=gateId(a?.physicalGateId??a?.physical_gate_id),numeric=prefix(id);
    if(numeric&&assigned&&assigned!==numeric)invalid(key(id)+' belongs to Gate '+numeric+', requested '+assigned);
    const validated=a?.bindingStatus==='RESOLVED'||a?.bindingValidated===true||validatedStatus(a?.mapping_status);
    return numeric||(validated?assigned:null);
  }
  function normalize(input){
    const gates={},shipdocks={},families={},issues=[];
    for(const [id,value]of Object.entries(input.gates||{})){
      const g=key(id);if(gates[g])invalid('Duplicate Gate '+g);
      gates[g]=Object.freeze({...value,gateId:g,temporaryObjectId:'GATE:'+g,operationMode:operationMode(value,'DYNAMIC'),physicalChamber:String(value.physicalChamber??value.physical_chamber??'' )||null,active:value.active!==false});
      families[g]={physicalGateId:g,shipDockIds:[]};
    }
    const records=new Map();
    for(const [id,value]of Object.entries(input.aliases||{}))records.set(key(id),{...value,shipDockId:key(id)});
    const seen=new Set();
    for(const [id,value]of Object.entries(input.shipdocks||{})){
      const s=key(id);if(seen.has(s))invalid('Duplicate ShipDock '+s);seen.add(s);
      const old=records.get(s),a=old?.physicalGateId??old?.physical_gate_id,b=value.physicalGateId??value.physical_gate_id;
      if(a&&b&&String(a)!==String(b))invalid('Two Gates for ShipDock '+s);
      records.set(s,{...old,...value,shipDockId:s});
    }
    for(const [id,value]of records){
      if(Array.isArray(value.physicalGateId)||Array.isArray(value.physical_gate_id)||(value.physicalGateIds||value.physical_gate_ids||[]).length>1)invalid('Two Gates for ShipDock '+id);
      const numeric=prefix(id),explicit=gateId(value.physicalGateId??value.physical_gate_id);
      if(numeric&&explicit&&numeric!==explicit)invalid(id+' belongs to Gate '+numeric+', requested '+explicit);
      const validated=value.bindingValidated===true||value.mappingValidated===true||validatedStatus(value.mapping_status)||/^(MANUALLY_VALIDATED|USER_CONFIRMED)/.test(value.confidence||'');
      const assigned=numeric||(validated?explicit:null),gate=gates[assigned];
      const resolved=!!gate;
      const shipdock={...value,shipDockId:id,operationMode:operationMode(value),physicalGateId:resolved?assigned:null,physicalChamber:gate?.physicalChamber??null,
        cadX:value.cadX??null,cadY:value.cadY??null,roadNodeId:value.roadNodeId??null,active:value.active!==false,
        bindingStatus:resolved?'RESOLVED':'NEEDS_VALIDATION',bindingSource:numeric?'NUMERIC_PREFIX':validated?'VALIDATED_MAPPING':'UNRESOLVED',
        mappingSource:value.mappingSource||value.mapping_status||'MASTER_MAPPING',confidence:value.confidence||'NEEDS_VALIDATION'};
      if(!resolved){shipdock.mapped=false;shipdock.confidence='NEEDS_VALIDATION';issues.push(id+': NEEDS_VALIDATION — physical gate unresolved');}
      shipdocks[id]=Object.freeze(shipdock);
      if(gate)families[assigned].shipDockIds.push(id);
    }
    for(const f of Object.values(families)){f.shipDockIds.sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));Object.freeze(f.shipDockIds);Object.freeze(f);}
    return {...input,gates:Object.freeze(gates),shipdocks:Object.freeze(shipdocks),gateFamilies:Object.freeze(families),domainIssues:issues};
  }
  function validateAssignment(model,id,requestedGate){
    const dock=model.shipdocks[key(id)];if(!dock?.physicalGateId)invalid('ShipDock '+key(id)+' NEEDS_VALIDATION');
    const numeric=prefix(id);if(numeric&&numeric!==dock.physicalGateId)invalid(key(id)+' must belong to Gate '+numeric);
    const gate=model.gates[dock.physicalGateId];if(!gate)invalid('Unknown Gate for '+key(id));
    if(dock.physicalChamber!==gate.physicalChamber)invalid('Physical chamber differs from Gate for '+key(id));
    if(requestedGate!=null&&String(requestedGate)!==dock.physicalGateId)invalid(key(id)+' -> Gate '+dock.physicalGateId+', requested Gate '+requestedGate);
    return dock;
  }
  function assertPatch(id,original,patch){
    const proposed=patch.physicalGateId??patch.physical_gate_id,numeric=prefix(id),previous=original?.physicalGateId??original?.physical_gate_id;
    if(proposed!=null&&((numeric&&String(proposed)!==numeric)||(previous&&String(proposed)!==String(previous))))invalid('Cannot change Gate for '+key(id));
  }
  const api={key,prefix,physicalGate,normalize,validateAssignment,assertPatch,invalid,activity,operationMode,allows,activityLabel};DG.ShipDockDomain=api;
  if(typeof module==='object'&&module.exports)module.exports=api;
})(globalThis);
