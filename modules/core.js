(function (root) {
  "use strict";
  const DG = root.DG = root.DG || {};

  const Domain = DG.ShipDockDomain || (typeof require === "function" ? require('./shipdock-domain.js') : null);
  const optimizer = () => DG.ShipDockOptimizer || (typeof require === "function" ? require('./shipdock-optimizer.js') : null);
  const physicalGate = (id, aliases) => Domain.physicalGate(id, aliases);
  const costFor = (...args) => optimizer().costFor(...args);

  // Rectangular Hungarian assignment. Every row must have at least one
  // feasible column. Kept as a generic utility; domain allocation also enforces
  // shared Gate calendars and Stage occupancy in shipdock-optimizer.js.
  function minCostAssignment(matrix) {
    const n = matrix.length, m = matrix[0]?.length || 0;
    if (!n) return [];
    if (m < n) return null;
    const u = Array(n + 1).fill(0), v = Array(m + 1).fill(0);
    const p = Array(m + 1).fill(0), way = Array(m + 1).fill(0);
    for (let i = 1; i <= n; i++) {
      p[0] = i;
      let j0 = 0;
      const minv = Array(m + 1).fill(Infinity), used = Array(m + 1).fill(false);
      do {
        used[j0] = true;
        const i0 = p[j0];
        let delta = Infinity, j1 = 0;
        for (let j = 1; j <= m; j++) {
          if (used[j]) continue;
          const cur = matrix[i0 - 1][j - 1] - u[i0] - v[j];
          if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
          if (minv[j] < delta) { delta = minv[j]; j1 = j; }
        }
        if (!Number.isFinite(delta)) return null;
        for (let j = 0; j <= m; j++) {
          if (used[j]) { u[p[j]] += delta; v[j] -= delta; }
          else minv[j] -= delta;
        }
        j0 = j1;
      } while (p[j0] !== 0);
      do {
        const j1 = way[j0]; p[j0] = p[j1]; j0 = j1;
      } while (j0 !== 0);
    }
    const result = Array(n).fill(-1);
    for (let j = 1; j <= m; j++) if (p[j]) result[p[j] - 1] = j - 1;
    return result;
  }

  const optimize = (...args) => optimizer().optimize(...args);
  const chooseShipDock = (...args) => optimizer().chooseShipDock(...args);
  const mergeWorkload = (...args) => optimizer().mergeWorkload(...args);
  const additionalCollisions = (...args) => optimizer().additionalCollisions(...args);
  const recordAssignments = (...args) => optimizer().recordAssignments(...args);

  function parseDelimited(raw,{strict=false}={}) {
    const first = raw.split(/\r?\n/, 1)[0] || "";
    const delimiter = first.includes("\t") ? "\t" : first.split(";").length > first.split(",").length ? ";" : ",";
    const rows = [], row = [];let cell = "", quoted = false, closed = false;
    const fail=()=>{throw Error('CSV: nieprawidłowy cudzysłów przy rekordzie '+(rows.length+1)+'. Popraw plik przed importem.');};
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (c === '"' && quoted && raw[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') {if(strict&&!quoted&&(cell.length||closed))fail();quoted=!quoted;if(!quoted)closed=true;}
      else if (c === delimiter && !quoted) { row.push(cell); cell = "";closed=false; }
      else if ((c === "\n" || c === "\r") && !quoted) {
        if (c === "\r" && raw[i + 1] === "\n") i++;
        row.push(cell); if (row.some(v => v.trim())) rows.push(row.splice(0)); else row.length = 0;
        cell = "";closed=false;
      } else {if(strict&&closed){if(c===' '||c==='\t')continue;fail();}cell += c;}
    }
    if(strict&&quoted)fail();row.push(cell); if (row.some(v => v.trim())) rows.push(row);
    return rows;
  }

  function importMoveTasks(raw, schedule = [], options = {}) {
    const flow=options.activity||'OUTBOUND';Domain.activity({activity:flow});const inbound=flow==='INBOUND';
    if(typeof raw!=='string'||raw.length>15*1024*1024||new TextEncoder().encode(raw).length>15*1024*1024)throw Error('CSV: plik przekracza limit 15 MB.');
    if(/\ufffd|\x00/.test(raw))throw Error('CSV: uszkodzone kodowanie tekstu. Zapisz poprawny plik UTF-8; nie zaimportowano danych.');
    const table = parseDelimited(raw.replace(/^\uFEFF/, ""),{strict:true});
    if(table.length>30001)throw Error('CSV: przekroczono limit 30 000 picków.');
    if (table.length < 2) throw new Error("The file has no Move Task rows.");
    const norm = v => String(v || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
    const headers = table[0].map(norm);
    if(headers.some((h,i)=>!h||headers.indexOf(h)!==i))throw Error("CSV: puste lub powtórzone nagłówki kolumn.");
    const keys = {
      load_id: ["load_id", "consignment", "consignment_id", "load"],
      source_location: ["source_location", "from_loc_id", "from_location", "location_id"],
      quantity: ["quantity", "qty", "units"],
      destination_location: ["destination_location","to_loc_id","to_location","target_location","docelowa_lokalizacja"],
      sku: ["sku","sku_id","item_id","article"],
      move_task_id: ["move_task_id", "task_id"],
      store: ["store", "destination", "kierunek", "sklep", "client", "klient", "customer", "customer_id"],
      loading_time: ["loading_time", "godzina", "window"],
      loading_end: ["loading_end", "loading_end_time"],
      loading_date: ["loading_date", "appointment_date", "date"],
      loading_duration_minutes: ["loading_duration_minutes","service_duration_minutes","unloading_duration_minutes"],
      estimated_arrival_at: ["estimated_arrival_at", "eta", "arrival_at"],
      truck_label: ["truck_label", "truck_registration", "registration"],
      staging_start: ["staging_start"],
      staging_end: ["staging_end"],
      current_shipdock: ["current_shipdock", ...(inbound?[]:["final_loc_id"]), "shipdock", "dock"],
      requested_gate: ['requested_gate','requested_gate_id','physical_gate','physical_gate_id','gate','gate_id'],
      order_type: ["order_type"],
      carrier_type: ["carrier_type"],
      process: ["process", "flow"],
      priority: ["priority"],
      status: ["status", "load_status"],
      data_completeness: ["data_completeness", "allocation_completeness"]
    };
    for(const [key,names]of Object.entries(keys))if(names.filter(name=>headers.includes(name)).length>1)throw Error('CSV: niejednoznaczne kolumny dla '+key+'. Pozostaw jedno źródło wartości.');
    const column = Object.fromEntries(Object.entries(keys).map(([key, names]) => [key, names.map(n => headers.indexOf(n)).find(i => i >= 0) ?? -1]));
    if (column.load_id < 0 || column[inbound?"destination_location":"source_location"] < 0 || column.quantity < 0 || inbound&&column.sku<0) throw new Error(inbound?"Wymagane kolumny przyjęć: consignment, sku, destination_location, quantity. ETA: estimated_arrival_at lub loading_date + loading_time.":"Required columns: load_id/consignment, source_location/FROM_LOC_ID, quantity.");

    const loads = new Map(), errors = [];
    table.slice(1).forEach((cells, i) => {
      if(cells.length!==headers.length){errors.push(`Row ${i+2}: niezgodna liczba kolumn`);return;}
      const get = k => column[k] < 0 ? "" : String(cells[column[k]] || "").trim();
      const rawId=get("load_id"),id=inbound?"INBOUND:"+rawId:rawId,source=get(inbound?"destination_location":"source_location").toUpperCase();
      if(/^[+-]?\d+(?:[.,]\d+)?e[+-]?\d+$/i.test(rawId)||/^\d+[.,]\d+$/.test(rawId)||/[\ufffd\x00-\x1f]/.test(rawId)||rawId.length>200){errors.push(`Row ${i+2}: niepewne ID consignmentu — popraw tekst w źródle, bez odtwarzania cyfr`);return;}
      const quantityText=get("quantity"),quantity=/^(?:\d+(?:[.,]\d+)?|[.,]\d+)$/.test(quantityText)?Number(quantityText.replace(",", ".")):NaN;
      if (!rawId || !source || inbound&&!get("sku") || !Number.isFinite(quantity) || quantity <= 0) { errors.push(`Row ${i + 2}: invalid ID, source or quantity`); return; }
      if (!loads.has(id)) {
        const store = get("store"); const scheduled = null;
        const completeness = Number(get("data_completeness").replace("%", "").replace(",", "."));
        loads.set(id, { load_id: id, activity:flow, source_load_id:rawId, store, loading_time: get("loading_time") || scheduled?.loading_time || "",
          current_shipdock: get("current_shipdock").toUpperCase() || scheduled?.current_shipdock || "",
          shipdockSource: get("current_shipdock") ? 'IMPORT' : scheduled?.current_shipdock ? 'SCHEDULE' : 'UNASSIGNED',
          ...(get('requested_gate')?{requestedGateId:get('requested_gate')} : {}),
          loading_end: get("loading_end"), loading_date: get("loading_date"),
          estimated_arrival_at: get('estimated_arrival_at'), truck_label: get('truck_label'),
          loading_duration_minutes: get("loading_duration_minutes") ? Number(get("loading_duration_minutes").replace(",",".")) : undefined,
          staging_start: get("staging_start"), staging_end: get("staging_end"),
          process: get("process").toUpperCase(), priority: get("priority"), status: get("status").toUpperCase(),
          data_completeness: get("data_completeness") && Number.isFinite(completeness) ? (completeness > 1 ? completeness / 100 : completeness) : null,
          tasks: [] });
      }
      const load = loads.get(id);
      if(get('current_shipdock')&&!load.current_shipdock){load.current_shipdock=get('current_shipdock').toUpperCase();load.shipdockSource='IMPORT';}
      for(const key of ['store','estimated_arrival_at','loading_date','loading_time','loading_end','staging_start','staging_end','truck_label']){const incoming=get(key);if(!incoming)continue;if(load[key]&&String(load[key]).toUpperCase()!==incoming.toUpperCase())Domain.invalid(`Row ${i+2}: conflicting ${key} for consignment ${id}`);if(!load[key])load[key]=incoming;}
      if(get('loading_duration_minutes')){const duration=Number(get('loading_duration_minutes').replace(',','.'));if(!Number.isInteger(duration)||duration<1||duration>10080)Domain.invalid(`Row ${i+2}: invalid service duration`);if(load.loading_duration_minutes!=null&&load.loading_duration_minutes!==duration)Domain.invalid(`Row ${i+2}: conflicting service duration for ${id}`);load.loading_duration_minutes=duration;}

      if(get('requested_gate')){if(load.requestedGateId&&load.requestedGateId!==get('requested_gate'))Domain.invalid(`Row ${i+2}: conflicting Gate for load ${id}`);load.requestedGateId=get('requested_gate');}
      if(load.current_shipdock&&load.requestedGateId){const gate=Domain.prefix(load.current_shipdock);if(gate&&gate!==load.requestedGateId)Domain.invalid(`Row ${i+2}: ${load.current_shipdock} cannot use Gate ${load.requestedGateId}`);}
      if (get("current_shipdock") && load.current_shipdock && get("current_shipdock").toUpperCase() !== load.current_shipdock) Domain.invalid(`Row ${i + 2}: conflicting ShipDock for load ${id}`);
      if(inbound&&get("loading_duration_minutes")&&(!Number.isFinite(load.loading_duration_minutes)||load.loading_duration_minutes<1||load.loading_duration_minutes>10080))Domain.invalid(`Row ${i+2}: invalid service duration`);
      if(inbound&&["estimated_arrival_at","loading_date","loading_time","loading_duration_minutes","current_shipdock"].some(k=>get(k)&&(k==="loading_duration_minutes"?load[k]!==Number(get(k).replace(",",".")):String(load[k]??"").toUpperCase()!==get(k).toUpperCase())))Domain.invalid(`Row ${i+2}: conflicting ${id} transport details`);
      load.tasks.push({ ...(inbound?{destination_location:source,sku:get("sku")}:{source_location:source,...(get("sku")?{sku:get("sku")}: {})}), quantity, attributes:Object.fromEntries(headers.map((h,j)=>[h,String(cells[j]||'').trim()])), order_type: get("order_type"), carrier_type: get("carrier_type"), ...(get('move_task_id')?{move_task_id:get('move_task_id')}:{}) });
    });
    if(errors.length)throw Error('CSV: Nie zaimportowano żadnych danych. '+errors.slice(0,20).join(' · ')+(errors.length>20?' · Pozostałe błędy: '+(errors.length-20):''));
    const rules=DG.PlanningRules||(typeof require==='function'?require('./planning-rules.js'):null);
    for(const load of loads.values())load.order_type=rules.orderType(load);
    return { loads: [...loads.values()], errors, activity:flow };
  }

  DG.physicalGate = physicalGate;
  DG.chooseShipDock = chooseShipDock;
  DG.mergeWorkload = mergeWorkload;
  DG.additionalCollisions = additionalCollisions;
  DG.recordAssignments = recordAssignments;
  DG.costFor = costFor;
  DG.minCostAssignment = minCostAssignment;
  DG.optimize = optimize;
  DG.importMoveTasks = importMoveTasks;
  DG.parseDelimited = parseDelimited;
})(globalThis);
