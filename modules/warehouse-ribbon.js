(function(DG){
  'use strict';
  // Rehome the existing controls: their handlers, mapping IDs and persistence stay intact.
  DG.mountWarehouseRibbon=function(host,{onTab,onMode,onZoom,onClose}){
    const $=id=>document.getElementById(id),icons=DG.RibbonIcons;
    const names={view:'Widok',inspector:'Podgląd',edit:'Edycja',filters:'Filtry',tools:'Narzędzia'};
    const ribbon=document.createElement('div');ribbon.className='warehouse-ribbon';ribbon.id='warehouse-ribbon';
    ribbon.innerHTML=`<div class="ribbon-top"><div class="ribbon-tabs" role="tablist" aria-label="Polecenia Warehouse Setup" aria-orientation="horizontal">${Object.entries(names).map(([id,name])=>`<button type="button" id="workspace-tab-${id}" role="tab" aria-controls="ribbon-${id}" aria-selected="false" tabindex="-1" data-ribbon-tab="${id}">${name}</button>`).join('')}</div><div class="ribbon-context"><div id="ribbon-chamber"></div><form id="ribbon-search" role="search">${icons.search}<input id="ribbon-location-search" type="search" aria-label="Szukaj lokalizacji na mapie" placeholder="Szukaj lokalizacji…" autocomplete="off"><button type="submit" aria-label="Pokaż lokalizację">${icons.search}</button></form><button id="ribbon-collapse" type="button" aria-expanded="true" aria-controls="ribbon-commands" aria-label="Zwiń wstążkę" title="Zwiń wstążkę">${icons.collapse}</button></div></div><div id="ribbon-commands">${Object.entries(names).map(([id,name])=>`<section id="ribbon-${id}" role="tabpanel" aria-labelledby="workspace-tab-${id}" aria-label="${name}" hidden></section>`).join('')}</div>`;
    host.querySelector('.workspace-tabs').remove();host.classList.add('has-ribbon');host.lang='pl';host.classList.remove('workspace-panel-open');host.prepend(ribbon);
    $('ribbon-chamber').append($('spatial-chamber-focus'));
    const footer=document.createElement('div');footer.className='ribbon-map-status';footer.innerHTML='<span id="ribbon-message" role="status" aria-live="polite"></span>';
    footer.append($('spatial-view-status'));host.append(footer);$('ribbon-view').append($('spatial-fit'));host.querySelector('.spatial-viewbar').remove();
    const drawer=$('workspace-panel');drawer.hidden=true;drawer.setAttribute('role','region');drawer.setAttribute('aria-labelledby','workspace-panel-title');
    $('workspace-panel-close').textContent='Zamknij';$('workspace-panel-close').setAttribute('aria-label','Zamknij panel właściwości');
    for(const id of ['tools','filters','edit','inspector']){$('workspace-'+id).removeAttribute('role');$('workspace-'+id).removeAttribute('aria-labelledby');}
    let active='edit',drawerKind=null,opener=null,panOnly=false;
    function decorate(button,icon,label){button.innerHTML=icons[icon]+'<span>'+DG.escapeHtml(label)+'</span>';button.classList.add('ribbon-button');button.type='button';}
    function group(tab,label,id){const el=document.createElement('div');el.className='ribbon-group';el.innerHTML=`<div class="ribbon-group-actions" id="${id}"></div><span class="ribbon-group-label">${label}</span>`;$('ribbon-'+tab).append(el);return $(id);}
    function button(parent,id,label,icon,action){const b=document.createElement('button');b.id=id;b.className='button secondary';decorate(b,icon,label);b.onclick=action;parent.append(b);return b;}
    function move(parent,id,icon,label){const b=$(id);if(icon)decorate(b,icon,label);parent.append(b);return b;}
    const choice=group('edit','Wybór','ribbon-choice');
    button(choice,'ribbon-select','Zaznacz','select',()=>{panOnly=false;onMode('pan');closeDrawer();syncMode('pan');});
    button(choice,'ribbon-pan','Przesuń mapę','pan',()=>{panOnly=true;onMode('pan');closeDrawer();syncMode('pan');});
    const lines=group('edit','Linie','ribbon-lines');
    move(lines,'sketch-toggle','draw','Rysuj linię').classList.replace('secondary','primary');
    move(lines,'sketch-merge-selected','merge','Połącz linie');move(lines,'sketch-undo','undo','Cofnij');
    const objects=group('edit','Obiekty','ribbon-objects');
    const kindLabel=$('object-kind').closest('label');objects.append($('object-kind'));kindLabel.remove();$('object-kind').setAttribute('aria-label','Typ nowego obiektu');
    for(const option of $('object-kind').options){option.title=option.text;option.text=option.text.split(' · ')[0];}
    move(objects,'object-draw','add','Dodaj obiekt');button(objects,'layout-edit-toggle','Edytuj obiekt','draw',()=>{});button(objects,'layout-edit-undo','Cofnij obiekt','undo',()=>{}).disabled=true;
    button(choice,'ribbon-measure','Zmierz odległość','dimensions',()=>onMode('measure')).title='Odległość A → B w linii prostej według skali planu';
    const details=document.createElement('div');details.id='ribbon-measure-details';details.hidden=true;details.innerHTML='<span id="ribbon-measure-status" role="status" aria-live="polite"></span><small>Linia prosta · skala planu</small>';host.append(details);
    button(details,'ribbon-measure-clear','Nowy pomiar','undo',()=>{});
    const mode=document.createElement('div');mode.className='ribbon-mode';mode.innerHTML='<span class="ribbon-mode-dot" aria-hidden="true"></span><span id="ribbon-mode-label">Tryb edycji</span>';$('ribbon-edit').append(mode);
    const view=group('view','Nawigacja','ribbon-navigation');move(view,'spatial-fit','fit','Dopasuj widok');
    button(view,'ribbon-zoom-in','Przybliż','zoomIn',()=>onZoom(.8));button(view,'ribbon-zoom-out','Oddal','zoomOut',()=>onZoom(1.25));
    const presentation=group('view','Przestrzeń robocza','ribbon-presentation');button(presentation,'ribbon-properties-view','Właściwości','inspect',()=>openDrawer('inspector'));button(presentation,'ribbon-hide-panel','Ukryj panel','collapse',closeDrawer);
    const preview=group('inspector','Podgląd','ribbon-preview');button(preview,'ribbon-properties','Właściwości obiektu','inspect',()=>openDrawer('inspector'));move(preview,'route-toggle','route','Test trasy');move(preview,'fit-toggle','route','Test dopasowania');
    const previewHelp=document.createElement('p');previewHelp.className='ribbon-help';previewHelp.textContent='Wybierz obiekt na mapie, aby sprawdzić jego adresy, wymiary i dostęp.';$('ribbon-inspector').append(previewHelp);
    const layerLabels={cad:'Plan CAD',chambers:'Granice komór',stages:'Stages',roads:'Drogi modelu',nodes:'Węzły drogi',locations:'Adresy WMS',gates:'Numery ramp',shipdocks:'ShipDocks',control:'Kontrola',printers:'Drukarki',agv:'Pola AGV',sketch:'Linie przejazdu','sketch-access':'Dostępy',mass:'Masa', 'storage-areas':'Pola odkładcze','inactive-objects':'Pokaż nieaktywne'};
    const layerGroups=[['Obiekty',['stages','storage-areas','mass','control','printers','agv','inactive-objects']],['Oznaczenia',['locations','gates','shipdocks']],['Komunikacja',['sketch','sketch-access','roads']],['Plan',['cad','chambers','nodes']]];
    for(const [label,ids] of layerGroups){const g=group('filters',label,'ribbon-layer-'+ids[0]);g.classList.add('ribbon-layer-group');for(const id of ids){const input=host.querySelector(`[data-layer="${id}"]`),label=input.closest('label');label.replaceChildren(input,document.createTextNode(layerLabels[id]));g.append(label);}}
    const editOptions=group('tools','Edycja zaawansowana','ribbon-advanced');move(editOptions,'sketch-edit','select','Wybierz linię');button(editOptions,'ribbon-line-options','Opcje linii','settings',()=>openDrawer('line'));move(editOptions,'object-undo','undo','Cofnij układ');
    const mapping=group('tools','Mapowanie','ribbon-mapping');button(mapping,'ribbon-map-options','Adresy WMS i stages','settings',()=>openDrawer('mapping'));button(mapping,'ribbon-gate-options','Rampy i stages','settings',()=>openDrawer('gates'));
    const backup=group('tools','Kopia Warehouse Setup','ribbon-backup');move(backup,'warehouse-export','download','Eksport Warehouse Setup');
    button(backup,'ribbon-import-backup','Import Warehouse Setup','download',()=>$('warehouse-import').click());
    button(backup,'ribbon-export-options','Pozostałe kopie','settings',()=>openDrawer('backup'));
    const backupScope=document.createElement('p');backupScope.id='ribbon-backup-scope';backupScope.className='ribbon-help';backupScope.textContent='Kopia Warehouse Setup obejmuje tylko układ, mapowania, drogi i filtry. Nie obejmuje Operations, awizacji, ustawień ani historii. Kopia całej aplikacji: Ustawienia → Dane i kopie aplikacji.';$('ribbon-tools').append(backupScope);
    const source=group('tools','Źródła','ribbon-source');button(source,'ribbon-documentation','Dokumentacja i walidacja','inspect',()=>openDrawer('sources'));
    // Empty editor chrome is discarded; contextual fields have one home in the drawer.
    const lineContext=$('sketch-panel'),objectContext=host.querySelector('.object-editor');
    $('workspace-edit').replaceChildren(lineContext,objectContext);$('object-chamber').closest('label').hidden=true;
    $('sketch-endpoint-test').hidden=true;$('fit-panel').hidden=true;$('route-toggle').setAttribute('aria-expanded','false');$('fit-toggle').setAttribute('aria-expanded','false');
    $('spatial-slot-find').setAttribute('aria-label','Adres WMS lub numer miejsca');
    $('spatial-slot-find').placeholder='Adres WMS lub K2-0001';
    $('ribbon-search').onsubmit=event=>{event.preventDefault();const value=$('ribbon-location-search').value.trim();if(!value){$('ribbon-location-search').focus();return;}$('spatial-slot-find').value=value;$('spatial-slot-show').click();$('ribbon-message').textContent=$('spatial-slot-status').textContent;};
    function setTab(id){if(!names[id])return;active=id;for(const key of Object.keys(names)){$('ribbon-'+key).hidden=key!==id;const b=$('workspace-tab-'+key);b.setAttribute('aria-selected',String(key===id));b.tabIndex=key===id?0:-1;}closeDrawer();measure();}
    function focusable(el){return el?.isConnected&&!el.closest('[hidden]')&&!el.disabled&&el.tabIndex>=0&&el.getClientRects().length>0;}
    function openDrawer(kind){const focused=document.activeElement;if(!drawer.contains(focused)&&focusable(focused))opener=focused;else if(!focusable(opener))opener=$('workspace-tab-'+active);drawerKind=kind;drawer.dataset.drawer=kind;drawer.hidden=false;$('workspace-panel-close').innerHTML=kind==='inspector'?DG.RibbonIcons.dismiss:'Zamknij';$('workspace-panel-close').setAttribute('aria-label','Zamknij panel');
      for(const id of ['tools','filters','edit','inspector'])$('workspace-'+id).hidden=true;if($('layout-edit-panel'))$('layout-edit-panel').hidden=true;
      const title={line:'Właściwości i opcje linii',object:'Dodawanie obiektu','object-edit':'Edytuj obiekt',inspector:'Właściwości obiektu',route:'Test trasy',fit:'Test dopasowania',mapping:'Adresy WMS i stages',gates:'Rampy i stages',sources:'Dokumentacja i walidacja',backup:'Kopie i importy układu'};
      $('workspace-panel-title').textContent=title[kind];$('fit-panel').hidden=kind!=='fit';$('fit-toggle').setAttribute('aria-expanded',String(kind==='fit')); 
      if(kind==='line'||kind==='object'){$('workspace-edit').hidden=false;lineContext.hidden=kind!=='line';objectContext.hidden=kind!=='object';}
      else if(kind==='object-edit'){$('layout-edit-panel').hidden=false;}
      else if(kind==='inspector'){$('workspace-inspector').hidden=false;$('inspector').closest('details').open=true;}
      else{$('workspace-tools').hidden=false;const route=kind==='route',test=route||kind==='fit';$('sketch-endpoint-test').hidden=!route;$('route-toggle').setAttribute('aria-expanded',String(route));$('spatial-tools').hidden=test;$('spatial-tools').open=true;
        for(const el of host.querySelector('.spatial-tools-content').children)el.hidden=kind==='mapping'?!el.classList.contains('spatial-slot-tools'):kind==='gates'?!el.classList.contains('gate-management'):kind==='sources'?!['documentary-areas-panel','spatial-validation'].some(c=>el.classList.contains(c)):kind==='backup'?!el.classList.contains('layout-backup'):true;
      }
    }
    function closeDrawer(){const returnFocus=drawer.contains(document.activeElement)||document.activeElement===document.body;drawer.hidden=true;drawerKind=null;$('fit-panel').hidden=true;$('fit-toggle').setAttribute('aria-expanded','false');$('sketch-endpoint-test').hidden=true;$('route-toggle').setAttribute('aria-expanded','false');if(returnFocus)(focusable(opener)?opener:$('workspace-tab-'+active)).focus();}
    function syncMode(current,hasLine=false){const labels={sketch:'Rysowanie linii','sketch-edit':'Wybór linii','sketch-merge':'Łączenie linii','sketch-test':'Test połączenia','sketch-access':'Przypisanie dostępu','object-draw':'Dodawanie obiektu','object-edit':'Edytowanie obiektu',pan:panOnly?'Przesuwanie mapy':'Tryb edycji'};
      $('ribbon-mode-label').textContent=labels[current]||'Tryb edycji';
      $('ribbon-measure').setAttribute('aria-pressed',String(current==='measure'));$('ribbon-measure').classList.toggle('active',current==='measure');
      if(current==='measure'){$('ribbon-mode-label').textContent='Pomiar A → B';closeDrawer();}
      for(const [id,pressed] of [['ribbon-select',current==='pan'&&!panOnly],['ribbon-pan',current==='pan'&&panOnly]]){$(id).setAttribute('aria-pressed',String(pressed));$(id).classList.toggle('active',pressed);}
      decorate($('sketch-toggle'),'draw','Rysuj linię');$('sketch-toggle').classList.toggle('active',current==='sketch');
      decorate($('object-draw'),'add','Dodaj obiekt');$('object-draw').setAttribute('aria-pressed',String(current==='object-draw'));
      $('object-draw').disabled=!$('spatial-chamber-focus').value;$('object-draw').title=$('object-draw').disabled?'Wybierz komorę, aby dodać obiekt.':'Dodaj obiekt w wybranej komorze';
      $('layout-edit-toggle').disabled=!$('spatial-chamber-focus').value;$('layout-edit-toggle').setAttribute('aria-pressed',String(current==='object-edit'));$('layout-edit-toggle').classList.toggle('active',current==='object-edit');host.classList.toggle('map-pan-only',current==='pan'&&panOnly);drawer.dataset.mode=current;
      if(current==='object-edit'&&$('layout-edit-panel')&&drawerKind!=='object-edit')openDrawer('object-edit');
      if(current==='object-draw'&&drawerKind!=='object')openDrawer('object');
      if(['sketch','sketch-edit','sketch-merge','sketch-test'].includes(current)&&drawerKind!=='line')openDrawer('line');
      if(current==='pan'&&hasLine&&drawerKind!=='line')openDrawer('line');
      if(current==='pan'&&!hasLine&&['line','object','object-edit'].includes(drawerKind))closeDrawer();
      if(['line','object'].includes(drawerKind)){lineContext.hidden=drawerKind!=='line';objectContext.hidden=drawerKind!=='object';}
    }
    ribbon.querySelectorAll('[data-ribbon-tab]').forEach(b=>b.onclick=()=>{if($('ribbon-commands').hidden)$('ribbon-collapse').click();onTab(b.dataset.ribbonTab);});
    ribbon.querySelector('.ribbon-tabs').onkeydown=event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const ids=Object.keys(names),i=ids.indexOf(active),next=event.key==='Home'?0:event.key==='End'?ids.length-1:(i+(event.key==='ArrowRight'?1:-1)+ids.length)%ids.length;const b=$('workspace-tab-'+ids[next]);b.click();b.focus();};
    $('workspace-panel-close').onclick=()=>{onClose(drawerKind);closeDrawer();};
    $('ribbon-collapse').onclick=()=>{const collapsed=host.classList.toggle('ribbon-collapsed');$('ribbon-commands').hidden=collapsed;$('ribbon-collapse').setAttribute('aria-expanded',String(!collapsed));$('ribbon-collapse').setAttribute('aria-label',collapsed?'Rozwiń wstążkę':'Zwiń wstążkę');$('ribbon-collapse').title=collapsed?'Rozwiń wstążkę':'Zwiń wstążkę';$('ribbon-collapse').innerHTML=icons[collapsed?'expand':'collapse'];measure();};
    host.addEventListener('keydown',event=>{if(event.key==='Escape'&&!drawer.hidden){event.preventDefault();onClose(drawerKind);closeDrawer();}});
    function measure(){host.style.setProperty('--ribbon-height',(ribbon.offsetHeight+(DG.WarehouseSession?54:0))+'px');}
    const statusObserver=new MutationObserver(records=>{for(const record of records){const el=record.target.nodeType===1?record.target:record.target.parentElement;if(el?.textContent)$('ribbon-message').textContent=el.textContent;}});
    for(const id of ['warehouse-backup-status','layout-backup-status'])statusObserver.observe($(id),{childList:true,characterData:true,subtree:true});
    for(const label of host.querySelectorAll('label[for]')){const input=$(label.htmlFor);if(input?.type!=='file')continue;const b=document.createElement('button');b.type='button';b.className=label.className;b.textContent=label.textContent;b.onclick=()=>input.click();label.replaceWith(b);input.hidden=true;}
    new ResizeObserver(measure).observe(ribbon);setTab('edit');syncMode('pan');
    return {setTab,openDrawer,closeDrawer,syncMode,isPanOnly:()=>panOnly,clearInspection(){if(drawerKind==='inspector')closeDrawer();$('ribbon-message').textContent='';},showFitting(show){if(show){setTab('inspector');openDrawer('fit');}else closeDrawer();},showRoute(show){if(show){setTab('inspector');openDrawer('route');}else closeDrawer();}};
  };
})(DG);
