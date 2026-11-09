(function(root){
  'use strict';
  function distanceMeters(a,b,scale){
    if(![a,b].every(p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite))||!Number.isFinite(scale)||scale<=0)throw new Error('Nieprawidłowe punkty lub skala planu.');
    const distance=Math.hypot(b[0]-a[0],b[1]-a[1])*scale;
    if(!Number.isFinite(distance))throw new Error('Odległość poza zakresem.');
    return distance;
  }
  if(typeof module==='object'&&module.exports)module.exports={distanceMeters};
  if(!root.DG)return;
  root.DG.mountMapMeasure=function({host,svg,point,scale,pixelsPerMeter}){
    const $=id=>document.getElementById(id),format=n=>n.toLocaleString('pl-PL',{minimumFractionDigits:2,maximumFractionDigits:2})+' m';
    let active=false,a=null,b=null,hover=null;
    function status(){
      $('ribbon-measure-details').hidden=!active;
      $('ribbon-measure-status').textContent=!a?'Kliknij punkt A na mapie.':!b?'Kliknij punkt B. Esc kończy pomiar.':'A → B: '+format(distanceMeters(a,b,scale()))+'. Kliknij, aby zacząć kolejny.';
      $('ribbon-measure-clear').disabled=!a;
    }
    function markup(){
      if(!active||!a)return '<g id="map-measure-overlay"></g>';
      const end=b||hover,p=point(...a),q=end?point(...end):null,z=1/Math.max(pixelsPerMeter(),.00001);
      const marker=(p,label)=>`<circle cx="${p[0]}" cy="${p[1]}" r="${10*z}"/><text class="map-measure-point" x="${p[0]}" y="${p[1]}" font-size="${11*z}">${label}</text>`;
      let out=marker(p,'A');
      if(q){const meters=distanceMeters(a,end,scale()),label=format(meters),x=(p[0]+q[0])/2,y=(p[1]+q[1])/2-22*z,w=(label.length*8+24)*z;
        out=`<line x1="${p[0]}" y1="${p[1]}" x2="${q[0]}" y2="${q[1]}" class="${b?'':'map-measure-preview'}"/>`+out+marker(q,'B')+`<rect x="${x-w/2}" y="${y-15*z}" width="${w}" height="${30*z}" rx="${6*z}"/><text class="map-measure-distance" data-distance-meters="${meters}" x="${x}" y="${y}" font-size="${14*z}">${label}</text>`;
      }
      return `<g id="map-measure-overlay" aria-hidden="true">${out}</g>`;
    }
    function paint(){const el=$('map-measure-overlay');if(el)el.outerHTML=markup();else svg.insertAdjacentHTML('beforeend',markup());}
    function reset(){a=null;b=null;hover=null;status();paint();}
    $('ribbon-measure-clear').onclick=reset;
    status();
    return {markup,reset,setActive(value){if(active===value)return;active=value;host.classList.toggle('map-measuring',active);reset();},click(xy){if(!a||b){a=[...xy];b=null;hover=null;}else b=[...xy];status();paint();},move(xy){if(active&&a&&!b){hover=xy;paint();}},leave(){if(active&&!b){hover=null;paint();}}};
  };
})(globalThis);
