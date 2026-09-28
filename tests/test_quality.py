"""New quality/knowledge/decision contract tests. No live provider calls."""
import asyncio, json, math, time
from dataclasses import replace
from pathlib import Path
import pytest
from atlas_voice.quality import InterviewLedger,session_config,INTERVIEW_POLICY
from atlas_voice.wiki import WikiVault,SECTIONS
from atlas_voice.identity import Session
from atlas_voice.config import Config
from atlas_voice.memory import PrivateMemory
from atlas_voice.jev import parse_result,request_body,DIMENSIONS,JevRanker

def person(name,roles=()):return Session('tenant',name,name,'csrf',time.monotonic()+60,roles)
def story(audience='customer-anonymized'):
 return {'title':'FICTIONAL triage pilot','stage':'Pilot','kind':'qualitative','audience':audience,'tags':['service-operations'],
  'sections':{k:'Fictional '+k+' account, limited to one queue. Not a claimed company result.' for k in SECTIONS},
  'sources':[{'id':'E1','version':'fictional-v1','excerpt':'Synthetic acceptance record, not a real customer source.','supports':['challenge','contribution','approach','outcome']}],
  'customer_brief':'Operations teams seeking predictable intake, with process ownership.'}
def candidate(ledger,field='outcome',quote='We saved 40%.',ident='u1',**extra):
 return ledger.record({'details':[{'field':field,'quote':quote,'item_id':ident,**extra}]})

def test_candidate_provenance_not_verification():
 l=InterviewLedger();l.add_transcript('u1','We saved 40%.');s=candidate(l)
 assert s['evidence_status']=='unverified' and s['next_field']=='measurement' and s['candidate_details'][0]['quote']=='We saved 40%.'
@pytest.mark.parametrize('quote',['We saved 60%.','We did not save 40%.','The project achieved causal ROI.'])
def test_invented_or_changed_quote_rejected(quote):
 l=InterviewLedger();l.add_transcript('u1','We saved 40%.')
 with pytest.raises(ValueError):candidate(l,quote=quote)
def test_missing_transcript_rejected():
 with pytest.raises(ValueError):candidate(InterviewLedger())
def test_model_own_speech_cannot_be_recorded():
 l=InterviewLedger();l.add_transcript('user-1','I designed the schema.')
 with pytest.raises(ValueError):candidate(l,'contribution','I designed the schema.','agent-1')
def test_atomic_detail_batch():
 l=InterviewLedger();l.add_transcript('u1','We saved 40%.')
 with pytest.raises(ValueError):l.record({'details':[{'field':'outcome','quote':'We saved 40%.','item_id':'u1'},{'field':'bad','quote':'We saved 40%.','item_id':'u1'}]})
 assert not l.details
def test_correction_retires_prior_not_silently_merge():
 l=InterviewLedger();l.add_transcript('u1','We saved 40%.');candidate(l);l.add_transcript('u2','Correction: the pilot saved 20 minutes, not 40%.')
 s=candidate(l,quote='the pilot saved 20 minutes, not 40%.',ident='u2',supersedes='D-001')
 assert len(s['candidate_details'])==1 and not l.details[0]['active']
def test_unknown_is_not_reported_fact():
 l=InterviewLedger();l.add_transcript('u1',"I don't know the baseline.");s=candidate(l,'measurement',"I don't know the baseline.")
 assert s['candidate_details'][0]['status']=='unknown' and s['unresolved_fields']==['measurement']
def test_estimates_preserve_uncertainty():
 l=InterviewLedger();l.add_transcript('u1','We estimate about 20% less time.');s=candidate(l,quote='We estimate about 20% less time.')
 assert s['candidate_details'][0]['status']=='uncertain'
def test_idempotent_tool_call():
 l=InterviewLedger();l.add_transcript('u1','We saved 40%.');a={'details':[{'field':'outcome','quote':'We saved 40%.','item_id':'u1'}]}
 assert l.call('c1','record_details',a)==l.call('c1','record_details',a) and len(l.details)==1
@pytest.mark.parametrize('tool',['publish_story','fetch_url','approve','read_another_bank'])
def test_no_privileged_model_tool(tool):
 with pytest.raises(ValueError):InterviewLedger().call('c',tool,{})
def test_policy_and_real_session_shape():
 c=session_config('gpt-realtime-2.1','cedar',{},capture=True)['session']
 assert c['audio']['input']['format']['rate']==24000 and c['audio']['input']['transcription']['model']=='gpt-transcribe'
 assert c['audio']['input']['turn_detection']['type']=='semantic_vad'
 assert 'ONE main question' in c['instructions'] and 'two unsuccessful' in c['instructions']
def test_capture_off_disables_asr_and_tools():
 c=session_config('gpt-realtime-2.1','cedar',{},capture=False)['session']
 assert c['tools']==[] and 'transcription' not in c['audio']['input']
def test_invalid_provider_cannot_fallback():
 with pytest.raises(ValueError):replace(Config(),voice_provider='anything').validate()
@pytest.fixture
def vault(tmp_path):
 v=WikiVault(tmp_path/'wiki');yield v;v.close()
def reviewed(vault,audience='customer-anonymized'):
 a=person('author');b=person('reviewer',('ATLAS.Review','ATLAS.Publish'));s=vault.save(a,story(audience));vault.grant(a,s['id'],b.subject_key)
 for kind in (['facts'] if audience=='internal' else ['facts','permission']):s=vault.approve(b,s['id'],s['content_hash'],kind,'Reviewed synthetic fixture',time.time()+3600)
 return a,b,s

def test_markdown_immutable_with_hash(vault):
 a=person('author');s=vault.save(a,story());assert s['markdown'].startswith('---\n') and not s['eligible'];assert list(vault.root.rglob('*.md'))
 s2=vault.save(a,story(),s['id'],s['content_hash']);assert s2['revision']==2 and len(list(vault.root.rglob('*.md')))==2
def test_wrong_user_no_access_or_graph(vault):
 a,b,s=reviewed(vault)
 with pytest.raises(PermissionError):vault.get(person('outsider'),s['id'])
 assert vault.list(person('outsider'))==[] and vault.graph(person('outsider'))['nodes']==[]
def test_author_cannot_self_approve(vault):
 a=person('author',('ATLAS.Review',));s=vault.save(a,story())
 with pytest.raises(PermissionError):vault.approve(a,s['id'],s['content_hash'],'facts','self',time.time()+30)
def test_local_profile_not_authenticated_reviewer(vault):
 a=person('author');b=person('reader');s=vault.save(a,story());vault.grant(a,s['id'],b.subject_key)
 with pytest.raises(PermissionError):vault.approve(b,s['id'],s['content_hash'],'facts','local checkbox',time.time()+30)
def test_correct_roles_and_two_decisions(vault):
 a=person('author');b=person('reviewer',('ATLAS.Review','ATLAS.Publish'));s=vault.save(a,story());vault.grant(a,s['id'],b.subject_key)
 s=vault.approve(b,s['id'],s['content_hash'],'facts','source reviewed',time.time()+30);assert not s['eligible']
 s=vault.approve(b,s['id'],s['content_hash'],'permission','disclosure+brand+account resolved',time.time()+30);assert s['eligible']
def test_changed_story_or_audience_invalidates_approval(vault):
 a,b,s=reviewed(vault);d=story('internal');d['title']='Changed interpretation';v=vault.save(a,d,s['id'],s['content_hash'])
 assert not v['eligible'] and v['review_states']==[]
def test_stale_edit_rejected(vault):
 a,b,s=reviewed(vault)
 with pytest.raises(ValueError):vault.save(a,story(),s['id'],'outdated-hash')
def test_withdraw_removes_rank_graph_and_access_revoke(vault):
 a,b,s=reviewed(vault);assert vault.graph(b,'customer-anonymized')['nodes']
 vault.withdraw(a,s['id'],s['content_hash']);assert not vault.list(b,'customer-anonymized',True)
 assert not vault.graph(b,'customer-anonymized')['nodes'];vault.revoke(a,s['id'],b.subject_key)
 with pytest.raises(PermissionError):vault.get(b,s['id'])
def test_expired_approval_is_not_eligible(vault):
 a,b,s=reviewed(vault);vault.db.execute('UPDATE approvals SET expires=0');vault.db.commit();assert not vault.get(a,s['id'])['eligible']
def test_edited_markdown_cannot_forge_registry(vault):
 a,b,s=reviewed(vault);f=list(vault.root.rglob('*.md'))[0];f.write_text(f.read_text()+'\napproved: true\n')
 with pytest.raises(ValueError):vault.get(a,s['id'])
def test_imported_permission_field_rejected(vault):
 with pytest.raises(ValueError):vault.save(person('author'),{**story(),'eligible':True})
def test_missing_sources_and_unknowns_block_review(vault):
 a=person('author');b=person('reviewer',('ATLAS.Review',));d=story();d['sources']=[];s=vault.save(a,d);vault.grant(a,s['id'],b.subject_key)
 with pytest.raises(ValueError):vault.approve(b,s['id'],s['content_hash'],'facts','x',time.time()+30)
 d=story();d['sections']['poor_fit']='Unknown — ask';s=vault.save(a,d);vault.grant(a,s['id'],b.subject_key)
 with pytest.raises(ValueError):vault.approve(b,s['id'],s['content_hash'],'facts','x',time.time()+30)
def test_path_traversal_rejected(vault):
 with pytest.raises(ValueError):vault.save(person('a'),story(),'../../escape')

def jev_result(score=3,confidence=.8):
 return {'model':'jev-test-fixture','answers':{k:{'type':'score','score':score,'confidence':confidence,'probabilities':{str(i):1 if i==score else 0 for i in range(5)}} for k in DIMENSIONS}}
def test_jev_weighted_score_and_version():
 r=parse_result(jev_result());assert r['relevance_score']==75 and r['rubric_version']=='customer-value-v1'
 assert 'not probability' in r['notice']
@pytest.mark.parametrize('mutation',[{'score':99},{'score':float('nan')},{'confidence':2},{'type':'choice'},{'probabilities':{'0':1}}])
def test_malformed_jev_fails_closed(mutation):
 r=jev_result();r['answers']['evidence'].update(mutation)
 with pytest.raises(ValueError):parse_result(r)
def test_jev_question_schema():
 r=request_body({}, {}, 'jev-1.13.0');assert set(r)=={'model','state','questions'}
 assert all(q['type']=='score' and len(q['criteria'])==5 for q in r['questions'].values())
@pytest.mark.asyncio
async def test_jev_does_not_send_ineligible_or_missing_brief():
 r=JevRanker(None,key='fixture');brief={k:'context' for k in ('problem','buyer','constraints','desired_outcome')}
 with pytest.raises(ValueError):await r.rank([{'eligible':False}],brief)
 with pytest.raises(ValueError):await r.rank([],{})
@pytest.mark.asyncio
async def test_memory_explicit_replacement_has_fixed_document_and_bank():
 calls=[]
 class Client:
  async def aretain(self,**kw):calls.append(kw)
  async def aclose(self):pass
 m=PrivateMemory(replace(Config(),hindsight_url='https://memory.invalid',bank_secret='z'*32),client_factory=Client)
 a,b=person('a'),person('b');await m.replace_continuity(a,'Resume at evidence; result not confirmed.');await m.replace_continuity(a,'Corrected resume pointer.');await m.replace_continuity(b,'Other person.')
 assert calls[0]['document_id']==calls[1]['document_id']=='atlas-continuity'
 assert calls[0]['bank_id']==calls[1]['bank_id']!=calls[2]['bank_id']

def test_authorized_wiki_export_has_markdown_index_and_excludes_drafts(vault):
 import io,zipfile
 from atlas_voice.wiki_export import export_view
 a,b,s=reviewed(vault,'internal');d=vault.save(a,story('internal'))
 z=zipfile.ZipFile(io.BytesIO(export_view(vault,a,'internal')))
 assert 'index.md' in z.namelist() and 'topics/service-operations.md' in z.namelist()
 assert 'stories/'+s['id']+'.md' in z.namelist() and 'stories/'+d['id']+'.md' not in z.namelist()
 assert 'private memory' not in z.namelist()
 assert json.loads(z.read('manifest.json'))['records'][0]['content_hash']==s['content_hash']

@pytest.mark.asyncio
async def test_jev_actual_adapter_body_and_confidence_label():
 from atlas_voice.jev import JevRanker
 class Response:
  status=200
  async def __aenter__(self):return self
  async def __aexit__(self,*args):pass
  async def json(self):return jev_result(confidence=.5)
 class HTTP:
  def __init__(self):self.calls=[]
  def post(self,url,**kwargs):self.calls.append((url,kwargs));return Response()
 h=HTTP();r=JevRanker(h,key='FIXTURE');s={**story(),'id':'a','revision':1,'content_hash':'hash','eligible':True}
 result=await r.rank([s],{k:'Example constraint' for k in ('problem','buyer','constraints','desired_outcome')})
 assert h.calls[0][0]=='https://api.typesafe.ai/v1/systemone'
 assert h.calls[0][1]['allow_redirects'] is False
 assert result['rankings'][0]['review_required'] is True
 assert 'owner' not in h.calls[0][1]['json']['state']['eligible_story']
