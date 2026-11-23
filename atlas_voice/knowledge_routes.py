"""Authenticated knowledge operations in the existing single application.

No model tool can reach approval/write/ranking endpoints. CSRF+Origin are enforced
by the application middleware. Ranking always starts and ends with current ACLs.
"""
import asyncio
import hashlib
import json
import time
from aiohttp import web
from .jev import JevRanker, shortlist
from .wiki import AUDIENCES, compact
from .memory import PrivateMemory

HINDSIGHT_SOURCE={'repository':'https://github.com/mysticalsin/hindsight','commit':'a921929a0e0ea82fb49da1daa0ca3e152e41fcc1','runtime':'operator-configured endpoint; source pin is not deployment evidence'}

def install(app,identity):
    rank_gate=asyncio.Lock()
    editor_gate=asyncio.Lock()
    def vault():
        if 'wiki' not in app:raise web.HTTPServiceUnavailable(text='Markdown vault is not configured. Set ATLAS_WIKI_ROOT on the server.')
        return app['wiki']
    def audience(request):
        a=request.query.get('audience','internal')
        if a not in AUDIENCES:raise ValueError('Invalid audience')
        return a
    async def body(request,allowed):
        value=await request.json()
        if not isinstance(value,dict) or set(value)-set(allowed):raise ValueError('Invalid request fields')
        return value
    def guarded(fn):
        async def wrap(request):
            subject=identity.require(request)
            try:return await fn(request,subject)
            except PermissionError:raise web.HTTPForbidden(text='No access to this story or action.') from None
            except (ValueError,KeyError,TypeError) as e:raise web.HTTPBadRequest(text=str(e)) from None
            except (FileNotFoundError,OSError):raise web.HTTPConflict(text='Stored version unavailable; restore the vault before reuse.') from None
        return wrap
    @guarded
    async def status(request,subject):
        return web.json_response({'wiki':bool(app['config'].wiki_root),'provider':app['config'].voice_provider,
          'memory':bool(app['config'].hindsight_url),'hindsight_source':HINDSIGHT_SOURCE,
          'roles':list(subject.roles),'subjectKey':subject.subject_key,
          'jev':bool(__import__('os').environ.get('TYPESAFE_API_KEY')),
          'editor':bool(__import__('os').environ.get('OPENAI_API_KEY') and __import__('os').environ.get('STORY_EDITOR_MODEL')),
          'notice':'Configured does not mean live-tested. Local mode cannot authorize reviewed wiki publication.'})
    @guarded
    async def stories(request,subject):return web.json_response({'stories':vault().list(subject,audience(request))})
    @guarded
    async def graph(request,subject):return web.json_response(vault().graph(subject,audience(request)))
    @guarded
    async def export(request,subject):
        d=await body(request,('audience','consent'))
        if d.get('consent') is not True:raise ValueError('Confirm an authorized snapshot export')
        a=d.get('audience','internal')
        if a not in AUDIENCES:raise ValueError('Invalid audience')
        from .wiki_export import export_view
        data=export_view(vault(),subject,a)
        return web.Response(body=data,content_type='application/zip',headers={'Content-Disposition':'attachment; filename="ATLAS_Authorized_Wiki.zip"'})
    @guarded
    async def get(request,subject):return web.json_response(vault().get(subject,request.match_info['id']))
    @guarded
    async def save(request,subject):
        d=await body(request,('story','id','expected_hash'))
        return web.json_response(vault().save(subject,d['story'],d.get('id'),d.get('expected_hash')),status=201)
    @guarded
    async def refine(request,subject):
        d=await body(request,('expected_hash','objective','consent'))
        if d.get('consent') is not True:raise ValueError('Authorize sending this saved narrative and its sources to the configured editor first')
        record=vault().get(subject,request.match_info['id'])
        if record['withdrawn'] or record['content_hash']!=d.get('expected_hash'):raise ValueError('Reload the current non-withdrawn version before refining')
        if editor_gate.locked():raise web.HTTPTooManyRequests(text='An editorial request is active; try again after it finishes.')
        from .editor import StoryEditor
        async with editor_gate:
            try:result=await asyncio.wait_for(StoryEditor(app['http']).refine(record,d.get('objective')),timeout=45)
            except (RuntimeError,asyncio.TimeoutError):raise web.HTTPBadGateway(text='No valid editorial draft returned. Existing work is unchanged.') from None
        identity.require(request)
        current=vault().get(subject,record['id'])
        if current['withdrawn'] or current['content_hash']!=record['content_hash']:raise web.HTTPConflict(text='The source changed during editing. Discard this stale response and reload.')
        result['based_on']={'id':record['id'],'content_hash':record['content_hash'],'revision':record['revision']}
        return web.json_response(result)
    @guarded
    async def review(request,subject):
        d=await body(request,('kind','expected_hash','reference','expires_at'))
        return web.json_response(vault().approve(subject,request.match_info['id'],d['expected_hash'],d['kind'],d['reference'],d['expires_at']))
    @guarded
    async def withdraw(request,subject):
        d=await body(request,('expected_hash',))
        return web.json_response(vault().withdraw(subject,request.match_info['id'],d['expected_hash']))
    @guarded
    async def rank(request,subject):
        d=await body(request,('customer_brief','audience','story_ids','consent'))
        if d.get('consent') is not True:raise ValueError('Explicit consent is required before sending these eligible records and the customer brief to TypeSafe.')
        a=d.get('audience','customer-anonymized')
        if a!='customer-anonymized':raise ValueError('External JEV processing requires an approved customer-anonymized variant')
        ids=d.get('story_ids',[])
        if not isinstance(ids,list) or len(ids)>12 or any(not isinstance(x,str) for x in ids):raise ValueError('Select up to 12 story IDs')
        eligible=vault().list(subject,a,eligible_only=True)
        candidates=[s for s in eligible if s['id'] in ids][:12] if ids else shortlist(eligible,d.get('customer_brief',{}))
        if not candidates:return web.json_response({'ranked':[],'notice':('No authorized, current, reviewed stories are eligible for this audience. Nothing was sent to JEV.' if not eligible else 'No lexical shortlist match. Try a more specific problem or supply explicit authorized story IDs. No provider call was made.')})
        if rank_gate.locked():raise web.HTTPTooManyRequests(text='A ranking request is active; wait for it to finish.')
        def current_for_send(story):
            identity.require(request)
            try:live=vault().get(subject,story['id'])
            except PermissionError:return None
            return live if live['eligible'] and live['audience']==a and live['content_hash']==story['content_hash'] else None
        async with rank_gate:
            try:result=await asyncio.wait_for(JevRanker(app['http']).rank(candidates,d['customer_brief'],authorize=current_for_send),timeout=95)
            except (RuntimeError,asyncio.TimeoutError):raise web.HTTPBadGateway(text='JEV did not return a valid decision. No ranking is fabricated.') from None
        # Avoid returning a ranking after withdrawal, an edit, expiry or session revocation.
        identity.require(request)
        valid={s['id']:s for s in vault().list(subject,a,eligible_only=True)}
        kept=[]
        for item in result['rankings']:
            live=valid.get(item['id'])
            if live and live['content_hash']==item['content_hash'] and live['revision']==item['revision']:kept.append(item)
        result['rankings']=kept
        result['recommended_ids']=[x['id'] for x in kept if x.get('fit_class')=='strong-contextual-fit']
        result['no_strong_match']=not result['recommended_ids']
        result['candidate_selection']='explicit authorized IDs' if ids else 'weighted lexical shortlist, not a semantic quality score'
        result['customer_brief_hash']=hashlib.sha256(compact(d['customer_brief']).encode()).hexdigest()
        result['rechecked_at']=time.time()
        return web.json_response(result)
    @guarded
    async def memory_write(request,subject):
        d=await body(request,('content','consent'))
        if d.get('consent') is not True:raise ValueError('Explicit consent required to store private continuity')
        try:await PrivateMemory(app['config']).replace_continuity(subject,d.get('content'))
        except ValueError:raise
        except Exception:raise web.HTTPBadGateway(text='Hindsight did not confirm replacement. Check the memory service before assuming success.') from None
        return web.json_response({'saved':True,'scope':'private user continuity, not project evidence'})
    @guarded
    async def memory_delete(request,subject):
        try:result=await PrivateMemory(app['config']).delete_continuity(subject)
        except ValueError:raise
        except Exception:raise web.HTTPBadGateway(text='Hindsight did not confirm deletion. No success is assumed.') from None
        return web.json_response({'deleted':True,'scope':'ATLAS continuity document only','result':result})
    @guarded
    async def memory_read(request,subject):
        try:text=await PrivateMemory(app['config']).get_continuity(subject)
        except ValueError:raise
        except Exception:raise web.HTTPBadGateway(text='Private memory could not be read.') from None
        return web.json_response({'content':text})
    base = app['config'].base_path.rstrip('/')
    for method,path,fn in [('GET','/api/intelligence',status),('GET','/api/wiki',stories),('GET','/api/wiki/graph',graph),
       ('POST','/api/wiki',save),('POST','/api/wiki/export',export),('POST','/api/wiki/rank',rank),('GET','/api/wiki/{id}',get),
       ('POST','/api/wiki/{id}/refine',refine),('POST','/api/wiki/{id}/review',review),('POST','/api/wiki/{id}/withdraw',withdraw),
       ('GET','/api/memory/context',memory_read),('POST','/api/memory/context',memory_write),('DELETE','/api/memory/context',memory_delete)]:
        app.router.add_route(method, (base + path) if base else path, fn)
