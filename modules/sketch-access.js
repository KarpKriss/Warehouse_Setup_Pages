(function(root){
  'use strict';
  const Sketch=root.DG?.LineSketch||(typeof require==='function'?require('./line-sketch.js'):null);
  const box=p=>[Math.min(...p.map(v=>v[0])),Math.min(...p.map(v=>v[1])),Math.max(...p.map(v=>v[0])),Math.max(...p.map(v=>v[1]))];
  const inside=(p,b)=>p[0]>=b[0]-.1&&p[0]<=b[2]+.1&&p[1]>=b[1]-.1&&p[1]<=b[3]+.1;
  // Test the open interior, so a connector ending at a rack face is allowed.
  function hits(a,b,bounds){
    const r=[bounds[0]+5,bounds[1]+5,bounds[2]-5,bounds[3]-5];
    if(r[0]>=r[2]||r[1]>=r[3])return false;
    let lo=0,hi=1;
    for(let axis=0;axis<2;axis++){
      const d=b[axis]-a[axis];
      if(Math.abs(d)<.001){if(a[axis]<=r[axis]||a[axis]>=r[axis+2])return false;}
      else{const t1=(r[axis]-a[axis])/d,t2=(r[axis+2]-a[axis])/d;lo=Math.max(lo,Math.min(t1,t2));hi=Math.min(hi,Math.max(t1,t2));if(lo>=hi)return false;}
    }
    return hi>0&&lo<1;
  }
  function create(geometry){
    const footprints=new Map(geometry.footprints.map(r=>[r.id,{...r,bounds:box(r.points)}])),obstacles=[];
    const bands=new Map(),representedRacks=new Set(geometry.rackSlots.map(s=>s.rackObjectId).filter(Boolean));
    for(const slot of geometry.rackSlots)if(slot.floorPassage||slot.active===false){const list=bands.get(slot.rackObjectId)||[];list.push(box(slot.points));bands.set(slot.rackObjectId,list);}
    for(const r of footprints.values()){
      if(!['rack','storage'].includes(r.kind))continue;
      // CAD FACE is a grouping envelope, not another floor-level obstacle.
      // Individual pallet places below define occupied floor and passages.
      // Keep the envelope as metadata for previously confirmed edge ports.
      if(r.kind==='rack'&&representedRacks.has(r.id))continue;
      let parts=[r.bounds];
      for(const hole of bands.get(r.id)||[]){parts=parts.flatMap(b=>{const x1=Math.max(b[0],hole[0]),y1=Math.max(b[1],hole[1]),x2=Math.min(b[2],hole[2]),y2=Math.min(b[3],hole[3]);if(x1>=x2||y1>=y2)return [b];return [[b[0],b[1],x1,b[3]],[x2,b[1],b[2],b[3]],[x1,b[1],x2,y1],[x1,y2,x2,b[3]]].filter(p=>p[2]-p[0]>.1&&p[3]-p[1]>.1);});}
      obstacles.push(...parts.map(bounds=>({id:r.id,bounds})));
    }
    // Active pallet places block through traffic unless their floor is an
    // explicit passage. Upper WMS locations remain attached to the same place.
    // Preserve the separately agreed operational exception for inactive objects.
    for(const s of geometry.rackSlots)if(s.active!==false&&s.floorPassage!==true)obstacles.push({id:s.id,bounds:box(s.points)});
    for(const s of [...geometry.stageAreas,...(geometry.floorAreas||[]),...(geometry.controlAreas||[])])if(s.active!==false&&(!s.documentaryOnly||s.placementValidated))obstacles.push({id:s.id,bounds:box(s.points)});
    // Broad phase only: every candidate still uses the original exact hits test.
    // The index belongs to this geometry instance; a changed layout creates a new one.
    const cellSize=4000,cells=new Map(),large=[];
    for(let i=0;i<obstacles.length;i++){
      const b=obstacles[i].bounds,x1=Math.floor(b[0]/cellSize),y1=Math.floor(b[1]/cellSize),x2=Math.floor(b[2]/cellSize),y2=Math.floor(b[3]/cellSize);
      if(![x1,y1,x2,y2].every(Number.isSafeInteger)||(x2-x1+1)*(y2-y1+1)>4096){large.push(i);continue;}
      for(let x=x1;x<=x2;x++)for(let y=y1;y<=y2;y++){const key=x+':'+y,list=cells.get(key)||[];list.push(i);cells.set(key,list);}
    }
    function nearbyObstacles(points){
      const b=box(points),x1=Math.floor(b[0]/cellSize),y1=Math.floor(b[1]/cellSize),x2=Math.floor(b[2]/cellSize),y2=Math.floor(b[3]/cellSize);
      if(![x1,y1,x2,y2].every(Number.isSafeInteger)||(x2-x1+1)*(y2-y1+1)>4096)return obstacles;
      const ids=new Set(large);
      for(let x=x1;x<=x2;x++)for(let y=y1;y<=y2;y++)for(const i of cells.get(x+':'+y)||[])ids.add(i);
      // Preserve the original first-obstacle diagnostic, independently of grid order.
      return [...ids].sort((a,b)=>a-b).map(i=>obstacles[i]);
    }
    const targets=new Map([...geometry.rackSlots,...geometry.stageAreas,...(geometry.floorAreas||[]),...(geometry.controlAreas||[]),...(geometry.gateAccessTargets||[])].filter(s=>s.temporaryId).map(s=>[s.temporaryId,{...s,targetKind:s.kind==='GATE'?'gate':s.rackObjectId||s.kind==='SLOT'?'slot':s.kind==='CONTROL'?'control':s.kind==='PRINTER'?'printer':s.kind==='AGV'?'agv':['AREA','MASS'].includes(s.kind)?'storage':'stage'}]));
    // CAD may represent a continuous row as many overlapping bay blocks.
    // Group along the long axis, retaining every original parent/slot identity.
    const rowsByChamber=new Map(),rowForTarget=new Map();
    for(const target of targets.values()){
      if(!target.rackObjectId)continue;
      const chamber=String(target.physicalChamber);
      if(!rowsByChamber.has(chamber))rowsByChamber.set(chamber,new Map());
      const parents=rowsByChamber.get(chamber),parent=footprints.get(target.rackObjectId);
      if(!parents.has(target.rackObjectId))parents.set(target.rackObjectId,{id:target.rackObjectId,bounds:parent?.bounds||box(target.points),members:[]});
      parents.get(target.rackObjectId).members.push(target);
    }
    function physicalRow(target){
      if(rowForTarget.has(target.temporaryId))return rowForTarget.get(target.temporaryId);
      const parents=[...(rowsByChamber.get(String(target.physicalChamber))?.values()||[])],first=parents.find(r=>r.id===target.rackObjectId);
      if(!first)return {members:[target],bounds:box(target.points)};
      const along=first.bounds[3]-first.bounds[1]>=first.bounds[2]-first.bounds[0]?1:0,cross=1-along,selected=new Set([first]),queue=[first];
      for(let i=0;i<queue.length;i++){
        const a=queue[i].bounds;
        for(const r of parents){
          if(selected.has(r))continue;
          const b=r.bounds,axis=b[3]-b[1]>=b[2]-b[0]?1:0;
          if(axis!==along||Math.abs(a[cross]-b[cross])>50||Math.abs(a[cross+2]-b[cross+2])>50)continue;
          // Small construction gaps join; an aisle or separate rack does not.
          const gap=Math.max(a[along],b[along])-Math.min(a[along+2],b[along+2]);
          if(gap>250)continue;
          selected.add(r);queue.push(r);
        }
      }
      const members=queue.flatMap(r=>r.members),bounds=[Math.min(...queue.map(r=>r.bounds[0])),Math.min(...queue.map(r=>r.bounds[1])),Math.max(...queue.map(r=>r.bounds[2])),Math.max(...queue.map(r=>r.bounds[3]))],row={members,bounds};
      for(const member of members)rowForTarget.set(member.temporaryId,row);
      return row;
    }
    function candidate(target,side,line,options={}){
      if(!target)return {valid:false,reason:'Nie znaleziono obiektu.'};
      if(!line||line.enabled===false)return {valid:false,reason:'Wskaż linię włączoną do ruchu.'};
      const cell=box(target.points),parent=target.targetKind==='slot'?footprints.get(target.rackObjectId):null,b=parent?.bounds||cell;
      const cx=(cell[0]+cell[2])/2,cy=(cell[1]+cell[3])/2;
      const points={LEFT:[b[0],cy],RIGHT:[b[2],cy],TOP:[cx,b[3]],BOTTOM:[cx,b[1]]},normals={LEFT:[-1,0],RIGHT:[1,0],TOP:[0,1],BOTTOM:[0,-1]};
      if(!points[side])return {valid:false,reason:'Wybierz stronę dostępu.'};
      const gap={LEFT:cell[0]-b[0],RIGHT:b[2]-cell[2],TOP:b[3]-cell[3],BOTTOM:cell[1]-b[1]}[side];
      if(gap>150)return {valid:false,reason:'Miejsce nie leży przy wybranej zewnętrznej stronie regału.'};
      const p=points[side],saved=options.confirmed&&options.linePoint,q=saved&&Math.hypot(...Sketch.project(saved,...line.points).point.map((v,i)=>v-saved[i]))<=Sketch.EPS?[...saved]:Sketch.project(p,...line.points).point,n=normals[side];
      if((q[0]-p[0])*n[0]+(q[1]-p[1])*n[1]<-.1)return {valid:false,reason:'Linia leży po przeciwnej stronie wybranego wejścia.'};
      const ch=geometry.chambers.find(c=>c.id===String(target.physicalChamber));
      if(!ch||!inside(p,ch.bounds)||!inside(q,ch.bounds))return {valid:false,reason:'Dostęp wychodzi poza komorę.'};
      const obstacle=nearbyObstacles([p,q]).find(o=>hits(p,q,o.bounds));
      if(obstacle)return {valid:false,reason:'Łącznik przecina regał lub pole odkładcze: '+obstacle.id};
      return {valid:true,access:{targetId:target.temporaryId,targetKind:target.targetKind,side,point:p,linePoint:q,segmentId:line.id,entryAllowed:options.entryAllowed!==false,exitAllowed:options.exitAllowed!==false,confirmed:true}};
    }
    function proposals(targetId,side,line,options={}){
      const target=targets.get(targetId);
      const row=options.bulk&&target?.rackObjectId?physicalRow(target):null;
      const list=row?row.members.filter(s=>{
        if(s.floorPassage)return false;
        const b=box(s.points),r=row.bounds,gaps={LEFT:b[0]-r[0],RIGHT:r[2]-b[2],TOP:r[3]-b[3],BOTTOM:b[1]-r[1]};
        return gaps[side]<=150;
      }):target?[target]:[];
      const existing=options.bulk?new Map((options.existingAccessPoints||[]).map(a=>[a.targetId+':'+a.side,a])):new Map();
      const accepted=[],rejected=[],preserved=[];
      for(const s of list){
        const saved=existing.get(s.temporaryId+':'+side);
        if(saved){preserved.push(saved);continue;}
        const c=candidate(s,side,line,options);if(c.valid)accepted.push(c.access);else rejected.push({targetId:s.temporaryId,reason:c.reason});
      }
      return {accepted,rejected,preserved};
    }
    const checked=new WeakMap();
    function checkPort(a,lines){
      const line=lines.get(a.segmentId),c=candidate(targets.get(a.targetId),a.side,line&&{...line,enabled:true},a);
      if(!c.valid||a.targetKind!==c.access.targetKind||Math.hypot(c.access.point[0]-a.point[0],c.access.point[1]-a.point[1])>1||Math.hypot(c.access.linePoint[0]-a.linePoint[0],c.access.linePoint[1]-a.linePoint[1])>1)throw Error('Dostęp '+a.targetId+' nie pasuje do aktualnej geometrii. '+(c.reason||''));
      checked.set(a,line.points);
    }
    function checkLines(lines){
      for(const line of lines){if(line.enabled===false)continue;const obstacle=nearbyObstacles(line.points).find(o=>line.points.slice(1).some((p,i)=>hits(line.points[i],p,o.bounds)));if(obstacle)throw Error('Linia '+line.id+' przecina aktywny obiekt '+obstacle.id+'.');}
    }
    function checkChanges(before,next){
      const oldLines=new Map(before.segments.map(s=>[s.id,s])),lines=new Map(next.segments.map(s=>[s.id,s])),changed=new Set();
      for(const line of next.segments){const old=oldLines.get(line.id);if(!old||JSON.stringify(old.points)!==JSON.stringify(line.points)||old.enabled!==line.enabled)changed.add(line.id);}
      checkLines(next.segments.filter(s=>changed.has(s.id)));
      for(const id of oldLines.keys())if(!lines.has(id))changed.add(id);
      const previous=new Map(before.accessPoints.map(a=>[a.targetId+':'+a.side,JSON.stringify(a)]));
      for(const a of next.accessPoints)if(changed.has(a.segmentId)||previous.get(a.targetId+':'+a.side)!==JSON.stringify(a))checkPort(a,lines);
      return next;
    }
    function checkSaved(sketch){
      checkLines(sketch.segments||[]);
      // Recheck imported ports against current geometry; coordinates are never trusted blindly.
      const lines=new Map(sketch.segments.map(s=>[s.id,s]));
      for(const a of sketch.accessPoints||[]){const line=lines.get(a.segmentId);if(line&&checked.get(a)===line.points)continue;checkPort(a,lines);}
      return sketch;
    }
    return {targets,proposals,checkSaved,checkChanges,obstacles};
  }
  const hitsLine=(points,bounds)=>points.slice(1).some((p,i)=>hits(points[i],p,bounds));
  const api={create,hits,hitsLine,box};root.DG=root.DG||{};root.DG.SketchAccess=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
