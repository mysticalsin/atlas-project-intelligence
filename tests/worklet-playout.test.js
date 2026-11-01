// v2.2 V1: the browser's playout buffer (src/voice-worklet.js). A one second ring (the server sends up to ~0.5 s ahead of playback), playback that starts at 150 ms
// buffered (or 60 ms after the last audio arrived, so a short reply is never held back), every run-dry counted, and her volume ducked while a sound over her voice is checked.
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');
const WORKLET=fs.readFileSync(__dirname+'/../src/voice-worklet.js','utf8');
function load(rate=48000){let C;const messages=[];const context={sampleRate:rate,Float32Array,Int16Array,Math,AudioWorkletProcessor:class{constructor(){this.port={postMessage:m=>messages.push(m)}}},registerProcessor:(n,c)=>C=c};vm.createContext(context);vm.runInContext(WORKLET,context);return{p:new C(),messages};}
const pcm=(ms,amp=8000)=>{const n=Math.round(24*ms),a=new Int16Array(n);for(let i=0;i<n;i++)a[i]=Math.round(amp*Math.sin(2*Math.PI*440*i/24000));return a.buffer;};
const feed=(p,ms,item='a')=>p.port.onmessage({data:{type:'audio',buffer:pcm(ms),item_id:item}});
const tick=(p,blocks=1)=>{const out=new Float32Array(128);for(let i=0;i<blocks;i++)p.process([],[[out]]);return out;};
const ms=blocks=>blocks*128/48000*1000;

test('the ring holds a full second: the burst a credit-based server sends (0.5 s lead plus the reply before it) is never dropped',()=>{
 const {p}=load();feed(p,1000);assert.equal(p.dropped,0);assert.ok(Math.abs(1000*p.count/48000-1000)<2);
 feed(p,100);assert.ok(p.dropped>0,'only beyond a second');
});

test('playback starts at 150 ms buffered, not before; after a stall it starts 60 ms after the last audio arrived',()=>{
 const a=load().p;feed(a,100);tick(a,20); // 53 ms: well under the stall rule? 100 ms buffered, 53 ms waited
 assert.equal(a.playing,false,'100 ms is not enough yet');
 feed(a,60);tick(a);assert.equal(a.playing,true,'160 ms buffered: playing');
 const b=load().p;feed(b,100);tick(b,40); // 107 ms since the audio arrived
 assert.equal(b.playing,true,'a short reply (under 150 ms) is not held for ever');
});

test('a late chunk costs nothing while the ring still has audio; running dry is counted',()=>{
 const {p}=load();feed(p,200);tick(p,5);assert.equal(p.playing,true);assert.equal(p.underruns,0);
 tick(p,40);assert.equal(p.underruns,0,'about 107 ms played of 200: still audio buffered through a 120 ms gap in arrivals');
 feed(p,200);tick(p,40);assert.equal(p.underruns,0);
 tick(p,200);assert.equal(p.underruns,1,'the buffer ran dry once');assert.equal(p.playing,false);
});

test('duck lowers her volume to a quarter without a click, lifts it again, and lets go by itself after 3 s',()=>{
 const level=o=>Math.max(...o.map(Math.abs));
 const {p,messages}=load();feed(p,1000);tick(p,5);
 const full=level(tick(p));p.port.onmessage({data:{type:'duck',on:true}});for(let i=0;i<10;i++)tick(p);const ducked=level(tick(p));
 assert.ok(ducked<full*.3&&ducked>full*.15,'about a quarter: '+(ducked/full).toFixed(2));
 p.port.onmessage({data:{type:'duck',on:false}});for(let i=0;i<10;i++)tick(p);assert.ok(level(tick(p))>full*.9,'back');
 // forgotten duck: released after 3 s (48000*3/128 blocks)
 const q=load().p;feed(q,1000);tick(q,5);q.port.onmessage({data:{type:'duck',on:true}});for(let i=0;i<1200;i++){if(q.count<24000)feed(q,500);tick(q);}
 assert.equal(q.gainTarget,1,'let go by itself');
 // the speaker meter (what moves the orb) reads her voice, not the volume it is played at
 const m=load();feed(m.p,1000);m.p.port.onmessage({data:{type:'duck',on:true}});for(let i=0;i<40;i++)tick(m.p);
 const meters=m.messages.filter(x=>x.type==='meter');assert.ok(meters.length&&meters.at(-1).speaker>.1,'the orb is not dimmed by the duck: '+meters.at(-1)?.speaker);
 assert.ok('underruns' in meters.at(-1));
});

test('flush (an interruption) empties the ring and restores the volume',()=>{
 const {p}=load();feed(p,500);p.port.onmessage({data:{type:'duck',on:true}});p.port.onmessage({data:{type:'flush'}});
 assert.equal(p.count,0);assert.equal(p.gainTarget,1);assert.equal(p.playing,false);
});
