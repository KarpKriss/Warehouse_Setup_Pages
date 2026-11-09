(function(root){
  'use strict';
  const EPS=.01,MAX_LINES=2000;
  const distance=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
  const cross=(a,b)=>a[0]*b[1]-a[1]*b[0];
  const sub=(a,b)=>[a[0]-b[0],a[1]-b[1]];
  const pieces=segments=>segments.flatMap(s=>s.points.slice(1).map((p,i)=>({...s,points:[s.points[i],p]})));
  const length=points=>points.slice(1).reduce((sum,p,i)=>sum+distance(points[i],p),0);
  function pruneTargets(value,ids=[],replacements={}){
    const removed=new Set(ids),changed=Object.entries(replacements).filter(([ch,r])=>value?.rackLayoutRevisions?.[ch]!==r.revision);
    const keep=a=>!removed.has(a.targetId)&&!(a.targetKind==='slot'&&changed.some(([ch,r])=>Array.isArray(r.targetIds)?r.targetIds.includes(a.targetId):ch===/^K(\d+)-/.exec(a.targetId)?.[1]));
    if(!Array.isArray(value?.accessPoints)||!changed.length&&value.accessPoints.every(keep))return value;
    const archived=value.accessPoints.filter(a=>!keep(a)).map(access=>({access,reason:'Wycofane pole lub poprzednia geometria regału',revision:'PRUNED_TARGET'}));
    return {...value,accessPoints:value.accessPoints.filter(keep),archivedAccessPoints:[...(value.archivedAccessPoints||[]),...archived],...(changed.length?{rackLayoutRevisions:{...value.rackLayoutRevisions,...Object.fromEntries(changed.map(([ch,r])=>[ch,r.revision]))}}:{})};
  }
  function project(p,...points){let best=null;for(let i=1;i<points.length;i++){const a=points[i-1],b=points[i],dx=b[0]-a[0],dy=b[1]-a[1],d=dx*dx+dy*dy,t=d?Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/d)):0,q=[a[0]+t*dx,a[1]+t*dy];if(!best||distance(p,q)<distance(p,best.point))best={point:q,t,index:i-1};}return best;}
  function validate(value){
    if(value?.version!==1||!Array.isArray(value.segments)||value.segments.length>MAX_LINES)throw Error('Nieprawidłowy plik szkicu linii.');
    const ids=new Set();
    const segments=value.segments.map(s=>{
      if(typeof s.id!=='string'||!/^L\d+$/.test(s.id)||ids.has(s.id))throw Error('Nieprawidłowe lub powtórzone numery odcinków.');
      if(!Array.isArray(s.points)||s.points.length<2||s.points.length>2000||!s.points.every(p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite)))throw Error('Nieprawidłowe współrzędne odcinka.');
      if(s.points.slice(1).some((p,i)=>distance(p,s.points[i])<=EPS))throw Error('Odcinek musi mieć dwa różne końce.');
      if(s.direction!=null&&!['BOTH','FORWARD','REVERSE'].includes(s.direction)||s.enabled!=null&&typeof s.enabled!=='boolean')throw Error('Nieprawidłowe zasady ruchu odcinka.');
      ids.add(s.id);return {id:s.id,points:s.points.map(p=>[...p]),direction:s.direction||'BOTH',enabled:s.enabled!==false};
    });
    const accesses=value.accessPoints||[];
    if(!Array.isArray(accesses)||accesses.length>100000)throw Error('Nieprawidłowe punkty dostępu.');
    const keys=new Set(),accessPoints=accesses.map(a=>{
      if(!a||typeof a.targetId!=='string'||!/^(?:GATE:[A-Z0-9_-]+|K\d+-(?:\d+|XL-\d+|(?:ST|AREA|MASS|CTRL|XD|PRN|AGV)-[\w-]+))$/.test(a.targetId)||!['slot','stage','storage','control','gate','printer','agv'].includes(a.targetKind)||!['LEFT','RIGHT','TOP','BOTTOM'].includes(a.side)||!ids.has(a.segmentId)||![a.point,a.linePoint].every(p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite))||a.confirmed!==true||typeof a.entryAllowed!=='boolean'||typeof a.exitAllowed!=='boolean'||!a.entryAllowed&&!a.exitAllowed)throw Error('Nieprawidłowy punkt dostępu.');
      const key=a.targetId+':'+a.side;if(keys.has(key))throw Error('Powtórzony punkt dostępu.');keys.add(key);
      const line=segments.find(s=>s.id===a.segmentId);if(distance(project(a.linePoint,...line.points).point,a.linePoint)>EPS)throw Error('Punkt dostępu nie leży na wskazanej linii.');
      return {...a,point:[...a.point],linePoint:[...a.linePoint]};
    });
    return {...value,segments,accessPoints,nextSegmentNumber:Math.max(Number.isSafeInteger(value.nextSegmentNumber)?value.nextSegmentNumber:1,1,...segments.map(s=>Number(s.id.slice(1))+1))};
  }
  function add(segments,a,b,nextNumber=1){
    if(distance(a,b)<=EPS)throw Error('Wskaż drugi koniec odcinka.');
    if(Math.abs(a[0]-b[0])>EPS&&Math.abs(a[1]-b[1])>EPS)throw Error('Linia komunikacyjna musi być pionowa lub pozioma.');
    if(segments.length>=MAX_LINES)throw Error('Szkic osiągnął limit 2000 odcinków.');
    if(pieces(segments).some(s=>distance(s.points[0],a)<=EPS&&distance(s.points[1],b)<=EPS||distance(s.points[1],a)<=EPS&&distance(s.points[0],b)<=EPS))return segments;
    const number=Math.max(nextNumber,Math.max(0,...segments.map(s=>Number(s.id.slice(1))))+1);
    return [...segments,{id:'L'+number,points:[[...a],[...b]],direction:'BOTH',enabled:true}];
  }
  function snap(p,segments,tolerance,anchor=null,ortho=false,endpointTolerance=tolerance){
    // An explicit nearby endpoint wins over the orthogonal constraint. Otherwise
    // slightly different axis coordinates create a second point beside the joint.
    let end=null,endDistance=endpointTolerance;
    for(const s of segments)for(const endpoint of s.points){const d=distance(p,endpoint);if(d<=endDistance){endDistance=d;end={point:[...endpoint],snapped:true,segmentId:s.id,kind:'endpoint'};}}
    if(end&&(!anchor||!ortho||Math.abs(end.point[0]-anchor[0])<=EPS||Math.abs(end.point[1]-anchor[1])<=EPS))return end;
    let q=[...p],axis=null;
    if(anchor&&ortho){axis=Math.abs(q[0]-anchor[0])>=Math.abs(q[1]-anchor[1])?1:0;q[axis]=anchor[axis];}
    const acceptable=r=>axis===null||Math.abs(r[axis]-anchor[axis])<=EPS;
    let best=null,minimum=tolerance;
    // Prefer shared ends over a point slightly inside a segment.
    for(const s of segments)for(const endpoint of s.points){const d=distance(q,endpoint);if(acceptable(endpoint)&&d<=minimum){minimum=d;best={point:[...endpoint],snapped:true,segmentId:s.id};}}
    if(best)return best;
    for(const s of pieces(segments)){
      let projected=project(q,...s.points);
      if(axis!==null){const [a,b]=s.points,delta=b[axis]-a[axis];if(Math.abs(delta)>EPS){const t=(anchor[axis]-a[axis])/delta;if(t<0||t>1)continue;projected={point:[a[0]+t*(b[0]-a[0]),a[1]+t*(b[1]-a[1])]};}}
      const d=distance(q,projected.point);if(acceptable(projected.point)&&d<=minimum){minimum=d;best={point:projected.point,snapped:true,segmentId:s.id,kind:'segment'};}
    }
    if(best)return best;
    const guides=[];
    for(let j=0;j<2;j++)if(axis!==j){let nearest=null;for(const s of segments)for(const p of s.points)if(Math.abs(p[j]-q[j])<=tolerance&&(!nearest||Math.abs(p[j]-q[j])<Math.abs(nearest.point[j]-q[j])))nearest={point:p,id:s.id};if(nearest){q[j]=nearest.point[j];guides.push({from:nearest.point,to:[...q],axis:j});}}
    return {point:q,snapped:guides.length>0,kind:guides.length?'alignment':null,guides};
  }
  function joinNearby(segments,tolerance,options={}){
    if(!Number.isFinite(tolerance)||tolerance<=EPS)throw Error('Podaj dodatni zasięg łączenia.');
    const eligible=new Set(options.eligibleIds||segments.map(s=>s.id)),protectedIds=new Set(options.protectedIds||[]),contains=options.contains||(()=>true);
    const key=p=>p[0].toFixed(5)+':'+p[1].toFixed(5),groups=[],byPoint=new Map();
    for(const s of segments)for(const p of s.points){let g=byPoint.get(key(p));if(!g){g={index:groups.length,point:[...p],originals:[[...p]],members:new Set(),active:true};byPoint.set(key(p),g);groups.push(g);}g.members.add(s.id);}
    const pairs=[];
    for(let i=0;i<groups.length;i++)for(let j=i+1;j<groups.length;j++){const d=distance(groups[i].point,groups[j].point);if(d>EPS&&d<=tolerance)pairs.push({a:groups[i],b:groups[j],distance:d});}
    pairs.sort((a,b)=>a.distance-b.distance);
    const graph=build(segments),incident=new Map(graph.nodes.map(n=>[n.id,new Set()]));
    for(const e of graph.edges)for(const id of [e.from,e.to])for(const source of e.segmentIds)incident.get(id).add(source);
    const junctions=graph.nodes.map(n=>({point:n.point,lines:incident.get(n.id)})).filter(n=>n.lines.size>1);
    let current=segments,joined=0,skipped=0;
    const resolve=g=>{while(g.parent)g=g.parent;return g;};
    for(const pair of pairs){
      const a=resolve(pair.a),b=resolve(pair.b);if(a===b||distance(a.point,b.point)>tolerance)continue;
      const members=new Set([...a.members,...b.members]);if([...members].some(id=>!eligible.has(id))||!contains(a.point)||!contains(b.point))continue;
      const supports=g=>pieces(current).filter(s=>g.members.has(s.id)&&s.points.some(p=>distance(p,g.point)<=EPS)&&!(s.points.some(p=>distance(p,a.point)<=EPS)&&s.points.some(p=>distance(p,b.point)<=EPS))).sort((s,t)=>length(t.points)-length(s.points));
      const sa=supports(a),sb=supports(b);let target=sa.length>1?a.point:sb.length>1?b.point:a.point;
      // Preserve the perpendicular straight lines at a nearly matching corner.
      if(sa.length===1&&sb.length===1){const [p,q]=sa[0].points,[r,z]=sb[0].points,u=sub(q,p),v=sub(z,r),den=cross(u,v);if(Math.abs(den)>1e-10*distance(p,q)*distance(r,z)){const t=cross(sub(r,p),v)/den,candidate=[p[0]+t*u[0],p[1]+t*u[1]];if(distance(candidate,a.point)<=tolerance&&distance(candidate,b.point)<=tolerance)target=candidate;}}
      if(!contains(target)||[...a.originals,...b.originals].some(p=>distance(p,target)>tolerance)){skipped++;continue;}
      const replacements=new Map([...a.originals,...b.originals].map(p=>[key(p),target]));replacements.set(key(a.point),target);replacements.set(key(b.point),target);
      const candidate=current.map(s=>{const points=s.points.map(p=>replacements.get(key(p))||p);return points.some((p,i)=>p!==s.points[i])?{...s,points:points.map(p=>[...p])}:s;});
      if(candidate.some((s,i)=>s.points!==current[i].points&&s.points.slice(1).some((p,j)=>Math.abs(p[0]-s.points[j][0])>EPS&&Math.abs(p[1]-s.points[j][1])>EPS))){skipped++;continue;}
      const collapsed=candidate.filter(s=>length(s.points)<=EPS);
      if(collapsed.some(s=>protectedIds.has(s.id)||s.enabled===false||(s.direction||'BOTH')!=='BOTH')){skipped++;continue;}
      const next=candidate.filter(s=>length(s.points)>EPS).map(s=>({...s,points:s.points.filter((p,i)=>!i||distance(p,s.points[i-1])>EPS)})),lines=new Map(next.map(s=>[s.id,s]));
      // Keep pre-existing T junctions and intersections attached after moving ends.
      const broken=junctions.some(j=>{const originalGroup=byPoint.get(key(j.point)),g=originalGroup&&resolve(originalGroup),p=g===a||g===b?target:g?.point||j.point;const participating=[...j.lines].filter(id=>lines.has(id));return participating.length>1&&participating.some(id=>distance(project(p,...lines.get(id).points).point,p)>EPS);});
      if(broken||options.canApply&&!options.canApply(next)){skipped++;continue;}
      a.point=[...target];a.originals.push(...b.originals);a.members=members;b.parent=a;b.active=false;current=next;joined++;
    }
    return {segments:current,joined,skipped,removedIds:segments.filter(s=>!current.some(t=>t.id===s.id)).map(s=>s.id)};
  }
  function mergeSelected(value,firstId,secondId,tolerance=EPS){
    const sketch=validate(value),a=sketch.segments.find(s=>s.id===firstId),b=sketch.segments.find(s=>s.id===secondId);
    if(!a||!b||a===b)throw Error('Wybierz dwie różne linie.');
    if(!Number.isFinite(tolerance)||tolerance<EPS)throw Error('Nieprawidłowy zasięg łączenia.');
    if(a.enabled!==b.enabled)throw Error('Linie mają różny stan ruchu. Ustaw jednakowy stan przed scaleniem.');
    const pairs=[];for(const i of [0,a.points.length-1])for(const j of [0,b.points.length-1])pairs.push({i,j,d:distance(a.points[i],b.points[j])});pairs.sort((x,y)=>x.d-y.d);
    const pair=pairs[0];if(pair.d>tolerance)throw Error('Końce linii są zbyt daleko. Dorysuj odcinek łączący albo zwiększ zasięg.');
    const firstEnd=a.points[pair.i],secondEnd=b.points[pair.j];if(pair.d>EPS&&Math.abs(firstEnd[0]-secondEnd[0])>EPS&&Math.abs(firstEnd[1]-secondEnd[1])>EPS)throw Error('Połączenie musi być pionowe lub poziome. Dorysuj odcinki pod kątem prostym przed scaleniem.');
    const reverseA=pair.i===0,reverseB=pair.j!==0,ap=reverseA?[...a.points].reverse():a.points,bp=reverseB?[...b.points].reverse():b.points;
    const oriented=(s,reverse)=>s.direction==='BOTH'?'BOTH':reverse?(s.direction==='FORWARD'?'REVERSE':'FORWARD'):s.direction;
    const direction=oriented(a,reverseA);if(direction!==oriented(b,reverseB))throw Error('Kierunki ruchu nie tworzą jednej spójnej linii. Popraw kierunki przed scaleniem.');
    const points=[...ap,...(pair.d<=EPS?bp.slice(1):bp)].map(p=>[...p]);
    if(distance(points[0],points.at(-1))<=EPS)throw Error('Nie można scalić zamkniętej pętli w jedną linię.');
    const merged={...a,points,direction},segments=sketch.segments.filter(s=>s.id!==b.id).map(s=>s.id===a.id?merged:s),accessPoints=sketch.accessPoints.map(port=>port.segmentId===b.id?{...port,segmentId:a.id}:port);
    return validate({...sketch,segments,accessPoints});
  }
  function build(segments,anchors=[]){
    segments=pieces(segments);
    const cuts=segments.map(s=>[{t:0,point:s.points[0]},{t:1,point:s.points[1]}]);
    const cut=(i,p)=>{const q=project(p,...segments[i].points);if(distance(q.point,p)<=EPS)cuts[i].push({t:q.t,point:p});};
    for(let i=0;i<segments.length;i++)for(let j=i+1;j<segments.length;j++){
      const [a,b]=segments[i].points,[c,d]=segments[j].points;
      if(Math.min(a[0],b[0])>Math.max(c[0],d[0])+EPS||Math.min(c[0],d[0])>Math.max(a[0],b[0])+EPS||Math.min(a[1],b[1])>Math.max(c[1],d[1])+EPS||Math.min(c[1],d[1])>Math.max(a[1],b[1])+EPS)continue;
      const r=sub(b,a),s=sub(d,c),den=cross(r,s),delta=sub(c,a),lr=distance(a,b),ls=distance(c,d);
      if(Math.abs(den)>1e-12*lr*ls){
        const t=cross(delta,s)/den,u=cross(delta,r)/den;
        if(t>=-EPS/lr&&t<=1+EPS/lr&&u>=-EPS/ls&&u<=1+EPS/ls){const p=[a[0]+Math.max(0,Math.min(1,t))*r[0],a[1]+Math.max(0,Math.min(1,t))*r[1]];cut(i,p);cut(j,p);}
      }else if(Math.abs(cross(delta,r))<=EPS*lr){for(const p of [a,b,c,d]){cut(i,p);cut(j,p);}}
    }
    for(const p of anchors)for(let i=0;i<segments.length;i++)cut(i,p);
    const nodes=[],edges=[],grid=new Map(),edgeIndex=new Map();
    const node=p=>{
      const gx=Math.floor(p[0]/EPS),gy=Math.floor(p[1]/EPS);
      for(let x=gx-1;x<=gx+1;x++)for(let y=gy-1;y<=gy+1;y++)for(const n of grid.get(x+':'+y)||[])if(distance(n.point,p)<=EPS)return n;
      const n={id:'S'+(nodes.length+1),point:[...p]};nodes.push(n);const k=gx+':'+gy,list=grid.get(k)||[];list.push(n);grid.set(k,list);return n;
    };
    for(let i=0;i<segments.length;i++){
      const sorted=cuts[i].sort((a,b)=>a.t-b.t),points=[];
      for(const cut of sorted){const n=node(cut.point);if(points.at(-1)!==n)points.push(n);}
      for(let k=1;k<points.length;k++){
        const a=points[k-1],b=points[k],key=[a.id,b.id].sort().join(':');if(a===b)continue;
        let e=edgeIndex.get(key);
        if(!e){e={from:a.id,to:b.id,lengthCadUnits:distance(a.point,b.point),segmentIds:[],forward:false,reverse:false,enabled:false,approved:false,confidence:'DRAFT'};edges.push(e);edgeIndex.set(key,e);}
        e.segmentIds.push(segments[i].id);
        if(segments[i].enabled!==false){const direction=segments[i].direction||'BOTH',same=e.from===a.id;const f=direction!=='REVERSE',r=direction!=='FORWARD';e.forward||=same?f:r;e.reverse||=same?r:f;e.enabled=true;}
        e.direction=e.forward&&e.reverse?'BOTH':e.forward?'FORWARD':e.reverse?'REVERSE':'CLOSED';
      }
    }
    const adjacency=new Map(nodes.map(n=>[n.id,[]]));
    const weak=new Map(nodes.map(n=>[n.id,[]]));
    for(const e of edges){if(e.forward)adjacency.get(e.from).push({to:e.to,edge:e});if(e.reverse)adjacency.get(e.to).push({to:e.from,edge:e});if(e.enabled){weak.get(e.from).push(e.to);weak.get(e.to).push(e.from);}}
    let components=0;const visited=new Set(),byId=new Map(nodes.map(n=>[n.id,n]));
    for(const n of nodes){if(visited.has(n.id)||!weak.get(n.id).length)continue;components++;const todo=[n.id];while(todo.length){const id=todo.pop();if(visited.has(id))continue;visited.add(id);byId.get(id).component=components;for(const next of weak.get(id))todo.push(next);}}
    return {nodes,edges,adjacency,components};
  }
  function visibleNodes(graph){
    // Keep endpoints and junctions; an internal vertex of one polyline is not a join.
    const incident=new Map(graph.nodes.map(n=>[n.id,{neighbours:new Set(),lines:new Set()}]));
    for(const e of graph.edges)for(const [id,other] of [[e.from,e.to],[e.to,e.from]]){
      const item=incident.get(id);item.neighbours.add(other);for(const line of e.segmentIds)item.lines.add(line);
    }
    return graph.nodes.filter(n=>{const item=incident.get(n.id);return item.neighbours.size!==2||item.lines.size>1;});
  }
  function route(segments,from,to,scale){
    const g=build(segments,[from,to]),start=g.nodes.find(n=>distance(n.point,from)<=EPS),end=g.nodes.find(n=>distance(n.point,to)<=EPS);
    if(!start||!end||!start.component||!end.component)return {connected:false,reason:'POINT_OUTSIDE_ACTIVE_SKETCH'};
    const costs=new Map([[start.id,0]]),previous=new Map(),todo=[start.id],seen=new Set();
    while(todo.length){todo.sort((a,b)=>costs.get(a)-costs.get(b));const id=todo.shift();if(seen.has(id))continue;seen.add(id);if(id===end.id)break;
      for(const e of g.adjacency.get(id)){const cost=costs.get(id)+e.edge.lengthCadUnits;if(cost<(costs.get(e.to)??Infinity)){costs.set(e.to,cost);previous.set(e.to,id);todo.push(e.to);}}
    }
    if(!costs.has(end.id))return {connected:false,reason:'LINES_NOT_CONNECTED'};
    const ids=[end.id];while(ids[0]!==start.id)ids.unshift(previous.get(ids[0]));const byId=new Map(g.nodes.map(n=>[n.id,n]));
    return {connected:true,lengthCadUnits:costs.get(end.id),lengthMeters:Number.isFinite(scale)&&scale>0?costs.get(end.id)*scale:null,points:ids.map(id=>byId.get(id).point)};
  }
  function accessRoute(sketch,from,to,scale){
    const active=new Set(sketch.segments.filter(s=>s.enabled!==false).map(s=>s.id));
    const accesses=(sketch.accessPoints||[]).filter(a=>a.confirmed&&active.has(a.segmentId));
    const exits=accesses.filter(a=>a.targetId===from&&a.exitAllowed),entries=accesses.filter(a=>a.targetId===to&&a.entryAllowed);
    if(!exits.length||!entries.length)return {connected:false,reason:'MISSING_ACTIVE_ACCESS'};
    let best=null;
    for(const exit of exits)for(const entry of entries){const r=route(sketch.segments,exit.linePoint,entry.linePoint,scale);if(!r.connected)continue;const length=r.lengthCadUnits+distance(exit.point,exit.linePoint)+distance(entry.point,entry.linePoint);if(!best||length<best.lengthCadUnits)best={...r,lengthCadUnits:length,lengthMeters:scale>0?length*scale:null,points:[exit.point,...r.points,entry.point],fromAccess:exit,toAccess:entry};}
    return best||{connected:false,reason:'NO_ALLOWED_ROUTE'};
  }
  // One synchronous planning call owns this context. Never cache it globally:
  // the next call must see new line directions, access permissions and geometry.
  function createAccessRouter(sketch){
    const active=new Set(sketch.segments.filter(s=>s.enabled!==false).map(s=>s.id)),accesses=new Map();
    for(const a of sketch.accessPoints||[])if(a.confirmed&&active.has(a.segmentId)){const list=accesses.get(a.targetId)||[];list.push(a);accesses.set(a.targetId,list);}
    let graph,byId,anchorNodes,prepared=false,safeAnchors=[],cachedNodes=0;
    const unsafe=new Set(),trees=new Map(),stats={graphBuilds:0,treeBuilds:0,cachedTrees:0,cachedNodes:0,legacyFallback:false,unsafeAnchors:0,legacyRoutes:0,sharedRoutes:0};
    const key=p=>JSON.stringify(p),tiny=1e-8;
    function prepare(){
      if(prepared)return;
      const base=build(sketch.segments);stats.graphBuilds++;
      const anchors=[...accesses.values()].flat().map(a=>a.linePoint),parts=pieces(sketch.segments),grid=new Map(),unique=[];
      const nearby=p=>{const found=[],gx=Math.floor(p[0]/EPS),gy=Math.floor(p[1]/EPS);for(let x=gx-1;x<=gx+1;x++)for(let y=gy-1;y<=gy+1;y++)found.push(...(grid.get(x+':'+y)||[]));return found;};
      const insert=p=>{const k=Math.floor(p[0]/EPS)+':'+Math.floor(p[1]/EPS),list=grid.get(k)||[];list.push(p);grid.set(k,list);};
      for(const n of base.nodes)insert(n.point);
      // Only safe anchors may subdivide the shared graph. A near-EPS port
      // remains pair-specific, without disabling reuse for unrelated endpoints.
      for(const p of anchors){
        if(unsafe.has(key(p)))continue;
        if(nearby(p).some(q=>{const d=distance(p,q);return d>tiny&&d<=EPS;})||parts.some(s=>{const d=distance(project(p,...s.points).point,p);return d>tiny&&d<=EPS;})){unsafe.add(key(p));continue;}
        if(!nearby(p).some(q=>distance(p,q)<=tiny)){insert(p);unique.push(p);}
      }
      safeAnchors=unique;prepared=true;stats.unsafeAnchors=unsafe.size;stats.legacyFallback=unsafe.size>0;
    }
    function shared(){
      if(graph)return;
      graph=build(sketch.segments,safeAnchors);stats.graphBuilds++;byId=new Map(graph.nodes.map(n=>[n.id,n]));
      const grid=new Map();
      graph.nodes.forEach((n,index)=>{const k=Math.floor(n.point[0]/EPS)+':'+Math.floor(n.point[1]/EPS),list=grid.get(k)||[];list.push({n,index});grid.set(k,list);});
      anchorNodes=new Map();
      for(const list of accesses.values())for(const a of list){const p=a.linePoint,k=key(p);if(unsafe.has(k)||anchorNodes.has(k))continue;let best;
        const gx=Math.floor(p[0]/EPS),gy=Math.floor(p[1]/EPS);
        for(let x=gx-1;x<=gx+1;x++)for(let y=gy-1;y<=gy+1;y++)for(const candidate of grid.get(x+':'+y)||[])if((!best||candidate.index<best.index)&&distance(candidate.n.point,p)<=EPS)best=candidate;
        anchorNodes.set(k,best?.n);
      }
    }
    function tree(start){
      if(trees.has(start)){const result=trees.get(start);trees.delete(start);trees.set(start,result);return result;}
      stats.treeBuilds++;const costs=new Map([[start,0]]),previous=new Map(),queue=[[0,start]],seen=new Set();
      const push=item=>{queue.push(item);let i=queue.length-1;while(i){const parent=(i-1)>>1;if(queue[parent][0]<=item[0])break;queue[i]=queue[parent];i=parent;}queue[i]=item;};
      const pop=()=>{const first=queue[0],last=queue.pop();if(queue.length){let i=0;while(i*2+1<queue.length){let c=i*2+1;if(c+1<queue.length&&queue[c+1][0]<queue[c][0])c++;if(queue[c][0]>=last[0])break;queue[i]=queue[c];i=c;}queue[i]=last;}return first;};
      while(queue.length){const[cost,id]=pop();if(seen.has(id))continue;seen.add(id);for(const e of graph.adjacency.get(id)){const next=cost+e.edge.lengthCadUnits;if(next<(costs.get(e.to)??Infinity)){costs.set(e.to,next);previous.set(e.to,id);push([next,e.to]);}}}
      const result={costs,previous};if(costs.size<=250000){while(trees.size&&(trees.size>=256||cachedNodes+costs.size>250000)){const first=trees.keys().next().value;cachedNodes-=trees.get(first).costs.size;trees.delete(first);}trees.set(start,result);cachedNodes+=costs.size;}stats.cachedTrees=trees.size;stats.cachedNodes=cachedNodes;return result;
    }
    function between(from,to,scale){
      const exits=(accesses.get(from)||[]).filter(a=>a.exitAllowed),entries=(accesses.get(to)||[]).filter(a=>a.entryAllowed);if(!exits.length||!entries.length)return {connected:false,reason:'MISSING_ACTIVE_ACCESS'};
      prepare();let best=null;
      for(const exit of exits)for(const entry of entries){
        if(unsafe.has(key(exit.linePoint))||unsafe.has(key(entry.linePoint))){
          stats.legacyRoutes++;const r=route(sketch.segments,exit.linePoint,entry.linePoint,scale);if(!r.connected)continue;
          const value=r.lengthCadUnits+distance(exit.point,exit.linePoint)+distance(entry.point,entry.linePoint);if(best&&value>=best.lengthCadUnits)continue;
          best={...r,lengthCadUnits:value,lengthMeters:scale>0?value*scale:null,points:[[...exit.point],...r.points.map(p=>[...p]),[...entry.point]],fromAccess:exit,toAccess:entry};continue;
        }
        shared();stats.sharedRoutes++;const start=anchorNodes.get(key(exit.linePoint)),end=anchorNodes.get(key(entry.linePoint));if(!start?.component||!end?.component)continue;const path=tree(start.id);if(!path.costs.has(end.id))continue;const value=path.costs.get(end.id)+distance(exit.point,exit.linePoint)+distance(entry.point,entry.linePoint);if(best&&value>=best.lengthCadUnits)continue;const ids=[end.id];while(ids[0]!==start.id)ids.unshift(path.previous.get(ids[0]));best={connected:true,lengthCadUnits:value,lengthMeters:scale>0?value*scale:null,points:[[...exit.point],...ids.map(id=>[...byId.get(id).point]),[...entry.point]],fromAccess:exit,toAccess:entry};}
      return best||{connected:false,reason:'NO_ALLOWED_ROUTE'};
    }
    return {route:between,stats};
  }
  const api={validate,pruneTargets,add,snap,joinNearby,mergeSelected,length,build,visibleNodes,route,accessRoute,createAccessRouter,project,EPS};
  root.DG=root.DG||{};root.DG.LineSketch=api;
  if(typeof module!=='undefined')module.exports=api;
})(globalThis);
