(function(root){
  'use strict';
  const DG=root.DG;
  DG.mountSpatialView=function(base,callbacks){
    const session=DG.WarehouseSession;session?.initialize();
    const sketchProtection=DG.WarehouseBackup.protectSketchStorage(session?.storage||DG.Storage||root.localStorage),localStorage=sketchProtection.storage;
    const host=document.getElementById('warehouse-map'),esc=DG.escapeHtml;
    let config=JSON.parse(JSON.stringify(base.calibration)),model,engine,selected=null,interactionMode='pan',routeRequest=null,testPicking=null,fitPoints=[],fitAnalysis=null,fitLines=[],fitSequence=0;
    let loadedCalibration=false;
    try{const saved=localStorage.getItem('dynamic-gates-spatial-calibration-v1');if(saved){config=JSON.parse(saved);if(!config.anchors?.length&&base.calibration.anchors?.length){config.anchors=base.calibration.anchors;config.projectionChambers=base.calibration.projectionChambers;config.alignmentValidated=false;config.alignmentValidatedChambers=[];}loadedCalibration=true;}}catch(_){}
    const calibrationBeforeMigration=JSON.stringify(config);
    config=DG.mergeSourceSlotMappings(config,base.calibration,base.geometry);
    config=DG.LayoutObjects.pruneRemoved(base.geometry,config);
    if(loadedCalibration&&JSON.stringify(config)!==calibrationBeforeMigration)try{localStorage.setItem('dynamic-gates-spatial-calibration-v1',DG.serializeCalibration(config,base.calibration));}catch(_){}
    const origin=[base.geometry.bounds[0],base.geometry.bounds[1]],width=(base.geometry.bounds[2]-origin[0])/1000,height=(base.geometry.bounds[3]-origin[1])/1000;
    const point=(x,y)=>[(x-origin[0])/1000,(base.geometry.bounds[3]-y)/1000];
    const coords=p=>p.map(([x,y])=>point(x,y).join(',')).join(' ');
    let box=[-5,-5,width+10,height+10],drag=null;
    const Sketch=DG.LineSketch,sketchStorageKey='dynamic-gates-line-sketch-v1';
    
    let sketch={version:1,source:base.geometry.source,cadToMeters:base.geometry.unit.cadToMeters,segments:[],accessPoints:[],nextSegmentNumber:1},sketchGraph=Sketch.build([]),sketchAnchor=null,sketchHover=null,sketchRoute=null,sketchSelected=null,sketchHistory=[],sketchMessage='',sketchStorageError='',accessIndex,accessTarget=null,accessPreview=null,accessValidationError='';
    sketch=Sketch.pruneTargets(sketch,base.geometry.removedObjectIds,base.geometry.rackLayoutReplacements);
    try{const saved=localStorage.getItem(sketchStorageKey);if(saved){const original=JSON.parse(saved),cleaned=Sketch.pruneTargets(original,base.geometry.removedObjectIds,base.geometry.rackLayoutReplacements);sketch=Sketch.validate(cleaned);sketchGraph=Sketch.build(sketch.segments);if(cleaned!==original)localStorage.setItem(sketchStorageKey,JSON.stringify(sketch));}}catch(_){sketchStorageError=sketchProtection.block();}
    // Static CAD geometry is converted once; detailed cells are mounted only
    // around the viewport. The model and its stable mapping IDs stay complete.
    const geometryCache=new WeakMap();
    const scopeCache=new WeakMap(),viewBoxes=new Map(),viewStorageKey='dynamic-gates-warehouse-view-v1',layerStorageKey='dynamic-gates-warehouse-layers-v1';
    let activeView='';
    let objectAnchor=null,objectDraft=null,objectHover=null,layoutHistory=[],palletRotated=false,layoutEditor=null,editHistory=[];
    function shape(points){let cached=geometryCache.get(points);if(!cached){const p=points.map(x=>point(...x)),xs=p.map(v=>v[0]),ys=p.map(v=>v[1]);cached={bounds:[Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)],coords:p.map(v=>v.join(',')).join(' '),path:'M'+p.map(v=>v.join(',')).join('L')};geometryCache.set(points,cached);}return cached;}
    let viewport,pxPerMeter=1,viewFrame=null,detailTimer=null;
    function updateViewport(){const rect=svg.getBoundingClientRect();pxPerMeter=Math.min((rect.width||width)/box[2],(rect.height||height)/box[3]);const w=(rect.width||width)/pxPerMeter,h=(rect.height||height)/pxPerMeter;viewport=[box[0]-(w-box[2])/2-3,box[1]-(h-box[3])/2-3,box[0]+box[2]+(w-box[2])/2+3,box[1]+box[3]+(h-box[3])/2+3];}
    const visible=points=>{const b=shape(points).bounds;return b[0]<=viewport[2]&&b[2]>=viewport[0]&&b[1]<=viewport[3]&&b[3]>=viewport[1];};
    const viewChamber=()=>model.geometry.chambers.find(c=>c.id===$('spatial-chamber-focus').value);
    function scoped(rows,kind='shape'){
      const ch=viewChamber();if(!ch)return rows;
      let cached=scopeCache.get(rows);if(!cached){cached=new Map();scopeCache.set(rows,cached);}
      const key=ch.id+':'+kind;if(kind!=='dynamic'&&cached.has(key))return cached.get(key);
      const a=point(ch.bounds[0],ch.bounds[3]),z=point(ch.bounds[2],ch.bounds[1]);
      const selected=rows.filter(o=>{
        if(o.physicalChamber!=null)return String(o.physicalChamber)===ch.id;
        const b=shape(o.points).bounds;
        if(kind==='footprint')return (b[0]+b[2])/2>=a[0]&&(b[0]+b[2])/2<=z[0]&&(b[1]+b[3])/2>=a[1]&&(b[1]+b[3])/2<=z[1];
        return b[0]<=z[0]&&b[2]>=a[0]&&b[1]<=z[1]&&b[3]>=a[1];
      });if(kind!=='dynamic')cached.set(key,selected);return selected;
    }
    function scopedPoint(o){
      const ch=viewChamber();if(!ch)return true;
      if(o.physicalChamber!=null)return String(o.physicalChamber)===ch.id;
      const x=o.cadX??o.x,y=o.cadY??o.y,b=ch.bounds;
      return Number.isFinite(x)&&Number.isFinite(y)&&x>=b[0]&&x<=b[2]&&y>=b[1]&&y<=b[3];
    }
    function moveView(){if(!svg.clientWidth||!svg.clientHeight)return;if(viewFrame===null)viewFrame=requestAnimationFrame(()=>{viewFrame=null;svg.setAttribute('viewBox',box.join(' '));});clearTimeout(detailTimer);detailTimer=setTimeout(render,120);}
    const objectName=o=>o.displayName||config.objectMappings?.[o.temporaryId]?.[0]||config.slotMappings?.[o.temporaryId]?.[0]||o.documentaryLabel||o.temporaryId||o.label||'CONTROL';
    function documentaryLabel(o,p){
      const text=o.displayName||(o.documentaryOnly?o.label||objectName(o):config.objectMappings?.[o.temporaryId]?.join(', ')||o.label||objectName(o)),parts=text.split(' '),first=parts.shift(),second=parts.join(' '),b=DG.LayoutObjects.bounds(o.points);
      const font=Math.min(11/pxPerMeter,(b[2]-b[0])/1000/(Math.max(first.length,second.length)*.65+1),(b[3]-b[1])/1000/3);
      return `<text class="layout-area-label documentary-area-label" font-size="${font}" x="${p[0]}" y="${p[1]}"><tspan x="${p[0]}" dy="${second?-font*.55:0}">${esc(first)}</tspan>${second?`<tspan x="${p[0]}" dy="${font*1.2}">${esc(second)}</tspan>`:''}</text>`;
    }
    host.className='spatial-workspace';
    host.innerHTML=`<div class="spatial-banner"><strong>CAD · warehouse spatial validation</strong><span>Provisional gate numbering · WMS alignment pending</span></div>
      <div class="spatial-toggles"><label>Focus <select id="spatial-chamber-focus" aria-label="Focus chamber"><option value="">All</option>${base.geometry.chambers.map(c=>`<option value="${esc(c.id)}">K${esc(c.id)}${String(c.id)==='7'?' · pilot':String(c.id)==='8'?' · next':''}</option>`).join('')}</select></label>${[['cad','CAD geometry',true],['chambers','Chambers',true],['stages','Stages',true],['roads','Roads',false],['nodes','Nodes',false],['locations','WMS Locations',true],['gates','Numery ramp',false],['shipdocks','ShipDocks',false],['control','Control area',true]].map(([id,label,on])=>`<label><input data-layer="${id}" type="checkbox" ${on?'checked':''}> ${label}</label>`).join('')}<button id="spatial-fit" class="button secondary">Fit</button></div>
      <div class="spatial-slot-tools spatial-inputs"><strong>Mapowanie <select id="mapping-chamber" aria-label="Komora mapowania">${base.geometry.chambers.map(c=>`<option value="${esc(c.id)}" ${String(c.id)==='2'?'selected':''}>K${esc(c.id)}</option>`).join('')}</select> · Miejsca paletowe</strong><input id="spatial-slot-find" aria-label="Numer miejsca paletowego" placeholder="K2-0001 lub 1"><button id="spatial-slot-show" class="button secondary">Pokaż miejsce</button><button id="spatial-slot-export" class="button secondary">Eksport mapowania CSV</button><label for="spatial-slot-import" class="button secondary">Import mapowania CSV</label><input id="spatial-slot-import" type="file" accept=".csv"><span id="spatial-slot-status">Numery robocze · WMS do przypisania</span></div>
      <div class="spatial-slot-tools spatial-inputs"><strong>Stages</strong><input id="spatial-stage-find" aria-label="Numer stage" placeholder="A01 / B01"><button id="spatial-stage-show" class="button secondary">Pokaż stage</button><button id="spatial-stage-fit" class="button secondary">Pokaż stages komory</button><button id="spatial-stage-export" class="button secondary">Eksport stages CSV</button><span id="spatial-stage-status">A · przy rampach, B · po drugiej stronie drogi</span></div>
      <svg id="spatial-svg" role="img" aria-label="Warehouse CAD layout; mouse wheel zoom and drag pan" tabindex="0"></svg>
      <details open class="spatial-validation"><summary>Spatial validation report · global backbone → K7 → K8</summary><div id="spatial-validation"></div><div id="spatial-chamber-validation" class="table-wrap"></div></details>`;
    const $=id=>document.getElementById(id),svg=$('spatial-svg');
    const tools=document.createElement('details');tools.id='spatial-tools';tools.className='spatial-tools';
    tools.innerHTML='<summary>Warehouse Setup · Narzędzia</summary><div class="spatial-tools-content"></div>';
    const toolContent=tools.querySelector('.spatial-tools-content');
    const documentaryPanel=document.createElement('section');documentaryPanel.id='documentary-areas-panel';documentaryPanel.className='documentary-areas-panel';toolContent.append(documentaryPanel);
    const viewBar=document.createElement('div');viewBar.className='spatial-viewbar';
    viewBar.innerHTML='<label for="spatial-chamber-focus">Podgląd</label><span id="spatial-view-status" aria-live="polite"></span>';
    host.append(viewBar);
    viewBar.querySelector('label').after($('spatial-chamber-focus'));
    viewBar.append($('spatial-fit'));
    $('spatial-chamber-focus').setAttribute('aria-label','Podgląd magazynu lub komory');
    $('spatial-chamber-focus').options[0].text='Cały magazyn';
    for(const option of [...$('spatial-chamber-focus').options].slice(1))option.text='Komora K'+option.value;
    $('spatial-fit').textContent='Dopasuj widok';
    host.querySelector('.spatial-toggles label').remove();
    for(const el of [...host.children])if(el!==svg&&el!==viewBar)toolContent.append(el);
    host.append(tools);
    host.append(viewBar);
    const sketchToggle=document.createElement('button');sketchToggle.id='sketch-toggle';sketchToggle.className='button secondary';sketchToggle.textContent='Rysuj linie';sketchToggle.setAttribute('aria-pressed','false');
    $('spatial-fit').before(sketchToggle);
    const sketchEdit=document.createElement('button');sketchEdit.id='sketch-edit';sketchEdit.className='button secondary';sketchEdit.textContent='Edytuj linie';sketchToggle.after(sketchEdit);
    const sketchPanel=document.createElement('div');sketchPanel.id='sketch-panel';sketchPanel.className='sketch-panel';sketchPanel.hidden=true;
    sketchPanel.innerHTML=`<div class="sketch-actions"><strong>Szkic linii</strong><button id="sketch-end" class="button secondary">Nowa linia</button><button id="sketch-undo" class="button secondary">Cofnij</button><button id="sketch-delete" class="button secondary">Usuń wybraną</button><button id="sketch-test" class="button secondary">Sprawdź połączenie</button><label><input id="sketch-ortho" type="checkbox" checked> Poziom / pion</label><button id="sketch-export" class="button secondary">Eksport szkicu</button><label for="sketch-import" class="button secondary">Import szkicu</label><input id="sketch-import" type="file" accept=".json" hidden><button id="sketch-close" class="button secondary">Zakończ rysowanie</button></div><div id="sketch-status" role="status"></div>`;
    sketchPanel.querySelector('#sketch-status').insertAdjacentHTML('beforebegin',`<div id="sketch-line-controls" class="sketch-actions"><label>Wybrana linia <select id="sketch-line-select" aria-label="Wybrany odcinek"></select></label><label>Kierunek ruchu <select id="sketch-direction" aria-label="Kierunek ruchu"><option value="BOTH">Dwukierunkowy</option><option value="FORWARD">Jednokierunkowy A → B</option><option value="REVERSE">Jednokierunkowy B → A</option></select></label><label><input id="sketch-enabled" type="checkbox"> Włączona do ruchu</label><span id="sketch-line-length"></span></div>`);
    sketchPanel.querySelector('#sketch-delete').insertAdjacentHTML('afterend','<button id="sketch-join" class="button secondary">Połącz bliskie końce</button><label>Zasięg <input id="sketch-join-distance" aria-label="Zasięg łączenia w centymetrach" type="number" min="1" max="100" step="1" value="20"> cm</label>');
    sketchPanel.querySelector('#sketch-line-controls').insertAdjacentHTML('afterend','<button id="sketch-merge-selected" class="button secondary">Połącz linie</button>');
    host.append(sketchPanel);
    const routePanel=document.createElement('section');routePanel.id='sketch-endpoint-test';routePanel.className='route-tester';routePanel.setAttribute('aria-label','Test trasy między lokalizacjami');
    routePanel.innerHTML=`<div class="route-tester-heading"><strong>Test trasy</strong><button id="route-clear" class="button secondary" type="button">Wyczyść</button><button id="route-close" class="button secondary" type="button" aria-label="Zamknij test trasy">Zamknij</button></div><form id="route-test-form"><label for="sketch-from">Od<input id="sketch-from" placeholder="Lokalizacja WMS lub K2-0001" autocomplete="off"></label><button id="route-swap" class="button secondary" type="button" aria-label="Zamień początek i koniec trasy">Zamień</button><label for="sketch-to">Do<input id="sketch-to" placeholder="Lokalizacja WMS lub K2-ST-A01" autocomplete="off"></label><button id="sketch-endpoint-route" class="button primary" type="submit">Pokaż trasę</button></form><div id="route-test-result" role="status" aria-live="polite">Wpisz dwie lokalizacje. Możesz użyć też numerów miejsc i stages.</div>`;
    routePanel.querySelector('#route-test-form').insertAdjacentHTML('beforebegin','<div class="map-test-actions"><button id="route-map-pick" type="button" class="button secondary">Wskaż Od → Do na mapie</button><button id="route-map-to" type="button" class="button secondary">Wskaż Do</button><button id="route-pick-stop" type="button" class="button secondary" hidden>Zakończ wybieranie</button></div><p id="route-pick-status" class="map-test-help" role="status"></p>');
    host.append(routePanel);
    const fitPanel=document.createElement('section');fitPanel.id='fit-panel';fitPanel.className='map-fit-panel';fitPanel.hidden=true;fitPanel.setAttribute('aria-label','Test dopasowania Stage’a');
    fitPanel.innerHTML=`<h3>Test dopasowania</h3><p class="map-test-help">Jedna grupa na wspólny Stage. Każdy wskazany punkt to jedna paleta. Porównujemy trasy źródło → wymagane punkty → Stage. Rampa wynika z przypisania Stage’a; jej odległość nie jest liczona. Test nie zapisuje przydziałów.</p><div class="map-test-actions"><button id="fit-map-pick" type="button" class="button secondary">Wybieraj punkty na mapie</button><button id="fit-pick-stop" type="button" class="button secondary" hidden>Zakończ wybieranie</button><button id="fit-clear" type="button" class="button secondary">Wyczyść</button></div><p id="fit-pick-status" role="status" class="map-test-help"></p><form id="fit-source-form"><label for="fit-source">Dodaj lokalizację<input id="fit-source" autocomplete="off" placeholder="WMS lub numer miejsca"></label><button type="submit" class="button secondary">Dodaj punkt</button></form><p id="fit-point-count">0 punktów · 0 palet</p><ol id="fit-points" class="map-fit-points"></ol><form id="fit-form"><label for="fit-store">Sklep (opcjonalnie)<input id="fit-store" placeholder="Puste: kierunki dynamiczne" maxlength="200"></label><label for="fit-type">Typ palet<select id="fit-type"><option value="LS">LS</option><option value="CC">CC — przez kontrolę</option></select></label><label for="fit-priority">Priority WMS (opcjonalnie)<input id="fit-priority" inputmode="decimal" placeholder="np. 150"></label><p class="map-test-help">Priority 0/150 oznacza LS, inne wartości CC. Sklep pozwala sprawdzić fix i aktywny przydział. Bez awizacji test nie rezerwuje czasu rampy.</p><button id="fit-run" type="submit" class="button primary">Znajdź najlepszy Stage</button></form><div id="fit-result" role="status" aria-live="polite"></div>`;
    host.append(fitPanel);
    const routeToggle=document.createElement('button');routeToggle.id='route-toggle';routeToggle.className='button secondary';routeToggle.textContent='Test trasy';routeToggle.setAttribute('aria-expanded','true');routeToggle.setAttribute('aria-controls',routePanel.id);sketchEdit.after(routeToggle);const fitToggle=document.createElement('button');fitToggle.id='fit-toggle';fitToggle.className='button secondary';fitToggle.textContent='Test dopasowania';fitToggle.setAttribute('aria-expanded','false');fitToggle.setAttribute('aria-controls','fit-panel');routeToggle.after(fitToggle);
    new ResizeObserver(()=>host.style.setProperty('--route-panel-height',routePanel.hidden?'0px':routePanel.offsetHeight+'px')).observe(routePanel);
    host.querySelector('.spatial-toggles').insertAdjacentHTML('beforeend','<label><input data-layer="sketch" type="checkbox" checked> Ścieżki komunikacyjne</label><label><input data-layer="sketch-access" type="checkbox" checked> Linie dostępowe</label><label><input data-layer="mass" type="checkbox" checked> Pola masy</label>');
    const viewFilters=document.createElement('details');viewFilters.id='spatial-view-filters';viewFilters.className='spatial-view-filters';
    viewFilters.innerHTML='<summary aria-label="Filtry widoku">Filtry</summary><div class="spatial-view-filter-menu"><strong>Widoczność warstw</strong></div>';
    viewFilters.querySelector('.spatial-view-filter-menu').append(host.querySelector('.spatial-toggles'));sketchToggle.before(viewFilters);
    host.querySelector('.spatial-validation').open=false;
    const inspectorPanel=$('inspector').closest('details');
    const workspacePanel=document.createElement('aside');workspacePanel.id='workspace-panel';workspacePanel.className='workspace-panel';workspacePanel.setAttribute('aria-label','Panel magazynu');
    workspacePanel.innerHTML='<div class="workspace-panel-heading"><strong id="workspace-panel-title">Narzędzia</strong><button id="workspace-panel-close" class="button secondary" aria-label="Zwiń panel magazynu">Zwiń</button></div>'+['tools','filters','edit','inspector'].map(id=>`<section id="workspace-${id}" role="tabpanel" aria-labelledby="workspace-tab-${id}" ${id==='tools'?'':'hidden'}></section>`).join('');
    host.append(workspacePanel);
    const tabs=document.createElement('div');tabs.className='workspace-tabs';tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','Narzędzia magazynu');tabs.setAttribute('aria-orientation','vertical');
    const tabNames={tools:'Narzędzia',filters:'Filtry',edit:'Edycja',inspector:'Inspektor'};
    const tabIcons={tools:'<path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"/>',filters:'<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="8" cy="18" r="2"/>',edit:'<path d="m14 5 5 5M4 20l4-1 12-12a2 2 0 0 0-5-5L3 14l1 6ZM4 20h16"/>',inspector:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5M10.5 7v.1M10.5 10v4"/>'};
    tabs.innerHTML='<span class="workspace-menu-caption" aria-hidden="true">MAGAZYN</span>'+Object.entries(tabNames).map(([id,name])=>`<button id="workspace-tab-${id}" class="workspace-tab" role="tab" aria-controls="workspace-${id}" aria-selected="${id==='tools'}" tabindex="${id==='tools'?'0':'-1'}" data-workspace-tab="${id}" title="${name}"><svg viewBox="0 0 24 24" aria-hidden="true">${tabIcons[id]}</svg><span>${name}</span></button>`).join('');host.append(tabs);viewBar.append($('spatial-fit'));
    $('workspace-tools').append(routeToggle,fitToggle,routePanel,fitPanel,tools);tools.open=true;
    $('workspace-filters').append(viewFilters);viewFilters.open=true;
    $('workspace-edit').innerHTML=`<h3>Linie komunikacyjne</h3><div class="line-editor-actions"></div><h3>Dodaj obiekt</h3><div class="object-editor"><label>Komora<select id="object-chamber">${base.geometry.chambers.map(c=>`<option value="${c.id}" ${c.id==='2'?'selected':''}>K${c.id}</option>`).join('')}</select></label><label>Typ<select id="object-kind">${Object.entries(DG.LayoutObjects.kinds).map(([id,name])=>`<option value="${id}">${name}</option>`).join('')}</select></label><button id="object-draw" class="button secondary">Narysuj prostokąt</button><p>Kliknij dwa przeciwległe narożniki na mapie. Zatwierdź gotowy obrys.</p><div id="object-dimensions" hidden><label>Szerokość (m)<input id="object-width" type="number" min="0.05" step="0.01"></label><label>Wysokość (m)<input id="object-height" type="number" min="0.05" step="0.01"></label></div><div id="object-status" role="status">Nowe obiekty otrzymają stałe numery robocze.</div><div class="object-actions"><button id="object-confirm" class="button primary" disabled>Zatwierdź obiekt</button><button id="object-cancel" class="button secondary">Anuluj</button><button id="object-undo" class="button secondary" disabled>Cofnij zmianę układu</button></div></div>`;
    $('workspace-edit').querySelector('.line-editor-actions').append(sketchToggle,sketchEdit);$('workspace-edit').querySelector('h3:nth-of-type(2)').before(sketchPanel);
    $('object-draw').insertAdjacentHTML('afterend','<button id="object-rotate" class="button secondary">Obróć paletę o 90°</button>');$('workspace-edit').querySelector('.object-editor>p').id='object-draw-help';
    // Give each operation one home; the primary merge action starts map picking.
    const editPane=$('workspace-edit'),objectEditor=editPane.querySelector('.object-editor'),lineControls=$('sketch-line-controls');
    const editorElements=Object.fromEntries(['sketch-end','sketch-undo','sketch-delete','sketch-test','sketch-ortho','sketch-export','sketch-import','sketch-close','sketch-join','sketch-join-distance','sketch-merge-selected','sketch-status'].map(id=>[id,$(id)]));
    const importLabel=sketchPanel.querySelector('label[for="sketch-import"]');
    editPane.replaceChildren();
    editPane.innerHTML='<section class="editor-card"><div class="editor-card-heading"><h3>Linie komunikacyjne</h3><div id="editor-line-undo"></div></div><p class="editor-card-help">Wybierz czynność, a następnie wskaż miejsce na mapie.</p><div id="editor-line-actions" class="editor-line-actions"></div><div id="editor-line-content"></div></section><section class="editor-card"><div class="editor-card-heading"><h3>Obiekty magazynu</h3></div><p class="editor-card-help">Dodaj miejsce paletowe, stage, masę, kontrolę lub pole odkładcze.</p><div id="editor-object-content"></div></section>';
    $('editor-line-actions').append(sketchToggle,sketchEdit,editorElements['sketch-merge-selected']);
    $('editor-line-undo').append(editorElements['sketch-undo']);
    sketchEdit.textContent='Wybierz linię';
    sketchPanel.replaceChildren();
    $('editor-line-content').append(sketchPanel);
    sketchPanel.innerHTML='<div id="sketch-merge-progress" class="editor-merge-progress" hidden><div class="editor-merge-picks"><span id="sketch-merge-first">1 · Pierwsza linia</span><span id="sketch-merge-next">2 · Druga linia</span></div></div><div id="editor-line-status" class="editor-line-status"></div><div id="editor-drawing-options" class="editor-drawing-options" hidden></div><div id="editor-mode-actions" class="editor-mode-actions"></div><div id="editor-line-properties"></div><details id="editor-line-extra" class="editor-line-extra"><summary>Dodatkowe opcje linii</summary><div class="editor-extra-body"><label id="editor-snap-distance">Zasięg przyciągania (cm)</label><div id="editor-gap-repair"></div><p>Napraw drobne przerwy między bliskimi końcami w widocznej komorze.</p><div id="editor-line-diagnostics"></div><div id="editor-line-backup" class="editor-line-backup"></div></div></details>';
    $('editor-line-status').append(editorElements['sketch-status']);
    $('editor-drawing-options').append(editorElements['sketch-ortho'].closest('label'),editorElements['sketch-end']);
    $('editor-mode-actions').append(editorElements['sketch-close']);
    $('editor-line-properties').append(lineControls);
    lineControls.insertAdjacentHTML('afterbegin','<h4>Właściwości linii</h4>');
    lineControls.append(editorElements['sketch-delete']);
    editorElements['sketch-delete'].classList.add('editor-delete');
    $('editor-snap-distance').append(editorElements['sketch-join-distance']);
    editorElements['sketch-join'].textContent='Napraw drobne przerwy';$('editor-gap-repair').append(editorElements['sketch-join']);
    editorElements['sketch-test'].textContent='Sprawdź połączenie punktów';$('editor-line-diagnostics').append(editorElements['sketch-test']);
    $('editor-line-backup').append(editorElements['sketch-export'],importLabel,editorElements['sketch-import']);
    $('editor-line-content').append(sketchPanel);$('editor-object-content').append(objectEditor);
    host.querySelector('.spatial-toggles').insertAdjacentHTML('beforeend','<label><input data-layer="storage-areas" type="checkbox" checked> Pola odkładcze</label><label><input data-layer="printers" type="checkbox" checked> Drukarki</label><label><input data-layer="agv" type="checkbox" checked> Pola AGV</label><label><input data-layer="inactive-objects" type="checkbox"> Pokaż nieaktywne</label>');
    $('workspace-inspector').append(inspectorPanel);inspectorPanel.open=true;
    toolContent.insertAdjacentHTML('beforeend','<section class="layout-backup"><h3>Układ użytkownika</h3><button id="layout-export" class="button secondary">Eksport obiektów</button><label for="layout-import" class="button secondary">Import obiektów</label><input id="layout-import" type="file" accept=".json" hidden><div id="layout-backup-status" role="status"></div></section>');
    toolContent.insertAdjacentHTML('beforeend','<section class="layout-backup"><h3>Kopia Warehouse Setup — część aplikacji</h3><p>Obiekty, mapowania, Stage’e, linie, dostępy i filtry. Nie obejmuje Operations, awizacji, ustawień ani historii. Kopia całej aplikacji: Ustawienia → Dane i kopie aplikacji.</p><button id="warehouse-export" class="button secondary">Eksport Warehouse Setup</button><label for="warehouse-import" class="button secondary">Import Warehouse Setup</label><input id="warehouse-import" type="file" accept=".json" hidden><div id="warehouse-backup-status" role="status"></div></section>');
    toolContent.insertAdjacentHTML('afterbegin',`<section class="gate-management"><h3>Zarządzanie rampami</h3><label>Rampa<select id="managed-gate">${Object.values(base.gates).filter(g=>g.active).map(g=>`<option value="${esc(g.gateId)}">${esc(g.gateId)} · K${esc(g.physicalChamber)}</option>`).join('')}</select></label><button id="managed-gate-open" class="button secondary">Przypisz stages do rampy</button></section>`);
    $('managed-gate-open').onclick=()=>{const id=$('managed-gate').value,g=engine.getPhysicalGate(id);selectView(g.physicalChamber,{renderNow:false});inspect('GATE:'+id);render();};
    let workspaceTab='edit';
    const ribbon=DG.mountWarehouseRibbon(host,{
      onTab(id){stopTestPicking();if(id==='edit')session?.begin();if(id!=='edit'&&['measure','object-edit','object-draw','sketch','sketch-test','sketch-edit','sketch-merge'].includes(interactionMode)||id!=='inspector'&&interactionMode==='sketch-access')sketchMode('pan');activateWorkspaceTab(id);},
      onMode:mode=>sketchMode(mode),
      onZoom(f){const w=box[2]*f,h=box[3]*f;if(w<5||w>width*10)return;box=[box[0]+(box[2]-w)/2,box[1]+(box[3]-h)/2,w,h];render();},
      onClose(kind){stopTestPicking();if((['line','object','object-edit'].includes(kind)||interactionMode==='sketch-access')&&interactionMode!=='pan')sketchMode('pan');}
    });
    function activateWorkspaceTab(id){
      if(id!=='edit'&&interactionMode==='measure')sketchMode('pan');
      workspaceTab=id;ribbon.setTab(id);if(id==='edit')ribbon.syncMode(interactionMode,!!sketchSelected);moveView();
    }
    function commitObjectEdit(next,nextSketch,{history=true}={}){
      sketchProtection.assertWritable();
      const nextModel=DG.applyCalibration(base,next),nextIndex=DG.SketchAccess.create(nextModel.geometry);
      callbacks.validateStageBinding?.(model,nextModel);
      // A moved/new confirmed object must not cut a communication line.
      const oldTargets=new Map(DG.LayoutObjects.editTargets(model.geometry).map(o=>[o.id,o]));
      const changed=DG.LayoutObjects.editTargets(nextModel.geometry).filter(o=>{const old=oldTargets.get(o.id);return !old||JSON.stringify(o.points)!==JSON.stringify(old.points)||old.active===false&&o.active!==false||old.floorPassage&&!o.floorPassage;});
      for(const o of changed){if(o.active===false||o.floorPassage===true&&(o.rackObjectId||o.kind==='SLOT')||o.documentaryOnly&&!o.placementValidated)continue;const b=DG.LayoutObjects.bounds(o.points),line=nextSketch.segments.find(s=>s.enabled!==false&&DG.SketchAccess.hitsLine(s.points,b));if(line)throw Error(oldTargets.get(o.id)?.floorPassage&&!o.floorPassage?'Nie można zmienić przejazdu w zwykłe miejsce: przecina linię '+line.id+'. Najpierw zmień lub wyłącz tę linię.':'Obiekt przecina linię '+line.id+'. Zmień położenie.');}
      nextIndex.checkSaved(nextSketch);
      callbacks.validateOperationalChange?.(engine,new DG.SpatialEngine(nextModel).setSketch(nextSketch),sketch,nextSketch);
      validateSavedChange(next,nextSketch);
      const keys=Object.keys(next).filter(k=>JSON.stringify(next[k])!==JSON.stringify(config[k])),copy=v=>v===undefined?undefined:JSON.parse(JSON.stringify(v)),before=Object.fromEntries(keys.map(k=>[k,copy(config[k])])),after=Object.fromEntries(keys.map(k=>[k,copy(next[k])])),sketchChanged=JSON.stringify(sketch)!==JSON.stringify(nextSketch);
      DG.WarehouseBackup.store({config:next,sketch:nextSketch,layers:localStorage.getItem(layerStorageKey),view:localStorage.getItem(viewStorageKey),sourceCalibration:base.calibration},localStorage);
      if(history){editHistory.push({before,after,sketchBefore:sketchChanged?sketch:null,sketchAfter:sketchChanged?nextSketch:null});if(editHistory.length>50)editHistory.shift();}
      config=next;sketch=nextSketch;sketchGraph=Sketch.build(sketch.segments);invalidateRouteTest();accessPreview=null;accessTarget=null;refresh();callbacks.onDomainChanged?.();$('layout-edit-undo').disabled=!editHistory.length;
    }
    const measureTool=DG.mountMapMeasure({host,svg,point,scale:()=>base.geometry.unit.cadToMeters,pixelsPerMeter:()=>pxPerMeter});
    $('ribbon-measure').onclick=()=>sketchMode(interactionMode==='measure'?'pan':'measure');
    layoutEditor=DG.mountLayoutEditor(host,{svg,geometry:()=>model.geometry,chamber:()=>$('spatial-chamber-focus').value,scale:()=>base.geometry.unit.cadToMeters,base:()=>base,config:()=>config,sketch:()=>sketch,commit:commitObjectEdit,render,enabled:()=>interactionMode==='object-edit',showInactive:()=>host.querySelector('[data-layer="inactive-objects"]').checked,cadPoint,point,pixelsPerMeter:()=>pxPerMeter,pixelsPerCad:()=>pxPerMeter/1000,open:()=>ribbon.openDrawer('object-edit'),preview(){const el=svg.querySelector('.layout-edit-overlay'),markup=layoutEditor.markup();if(el)el.outerHTML=markup;else svg.insertAdjacentHTML('beforeend',markup);}});
    $('layout-edit-toggle').onclick=()=>{sketchMode(interactionMode==='object-edit'?'pan':'object-edit');if(interactionMode==='object-edit'){const o=DG.LayoutObjects.editTargets(model.geometry).find(o=>o.temporaryId===inspectionContext?.key);if(o)layoutEditor.select(o);else ribbon.openDrawer('object-edit');}};
    $('layout-edit-undo').onclick=()=>{const previous=editHistory.at(-1);if(!previous)return;try{for(const [key,value]of Object.entries(previous.after))if(JSON.stringify(config[key])!==JSON.stringify(value))throw Error('Dane zmieniły się po edycji. Cofnięcie nadpisałoby późniejsze przypisania.');if(previous.sketchAfter&&JSON.stringify(sketch)!==JSON.stringify(previous.sketchAfter))throw Error('Szkic zmienił się po edycji obiektu. Najpierw cofnij późniejsze zmiany szkicu.');const next={...config};for(const [key,value]of Object.entries(previous.before)){if(value===undefined)delete next[key];else next[key]=value;}commitObjectEdit(next,previous.sketchBefore||sketch,{history:false});editHistory.pop();$('layout-edit-undo').disabled=!editHistory.length;layoutEditor.reset();ribbon.openDrawer('object-edit');$('layout-edit-status').textContent='Cofnięto edycję obiektu.';}catch(e){$('layout-edit-status').textContent=e.message;$('layout-edit-status').dataset.state='error';}};
    let inspectionContext=null;
    const objectInspector=DG.mountObjectInspector($('inspector'));
    function inspectionAccess(){
      if(!inspectionContext)return {text:'Dostęp do trasy nieprzypisany',state:'missing'};
      const records=(sketch.accessPoints||[]).filter(a=>a.targetId===inspectionContext.key);
      const enabled=records.filter(a=>a.confirmed&&sketch.segments.some(line=>line.id===a.segmentId&&line.enabled!==false));
      if(enabled.length)return {text:'Dostęp do linii przypisany · '+enabled.length,state:'ready'};
      if(records.length)return {text:records.some(a=>!a.confirmed)?'Dostęp wymaga zatwierdzenia':'Przypisany dostęp · linia wyłączona',state:'missing'};
      if(inspectionContext.endpointAccess)return {text:'Dostęp do drogi zatwierdzony',state:'ready'};
      return {text:inspectionContext.floorPassage?'Przejazd · połączenia do ustalenia':'Dostęp do trasy nieprzypisany',state:'missing'};
    }
    function setInspectionContext(o,type,dimensions){inspectionContext={key:o.temporaryId||o.id,title:o.displayName||o.temporaryId||o.id,type,chamber:o.physicalChamber,floorPassage:o.floorPassage,dimensions:dimensions||(o.dimensionsMeters?o.dimensionsMeters.map(v=>v.toFixed(2).replace('.',',')).join(' × ')+' m'+(o.documentaryOnly||o.reconstructed||o.simulated?' · przybliżone':''):null)};}
    const inspectorObserver=new MutationObserver(()=>{objectInspector.render(inspectionContext&&{...inspectionContext,access:inspectionAccess()});inspectorObserver.takeRecords();activateWorkspaceTab('inspector');ribbon.openDrawer('inspector');});
    inspectorObserver.observe($('inspector'),{childList:true});
    function resetInspection(){addressFeedback={key:null,text:''};inspectionContext=null;objectInspector.reset();selected=null;inspectorPanel.open=false;$('inspector').textContent='Wybierz miejsce paletowe, stage lub rampę na mapie.';inspectorObserver.takeRecords();ribbon.clearInspection();}
    sketchPanel.hidden=false;
    function validateSavedChange(next,nextSketch=sketch,options={}){DG.SketchAccess.create(DG.applyCalibration(base,next).geometry).checkSaved(nextSketch);const backend=DG.Storage||localStorage,keys=[...Object.values(DG.WarehouseBackup.keys),'dynamic-gates-v01',DG.GateSchedule.KEY,DG.AlgorithmSettings.KEY],before=Object.fromEntries(keys.map(k=>[k,backend.getItem(k)]));DG.WarehouseBackup.validateChange(base,before,{'dynamic-gates-spatial-calibration-v1':DG.serializeCalibration(next,base.calibration),'dynamic-gates-line-sketch-v1':JSON.stringify(nextSketch)},options);}
    function commit(){const key='dynamic-gates-spatial-calibration-v1';try{validateSavedChange(config);localStorage.setItem(key,DG.serializeCalibration(config,base.calibration));}catch(e){const raw=localStorage.getItem(key);config=DG.mergeSourceSlotMappings(raw?JSON.parse(raw):base.calibration,base.calibration,base.geometry);throw e;}refresh();}
    function saveSlotMappings(slotMappings){const next={...config,slotMappings};validateSavedChange(next);try{localStorage.setItem('dynamic-gates-spatial-calibration-v1',DG.serializeCalibration(next,base.calibration));}catch(error){throw Error('Nie zapisano mapowania lokalnie. '+(error.name==='QuotaExceededError'?'Brak miejsca w pamięci przeglądarki.':'Pamięć przeglądarki jest niedostępna.'));}config=next;refresh();}
    function refresh(){model=DG.applyCalibration(base,config);const migrated=sketchProtection.isBlocked()?sketch:DG.WarehouseBackup.migrateAccess(sketch,model.geometry);if(migrated!==sketch){sketch=migrated;sketchGraph=Sketch.build(sketch.segments);try{localStorage.setItem(sketchStorageKey,JSON.stringify(sketch));}catch(_){sketchStorageError='Pobierz pełną kopię Warehouse Setup, aby zachować aktualizację dostępów.';}}engine=new DG.SpatialEngine(model).setSketch(sketch);root.SpatialEngine=engine;root.DistanceProvider=new DG.DistanceProvider(engine);accessIndex=DG.SketchAccess.create(model.geometry);checkSketchAccess();sketchRoute=null;invalidateRouteTest();render();report();updateMappingStatus();if(sketch.archivedAccessPoints?.length)$('warehouse-backup-status').textContent='Archiwum dostępów do ponownego przypisania: '+sketch.archivedAccessPoints.length+'. Linie pozostają zachowane; pełna kopia zawiera archiwum.';}
    function checkSketchAccess(){try{accessIndex.checkSaved(sketch);accessValidationError='';}catch(e){accessValidationError=e.message;}}
    const mappingChamber=()=>$('mapping-chamber').value;
    const chamberSlots=()=>model.geometry.rackSlots.filter(s=>s.physicalChamber===mappingChamber());
    const chamberStages=()=>model.geometry.stageAreas.filter(s=>s.physicalChamber===mappingChamber());
    function updateMappingStatus(){const ch=mappingChamber(),slots=chamberSlots(),stages=chamberStages();const first=slots.reduce((a,s)=>!a||s.number<a.number?s:a,null);$('spatial-slot-find').placeholder=first?`${first.temporaryId} lub ${first.number}`:`K${ch} · numer miejsca`;$('spatial-slot-status').textContent=slots.length?`K${ch}: ${slots.length} miejsc · ${slots.filter(s=>config.slotMappings?.[s.temporaryId]?.length).length} z WMS · ${slots.filter(s=>s.floorPassage).length} oznaczeń przejazdu`:`K${ch}: brak odczytanych obrysów pojedynczych miejsc paletowych · geometria do uzupełnienia`;$('spatial-stage-status').textContent=`K${ch}: ${stages.length} stages`;}
    function render(){
      clearTimeout(detailTimer);if(viewFrame!==null){cancelAnimationFrame(viewFrame);viewFrame=null;}updateViewport();
      const enabled=id=>host.querySelector(`[data-layer="${id}"]`).checked;
      const objectVisible=o=>DG.LayoutObjects.isVisible(o,enabled('inactive-objects'));
      const ch=viewChamber(),allSlots=scoped(model.geometry.rackSlots||[]),slots=allSlots.filter(objectVisible),stages=scoped(model.geometry.stageAreas||[]).filter(objectVisible);
      const floor=scoped(model.geometry.floorAreas||[]).filter(objectVisible);
      const hiddenObjects=DG.LayoutObjects.editTargets(model.geometry).filter(o=>!objectVisible(o)),hiddenTemps=new Set(hiddenObjects.map(o=>o.temporaryId)),hiddenAddresses=new Set(hiddenObjects.flatMap(o=>config.objectMappings?.[o.temporaryId]||[]));
      $('spatial-view-status').textContent=ch?`${slots.length} miejsc · ${stages.length} stages${floor.length?' · '+floor.length+' pól odkładczych':''}${stages.some(s=>s.documentaryOnly)||floor.some(s=>s.documentaryOnly)?' · schemat z dokumentacji':''}`:`${model.geometry.chambers.length} komór · ${slots.length.toLocaleString('pl-PL')} miejsc`;
      renderDocumentaryRegister(ch?.id);
      let markup='';
      if(ch){const p=point(ch.bounds[0],ch.bounds[3]);markup=`<defs><clipPath id="spatial-chamber-clip" clipPathUnits="userSpaceOnUse"><rect x="${p[0]}" y="${p[1]}" width="${(ch.bounds[2]-ch.bounds[0])/1000}" height="${(ch.bounds[3]-ch.bounds[1])/1000}"/></clipPath></defs>`;}
      markup+=`<g id="spatial-scene"${ch?' clip-path="url(#spatial-chamber-clip)"':''}>`;
      if(enabled('storage-areas'))markup+=(model.geometry.documentaryGuides||[]).filter(s=>!ch||s.physicalChamber===ch.id).map(s=>{const center=[(s.points[0][0]+s.points.at(-1)[0])/2,(s.points[0][1]+s.points.at(-1)[1])/2],p=point(...center),vertical=Math.abs(s.points[0][0]-s.points.at(-1)[0])<1;return `<g class="documentary-guide" data-documentary-guide="${esc(s.id)}"><polyline points="${coords(s.points)}" stroke-width="${s.widthMeters}"><title>${esc(s.label)} · rezerwa ${s.widthMeters} m · koncepcja, do potwierdzenia</title></polyline><text x="${p[0]}" y="${p[1]}" font-size="${10/pxPerMeter}" ${vertical?`transform="rotate(-90 ${p[0]} ${p[1]})"`:''}>${esc(s.label)}</text></g>`;}).join('');
      if(enabled('cad')){const groups=new Map();for(const p of scoped(model.geometry.paths)){if(!visible(p.points))continue;const list=groups.get(p.layer)||[];list.push(shape(p.points).path);groups.set(p.layer,list);}markup+=[...groups].map(([layer,paths])=>`<path class="cad-lines" data-cad-layer="${esc(layer)}" d="${paths.join('')}"/>`).join('');}
      if(enabled('control'))markup+=scoped(model.geometry.controlAreas||[],'dynamic').filter(objectVisible).map(a=>{const p=point(...(a.userAdded||a.documentaryOnly?[a.cadX,a.cadY]:a.points[0]));return `<polygon class="cad-control ${a.userAdded?'user-control':''} ${a.documentaryOnly?'documentary-area':''}" ${a.temporaryId?`data-layout-object="${esc(a.id)}"`:''} points="${coords(a.points)}"><title>${esc(a.temporaryId||a.label)} · ${esc(objectName(a))}</title></polygon>${a.documentaryOnly?documentaryLabel(a,p):`<text class="${a.userAdded?'layout-area-label':'cad-area-label'}" ${a.userAdded?`font-size="${11/pxPerMeter}"`:''} x="${p[0]}" y="${p[1]}">${esc(objectName(a))}</text>`}`;}).join('');
      if(enabled('control'))markup+=(model.geometry.controlPoints||[]).filter(scopedPoint).map(a=>{const p=point(a.cadX,a.cadY);return `<g class="cad-control-point" data-control="${esc(a.id)}" role="button" tabindex="0"><circle cx="${p[0]}" cy="${p[1]}" r="2"/><text class="cad-area-label" x="${p[0]+3}" y="${p[1]}">STREFA KONTROLI</text><title>CAD label position · area boundary NEEDS_VALIDATION</title></g>`;}).join('');
      if(enabled('chambers'))markup+=(model.geometry.chambers||[]).filter(c=>!ch||c.id===ch.id).map(ch=>{const p=point(ch.bounds[0]+2000,ch.bounds[3]-6000);return `<polygon class="cad-chamber-boundary" data-chamber="${esc(ch.id)}" points="${coords(ch.points)}"><title>K${esc(ch.id)} · ${esc(ch.geometrySource)} · ${esc(ch.confidence)}</title></polygon><text class="cad-chamber-label" x="${p[0]}" y="${p[1]}">K${esc(ch.id)}</text>`;}).join('');
      if(enabled('roads'))markup+=model.roadGraph.edges.filter(e=>!e.prototype).map(e=>{const a=engine.nodes.get(e.from),b=engine.nodes.get(e.to);return a&&b&&scoped([{points:[[a.x,a.y],[b.x,b.y]]}],'dynamic').length?`<polyline class="cad-road ${e.enabled?'':'unvalidated'}" points="${coords([[a.x,a.y],[b.x,b.y]])}"><title>${esc(e.direction)} · ${e.enabled?'enabled':'disabled'}</title></polyline>`:'';}).join('');
      if(enabled('nodes'))markup+=model.roadGraph.nodes.filter(scopedPoint).map(n=>{const p=point(n.x,n.y);return `<circle class="cad-node" data-node="${esc(n.id)}" cx="${p[0]}" cy="${p[1]}" r="1.2"><title>${esc(n.id)}</title></circle>`;}).join('');
      if(enabled('locations'))markup+=slots.filter(s=>visible(s.points)&&((s.dimensionsMeters?.[0]||.8)*pxPerMeter>=2||s.floorPassage||config.slotMappings?.[s.temporaryId]?.length)).map(s=>{const ids=config.slotMappings?.[s.temporaryId]||[],p=point(s.cadX,s.cadY),detail=(ids[0]!==s.displayName?ids[0]:ids.length>1?ids.length+' adresów':'')||(s.floorPassage?'PRZEJAZD':''),showNumber=(s.dimensionsMeters?.[0]||.8)*pxPerMeter>=12;return `<polygon class="cad-rack-slot ${s.floorPassage?'floor-passage':ids.length?'wms-assigned':enabled('locations')?'wms-pending':''}" data-cad-slot="${esc(s.id)}" data-physical-chamber="${esc(s.physicalChamber)}" points="${shape(s.points).coords}"><title>${esc(s.temporaryId||'Miejsce paletowe CAD')} · ${s.dimensionsMeters?.map(v=>v.toFixed(2)).join(' × ')} m · ${esc(s.floorPassage?'Przejazd na podłodze · regał nad przejazdem · '+(ids.join(', ')||'WMS do przypisania'):ids.join(', ')||'WMS do przypisania')}</title></polygon>${s.temporaryId&&showNumber?`<text class="cad-slot-number" ${s.displayName?`style="font-size:${Math.min(.3,(DG.LayoutObjects.bounds(s.points)[2]-DG.LayoutObjects.bounds(s.points)[0])/1000/((s.displayName.length+1)*.65))}px"`:''} x="${p[0]}" y="${p[1]-(detail ? .12 : 0)}">${esc(s.displayName||(s.displayNumber??s.number))}</text>${detail?`<text class="cad-slot-wms" x="${p[0]}" y="${p[1]+.18}">${esc(detail)}${ids.length>1?' +':''}</text>`:''}`:''}`;}).join('');
      if(enabled('stages'))markup+=stages.map(s=>{const p=point(s.cadX,s.cadY);return `<polygon class="cad-stage ${s.simulated?'simulated-stage':''} ${s.documentaryOnly?'documentary-area':''}" data-stage="${esc(s.id)}" data-physical-chamber="${esc(s.physicalChamber)}" points="${coords(s.points)}"><title>${esc(s.temporaryId)} · ${s.dimensionsMeters.map(v=>v.toFixed(2)).join(' × ')} m · ${esc(objectName(s))}</title></polygon>${s.documentaryOnly?documentaryLabel(s,p):`<text class="${s.userAdded?'layout-area-label':'cad-stage-label'} ${s.simulated?'simulated-stage-label':''}" ${s.userAdded?`font-size="${11/pxPerMeter}"`:''} x="${p[0]}" y="${p[1]}">${esc(objectName(s))}</text>`}`;}).join('');
      markup+=floor.filter(s=>enabled(({AREA:'storage-areas',PRINTER:'printers',AGV:'agv'})[s.kind]||'mass')).map(s=>{const p=point(s.cadX,s.cadY);return `<polygon class="${({AREA:'cad-storage-area',PRINTER:'cad-printer',AGV:'cad-agv'})[s.kind]||'cad-mass'} ${s.documentaryOnly?'documentary-area':''} ${s.planningProposal?'planning-proposal':''} ${s.mappingConflict?'documentary-conflict':''}" data-layout-object="${esc(s.id)}" points="${coords(s.points)}"><title>${esc(s.temporaryId)} · ${esc(s.documentaryLabel||objectName(s))}</title></polygon>${s.documentaryOnly?documentaryLabel(s,p):`<text class="layout-area-label" font-size="${11/pxPerMeter}" x="${p[0]}" y="${p[1]}">${esc(objectName(s))}</text>`}`;}).join('');
      if(ch?.id==='10'&&enabled('storage-areas'))for(const a of model.geometry.documentaryAreas?.k10Layout?.annotations||[]){const p=point(ch.bounds[0]+a.point[0]*1000,ch.bounds[1]+a.point[1]*1000);markup+=`<text class="documentary-guide-label" font-size="${10/pxPerMeter}" x="${p[0]}" y="${p[1]}">${esc(a.label)}</text>`;}
      const draft=objectDraft?.object;
      if(draft){const b=DG.LayoutObjects.bounds(draft.points),p=point(b[0],b[3]);markup+=`<polygon class="layout-object-preview" points="${coords(draft.points)}"/><text class="layout-preview-label" x="${p[0]}" y="${p[1]-10/pxPerMeter}" font-size="${12/pxPerMeter}">${((b[2]-b[0])*base.geometry.unit.cadToMeters).toFixed(2)} × ${((b[3]-b[1])*base.geometry.unit.cadToMeters).toFixed(2)} m</text>`;}
      markup+='<g id="layout-object-live-preview"></g>';
      if(enabled('sketch')||enabled('sketch-access')||accessPreview?.accepted.length||sketchRoute?.connected)markup+=sketchMarkup();
      markup+='</g>';
      markup+=Object.values(model.gates).filter(g=>objectVisible(g)&&scopedPoint(g)&&(enabled('gates')||g.numberingValidated)&&Number.isFinite(g.cadX)&&Number.isFinite(g.cadY)).map(g=>{const p=point(g.cadX,g.cadY),n=g.gateId;return `<g class="cad-gate ${g.mapped?'':'unvalidated'}" data-gate="${esc(n)}" role="button" tabindex="0" aria-label="Physical gate ${esc(n)}"><text x="${p[0]}" y="${p[1]+(p[1]<height/2?-3:6)}">${esc(n.startsWith('EXTRA')?'E'+n.slice(-1):n)}</text><title>${esc(n)} · ${esc(g.confidence)} · CAD ${esc(g.cadObjectId)}</title></g>`;}).join('');
      if(enabled('shipdocks'))markup+=Object.values(model.shipdocks).filter(s=>s.cadX!=null&&scopedPoint(s)&&!hiddenTemps.has(s.temporaryObjectId)&&!hiddenAddresses.has(s.shipDockId)).map(s=>{const p=point(s.cadX,s.cadY);return `<circle class="cad-shipdock" data-shipdock="${esc(s.shipDockId)}" cx="${p[0]}" cy="${p[1]}" r="1.4"><title>${esc(s.shipDockId)}</title></circle>`;}).join('');
      markup+=layoutEditor?.markup()||'';markup+=testMarkup();markup+=measureTool.markup();svg.innerHTML=markup;svg.setAttribute('viewBox',box.join(' '));
    }
    function sketchMarkup(){
      let out='<g id="sketch-layer">';const showLines=host.querySelector('[data-layer="sketch"]').checked,showAccess=host.querySelector('[data-layer="sketch-access"]').checked;
      const arrow=(points,t,reverse=false,classes='')=>{const [a,b]=points.map(p=>point(...p)),dx=b[0]-a[0],dy=b[1]-a[1],length=Math.hypot(dx,dy);if(length*pxPerMeter<18)return '';const sign=reverse?-1:1,ux=dx/length*sign,uy=dy/length*sign,z=[a[0]+t*dx,a[1]+t*dy],size=7/pxPerMeter;return `<polyline class="sketch-arrow ${classes}" points="${[[z[0]-ux*size-uy*size*.6,z[1]-uy*size+ux*size*.6],z,[z[0]-ux*size+uy*size*.6,z[1]-uy*size-ux*size*.6]].map(p=>p.join(',')).join(' ')}"/>`;};
      if(showLines)for(const s of scoped(sketch.segments,'dynamic'))if(visible(s.points)){
        const classes=`${s.enabled===false?'closed':''} ${s.id===sketchSelected?'selected':''}`,direction=s.direction||'BOTH';
        out+=`<polyline class="sketch-hit" data-sketch-line="${s.id}" points="${coords(s.points)}"/><polyline class="sketch-line ${classes}" data-sketch-line="${s.id}" points="${coords(s.points)}"><title>${s.id} · ${s.enabled===false?'Wyłączona':direction==='BOTH'?'Dwukierunkowa':direction==='FORWARD'?'A → B':'B → A'}</title></polyline>`;
        if(s.enabled!==false)for(let i=1;i<s.points.length;i++){const edge=[s.points[i-1],s.points[i]];if(direction!=='REVERSE')out+=arrow(edge,direction==='BOTH'?.65:.5,false,classes);if(direction!=='FORWARD')out+=arrow(edge,direction==='BOTH'?.35:.5,true,classes);}
        if(s.id===sketchSelected)[s.points[0],s.points.at(-1)].forEach((p,i)=>{const a=point(...p);out+=`<text class="sketch-end-label" x="${a[0]+8/pxPerMeter}" y="${a[1]-8/pxPerMeter}" font-size="${12/pxPerMeter}">${i?'B':'A'} · ${s.id}</text>`;});
      }
      if(showLines)for(const n of Sketch.visibleNodes(sketchGraph))if(scopedPoint({cadX:n.point[0],cadY:n.point[1]})){const p=point(...n.point);out+=`<circle class="sketch-node ${n.component?'':'closed'}" data-sketch-node="${n.id}" cx="${p[0]}" cy="${p[1]}" r="${4/pxPerMeter}"><title>Połączenie linii</title></circle>`;}
      const lineMap=new Map(sketch.segments.map(s=>[s.id,s]));
      const ports=[...(showAccess?sketch.accessPoints||[]:[]).map(a=>({...a,preview:false})),...(accessPreview?.accepted||[]).map(a=>({...a,preview:true}))];
      for(const a of ports)if(scopedPoint({cadX:a.point[0],cadY:a.point[1]})&&visible([a.point,a.linePoint])){const p=point(...a.point),classes=`${a.preview?'preview':''} ${lineMap.get(a.segmentId)?.enabled===false?'closed':''}`;out+=`<polyline class="sketch-access-line ${classes}" points="${coords([a.point,a.linePoint])}"/><circle class="sketch-access-port ${classes}" cx="${p[0]}" cy="${p[1]}" r="${Math.min(3,.25*pxPerMeter)/pxPerMeter}"/>`;if(a.exitAllowed)out+=arrow([a.point,a.linePoint],.7,false,classes);if(a.entryAllowed)out+=arrow([a.point,a.linePoint],.3,true,classes);}
      if(sketchRoute?.connected){
        out+=`<polyline class="sketch-route" points="${coords(sketchRoute.points)}"/>`;
        for(const [i,xy] of [sketchRoute.points[0],sketchRoute.points.at(-1)].entries()){
          const p=point(...xy);out+=`<circle class="route-endpoint ${i?'destination':'source'}" cx="${p[0]}" cy="${p[1]}" r="${6/pxPerMeter}"/><text class="route-endpoint-label" x="${p[0]+10/pxPerMeter}" y="${p[1]-10/pxPerMeter}" font-size="${12/pxPerMeter}">${i?'Do':'Od'}</text>`;
        }
      }
      out+='</g><g id="sketch-preview"></g>';return out;
    }
    function sketchFeedback(){
      const mode=interactionMode,drawing=mode==='sketch',testing=mode==='sketch-test',editing=mode==='sketch-edit',access=mode==='sketch-access',merging=mode==='sketch-merge';
      sketchToggle.setAttribute('aria-pressed',String(drawing));sketchToggle.textContent=drawing?'Przesuwanie mapy':'Rysuj linie';
      sketchEdit.classList.toggle('active',editing);
      sketchPanel.hidden=false;
      $('sketch-undo').disabled=!sketchHistory.length;$('sketch-delete').disabled=!sketchSelected;
      $('sketch-join').disabled=!sketch.segments.length;
      if($('access-confirm'))$('access-confirm').disabled=!accessPreview?.accepted.length;
      $('sketch-test').classList.toggle('active',testing);
      const select=$('sketch-line-select'),lines=scoped(sketch.segments,'dynamic');
      select.innerHTML='<option value="">Wybierz na mapie</option>'+lines.map(s=>`<option value="${s.id}">${s.id}${s.enabled===false?' · wyłączony':''}</option>`).join('');select.value=sketchSelected||'';
      $('sketch-merge-selected').disabled=sketch.segments.length<2&&!merging;
      $('sketch-merge-selected').classList.toggle('active',merging);$('sketch-merge-selected').setAttribute('aria-pressed',String(merging));
      $('sketch-merge-progress').hidden=!merging;
      $('sketch-merge-first').textContent=sketchSelected?'1 · '+sketchSelected:'1 · Pierwsza linia';$('sketch-merge-first').classList.toggle('chosen',!!sketchSelected);
      $('sketch-merge-next').textContent='2 · Druga linia';$('sketch-merge-next').classList.toggle('next',!!sketchSelected);
      $('editor-drawing-options').hidden=!drawing;
      $('sketch-close').hidden=!drawing&&!editing&&!merging&&!testing&&!access;
      $('sketch-close').textContent=merging?'Anuluj łączenie':drawing?'Zakończ rysowanie':'Zakończ edycję';
      if(testing)$('editor-line-extra').open=true;
      $('sketch-line-controls').hidden=merging||(!editing&&!sketchSelected);
      const line=sketch.segments.find(s=>s.id===sketchSelected);$('sketch-direction').disabled=!line;$('sketch-enabled').disabled=!line;
      if(line){const a=line.points[0],b=line.points.at(-1),horizontal=Math.abs(a[1]-b[1])<Sketch.EPS,forward=horizontal?(b[0]>a[0]?'Prawo':'Lewo'):(b[1]>a[1]?'Góra':'Dół'),reverse=horizontal?(b[0]>a[0]?'Lewo':'Prawo'):(b[1]>a[1]?'Dół':'Góra');$('sketch-direction').options[1].textContent=forward;$('sketch-direction').options[2].textContent=reverse;$('sketch-direction').value=line.direction||'BOTH';$('sketch-enabled').checked=line.enabled!==false;}
      $('sketch-line-length').textContent=line?(Sketch.length(line.points)*base.geometry.unit.cadToMeters).toFixed(2)+' m':'';
      const help=merging?(sketchSelected?'Wybierz drugą linię na mapie.':'Wybierz pierwszą linię na mapie.'):access?'Kliknij linię, do której przypiszesz dostęp.':editing?'Kliknij linię na mapie, aby zmienić jej właściwości.':testing?'Kliknij dwa punkty na liniach, aby sprawdzić dozwoloną trasę.':drawing?'Kliknij początek i kolejne końce linii.':sketchSelected?'Wybrano '+sketchSelected+'.':'Rysuj, wybierz lub połącz linie na mapie.';
      $('sketch-status').textContent=sketchStorageError||sketchMessage||`${help} ${sketch.segments.length} odcinków · ${sketchGraph.components} sieci.`;
      svg.classList.toggle('sketch-drawing',drawing||testing||merging||mode==='object-draw');
      ribbon.syncMode(mode,!!sketchSelected);
    }
    function saveSketch(next,{keepSelection=false,history=true,allowUnreadableSketch=false}={}){
      sketchProtection.assertWritable();
      next=Sketch.validate(next);
      const oldLines=new Map(sketch.segments.map(s=>[s.id,s]));
      for(const line of next.segments){
        const old=oldLines.get(line.id),changed=!old||JSON.stringify(old.points)!==JSON.stringify(line.points)||old.enabled===false&&line.enabled!==false;
        if(!changed||line.enabled===false)continue;
        if(line.points.slice(1).some((p,i)=>Math.abs(p[0]-line.points[i][0])>Sketch.EPS&&Math.abs(p[1]-line.points[i][1])>Sketch.EPS))throw Error('Linie mogą być tylko pionowe lub poziome.');
        const obstacle=accessIndex.obstacles.find(o=>DG.SketchAccess.hitsLine(line.points,o.bounds));
        if(obstacle){sketchMessage='Linia przecina obiekt '+obstacle.id;render();throw Error(sketchMessage);}
      }
      // A draft validates only changed roads/ports. The native Save boundary
      // validates the complete Warehouse and protects active Operations atomically.
      const draftEngine=session?.active?engine.withDraftSketch(next):null;
      if(draftEngine?.sketchError)throw Error(draftEngine.sketchError);
      if(!draftEngine){callbacks.validateOperationalChange?.(engine,new DG.SpatialEngine(model).setSketch(next),sketch,next);validateSavedChange(config,next,{allowUnreadableSketch});}
      const nextGraph=Sketch.build(next.segments);
      try{localStorage.setItem(sketchStorageKey,JSON.stringify(next));}catch(e){sketchStorageError='Nie zapisano zmiany szkicu. Poprzedni zapis pozostaje zachowany. '+e.message;sketchFeedback();throw e;}
      if(history){sketchHistory.push(sketch);if(sketchHistory.length>50)sketchHistory.shift();}
      sketch=next;sketchGraph=nextGraph;sketchRoute=null;invalidateRouteTest();if(!keepSelection)sketchSelected=null;accessPreview=null;
      if(draftEngine){engine=draftEngine;root.SpatialEngine=engine;root.DistanceProvider=new DG.DistanceProvider(engine);accessValidationError='';}
      else{checkSketchAccess();engine.setSketch(sketch);}
      sketchStorageError='';sketchMessage='';
      render();sketchFeedback();refreshAccessRecords();
    }
    function sketchMode(mode){
      stopTestPicking();
      if(['object-edit','object-draw','sketch','sketch-edit','sketch-merge','sketch-access'].includes(mode))session?.begin();
      if(sketchProtection.isBlocked()&&mode.startsWith('sketch')){sketchMode('pan');ribbon.openDrawer('line');return;}
      measureTool.setActive(mode==='measure');
      if(mode!=='object-edit')layoutEditor?.cancel();
      if(mode!=='object-draw'){if(interactionMode==='object-draw')$('object-status').textContent='Anulowano dodawanie obiektu.';objectAnchor=null;objectDraft=null;objectHover=null;$('object-dimensions').hidden=true;$('object-confirm').disabled=true;}
      drag=null;sketchAnchor=null;sketchHover=null;sketchRoute=null;invalidateRouteTest();sketchSelected=null;sketchMessage='';accessPreview=null;if(mode!=='sketch-access')accessTarget=null;
      interactionMode=mode;if(['measure','sketch','sketch-test','sketch-edit','sketch-merge','object-draw','object-edit'].includes(mode))activateWorkspaceTab('edit');if(mode.startsWith('sketch'))host.querySelector('[data-layer="sketch"]').checked=true;render();sketchFeedback();
    }
    function sketchSnap(xy,event){
      const tolerance=Math.min(1000,14/pxPerMeter*1000),drawing=interactionMode==='sketch',nodeId=event.target.closest('[data-sketch-node]')?.dataset.sketchNode;
      const node=nodeId&&sketchGraph.nodes.find(n=>n.id===nodeId);
      if(node)return {point:[...node.point],snapped:true,kind:'node',segmentId:sketchGraph.edges.find(e=>e.from===node.id||e.to===node.id)?.segmentIds[0]};
      const cm=Number($('sketch-join-distance').value),endpointTolerance=drawing?Math.min(tolerance,(cm>=1&&cm<=100?cm:20)/100/base.geometry.unit.cadToMeters):tolerance;
      return Sketch.snap(xy,event.altKey?[]:sketch.segments,tolerance,sketchAnchor,drawing,endpointTolerance);
    }
    function sketchClick(xy,event){
      const snapped=sketchSnap(xy,event),p=snapped.point;
      if(!scopedPoint({cadX:p[0],cadY:p[1]}))return;
      if(interactionMode==='sketch-test'){
        if(!snapped.snapped){sketchMessage='Kliknij na narysowanej linii.';sketchFeedback();return;}
        if(!sketchAnchor){sketchAnchor=p;sketchMessage='Wskaż drugi punkt na szkicu.';}
        else{sketchRoute=Sketch.route(sketch.segments,sketchAnchor,p,base.geometry.unit.cadToMeters);sketchAnchor=null;sketchMessage=sketchRoute.connected?`Połączone · ${sketchRoute.lengthMeters==null?sketchRoute.lengthCadUnits.toFixed(2)+' jednostek CAD':sketchRoute.lengthMeters.toLocaleString('pl-PL',{minimumFractionDigits:2,maximumFractionDigits:2})+' m'} (szkic).`:'Te punkty nie są połączone dozwoloną trasą. Sprawdź kierunki, wyłączenia i brakujące odcinki.';}
      }else if(!sketchAnchor){sketchAnchor=p;sketchSelected=null;sketchMessage='Wskaż koniec odcinka. Linie przyciągają się do istniejących połączeń.';}
      else if(Math.hypot(p[0]-sketchAnchor[0],p[1]-sketchAnchor[1])<=Sketch.EPS){sketchAnchor=null;sketchHover=null;sketchMessage='To już wspólny punkt — nie dodano krótkiego odcinka.';}
      else{try{const segments=Sketch.add(sketch.segments,sketchAnchor,p,sketch.nextSegmentNumber);if(segments!==sketch.segments)saveSketch({...sketch,segments,nextSegmentNumber:Number(segments.at(-1).id.slice(1))+1});sketchAnchor=p;sketchMessage=snapped.snapped?`Odcinek dodany. Połączono z ${snapped.segmentId||'istniejącym punktem'}.`:'Odcinek dodany. Kliknij kolejny punkt albo wybierz „Nowa linia”.';}catch(e){sketchMessage=e.message;}}
      render();sketchFeedback();
    }
    function report(){
      const locations=Object.values(model.locations),racks=locations.filter(l=>/^\d{2}R\d{4}/.test(l.locationId)),gates=Object.values(model.gates).filter(g=>g.active),docks=Object.values(model.shipdocks),nodes=model.roadGraph.nodes.filter(n=>!n.id.startsWith('PROTO-K2-')),edges=model.roadGraph.edges.filter(e=>!e.prototype),visited=new Set();let components=0;
      for(const n of nodes){if(visited.has(n.id))continue;components++;const todo=[n.id];while(todo.length){const id=todo.pop();if(visited.has(id))continue;visited.add(id);for(const e of edges)if(e.enabled&&(e.from===id||e.to===id))todo.push(e.from===id?e.to:e.from);}}
      const pairs=[['CAD docks detected',Object.keys(model.gates).length],['Physical gates validated',`${gates.filter(g=>g.mapped).length} / 137`],['WMS locations mapped',`${locations.filter(l=>l.mapped).length} / ${locations.length}`],['Rack coverage',`${(100*racks.filter(l=>l.mapped).length/racks.length).toFixed(1)}%`],['ShipDocks mapped',`${docks.filter(s=>s.mapped).length} / ${docks.length}`],['Road nodes / edges',`${nodes.length} / ${edges.length}`],['Disconnected components',components],['Locations without road access',locations.filter(l=>!l.accessValidated).length],['ShipDocks without road access',docks.filter(l=>!l.accessValidated).length],['Units',model.geometry.unit.distanceUnit],['Control areas',(config.controlAreas||[]).length]];
      $('spatial-validation').innerHTML=pairs.map(([k,v])=>`<div class="stat-line"><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`).join('')+'<p class="row-warning">NEEDS_VALIDATION · not production ready. Sequential gate IDs and ShipDock associations need confirmation.</p>';
      const coverage=(rows,pred)=>{const count=rows.filter(pred).length;return rows.length&&count===rows.length?'PASS':count?'PARTIAL':'NEEDS_VALIDATION';};
      const statuses=[];
      for(const ch of ['7','8','9','3','2','1','10','11','4','5','6']){
        const lr=racks.filter(l=>l.physicalChamber===ch),sd=docks.filter(s=>s.physicalChamber===ch),gs=gates.filter(g=>g.physicalChamber===ch),st=locations.filter(l=>l.locType==='Stage'&&String(l.logicalChamber)===ch),geo=model.geometry.chambers.find(c=>c.id===ch);
        // Reachability needs one directed graph walk, not a shortest-path
        // calculation for every pair of nodes in different chambers.
        let cross=false;const todo=nodes.filter(n=>n.physicalChamber===ch).map(n=>n.id),seen=new Set(todo);
        for(let i=0;i<todo.length&&!cross;i++)for(const arc of engine.adj.get(todo[i])||[]){const n=engine.nodes.get(arc.to);if(n?.physicalChamber&&n.physicalChamber!==ch){cross=true;break;}if(!seen.has(arc.to)){seen.add(arc.to);todo.push(arc.to);}}
        statuses.push([`K${ch}${ch==='7'?' · PILOT':ch==='8'?' · NEXT':''}`,geo?'PASS':'NEEDS_VALIDATION',coverage(lr,l=>l.mapped),coverage(st,l=>l.mapped&&l.physicalChamber===ch),coverage(sd,s=>s.mapped),coverage(lr.concat(sd),e=>e.accessValidated),coverage(gs,g=>g.mapped),cross?'PASS':'NEEDS_VALIDATION']);
      }
      $('spatial-chamber-validation').innerHTML=`<table><thead><tr>${['Chamber','Geometry','WMS racks','Stage','ShipDock','Road access','Gate mapping','Cross chamber'].map(t=>`<th>${t}</th>`).join('')}</tr></thead><tbody>${statuses.map(row=>`<tr>${row.map((v,i)=>`<td class="${i&&v!=='PASS'?'row-warning':''}">${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    }
    function inspect(id){selected=id;const e=engine.endpoint(id);if(!e)return;inspectionContext={key:id,title:id.startsWith('GATE:')?'Rampa '+id.slice(5):id,type:id.startsWith('GATE:')?'Rampa':e.shipDockId?'ShipDock':'Lokalizacja WMS',chamber:e.physicalChamber,gate:id.startsWith('GATE:'),endpointAccess:e.accessValidated};
      if(id.startsWith('GATE:')&&base.gates[id.slice(5)]?.active)callbacks.inspectGate(id.slice(5));else $('inspector').innerHTML=`<strong>${esc(id)}</strong>`;
      $('inspector').insertAdjacentHTML('beforeend',`<div class="spatial-inspection"><h4>Spatial mapping</h4>${[['Physical chamber',e.physicalChamber],['Logical chamber',e.logicalChamber],['CAD XY',e.cadX==null?'Unknown':`${e.cadX.toFixed(2)}, ${e.cadY.toFixed(2)}`],['Confidence',e.confidence],['Source',e.mappingSource],['Road access',e.accessValidated?e.roadNodeId:'NEEDS_VALIDATION']].map(([k,v])=>`<div class="stat-line"><span>${esc(k)}</span><strong>${esc(v??'Unknown')}</strong></div>`).join('')}${id.startsWith('GATE:')?`<p>ShipDock endpoints: ${esc(Object.values(model.shipdocks).filter(s=>s.physicalGateId===id.slice(5)).map(s=>s.shipDockId+' ('+s.confidence+')').join(', ')||'None')}</p>`:''}</div>`);
      if(e.shipDockId)shipDockDetails(e.shipDockId);
    }
    function shipDockDetails(id){const s=engine.getShipDock(id);if(!s)return;$('inspector').insertAdjacentHTML('beforeend',`<section class="spatial-inspection"><h4>ShipDock → Physical Gate</h4>${[['ShipDock',s.shipDockId],['Physical Gate',s.physicalGateId??'NEEDS_VALIDATION'],['Physical Chamber',s.physicalChamber?'K'+s.physicalChamber:'NEEDS_VALIDATION'],['Status',s.active?(s.bindingStatus==='RESOLVED'?(s.mapped?'ACTIVE':'NEEDS_VALIDATION · stage position'):'NEEDS_VALIDATION'):'INACTIVE'],['Coordinates',s.cadX==null?'NEEDS_VALIDATION':s.cadX.toFixed(2)+', '+s.cadY.toFixed(2)],['Mapping source',s.mappingSource],['Confidence',s.confidence]].map(([k,v])=>`<div class="stat-line"><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`).join('')}<p>Gate wynika z ShipDocku i nie jest osobnym wyborem.</p></section>`);}
    function gateStageControls(gateId){
      const gate=engine.getPhysicalGate(gateId);if(!gate)return;inspectionContext={key:'GATE:'+gateId,title:'Rampa '+gateId,type:'Rampa',chamber:gate.physicalChamber,gate:true,endpointAccess:gate.accessValidated};
      const stages=DG.LayoutObjects.shippingStages(model.geometry).filter(s=>String(s.physicalChamber)===String(gate.physicalChamber)),family=model.gateFamilies[gateId]?.shipDockIds||[];
      const bound=family.map(id=>engine.getShipDock(id)).filter(s=>s.temporaryObjectId);
      const evidence=model.geometry.documentaryAreas?.stageRelationships.filter(r=>r.gateId===gateId)||[];
      if(evidence.length)$('inspector').insertAdjacentHTML('beforeend',`<section class="documentary-evidence"><h4>Pole przy rampie · dokumentacja</h4>${evidence.map(r=>`<p><strong>${esc(r.label)}</strong>${r.documentaryLocationCode?' · '+esc(r.documentaryLocationCode):''}</p><p>${esc(r.source)} · str. ${r.page}. Litera stage’u WMS nie jest podana.${r.temporaryObjectId?' Obrys na planie jest przybliżony.':' Dopasowanie do obrysu CAD pozostaje do ustalenia.'}</p>${r.note?'<p>'+esc(r.note)+'</p>':''}`).join('')}</section>`);
      $('inspector').insertAdjacentHTML('beforeend',`<section class="gate-stage-tools"><h4>Stages rampy ${esc(gateId)}</h4><label><input id="gate-active" type="checkbox"> Rampa aktywna</label><label><input id="gate-position-confirmed" type="checkbox"> Potwierdzam położenie rampy na mapie</label><label>Przeznaczenie rampy<select id="gate-operation-mode"><option value="DYNAMIC">Dynamic — załadunek i rozładunek</option><option value="OUTBOUND">Outbound — załadunek</option><option value="INBOUND">Inbound — rozładunek</option></select></label><button id="gate-operation-save" class="button secondary">Zapisz przeznaczenie rampy</button><div id="gate-operation-status" role="status"></div><div>${bound.map(s=>`<p><strong>${esc(s.shipDockId)}</strong> · ${esc(s.temporaryObjectId)}</p>`).join('')||'<p>Brak przypisanych obrysów stages.</p>'}</div><label>Stage na planie<select id="gate-stage-select">${stages.map(s=>{const assigned=config.objectMappings?.[s.temporaryId]?.[0],dock=engine.getShipDock(assigned||s.temporaryId);return `<option value="${esc(s.temporaryId)}">${esc(s.temporaryId)}${assigned?' · '+esc(assigned):''}${dock?.physicalGateId?' → rampa '+esc(dock.physicalGateId):' · bez rampy'}</option>`;}).join('')}</select></label><label>Numer / kod ShipDock<input id="gate-stage-code" aria-label="Kod ShipDocku stage" placeholder="Np. ${esc(gateId)}A lub własny kod" list="gate-stage-aliases"></label><datalist id="gate-stage-aliases">${family.map(id=>`<option value="${esc(id)}">`).join('')}</datalist><p>Wybierz prostokąt na planie i wpisz jego kod. Standardowy kod musi zaczynać się numerem tej rampy. Własny kod otrzyma ręcznie potwierdzone powiązanie.</p><button id="gate-stage-save" class="button secondary" ${stages.length?'':'disabled'}>Zapisz stage → rampa ${esc(gateId)}</button><div id="gate-stage-status" role="status"></div></section>`);
      $('gate-operation-mode').value=DG.ShipDockDomain.operationMode(gate,'DYNAMIC');$('gate-active').checked=gate.active!==false;$('gate-position-confirmed').checked=gate.mapped===true;
      $('gate-operation-save').onclick=()=>{try{const next={...config,gates:{...config.gates,[gateId]:{...config.gates?.[gateId],operationMode:$('gate-operation-mode').value,active:$('gate-active').checked,mapped:$('gate-position-confirmed').checked}}};commitObjectEdit(next,sketch);callbacks.inspectGate(gateId);$('gate-operation-status').textContent='Zapisano przeznaczenie rampy. Istniejące przydziały zachowano; niezgodne będą oznaczone konfliktem.';}catch(e){$('gate-operation-status').textContent=e.message;}DG.revealInspectorFeedback($('gate-operation-status'));};
      const gateTarget=model.geometry.gateAccessTargets?.find(g=>g.temporaryId==='GATE:'+gateId);if(gateTarget)accessControls(gateTarget);
      const update=()=>{$('gate-stage-code').value=config.objectMappings?.[$('gate-stage-select').value]?.[0]||'';};$('gate-stage-select').onchange=update;update();
      if(evidence[0]?.temporaryObjectId){$('gate-stage-select').value=evidence[0].temporaryObjectId;update();}
      $('gate-stage-save').onclick=()=>{try{
        const next=DG.bindStageToGate(base,config,$('gate-stage-select').value,$('gate-stage-code').value,gateId),nextModel=DG.applyCalibration(base,next);
        callbacks.validateStageBinding?.(model,nextModel);
        commitObjectEdit(next,sketch);callbacks.inspectGate(gateId);
        $('gate-stage-status').textContent='Zapisano przypisanie. Dostępy stage do linii pozostają bez zmian.';
      }catch(e){$('gate-stage-status').textContent=e.message;}DG.revealInspectorFeedback($('gate-stage-status'));};
    }
    const mappingLocations=()=>({...base.locations,...model.shipdocks});
    function renderDocumentaryRegister(chamber){
      const source=model.geometry.documentaryAreas;if(!source){documentaryPanel.hidden=true;return;}
      const rows=source.stageRelationships.filter(r=>!chamber||r.physicalChamber===chamber);
      const floorCount=model.geometry.floorAreas.filter(a=>a.documentaryOnly&&a.physicalChamber==='11').length;
      documentaryPanel.innerHTML=`<h4>Pola i stages z dokumentacji</h4><p>${source.stageRelationships.length} powiązań z rampami · ${floorCount} nazwane pola X-Dock w K11. Obrysy przerywane pokazują przybliżone położenie ze schematów. Kliknij pole, aby sprawdzić nazwę i źródło.</p><details><summary>${chamber?'K'+esc(chamber):'Wszystkie komory'} · ${rows.length} powiązań z rampami</summary><table><thead><tr><th>Rampa</th><th>Pole / kierunek</th><th>Obrys</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${esc(r.gateId)}</td><td>${esc(r.label)}</td><td>${r.temporaryObjectId?`<button class="button secondary" data-documentary-object="${esc(r.temporaryObjectId)}">Pokaż</button>`:'Do ustalenia'}</td></tr>`).join('')}</tbody></table></details>`;
      documentaryPanel.querySelectorAll('[data-documentary-object]').forEach(button=>button.onclick=()=>{const s=model.geometry.stageAreas.find(s=>s.temporaryId===button.dataset.documentaryObject);selectView(s.physicalChamber,{renderNow:false});focusStages([s]);inspectStage(s.id);});
      if(chamber==='10'&&source.k10Layout){const fields=model.geometry.floorAreas.filter(a=>a.physicalChamber==='10'&&a.documentaryCode),assigned=fields.filter(a=>config.objectMappings?.[a.temporaryId]?.length).length;documentaryPanel.innerHTML=`<h4>K10 · układ roboczy</h4><p>15 pól X-Dock przy części ramp 40–46 · ${assigned} z przypisaniem WMS. Zwroty i Masa mają proponowane granice. Rezerwa operacyjna jest koncepcją zagospodarowania.</p><p>Obrysy i szerokości wymagają potwierdzenia. Układ regałów przy ścianach: ${model.geometry.rackSlots.filter(s=>s.physicalChamber==='10').length} miejsc.</p><details><summary>Pola X-Dock i źródła</summary><table><thead><tr><th>Pole</th><th>ID WMS</th></tr></thead><tbody>${fields.map(a=>`<tr><td>${esc(a.documentaryLabel)}</td><td>${esc(config.objectMappings?.[a.temporaryId]?.join(', ')||'Do ustalenia')}</td></tr>`).join('')}</tbody></table></details>`;}
    }
    function documentaryDetails(s){
      if(!s.documentaryOnly)return;
      const confirmed=config.documentaryGeometryValidated?.[s.temporaryId]===true;
      $('inspector').insertAdjacentHTML('beforeend',`<section class="documentary-evidence"><h4>${esc(s.documentaryLabel)}</h4><p>${esc(s.sourceEvidence.source)}${s.sourceEvidence.page?' · str. '+s.sourceEvidence.page:''}${s.documentaryGateId?' · rampa '+esc(s.documentaryGateId):''}${s.documentaryLocationCode?' · oznaczenie '+esc(s.documentaryLocationCode):''}</p><p>${esc(s.sourceEvidence.note)}</p><p><strong>${confirmed?'Położenie i wymiary zatwierdzone lokalnie':s.planningProposal?'Propozycja zagospodarowania · granice do ustalenia':'Położenie i wymiary przybliżone'}</strong></p><button id="documentary-geometry-confirm" class="button secondary">${confirmed?'Cofnij zatwierdzenie geometrii':'Zatwierdź położenie i wymiary'}</button></section>`);
      $('documentary-geometry-confirm').insertAdjacentHTML('afterend','<p id="documentary-geometry-status" role="status"></p>');
      $('documentary-geometry-confirm').onclick=()=>{try{config={...config,documentaryGeometryValidated:{...config.documentaryGeometryValidated,[s.temporaryId]:!confirmed}};commit();inspectAccessTarget(s);}catch(error){$('documentary-geometry-status').textContent=error.message;}};
    }
    function inspectSlot(id){
      const s=model.geometry.rackSlots.find(s=>s.id===id);if(!s)return;setInspectionContext(s,s.floorPassage?'Przejazd pod regałem':'Miejsce paletowe');
      // A projected point inside a CAD cell is a candidate, never an approved association.
      const contains=l=>{if(l.cadX==null||l.cadY==null)return false;let sign=0;for(let i=0;i<4;i++){const a=s.points[i],b=s.points[(i+1)%4],cross=(b[0]-a[0])*(l.cadY-a[1])-(b[1]-a[1])*(l.cadX-a[0]);if(Math.abs(cross)<.01)continue;const next=Math.sign(cross);if(sign&&sign!==next)return false;sign=next;}return true;};
      const candidates=Object.values(model.locations).filter(contains).map(l=>l.locationId);
      const assigned=config.slotMappings?.[s.temporaryId]||[];
      $('inspector').innerHTML=`<strong>${esc(s.temporaryId||'Miejsce paletowe na regale')}</strong><div class="spatial-inspection">${[['Numer roboczy',s.temporaryId||'Nie nadano'],['Obiekt CAD',s.id],['Regał',s.rackObjectId],...(s.reconstructed?[['Status geometrii',s.geometrySource==='USER_EXCEL_LAYOUT_CORRECTION'?'Układ z Excela · rozmieszczenie metryczne do potwierdzenia':'Odtworzenie ze zrzutu · liczba miejsc do potwierdzenia']]:s.userLayout?[['Status geometrii','Układ użytkownika · położenie robocze']]:[]),['Wymiary',s.dimensionsMeters?.map(v=>v.toFixed(2)).join(' × ')+' m'],['CAD XY',`${s.cadX.toFixed(2)}, ${s.cadY.toFixed(2)}`],['Źródło geometrii',s.geometrySource]].map(([k,v])=>`<div class="stat-line"><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`).join('')}<p>WMS: ${esc(assigned.join(', ')||'Do przypisania · NEEDS_VALIDATION')}</p><p>Prostokąt przedstawia miejsce paletowe w rzucie z góry. Jedno miejsce może obejmować adresy WMS z różnych wysokości. Rozdziel pełne identyfikatory znakiem |.</p>${s.temporaryId?'<section id="slot-wms-addresses" data-wms-addresses></section>':''}${candidates.length?`<p>Kandydaci z roboczej projekcji XLSB: ${esc(candidates.join(', '))}. Wymagają potwierdzenia.</p>`:'<p>Brak lokalizacji WMS wewnątrz tego miejsca w roboczej projekcji XLSB.</p>'}</div>`;
      if(s.temporaryId)addressControls($('slot-wms-addresses'),s,assigned,next=>{
        const mappings=DG.importSlotCsv('TEMP_ID;LOCATION_IDS\n'+s.temporaryId+';'+next.join('|'),model.geometry,base.locations,config.slotMappings,config.objectMappings);
        session?.begin();saveSlotMappings(mappings);
      },s.floorPassage?{help:'Adresy WMS regału nad przejazdem. Podłoga pozostaje przejazdem.'}:{});
      $('inspector').insertAdjacentHTML('beforeend',`<section data-slot-mode-tools class="object-location-tools"><label for="slot-floor-mode">Podłoga pod lokalizacją</label><select id="slot-floor-mode"><option value="PALLET">Zwykłe miejsce paletowe</option><option value="PASSAGE">Przejazd pod regałem</option></select><button id="slot-floor-apply" type="button" class="button secondary">Zastosuj rodzaj miejsca</button><p class="object-help">Przejazd pozwala poprowadzić ścieżkę pod lokalizacją. Wszystkie adresy WMS na wyższych poziomach pozostają przypisane.</p><p id="slot-floor-status" role="status"></p></section>`);
      $('slot-floor-mode').value=s.floorPassage?'PASSAGE':'PALLET';
      $('slot-floor-apply').onclick=()=>{try{const passage=$('slot-floor-mode').value==='PASSAGE';if(passage===!!s.floorPassage)return;session?.begin();const next=DG.LayoutEdit.change(base,config,sketch,s,{floorPassage:passage});commitObjectEdit(next.config,next.sketch);inspectSlot(id);$('slot-floor-status').textContent=(session?'Zmieniono w wersji roboczej. Kliknij Zapisz, aby utrwalić zmianę.':'Zapisano rodzaj miejsca.')+' Adresy WMS zachowano.';}catch(error){$('slot-floor-mode').value=s.floorPassage?'PASSAGE':'PALLET';$('slot-floor-status').textContent=error.message;}DG.revealInspectorFeedback($('slot-floor-status'));};
      if(s.floorPassage){$('inspector').insertAdjacentHTML('beforeend',`<div class="spatial-inspection"><strong>Przejazd na podłodze · regał nad przejazdem</strong><p>Adresy WMS mogą pozostać przypisane do lokalizacji nad przejazdem. Dostęp do regału wymaga osobnego wskazania.</p></div>`);}
      accessControls(s);
      if(s.mappingConflict&&!assigned.length)$('inspector').insertAdjacentHTML('beforeend',`<div class="spatial-inspection"><strong>Adres do wyjaśnienia</strong><p>${esc(s.note)}</p></div>`);
      const sourceEvidence=model.geometry.slotEvidence?.[s.temporaryId];if(sourceEvidence&&!assigned.length)$('inspector').insertAdjacentHTML('beforeend',`<div class="spatial-inspection"><strong>Źródło pola${sourceEvidence.cell?' · '+esc(sourceEvidence.cell):''}</strong><p>${esc(sourceEvidence.note)}</p></div>`);
      if(s.userAdded)objectControls(s);
    }
    function cadPoint(event){const p=new DOMPoint(event.clientX,event.clientY).matrixTransform(svg.getScreenCTM().inverse());return [p.x*1000+origin[0],base.geometry.bounds[3]-p.y*1000];}
    function inspectStage(id){const s=model.geometry.stageAreas.find(s=>s.id===id);if(!s)return;setInspectionContext(s,'Stage');$('inspector').innerHTML=`<strong>${esc(s.temporaryId)}</strong><div class="spatial-inspection">${[['Przeznaczenie Stage',DG.ShipDockDomain.operationMode(s)],['Rząd',s.documentaryOnly?'Pole z dokumentacji przy rampie '+s.documentaryGateId:s.userAdded?'Pole użytkownika':s.simulated?'Pole Masa':s.row==='A'?'Przy rampach':'Po drugiej stronie drogi'],['Wymiary',s.dimensionsMeters.map(v=>v.toFixed(2)).join(' × ')+' m'],['CAD XY',`${s.cadX.toFixed(2)}, ${s.cadY.toFixed(2)}`],['Źródło',s.geometrySource],['Status geometrii',s.documentaryOnly?'Schemat · wymiary i położenie przybliżone':s.userAdded?'Obrys narysowany przez użytkownika':s.simulated?'Układ roboczy · wymiary przybliżone':s.geometrySource==='PROPOSED_STAGE_AT_CAD_GATE'?'Propozycja · położenie i wymiary do korekty':'Obrys z CAD']].map(([k,v])=>`<div class="stat-line"><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`).join('')}</div>`;documentaryDetails(s);objectLocationControls(s);accessControls(s);if(s.userAdded)objectControls(s);}
    function inspectLayoutObject(id){
      const o=(config.layoutObjects||[]).find(o=>o.id===id)||DG.LayoutObjects.areaTargets(model.geometry).find(o=>o.id===id);if(!o)return;
      if(o.kind==='SLOT'){inspectSlot(o.id);return;}if(o.kind==='STAGE'){inspectStage(o.id);return;}
      const b=DG.LayoutObjects.bounds(o.points),scale=base.geometry.unit.cadToMeters;setInspectionContext(o,DG.LayoutObjects.kinds[o.kind],((b[2]-b[0])*scale).toFixed(2).replace('.',',')+' × '+((b[3]-b[1])*scale).toFixed(2).replace('.',',')+' m'+(o.documentaryOnly?' · przybliżone':''));
      $('inspector').innerHTML=`<strong>${esc(o.temporaryId)}</strong><div class="spatial-inspection"><p>${esc(DG.LayoutObjects.kinds[o.kind])} · komora K${esc(o.physicalChamber)}</p><p>Wymiary${o.documentaryOnly?' przybliżone':''}: ${((b[2]-b[0])*scale).toFixed(2)} × ${((b[3]-b[1])*scale).toFixed(2)} m</p></div>`;documentaryDetails(o);objectLocationControls(o);accessControls(o);if(o.id.startsWith('USER-'))objectControls(o);
    }
    function inspectAccessTarget(s){if(s.rackObjectId||s.kind==='SLOT')inspectSlot(s.id);else if(model.geometry.stageAreas.some(a=>a.id===s.id))inspectStage(s.id);else inspectLayoutObject(s.id);}
    let addressFeedback={key:null,text:''};
    function addressControls(container,s,assigned,write,options={}){
      container.addressOptions={values:assigned,notice:addressFeedback.key===s.temporaryId?addressFeedback.text:'',...options,onChange(next){
        write(next);
        addressFeedback={key:s.temporaryId,text:session?'Zmieniono adresy w wersji roboczej.':'Zapisano adresy.'};
        inspectAccessTarget(s);
      }};
    }
    function objectLocationControls(s){
      const assigned=config.objectMappings?.[s.temporaryId]||[],stage=DG.LayoutObjects.shippingStages(model.geometry).some(a=>a.id===s.id);
      $('inspector').insertAdjacentHTML('beforeend','<section class="object-location-tools" data-wms-addresses></section>');
      addressControls($('inspector').querySelector('.object-location-tools'),s,assigned,next=>{
        const objectMappings=DG.LayoutObjects.assignLocations(model.geometry,config,mappingLocations(),s.temporaryId,next.join('|')),nextConfig={...config,objectMappings};
        DG.applyCalibration(base,nextConfig);validateSavedChange(nextConfig);session?.begin();localStorage.setItem('dynamic-gates-spatial-calibration-v1',DG.serializeCalibration(nextConfig,base.calibration));config=nextConfig;refresh();
      },{heading:'Adresy tego obiektu',help:stage?'Dodaj adres WMS Stage’a. Rampa wynika z numeru adresu.':'Każdy adres wskazuje ten sam obiekt. Możesz używać go w teście trasy.',placeholder:stage?'Np. 122B':'Np. KONTROLA-K2 lub ODKLAD-K2-01'});
      if(stage)for(const id of assigned.length?assigned:[s.temporaryId])shipDockDetails(id);
    }
    function objectControls(o){
      $('inspector').insertAdjacentHTML('beforeend','<section class="object-inspector-actions"><p>Obiekt dodany do układu.</p><button id="object-delete" class="button secondary">Usuń dodany obiekt</button><div id="object-delete-status" role="status"></div></section>');
      $('object-delete').onclick=()=>{try{saveLayout((config.layoutObjects||[]).filter(s=>s.id!==o.id),config.layoutCounters||{});inspectionContext=null;objectInspector.reset();$('inspector').innerHTML=`<p>Usunięto ${esc(o.temporaryId)}. Możesz cofnąć zmianę w Edycji.</p>`;}catch(e){$('object-delete-status').textContent=e.message;}};
    }
    function updateObjectDraft(){
      if(!objectDraft)return;const b=DG.LayoutObjects.bounds(objectDraft.object.points),scale=base.geometry.unit.cadToMeters;
      $('object-dimensions').hidden=false;$('object-width').value=((b[2]-b[0])*scale).toFixed(2);$('object-height').value=((b[3]-b[1])*scale).toFixed(2);$('object-confirm').disabled=false;
      $('object-status').textContent=objectDraft.object.temporaryId+' · '+DG.LayoutObjects.kinds[objectDraft.object.kind]+' · obrys do zatwierdzenia.';
    }
    function configureObjectTool(){const pallet=$('object-kind').value==='SLOT';$('object-rotate').hidden=!pallet;$('object-width').readOnly=pallet;$('object-height').readOnly=pallet;$('object-draw-help').textContent=pallet?'Paleta ma 0,8 × 1,2 m. Kliknij na mapie jej dolny lewy narożnik, a następnie zatwierdź. Możesz obrócić ją o 90°.':'Kliknij dwa przeciwległe narożniki na mapie. Wpisz własne wymiary i zatwierdź gotowy obrys.';ribbon.syncMode(interactionMode,!!sketchSelected);}
    function saveLayout(objects,counters,{history=true,restoreMappings={},restoreObjectMappings={},restorePorts=[],objectMappings=config.objectMappings||{},shipdocks=config.shipdocks||{}}={}){
      sketchProtection.assertWritable();
      const nextObjects=DG.LayoutObjects.validate(objects,base.geometry),removed=new Set((config.layoutObjects||[]).filter(o=>!nextObjects.some(n=>n.id===o.id)).map(o=>o.temporaryId));
      const slotMappings={...config.slotMappings},removedMappings={};for(const id of removed){if(slotMappings[id])removedMappings[id]=slotMappings[id];delete slotMappings[id];}
      const removedObjectMappings={},keptObjectMappings={...DG.LayoutObjects.pruneRemoved(base.geometry,{objectMappings}).objectMappings};for(const id of removed){if(config.objectMappings?.[id])removedObjectMappings[id]=config.objectMappings[id];delete keptObjectMappings[id];}
      const owners=new Map(Object.entries({...slotMappings,...keptObjectMappings}).flatMap(([temp,ids])=>ids.map(id=>[id,temp])));
      for(const [temp,ids] of Object.entries(restoreMappings)){if(ids.some(id=>owners.has(id)&&owners.get(id)!==temp))throw Error('Nie można cofnąć: lokalizacja WMS została już przypisana do innego miejsca.');slotMappings[temp]=ids;}
      const nextConfig={...config,shipdocks,layoutObjects:nextObjects,layoutCounters:{...config.layoutCounters,...counters},slotMappings,objectMappings:{}},initialModel=DG.applyCalibration(base,nextConfig),geometry=initialModel.geometry;
      nextConfig.objectMappings=DG.LayoutObjects.validateMappings({...keptObjectMappings,...restoreObjectMappings},geometry,nextConfig,{...mappingLocations(),...initialModel.shipdocks},base.geometry);
      callbacks.validateStageBinding?.(model,DG.applyCalibration(base,nextConfig));
      const removedPorts=(sketch.accessPoints||[]).filter(a=>removed.has(a.targetId)),kept=(sketch.accessPoints||[]).filter(a=>!removed.has(a.targetId)),keys=new Set(kept.map(a=>a.targetId+':'+a.side));
      const nextSketch={...sketch,accessPoints:[...kept,...restorePorts.filter(a=>!keys.has(a.targetId+':'+a.side))]};
      // A new storage area must not cut an existing communication line or access.
      const added=nextObjects.filter(o=>!(config.layoutObjects||[]).some(old=>old.id===o.id));
      for(const o of added){const b=DG.LayoutObjects.bounds(o.points),line=sketch.segments.find(s=>s.enabled!==false&&DG.SketchAccess.hitsLine(s.points,b));if(line)throw Error('Obrys przecina istniejącą linię '+line.id+'. Zmień jego położenie lub wymiary.');}
      const nextIndex=DG.SketchAccess.create(geometry);nextIndex.checkSaved(nextSketch);callbacks.validateOperationalChange?.(engine,new DG.SpatialEngine(DG.applyCalibration(base,nextConfig)).setSketch(nextSketch),sketch,nextSketch);
      validateSavedChange(nextConfig,nextSketch);
      const configKey='dynamic-gates-spatial-calibration-v1',previousConfig=localStorage.getItem(configKey),previousSketch=localStorage.getItem(sketchStorageKey);
      if(localStorage.batch)localStorage.batch(()=>{localStorage.setItem(configKey,DG.serializeCalibration(nextConfig,base.calibration));localStorage.setItem(sketchStorageKey,JSON.stringify(nextSketch));});
      else
      try{localStorage.setItem(configKey,DG.serializeCalibration(nextConfig,base.calibration));if(removedPorts.length||restorePorts.length)localStorage.setItem(sketchStorageKey,JSON.stringify(nextSketch));}catch(e){if(previousConfig==null)localStorage.removeItem(configKey);else localStorage.setItem(configKey,previousConfig);if(previousSketch==null)localStorage.removeItem(sketchStorageKey);else localStorage.setItem(sketchStorageKey,previousSketch);throw Error('Nie udało się zapisać układu lokalnie ('+e.name+'): '+e.message+'. Eksportuj pełną kopię danych.');}
      if(history){layoutHistory.push({objects:config.layoutObjects||[],removedMappings,removedObjectMappings,oldObjectMappings:config.objectMappings||{},oldShipdocks:config.shipdocks||{},removedPorts});if(layoutHistory.length>50)layoutHistory.shift();}
      config=nextConfig;sketch=nextSketch;sketchHistory=sketchHistory.map(s=>({...s,accessPoints:(s.accessPoints||[]).filter(a=>nextIndex.targets.has(a.targetId))}));
      $('object-undo').disabled=!layoutHistory.length;refresh();sketchFeedback();
    }
    $('object-draw').onclick=()=>{const ch=$('object-chamber').value;selectView(ch);sketchMode('object-draw');objectAnchor=null;objectDraft=null;objectHover=null;$('object-confirm').disabled=true;const pallet=$('object-kind').value==='SLOT';$('object-dimensions').hidden=!pallet;if(pallet){$('object-width').value=palletRotated?'1.20':'0.80';$('object-height').value=palletRotated?'0.80':'1.20';}$('object-status').textContent=pallet?'Wskaż dolny lewy narożnik palety.':'Wskaż pierwszy narożnik obiektu.';};
    $('object-chamber').onchange=()=>{sketchMode('pan');selectView($('object-chamber').value);activateWorkspaceTab('edit');};
    $('object-kind').onchange=()=>{sketchMode('pan');configureObjectTool();$('object-status').textContent='Kliknij „'+$('object-draw').textContent+'”, aby dodać wybrany obiekt.';activateWorkspaceTab('edit');};
    $('object-rotate').onclick=()=>{palletRotated=!palletRotated;try{if(objectDraft?.object.kind==='SLOT'){objectDraft=DG.LayoutObjects.placePallet(base.geometry,config.layoutObjects||[],config.layoutCounters||{},objectDraft.object.physicalChamber,objectDraft.object.points[0],palletRotated);updateObjectDraft();render();}else{$('object-width').value=palletRotated?'1.20':'0.80';$('object-height').value=palletRotated?'0.80':'1.20';$('object-status').textContent='Orientacja palety: '+(palletRotated?'1,2 × 0,8 m.':'0,8 × 1,2 m.');}}catch(e){palletRotated=!palletRotated;$('object-status').textContent=e.message;}};
    configureObjectTool();
    for(const id of ['object-width','object-height'])$(id).oninput=()=>{if(!objectDraft)return;try{const b=DG.LayoutObjects.bounds(objectDraft.object.points),scale=base.geometry.unit.cadToMeters,w=Number($('object-width').value),h=Number($('object-height').value);if(w<.05||h<.05)throw Error('Wymiary muszą wynosić minimum 0,05 m.');objectDraft=DG.LayoutObjects.create(base.geometry,config.layoutObjects||[],config.layoutCounters||{},objectDraft.object.kind,objectDraft.object.physicalChamber,[b[0],b[1]],[b[0]+w/scale,b[1]+h/scale]);$('object-confirm').disabled=false;$('object-status').textContent=objectDraft.object.temporaryId+' · obrys do zatwierdzenia.';render();}catch(e){$('object-confirm').disabled=true;$('object-status').textContent=e.message;}};
    $('object-confirm').onclick=()=>{if(!objectDraft)return;try{const draft=objectDraft;saveLayout(draft.objects,draft.counters);sketchMode('pan');$('object-status').textContent='Dodano '+draft.object.temporaryId+'.';inspectLayoutObject(draft.object.id);}catch(e){$('object-status').textContent=e.message;}};
    $('object-cancel').onclick=()=>{sketchMode('pan');$('object-status').textContent='Anulowano dodawanie obiektu.';activateWorkspaceTab('edit');};
    $('object-undo').onclick=()=>{const prior=layoutHistory.at(-1);if(!prior)return;try{saveLayout(prior.objects,config.layoutCounters||{},{history:false,restoreMappings:prior.removedMappings,objectMappings:prior.oldObjectMappings,shipdocks:prior.oldShipdocks,restoreObjectMappings:prior.removedObjectMappings,restorePorts:prior.removedPorts});layoutHistory.pop();$('object-undo').disabled=!layoutHistory.length;sketchMode('pan');$('object-status').textContent='Cofnięto zmianę układu.';activateWorkspaceTab('edit');}catch(e){$('object-status').textContent=e.message;}};
    $('layout-export').onclick=()=>{const a=document.createElement('a'),url=URL.createObjectURL(new Blob([JSON.stringify({version:1,source:base.geometry.source,objects:config.layoutObjects||[],counters:config.layoutCounters||{},objectMappings:config.objectMappings||{},shipdocks:config.shipdocks||{}},null,2)],{type:'application/json'}));a.href=url;a.download='warehouse_layout_objects.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
    $('warehouse-export').onclick=()=>{try{const file=DG.WarehouseBackup.capture(base,config,sketch,localStorage),a=document.createElement('a'),url=URL.createObjectURL(new Blob([JSON.stringify(file,null,2)],{type:'application/json'}));a.href=url;a.download='warehouse_setup_backup.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);$('warehouse-backup-status').textContent='Wyeksportowano pełną kopię Warehouse Setup.';}catch(error){$('warehouse-backup-status').textContent=error.message;}};
    let warehouseImportGeneration=0;
    function warehouseImportStamp(){
      const keys=[...Object.values(DG.WarehouseBackup.keys),DG.STORAGE_KEY,DG.GateSchedule.KEY,DG.AlgorithmSettings.KEY];
      return JSON.stringify([keys.map(key=>[key,localStorage.getItem(key)??null]),session?{active:session.active,dirty:session.dirty,authoritative:root.Desktop.snapshot()}:null]);
    }
    $('warehouse-import').onchange=async event=>{
      const generation=++warehouseImportGeneration,input=event.target,file=input.files[0];if(!file)return;
      try{
        const expected=warehouseImportStamp(),text=await file.text();
        if(generation!==warehouseImportGeneration)return;
        if(expected!==warehouseImportStamp())throw Error('Dane lub wersja robocza zmieniły się podczas odczytu kopii Warehouse Setup. Wczytaj kopię ponownie.');
        const next=DG.WarehouseBackup.prepare(JSON.parse(text),base);
        callbacks.validateOperationalChange?.(engine,new DG.SpatialEngine(DG.applyCalibration(base,next.config)).setSketch(next.sketch),sketch,next.sketch);
        validateSavedChange(next.config,next.sketch,{allowUnreadableSketch:true});
        sketchProtection.replace(()=>DG.WarehouseBackup.store(next,localStorage));
        sketchStorageError='';config=next.config;editHistory=[];layoutEditor.reset();$('layout-edit-undo').disabled=true;sketch=next.sketch;sketchGraph=Sketch.build(sketch.segments);sketchHistory=[];layoutHistory=[];sketchSelected=null;accessPreview=null;resetInspection();sketchMode('pan');refresh();restoreLayers(next.layers);selectView(next.view||'',{renderNow:true});
        $('warehouse-backup-status').textContent='Przywrócono pełną kopię Warehouse Setup.'+(sketch.archivedAccessPoints?.length?' Dostępy w archiwum: '+sketch.archivedAccessPoints.length+'.':'');callbacks.onDomainChanged?.();
      }catch(error){if(generation===warehouseImportGeneration)$('warehouse-backup-status').textContent=error.message;}
      finally{if(generation===warehouseImportGeneration)input.value='';}
    };
    $('layout-import').onchange=async event=>{try{const file=JSON.parse(await event.target.files[0].text());if(file.version!==1||file.source?.sha256!==base.geometry.source.sha256)throw Error('Plik układu nie pasuje do tego planu magazynu.');const counters={...config.layoutCounters};for(const [key,n] of Object.entries(file.counters||{})){if(!/^\d+:(SLOT|AREA|STAGE|MASS|CONTROL|PRINTER|AGV)$/.test(key)||!Number.isSafeInteger(n)||n<1)throw Error('Nieprawidłowe liczniki obiektów.');counters[key]=Math.max(counters[key]||1,n);}saveLayout(file.objects,counters,{objectMappings:file.objectMappings||config.objectMappings||{},shipdocks:file.shipdocks||config.shipdocks||{}});$('layout-backup-status').textContent='Zaimportowano '+file.objects.length+' obiektów. Możesz cofnąć zmianę w Edycji.';}catch(e){$('layout-backup-status').textContent=e.message;}event.target.value='';};
    function accessControls(s){
      accessPreview=null;accessTarget=null;if(interactionMode==='sketch-access')sketchMode('pan');
      const sides={LEFT:'Lewa',RIGHT:'Prawa',TOP:'Górna',BOTTOM:'Dolna'},records=(sketch.accessPoints||[]).filter(a=>a.targetId===s.temporaryId);
      $('inspector').insertAdjacentHTML('beforeend',`<section class="sketch-access-tools"><h4>Dostęp do linii · ${esc(s.temporaryId)}</h4><p>Wybierz stronę pola widoczną na mapie, następnie linię przejazdu.</p><label>Strona <select id="access-side">${Object.entries(sides).map(([id,label])=>`<option value="${id}">${label}</option>`).join('')}</select></label>${s.rackObjectId?'<label><input type="checkbox" id="access-bulk"> Cała strona ciągu regałów</label><p>Cała strona dodaje brakujące dostępy. Zapisane pozostają bez zmian; aby je podmienić, wybierz pojedyncze miejsce.</p>':''}<label><input type="checkbox" id="access-entry" checked> Wjazd do miejsca / stage</label><label><input type="checkbox" id="access-exit" checked> Wyjazd na linię</label><button id="access-pick" class="button secondary">Wskaż linię</button><div id="access-preview-summary" role="status"></div><button id="access-confirm" class="button primary" disabled>Zatwierdź dostęp</button><button id="access-cancel" class="button secondary">Anuluj</button><div class="access-records">${records.map((a,i)=>`<p>${sides[a.side]} · ${esc(a.segmentId)} · ${a.entryAllowed?'wjazd ':''}${a.exitAllowed?'wyjazd':''}<button class="button secondary" data-remove-access="${i}">Usuń dostęp</button></p>`).join('')||'<p>Brak przypisanego dostępu.</p>'}</div><p>Podgląd uwzględnia obrysy regałów, stages i oznaczone przejazdy. Przed zatwierdzeniem sprawdź rzeczywisty przejazd i przeszkody.</p></section>`);
      $('access-pick').onclick=()=>{
        if(!$('access-entry').checked&&!$('access-exit').checked){$('access-preview-summary').textContent='Włącz wjazd lub wyjazd.';return;}
        accessTarget={targetId:s.temporaryId,side:$('access-side').value,bulk:!!$('access-bulk')?.checked,entryAllowed:$('access-entry').checked,exitAllowed:$('access-exit').checked};
        sketchMode('sketch-access');$('access-confirm').disabled=true;$('access-preview-summary').textContent='Kliknij linię przejazdu na mapie.';
      };
      for(const id of ['access-side','access-bulk','access-entry','access-exit'])if($(id))$(id).onchange=()=>{accessPreview=null;accessTarget=null;$('access-confirm').disabled=true;$('access-preview-summary').textContent='Wskaż ponownie linię dla wybranych ustawień.';render();};
      $('access-confirm').onclick=()=>{
        if(!accessPreview?.accepted.length)return;
        const additions=accessPreview.accepted,keys=new Set(additions.map(a=>a.targetId+':'+a.side)),count=additions.length;
        saveSketch({...sketch,accessPoints:[...(sketch.accessPoints||[]).filter(a=>!keys.has(a.targetId+':'+a.side)),...additions]});
        sketchMode('pan');sketchMessage='Zatwierdzono dostęp dla '+count+' pól.';sketchFeedback();
        inspectAccessTarget(s);$('access-preview-summary').textContent=sketchMessage;
      };
      $('access-cancel').onclick=()=>{sketchMode('pan');$('access-confirm').disabled=true;$('access-preview-summary').textContent='Anulowano podgląd.';};
      const list=$('inspector').querySelector('.access-records');list.dataset.accessTarget=s.temporaryId;refreshAccessRecords();
    }
    function refreshAccessRecords(){
      const list=$('inspector').querySelector('.access-records[data-access-target]');if(!list)return;
      const sides={LEFT:'Lewa',RIGHT:'Prawa',TOP:'Górna',BOTTOM:'Dolna'},records=(sketch.accessPoints||[]).filter(a=>a.targetId===list.dataset.accessTarget);
      list.innerHTML=records.map((a,i)=>`<p>${sides[a.side]} · ${esc(a.segmentId)} · ${a.entryAllowed?'wjazd ':''}${a.exitAllowed?'wyjazd':''}<button class="button secondary" data-remove-access="${i}">Usuń dostęp</button></p>`).join('')||'<p>Brak przypisanego dostępu.</p>';
      objectInspector.updateAccess(inspectionAccess());
      list.querySelectorAll('[data-remove-access]').forEach(button=>button.onclick=()=>{const a=records[Number(button.dataset.removeAccess)];saveSketch({...sketch,accessPoints:sketch.accessPoints.filter(b=>b.targetId!==a.targetId||b.side!==a.side)});});
    }
    function nearestSketchLine(xy){
      if(!host.querySelector('[data-layer="sketch"]').checked)return null;
      const tolerance=Math.min(1000,12/pxPerMeter*1000);let best=null,minimum=tolerance;
      for(const s of scoped(sketch.segments,'dynamic')){const q=Sketch.project(xy,...s.points).point,d=Math.hypot(q[0]-xy[0],q[1]-xy[1]);if(d<minimum){best=s;minimum=d;}}
      return best;
    }
    function chooseSketchLine(line){sketchSelected=line?.id||null;sketchAnchor=null;sketchMessage=line?'Wybrano '+line.id+'. Kierunek A/B jest oznaczony na mapie.':'Kliknij bliżej linii lub wybierz jej numer.';render();sketchFeedback();}
    function chooseMergeLine(line){
      if(!line){sketchMessage='Kliknij linię komunikacyjną na mapie.';sketchFeedback();return;}
      if(!sketchSelected){sketchSelected=line.id;sketchMessage='Wybrano '+line.id+'. Wybierz drugą linię na mapie.';render();sketchFeedback();return;}
      if(line.id===sketchSelected){sketchMessage='To ta sama linia. Wybierz inną linię.';sketchFeedback();return;}
      const first=sketchSelected,second=line.id;
      try{
        const cm=Number($('sketch-join-distance').value);if(!Number.isFinite(cm)||cm<1||cm>100)throw Error('Wpisz zasięg przyciągania od 1 do 100 cm.');
        const next=Sketch.mergeSelected(sketch,first,second,cm/100/base.geometry.unit.cadToMeters);accessIndex.checkSaved(next);
        interactionMode='sketch-edit';saveSketch(next,{keepSelection:true});
        sketchMessage=`Scalono ${first} i ${second} w ${first}. Zachowano dostępy i kierunek ruchu. Cofnij przywraca obie linie.`;
      }catch(e){sketchMessage=e.message+' Wybierz inną drugą linię lub anuluj łączenie.';}
      render();sketchFeedback();
    }
    svg.addEventListener('click',event=>{
      if(testPicking){if(!drag?.moved)pickTestObject(event);return;}
      if(interactionMode==='measure'){measureTool.click(cadPoint(event));return;}
      if(drag?.moved||interactionMode==='pan'&&ribbon.isPanOnly())return;const mode=interactionMode,xy=cadPoint(event);if(mode!=='pan'&&!scopedPoint({cadX:xy[0],cadY:xy[1]})){sketchMessage='Kliknij wewnątrz wybranej komory.';sketchFeedback();return;}
      if(mode==='object-draw'){
        if(objectDraft)return;
        if($('object-kind').value==='SLOT'){try{objectDraft=DG.LayoutObjects.placePallet(base.geometry,config.layoutObjects||[],config.layoutCounters||{},$('object-chamber').value,xy,palletRotated);objectHover=null;updateObjectDraft();render();}catch(e){$('object-status').textContent=e.message;}return;}
        if(!objectAnchor){objectAnchor=xy;$('object-status').textContent='Wskaż drugi narożnik.';return;}
        try{objectDraft=DG.LayoutObjects.create(base.geometry,config.layoutObjects||[],config.layoutCounters||{},$('object-kind').value,$('object-chamber').value,objectAnchor,xy);objectHover=null;updateObjectDraft();render();}catch(e){$('object-status').textContent=e.message;}
        return;
      }
      if(mode==='sketch-access'){
        if(!accessTarget){sketchMessage='Wybierz miejsce lub stage i wskaż jego stronę dostępu.';sketchFeedback();return;}
        const line=nearestSketchLine(xy);if(!line){sketchMessage='Kliknij linię przejazdu.';sketchFeedback();return;}
        accessPreview=accessIndex.proposals(accessTarget.targetId,accessTarget.side,line,{...accessTarget,existingAccessPoints:sketch.accessPoints});sketchSelected=line.id;
        $('access-preview-summary').textContent=`${line.id}: ${accessPreview.accepted.length} dostępów do zatwierdzenia · ${accessPreview.preserved.length} zapisanych zachowanych · ${accessPreview.rejected.length} odrzuconych. `+accessPreview.rejected.slice(0,4).map(r=>r.targetId+': '+r.reason).join(' ');
        $('access-confirm').disabled=!accessPreview.accepted.length;sketchMessage='Obejrzyj podgląd łączników i zatwierdź dostęp w inspektorze.';render();sketchFeedback();return;
      }
      if(mode==='sketch-merge'){const hit=event.target.closest('[data-sketch-line]');chooseMergeLine(hit?sketch.segments.find(s=>s.id===hit.dataset.sketchLine):nearestSketchLine(xy));return;}
      if(mode==='sketch-edit'){chooseSketchLine(nearestSketchLine(xy));return;}
      if(mode==='sketch'||mode==='sketch-test'){sketchClick(xy,event);return;}
      if(mode==='pan'&&event.target.closest('[data-sketch-line],[data-sketch-node]')){const hit=event.target.closest('[data-sketch-line]');chooseSketchLine(hit?sketch.segments.find(s=>s.id===hit.dataset.sketchLine):nearestSketchLine(xy));activateWorkspaceTab('edit');return;}
      if(mode==='pan'&&event.target.closest('[data-stage]')){inspectStage(event.target.closest('[data-stage]').dataset.stage);return;}
      if(mode==='pan'&&event.target.closest('[data-layout-object]')){inspectLayoutObject(event.target.closest('[data-layout-object]').dataset.layoutObject);return;}
      if(mode==='pan'){const g=event.target.closest('[data-gate]'),l=event.target.closest('[data-location]'),s=event.target.closest('[data-shipdock]'),n=event.target.closest('[data-node]'),c=event.target.closest('[data-control]'),slot=event.target.closest('[data-cad-slot]');if(slot)inspectSlot(slot.dataset.cadSlot);if(g)inspect('GATE:'+g.dataset.gate);if(l){inspect(l.dataset.location);}if(s)inspect(s.dataset.shipdock);if(n){$('inspector').textContent=JSON.stringify(engine.nodes.get(n.dataset.node));}if(c){const a=model.geometry.controlPoints.find(p=>p.id===c.dataset.control);$('inspector').innerHTML=`<strong>STREFA KONTROLI</strong><p>CAD label: ${esc(a.cadX.toFixed(2))}, ${esc(a.cadY.toFixed(2))}</p><p>${esc(a.mappingSource)}</p><p class="row-warning">Operational boundary: NEEDS_VALIDATION</p>`;}return;}
    });
    svg.addEventListener('keydown',event=>{const g=event.target.closest('[data-gate]');if(g&&['Enter',' '].includes(event.key)){event.preventDefault();inspect('GATE:'+g.dataset.gate);}if(event.key==='+'||event.key==='-'){const f=event.key==='+'?.8:1.25;box=[box[0],box[1],box[2]*f,box[3]*f];render();}});
    svg.addEventListener('wheel',event=>{event.preventDefault();const f=event.deltaY>0?1.15:1/1.15,p=new DOMPoint(event.clientX,event.clientY).matrixTransform(svg.getScreenCTM().inverse());const w=box[2]*f,h=box[3]*f;if(w<5||w>width*10)return;box=[p.x-(p.x-box[0])*f,p.y-(p.y-box[1])*f,w,h];moveView();},{passive:false});
    svg.addEventListener('pointerdown',e=>{if(interactionMode!=='pan')return;drag={x:e.clientX,y:e.clientY,box:[...box],moved:false};if(ribbon.isPanOnly()||!e.target.closest('[data-gate],[data-location],[data-shipdock],[data-node],[data-control],[data-layout-object],[data-cad-slot],[data-stage],[data-sketch-line],[data-sketch-node]'))svg.setPointerCapture(e.pointerId);});
    svg.addEventListener('pointermove',e=>{if(!drag||!svg.hasPointerCapture(e.pointerId))return;const dx=e.clientX-drag.x,dy=e.clientY-drag.y;if(Math.abs(dx)+Math.abs(dy)>5)drag.moved=true;const matrix=svg.getScreenCTM();box=[drag.box[0]-dx/matrix.a,drag.box[1]-dy/matrix.d,drag.box[2],drag.box[3]];moveView();});
    svg.addEventListener('pointerup',e=>{if(svg.hasPointerCapture(e.pointerId))svg.releasePointerCapture(e.pointerId);const released=drag;setTimeout(()=>{if(drag===released)drag=null;},0);});
    host.querySelectorAll('[data-layer]').forEach(el=>el.onchange=()=>{try{localStorage.setItem(layerStorageKey,JSON.stringify(Object.fromEntries([...host.querySelectorAll('[data-layer]')].map(input=>[input.dataset.layer,input.checked]))));}catch(_){}render();});
    function fittedBox(id){const ch=model.geometry.chambers.find(c=>c.id===id);if(!ch)return [-5,-5,width+10,height+10];const p=point(ch.bounds[0],ch.bounds[3]);return [p[0]-4,p[1]-4,(ch.bounds[2]-ch.bounds[0])/1000+8,(ch.bounds[3]-ch.bounds[1])/1000+8];}
    function selectView(id,{reset=false,renderNow=true,preserveTests=false,persistView=true}={}){
      const changed=id!==activeView;
      if(changed&&interactionMode==='measure'){measureTool.setActive(false);interactionMode='pan';}
      if(changed){layoutEditor?.reset();viewBoxes.set(activeView,[...box]);activeView=id;resetInspection();sketchAnchor=null;sketchHover=null;sketchSelected=null;sketchRoute=null;if(!preserveTests)invalidateRouteTest();sketchMessage='';accessPreview=null;accessTarget=null;if(['sketch-access','object-draw','object-edit'].includes(interactionMode)){interactionMode='pan';objectAnchor=null;objectDraft=null;objectHover=null;}}
      $('spatial-chamber-focus').value=id;
      if(id){$('mapping-chamber').value=id;$('object-chamber').value=id;updateMappingStatus();}
      if(changed||reset)box=!reset&&viewBoxes.has(id)?[...viewBoxes.get(id)]:fittedBox(id);
      if(persistView)try{localStorage.setItem(viewStorageKey,id);}catch(_){}
      if(renderNow)render();sketchFeedback();
    }
    $('spatial-fit').onclick=()=>selectView($('spatial-chamber-focus').value,{reset:true});
    $('spatial-chamber-focus').onchange=()=>selectView($('spatial-chamber-focus').value);
    $('mapping-chamber').onchange=()=>selectView(mappingChamber());
    function focusStages(stages){if(!stages.length){$('spatial-stage-status').textContent='Brak obrysów stages w tej komorze.';render();return;}const points=stages.flatMap(s=>s.points),xs=points.map(p=>p[0]),ys=points.map(p=>p[1]),p=point(Math.min(...xs),Math.max(...ys));box=[p[0]-2,p[1]-2,(Math.max(...xs)-Math.min(...xs))/1000+4,(Math.max(...ys)-Math.min(...ys))/1000+4];host.querySelector('[data-layer="stages"]').checked=true;render();}
    $('spatial-stage-show').onclick=()=>{const input=$('spatial-stage-find').value.trim().toUpperCase(),id=/^K\d+-ST-/.test(input)?input:'K'+mappingChamber()+'-ST-'+input.replace(/^([AB])(\d+)$/,(_,row,n)=>row+n.padStart(2,'0')),s=model.geometry.stageAreas.find(s=>s.id===id||s.temporaryId===id);if(!s){$('spatial-stage-status').textContent='Nie znaleziono stage '+input;return;}selectView(s.physicalChamber,{renderNow:false});focusStages([s]);inspectStage(s.id);$('spatial-stage-status').textContent=s.temporaryId;};
    $('spatial-stage-find').onkeydown=e=>{if(e.key==='Enter')$('spatial-stage-show').click();};
    $('spatial-stage-fit').onclick=()=>{selectView(mappingChamber(),{renderNow:false});focusStages(chamberStages());};
    $('spatial-stage-export').onclick=()=>{const a=document.createElement('a'),url=URL.createObjectURL(new Blob([DG.exportSlotCsv({rackSlots:chamberStages().map((s,i)=>({...s,number:i}))})],{type:'text/csv;charset=utf-8'}));a.href=url;a.download='K'+mappingChamber()+'_mapowanie_stages.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
    $('spatial-slot-show').onclick=()=>{const input=$('spatial-slot-find').value.trim().toUpperCase(),id=/^\d+$/.test(input)?'K'+mappingChamber()+'-'+input.padStart(4,'0'):input,s=[...model.geometry.rackSlots,...DG.LayoutObjects.areaTargets(model.geometry)].find(s=>s.temporaryId===id||(config.slotMappings?.[s.temporaryId]||config.objectMappings?.[s.temporaryId])?.includes(id));if(!s){const pending=model.geometry.pendingSourceLocations?.[id];$('spatial-slot-status').textContent=pending?'Adres '+id+' w arkuszu '+pending.sheet+' ('+pending.cells.join(', ')+'): '+pending.reason:model.locations[id]?'Lokalizacja '+id+' nie ma jeszcze przypisanego miejsca na mapie.':'Nie znaleziono miejsca '+id;return;}selectView(s.physicalChamber,{renderNow:false});const b=DG.LayoutObjects.bounds(s.points),p=point((b[0]+b[2])/2,(b[1]+b[3])/2),size=Math.max(8,(b[2]-b[0])/1000+4,(b[3]-b[1])/1000+4);box=[p[0]-size/2,p[1]-size/2,size,size];render();inspectAccessTarget(s);$('spatial-slot-status').textContent=s.temporaryId;};
    $('spatial-slot-find').onkeydown=e=>{if(e.key==='Enter')$('spatial-slot-show').click();};
    $('spatial-slot-export').onclick=()=>{const a=document.createElement('a'),url=URL.createObjectURL(new Blob([DG.exportSlotCsv({rackSlots:chamberSlots()},config.slotMappings)],{type:'text/csv;charset=utf-8'}));a.href=url;a.download='K'+mappingChamber()+'_mapowanie_miejsc.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
    $('spatial-slot-import').onchange=async e=>{try{const mappings=DG.importSlotCsv(await e.target.files[0].text(),model.geometry,base.locations,config.slotMappings,config.objectMappings);saveSlotMappings(mappings);$('spatial-slot-status').textContent='Przypisano WMS do '+Object.keys(config.slotMappings).length+' miejsc. Zapisano lokalnie.';}catch(error){$('spatial-slot-status').textContent=error.message;}e.target.value='';};
    if(config.anchors?.length)host.querySelector('[data-layer="locations"]').checked=true;
    const defaultLayers=Object.fromEntries([...host.querySelectorAll('[data-layer]')].map(input=>[input.dataset.layer,input.checked]));
    function restoreLayers(saved){const layers=saved?JSON.parse(saved):{};if(typeof layers.racks==='boolean')layers.locations=layers.locations===true||layers.racks;host.querySelectorAll('[data-layer]').forEach(input=>{input.checked=typeof layers[input.dataset.layer]==='boolean'?layers[input.dataset.layer]:defaultLayers[input.dataset.layer];});}
    try{restoreLayers(localStorage.getItem(layerStorageKey));}catch(_){}
    let initialView=config.slotMappingRevision?'2':'';
    try{const saved=localStorage.getItem(viewStorageKey);if(saved!==null&&(saved===''||base.geometry.chambers.some(c=>c.id===saved)))initialView=saved;}catch(_){}
    $('spatial-chamber-focus').value=initialView;activeView=initialView;if(initialView)$('object-chamber').value=initialView;
    if(initialView){$('mapping-chamber').value=initialView;const ch=base.geometry.chambers.find(c=>c.id===initialView),p=point(ch.bounds[0],ch.bounds[3]);box=[p[0]-4,p[1]-4,(ch.bounds[2]-ch.bounds[0])/1000+8,(ch.bounds[3]-ch.bounds[1])/1000+8];}
    sketchToggle.onclick=()=>sketchMode(interactionMode==='sketch'?'pan':'sketch');
    sketchEdit.onclick=()=>sketchMode(interactionMode==='sketch-edit'?'pan':'sketch-edit');
    $('sketch-close').onclick=()=>sketchMode('pan');
    $('sketch-close').textContent='Zamknij edycję';
    $('sketch-line-select').onchange=()=>chooseSketchLine(sketch.segments.find(s=>s.id===$('sketch-line-select').value));
    $('sketch-merge-selected').onclick=()=>sketchMode(interactionMode==='sketch-merge'?'pan':'sketch-merge');
    function editSketchLine(patch){if(!sketchSelected)return;try{saveSketch({...sketch,segments:sketch.segments.map(s=>s.id===sketchSelected?{...s,...patch}:s)},{keepSelection:true});}catch(e){sketchMessage=e.message;sketchFeedback();}}
    $('sketch-direction').onchange=()=>editSketchLine({direction:$('sketch-direction').value});
    $('sketch-enabled').onchange=()=>editSketchLine({enabled:$('sketch-enabled').checked});
    function reprojectSketchAccess(segments){
      const lines=new Map(segments.map(s=>[s.id,s])),oldLines=new Map(sketch.segments.map(s=>[s.id,s]));
      return (sketch.accessPoints||[]).map(a=>{const line=lines.get(a.segmentId);if(line?.points===oldLines.get(a.segmentId)?.points)return a;if(!line)throw Error('Linia '+a.segmentId+' ma przypisany dostęp.');const p=accessIndex.proposals(a.targetId,a.side,{...line,enabled:true},a);if(!p.accepted.length)throw Error('Nie można zachować dostępu '+a.targetId+': '+p.rejected[0]?.reason);return {...a,...p.accepted[0]};});
    }
    $('sketch-join').onclick=()=>{
      const cm=Number($('sketch-join-distance').value);if(!Number.isFinite(cm)||cm<1||cm>100){sketchMessage='Wpisz zasięg łączenia od 1 do 100 cm.';sketchFeedback();return;}
      if(!host.querySelector('[data-layer="sketch"]').checked){sketchMessage='Włącz widok ścieżek komunikacyjnych przed łączeniem.';sketchFeedback();return;}
      const bounds=base.geometry.bounds,result=Sketch.joinNearby(sketch.segments,cm/100/base.geometry.unit.cadToMeters,{eligibleIds:scoped(sketch.segments,'dynamic').map(s=>s.id),protectedIds:(sketch.accessPoints||[]).map(a=>a.segmentId),contains:p=>scopedPoint({cadX:p[0],cadY:p[1]})&&p[0]>=bounds[0]&&p[0]<=bounds[2]&&p[1]>=bounds[1]&&p[1]<=bounds[3],canApply:segments=>{try{reprojectSketchAccess(segments);return true;}catch(_){return false;}}});
      if(result.joined){const accessPoints=reprojectSketchAccess(result.segments);sketchAnchor=null;sketchHover=null;saveSketch({...sketch,segments:result.segments,accessPoints});}
      sketchMessage=(result.joined?`Połączono ${result.joined} par końców${result.removedIds.length?'; usunięto '+result.removedIds.length+' krótkich odcinków':''}. Cofnij przywraca poprzedni szkic.`:`Brak końców do połączenia w zasięgu ${cm} cm.`)+(result.skipped?` Pominięto ${result.skipped} par, aby zachować dostępy, zasady ruchu i skrzyżowania.`:'');sketchFeedback();
    };
    $('sketch-end').onclick=()=>{sketchAnchor=null;sketchHover=null;sketchRoute=null;sketchMessage='';if(interactionMode!=='sketch')sketchMode('sketch');else{render();sketchFeedback();}};
    $('sketch-test').onclick=()=>sketchMode('sketch-test');
    $('sketch-ortho').checked=true;$('sketch-ortho').disabled=true;$('sketch-ortho').onchange=()=>{sketchHover=null;render();};
    $('sketch-undo').onclick=()=>{if(!sketchHistory.length)return;const previous=sketchHistory.at(-1);try{saveSketch(previous,{history:false});sketchHistory.pop();sketchAnchor=null;sketchSelected=null;sketchMessage='Cofnięto zmianę szkicu.';}catch(e){sketchMessage=e.message;}sketchFeedback();};
    $('sketch-delete').onclick=()=>{if(sketchSelected){const id=sketchSelected,count=(sketch.accessPoints||[]).filter(a=>a.segmentId===id).length;sketchAnchor=null;saveSketch({...sketch,segments:sketch.segments.filter(s=>s.id!==id),accessPoints:(sketch.accessPoints||[]).filter(a=>a.segmentId!==id)});sketchMessage='Usunięto '+id+(count?' i '+count+' przypisanych dostępów.':'')+' Cofnij przywraca całość.';sketchFeedback();}};
    function invalidateRouteTest(){
      invalidateFit();
      if(!routeRequest)return;routeRequest=null;
      $('route-test-result').removeAttribute('data-state');$('route-test-result').textContent='Dane zmienione. Kliknij „Pokaż trasę”, aby przeliczyć odległość.';
    }
    function showRoutePanel(show){if(show&&interactionMode==='measure')sketchMode('pan');ribbon.showRoute(show);routePanel.hidden=!show;routeToggle.setAttribute('aria-expanded',String(show));}
    routeToggle.onclick=()=>showRoutePanel(routePanel.hidden);
    $('route-close').onclick=()=>showRoutePanel(false);
    $('route-clear').onclick=()=>{stopTestPicking();$('sketch-from').value='';$('sketch-to').value='';routeRequest=null;sketchRoute=null;sketchMessage='';$('route-test-result').removeAttribute('data-state');$('route-test-result').textContent='Wpisz dwie lokalizacje. Możesz użyć też numerów miejsc i stages.';render();sketchFeedback();};
    const changedRouteInput=()=>{sketchRoute=null;sketchMessage='';invalidateRouteTest();render();sketchFeedback();};
    for(const id of ['sketch-from','sketch-to'])$(id).oninput=changedRouteInput;
    $('route-swap').onclick=()=>{const from=$('sketch-from').value;$('sketch-from').value=$('sketch-to').value;$('sketch-to').value=from;changedRouteInput();};
    function fitTestRoute(route,from,to,fitting=false){
      const fromTarget=accessIndex.targets.get(from),toTarget=accessIndex.targets.get(to),ch=model.geometry.chambers.find(c=>c.id===String(fromTarget.physicalChamber));
      const sameChamber=ch&&String(toTarget.physicalChamber)===ch.id&&route.points.every(([x,y])=>x>=ch.bounds[0]&&x<=ch.bounds[2]&&y>=ch.bounds[1]&&y<=ch.bounds[3]);
      selectView(sameChamber?ch.id:'',{renderNow:false,preserveTests:fitting,persistView:false});if(fitting)ribbon.showFitting(true);else ribbon.showRoute(true);
      const p=[...route.points,...fromTarget.points,...toTarget.points].map(x=>point(...x)),xs=p.map(v=>v[0]),ys=p.map(v=>v[1]),x0=Math.min(...xs),y0=Math.min(...ys),x1=Math.max(...xs),y1=Math.max(...ys),rect=svg.getBoundingClientRect();
      const panelHeight=0,availableHeight=Math.max(100,rect.height-panelHeight-100),scale=Math.max(.1,Math.min(Math.max(100,rect.width-100)/Math.max(8,x1-x0),availableHeight/Math.max(8,y1-y0)));
      box=[(x0+x1)/2-rect.width/scale/2,(y0+y1)/2-(rect.height-panelHeight)/scale/2,rect.width/scale,rect.height/scale];
    }
    $('route-test-form').onsubmit=event=>{
      event.preventDefault();stopTestPicking();showRoutePanel(true);
      if(['sketch','sketch-test','sketch-access','sketch-merge'].includes(interactionMode))sketchMode('pan');
      const resolve=input=>{const id=input.trim().toUpperCase();return accessIndex.targets.has(id)?id:model.locations[id]?.temporaryObjectId||model.locations[id]?.temporarySlotId||Object.keys({...config.slotMappings,...config.objectMappings}).find(key=>(config.slotMappings?.[key]||config.objectMappings?.[key]||[]).includes(id))||id;};
      const fromInput=$('sketch-from').value.trim().toUpperCase(),toInput=$('sketch-to').value.trim().toUpperCase(),from=resolve(fromInput),to=resolve(toInput);
      let error='';sketchAnchor=null;sketchRoute=null;
      if(!fromInput||!toInput)error='Wpisz lokalizację początkową i końcową.';
      else for(const [id,input] of [[from,fromInput],[to,toInput]]){const target=accessIndex.targets.get(id);if(!target){error=model.locations[input]?`Lokalizacja ${input} nie ma przypisanego miejsca na planie.`:`Nie znaleziono lokalizacji ${input}. Sprawdź numer lub mapowanie.`;break;}}
      let route=null;
      if(!error)for(const id of [from,to]){const target=accessIndex.targets.get(id);if(target.active===false){error='Obiekt '+id+' jest nieaktywny.';break;}if(target.documentaryOnly&&!target.placementValidated){error='Potwierdź geometrię obiektu '+id+'.';break;}}
      if(!error&&accessValidationError)error='Zapisany dostęp nie pasuje do planu. '+accessValidationError;
      if(!error&&from===to){const b=DG.SketchAccess.box(accessIndex.targets.get(from).points);route={connected:true,lengthMeters:0,points:[[(b[0]+b[2])/2,(b[1]+b[3])/2]]};}
      else if(!error){
        route=Sketch.accessRoute(sketch,from,to,base.geometry.unit.cadToMeters);
        if(!route.connected){
          if(route.reason==='MISSING_ACTIVE_ACCESS'){
            const active=new Set(sketch.segments.filter(s=>s.enabled!==false).map(s=>s.id)),ports=(sketch.accessPoints||[]).filter(a=>a.confirmed&&active.has(a.segmentId));
            error=!ports.some(a=>a.targetId===from&&a.exitAllowed)?`Brak zatwierdzonego, czynnego wyjazdu z ${fromInput}. Przypisz dostęp do włączonej linii.`:`Brak zatwierdzonego, czynnego wjazdu do ${toInput}. Przypisz dostęp do włączonej linii.`;
          }else error='Brak dozwolonej trasy między tymi lokalizacjami. Sprawdź połączenia linii, kierunki i wyłączenia.';
        }else if(!Number.isFinite(route.lengthMeters))error='Brak skali planu do obliczenia odległości w metrach.';
      }
      if(!error){fitTestRoute(route,from,to);sketchRoute=route;}
      routeRequest={from,to};$('route-test-result').dataset.state=error?'error':'success';
      $('route-test-result').innerHTML=error?esc(error):`<strong>Koszt trasy: <span data-distance-meters="${route.lengthMeters}">${route.lengthMeters.toLocaleString('pl-PL',{minimumFractionDigits:2,maximumFractionDigits:2})} m</span></strong><span>${from===to?'To samo miejsce.': 'Najkrótsza trasa w geometrii modelu, wraz z dojazdami do obu miejsc. Wymiary robocze wymagają potwierdzenia pomiarem.'}</span>`;
      sketchMessage=error||`${from} → ${to}: ${route.lengthMeters.toFixed(2)} m${route.fromAccess?' · '+route.fromAccess.side+' → '+route.toAccess.side:''}.`;
      render();sketchFeedback();
    };
    function stopTestPicking(){
      testPicking=null;host.classList.remove('map-test-picking');
      for(const id of ['route-map-pick','route-map-to','fit-map-pick'])$(id).setAttribute('aria-pressed','false');
      for(const id of ['route-pick-stop','fit-pick-stop'])$(id).hidden=true;
      $('route-pick-status').textContent='';$('fit-pick-status').textContent='';
    }
    function startTestPicking(kind){
      $('ribbon-select').click();testPicking=kind;host.classList.add('map-test-picking');
      if(kind==='fit'){ribbon.showFitting(true);$('fit-map-pick').setAttribute('aria-pressed','true');$('fit-pick-stop').hidden=false;$('fit-pick-status').textContent='Klikaj miejsca na mapie. Każde kliknięcie dodaje jedną paletę. Zakończ wybieranie lub naciśnij Escape.';}
      else{showRoutePanel(true);$(kind==='route-from'?'route-map-pick':'route-map-to').setAttribute('aria-pressed','true');$('route-pick-stop').hidden=false;$('route-pick-status').textContent=kind==='route-from'?'Kliknij miejsce początkowe, a następnie końcowe.':'Kliknij miejsce końcowe na mapie.';}
    }
    function eventTestId(event){
      const el=event.target.closest('[data-cad-slot],[data-stage],[data-layout-object],[data-gate],[data-location],[data-shipdock]');if(!el)return '';
      if(el.dataset.gate)return 'GATE:'+el.dataset.gate;if(el.dataset.location)return el.dataset.location;if(el.dataset.shipdock)return el.dataset.shipdock;
      return DG.LayoutObjects.editTargets(model.geometry).find(o=>o.id===(el.dataset.cadSlot||el.dataset.stage||el.dataset.layoutObject))?.temporaryId||'';
    }
    function pickTestObject(event){
      try{const id=eventTestId(event);if(!id)throw Error('Wskaż miejsce lub lokalizację na mapie.');const p=DG.WarehouseTest.point(id,engine,accessIndex,config);
        if(testPicking==='fit'){addFitPoint(p);return;}
        if(testPicking==='route-from'){$('sketch-from').value=p.id;$('sketch-to').value='';testPicking='route-to';$('route-pick-status').textContent='Początek: '+p.id+'. Kliknij miejsce końcowe.';render();return;}
        $('sketch-to').value=p.id;stopTestPicking();$('route-test-form').requestSubmit();
      }catch(e){$(testPicking==='fit'?'fit-pick-status':'route-pick-status').textContent=e.message;}
    }
    function invalidateFit(){
      if(!fitAnalysis&&!fitLines.length)return;fitAnalysis=null;fitLines=[];$('fit-result').removeAttribute('data-state');$('fit-result').textContent='Dane zmienione. Uruchom test dopasowania ponownie.';
    }
    function renderFitPoints(){
      $('fit-point-count').textContent=fitPoints.length+' punktów · '+fitPoints.length+' palet';
      $('fit-points').innerHTML=fitPoints.map(p=>`<li><span>${esc(p.label)}</span><button class="button secondary" type="button" data-fit-remove="${p.key}" aria-label="Usuń punkt ${esc(p.label)}">Usuń</button></li>`).join('');
    }
    function addFitPoint(p){fitPoints.push({id:p.id,label:p.label,key:++fitSequence});invalidateFit();renderFitPoints();render();}
    function testMarkup(){
      let out=fitLines.map(l=>`<polyline class="sketch-route map-fit-route" points="${coords(l.points)}"/>`).join('');
      const selected=fitPoints.map((p,i)=>({...p,label:String(i+1)}));
      if(!routePanel.hidden&&$('sketch-from').value){const p=accessIndex?.targets.get($('sketch-from').value);if(p)selected.push({id:p.temporaryId,label:'Od'});}
      for(const p of selected){const target=accessIndex?.targets.get(p.id);if(!target||!scopedPoint(target))continue;const b=DG.SketchAccess.box(target.points),xy=point((b[0]+b[2])/2,(b[1]+b[3])/2);out+=`<g class="map-test-marker"><circle cx="${xy[0]}" cy="${xy[1]}" r="${7/pxPerMeter}"/><text x="${xy[0]+10/pxPerMeter}" y="${xy[1]-10/pxPerMeter}" font-size="${12/pxPerMeter}">${esc(p.label)}</text></g>`;}
      return out;
    }
    function showFitRoute(shipDockId){
      if(!fitAnalysis)return;const route=DG.WarehouseTest.paths(fitAnalysis,shipDockId),target=engine.getShipDock(shipDockId)?.temporaryObjectId,points=route.lines.flatMap(l=>l.points);
      fitTestRoute({points},fitPoints[0].id,target,true);fitLines=route.lines;$('fit-route-caption').textContent='Wyświetlane trasy: '+target+' · '+shipDockId+' · '+route.cost.toLocaleString('pl-PL',{maximumFractionDigits:2})+' palet·m.';render();
    }
    $('route-map-pick').onclick=()=>startTestPicking('route-from');$('route-map-to').onclick=()=>startTestPicking('route-to');
    $('route-pick-stop').onclick=stopTestPicking;$('fit-pick-stop').onclick=stopTestPicking;
    $('fit-toggle').onclick=()=>{stopTestPicking();if(fitPanel.hidden){sketchMode('pan');ribbon.showFitting(true);}else ribbon.showFitting(false);};
    $('fit-map-pick').onclick=()=>startTestPicking('fit');
    $('fit-source-form').onsubmit=e=>{e.preventDefault();try{addFitPoint(DG.WarehouseTest.point($('fit-source').value,engine,accessIndex,config));$('fit-source').value='';$('fit-pick-status').textContent='Dodano punkt.';}catch(error){$('fit-pick-status').textContent=error.message;}};
    $('fit-points').onclick=e=>{const b=e.target.closest('[data-fit-remove]');if(!b)return;fitPoints=fitPoints.filter(p=>p.key!==Number(b.dataset.fitRemove));invalidateFit();renderFitPoints();render();};
    $('fit-clear').onclick=()=>{stopTestPicking();fitPoints=[];fitAnalysis=null;fitLines=[];renderFitPoints();$('fit-result').textContent='';$('fit-result').removeAttribute('data-state');render();};
    for(const id of ['fit-store','fit-type','fit-priority'])$(id).oninput=()=>{invalidateFit();render();};
    $('fit-form').onsubmit=e=>{
      e.preventDefault();stopTestPicking();fitAnalysis=null;fitLines=[];const result=$('fit-result');
      try{const context=callbacks.getTestContext?callbacks.getTestContext():{};if(accessValidationError)throw Error(accessValidationError);
        const analysis=DG.WarehouseTest.fit({engine,config,points:fitPoints,...context,store:$('fit-store').value,orderType:$('fit-type').value,wmsPriority:$('fit-priority').value});
        const best=analysis.choices[0],label=c=>model.geometry.stageAreas.find(s=>s.temporaryId===engine.getShipDock(c.shipDockId)?.temporaryObjectId)?.displayName||engine.getShipDock(c.shipDockId)?.temporaryObjectId||c.shipDockId;
        const ranking=analysis.choices.map((c,i)=>`<tr><td>${i+1}</td><td><button type="button" class="map-fit-choice" data-fit-stage="${esc(c.shipDockId)}">${esc(label(c))}</button><small>${esc(c.shipDockId)}</small></td><td>${esc(c.physicalGateId)}</td><td>${c.cost.toLocaleString('pl-PL',{maximumFractionDigits:2})}${c.capacityWarning?'<small class="row-warning">Przekroczona pojemność</small>':''}${c.bufferOverlap?'<small class="row-warning">Nakładanie bufora</small>':''}</td></tr>`).join('');
        result.innerHTML=best?`<strong>Najlepszy Stage: ${esc(label(best))} · Gate ${esc(best.physicalGateId)}</strong><p>Łączny koszt: <span data-fit-cost="${best.cost}">${best.cost.toLocaleString('pl-PL',{maximumFractionDigits:2})} palet·m</span> dla ${fitPoints.length} palet. ${best.capacityWarning?'Uwaga: przekroczona pojemność Stage’a.':''}</p><table><thead><tr><th>#</th><th>Stage</th><th>Gate</th><th>palet·m</th></tr></thead><tbody>${ranking}</tbody></table>`:'<strong>Brak dostępnego Stage’a z pełną trasą.</strong>';
        if(analysis.excluded.length){const groups=DG.WarehouseTest.exclusionGroups(analysis);result.insertAdjacentHTML('beforeend',`<details class="map-fit-exclusions"><summary>Pominięte warianty Stage–rampa (${analysis.excluded.length})</summary><p class="map-test-help">To liczba wariantów przydziału, nie brakujących dróg. Warianty tego samego Stage’a i rampy z identycznym powodem są połączone. Dla trasy pokazujemy pierwszy wykryty brak; po poprawce uruchom test ponownie.</p><ul>${groups.map(g=>`<li><strong>${esc(g.stage)}${g.gate?' · Rampa '+esc(g.gate):''}</strong><div>${esc(g.title)}</div>${g.segment?`<div>Odcinek: <strong>${esc(g.segment)}</strong></div>`:''}${g.detail?`<div>${esc(g.detail)}</div>`:''}${g.hint?`<p class="map-test-help">${esc(g.hint)}</p>`:''}<details><summary>Szczegóły · ${g.variants.length} wariantów</summary><small>Adresy Stage’a: ${g.variants.map(esc).join(', ')}<br>Kod: ${esc(g.code)}</small></details></li>`).join('')}</ul></details>`);}
        result.insertAdjacentHTML('beforeend','<p id="fit-route-caption" class="map-test-help"></p><p class="map-test-help">Symulacja wskazanych punktów na aktualnym układzie i zajętości zasobów. Brak rezerwacji i zapisu. Dane operacyjne oraz pomiary dróg wymagają osobnej weryfikacji.</p>');
        if(best){const route=DG.WarehouseTest.paths(analysis,best.shipDockId),points=route.lines.flatMap(l=>l.points);fitTestRoute({points},fitPoints[0].id,engine.getShipDock(best.shipDockId).temporaryObjectId,true);fitLines=route.lines;}
        fitAnalysis=analysis;if(best)$('fit-route-caption').textContent='Wyświetlane trasy: '+label(best)+' · '+best.shipDockId+'.';result.dataset.state=best?'success':'error';render();
      }catch(error){result.dataset.state='error';result.textContent=error.message;render();}
    };
    $('fit-result').onclick=e=>{const b=e.target.closest('[data-fit-stage]');if(b)try{showFitRoute(b.dataset.fitStage);}catch(error){invalidateFit();$('fit-result').textContent=error.message;render();}};
    for(const name of ['dynamic-gates-schedule-change','dynamic-gates-algorithm-settings-change','storage'])root.addEventListener(name,()=>{if(fitAnalysis||fitLines.length){invalidateFit();render();}});

    $('sketch-export').onclick=()=>{const a=document.createElement('a'),url=URL.createObjectURL(new Blob([sketchProtection.isBlocked()?localStorage.getItem(sketchStorageKey):JSON.stringify({...sketch,source:base.geometry.source,cadToMeters:base.geometry.unit.cadToMeters},null,2)],{type:'application/json'}));a.href=url;a.download=sketchProtection.isBlocked()?'warehouse_line_sketch_recovery.json':'warehouse_line_sketch.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
    let sketchImportGeneration=0;
    $('sketch-import').onchange=async event=>{
      const generation=++sketchImportGeneration,input=event.target,file=input.files[0];if(!file)return;
      try{
        const expected=warehouseImportStamp(),text=await file.text();if(generation!==sketchImportGeneration)return;
        if(expected!==warehouseImportStamp())throw Error('Dane lub wersja robocza zmieniły się podczas odczytu szkicu. Wczytaj plik ponownie.');
        const imported=DG.WarehouseBackup.migrateAccess(Sketch.validate(Sketch.pruneTargets(JSON.parse(text),base.geometry.removedObjectIds,base.geometry.rackLayoutReplacements)),model.geometry);
        if(imported.source?.sha256&&imported.source.sha256!==base.geometry.source.sha256)throw Error('Szkic pochodzi z innego planu CAD.');
        const b=base.geometry.bounds;if(imported.segments.some(s=>s.points.some(([x,y])=>x<b[0]||x>b[2]||y<b[1]||y>b[3])))throw Error('Szkic zawiera punkty poza planem magazynu.');
        accessIndex.checkSaved(imported);sketchAnchor=null;const replacingUnreadable=sketchProtection.isBlocked();
        sketchProtection.replace(()=>saveSketch(imported,{allowUnreadableSketch:replacingUnreadable}));sketchMessage='Szkic zaimportowany. Cofnij przywraca poprzedni szkic.';
      }catch(e){if(generation===sketchImportGeneration){sketchMessage=e.message;if(sketchProtection.isBlocked())sketchStorageError='Nie zaimportowano szkicu: '+e.message+'. Oryginalny zapis pozostaje zachowany i zablokowany.';$('ribbon-message').textContent=sketchStorageError||sketchMessage;}}
      finally{if(generation===sketchImportGeneration){input.value='';sketchFeedback();}}
    };
    svg.addEventListener('pointermove',event=>{
      if(interactionMode==='measure'){measureTool.move(cadPoint(event));return;}
      if(interactionMode==='object-draw'&&!objectDraft&&($('object-kind').value==='SLOT'||objectAnchor)){
        const xy=cadPoint(event),pallet=$('object-kind').value==='SLOT',scale=base.geometry.unit.cadToMeters,b=pallet?[xy[0],xy[1],xy[0]+(palletRotated?1.2:.8)/scale,xy[1]+(palletRotated?.8:1.2)/scale]:[Math.min(objectAnchor[0],xy[0]),Math.min(objectAnchor[1],xy[1]),Math.max(objectAnchor[0],xy[0]),Math.max(objectAnchor[1],xy[1])];
        objectHover={points:[[b[0],b[1]],[b[2],b[1]],[b[2],b[3]],[b[0],b[3]]]};const group=$('layout-object-live-preview'),p=point(b[0],b[3]);
        if(group)group.innerHTML=`<polygon class="layout-object-preview" points="${coords(objectHover.points)}"/><text class="layout-preview-label" x="${p[0]}" y="${p[1]-10/pxPerMeter}" font-size="${12/pxPerMeter}">${((b[2]-b[0])*scale).toFixed(2)} × ${((b[3]-b[1])*scale).toFixed(2)} m</text>`;return;
      }
      if(!['sketch','sketch-test'].includes(interactionMode))return;
      const xy=cadPoint(event),preview=$('sketch-preview');if(!preview)return;
      if(!scopedPoint({cadX:xy[0],cadY:xy[1]})){preview.innerHTML='';return;}
      sketchHover=sketchSnap(xy,event);const p=point(...sketchHover.point);
      preview.innerHTML=`${(sketchHover.guides||[]).map(g=>`<polyline class="layout-alignment-guide" points="${coords([g.from,g.to])}"/>`).join('')}${sketchAnchor&&interactionMode==='sketch'?`<polyline class="sketch-preview-line" points="${coords([sketchAnchor,sketchHover.point])}"/>`:''}<circle class="sketch-cursor ${sketchHover.snapped?'snapped':''}" cx="${p[0]}" cy="${p[1]}" r="${(sketchHover.snapped?8:6)/pxPerMeter}"/>${sketchHover.snapped?`<text class="sketch-snap-label" x="${p[0]+12/pxPerMeter}" y="${p[1]-12/pxPerMeter}" font-size="${12/pxPerMeter}">${sketchHover.kind==='alignment'?'Wyrównanie do końca linii':'Połącz z '+esc(sketchHover.segmentId||'punktem')}</text>`:''}`;
    });
    svg.addEventListener('pointerleave',()=>{measureTool.leave();const preview=$('sketch-preview');if(preview)preview.innerHTML='';});
    document.addEventListener('keydown',event=>{if(interactionMode==='measure'&&event.key==='Escape'&&svg.clientWidth&&svg.clientHeight){event.preventDefault();sketchMode('pan');$('ribbon-measure').focus();}});
    document.addEventListener('keydown',event=>{if(!svg.clientWidth||!svg.clientHeight)return;if(testPicking&&event.key==='Escape'){event.preventDefault();stopTestPicking();return;}if(interactionMode==='sketch-merge'){if(event.key==='Escape'){event.preventDefault();sketchMode('pan');sketchMessage='Anulowano łączenie linii.';sketchFeedback();}return;}if(event.target.closest('input,select,textarea,[contenteditable=true]'))return;if(interactionMode==='object-draw'&&event.key==='Escape'){event.preventDefault();$('object-cancel').click();return;}if(['Delete','Backspace'].includes(event.key)&&sketchSelected){event.preventDefault();$('sketch-delete').click();}if(event.key==='Escape'){if(interactionMode==='sketch-access'){sketchMode('pan');return;}sketchAnchor=null;sketchHover=null;sketchSelected=null;sketchMessage='';render();sketchFeedback();}});
    new ResizeObserver(()=>moveView()).observe(svg);
    refresh();sketchFeedback();if(sketchProtection.isBlocked())$('ribbon-message').textContent=sketchStorageError;
    function reloadStored(){
      config=DG.LayoutObjects.pruneRemoved(base.geometry,DG.mergeSourceSlotMappings(JSON.parse(localStorage.getItem('dynamic-gates-spatial-calibration-v1')||JSON.stringify(base.calibration)),base.calibration,base.geometry));
      const empty=()=>({version:1,source:base.geometry.source,cadToMeters:base.geometry.unit.cadToMeters,segments:[],accessPoints:[],nextSegmentNumber:1});
      try{const raw=localStorage.getItem(sketchStorageKey);sketch=raw===null?empty():Sketch.validate(JSON.parse(raw));sketchStorageError='';}
      catch(_){sketch=empty();sketchStorageError=sketchProtection.block();}
      sketchGraph=Sketch.build(sketch.segments);editHistory=[];layoutHistory=[];sketchHistory=[];sketchSelected=null;layoutEditor.reset();resetInspection();sketchMode('pan');refresh();restoreLayers(localStorage.getItem(layerStorageKey));selectView(localStorage.getItem(viewStorageKey)||'',{renderNow:true});
      if(sketchProtection.isBlocked())$('ribbon-message').textContent=sketchStorageError;
    }
    if(session){session.initialized();session.mount(host,{reload:reloadStored,reset:()=>{sketchMode('pan');activateWorkspaceTab('view');},edit:()=>activateWorkspaceTab('edit')});activateWorkspaceTab('view');
      // Explicit modifying controls enter a draft before their handlers run.
      const modifiers='#slot-floor-apply,#slot-floor-mode,#layout-edit-save,#layout-edit-duplicate,#layout-edit-delete,#layout-edit-undo,#object-confirm,#object-undo,#object-delete,#gate-operation-save,#gate-stage-save,#documentary-geometry-confirm,#slot-wms-save,#object-location-save,#access-pick,#access-confirm,[data-remove-access],#sketch-delete,#sketch-undo,#sketch-join,#warehouse-import,#layout-import,#sketch-import,#spatial-slot-import,#sketch-direction,#sketch-enabled';
      host.addEventListener('click',e=>{if(e.target.closest(modifiers))session.begin();},true);
      host.addEventListener('change',e=>{if(e.target.matches(modifiers))session.begin();},true);
    }
    return {update(){if(fitAnalysis||fitLines.length){invalidateFit();render();}if(selected?.startsWith('GATE:'))inspect(selected);},gateStageControls,getModel:()=>model,getEngine:()=>engine};
  };
})(globalThis);
