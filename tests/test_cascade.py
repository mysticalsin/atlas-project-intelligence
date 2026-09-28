"""Kyutai cascaded voice route: synthetic STT/TTS/LLM services only.
No Kyutai server, LLM provider, GPU or microphone is contacted. Constant PCM is a transport payload, not speech.
"""
import asyncio,json,socket
from dataclasses import replace
import aiohttp,msgpack,pytest
from aiohttp import web
from atlas_voice.config import Config
from atlas_voice.server import create_app
from atlas_voice.kyutai import TurnDetector,pcm16_to_float,float_to_pcm16,stream_chat,WARMUP_STEPS
from atlas_voice.cascade import WordChunker,talker_messages
from tests.test_voice import serve,PROJECT

P=lambda v:msgpack.packb(v,use_bin_type=True,use_single_float=True)
ANSWER='We cut triage time by 40% after the rollout'

# ---------- unit (no sockets) ----------
def test_pcm_round_trip_and_clamping():
    data=b'\x00\x00\xff\x7f\x00\x80'
    floats=pcm16_to_float(data);assert floats[0]==0 and floats[1]>0.99 and floats[2]==-1.0
    assert float_to_pcm16([0.0,2.0,-2.0])==b'\x00\x00\xff\x7f\x01\x80'

def test_turn_detector_waits_for_words_warmup_and_pause():
    d=TurnDetector()
    for _ in range(WARMUP_STEPS):assert d.step([0,0,0.99]) is None
    assert d.step([0,0,0.99]) is None  # no words yet
    d.word('We');d.word('cut');assert d.step([0,0,0.2]) is None
    assert d.step([0,0,0.9])=='We cut' and d.step([0,0,0.9]) is None
    d.word('x');assert d.step('bad') is None and d.step([1]) is None

def test_word_chunker_never_splits_words():
    c=WordChunker();out=[c.feed(x) for x in ('Hel','lo th','ere, how',' are')]
    assert out==['','Hello ','there, ','how '] and c.flush()=='are'

def test_talker_gets_policy_guidance_and_untrusted_markers():
    m=talker_messages({'alias':'X'},'pref',{'field':'measurement','question':'Before and after?'},[{'role':'user','content':'hi'}]*30,'open')
    assert 'NO tools' in m[0]['content'] and 'UNTRUSTED PROJECT DATA' in m[0]['content'] and 'exactly ONE question' in m[0]['content']
    # cache-friendly order: policy, append-only history (all 30 kept, HISTORY=40), then the per-turn guidance, then the instruction
    assert m[1]=={'role':'user','content':'hi'} and m[-2]['content'].startswith('ANALYST_GUIDANCE') and m[-1]=={'role':'user','content':'open'} and len(m)==1+30+1+1

class Content:
    def __init__(self,parts):self.parts=parts
    async def iter_any(self):
        for p in self.parts:yield p
class SSE:
    def __init__(self,parts):self.content=Content(parts)
    async def __aenter__(self):return self
    async def __aexit__(self,*a):return False
    def raise_for_status(self):pass
class Http:
    def __init__(self,parts):self.parts=parts
    def post(self,url,headers,json,timeout):assert json['stream'] is True;return SSE(self.parts)

def test_stream_chat_parses_split_sse_and_stops_at_done():
    parts=[b'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"choi',b'ces":[{"delta":{"content":"lo"}}]}\n\n: keepalive\ndata: [DONE]\n\ndata: {"choices":[{"delta":{"content":"late"}}]}\n']
    async def collect():return [d async for d in stream_chat(Http(parts),'https://x.example.com','m','',[])]
    assert asyncio.run(collect())==['Hel','lo']

def test_kyutai_config_contract():
    good=dict(voice_provider='kyutai',kyutai_stt_url='wss://stt.example.com',kyutai_tts_url='wss://tts.example.com',
              conversation_url='https://api.example.com/v1/chat/completions',conversation_model='@cf/meta/llama-3.3-70b-instruct-fp8-fast',
              kyutai_voice='vctk/p225_023.wav',max_interviews=30)
    assert Config(**good).validate().max_interviews==30
    for bad in ({'kyutai_stt_url':''},{'kyutai_tts_url':'ws://tts.example.com'},{'conversation_model':''},
                {'kyutai_voice':'../etc/passwd'},{'kyutai_voice':''},{'kyutai_voice':'expresso/ex03.wav'},{'kyutai_voice':'ears/p001.wav'},{'conversation_url':'http://api.example.com/v1'}):
        with pytest.raises(ValueError):Config(**{**good,**bad}).validate()

# ---------- integration (binds loopback ports) ----------
class Services:
    def __init__(self):self.tts_texts=[];self.stt_audio=0;self.chat_bodies=[];self.tts_sessions=0
    async def stt(self,request):
        assert request.headers.get('kyutai-api-key')=='FIXTURE'
        ws=web.WebSocketResponse();await ws.prepare(request);await ws.send_bytes(P({'type':'Ready'}))
        sent=False
        async for m in ws:
            v=msgpack.unpackb(m.data);assert v['type']=='Audio' and all(-1<=x<=1 for x in v['pcm'])
            self.stt_audio+=1
            if self.stt_audio==3 and not sent:
                sent=True
                for _ in range(WARMUP_STEPS):await ws.send_bytes(P({'type':'Step','step_idx':0,'prs':[0,0,0]}))
                for w in ANSWER.split():await ws.send_bytes(P({'type':'Word','text':w,'start_time':0.0}))
                await ws.send_bytes(P({'type':'Step','step_idx':1,'prs':[0,0,0.95]}))
        return ws
    async def tts(self,request):
        assert request.query['format']=='PcmMessagePack' and request.query['voice']=='fixture-voice'
        self.tts_sessions+=1
        ws=web.WebSocketResponse();await ws.prepare(request);await ws.send_bytes(P({'type':'Ready'}))
        async for m in ws:
            v=msgpack.unpackb(m.data)
            if v['type']=='Text':self.tts_texts.append(v['text'])
            if v['type']=='Eos':
                await ws.send_bytes(P({'type':'Audio','pcm':[0.05]*4800}));await ws.close();break
        return ws
    async def chat(self,request):
        body=await request.json();self.chat_bodies.append(body)
        if body.get('tools'):
            data=json.loads(body['messages'][1]['content'].split('\n',1)[1]);ident=data['new_segment']['item_id']
            return web.json_response({'choices':[{'message':{'tool_calls':[{'id':'c-'+ident,'function':{'name':'record_details',
              'arguments':json.dumps({'details':[{'field':'outcome','item_id':ident,'quote':'We cut triage time by 40%'}]})}}]}}]})
        resp=web.StreamResponse(headers={'Content-Type':'text/event-stream'});await resp.prepare(request)
        for part in ('Thanks. ','What was ','the baseline?'):
            await resp.write(('data: '+json.dumps({'choices':[{'delta':{'content':part}}]})+'\n\n').encode())
        await resp.write(b'data: [DONE]\n\n');return resp

@pytest.mark.asyncio
async def test_cascade_session_speaks_listens_records_evidence_and_notes(tmp_path):
    svc=Services();mock=web.Application()
    mock.router.add_get('/api/asr-streaming',svc.stt);mock.router.add_get('/api/tts_streaming',svc.tts);mock.router.add_post('/chat',svc.chat)
    runner,port=await serve(mock);base=f'127.0.0.1:{port}'
    with socket.socket() as sock:sock.bind(('127.0.0.1',0));gp=sock.getsockname()[1]
    origin=f'http://127.0.0.1:{gp}'
    cfg=replace(Config(),origin=origin,port=gp,voice_provider='kyutai',kyutai_stt_url='ws://'+base,kyutai_tts_url='ws://'+base,kyutai_key='FIXTURE',
                kyutai_voice='fixture-voice',conversation_url=f'http://{base}/chat',conversation_model='fixture-talker',
                analyst_url=f'http://{base}/chat',analyst_model='fixture-analyst',max_interviews=4)
    app=create_app(cfg);r=web.AppRunner(app,access_log=None);await r.setup();await web.TCPSite(r,'127.0.0.1',gp).start()
    try:
        async with aiohttp.ClientSession(cookie_jar=aiohttp.CookieJar(unsafe=True)) as c:
            await c.get(origin);b=await(await c.get(origin+'/api/bootstrap')).json()
            assert b['provider']=='kyutai' and b['liveLedger'] and not b['playbackAck'] and b['capacity']==4 and b['voices']==['fixture-voice']
            ws=await c.ws_connect(origin+'/api/voice',headers={'Origin':origin})
            await ws.send_json({'type':'start','consent':True,'csrf':b['csrf'],'project':PROJECT,'voice':'fixture-voice','capture':True,'memory':False})
            seen=[];audio=0;quality=None;ready=False
            async def pump(until,limit=200):
                nonlocal audio,quality,ready
                for _ in range(limit):
                    m=await asyncio.wait_for(ws.receive(),5)
                    if m.type==aiohttp.WSMsgType.BINARY:assert ready;audio+=len(m.data)
                    elif m.type==aiohttp.WSMsgType.TEXT:
                        d=json.loads(m.data);seen.append(d);assert d['type']!='error',d
                        if d['type']=='ready':ready=True
                        if d['type']=='quality':quality=d
                    if until():return
                raise AssertionError('condition not reached')
            await pump(lambda:audio>=9600)  # opening question synthesised and played
            assert ''.join(svc.tts_texts).strip()=='Thanks. What was the baseline?'
            for _ in range(4):await ws.send_bytes(b'\x10\x00'*960)
            await pump(lambda:quality is not None)
            texts=[d for d in seen if d['type']=='user_text'];assert texts[0]['text']==ANSWER and texts[0]['provenance']=='unverified_speech_recognition'
            assert quality['candidate_details'][0]['quote']=='We cut triage time by 40%' and quality['next_field']=='measurement'
            talker=[x for x in svc.chat_bodies if not x.get('tools')]
            await pump(lambda:len([x for x in svc.chat_bodies if not x.get('tools')])>=2 and svc.tts_sessions>=2,400)
            second=[x for x in svc.chat_bodies if not x.get('tools')][1]
            assert any(m['content']==ANSWER for m in second['messages'] if m['role']=='user')
            assert any(m['content'].startswith('ANALYST_GUIDANCE') and 'measurement' in m['content'] for m in second['messages'])
            assert all('record_details' not in json.dumps(x.get('tools',[])) for x in talker)
            await ws.send_json({'type':'end'});notes=None
            for _ in range(400):
                m=await asyncio.wait_for(ws.receive(),5)
                if m.type!=aiohttp.WSMsgType.TEXT:continue
                d=json.loads(m.data);seen.append(d)
                if d['type']=='notes':notes=d
                if d['type']=='ended':break
            assert notes['status']=='candidate' and notes['sections'][3]=='We cut triage time by 40%'
            agent=''.join(d['text'] for d in seen if d['type']=='agent_text')
            assert agent.startswith('Thanks.') and '\n\nThanks.' in agent  # replies separated on screen
            assert 'Thanks' not in notes['transcript']
            assert not app['voice_gate'].locked()
    finally:
        await r.cleanup();await runner.cleanup()

def test_load_script_verdicts():
    import importlib.util,pathlib
    spec=importlib.util.spec_from_file_location('load_kyutai',pathlib.Path(__file__).resolve().parents[1]/'scripts/load_kyutai.py')
    m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
    assert m.verdict(0,[1.0,0.99],0,[(0.3,2.0)])=='kept up'
    assert m.verdict(0,[0.8],0,[(0.3,2.0)])=='STT fell behind real time'
    assert m.verdict(0,[1.0],0,[(0.3,0.7)])=='TTS slower than real time'
    assert m.verdict(1,[],0,[])=='over capacity (sessions refused or failed)'
    assert m.summarize([1,2,3,4])['median']==2.5 and m.summarize([])is None
