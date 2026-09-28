const test=require('node:test'),assert=require('node:assert/strict');
const {MotionRig}=require('../src/orb-renderer.js');
function step(r,level,n=30){for(let i=0;i<n;i++)r.step(1/60,0,level);return r.snapshot();}
test('silent speaking state does not create a phrase gesture',()=>{const r=new MotionRig();r.setState('speaking');const p=step(r,0,100);assert.equal(p.gestureIndex,0);assert.equal(p.gestureX,0);assert.equal(p.gestureY,0);});
test('audible onset gives one coherent gesture, not a per-frame twitch',()=>{const r=new MotionRig();r.setState('speaking');step(r,.14,60);const p=r.snapshot();assert.equal(p.gestureIndex,1);assert.ok(Math.abs(p.gestureY)>.001);step(r,.14,60);assert.equal(r.snapshot().gestureIndex,1);});
test('a new phrase needs an actual silence interval',()=>{const r=new MotionRig();r.setState('speaking');step(r,.15);step(r,0,8);step(r,.15);assert.equal(r.snapshot().gestureIndex,1);step(r,0,25);step(r,.15);assert.equal(r.snapshot().gestureIndex,2);});
test('gesture settles in silence with bounded position',()=>{const r=new MotionRig();r.setState('speaking');for(let i=0;i<30;i++){step(r,.14);step(r,0,30);}const p=step(r,0,300);assert.ok(Math.abs(p.gestureX)<1e-6&&Math.abs(p.gestureY)<1e-6);assert.ok(Math.abs(p.gestureX)<.03);});
test('phrase gestures deterministic for identical audio histories',()=>{const a=new MotionRig(),b=new MotionRig();a.setState('speaking');b.setState('speaking');for(let i=0;i<200;i++){const v=i%60<25?.14:0;a.step(1/60,0,v);b.step(1/60,0,v);}assert.deepEqual(a.snapshot(),b.snapshot());});
