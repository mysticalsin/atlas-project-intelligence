"""Concurrent interviews: bounded slots, one interview per signed-in subject.
Synthetic provider only; no OpenAI, microphone or NVIDIA call.
"""
import asyncio,json
from dataclasses import replace
import aiohttp
from aiohttp import web
import pytest
from atlas_voice.capacity import VoiceCapacity
from atlas_voice.config import Config
from atlas_voice.identity import COOKIE
from atlas_voice.server import create_app
from tests.test_voice import serve,PROJECT
from tests.test_realtime import SyntheticRealtime

def test_slots_are_bounded_and_per_subject():
    gate=VoiceCapacity(2)
    assert gate.try_acquire('a')=='ok' and gate.try_acquire('a')=='duplicate'
    assert gate.try_acquire('b')=='ok' and gate.locked() and gate.try_acquire('c')=='full' and gate.try_acquire('a')=='duplicate'
    gate.release('a');assert not gate.locked() and gate.try_acquire('c')=='ok'
    gate.release('unknown');assert gate.locked()

def test_default_single_slot_matches_former_lock():
    gate=VoiceCapacity();assert not gate.locked() and gate.try_acquire('a')=='ok' and gate.locked()
    gate.release('a');assert not gate.locked()

@pytest.mark.parametrize('limit',[0,-1,1.5,'2'])
def test_invalid_capacity_rejected(limit):
    with pytest.raises(ValueError):VoiceCapacity(limit)

def test_config_bounds_and_personaplex_stays_single():
    assert Config(voice_provider='openai',max_interviews=40).validate().max_interviews==40
    for bad in (0,101):
        with pytest.raises(ValueError):Config(voice_provider='openai',max_interviews=bad).validate()
    with pytest.raises(ValueError):Config(voice_provider='personaplex',max_interviews=2).validate()
    assert Config().validate().max_interviews==1

def test_env_reads_capacity(monkeypatch):
    monkeypatch.setenv('ATLAS_VOICE_PROVIDER','openai');monkeypatch.setenv('ATLAS_MAX_INTERVIEWS','25')
    assert Config.env().max_interviews==25

async def start(c,origin,csrf):
    ws=await c.ws_connect(origin+'/api/voice',headers={'Origin':origin})
    await ws.send_json({'type':'start','consent':True,'csrf':csrf,'project':PROJECT,'voice':'cedar','capture':False,'memory':False})
    while True:
        m=await asyncio.wait_for(ws.receive(),5)
        if m.type==aiohttp.WSMsgType.TEXT:
            d=json.loads(m.data)
            if d['type'] in ('ready','error'):return ws,d

@pytest.mark.asyncio
async def test_hosted_interviews_run_concurrently_up_to_limit(monkeypatch):
    fixture=SyntheticRealtime();mock=web.Application();mock.router.add_get('/voice',fixture.handler);runner,port=await serve(mock)
    original=aiohttp.ClientSession.ws_connect
    def redirect(self,url,*a,**kw):
        if str(url).startswith('wss://api.openai.com/v1/realtime'):return original(self,f'http://127.0.0.1:{port}/voice',*a,**kw)
        return original(self,url,*a,**kw)
    monkeypatch.setattr(aiohttp.ClientSession,'ws_connect',redirect)
    import socket
    with socket.socket() as sock:sock.bind(('127.0.0.1',0));gp=sock.getsockname()[1]
    origin=f'http://127.0.0.1:{gp}'
    app=create_app(replace(Config(),origin=origin,port=gp,voice_provider='openai',openai_key='FIXTURE-NOT-A-KEY',max_interviews=2))
    r=web.AppRunner(app,access_log=None);await r.setup();await web.TCPSite(r,'127.0.0.1',gp).start()
    clients=[];sockets=[]
    try:
        users=[]
        for n in range(3):
            key,session=app['identity'].issue('synthetic-tenant',f'user-{n}',f'Synthetic {n}')
            jar=aiohttp.CookieJar(unsafe=True);jar.update_cookies({COOKIE:key},aiohttp.client.URL(origin))
            c=aiohttp.ClientSession(cookie_jar=jar);clients.append(c);users.append((c,session.csrf))
        a,da=await start(users[0][0],origin,users[0][1]);b,db=await start(users[1][0],origin,users[1][1]);sockets+=[a,b]
        assert da['type']=='ready' and db['type']=='ready' and app['voice_gate'].locked()
        c3,d3=await start(users[2][0],origin,users[2][1]);sockets.append(c3)
        assert d3['type']=='error' and 'slots' in d3['message']
        dup,dd=await start(users[0][0],origin,users[0][1]);sockets.append(dup)
        assert dd['type']=='error' and 'already have an interview' in dd['message']
        await a.close()
        for _ in range(50):
            if not app['voice_gate'].locked():break
            await asyncio.sleep(.05)
        assert not app['voice_gate'].locked()
        c4,d4=await start(users[2][0],origin,users[2][1]);sockets.append(c4)
        assert d4['type']=='ready'
    finally:
        for s in sockets:await s.close()
        for c in clients:await c.close()
        await r.cleanup();await runner.cleanup()

def test_signed_in_session_cap_is_configurable():
    from aiohttp import web as w
    from atlas_voice.identity import Identity
    ident=Identity(Config(max_sessions=10))
    for n in range(10):ident.issue('t',f'o{n}','x')
    with pytest.raises(w.HTTPServiceUnavailable):ident.issue('t','o10','x')
    for bad in (9,20001):
        with pytest.raises(ValueError):Config(max_sessions=bad).validate()
    assert Config(max_sessions=3000).validate().max_sessions==3000
