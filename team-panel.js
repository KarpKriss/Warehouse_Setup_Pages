(function(root){
 'use strict';
 const roles={admin:'Administrator',editor:'Edytor',viewer:'Podgląd'};
 const message=e=>({SELF_UPDATE_DENIED:'Nie możesz zmienić własnego konta ani zaprosić go ponownie.',ADMIN_REQUIRED:'Ta funkcja wymaga uprawnień administratora.',ACCESS_DENIED:'Brak aktywnego dostępu.',INVALID_MEMBER:'Nieprawidłowe konto lub rola.',ACCOUNT_SYNC_REQUIRED:'Rola lub dostęp zostały zapisane, ale konto wymaga dokończenia synchronizacji logowania. Ponów zapis konta.',INVALID_INVITATION:'Sprawdź adres e-mail i rolę.',INVALID_ACTIVATION:'Zaproszenie jest nieprawidłowe albo wygasło. Hasło musi mieć co najmniej 12 znaków.'}[e.message]||'Nie udało się wykonać operacji. Spróbuj ponownie.');
 root.DG.mountTeamPanel=function(auth){
  if(auth.member?.role!=='admin')return;
  const button=document.getElementById('team-open'),panel=document.getElementById('team-panel'),rows=document.getElementById('team-rows'),status=document.getElementById('team-status');
  button.hidden=false;
  const note=text=>status.textContent=text;
  async function load(){note('Wczytywanie kont…');const members=await(await auth.call('members')).json();rows.replaceChildren();
   for(const member of members){const tr=document.createElement('tr');const email=document.createElement('td');email.textContent=member.email;const roleCell=document.createElement('td'),select=document.createElement('select');select.setAttribute('aria-label','Rola '+member.email);for(const [id,label]of Object.entries(roles)){const option=document.createElement('option');option.value=id;option.textContent=label;select.append(option);}select.value=member.role;roleCell.append(select);
    const access=document.createElement('td'),label=document.createElement('label'),enabled=document.createElement('input');enabled.type='checkbox';enabled.checked=member.enabled;enabled.setAttribute('aria-label','Dostęp '+member.email);label.append(enabled,document.createTextNode(' Aktywny'));access.append(label);
    const action=document.createElement('td'),save=document.createElement('button');save.className='button secondary';save.textContent='Zapisz konto';if(member.userId===auth.member.userId){select.disabled=true;enabled.disabled=true;save.disabled=true;save.textContent='Twoje konto';}
    save.onclick=async()=>{save.disabled=true;try{await auth.call('member-update',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId:member.userId,role:select.value,enabled:enabled.checked})});await load();note('Zapisano konto. Użytkownik musi zalogować się ponownie.');}catch(e){note(message(e));}finally{if(member.userId!==auth.member?.userId)save.disabled=false;}};action.append(save);tr.append(email,roleCell,access,action);rows.append(tr);
   }note('Konta zespołu. Uprawnienia dotyczą całego Warehouse Setup.');
  }
  button.onclick=async()=>{panel.hidden=false;document.getElementById('login').hidden=true;document.getElementById('controlroom').hidden=true;try{await load();}catch(e){note(message(e));}};
  document.getElementById('team-close').onclick=()=>{panel.hidden=true;const hasMap=!!document.getElementById('warehouse-map').children.length;document.getElementById('controlroom').hidden=!hasMap;document.getElementById('login').hidden=hasMap;};
  document.getElementById('team-refresh').onclick=async()=>{try{await load();}catch(e){note(message(e));}};
  document.getElementById('team-invite').onsubmit=async e=>{e.preventDefault();const form=e.target,b=form.querySelector('button');b.disabled=true;document.getElementById('invite-result').hidden=true;try{const invitation=await(await auth.call('invites',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:form.email.value.trim(),role:form.role.value})})).json();const link=new URL(location.href);link.search='?activate=1';link.hash=new URLSearchParams({email:invitation.email,code:invitation.code}).toString();document.getElementById('invite-link').value=link.href;document.getElementById('invite-result').hidden=false;note('Utworzono zaproszenie ważne 24 godziny. Przekaż link tej osobie; wiadomość nie jest wysyłana automatycznie.');}catch(error){note(message(error));}finally{b.disabled=false;}};
  document.getElementById('invite-copy').onclick=async()=>{try{await navigator.clipboard.writeText(document.getElementById('invite-link').value);note('Skopiowano link zaproszenia.');}catch{note('Zaznacz link i skopiuj go ręcznie.');}};
 };
 root.DG.setupActivation=function(auth){
  if(new URLSearchParams(location.search).get('activate')!=='1')return;
  const values=new URLSearchParams(location.hash.slice(1));history.replaceState(null,'',location.pathname+'?activate=1');document.getElementById('activation').hidden=false;document.getElementById('login-form').hidden=true;
  const form=document.getElementById('activation-form');form.email.value=values.get('email')||'';form.code.value=values.get('code')||'';
  form.onsubmit=async e=>{e.preventDefault();const status=document.getElementById('activation-status'),b=form.querySelector('button');b.disabled=true;try{if(form.password.value!==form.confirm.value)throw Error('PASSWORD_MISMATCH');await auth.request('/functions/v1/warehouse-web/activate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:form.email.value,code:form.code.value,password:form.password.value})});form.password.value='';form.confirm.value='';form.code.value='';status.textContent='Konto aktywowane. Możesz zalogować się swoim hasłem.';document.getElementById('login-form').hidden=false;form.hidden=true;history.replaceState(null,'',location.pathname);}catch(error){status.textContent=error.message==='PASSWORD_MISMATCH'?'Hasła muszą być takie same.':message(error);}finally{b.disabled=false;}};
 };
})(globalThis);
