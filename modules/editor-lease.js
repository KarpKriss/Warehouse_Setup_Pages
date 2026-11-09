(function(root){
 'use strict';const DG=root.DG=root.DG||{};
 function create(locks,name,{readOnly=false,onChange=()=>{}}={}){
  let owner=false,disposed=false,state='WAITING',releaseHold;let resolveReady;const ready=new Promise(resolve=>resolveReady=resolve);
  const lease={ready,get state(){return state;},canWrite:()=>owner,assertWritable(){if(!owner)throw Error(state==='UNAVAILABLE'?'Brak bezpiecznej blokady edycji w tej przeglądarce. Użyj aplikacji Windows.':'To okno działa w podglądzie. Zamknij inne okno edycji i odśwież to okno.');},dispose(){disposed=true;owner=false;state='RELEASED';resolveReady(false);releaseHold?.();}};
  if(readOnly){state='READ_ONLY_VIEW';resolveReady(false);return lease;}
  if(!locks?.request){state='UNAVAILABLE';resolveReady(false);return lease;}
  lease.pending=locks.request(name,{ifAvailable:true,mode:'exclusive'},async lock=>{if(disposed)return;if(!lock){state='READ_ONLY';resolveReady(false);onChange();return;}owner=true;state='EDITOR';resolveReady(true);onChange();await new Promise(resolve=>releaseHold=resolve);owner=false;state='RELEASED';onChange();}).catch(()=>{owner=false;state='UNAVAILABLE';resolveReady(false);onChange();});
  return lease;
 }
 const api={create};DG.EditorLeaseFactory=api;if(typeof module!=='undefined')module.exports=api;
 if(!root.document)return;
 if(root.Cloud?.mode==='mapping'){DG.EditorLease={ready:Promise.resolve(true),canWrite:()=>!!DG.WarehouseSession?.active,assertWritable(){if(!DG.WarehouseSession?.active)throw Error('Rozpocznij edycję wybranej komory.');}};return;}if(root.Desktop?.snapshot){DG.EditorLease={ready:Promise.resolve(true),canWrite:()=>true,assertWritable(){}};return;}
 const mode=new URLSearchParams(root.location.search).get('mode'),readOnly=['gate-tv','display'].includes(mode),name='dynamic-gates-editor-v1'+(root.location.protocol==='file:'?':'+root.location.pathname:'');
 function show(){if(readOnly)return;const lease=DG.EditorLease,status=document.getElementById('header-status');if(!lease||!status)return;const view=!lease.canWrite();status.textContent=view?'PODGLĄD · EDYCJA W INNYM OKNIE':'EDYCJA · OFFLINE';status.setAttribute('role','status');if(lease.state==='UNAVAILABLE')status.textContent='PODGLĄD · BLOKADA NIEDOSTĘPNA';status.parentElement.classList.toggle('editor-is-readonly',view);if(view&&!document.getElementById('editor-lease-reload')){const button=document.createElement('button');button.id='editor-lease-reload';button.type='button';button.className='editor-lease-reload';button.textContent='Edytuj';button.title='Zamknij inne okno edycji, potem odśwież to okno. Wczytasz bieżący zapis.';button.setAttribute('aria-label','Odśwież i spróbuj włączyć edycję po zamknięciu innego edytora');button.onclick=()=>root.location.reload();status.after(button);}}
 DG.EditorLease=create(root.navigator.locks,name,{readOnly,onChange:show});DG.EditorLease.ready.then(show);
})(globalThis);

