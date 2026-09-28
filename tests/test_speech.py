"""Speech backends: turn detection, sentence streaming, Workers AI request shapes. No network."""
import asyncio,io,json,math,struct,wave
from types import SimpleNamespace
import pytest
from atlas_voice.speech import EnergyTurns,WorkersSpeech,sentences,wav_bytes,SAMPLE_RATE
from atlas_voice.config import Config

def tone(seconds,amp):
    n=int(SAMPLE_RATE*seconds);return struct.pack('<%dh'%n,*(int(amp*32767*math.sin(2*math.pi*180*i/SAMPLE_RATE)) for i in range(n)))
def frames(pcm,size=960):return [pcm[i:i+size] for i in range(0,len(pcm),size)]

def run_turns(pcm,agent=False):
    t=EnergyTurns();starts=0;utts=[]
    for f in frames(pcm):
        s,u=t.feed(f,agent);starts+=s
        if u:utts.append(u)
    return starts,utts

def test_speech_between_silences_is_one_utterance_with_preroll():
    pcm=tone(1.3,.001)+tone(1.2,.2)+tone(1.3,.001)
    starts,utts=run_turns(pcm)
    assert starts==1 and len(utts)==1 and 1.2*SAMPLE_RATE*2<=len(utts[0])<=2.8*SAMPLE_RATE*2

def test_short_pause_does_not_split_a_turn_and_blips_do_not_start_one():
    starts,utts=run_turns(tone(.5,.001)+tone(.6,.2)+tone(.4,.001)+tone(.6,.2)+tone(1.3,.001))
    assert len(utts)==1
    assert run_turns(tone(.5,.001)+tone(.04,.3)+tone(1.3,.001))==(0,[])

def test_quiet_echo_during_agent_speech_is_not_a_barge_in():
    assert run_turns(tone(.5,.001)+tone(.8,.03)+tone(1.3,.001),agent=True)[0]==0
    assert run_turns(tone(.5,.001)+tone(.8,.2)+tone(1.3,.001),agent=True)[0]==1

def test_sentence_streaming():
    assert sentences('Thanks. What was the baseline? And')==(['Thanks.','What was the baseline?'],'And')
    assert sentences('No end yet')==([],'No end yet')

def test_wav_header():
    with wave.open(io.BytesIO(wav_bytes(b'\0\0'*10))) as w:assert (w.getframerate(),w.getnchannels(),w.getsampwidth(),w.getnframes())==(24000,1,2,10)

class Resp:
    def __init__(self,data,ctype):self.data=data;self.content_type=ctype
    async def __aenter__(self):return self
    async def __aexit__(self,*a):return False
    def raise_for_status(self):pass
    async def json(self):return self.data
    async def read(self):return self.data
class Http:
    def __init__(self):self.calls=[]
    def post(self,url,**kw):
        self.calls.append((url,kw))
        if 'nova-3' in url:return Resp({'result':{'results':{'channels':[{'alternatives':[{'transcript':' We cut triage time. '}]}]}}},'application/json')
        return Resp(b'\x01\x00'*2400,'application/octet-stream')

CFG=SimpleNamespace(workers_account='294885a27b3cc0a1cbe5d0ccbe38de4f',workers_key='SERVER-KEY',workers_stt_model='@cf/deepgram/nova-3',workers_tts_model='@cf/deepgram/aura-2-en',workers_voice='harmonia')

def test_transcribe_and_synthesize_request_shapes():
    http=Http();sp=WorkersSpeech(CFG,http)
    assert asyncio.run(sp.transcribe(b'\0\0'*2400))=='We cut triage time.'
    url,kw=http.calls[0]
    assert url.endswith('/accounts/294885a27b3cc0a1cbe5d0ccbe38de4f/ai/run/@cf/deepgram/nova-3') and kw['headers']['Content-Type']=='audio/wav'
    assert kw['headers']['Authorization']=='Bearer SERVER-KEY' and kw['data'][:4]==b'RIFF'
    pcm=asyncio.run(sp.synthesize('Hello.'));url,kw=http.calls[1]
    assert url.endswith('@cf/deepgram/aura-2-en') and kw['json']=={'text':'Hello.','speaker':'harmonia','encoding':'linear16','container':'none','sample_rate':24000}
    assert len(pcm)==4800

def test_speak_synthesizes_sentence_by_sentence_as_text_streams():
    http=Http();sp=WorkersSpeech(CFG,http);out=[]
    async def deltas():
        for d in ('Thanks. What ','was the base','line? Ok'):yield d
    async def emit(p):out.append(p)
    asyncio.run(sp.speak(deltas(),emit))
    assert [kw['json']['text'] for _,kw in http.calls]==['Thanks.','What was the baseline?','Ok'] and sum(map(len,out))==3*4800

def test_events_yield_voice_then_transcribed_turn():
    http=Http();sp=WorkersSpeech(CFG,http)
    async def go():
        for f in frames(tone(.5,.001)+tone(1,.2)+tone(1.3,.001)):await sp.feed(f)
        got=[];agen=sp.events()
        for _ in range(2):got.append(await agen.__anext__())
        return got
    assert asyncio.run(go())==[('voice',None),('turn','We cut triage time.')]

def test_workers_config_contract():
    base=dict(voice_provider='workers',workers_account=CFG.workers_account,workers_key='k',conversation_url='https://api.cloudflare.com/x',conversation_model='@cf/meta/llama-3.3-70b-instruct-fp8-fast')
    assert Config(**base).validate()
    for bad in ({'workers_account':'nothex'},{'workers_key':''},{'workers_voice':'robot'},{'workers_tts_model':'aura'},{'conversation_model':''}):
        with pytest.raises(ValueError):Config(**{**base,**bad}).validate()

def test_echo_of_agent_words_is_detected_but_real_answers_are_not():
    from atlas_voice.speech import is_echo
    agent = "I'm ATLAS, here to discuss your project experience. What problem were you trying to solve with Project Falcon?"
    assert is_echo('what problem were you trying to solve', agent)
    assert not is_echo('Tickets were bouncing between three support teams', agent)
    assert not is_echo('yes', agent) and not is_echo('a b c', '')
