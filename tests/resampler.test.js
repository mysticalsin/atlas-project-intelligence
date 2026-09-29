// Audio quality of the browser worklet's resampler (src/voice-worklet.js), measured with an FFT.
// The model speaks 24 kHz PCM; the AudioContext runs at the device rate (48k, 44.1k, 32k, or 16k on a Bluetooth headset in
// call mode), so every word ATLAS says and every word the consultant says passes through AtlasResampler.
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');
const WORKLET=fs.readFileSync(__dirname+'/../src/voice-worklet.js','utf8');
function load(rate=48000){let C;const messages=[];const context={sampleRate:rate,Float32Array,Int16Array,Math,AudioWorkletProcessor:class{constructor(){this.port={postMessage:m=>messages.push(m)}}},registerProcessor:(n,c)=>C=c};vm.createContext(context);vm.runInContext(WORKLET+'\nthis.R=AtlasResampler;',context);return{R:context.R,processor:()=>new C(),messages};}
const {R}=load();

// The resampler this change replaced (verbatim): linear interpolation, no anti-imaging or anti-aliasing filter. It is the
// reference for the output schedule (how many samples each block yields), which the ring buffer, the 480-sample frames and
// the playback acknowledgements depend on, and the baseline the quality numbers below are printed against.
class Legacy{constructor(from,to){this.from=from;this.to=to;this.phase=0;this.prev=0;}
 push(samples){if(this.from===this.to)return samples;const out=[];for(const current of samples){this.phase+=this.to;while(this.phase>=this.from){this.phase-=this.from;const fraction=Math.max(0,Math.min(1,1-this.phase/this.to));out.push(this.prev+(current-this.prev)*fraction);}this.prev=current;}return Float32Array.from(out);}}

const NFFT=16384;
function tone(freq,rate,seconds,amp=.5){const x=new Float32Array(Math.round(rate*seconds));for(let i=0;i<x.length;i++)x[i]=amp*Math.sin(2*Math.PI*freq*i/rate);return x;}
function run(Kind,from,to,x,block=128){const r=new Kind(from,to),parts=[];let n=0;for(let i=0;i<x.length;i+=block){const y=r.push(x.subarray(i,Math.min(x.length,i+block)));parts.push(Float32Array.from(y));n+=y.length;}const out=new Float32Array(n);let o=0;for(const p of parts){out.set(p,o);o+=p.length;}return out;}
function fft(re,im){const n=re.length;for(let i=1,j=0;i<n;i++){let bit=n>>1;for(;j&bit;bit>>=1)j^=bit;j^=bit;if(i<j){[re[i],re[j]]=[re[j],re[i]];[im[i],im[j]]=[im[j],im[i]];}}
 for(let len=2;len<=n;len<<=1){const a=-2*Math.PI/len,wr=Math.cos(a),wi=Math.sin(a);for(let i=0;i<n;i+=len){let cr=1,ci=0;for(let k=0;k<len/2;k++){const ur=re[i+k],ui=im[i+k],p=i+k+len/2,vr=re[p]*cr-im[p]*ci,vi=re[p]*ci+im[p]*cr;re[i+k]=ur+vr;im[i+k]=ui+vi;re[p]=ur-vr;im[p]=ui-vi;const t=cr*wr-ci*wi;ci=cr*wi+ci*wr;cr=t;}}}}
// 4-term Blackman-Harris window (sidelobes -92 dB): leakage stays far below the -50 dB bar being measured.
function analyze(y,rate,start=Math.round(rate*.05)){assert.ok(y.length>=start+NFFT,'enough output to analyze');const re=new Float64Array(NFFT),im=new Float64Array(NFFT),w=new Float64Array(NFFT);let sw=0;
 for(let i=0;i<NFFT;i++){const a=2*Math.PI*i/NFFT;w[i]=.35875-.48829*Math.cos(a)+.14128*Math.cos(2*a)-.01168*Math.cos(3*a);sw+=w[i];re[i]=y[start+i]*w[i];}
 const seg=Float64Array.from(re);fft(re,im);const mag=new Float64Array(NFFT/2);for(let k=0;k<NFFT/2;k++)mag[k]=2*Math.hypot(re[k],im[k])/sw;
 const amp=f=>{let a=0,b=0;for(let i=0;i<NFFT;i++){const p=2*Math.PI*f*i/rate;a+=seg[i]*Math.cos(p);b-=seg[i]*Math.sin(p);}return 2*Math.hypot(a,b)/sw;};
 return{mag,bin:rate/NFFT,amp};}
const dB=v=>20*Math.log10(Math.max(v,1e-12));
// Level of a tone at its exact frequency, and the strongest other component anywhere in the spectrum (images, aliases,
// distortion) relative to it. The tone's own main lobe (+-6 bins) is excluded.
function toneReport(y,rate,freq,amp=.5){const s=analyze(y,rate),level=s.amp(freq),c=freq/s.bin;let spur=0;for(let k=1;k<s.mag.length;k++)if(Math.abs(k-c)>6)spur=Math.max(spur,s.mag[k]);return{levelDb:dB(level/amp),spurDb:dB(spur/level)};}
function peakHz(y,rate){const s=analyze(y,rate);let k=1;for(let i=2;i<s.mag.length-1;i++)if(s.mag[i]>s.mag[k])k=i;const a=dB(s.mag[k-1]),b=dB(s.mag[k]),c=dB(s.mag[k+1]);return(k+.5*(a-c)/(a-2*b+c))*s.bin;}
function impulseDelayMs(Kind,from,to){const x=new Float32Array(Math.round(from*.2)),k0=Math.round(from*.1)+1;x[k0]=1;const y=run(Kind,from,to,x);let n=0;for(let i=1;i<y.length;i++)if(Math.abs(y[i])>Math.abs(y[n]))n=i;const a=y[n-1],b=y[n],c=y[n+1];const d=a-2*b+c,frac=d?.5*(a-c)/d:0;return 1000*((n+frac)/to-k0/from);}
const f1=v=>v.toFixed(1),f2=v=>v.toFixed(2);

// Playback: 24 kHz model speech to the device rate, and microphone: device rate to 24 kHz.
const WIDE=[48000,44100,32000];
const PASS_WIDE=[100,250,500,1000,2000,4000,6000,8000,9000,10000],PASS_16K=[100,500,1000,2000,4000,5000,6000,6500];

test('passband is flat within 1 dB (100 Hz-10 kHz; 100 Hz-6.5 kHz at 16 kHz), both directions',()=>{
 const bad=[],cases=[...WIDE.map(r=>[24000,r,PASS_WIDE]),...WIDE.map(r=>[r,24000,PASS_WIDE]),[24000,16000,PASS_16K],[16000,24000,PASS_16K]];
 for(const [from,to,freqs] of cases){const levels=freqs.map(f=>toneReport(run(R,from,to,tone(f,from,1.2)),to,f).levelDb),old=freqs.map(f=>toneReport(run(Legacy,from,to,tone(f,from,1.2)),to,f).levelDb);
  const worst=l=>l.reduce((a,b)=>Math.abs(b)>Math.abs(a)?b:a,0);
  console.log(`# passband ${from}->${to}: worst ${f2(worst(levels))} dB (legacy ${f2(worst(old))} dB); at ${freqs.at(-1)} Hz ${f2(levels.at(-1))} dB (legacy ${f2(old.at(-1))} dB)`);
  levels.forEach((l,i)=>{if(Math.abs(l)>=1)bad.push(`${from}->${to} ${freqs[i]} Hz is ${f2(l)} dB`);});}
 assert.deepEqual(bad,[]);
});

test('images and aliases are at least 50 dB down (24k->48k, 24k->44.1k, 24k->16k and the microphone paths)',()=>{
 // In-band tones: everything else in the output spectrum is an image, an alias or distortion.
 const bad=[],inband=[[24000,48000,[1000,4000,8000,10000]],[24000,44100,[1000,4000,8000,10000]],[24000,32000,[1000,4000,10000]],[24000,16000,[1000,4000,6000]],
  [48000,24000,[1000,4000,10000]],[44100,24000,[1000,4000,10000]],[16000,24000,[1000,4000,6000]],
  [24000,44056,[1000,10000]],[44056,24000,[1000,10000]]]; // a non-standard rate: 1024 quantized filter phases
 for(const [from,to,freqs] of inband)for(const f of freqs){const now=toneReport(run(R,from,to,tone(f,from,1.2)),to,f).spurDb,old=toneReport(run(Legacy,from,to,tone(f,from,1.2)),to,f).spurDb;
  console.log(`# images ${from}->${to} ${f} Hz tone: worst other component ${f1(now)} dB (legacy ${f1(old)} dB)`);
  if(now>-50)bad.push(`${from}->${to} ${f} Hz: spur ${f1(now)} dB`);}
 // Out-of-band tones above the output Nyquist: whatever reaches the output is an alias folded into the speech band.
 const outband=[[24000,16000,[9000,10000,11000]],[48000,24000,[13000,15000,20000]],[44100,24000,[13000,15000,20000]]];
 for(const [from,to,freqs] of outband)for(const f of freqs){const peak=y=>{const s=analyze(y,to);return dB(Math.max(...s.mag)/.5);},now=peak(run(R,from,to,tone(f,from,1.2))),old=peak(run(Legacy,from,to,tone(f,from,1.2)));
  console.log(`# aliases ${from}->${to} ${f} Hz tone: strongest output ${f1(now)} dB re input (legacy ${f1(old)} dB)`);
  if(now>-50)bad.push(`${from}->${to} ${f} Hz aliases at ${f1(now)} dB`);}
 assert.deepEqual(bad,[]);
});

test('a 1 kHz tone keeps its frequency and its level',()=>{
 for(const [from,to] of [[24000,48000],[24000,44100],[24000,32000],[24000,16000],[48000,24000],[44100,24000],[16000,24000]]){
  const y=run(R,from,to,tone(1000,from,1.2)),hz=peakHz(y,to),level=toneReport(y,to,1000).levelDb;
  console.log(`# 1 kHz ${from}->${to}: ${f2(hz)} Hz, ${level.toFixed(3)} dB`);
  assert.ok(Math.abs(hz-1000)<.5,`${from}->${to} frequency ${hz}`);assert.ok(Math.abs(level)<.1,`${from}->${to} level ${level}`);}
});

test('group delay is small (under 3 ms) and stated',()=>{
 const bad=[];for(const [from,to] of [[24000,48000],[24000,44100],[24000,16000],[48000,24000],[44100,24000],[16000,24000]]){
  const now=impulseDelayMs(R,from,to),old=impulseDelayMs(Legacy,from,to);
  console.log(`# group delay ${from}->${to}: ${f2(now)} ms (legacy ${f2(old)} ms; added ${f2(now-old)} ms)`);
  if(!(now>0&&now<3))bad.push(`${from}->${to} delay ${f2(now)} ms`);}
 assert.deepEqual(bad,[]);
});

test('output schedule is unchanged: every block yields exactly as many samples as before, for any block split',()=>{
 for(const [from,to] of [[48000,24000],[44100,24000],[32000,24000],[16000,24000],[24000,48000],[24000,44100],[24000,32000],[24000,16000],[22050,24000],[96000,24000],[44056,24000],[24000,44056],[24000,24000]]){
  const r=new R(from,to),old=new Legacy(from,to),x=tone(700,from,.5);let i=0,step=0;const sizes=[128,1,7,480,127,1000,2,4000];
  while(i<x.length){const len=Math.min(sizes[step++%sizes.length],x.length-i),block=x.subarray(i,i+len);assert.equal(r.push(block).length,old.push(block).length,`${from}->${to} block ${step}`);i+=len;}}
});

test('streaming keeps filter state across blocks: any block split gives identical samples',()=>{
 for(const [from,to] of [[24000,48000],[24000,44100],[48000,24000],[44100,24000],[24000,16000]]){
  const x=tone(3000,from,.3),whole=run(R,from,to,x,x.length),blocks=run(R,from,to,x,128),odd=run(R,from,to,x,37);
  assert.deepEqual(blocks,whole,`${from}->${to} 128-sample blocks`);assert.deepEqual(odd,whole,`${from}->${to} 37-sample blocks`);}
});

test('CPU: multiply-accumulates per second at 48 kHz, and real-time headroom',()=>{
 const play=new R(24000,48000),mic=new R(48000,24000);
 const macs=play.taps*48000+mic.taps*24000;
 console.log(`# 48 kHz: playback ${play.taps} taps x 48000/s + microphone ${mic.taps} taps x 24000/s = ${(macs/1e6).toFixed(2)} M MAC/s`);
 assert.ok(macs<8e6,`${macs} MAC/s`);
 const seconds=10,chunk=new Int16Array(480).fill(1000),block=tone(1000,48000,128/48000);for(let i=0;i<50;i++){play.write(chunk,480,1/32768);mic.write(block);}
 const t0=process.hrtime.bigint();for(let i=0;i<seconds*50;i++)play.write(chunk,480,1/32768);for(let i=0;i<seconds*375;i++)mic.write(block);
 const ms=Number(process.hrtime.bigint()-t0)/1e6;console.log(`# ${seconds} s of duplex 48 kHz audio resampled in ${f1(ms)} ms (${f2(100*ms/(seconds*1000))}% of one core)`);
 assert.ok(ms<seconds*1000*.2,`${ms} ms for ${seconds} s`);
});

test('process() reuses preallocated buffers (no per-sample or per-block allocation)',()=>{
 const {processor}=load(48000),p=processor();p.port.onmessage({data:{type:'state',enabled:true}});
 const input=[[tone(500,48000,128/48000)]],output=[[new Float32Array(128)]];p.process(input,output);
 const out=p.inputRate.out;assert.ok(out instanceof Float32Array);
 for(let i=0;i<200;i++){p.process(input,output);p.process([],output);}
 assert.equal(p.inputRate.out,out,'resampler output buffer is reused');
});

// The same resampler, wired into the worklet at a 48 kHz device rate.
test('48 kHz worklet: model speech plays back clean and a microphone tone reaches the 480-sample frames clean',()=>{
 const {processor,messages}=load(48000),p=processor();const src=tone(1000,24000,1.5);const played=[];let fed=0;
 for(let guard=0;guard<4000&&played.length<(NFFT+4800);guard++){while(fed<src.length&&p.count<48000*.2){const pcm=new Int16Array(480);for(let i=0;i<480;i++)pcm[i]=Math.round(src[fed+i]*32767);fed+=480;p.port.onmessage({data:{type:'audio',buffer:pcm.buffer,item_id:'a'}});}
  const out=new Float32Array(128);p.process([],[[out]]);if(p.playing)played.push(...out);}
 const speaker=toneReport(Float32Array.from(played),48000,1000);console.log(`# 48 kHz speaker: 1 kHz at ${f2(speaker.levelDb)} dB, worst other component ${f1(speaker.spurDb)} dB`);
 const bad=[];if(!(Math.abs(speaker.levelDb)<.1&&speaker.spurDb<=-50))bad.push('speaker');
 for(const [freq,alias] of [[1000,false],[15000,true]]){messages.length=0;const q=processor();q.port.onmessage({data:{type:'state',enabled:true}});const mic=tone(freq,48000,1.2);
  for(let i=0;i<mic.length;i+=128)q.process([[mic.subarray(i,i+128)]],[[new Float32Array(128)]]);
  const frames=messages.filter(m=>m.type==='pcm');assert.ok(frames.every(m=>m.buffer.byteLength===960));const pcm=Float32Array.from(frames.flatMap(m=>[...new Int16Array(m.buffer)]),v=>v/32768);
  if(alias){const s=analyze(pcm,24000),peak=dB(Math.max(...s.mag)/.5);console.log(`# 48 kHz microphone: 15 kHz tone reaches the 24 kHz frames at ${f1(peak)} dB`);if(peak>-50)bad.push('microphone alias');}
  else{const r=toneReport(pcm,24000,1000);console.log(`# 48 kHz microphone: 1 kHz at ${f2(r.levelDb)} dB, worst other component ${f1(r.spurDb)} dB`);if(!(Math.abs(r.levelDb)<.1&&r.spurDb<=-50))bad.push('microphone tone');}}
 assert.deepEqual(bad,[]);
});

test('flush discards the filter memory of cut-off speech: the next reply starts from silence',()=>{
 const {processor}=load(48000),p=processor();const loud=new Int16Array(2400);for(let i=0;i<loud.length;i++)loud[i]=Math.round(20000*Math.sin(2*Math.PI*1234*i/24000+.7));
 p.port.onmessage({data:{type:'audio',buffer:loud.buffer,item_id:'a'}});p.port.onmessage({data:{type:'flush'}});
 p.port.onmessage({data:{type:'audio',buffer:new Int16Array(4800).buffer,item_id:'b'}});const out=new Float32Array(128);let peak=0;
 for(let i=0;i<60;i++){p.process([],[[out]]);for(const v of out)peak=Math.max(peak,Math.abs(v));}
 assert.equal(peak,0,'no sound from the flushed reply');
});

// voice-client.js used to insert a BiquadFilter lowpass (11 kHz, Q .707) before the worklet when the device rate is above
// 24 kHz. Web Audio's lowpass treats Q as resonance in dB, so that filter is not flat: it would push the microphone path
// outside the 1 dB passband on its own, and the worklet's FIR is now the anti-alias filter (>= 50 dB, measured above).
test('microphone graph has no extra biquad: its response alone breaks the 1 dB passband',()=>{
 const biquadDb=(f,rate,f0=11000,q=.707)=>{const w0=2*Math.PI*f0/rate,alpha=Math.sin(w0)/(2*10**(q/20)),c=Math.cos(w0),b0=(1-c)/2,b1=1-c,b2=(1-c)/2,a0=1+alpha,a1=-2*c,a2=1-alpha;
  const w=2*Math.PI*f/rate,num=[b0+b1*Math.cos(w)+b2*Math.cos(2*w),-(b1*Math.sin(w)+b2*Math.sin(2*w))],den=[a0+a1*Math.cos(w)+a2*Math.cos(2*w),-(a1*Math.sin(w)+a2*Math.sin(2*w))];return dB(Math.hypot(...num)/Math.hypot(...den));};
 for(const rate of [48000,44100,32000]){let lo=0,hi=0;for(let f=100;f<=10000;f+=50){const v=biquadDb(f,rate);lo=Math.min(lo,v);hi=Math.max(hi,v);}
  console.log(`# removed biquad at ${rate} Hz: ${f2(lo)} to +${f2(hi)} dB over 100 Hz-10 kHz`);assert.ok(hi-lo>1);}
 for(const file of ['voice-client.js','ask-ui.js']){ // every page that feeds a microphone into this worklet
  const code=fs.readFileSync(__dirname+'/../src/'+file,'utf8');
  assert.ok(!/createBiquadFilter/.test(code),file+' connects the microphone straight to the worklet');}
});
