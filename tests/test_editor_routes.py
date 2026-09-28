"""Real HTTP route checks; editorial provider replaced with an explicit local fixture."""
import socket
import time
from dataclasses import replace
import aiohttp
from aiohttp import web
import pytest
from atlas_voice.server import create_app
from atlas_voice.config import Config
from atlas_voice.editor import StoryEditor, parse_edit
from tests.test_quality import story, person
from tests.test_depth import edit

@pytest.mark.asyncio
async def test_editor_route_consent_exact_version_and_no_auto_save(monkeypatch,tmp_path):
 calls=[]
 async def fixture(self,record,objective):calls.append(record['content_hash']);return parse_edit(edit(record),record)
 monkeypatch.setattr(StoryEditor,'refine',fixture)
 with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
 origin=f'http://127.0.0.1:{port}';app=create_app(replace(Config(),origin=origin,port=port,wiki_root=str(tmp_path/'vault')))
 runner=web.AppRunner(app,access_log=None);await runner.setup();await web.TCPSite(runner,'127.0.0.1',port).start()
 try:
  async with aiohttp.ClientSession(cookie_jar=aiohttp.CookieJar(unsafe=True)) as client:
   await client.get(origin);boot=await(await client.get(origin+'/api/bootstrap')).json();h={'Origin':origin,'X-Atlas-CSRF':boot['csrf']}
   saved=await(await client.post(origin+'/api/wiki',headers=h,json={'story':story()})).json();path=origin+'/api/wiki/'+saved['id']+'/refine'
   d={'expected_hash':saved['content_hash'],'objective':'Explain mechanism and limitations','consent':True}
   assert (await client.post(path,json=d)).status==403
   assert (await client.post(path,headers=h,json={**d,'consent':False})).status==400
   assert (await client.post(path,headers=h,json={**d,'expected_hash':'stale'})).status==400
   response=await client.post(path,headers=h,json=d);assert response.status==200;result=await response.json()
   assert result['status']=='restricted-candidate' and result['based_on']['content_hash']==saved['content_hash']
   current=await(await client.get(origin+'/api/wiki/'+saved['id'])).json();assert current['revision']==1 and not current['eligible']
   assert calls==[saved['content_hash']]
   # Knowledge authorization is rechecked after the asynchronous editor returns.
   async def changed(self,record,objective):
    # Direct registry withdrawal is an explicit test of an operator action during a pending response.
    app['wiki'].db.execute('UPDATE stories SET withdrawn=1 WHERE id=?',(record['id'],));app['wiki'].db.commit()
    return parse_edit(edit(record),record)
   monkeypatch.setattr(StoryEditor,'refine',changed)
   response=await client.post(path,headers=h,json=d);assert response.status==409
   assert (await client.post(origin+'/api/wiki/rank',headers=h,json={'audience':'internal','customer_brief':{},'consent':True})).status==400
 finally:await runner.cleanup()

def test_unknown_placeholders_cannot_receive_factual_approval(tmp_path):
 from atlas_voice.wiki import WikiVault
 v=WikiVault(tmp_path/'vault');a=person('author');r=person('reviewer',('ATLAS.Review',))
 try:
  s=story();s['sections']['poor_fit']='Unknown — ask the consultant.';record=v.save(a,s);v.grant(a,record['id'],r.subject_key)
  assert record['quality_gaps'][0]['field']=='poor_fit'
  with pytest.raises(ValueError):v.approve(r,record['id'],record['content_hash'],'facts','Synthetic review',time.time()+3600)
 finally:v.close()
