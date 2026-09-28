const test=require('node:test');const assert=require('node:assert/strict');
const {Swarm,SWARM}=require('../src/orb-renderer.js');
const mean=w=>{let s=0;for(let i=0;i<w.count;i++){const a=i*3;s+=Math.hypot(w.pos[a],w.pos[a+1],w.pos[a+2]);}return s/w.count;};
const run=(state,sec,bass=0,mid=0,n=600)=>{const w=new Swarm(n);w.setState(state);for(let i=0;i<sec*60;i++)w.step(1/60,bass,mid);return w;};

test('swarm is deterministic for the same history',()=>{const a=run('idle',3),b=run('idle',3);assert.deepEqual(Array.from(a.pos.slice(0,30)),Array.from(b.pos.slice(0,30)));});
test('speaking tightens the cloud relative to idle',()=>{assert.ok(mean(run('speaking',30))<mean(run('idle',30))-.08);});
test('long idle keeps a filled, bounded volume',()=>{const w=run('idle',120);assert.ok(mean(w)>.5&&w.bounds()<1.1);});
test('played bass pushes outward only while speaking, and stays bounded',()=>{
 assert.ok(mean(run('speaking',15,.8,.4))>mean(run('speaking',15))+.1);
 assert.ok(Math.abs(mean(run('idle',15,.8,.4))-mean(run('idle',15)))<1e-9);
 assert.ok(run('speaking',60,1,1).bounds()<1.25);});
test('electrons only mark pending work or an explicit pulse',()=>{
 assert.equal(run('speaking',10).electrons.length,0);assert.equal(run('idle',10).electrons.length,0);
 assert.ok(run('connecting',10).electrons.length>0);
 const w=run('idle',2);w.pulse();w.step(1/60);assert.equal(w.electrons.length,1);});
test('state change triggers a decaying tumble on top of the resting turn',()=>{const w=run('idle',1);const before=w.spinY;w.setState('listening');for(let i=0;i<60;i++)w.step(1/60);const mid=w.spinY-before-w.cur.rate;for(let i=0;i<600;i++)w.step(1/60);const later=w.spinY;for(let i=0;i<60;i++)w.step(1/60);assert.ok(mid>.3&&w.spinY-later-w.cur.rate<mid*.2);});
test('no motif exposes a wave or propagation radius',()=>{for(const m of Object.values(SWARM))for(const k of Object.keys(m))assert.ok(!/wave|ring|propag/i.test(k));});
test('invalid input stays finite',()=>{const w=new Swarm(300);w.setState('bogus');for(let i=0;i<30;i++)w.step(NaN,NaN,Infinity);w.step(1/60,-5,99);assert.ok(Array.from(w.pos).every(Number.isFinite));});
test('the body keeps turning at rest, faster when listening, slower while speaking',()=>{
 const turn=st=>{const w=run(st,20);const a=w.spinY;for(let i=0;i<600;i++)w.step(1/60);return w.spinY-a;};
 const idle=turn('idle'),listen=turn('listening'),speak=turn('speaking');
 assert.ok(idle>1.5&&idle<2.3,'idle ~0.18 rad/s');assert.ok(listen>idle&&speak<idle);});
test('it wanders around the stage within bounds',()=>{const w=new Swarm(300);let mx=0,my=0,moved=0;
 for(let i=0;i<60*120;i++){w.step(1/60);mx=Math.max(mx,Math.abs(w.offX));my=Math.max(my,Math.abs(w.offY));if(i===60)moved=w.offX;}
 assert.ok(mx>.03&&mx<.06&&my<.05);assert.notEqual(moved,w.offX);});
test('a click makes the body flinch, spin and spark, then it re-forms bounded',()=>{const w=run('idle',10);const before=mean(w),spin=w.spinY;
 w.poke(.5,-.2);for(let i=0;i<20;i++)w.step(1/60);assert.ok(mean(w)>before+.03,'scatters');assert.ok(w.spinY-spin>.12,'spin kick');assert.ok(w.electrons.length>=3,'spark flurry');assert.ok(w.flash>.2);
 const twin=run('idle',10);for(let i=0;i<60*20+20;i++){if(i>=20)w.step(1/60);twin.step(1/60);}assert.ok(Math.abs(mean(w)-mean(twin))<.05,'re-forms like an untouched twin');assert.ok(w.bounds()<1.2);assert.ok(Math.abs(w.av[1])<.01,'spin coasts to a stop');});
test('a drag spins and pulls the body, which springs back when released',()=>{const w=run('idle',2);w.dragging=true;for(let i=0;i<30;i++){w.drag(.02,0);w.step(1/60);}
 assert.ok(w.dragX>.08&&w.av[1]>1&&w.spinY>1.5,'turns with the hand');w.dragging=false;for(let i=0;i<60*6;i++)w.step(1/60);assert.ok(Math.abs(w.dragX)<.002&&Math.abs(w.av[1])<.05);
 const x=new Swarm(300);for(let i=0;i<99;i++)x.drag(9,-9);assert.ok(x.dragX<=.09&&x.dragY>=-.09&&x.av[1]<=7);});
test('hovering pushes nearby particles away and stays bounded',()=>{const a=run('idle',5),b=run('idle',5);b.cursor=[0,0,.5];for(let i=0;i<120;i++){a.step(1/60);b.step(1/60);}
 const near=w=>{let n=0;for(let i=0;i<w.count;i++){const o=i*3;if(Math.hypot(w.pos[o],w.pos[o+1],w.pos[o+2]-.5)<.2)n++;}return n;};
 assert.ok(near(b)<near(a));assert.ok(b.bounds()<1.15);});
test('poke and drag ignore junk input',()=>{const w=new Swarm(200);w.poke(NaN,Infinity);w.drag(NaN,-Infinity);for(let i=0;i<10;i++)w.step(1/60);assert.ok(Array.from(w.pos).every(Number.isFinite)&&Number.isFinite(w.spinY));});
