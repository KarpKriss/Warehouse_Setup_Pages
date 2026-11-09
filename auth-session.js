(function(root){
  'use strict';
  class WarehouseAuth {
    constructor(config,fetcher=(...args)=>fetch(...args)){this.config=config;this.fetcher=fetcher;this.session=null;this.member=null;this.generation=0;}
    async request(path,options={}){
      const r=await this.fetcher(this.config.url+path,{...options,headers:{apikey:this.config.publishableKey,...options.headers},redirect:'error',signal:AbortSignal.timeout(40000)});
      if(!r.ok){let code;try{const e=await r.json();code=e.error;}catch{}const error=Error(code||'REQUEST_FAILED');error.status=r.status;throw error;}return r;
    }
    async login(email,password){
      const generation=++this.generation;this.session=null;this.member=null;
      const token=await(await this.request('/auth/v1/token?grant_type=password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:email.trim(),password})})).json();
      if(generation!==this.generation)throw Error('SESSION_CHANGED');
      if(!token.access_token||!token.user?.id)throw Error('AUTH_FAILED');
      const member=await(await this.request('/functions/v1/warehouse-web/me',{headers:{authorization:'Bearer '+token.access_token}})).json();
      if(generation!==this.generation)throw Error('SESSION_CHANGED');
      if(member.userId!==token.user.id||!['admin','editor','viewer'].includes(member.role))throw Error('ACCESS_DENIED');
      this.session={...token,expiresAt:Date.now()+Number(token.expires_in||3600)*1000};this.member=member;return member;
    }
    async ensure(){
      if(!this.session)throw Error('UNAUTHORIZED');
      if(this.session.expiresAt-Date.now()>60000)return;
      if(!this.refreshing){const generation=this.generation,previous=this.session;this.refreshing=(async()=>{try{
        const token=await(await this.request('/auth/v1/token?grant_type=refresh_token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({refresh_token:previous.refresh_token})})).json();
        if(generation!==this.generation)throw Error('SESSION_CHANGED');if(token.user?.id!==this.member?.userId)throw Error('ACCESS_DENIED');
        this.session={...token,expiresAt:Date.now()+Number(token.expires_in||3600)*1000};
      }finally{this.refreshing=null;}})();}await this.refreshing;
    }
    async call(route,options={}){const generation=this.generation;await this.ensure();const r=await this.request('/functions/v1/warehouse-web/'+route,{...options,headers:{...options.headers,authorization:'Bearer '+this.session.access_token}});if(generation!==this.generation)throw Error('SESSION_CHANGED');return r;}
    async logout(){const token=this.session?.access_token;++this.generation;this.session=null;this.member=null;if(token)try{await this.request('/auth/v1/logout',{method:'POST',headers:{authorization:'Bearer '+token}});}catch{}}
  }
  root.WarehouseAuth=WarehouseAuth;
  if(typeof module!=='undefined')module.exports={WarehouseAuth};
})(globalThis);
