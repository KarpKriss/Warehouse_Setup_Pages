(function(){
  'use strict';
  const auth=new WarehouseAuth(WarehouseWebConfig),form=document.getElementById('login-form'),login=document.getElementById('login'),status=document.getElementById('login-status'),app=document.getElementById('controlroom');
  let heartbeat;
  const hex=bytes=>Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
  const errorMessage=e=>({SOURCE_NOT_READY:'Administrator musi najpierw wczytać bazową mapę.',ACCESS_DENIED:'Konto nie ma aktywnego dostępu do zespołu.',AUTH_FAILED:'Nieprawidłowy e-mail lub hasło.',REQUEST_FAILED:'Nie udało się zalogować lub pobrać danych. Sprawdź e-mail, hasło i połączenie.',SERVICE_UNAVAILABLE:'Usługa jest chwilowo niedostępna.',UNAUTHORIZED:'Sesja wygasła. Zaloguj się ponownie.'}[e.message]||'Operacja nie powiodła się. Spróbuj ponownie.');
  DG.escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  async function loadMap(){
    const r=await auth.call('source');const packed=await r.arrayBuffer();
    if(hex(await crypto.subtle.digest('SHA-256',packed))!==WarehouseWebConfig.gzipSha256)throw Error('INVALID_SOURCE');
    const raw=await new Response(new Blob([packed]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    if(hex(await crypto.subtle.digest('SHA-256',raw))!==WarehouseWebConfig.rawSha256)throw Error('INVALID_SOURCE');
    const base=JSON.parse(new TextDecoder().decode(raw));await DG.EditorLease.ready;
    const prefix='warehouse-web:'+auth.member.userId+':'+WarehouseWebConfig.rawSha256+':';
    const writable=()=>{if(!auth.member||auth.member.role==='viewer')throw Error('Konto ma dostęp tylko do podglądu.');DG.EditorLease.assertWritable();};
    DG.Storage={getItem:k=>localStorage.getItem(prefix+k),setItem(k,v){if(['dynamic-gates-spatial-calibration-v1','dynamic-gates-line-sketch-v1'].includes(k))writable();localStorage.setItem(prefix+k,v);},removeItem(k){writable();localStorage.removeItem(prefix+k);}};
    let view;view=DG.mountSpatialView(base,{inspectGate(id){document.getElementById('inspector').textContent='Rampa '+id;view.gateStageControls(id);}});
    login.hidden=true;app.hidden=false;document.getElementById('logout').hidden=false;
    document.getElementById('web-status').textContent='Zmiany są zapisywane lokalnie dla Twojego konta. Gotowy układ przekaż przez Eksport Warehouse Setup.';
    document.getElementById('header-status').textContent=auth.member.email||'Użytkownik zespołu';
    heartbeat=setInterval(async()=>{try{const member=await(await auth.call('me')).json();if(member.userId!==auth.member?.userId||member.role!==auth.member.role)throw Error('ACCESS_DENIED');}catch{app.hidden=true;clearInterval(heartbeat);await auth.logout();location.reload();}},60000);
  }
  form.onsubmit=async e=>{e.preventDefault();const button=form.querySelector('button');button.disabled=true;status.textContent='Logowanie…';
    try{await auth.login(form.email.value,form.password.value);DG.mountTeamPanel(auth);form.password.value='';status.textContent='Pobieranie mapy…';await loadMap();}
    catch(error){status.textContent=errorMessage(error);if(error.message==='SOURCE_NOT_READY'&&auth.member?.role==='admin')document.getElementById('bootstrap').hidden=false;else{await auth.logout();document.getElementById('bootstrap').hidden=true;}}
    finally{button.disabled=false;}
  };
  document.getElementById('bootstrap-file').onchange=async e=>{const file=e.target.files[0];if(!file)return;const input=e.target;input.disabled=true;status.textContent='Wczytywanie bazowej mapy…';try{await auth.call('bootstrap',{method:'POST',headers:{'Content-Type':'application/gzip'},body:await file.arrayBuffer()});await loadMap();}catch(error){status.textContent=errorMessage(error);}finally{input.disabled=false;input.value='';}};
  DG.setupActivation(auth);
  document.getElementById('logout').onclick=async()=>{app.hidden=true;clearInterval(heartbeat);await auth.logout();location.reload();};
  window.addEventListener('pagehide',()=>clearInterval(heartbeat));
})();
