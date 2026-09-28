/* ATLAS Orb — dependency-free particle renderer, v12, September 2026.
 * v12 swarm motion is a Canvas2D re-implementation of the particle-swarm model in
 * Tony Walteur's JARVIS orb (github.com/mysticalsin/tonys-jarvis, frontend/src/orb.ts),
 * used in ATLAS with the copyright holder's explicit permission (2026-09-26).
 * This module renders supplied state/levels only. It never captures audio, performs
 * network requests, starts speech or infers what a model is thinking.
 */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.AtlasOrb=api;})(typeof window!=='undefined'?window:globalThis,function(){
'use strict';
const clamp=(v,a=0,b=1)=>Math.max(a,Math.min(b,Number.isFinite(v)?v:0));
const hash=n=>{const v=Math.sin(n*91.713+13.127)*43758.5453;return v-Math.floor(v);};
function geometry(count=1300){
 count=Math.floor(clamp(count,160,2000));
 const points=new Float32Array(count*4),pairs=[],golden=Math.PI*(3-Math.sqrt(5));
 for(let i=0;i<count;i++){
  const y=1-2*(i+.5)/count,theta=i*golden,s=Math.sqrt(1-y*y);
  // Stratified angular coverage, with both a porous shell and a populated interior.
  const r=(i%5===0?.22+.58*hash(i+70):.83+.155*hash(i+100));
  points.set([Math.cos(theta)*s*r,y*r,Math.sin(theta)*s*r,hash(i+900)],4*i);
 }
 // Build a sparse graph once. There is no per-frame all-pairs search.
 for(let i=0;i<count;i+=2){
  const near=[];
  for(let j=i+2;j<count;j+=2){const dx=points[i*4]-points[j*4],dy=points[i*4+1]-points[j*4+1],dz=points[i*4+2]-points[j*4+2],d=dx*dx+dy*dy+dz*dz;if(d<.095)near.push([d,j]);}
  near.sort((a,b)=>a[0]-b[0]);for(const [,j]of near.slice(0,4))pairs.push([i,j]);
 }
 const lines=new Float32Array(pairs.length*8);pairs.forEach(([a,b],i)=>{lines.set(points.subarray(a*4,a*4+4),i*8);lines.set(points.subarray(b*4,b*4+4),i*8+4);});
 return {points,lines,pairs,count};
}

class SignalState{
 constructor(){this.phase='idle';this.muted=false;this.input=0;this.output=0;this.lastInput=-1e9;this.lastOutput=-1e9;this.updated=-1e9;}
 setPhase(phase,muted=false){this.phase=phase;this.muted=!!muted;if(phase!=='live'){this.input=0;this.output=0;this.lastInput=-1e9;this.lastOutput=-1e9;}}
 levels(mic,speaker,now){this.updated=now;this.input=this.phase==='live'&&!this.muted?clamp(mic):0;this.output=this.phase==='live'?clamp(speaker):0;if(this.input>.012)this.lastInput=now;if(this.output>.009)this.lastOutput=now;}
 snapshot(now){
  const fresh=now-this.updated<350,output=fresh?this.output:0,input=fresh?this.input:0;
  let state='idle';
  if(['preparing','connecting'].includes(this.phase))state='connecting';
  else if(this.phase==='ending')state='processing';else if(this.phase==='error')state='error';
  else if(this.phase==='live')state=now-this.lastOutput<190?'speaking':this.muted?'muted':'listening';
  return{state,input:this.muted?0:input,output,muted:this.muted,phase:this.phase,inputActive:!this.muted&&now-this.lastInput<240};
 }
}

// A continuous, audio-driven shape rig. No expanding rings or radial wave fields.
const TAU=Math.PI*2;
const MOTIFS=Object.freeze({
 idle:{name:'Poised',period:24,meaning:'A quiet turning body. No microphone is active.',radius:1,vertical:1,light:.96,closed:0},
 listening:{name:'Attentive',period:24,meaning:'A small forward lean and a restrained response to input.',radius:.985,vertical:1.025,light:.84,closed:0},
 speaking:{name:'Articulate',period:0,meaning:'Deformation and torsion follow the audio being played.',radius:1,vertical:1,light:.92,closed:0},
 muted:{name:'Still',period:24,meaning:'Microphone motion is off. Playback can still animate the body.',radius:.94,vertical:1,light:.47,closed:1},
 connecting:{name:'Connecting',period:8,meaning:'A restrained rotation while connection is pending.',radius:.96,vertical:1,light:.65,closed:.25},
 processing:{name:'Preparing notes',period:8,meaning:'A quiet turn while the gateway finishes notes.',radius:.96,vertical:1,light:.65,closed:.25},
 error:{name:'Paused',period:24,meaning:'The connection has stopped; microphone is off.',radius:.94,vertical:1,light:.45,closed:1}
});
const PARAMS=['radius','vertical','light','closed'];
const smooth=v=>{v=clamp(v);return v*v*(3-2*v);};
class MotionRig{
 constructor(){this.time=0;this.state='idle';this.mix={...MOTIFS.idle};this.from={...this.mix};this.transition=1;this.mic=0;this.speaker=0;this.focusX=0;this.focusY=0;this.targetX=0;this.targetY=0;this.intensity=.65;this.bass=0;this.body=0;this.air=0;this.impulse=0;this.spin=0;this.lastLevel=0;this.phrase=0;this.phraseGap=1;this.gestureIndex=0;this.gestureX=0;this.gestureY=0;this.targetGestureX=0;this.targetGestureY=0;}
 setState(s,immediate=false){s=Object.hasOwn(MOTIFS,s)?s:'idle';if(s===this.state&&!immediate)return;this.from={...this.mix};this.state=s;this.transition=immediate?1:0;if(immediate)this.mix={...MOTIFS[s]};}
 look(x,y){this.targetX=clamp(x,-1,1);this.targetY=clamp(y,-1,1);}
 reset(s='idle'){const i=this.intensity;Object.assign(this,new MotionRig());this.intensity=i;this.setState(s,true);}
 step(dt,input=0,output=0,spectrum=null){
  dt=clamp(dt,0,.1);this.time+=dt;this.transition=Math.min(1,this.transition+dt/.48);const w=smooth(this.transition),t=MOTIFS[this.state];for(const k of PARAMS)this.mix[k]=this.from[k]+(t[k]-this.from[k])*w;
  const sp=this.state==='speaking'?clamp(output*5.8):0,mi=this.state==='listening'?clamp(input*4.5):0;
  const follow=(a,b,attack=.035,release=.17)=>a+(b-a)*(1-Math.exp(-dt/(b>a?attack:release)));
  this.mic=follow(this.mic,mi,.09,.3);this.speaker=follow(this.speaker,sp);
  // A coherent turn-taking posture follows audible speech, never transcript timing.
  // The body leans into a phrase, holds through tiny gaps, and settles in silence.
  // A bounded phrase-onset gesture; this is not sentiment or emotion inference.
  // New gestures require an audible onset after silence, not an arriving text token.
  if(sp>.045){if(this.phraseGap>.22){const angle=this.gestureIndex++*2.39996323;this.targetGestureX=Math.sin(angle)*.022;this.targetGestureY=Math.cos(angle)*.018;}this.phraseGap=0;}else this.phraseGap+=dt;
  const talking=sp>.045||this.phraseGap<.18;
  this.gestureX=follow(this.gestureX,talking?this.targetGestureX:0,.16,.34);
  this.gestureY=follow(this.gestureY,talking?this.targetGestureY:0,.16,.34);
  this.phrase=follow(this.phrase,sp>.045?1:0,.14,.32);
  // Optional measured spectral bands. When absent, amplitude alone drives the rig.
  const band=k=>sp===0?0:spectrum?clamp((Number(spectrum[k])||0)*8):sp;
  this.bass=follow(this.bass,band('low'),.06,.23);this.body=follow(this.body,band('mid'));this.air=follow(this.air,band('high'),.025,.10);
  this.impulse=Math.max(this.impulse*Math.exp(-dt/0.13),Math.max(0,sp-this.lastLevel)*1.65);this.lastLevel=sp;
  this.spin+=dt*(.044+(this.body*.23+this.impulse*.26)*this.intensity)*(1-this.mix.closed*.7);
  const q=1-Math.exp(-dt*3.6);this.focusX+=(this.targetX-this.focusX)*q;this.focusY+=(this.targetY-this.focusY)*q;
  return this.snapshot();
 }
 snapshot(){const b=this.bass*this.intensity,v=this.body*this.intensity,a=this.air*this.intensity,sp=this.speaker*this.intensity;return {...this.mix,state:this.state,motif:MOTIFS[this.state].name,period:MOTIFS[this.state].period,time:this.time,transition:this.transition,
   scale:this.mix.radius*(1+sp*.065),luminosity:this.mix.light+sp*.20,focusX:this.focusX,focusY:this.focusY,mic:this.mic,speaker:this.speaker,bass:b,body:v,air:a,impulse:this.impulse*this.intensity,
   gestureX:this.gestureX*this.intensity,gestureY:this.gestureY*this.intensity,gestureIndex:this.gestureIndex,spin:this.spin,energy:Math.max(this.mic,this.speaker),intensity:this.intensity,articulation:sp,phrase:this.phrase*this.intensity,lean:sp*.085+this.phrase*this.intensity*.035+this.mic*.018,
   // Explicitly no animated propagation radius; changes deform the body in place.
   deformX:1+b*.095-v*.038,deformY:1-b*.09+v*.11,deformZ:1+v*.08};}
}
// Fixed topology; stable point identities. Audio changes pose, never creates random particles.
function deformPoint(x,y,z,pose){
 const theta=Math.atan2(z,x),lat=y;
 const speech=pose.articulation||0,torque=(pose.body||0)*.28+(pose.impulse||0)*.08;
 const local=1+speech*(.13*Math.sin(theta*3+lat*2.4+pose.spin*1.7)+.055*Math.cos(theta*5-lat*3+pose.spin));
 const twist=lat*torque+(pose.phrase||0)*.035+Math.sin(lat*3+pose.spin)*speech*.12,c=Math.cos(twist),s=Math.sin(twist);
 return [(x*c-z*s)*local*pose.deformX,y*local*pose.deformY,(x*s+z*c)*local*pose.deformZ];
}

// v12 swarm: free-floating particles, proximity links and a tumble on state change.
// Jarvis world units (cloud radius 25) are rescaled to ATLAS's unit sphere (S=1/25)
// and per-frame constants are normalized to 60 fps. Audio input is ONLY the measured
// envelope of played output (MotionRig bass/body), so text or labels cannot move it.
const SWARM=Object.freeze({
 idle:{radius:.95,speed:.2,light:.72,size:.38,lines:.38,electrons:0,rate:.18},
 listening:{radius:.86,speed:.3,light:.78,size:.4,lines:.5,electrons:0,rate:.24},
 speaking:{radius:.74,speed:.2,light:.74,size:.4,lines:.8,electrons:0,rate:.12},
 muted:{radius:.92,speed:.12,light:.46,size:.34,lines:.2,electrons:0,rate:.07},
 connecting:{radius:.66,speed:.5,light:.72,size:.3,lines:1,electrons:1,rate:.32},
 processing:{radius:.66,speed:.5,light:.72,size:.3,lines:1,electrons:1,rate:.32},
 error:{radius:1.0,speed:.08,light:.32,size:.32,lines:.06,electrons:0,rate:.04}
});
const S=1/25;
class Swarm{
 constructor(count=2000){
  this.count=Math.floor(clamp(count,200,2400));const n=this.count;
  this.pos=new Float32Array(n*3);this.vel=new Float32Array(n*3);this.phase=new Float32Array(n);
  for(let i=0;i<n;i++){const th=hash(i*3+1)*TAU,ph=Math.acos(2*hash(i*3+2)-1),r=Math.sqrt(hash(i*3+3));
   this.pos.set([r*Math.sin(ph)*Math.cos(th),r*Math.sin(ph)*Math.sin(th),r*Math.cos(ph)],i*3);this.phase[i]=hash(i+7001)*1000;}
  this.state='idle';this.last='idle';this.cur={...SWARM.idle};this.spinX=0;this.spinY=0;this.spinZ=0;this.energy=0;
  this.z=0;this.zv=0;this.time=0;this.electrons=[];this.lastSpawn=-9;this.links=new Float32Array(0);this.linkCount=0;
  this.breath=0;this.lookX=0;this.lookY=0;this.lookTX=0;this.lookTY=0;this.nextLook=2;this.attend=0;
  // Touch layer: continuous spin with inertia, a slow wander around the stage, drag offset, a click flinch and cursor repel.
  this.av=[0,0];this.offX=0;this.offY=0;this.dragX=0;this.dragY=0;this.dragging=false;this.cursor=null;this.flurry=0;this.flash=0;
 }
 // A click: the body flinches (particles scatter outward, a spin kick, a spark flurry, a brighter core), then re-forms.
 poke(nx=0,ny=0){
  nx=clamp(Number(nx)||0,-1.5,1.5);ny=clamp(Number(ny)||0,-1.5,1.5);const P=this.pos,V=this.vel,t=this.time;
  this.av[1]+=(nx||(hash(t*5.1)-.5))*3.2;this.av[0]+=(ny||(hash(t*3.7)-.5))*2.4;this.flash=1;this.flurry=6;
  for(let i=0;i<this.count;i++){const i3=i*3,x=P[i3],y=P[i3+1],z=P[i3+2],d=Math.sqrt(x*x+y*y+z*z)||.001,f=.0024*(.55+.9*hash(i*1.7+t));
   V[i3]+=x/d*f;V[i3+1]+=y/d*f;V[i3+2]+=z/d*f;}
  return this;
 }
 // Drag: the body turns with the hand (about half a turn per orb width), keeps the fling speed on release
 // and coasts to a stop; it is also pulled along (bounded) and springs back when released.
 drag(dx=0,dy=0){
  dx=clamp(Number(dx)||0,-.5,.5);dy=clamp(Number(dy)||0,-.5,.5);
  this.spinY+=dx*3.2;this.spinX+=dy*3.2;
  this.av[1]=clamp(this.av[1]*.5+dx*96,-7,7);this.av[0]=clamp(this.av[0]*.5+dy*96,-7,7);
  this.dragX=clamp(this.dragX+dx*.35,-.09,.09);this.dragY=clamp(this.dragY+dy*.35,-.09,.09);return this;
 }
 setState(s){this.state=Object.hasOwn(SWARM,s)?s:'idle';}
 pulse(){this.forcePulse=true;}
 step(dt,bass=0,mid=0,cues={}){
  dt=clamp(dt,0,.1);if(!dt)return this;const k=dt*60,t=(this.time+=dt),T=SWARM[this.state],ease=1-Math.pow(.98,k);
  for(const key of ['radius','speed','light','size','lines','electrons','rate'])this.cur[key]+=(T[key]-this.cur[key])*ease;
  if(this.state!==this.last){this.energy=1;this.last=this.state;}
  this.energy*=Math.pow(.985,k);
  if(this.energy>.05){this.spinX+=this.energy*.012*Math.sin(t*1.7)*k;this.spinY+=this.energy*.015*k;this.spinZ+=this.energy*.008*Math.cos(t*1.3)*k;}
  // Always turning (per-state resting rate, JARVIS-like wobble), plus drag/click spin that coasts to a stop.
  this.spinY+=(this.cur.rate+this.av[1])*dt;this.spinX+=(Math.sin(t*.11)*.018+this.av[0])*dt;this.spinZ+=Math.sin(t*.07+1)*.008*dt;
  const coast=Math.pow(this.dragging?.8:.955,k);this.av[0]*=coast;this.av[1]*=coast;
  // Wander: slow, bounded loops around the stage; a drag offset springs back once released.
  if(!this.dragging){const back=Math.pow(.93,k);this.dragX*=back;this.dragY*=back;}
  this.offX=Math.sin(t*.071)*.035+Math.sin(t*.029+1.3)*.02+this.dragX;this.offY=Math.cos(t*.053)*.026+Math.sin(t*.037+.4)*.015+this.dragY;
  this.flash*=Math.pow(.93,k);const C0=this.cursor;
  // MotionRig envelopes run hotter than the JARVIS analyser averages; rescale to its range.
  bass=this.state==='speaking'?clamp(bass)*.45:0;mid=this.state==='speaking'?clamp(mid)*.55:0;
  // Life cues, each tied to a real signal or a slow rhythm (never a fake 'thinking' state):
  // breathing, eye-like glances when nobody is talking, leaning in to the consultant's voice
  // (microphone level), and an exhale on each syllable onset of played output (impulse).
  const mic=this.state==='listening'?clamp(cues.mic):0,impulse=this.state==='speaking'?clamp(cues.impulse):0;
  this.attend+=(mic-this.attend)*(1-Math.pow(mic>this.attend?.85:.97,k));
  this.breath=Math.sin(TAU*t/5.6);
  if(['idle','listening','muted'].includes(this.state)&&this.attend<.05&&t>this.nextLook){
   this.lookTX=(hash(t*13.1)-.5)*.2;this.lookTY=(hash(t*7.7)-.5)*.14;this.nextLook=t+2.4+hash(t*3.3)*3.6;}
  if(this.attend>.05||this.state==='speaking'){this.lookTX*=Math.pow(.9,k);this.lookTY*=Math.pow(.9,k);}
  const glance=1-Math.pow(.86,k);this.lookX+=(this.lookTX-this.lookX)*glance;this.lookY+=(this.lookTY-this.lookY)*glance;
  let zt=Math.sin(t*.12)*8*S+this.attend*.22;if(this.cur.electrons>.5)zt=(Math.sin(t*.3)*15+Math.sin(t*.9)*6)*S;else if(this.state==='speaking')zt=(Math.sin(t*.15)*6-bass*10)*S;
  this.zv+=(zt-this.z)*.008*k;this.zv*=Math.pow(.94,k);this.z+=this.zv*k;
  const P=this.pos,V=this.vel,sp=this.cur.speed,damp=Math.pow(.992,k),W=25;
  const R=this.cur.radius*(1+(this.state==='speaking'?.012:.04)*this.breath)*(1-.07*this.attend);
  for(let i=0;i<this.count;i++){
   const i3=i*3,x=P[i3],y=P[i3+1],z=P[i3+2],px=this.phase[i];
   V[i3]+=(Math.sin(t*.05+px)*.001+Math.sin(t*.02+px*2.1+y*W*.1)*.0008)*sp*S*k;
   V[i3+1]+=(Math.cos(t*.06+px*1.3)*.001+Math.cos(t*.025+px*1.7+z*W*.1)*.0008)*sp*S*k;
   V[i3+2]+=(Math.sin(t*.055+px*.7)*.001+Math.sin(t*.022+px*.9+x*W*.1)*.0008)*sp*S*k;
   // Jarvis pull toward the state radius, plus a soft inner cushion that keeps the volume filled.
   const d=Math.sqrt(x*x+y*y+z*z)||.0004,pull=(Math.max(0,d-R)*.002+.0003*S-Math.max(0,.45*R-d)*.0015)*k;
   const wall=Math.max(0,d-1.05)*.03*k;// soft boundary: the body never balloons past the frame
   V[i3]-=x/d*(pull+wall);V[i3+1]-=y/d*(pull+wall);V[i3+2]-=z/d*(pull+wall);
   if(bass>.05){const b=bass*.02*S*k;V[i3]+=x/d*b;V[i3+1]+=y/d*b;V[i3+2]+=z/d*b;}
   if(mid>.1){const m=mid*.012*S*k*Math.sin(t*8+px);V[i3]+=x/d*m;V[i3+1]+=y/d*m;}
   if(impulse>.08){const e=impulse*.012*S*k;V[i3]+=x/d*e;V[i3+1]+=y/d*e;V[i3+2]+=z/d*e;}
   if(C0){const cx=x-C0[0],cy=y-C0[1],cz=z-C0[2],cd=cx*cx+cy*cy+cz*cz;if(cd<.16){const q=Math.sqrt(cd)||.001,f=(1-q/.4)*.0012*k;V[i3]+=cx/q*f;V[i3+1]+=cy/q*f;V[i3+2]+=cz/q*f;}}
   V[i3]*=damp;V[i3+1]*=damp;V[i3+2]*=damp;P[i3]+=V[i3]*k;P[i3+1]+=V[i3+1]*k;P[i3+2]+=V[i3+2]*k;
  }
  this.link(bass);this.spark(t,dt);
  return this;
 }
 link(bass=0){
  const n=this.count,P=this.pos,maxL=6000,step=Math.max(1,Math.floor(n/600)),max=8*S*(1+bass*.5),mx=max*max;
  if(this.links.length<maxL*6)this.links=new Float32Array(maxL*6);
  let c=0;if(this.cur.lines>.01)for(let i=0;i<n&&c<maxL;i+=step){const i3=i*3,x=P[i3],y=P[i3+1],z=P[i3+2];
   for(let j=i+step;j<n&&c<maxL;j+=step){const j3=j*3,dx=P[j3]-x,dy=P[j3+1]-y,dz=P[j3+2]-z;if(dx*dx+dy*dy+dz*dz<mx){this.links.set([x,y,z,P[j3],P[j3+1],P[j3+2]],c*6);c++;}}}
  this.linkCount=c;
 }
 // Electrons only mark real pending work (connecting / preparing notes) or an explicit pulse.
 spark(t,dt){
  if(this.flurry>0&&this.linkCount&&this.electrons.length<8){const c=Math.floor(hash(t*613+this.flurry)*Math.min(this.linkCount,500))*6,L=this.links;
   this.electrons.push({a:[L[c],L[c+1],L[c+2]],b:[L[c+3],L[c+4],L[c+5]],t:0,speed:(.008+hash(t*17+this.flurry)*.006)*60});this.flurry--;}
  const want=this.cur.electrons>.5||this.forcePulse;this.forcePulse=false;
  if(want&&this.linkCount&&this.electrons.length<3&&t-this.lastSpawn>1){const c=Math.floor(hash(t*977)*Math.min(this.linkCount,500))*6,L=this.links;
   this.electrons.push({a:[L[c],L[c+1],L[c+2]],b:[L[c+3],L[c+4],L[c+5]],t:0,speed:(.003+hash(t*31)*.003)*60});this.lastSpawn=t;}
  this.electrons=this.electrons.filter(e=>(e.t+=e.speed*dt)<1);
 }
 bounds(){let m=0;for(let i=0;i<this.count;i++){const i3=i*3;m=Math.max(m,Math.hypot(this.pos[i3],this.pos[i3+1],this.pos[i3+2]));}return m;}
}

// Canvas2D keeps the orb self-contained, with the existing inline SVG as a
// first-paint/no-script/context-failure fallback. Only this renderer draws frames.
function create(canvas,options={}){
 if(!canvas||!canvas.getContext)throw Error('An orb canvas is required.');
 const env=typeof window!=='undefined'?window:globalThis;
 const ctx=canvas.getContext('2d',{alpha:true}),rig=new MotionRig();
 const swarm=new Swarm(options.count||((env.innerWidth||1200)<650?1100:2000));
 const motion=env.matchMedia?.('(prefers-reduced-motion: reduce)');
 const palettes={mantu:{base:'138,0,255',mid:'197,140,255',light:'243,232,255',deep:'62,0,122'},blue:{base:'76,168,232',mid:'110,196,255',light:'232,246,255',deep:'30,73,132'}};
 let width=520,height=520,dpr=1,raf=0,dead=false,visible=true,manualPause=false,reduced=!!motion?.matches,lost=false;
 let state='idle',palette='mantu',input=0,output=0,spectrum=null,speed=1,previous=0,frameAt=0,frames=0,meanDraw=0,quality=1;
 let hover=null,down=null,moved=false,suppressClick=false;
 const xy=new Float32Array(swarm.count*4),fallback=canvas.parentElement?.querySelector('.orb-inline-fallback');
 const rgba=(c,a)=>`rgba(${c},${clamp(a)})`;
 const onError=m=>options.onError?.(m);
 function markReady(){if(ctx&&!lost){canvas.dataset.ready='true';canvas.parentElement?.classList.add('canvas-ready');if(fallback)fallback.setAttribute('aria-hidden','true');}}
 function pauseDOM(){const stage=canvas.closest('.orb-screen');stage?.classList.toggle('motion-paused',manualPause||reduced);stage?.setAttribute('data-motion',reduced?'reduced':manualPause?'paused':'playing');}
 function alive(){return!dead&&!lost&&!manualPause&&!reduced&&visible&&!env.document?.hidden&&!!ctx;}
 function halt(){if(raf)env.cancelAnimationFrame(raf);raf=0;previous=0;}
 function schedule(){if(alive()&&!raf){previous=0;raf=env.requestAnimationFrame(loop);}}
 function size(){if(dead)return;const r=canvas.getBoundingClientRect();if(r.width<1||r.height<1)return;width=r.width;height=r.height;dpr=Math.min(env.devicePixelRatio||1,1.7);const w=Math.round(width*dpr),h=Math.round(height*dpr);if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}draw();schedule();}
 function draw(){
  if(dead||lost||!ctx)return;
  const started=env.performance.now(),P=palettes[palette],pose=rig.snapshot(),m=Math.min(width,height),C=swarm.cur;
  const R=m*.36*(1+(pose.articulation||0)*.03),t=swarm.time,L=(C.light/.7)*(.9+pose.luminosity*.1);
  const out=pose.speaker||0,mic=swarm.attend,air=pose.air||0,br=swarm.breath;
  // Slow camera drift, pointer look and eye-like glances: bounded orientation changes only.
  const cx=width*.5+swarm.offX*m+pose.focusX*m*.012,cy=height*.5+swarm.offY*m+pose.focusY*m*.01;
  const ax=swarm.spinX+pose.focusY*.12+swarm.lookY,ay=swarm.spinY+pose.focusX*.14+swarm.lookX,az=swarm.spinZ;
  const ca=Math.cos(ax),sa=Math.sin(ax),cb=Math.cos(ay),sb=Math.sin(ay),cc=Math.cos(az),sc=Math.sin(az),zOff=swarm.z,F=3.6;
  const rot=(x,y,z)=>{let yy=y*ca-z*sa,zz=y*sa+z*ca,xx=x*cb+zz*sb;z=-x*sb+zz*cb;y=yy;x=xx;xx=x*cc-y*sc;y=x*sc+y*cc;return[xx,y,Math.min(1.3,z+zOff)];};
  // Cursor to model space (front of the body) so hovering particles lean away from the pointer.
  if(hover&&!down){const u=(hover[0]-cx)/R,v=(hover[1]-cy)/R,q=u*u+v*v;if(q<1.3){let x=u,y=v,z=Math.sqrt(Math.max(0,1-q))*.7-zOff;
   let x1=x*cc+y*sc,y1=-x*sc+y*cc,x2=x1*cb-z*sb,z2=x1*sb+z*cb;swarm.cursor=[x2,y1*ca+z2*sa,-y1*sa+z2*ca];}else swarm.cursor=null;}else swarm.cursor=null;
  ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,width,height);ctx.globalAlpha=1;ctx.globalCompositeOperation='lighter';
  const glow=(x,y,r,a,col)=>{if(r<=0||a<=0)return;const g=ctx.createRadialGradient(x,y,0,x,y,r);g.addColorStop(0,rgba(col,a));g.addColorStop(.35,rgba(col,a*.35));g.addColorStop(1,rgba(col,0));ctx.fillStyle=g;ctx.beginPath();ctx.arc(x,y,r,0,TAU);ctx.fill();};
  // Luminous nucleus: breathes at rest, warms with the consultant's voice and ATLAS's played voice.
  const core=(.2+.07*br+.22*out+.14*mic+.4*swarm.flash)*L;
  glow(cx,cy,R*1.25,core*.22,P.deep);glow(cx,cy,R*.62,core*.42,P.base);glow(cx,cy,R*.2,core*.75,P.mid);glow(cx,cy,R*.07,core*.9,P.light);
  const n=swarm.count,pos=swarm.pos,ph=swarm.phase;
  for(let i=0;i<n;i++){const [x,y,z]=rot(pos[i*3],pos[i*3+1],pos[i*3+2]),d=F/(F-z),o=i*4;xy[o]=cx+x*R*d;xy[o+1]=cy+y*R*d;xy[o+2]=z;xy[o+3]=d;}
  // Links: short and near ones bright, long and far ones faint (a plexus, not a mesh).
  if(swarm.linkCount&&C.lines>.01){const Lk=swarm.links,maxd=8*S,paths=[[],[],[]];ctx.lineWidth=.55;
   const fire=Math.max(mic*.55,air*.9*(swarm.state==='speaking'?1:0)),tick=Math.floor(t*7);ctx.beginPath();const flashes=[];
   for(let c=0;c<swarm.linkCount;c+=(quality<.8?2:1)){const o=c*6,dx=Lk[o+3]-Lk[o],dy=Lk[o+4]-Lk[o+1],dz=Lk[o+5]-Lk[o+2],len=Math.sqrt(dx*dx+dy*dy+dz*dz)/maxd;
    const a=rot(Lk[o],Lk[o+1],Lk[o+2]),b=rot(Lk[o+3],Lk[o+4],Lk[o+5]),da=F/(F-a[2]),db=F/(F-b[2]),front=(a[2]+b[2])*.5;
    const seg=[cx+a[0]*R*da,cy+a[1]*R*da,cx+b[0]*R*db,cy+b[1]*R*db];
    paths[len<.45&&front>-.2?2:len<.75?1:0].push(seg);
    if(fire>.03&&hash(c*1.37+tick)<fire*.06)flashes.push(seg);}
   [.05,.11,.2].forEach((alpha,k)=>{if(!paths[k].length)return;ctx.beginPath();for(const q of paths[k]){ctx.moveTo(q[0],q[1]);ctx.lineTo(q[2],q[3]);}ctx.strokeStyle=rgba(k===2?P.mid:P.base,alpha*C.lines*1.6*L);ctx.stroke();});
   // Neural flashes along existing links: driven by the microphone while listening and by
   // high-band played output while speaking. Silence produces none.
   if(flashes.length){ctx.beginPath();for(const q of flashes){ctx.moveTo(q[0],q[1]);ctx.lineTo(q[2],q[3]);}ctx.lineWidth=1.1;ctx.strokeStyle=rgba(P.light,.55*L);ctx.stroke();ctx.lineWidth=.55;}}
  // Particles: depth colour, twinkle and a soft halo on the nearest ones.
  const size=(C.size/.4)*(1+(pose.bass||0)*.12),buckets=[[],[],[],[],[],[]];
  for(let i=0;i<n;i+=(quality<.8?2:1)){const o=i*4,z=xy[o+2],band=z<-.3?0:z<.3?1:2,tw=Math.sin(t*(.6+hash(i+3)*1.4)+ph[i])>.35?1:0;buckets[band*2+tw].push(o);}
  const cols=[P.deep,P.deep,P.base,P.mid,P.mid,P.light],alphas=[.35,.55,.45,.7,.62,.95];
  buckets.forEach((list,b)=>{if(!list.length)return;ctx.beginPath();const band=b>>1;for(const o of list){const r=(.5+band*.3+(b&1)*.25)*size*xy[o+3];ctx.moveTo(xy[o]+r,xy[o+1]);ctx.arc(xy[o],xy[o+1],r,0,TAU);}
   ctx.fillStyle=rgba(cols[b],alphas[b]*L+(pose.bass||0)*.05);ctx.fill();});
  ctx.beginPath();for(const o of buckets[5]){if(xy[o+2]<.6)continue;const r=3.2*size*xy[o+3];ctx.moveTo(xy[o]+r,xy[o+1]);ctx.arc(xy[o],xy[o+1],r,0,TAU);}ctx.fillStyle=rgba(P.mid,.07*L);ctx.fill();
  // Electrons travel along real links only while connection/notes work is pending.
  for(const e of swarm.electrons){const q=e.t,[x,y,z]=rot(e.a[0]+(e.b[0]-e.a[0])*q,e.a[1]+(e.b[1]-e.a[1])*q,e.a[2]+(e.b[2]-e.a[2])*q),d=F/(F-z),X=cx+x*R*d,Y=cy+y*R*d;
   glow(X,Y,7*d,.5,P.light);ctx.fillStyle='rgba(255,255,255,.95)';ctx.beginPath();ctx.arc(X,Y,1.5*d,0,TAU);ctx.fill();}
  ctx.globalCompositeOperation='source-over';ctx.globalAlpha=1;frames++;
  const ms=env.performance.now()-started;meanDraw=meanDraw?meanDraw*.96+ms*.04:ms;if(frames>100&&meanDraw>19)quality=.7;if(frames===1)markReady();
 }
 function loop(now){raf=0;if(!alive())return;const interval=quality<.8?1000/30:1000/60;if(now-frameAt>=interval-1){const dt=previous?Math.min(.08,(now-previous)/1000):1/60;previous=now;frameAt=now;const pose=rig.step(dt*speed,input,output,spectrum);swarm.step(dt*speed,pose.bass,pose.body,{mic:pose.mic,impulse:pose.impulse});draw();}if(alive())raf=env.requestAnimationFrame(loop);}
 function updateMotion(){pauseDOM();options.onMotion?.(reduced,manualPause);}
 function onMotion(e){reduced=e.matches;halt();if(reduced){rig.mic=0;rig.speaker=0;rig.focusX=rig.focusY=0;rig.setState(state,true);}draw();updateMotion();schedule();}
 function visibilityChange(){if(env.document.hidden)halt();else schedule();}
 function pointer(e){if(reduced||manualPause)return;const r=canvas.getBoundingClientRect();if(!r.width||!r.height)return;rig.look((e.clientX-r.left)/r.width*2-1,(e.clientY-r.top)/r.height*2-1);
  hover=[e.clientX-r.left,e.clientY-r.top];
  if(down){const m=Math.min(r.width,r.height);if(!moved&&Math.hypot(e.clientX-down.x,e.clientY-down.y)>6){moved=true;swarm.dragging=true;canvas.style.cursor='grabbing';}
   if(moved){swarm.drag((e.clientX-down.lx)/m,(e.clientY-down.ly)/m);down.lx=e.clientX;down.ly=e.clientY;}}
  schedule();}
 function leave(){rig.look(0,0);hover=null;}
 // Touch layer. A click still reaches the orb button (start / mute) and also makes the body flinch;
 // a drag only plays with the orb (spin + pull) and never triggers the button.
 function press(e){if(reduced||manualPause||e.button>0)return;down={x:e.clientX,y:e.clientY,lx:e.clientX,ly:e.clientY};moved=false;try{canvas.setPointerCapture(e.pointerId);}catch{}}
 function release(e){if(!down)return;if(moved)suppressClick=true;else{const r=canvas.getBoundingClientRect(),m=Math.min(r.width,r.height)||1;swarm.poke((e.clientX-r.left-r.width/2)/(m*.36),(e.clientY-r.top-r.height/2)/(m*.36));}
  down=null;moved=false;swarm.dragging=false;canvas.style.cursor='';schedule();}
 function onClick(e){if(suppressClick){suppressClick=false;e.stopPropagation();e.preventDefault();return;}if(e.detail===0&&alive())swarm.poke(0,0);}
 function onLost(e){e.preventDefault();lost=true;halt();canvas.parentElement?.classList.remove('canvas-ready');onError('Orb renderer interrupted. The built-in visual and voice controls remain available.');}
 function onRestored(){lost=false;size();markReady();onError('');schedule();}
 canvas.addEventListener('pointermove',pointer);canvas.addEventListener('pointerleave',leave);canvas.addEventListener('pointerdown',press);canvas.addEventListener('pointerup',release);canvas.addEventListener('pointercancel',release);canvas.addEventListener('click',onClick);canvas.addEventListener('contextlost',onLost);canvas.addEventListener('contextrestored',onRestored);
 motion?.addEventListener('change',onMotion);env.document?.addEventListener('visibilitychange',visibilityChange);
 const resize=env.ResizeObserver?new env.ResizeObserver(size):null;resize?.observe(canvas);if(!resize)env.addEventListener?.('resize',size);
 const intersection=env.IntersectionObserver?new env.IntersectionObserver(entries=>{visible=entries[0]?.isIntersecting!==false;if(!visible)halt();else schedule();},{threshold:.01}):null;intersection?.observe(canvas);
 if(!ctx)onError('Canvas is unavailable. Showing the built-in SVG orb; voice controls remain separate.');
 size();updateMotion();schedule();
 return{
  setState(value){const next=Object.hasOwn(MOTIFS,value)?value:'idle';if(state===next)return;state=next;rig.setState(next,reduced||manualPause);swarm.setState(next);if(reduced||manualPause)draw();else schedule();},
  setLevels(mic,speaker,bands=null){input=clamp(mic);output=clamp(speaker);spectrum=bands;},
  pause(value=true){manualPause=!!value;halt();draw();updateMotion();schedule();},
  setPalette(value){palette=Object.hasOwn(palettes,value)?value:'mantu';draw();},
  setIntensity(value){rig.intensity=clamp(value,.15,1);if(reduced||manualPause)draw();},
  setSpeed(value){speed=clamp(value,.3,1.6);},
  // Restart is an explicit visual-preview control only. It never resets a model.
  restart(value='idle'){rig.reset(value);state=rig.state;swarm.setState(state);input=0;output=0;draw();},
  renderOnce(){draw();},
  pulse(){swarm.pulse();},
  inspect(){return{renderer:ctx?'Canvas2D particle swarm':'Inline SVG fallback',palette,state,frames,count:swarm.count,connections:swarm.linkCount,swarmRadius:Math.round(swarm.bounds()*100)/100,reducedMotion:reduced,paused:manualPause,visible,lost,running:!!raf,dpr,quality,intensity:rig.intensity,speed,time:rig.time,behavior:rig.snapshot(),touch:{spinX:swarm.spinX,spinY:swarm.spinY,offX:swarm.offX,offY:swarm.offY,flash:swarm.flash,dragging:swarm.dragging,electrons:swarm.electrons.length},averageDrawMs:Math.round(meanDraw*100)/100};},
  destroy(){dead=true;halt();resize?.disconnect();intersection?.disconnect();motion?.removeEventListener('change',onMotion);env.document?.removeEventListener('visibilitychange',visibilityChange);env.removeEventListener?.('resize',size);canvas.removeEventListener('pointermove',pointer);canvas.removeEventListener('pointerleave',leave);canvas.removeEventListener('pointerdown',press);canvas.removeEventListener('pointerup',release);canvas.removeEventListener('pointercancel',release);canvas.removeEventListener('click',onClick);canvas.removeEventListener('contextlost',onLost);canvas.removeEventListener('contextrestored',onRestored);}
 };
}
return{geometry,SignalState,MotionRig,MOTIFS,deformPoint,Swarm,SWARM,create};
});
