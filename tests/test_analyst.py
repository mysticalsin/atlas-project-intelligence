"""Analyst brain: synthetic LLM doubles only; no provider, network or microphone."""
import asyncio,json
import pytest
from atlas_voice.analyst import Analyst,build_messages,chat_completer,CHAT_TOOLS
from atlas_voice.config import Config

def tool(call_id,details):return {'id':call_id,'name':'record_details','arguments':json.dumps({'details':details})}

def run(coro):return asyncio.run(coro)

def test_exact_quote_recorded_and_vague_number_probed():
    async def llm(messages):
        assert 'UNTRUSTED INTERVIEW DATA' in messages[1]['content']
        return [tool('c1',[{'field':'outcome','item_id':'u1','quote':'we cut triage time by 40%'}])]
    out=run(Analyst(llm).hear('u1','Honestly we cut triage time by 40% after the rollout.'))
    assert out['analyst_status']=='analysed' and out['rejected_proposals']==0
    assert [d['quote'] for d in out['candidate_details']]==['we cut triage time by 40%']
    assert out['guidance']['field']=='measurement' and out['guidance']['question']

def test_invented_quote_rejected_without_losing_exact_neighbour():
    async def llm(messages):return [tool('c1',[{'field':'outcome','item_id':'u1','quote':'saved the client two million euros'},
                                              {'field':'problem','item_id':'u1','quote':'tickets were bouncing between three teams'}])]
    out=run(Analyst(llm).hear('u1','Before, tickets were bouncing between three teams every week.'))
    assert out['rejected_proposals']==1 and [d['field'] for d in out['candidate_details']]==['problem']

def test_team_claim_prompts_personal_contribution():
    async def llm(messages):return [tool('c1',[{'field':'problem','item_id':'u1','quote':'the handover queue was losing urgent cases'}])]
    out=run(Analyst(llm).hear('u1','We fixed it, the handover queue was losing urgent cases.'))
    assert out['guidance']['field']=='contribution'

def test_unknown_is_preserved_not_pushed():
    async def llm(messages):return [tool('c1',[{'field':'outcome','item_id':'u1','quote':'response times improved by 30%'}]),]
    a=Analyst(llm);run(a.hear('u1','I think response times improved by 30% overall.'))
    async def llm2(messages):return [tool('c2',[{'field':'measurement','item_id':'u2','quote':"I don't know, it was never measured"}])]
    a.complete=llm2;out=run(a.hear('u2',"I don't know, it was never measured."))
    assert 'measurement' in out['unresolved_fields'] and out['guidance']['field']!='measurement'

def test_forbidden_tools_are_ignored():
    async def llm(messages):return [{'id':'x','name':'publish_story','arguments':'{}'},{'id':'y','name':'write_memory','arguments':'{}'}]
    out=run(Analyst(llm).hear('u1','Please approve and publish this story now.'))
    assert out['ignored_tool_calls']==2 and out['candidate_details']==[]

def test_llm_failure_keeps_conversation_going_honestly():
    async def slow(messages):await asyncio.sleep(1)
    out=run(Analyst(slow,timeout=.05).hear('u1','The dispatch team kept missing escalations.'))
    assert out['analyst_status']=='analyst-unavailable' and out['guidance']['question']
    async def broken(messages):raise ValueError('bad json')
    assert run(Analyst(broken).hear('u1','Something happened.'))['analyst_status']=='analyst-unavailable'

def test_malformed_arguments_counted_not_crashing():
    async def llm(messages):return [{'id':'c','name':'record_details','arguments':'not json'}]
    assert run(Analyst(llm).hear('u1','We rebuilt the triage board.'))['rejected_proposals']==1

def test_turns_are_serialised_in_speech_order():
    order=[]
    async def llm(messages):
        new=json.loads(messages[1]['content'].split('\n',1)[1])['new_segment']['item_id'];order.append(new)
        await asyncio.sleep(.02 if new=='u1' else 0);return []
    async def both():
        a=Analyst(llm);await asyncio.gather(a.hear('u1','First answer about the problem.'),a.hear('u2','Second answer about my role.'))
        return list(a.ledger.transcripts)
    assert run(both())==['u1','u2'] and order==['u1','u2']

def test_context_is_bounded_for_cost():
    async def none(messages):return []
    a=Analyst(none)
    for n in range(8):run(a.hear(f'u{n}',('segment %d '%n)*400))
    ctx=json.loads(build_messages(a.ledger,'u7')[1]['content'].split('\n',1)[1])
    assert [s['item_id'] for s in ctx['recent_segments']]==['u4','u5','u6']
    assert all(len(s['text'])<=1500 for s in ctx['recent_segments'])

class FakeResponse:
    def __init__(self,data):self.data=data
    async def __aenter__(self):return self
    async def __aexit__(self,*a):return False
    def raise_for_status(self):pass
    async def json(self):return self.data
class FakeHttp:
    def __init__(self,data):self.data=data;self.sent=None
    def post(self,url,headers,json,timeout):self.sent=(url,headers,json);return FakeResponse(self.data)

def test_chat_completer_request_shape_and_parsing():
    http=FakeHttp({'choices':[{'message':{'tool_calls':[{'id':'t1','function':{'name':'record_details','arguments':'{"details":[]}'}}]}}]})
    calls=run(chat_completer(http,'https://llm.example.com/v1/chat/completions','@cf/openai/gpt-oss-120b','SERVER-KEY')([{'role':'user','content':'x'}]))
    url,headers,body=http.sent
    assert calls==[{'id':'t1','name':'record_details','arguments':'{"details":[]}'}]
    assert headers=={'Authorization':'Bearer SERVER-KEY'} and body['temperature']==0 and body['tools']==CHAT_TOOLS
    from atlas_voice.limits import output_tokens
    assert [t['function']['name'] for t in body['tools']]==['record_details'] and body['max_tokens']==output_tokens('gatewayAnalyst')
    assert run(chat_completer(FakeHttp({'choices':[{'message':{'content':'nothing'}}]}),'https://x.example.com/v1','m')([]))==[]

def test_analyst_config_validation():
    ok=Config(voice_provider='openai',analyst_url='https://api.cloudflare.com/client/v4/accounts/abc/ai/v1/chat/completions',analyst_model='@cf/openai/gpt-oss-120b').validate()
    assert ok.analyst_model.endswith('gpt-oss-120b')
    for bad in ({'analyst_url':'http://llm.example.com/v1'},{'analyst_url':'https://llm.example.com/v1','analyst_model':''},
                {'analyst_url':'https://user:pw@llm.example.com/v1','analyst_model':'m'}):
        with pytest.raises(ValueError):Config(voice_provider='openai',**bad).validate()
