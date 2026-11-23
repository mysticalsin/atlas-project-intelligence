"""v12 decision quality and grounding checks. All inputs are synthetic."""
import asyncio
import copy
import json
from datetime import date
import pytest
from atlas_voice.quality import InterviewLedger, FIELDS
from atlas_voice.editor import parse_edit, StoryEditor, references
from atlas_voice.jev import source_freshness, parse_result, request_body, JevRanker
from tests.test_quality import story, candidate, jev_result, reviewed

def add(l,field,text,ident=None,**extra):
    ident=ident or f'u{len(l.transcripts)+1}';l.add_transcript(ident,text)
    return candidate(l,field,text,ident,**extra)

def test_numeric_probe_narrows_to_missing_denominator():
    l=InterviewLedger();add(l,'outcome','We estimate 40% less time.')
    assert l.inspect()['next_question']=='What were the before and after values for that measure?'
    add(l,'measurement','Baseline median 42 minutes, after pilot 26 minutes in one queue.')
    assert 'dates' in l.inspect()['next_question']

def test_unknown_numeric_basis_is_not_repeated():
    l=InterviewLedger();add(l,'outcome','We estimate 40% less time.');add(l,'measurement',"I don't know the baseline.")
    assert l.inspect()['next_field']!='measurement' and 'measurement' in l.inspect()['unresolved_fields']

def test_two_unresolved_probe_plans_defer_not_resolve():
    l=InterviewLedger();add(l,'outcome','We estimate 40% less time.')
    assert l.plan_probe()['next_field']=='measurement'
    l.add_transcript('u2','Please explain what you need.');l.plan_probe()
    l.add_transcript('u3','I need to collect the details.');r=l.plan_probe()
    assert 'measurement' in r['deferred_fields'] and r['next_field']!='measurement'
    assert r['probe_history'][-1]['status']=='planned_not_confirmed_spoken'

def test_probe_retry_same_turn_does_not_consume_budget():
    l=InterviewLedger();l.add_transcript('u1','I worked on a pilot.');a=l.plan_probe();b=l.plan_probe()
    assert b['repeat_plan'] and a['planned_question']==b['planned_question'] and len(l.probes)==1

def test_no_field_gets_third_plan_even_after_another_deferred_field():
    l=InterviewLedger()
    for i in range(40):l.add_transcript(f'u{i}','Please move on to another detail.');l.plan_probe()
    assert all(sum(p['field']==f for p in l.probes)<=2 for f in FIELDS)

def test_no_percentage_required_for_qualitative_account():
    l=InterviewLedger();add(l,'outcome','The team adopted one consistent handover checklist.')
    assert l.inspect()['story_route']=='qualitative candidate' and l.inspect()['next_field']!='measurement'

def test_assessment_question_does_not_assert_implementation_benefit():
    l=InterviewLedger(stage='Assessment')
    for f in ('problem','stakes','contribution','intervention','decision','adoption'):add(l,f,'This is a candidate account of the '+f+'.')
    assert 'decision or tested finding' in l.inspect()['next_question']

def test_confidentiality_is_kept_open_not_repeated():
    l=InterviewLedger();add(l,'evidence','I cannot share the restricted report.')
    assert 'evidence' in l.inspect()['unresolved_fields']

def test_multiple_measurements_prompt_comparability_not_merge():
    l=InterviewLedger();add(l,'outcome','Median duration was 40 minutes.');add(l,'outcome','Median duration was 26 minutes.')
    assert 'same measure and population' in l.inspect()['next_question']

def test_duplicate_candidates_in_same_batch_are_deduplicated():
    l=InterviewLedger();l.add_transcript('u1','I designed and tested the ingestion rules.')
    d={'field':'contribution','item_id':'u1','quote':'I designed and tested the ingestion rules.'}
    l.record({'details':[d,d]});assert len(l.details)==1

def test_call_id_cannot_be_reused_for_another_tool():
    l=InterviewLedger();l.call('same','inspect_gaps',{})
    with pytest.raises(ValueError):l.call('same','plan_probe',{})

def edit(st=None):
    st=st or story();return {'title':'A controlled service pilot','paragraphs':[{'section':k,'text':v,'refs':['account:'+k]} for k,v in st['sections'].items()], 'open_questions':['Who can independently verify the handover?']}

def test_grounded_editor_preserves_sources_and_candidate_status():
    st=story();r=parse_edit(edit(st),st)
    assert r['candidate']['sources']==st['sources'] and r['human_review_required'] and r['status']=='restricted-candidate'
    assert len(r['citations'])==8

@pytest.mark.parametrize('bad',['Our pilot saved 80%.','It saved $300,000.','Median time was reduced by 38.1%.'])
def test_editor_cannot_introduce_new_numbers(bad):
    st=story();d=edit(st);d['paragraphs'][3]['text']=bad
    with pytest.raises(ValueError):parse_edit(d,st)

def test_editor_preserves_exact_original_limits():
    st=story();d=edit(st);d['paragraphs'][5]['text']='Check transfer conditions before applying this lesson.'
    assert st['sections']['limitations'] in parse_edit(d,st)['candidate']['sections']['limitations']

def test_second_refine_does_not_append_retained_limitations_again():
    st=story();d=edit(st);d['paragraphs'][5]['text']='Check transfer conditions before applying this lesson.'
    first=parse_edit(d,st)['candidate']
    marker='Original scope and limitations (retained verbatim)'
    assert first['sections']['limitations'].count(marker)==1
    again=edit(first);again['paragraphs'][5]['text']='A shorter limitation note for the next pass.'
    second=parse_edit(again,first)['candidate']['sections']['limitations']
    assert second.count(marker)==1
    assert second.count(st['sections']['limitations'])==1

@pytest.mark.parametrize('bad',['source:secret','account:nonexistent'])
def test_editor_rejects_invented_reference(bad):
    st=story();d=edit(st);d['paragraphs'][0]['refs']=[bad]
    with pytest.raises(ValueError):parse_edit(d,st)

def test_editor_rejects_cross_section_account_reference():
    st=story();d=edit(st);d['paragraphs'][0]['refs']=['account:outcome']
    with pytest.raises(ValueError):parse_edit(d,st)

def test_editor_refuses_numerical_headline():
    d=edit();d['title']='40% better operations'
    with pytest.raises(ValueError):parse_edit(d,story())

def test_editor_missing_section_rejected():
    d=edit();d['paragraphs'][-1]['section']='evidence'
    with pytest.raises(ValueError):parse_edit(d,story())

def test_editor_does_not_mutate_original():
    st=story();before=copy.deepcopy(st);parse_edit(edit(st),st);assert st==before

class Response:
    status=200
    def __init__(self,payload):self.payload=payload;self.content=self
    async def __aenter__(self):return self
    async def __aexit__(self,*a):pass
    async def json(self):return self.payload
    async def read(self,n):return json.dumps(self.payload).encode()[:n]
    async def iter_chunked(self,n):
        raw=json.dumps(self.payload).encode()
        for i in range(0,len(raw),n):yield raw[i:i+n]
class Session:
    def __init__(self,payload):self.payload=payload;self.calls=[]
    def post(self,url,**kwargs):self.calls.append((url,kwargs));return Response(self.payload)

@pytest.mark.asyncio
async def test_editor_request_and_structured_output_fixture():
    st=story();s=Session({'choices':[{'finish_reason':'stop','message':{'content':json.dumps(edit(st))}}]})
    r=await StoryEditor(s,key='FIXTURE',model='fixture-model').refine(st,'Explain the customer decision and limits.')
    request=s.calls[0][1]['json']
    assert not request['store'] and request['response_format']['json_schema']['strict']
    assert r['model']=='fixture-model' and s.calls[0][0]=='https://api.openai.com/v1/chat/completions'

@pytest.mark.asyncio
async def test_editor_missing_configuration_fails_without_network():
    s=Session({})
    with pytest.raises(ValueError):await StoryEditor(s,key='',model='').refine(story(),'Explain the decision.')
    assert not s.calls

@pytest.mark.asyncio
async def test_editor_refusal_no_fabricated_fallback():
    s=Session({'choices':[{'finish_reason':'stop','message':{'refusal':'fixture refusal'}}]})
    with pytest.raises(RuntimeError):await StoryEditor(s,key='FIXTURE',model='fixture').refine(story(),'Explain the decision.')

@pytest.mark.parametrize('version',['undated','2026-99-99','2099-01-01'])
def test_recency_is_unknown_for_invalid_missing_future_date(version):
    st=story();st['sources'][0]['version']=version
    assert not source_freshness(st,date(2026,9,26))['known']

def test_recency_date_arithmetic_is_outside_jev():
    st=story();st['sources'][0]['version']='v2 · 2026-08-28'
    f=source_freshness(st,date(2026,9,26));assert f['known'] and f['age_days']==29 and f['score']==4
    body=request_body(st,{},'fixture',True);assert 'recency' not in body['questions']
    data=jev_result();del data['answers']['recency'];result=parse_result(data,freshness=f)
    assert result['rubric_version']=='customer-value-v2' and result['dimensions']['recency']['confidence'] is None

@pytest.mark.asyncio
async def test_jev_abstains_instead_of_forcing_a_winner():
    st={**story(),'eligible':True,'id':'synthetic','revision':1,'content_hash':'fixture'};st['sources'][0]['version']='2026-09-01'
    s=Session(jev_result(score=1));r=await JevRanker(s,key='FIXTURE').rank([st],{'problem':'routing','buyer':'operations','constraints':'pilot','desired_outcome':'consistency'})
    assert r['no_strong_match'] and r['recommended_ids']==[] and r['rankings'][0]['fit_class']=='poor-contextual-fit'

@pytest.mark.asyncio
async def test_revoked_candidate_never_sent():
    st={**story(),'eligible':True,'id':'synthetic','revision':1,'content_hash':'fixture'};s=Session(jev_result())
    r=await JevRanker(s,key='FIXTURE').rank([st],{'problem':'routing','buyer':'operations','constraints':'pilot','desired_outcome':'consistency'},authorize=lambda story:None)
    assert not s.calls and not r['rankings']

def test_authorized_graph_contains_versioned_evidence(tmp_path):
    from atlas_voice.wiki import WikiVault
    v=WikiVault(tmp_path/'wiki')
    try:
        a,b,s=reviewed(v,'internal');g=v.graph(a)
        assert any(n['type']=='evidence' for n in g['nodes'])
        assert any(e['relationship']=='references-source' and e['provenance']=='EXTRACTED' for e in g['edges'])
        v.withdraw(a,s['id'],s['content_hash']);assert not v.graph(a)['nodes']
    finally:v.close()

def test_shortlist_prioritizes_problem_fit_not_latest_upload():
    from atlas_voice.jev import shortlist
    irrelevant={**story(),'eligible':True,'id':'recent','title':'Generic sample'}
    relevant={**story(),'eligible':True,'id':'older','title':'Service triage','sections':{**story()['sections'],'customer_fit':'For operations teams with inconsistent service triage queues.'}}
    selected=shortlist([irrelevant,relevant],{'problem':'service triage queues','buyer':'operations','constraints':'manual routing','desired_outcome':'consistent triage'},1)
    assert selected[0]['id']=='older'

def test_shortlist_is_not_an_access_filter_replacement():
    from atlas_voice.jev import shortlist
    r={**story(),'eligible':False,'id':'private','title':'service triage'}
    assert shortlist([r],{'problem':'service triage'})==[]

def test_undated_poor_fit_does_not_become_current_from_upload():
    st=story();st['recorded_at']='2026-09-26';assert not source_freshness(st,date(2026,9,26))['known']
