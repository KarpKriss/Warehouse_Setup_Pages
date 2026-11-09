/* Address assignments are read-only rows until the operator explicitly edits one. */
DG.revealInspectorFeedback=function(node){
  // The inspector may reparent the same control into its tab after a save.
  queueMicrotask(()=>{if(node?.isConnected&&!node.hidden&&node.textContent)node.scrollIntoView({block:'nearest',inline:'nearest'});});
};
DG.mountAddressList=function(host,{values,onChange,notice='',heading='Adresy tego miejsca',help='Adresy z różnych wysokości wskazują to samo pole.',placeholder='Np. 02R1304B'}){
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let addresses=[...values],editing=null,disposed=false;
  const pending=apply=>DG.WarehouseSession?.pending('wms-address-form',apply);
  host.classList.add('object-address-list');
  function count(n){return n+' '+(n===1?'adres':n%10>=2&&n%10<=4&&(n%100<12||n%100>14)?'adresy':'adresów');}
  function message(text,error=false){const status=host.querySelector('[data-address-status]');if(!status)return;status.textContent=text;status.dataset.state=error?'error':'success';status.hidden=!text;if(text)DG.revealInspectorFeedback(status);}
  function updateSaveState(){
    const state=host.querySelector('[data-address-save-state]');if(!state)return;
    const draft=!!DG.WarehouseSession?.dirty;
    state.dataset.state=draft?'draft':'saved';
    state.textContent=draft?'Wersja robocza · kliknij Zapisz, aby zapisać układ na dysku.':'Zapisane w układzie';
  }
  function saved(){if(disposed||!host.isConnected)return;updateSaveState();message('Zapisano adresy na dysku.');}
  function close(){pending(null);editing=null;render();host.querySelector('[data-address-add]').focus();}
  function commit(next){try{onChange(next);addresses=[...next];editing=null;pending(null);if(host.isConnected){render();message(DG.WarehouseSession?'Zmieniono adresy w wersji roboczej.':'Zapisano adresy.');host.querySelector('[data-address-add]').focus();}return true;}catch(error){message(error.message,true);return false;}}
  function apply(){
    const input=host.querySelector('[data-address-input]');if(!input||editing===null)return true;
    if(editing===-2){
      const entries=input.value.toUpperCase().split(/[;,|\r\n\t]+/).map(s=>s.trim()).filter(s=>s&&!/^-+$/.test(s));
      if(!entries.length){message('Wklej przynajmniej jeden adres.',true);input.setAttribute('aria-invalid','true');input.focus();return false;}
      const invalid=entries.find(s=>s.length>80||!/^[A-Z0-9][A-Z0-9._/-]*$/.test(s));
      if(invalid){message('Nieprawidłowy adres: '+invalid+'. Oddziel adresy średnikiem lub nową linią.',true);input.setAttribute('aria-invalid','true');input.focus();return false;}
      const seen=new Set(addresses.map(s=>s.toUpperCase())),added=[];
      for(const s of entries)if(!seen.has(s)){seen.add(s);added.push(s);}
      if(!added.length){close();message('Wszystkie podane adresy są już na liście.');return true;}
      if(!commit([...addresses,...added])){input.setAttribute('aria-invalid','true');input.focus();return false;}
      if(host.isConnected)message('Dodano '+count(added.length)+'. Pominięto powtórzenia: '+(entries.length-added.length)+'.'+(DG.WarehouseSession?' Kliknij Zapisz, aby utrwalić układ.':''));
      return true;
    }
    const address=input.value.trim().toUpperCase();let error='';
    if(!address)error='Wpisz adres.';
    else if(/[|;\r\n\t]/.test(address))error='Dodaj jeden pełny adres naraz.';
    else if(addresses.some((a,i)=>i!==editing&&a.toUpperCase()===address))error='Ten adres jest już na liście.';
    if(error){input.setAttribute('aria-invalid','true');message(error,true);input.focus();return false;}
    const next=[...addresses];if(editing===-1)next.push(address);else next[editing]=address;
    if(next.length===addresses.length&&next.every((a,i)=>a===addresses[i])){close();return true;}
    if(!commit(next)){input.setAttribute('aria-invalid','true');input.focus();return false;}
    pending(null);return true;
  }
  function edit(index){editing=index;render();const input=host.querySelector('[data-address-input]');input.focus();input.select();}
  function render(){
    const status='<p id="object-address-status" data-address-status role="status" aria-live="polite" hidden></p>';
    const form=index=>editing===index?`<div class="address-entry-form"><label for="object-address-input">${index===-2?'Wklej listę adresów':index===-1?'Nowy adres':'Edytuj adres'}</label>${index===-2?'<textarea id="object-address-input" data-address-input rows="6" maxlength="100000" spellcheck="false" aria-describedby="object-address-status address-bulk-help" placeholder="01M101; 01M101-10; 01M101-20"></textarea><p id="address-bulk-help" class="object-help">Oddziel adresy średnikiem, nową linią, przecinkiem lub tabulatorem. Powtórzenia zostaną pominięte. Lista zostanie dodana w całości albo pozostanie bez zmian.</p>':`<input id="object-address-input" data-address-input autocomplete="off" spellcheck="false" maxlength="150" aria-describedby="object-address-status" placeholder="${esc(placeholder)}" value="${esc(index===-1?'':addresses[index])}">`}${status}<div class="address-entry-actions"><button type="button" class="button primary" data-address-apply>${index===-2?'Dodaj adresy':index===-1?'Dodaj':'Zastosuj'}</button><button type="button" class="button secondary" data-address-cancel>Anuluj</button></div></div>`:'';
    host.innerHTML=`<h3>${esc(heading)}</h3><p class="object-help">${esc(help)}</p><button type="button" class="button secondary address-add" data-address-add ${editing!==null?'disabled':''}>Dodaj adres</button>${editing===null?status:''}${form(-1)}<div class="address-list-heading"><h4>Przypisane adresy</h4><span class="object-address-count" id="object-address-count">${count(addresses.length)}</span></div><p class="address-save-state" data-address-save-state role="status"></p><ul class="address-entries" aria-label="Dodane adresy">${addresses.map((address,i)=>`<li class="address-entry" data-address-row>${editing===i?form(i):`<span class="address-value">${esc(address)}</span><div class="address-row-actions"><button type="button" class="button secondary" data-address-edit="${i}" aria-label="Edytuj adres ${esc(address)}" ${editing!==null?'disabled':''}>Edytuj</button><button type="button" class="button secondary address-remove" data-address-remove="${i}" aria-label="Usuń adres ${esc(address)}" ${editing!==null?'disabled':''}>Usuń</button></div>`}</li>`).join('')}</ul>${!addresses.length?'<p class="address-empty">Nie dodano jeszcze żadnego adresu.</p>':''}`;
    updateSaveState();
    const add=host.querySelector('[data-address-add]');add.insertAdjacentHTML('afterend',`<button type="button" class="button secondary" data-address-bulk ${editing!==null?'disabled':''}>Dodaj hurtowo</button>`);
    if(editing===-2)add.insertAdjacentHTML('afterend',form(-2));
    host.querySelector('[data-address-bulk]').onclick=()=>edit(-2);
    host.querySelector('[data-address-add]').onclick=()=>edit(-1);
    for(const button of host.querySelectorAll('[data-address-edit]'))button.onclick=()=>edit(Number(button.dataset.addressEdit));
    for(const button of host.querySelectorAll('[data-address-remove]'))button.onclick=()=>{const next=addresses.filter((_,i)=>i!==Number(button.dataset.addressRemove));commit(next);};
    const input=host.querySelector('[data-address-input]');
    if(input){input.oninput=()=>{input.removeAttribute('aria-invalid');message('');pending(apply);updateSaveState();};input.onkeydown=event=>{if(event.key==='Enter'&&(editing!==-2||event.ctrlKey||event.metaKey)){event.preventDefault();event.stopPropagation();apply();}if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();}};host.querySelector('[data-address-apply]').onclick=apply;host.querySelector('[data-address-cancel]').onclick=close;}
    if(notice&&editing===null)message(DG.WarehouseSession&&!DG.WarehouseSession.dirty?'Zapisano adresy na dysku.':notice);
  }
  render();
  window.addEventListener('dg:warehouse-saved',saved);
  return {dispose(){if(disposed)return;disposed=true;window.removeEventListener('dg:warehouse-saved',saved);pending(null);}};
};

/* Presentation for the selected tabbed inspector. Existing controls keep their handlers. */
DG.mountObjectInspector=function(root){
  let objectKey=null, active='addresses',addressEditor=null;
  const icon=name=>DG.RibbonIcons[name]||'', escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function select(id,focus=false){
    active=id;
    for(const tab of root.querySelectorAll('.object-tabs [role=tab]')){const selected=tab.dataset.objectTab===id;tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;if(selected&&focus)tab.focus();}
    for(const pane of root.querySelectorAll('.object-pane'))pane.hidden=pane.dataset.objectPane!==id;
    root.querySelector('.object-pane-scroll')?.scrollTo(0,0);
  }
  function updateAccess({text,state}){
    const status=root.querySelector('.object-access-status');if(!status)return;
    status.textContent=text;status.dataset.state=state;
    const dot=root.querySelector('.object-access-dot');dot.hidden=state==='ready';
  }
  function render(context){
    if(!context||root.querySelector('.object-inspector-header'))return;
    if(context.key!==objectKey){objectKey=context.key;active='addresses';}
    const old=[...root.children], first=root.querySelector(':scope > strong');first?.remove();
    addressEditor?.dispose();addressEditor=null;
    const addressList=root.querySelector('[data-wms-addresses]'), location=root.querySelector('.object-location-tools'), access=root.querySelector('.sketch-access-tools'),slotMode=root.querySelector('[data-slot-mode-tools]');
    root.innerHTML=`<header class="object-inspector-header"><h2>${escape(context.title)}</h2><p class="object-subtitle">${!context.gate&&context.title!==context.key?escape(context.key)+' · ':''}${escape(context.type)}${context.chamber?' · Komora K'+escape(context.chamber):''}</p>${context.dimensions?`<p class="object-dimensions">${icon('dimensions')}${escape(context.dimensions)}</p>`:''}<p class="object-access-status" role="status"></p></header><div class="object-tabs" role="tablist" aria-label="Właściwości wybranego obiektu">${[['addresses',context.gate?'Stages / WMS':'Adresy WMS','database'],['access','Dostęp','road'],['technical','Techniczne','gear']].map(([id,label,name])=>`<button type="button" role="tab" id="object-tab-${id}" data-object-tab="${id}" aria-controls="object-pane-${id}">${icon(name)}<span>${label}</span>${id==='access'?'<span class="object-access-dot" aria-hidden="true"></span>':''}</button>`).join('')}</div><div class="object-pane-scroll">${['addresses','access','technical'].map(id=>`<section class="object-pane" id="object-pane-${id}" data-object-pane="${id}" role="tabpanel" aria-labelledby="object-tab-${id}" tabindex="0"></section>`).join('')}</div>`;
    const pane=id=>root.querySelector('#object-pane-'+id), addresses=pane('addresses'), technical=pane('technical');
    if(slotMode)addresses.append(slotMode);
    if(addressList){
      addresses.append(addressList);addressEditor=DG.mountAddressList(addressList,addressList.addressOptions);
    }
    else if(context.gate){addresses.innerHTML='<h3>Stages i adresy WMS</h3><p class="object-help">Przypisz pole na planie do tej rampy.</p>';}
    else{addresses.innerHTML=`<h3>${context.floorPassage?'Przejazd pod regałem':'Adresy obiektu'}</h3><p class="object-help">${context.floorPassage?'Lokalizacja nad przejazdem może zachować własne adresy WMS.':'Powiązania i dane źródłowe znajdziesz w zakładce Techniczne.'}</p>`;}
    if(access){pane('access').append(access);access.querySelector('h4').textContent='Dostęp do linii';}
    else pane('access').innerHTML='<h3>Dostęp do trasy</h3><p class="object-help">'+escape(context.access.text)+'. '+(context.gate?'Dostęp przypisujesz osobno do pola stage.':'Szczegóły mapowania znajdują się w zakładce Techniczne.')+'</p>';
    const gateOperations=context.gate?document.createElement('details'):null;
    if(gateOperations){gateOperations.className='object-gate-operations';gateOperations.innerHTML='<summary>Stan rampy i przydziały</summary>';}
    for(const el of old){
      if(el===first||el===location||el===access||el===addressList||el===slotMode)continue;
      if(el.classList.contains('gate-stage-tools')){addresses.append(el);continue;}
      // Gate state and operational assignments remain in the main pane.
      if(context.gate&&!el.matches('.spatial-inspection,.documentary-evidence,.object-inspector-actions')){gateOperations.append(el);continue;}
      technical.append(el);
    }
    if(gateOperations)addresses.append(gateOperations);
    // Read-only ShipDock bindings are source details, not another address form.
    for(const p of technical.querySelectorAll('.spatial-inspection > p'))if(p.textContent.startsWith('WMS:')||p.textContent.startsWith('Prostokąt przedstawia'))p.remove();
    for(const row of technical.querySelectorAll('.stat-line'))if(['Numer roboczy','Wymiary'].includes(row.firstElementChild?.textContent))row.remove();
    for(const tab of root.querySelectorAll('.object-tabs [role=tab]')){
      tab.onclick=()=>select(tab.dataset.objectTab);
      tab.onkeydown=event=>{const ids=['addresses','access','technical'],index=ids.indexOf(tab.dataset.objectTab);let next;if(event.key==='ArrowRight')next=(index+1)%3;if(event.key==='ArrowLeft')next=(index+2)%3;if(event.key==='Home')next=0;if(event.key==='End')next=2;if(next!=null){event.preventDefault();select(ids[next],true);}};
    }
    updateAccess(context.access);select(active);
  }
  return {render,updateAccess,reset(){addressEditor?.dispose();addressEditor=null;objectKey=null;active='addresses';}};
};
