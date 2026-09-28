"""Hosted voice adapter contract tests against a labelled synthetic WebSocket provider.
No OpenAI, microphone, NVIDIA, or billable API is called.
"""
import asyncio,base64,json,contextlib
from dataclasses import replace
import aiohttp
from aiohttp import web
import pytest
from atlas_voice.config import Config
from atlas_voice.server import create_app
from tests.test_voice import serve,PROJECT

class SyntheticRealtime:
 def __init__(self):self.events=[];self.started=False;self.truncated=None;self.sent_quote=False
 async def handler(self,request):
  ws=web.WebSocketResponse();await ws.prepare(request)
  async for msg in ws:
   if msg.type!=aiohttp.WSMsgType.TEXT:continue
   e=json.loads(msg.data);self.events.append(e);t=e['type']
   if t=='session.update':
    self.config=e['session'];await ws.send_json({'type':'session.updated','session':e['session']})
   elif t=='response.create' and not self.started:
    self.started=True
    await ws.send_json({'type':'response.created','response':{'id':'response-1'}})
    await ws.send_json({'type':'response.output_audio_transcript.delta','response_id':'response-1','delta':'TEST FIXTURE — NOT HUMAN SPEECH'})
    # Constant PCM is a synthetic transport payload, NOT a voice recording.
    await ws.send_json({'type':'response.output_audio.delta','response_id':'response-1','item_id':'assistant-1','delta':base64.b64encode(b'\x01\x04'*7200).decode()})
   elif t=='input_audio_buffer.append' and not self.sent_quote:
    self.sent_quote=True
    await ws.send_json({'type':'conversation.item.input_audio_transcription.completed','item_id':'user-1','transcript':'We estimate 40% less triage time.'})
    await ws.send_json({'type':'response.done','response':{'id':'tool-response','output':[{'type':'function_call','name':'record_details','call_id':'call-1','arguments':json.dumps({'details':[{'field':'outcome','item_id':'user-1','quote':'We estimate 40% less triage time.'}]})}]}})
   elif t=='conversation.item.create' and e['item'].get('type')=='function_call_output':
    await ws.send_json({'type':'input_audio_buffer.speech_started'})
   elif t=='conversation.item.truncate':self.truncated=e
  return ws

@pytest.mark.asyncio
async def test_hosted_socket_pcm_tools_interruption_and_notes(monkeypatch,tmp_path):
 fixture=SyntheticRealtime();mock=web.Application();mock.router.add_get('/voice',fixture.handler);runner,port=await serve(mock)
 original=aiohttp.ClientSession.ws_connect
 def redirect(self,url,*a,**kw):
  if str(url).startswith('wss://api.openai.com/v1/realtime'):
   assert kw['headers']['Authorization']=='Bearer FIXTURE-NOT-A-KEY'
   return original(self,f'http://127.0.0.1:{port}/voice',*a,**kw)
  return original(self,url,*a,**kw)
 monkeypatch.setattr(aiohttp.ClientSession,'ws_connect',redirect)
 import socket
 with socket.socket() as sock:sock.bind(('127.0.0.1',0));gp=sock.getsockname()[1]
 origin=f'http://127.0.0.1:{gp}';cfg=replace(Config(),origin=origin,port=gp,voice_provider='openai',openai_key='FIXTURE-NOT-A-KEY',wiki_root=str(tmp_path/'vault'))
 app=create_app(cfg);r=web.AppRunner(app,access_log=None);await r.setup();await web.TCPSite(r,'127.0.0.1',gp).start()
 try:
  async with aiohttp.ClientSession(cookie_jar=aiohttp.CookieJar(unsafe=True)) as c:
   await c.get(origin);b=await(await c.get(origin+'/api/bootstrap')).json();assert b['provider']=='openai' and b['wiki']
   ws=await c.ws_connect(origin+'/api/voice',headers={'Origin':origin})
   await ws.send_json({'type':'start','consent':True,'csrf':b['csrf'],'project':PROJECT,'voice':'cedar','capture':True,'memory':False})
   seen=[];audio=0;ready=False
   while audio<2880:
    m=await asyncio.wait_for(ws.receive(),5)
    if m.type==aiohttp.WSMsgType.TEXT:
     d=json.loads(m.data);seen.append(d)
     if d['type']=='ready':ready=True
     assert d['type']!='error',d
    elif m.type==aiohttp.WSMsgType.BINARY:assert ready;audio+=len(m.data)
   await ws.send_json({'type':'playback','item_id':'assistant-1','played_ms':20})
   await ws.send_bytes(b'\0\0'*480)
   got_quality=False;got_clear=False
   for _ in range(40):
    m=await asyncio.wait_for(ws.receive(),5)
    if m.type!=aiohttp.WSMsgType.TEXT:continue
    d=json.loads(m.data);seen.append(d)
    if d['type']=='quality':
     assert d['next_field']=='measurement' and d['candidate_details'][0]['status']=='uncertain';got_quality=True
    if d['type']=='clear_audio':got_clear=True
    if got_quality and got_clear:break
   await asyncio.sleep(.08)
   assert got_quality and got_clear
   assert fixture.truncated and fixture.truncated['audio_end_ms']==20
   await ws.send_json({'type':'end'});notes=None
   while True:
    m=await asyncio.wait_for(ws.receive(),5)
    if m.type!=aiohttp.WSMsgType.TEXT:continue
    d=json.loads(m.data)
    if d['type']=='notes':notes=d
    if d['type']=='ended':break
   assert notes['sections'][3]=='We estimate 40% less triage time.' and 'TEST FIXTURE' not in notes['transcript']
   assert not app['voice_gate'].locked()
   assert fixture.config['audio']['input']['transcription']['model']=='gpt-transcribe'
   assert 'publish_story' not in [x['name'] for x in fixture.config['tools']]
   await ws.close()
 finally:await r.cleanup();await runner.cleanup()

@pytest.mark.asyncio
async def test_wiki_routes_csrf_candidates_and_no_local_publish(tmp_path):
 import socket
 with socket.socket() as sock:sock.bind(('127.0.0.1',0));p=sock.getsockname()[1]
 origin=f'http://127.0.0.1:{p}';app=create_app(replace(Config(),origin=origin,port=p,wiki_root=str(tmp_path/'vault')))
 r=web.AppRunner(app,access_log=None);await r.setup();await web.TCPSite(r,'127.0.0.1',p).start()
 from tests.test_quality import story
 try:
  async with aiohttp.ClientSession(cookie_jar=aiohttp.CookieJar(unsafe=True)) as c:
   await c.get(origin);b=await(await c.get(origin+'/api/bootstrap')).json();headers={'Origin':origin,'X-Atlas-CSRF':b['csrf']}
   assert (await c.post(origin+'/api/wiki',json={'story':story()})).status==403
   result=await c.post(origin+'/api/wiki',headers=headers,json={'story':story()});assert result.status==201;record=await result.json()
   result=await c.post(origin+'/api/wiki/'+record['id']+'/review',headers=headers,json={'expected_hash':record['content_hash'],'kind':'facts','reference':'local checkbox','expires_at':1900000000});assert result.status==403
   result=await c.post(origin+'/api/wiki/rank',headers=headers,json={'customer_brief':{},'audience':'customer-anonymized','consent':True});assert result.status==200 and (await result.json())['ranked']==[]
   assert (await c.get(origin+'/api/wiki/'+record['id'])).status==200
   result=await c.post(origin+'/api/wiki/'+record['id']+'/withdraw',headers=headers,json={'expected_hash':record['content_hash']});assert result.status==200
   assert not (await(await c.get(origin+'/api/wiki?audience=customer-anonymized')).json())['stories']
 finally:await r.cleanup()
