"""One Markdown story vault plus a small SQLite authority registry.

Markdown is the canonical narrative; registry holds access, revisions and decisions.
A model, edited frontmatter or an imported graph cannot grant publication permission.
Single server process for this pilot; back up registry and files together.
"""
from pathlib import Path
import contextlib
import hashlib
import json
import os
import re
import sqlite3
import time
import uuid

SECTIONS=('challenge','contribution','approach','outcome','evidence','limitations','customer_fit','poor_fit')
AUDIENCES=('internal','customer-anonymized')

def compact(x):return json.dumps(x,sort_keys=True,ensure_ascii=False,separators=(',',':'))
def valid_id(x):return isinstance(x,str) and bool(re.fullmatch(r'[a-f0-9]{32}',x))
def text(x,n=12000):
    if not isinstance(x,str) or not x.strip() or len(x)>n:raise ValueError('Invalid or empty text')
    return x.strip()
def stamp():return time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())

def clean_story(raw):
    if not isinstance(raw,dict) or set(raw)-{'title','sections','tags','sources','kind','stage','audience','customer_brief'}:raise ValueError('Invalid story fields')
    sections=raw.get('sections',{})
    if not isinstance(sections,dict) or set(sections)!=set(SECTIONS):raise ValueError('Eight story sections required; use an explicit unknown instead of inventing')
    sections={k:text(v,14000) for k,v in sections.items()}
    tags=raw.get('tags',[])
    if not isinstance(tags,list) or len(tags)>15 or any(not isinstance(v,str) or not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,49}',v) for v in tags):raise ValueError('Invalid tags')
    sources=raw.get('sources',[])
    if not isinstance(sources,list) or len(sources)>20:raise ValueError('Invalid sources')
    out=[]
    for s in sources:
        if not isinstance(s,dict) or set(s)!= {'id','version','excerpt','supports'}:raise ValueError('Source needs id, version, excerpt and supports')
        if not isinstance(s['supports'],list) or not s['supports'] or any(x not in SECTIONS for x in s['supports']):raise ValueError('Invalid source coverage')
        out.append({'id':text(s['id'],100),'version':text(s['version'],150),'excerpt':text(s['excerpt'],16000),'supports':s['supports']})
    if len({s['id'] for s in out})!=len(out):raise ValueError('Source IDs must be unique')
    audience=raw.get('audience','internal')
    if audience not in AUDIENCES:raise ValueError('Unknown audience')
    kind=raw.get('kind','experience')
    if kind not in ('quantified','qualitative','experience','learning'):raise ValueError('Unknown story kind')
    return {'title':text(raw.get('title'),200),'sections':sections,'tags':sorted(set(tags)),'sources':out,
      'kind':kind,'stage':text(raw.get('stage','Unknown'),80),'audience':audience,
      'customer_brief':text(raw.get('customer_brief','Not yet positioned'),2000)}

def quality_gaps(record):
    """Conservative lint, not a model quality score or semantic evidence check."""
    gaps=[]
    for section in SECTIONS:
        value=record['sections'][section].strip()
        if re.match(r'^(?:unknown\b|not yet (?:known|captured|positioned)|to be (?:confirmed|supplied)|TBD\b)',value,re.I):
            gaps.append({'field':section,'reason':'Explicitly unresolved; clarify or record a bounded qualitative account'})
    covered={k for src in record['sources'] for k in src['supports']}
    for section in ('challenge','contribution','approach','outcome'):
        if section not in covered:gaps.append({'field':section,'reason':'No source excerpt linked to this section'})
    return gaps

def markdown(story,ident,revision,recorded):
    meta={k:story[k] for k in ('title','tags','kind','stage','audience','customer_brief')}
    meta.update({'id':ident,'revision':revision,'recorded_at':recorded,'status':'candidate','classification':'restricted',
      'authority':'Consult the live registry for current permission; this file does not authorize its own reuse.'})
    lines=['---',compact(meta),'---','',f"# {story['title']}",'',
      '> Candidate account. Source excerpts and interview testimony are not independently verified by saving this file.','']
    for name in SECTIONS:
        lines += [f'## {name.replace("_"," ").title()} {{#{name}}}',story['sections'][name],'']
    lines += ['## Versioned source excerpts','']
    for s in story['sources']:
        # Fences wider than any input run prevent source text from closing the block.
        fence='`'*max(4,1+max((len(m.group()) for m in re.finditer(r'`+',s['excerpt'])),default=0))
        lines += [f"### {s['id']} · {s['version']}",'Supports: '+', '.join(s['supports']),fence+'text',s['excerpt'],fence,'']
    return '\n'.join(lines)

class WikiVault:
    def __init__(self,root):
        self.root=Path(root).resolve();self.root.mkdir(parents=True,exist_ok=True,mode=0o700)
        if (self.root/'registry.sqlite3').is_symlink():raise ValueError('Vault registry must not be a symlink')
        self.db=sqlite3.connect(self.root/'registry.sqlite3',check_same_thread=False)
        os.chmod(self.root/'registry.sqlite3',0o600)
        self.db.row_factory=sqlite3.Row
        self.db.executescript('''PRAGMA foreign_keys=ON;
          CREATE TABLE IF NOT EXISTS stories(id TEXT PRIMARY KEY, owner TEXT NOT NULL, revision INTEGER NOT NULL, content_hash TEXT NOT NULL, record TEXT NOT NULL, withdrawn INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE IF NOT EXISTS access(story_id TEXT NOT NULL,user_key TEXT NOT NULL,PRIMARY KEY(story_id,user_key));
          CREATE TABLE IF NOT EXISTS approvals(story_id TEXT NOT NULL,revision INTEGER NOT NULL,kind TEXT NOT NULL,reviewer TEXT NOT NULL,reference TEXT NOT NULL,expires REAL NOT NULL,PRIMARY KEY(story_id,revision,kind));
          CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,story_id TEXT,actor TEXT,action TEXT,revision INTEGER,at TEXT);
        ''');self.db.commit()
    def close(self):
        store=getattr(self,'_story_links',None)
        if store is not None:store.close()
        self.db.close()
    def story_links(self):
        """Reference store beside this registry. Reads still use the live vault."""
        store=getattr(self,'_story_links',None)
        if store is None:
            from .story_attachment import open_story_attachments
            store=open_story_attachments(self.root/'story-attachments')
            self._story_links=store
        return store
    def create_story_target(self,subject,spec):return self.story_links().create_target(subject,spec)
    def story_target(self,subject,target_id):return self.story_links().target(subject,target_id)
    def attach_story(self,subject,target_id,spec):return self.story_links().attach(subject,self,target_id,spec)
    def detach_story(self,subject,attachment_id):return self.story_links().detach(subject,self,attachment_id)
    def list_story_links(self,subject,target_id):return self.story_links().list_attachments(subject,self,target_id)
    def eligible_story_links(self,subject,target_id):return self.story_links().eligible_stories_for_brief(subject,self,target_id)
    def _row(self,subject,ident):
        if not valid_id(ident):raise ValueError('Unknown story')
        r=self.db.execute('SELECT * FROM stories WHERE id=?',(ident,)).fetchone()
        if r is None or (r['owner']!=subject.subject_key and not self.db.execute('SELECT 1 FROM access WHERE story_id=? AND user_key=?',(ident,subject.subject_key)).fetchone()):
            raise PermissionError('Story is not accessible')
        return r
    def _file(self,r):return self.root/r['owner']/r['id']/f"r{r['revision']}-{r['content_hash']}.md"
    def _audit(self,subject,ident,action,revision):
        self.db.execute('INSERT INTO audit(story_id,actor,action,revision,at) VALUES(?,?,?,?,?)',(ident,subject.subject_key,action,revision,stamp()))
    def save(self,subject,raw,ident=None,expected=None):
        record=clean_story(raw);ident=ident or uuid.uuid4().hex
        with self.db:
            old=self._row(subject,ident) if expected is not None else None
            if old and old['owner']!=subject.subject_key:raise PermissionError('Only the author edits the canonical narrative')
            if old and old['content_hash']!=expected:raise ValueError('Revision conflict; reload before editing')
            if not old and (expected is not None or self.db.execute('SELECT 1 FROM stories WHERE id=?',(ident,)).fetchone()):raise ValueError('Expected revision required for update')
            if not valid_id(ident):raise ValueError('Invalid story ID')
            revision=old['revision']+1 if old else 1
            owner=old['owner'] if old else subject.subject_key
            contents=markdown(record,ident,revision,stamp());digest=hashlib.sha256(contents.encode()).hexdigest()
            folder=self.root/owner/ident;folder.mkdir(parents=True,exist_ok=True,mode=0o700)
            dest=folder/f'r{revision}-{digest}.md'
            # Immutable revision. An interrupted transaction may leave an orphan, never an eligible record.
            fd=os.open(dest,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
            with os.fdopen(fd,'w',encoding='utf8') as f:f.write(contents);f.flush();os.fsync(f.fileno())
            self.db.execute('INSERT INTO stories VALUES(?,?,?,?,?,0) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,content_hash=excluded.content_hash,record=excluded.record,withdrawn=0',
                 (ident,owner,revision,digest,compact(record)))
            self._audit(subject,ident,'save-candidate',revision)
        return self.get(subject,ident)
    def get(self,subject,ident):
        r=self._row(subject,ident);contents=self._file(r).read_text(encoding='utf8')
        if hashlib.sha256(contents.encode()).hexdigest()!=r['content_hash']:raise ValueError('Stored Markdown integrity mismatch')
        data=json.loads(r['record']);a=self.db.execute('SELECT kind,expires FROM approvals WHERE story_id=? AND revision=?',(ident,r['revision'])).fetchall()
        valid={x['kind'] for x in a if x['expires']>time.time()}
        needed={'facts'} if data['audience']=='internal' else {'facts','permission'}
        eligible=not r['withdrawn'] and needed<=valid
        return {**data,'id':ident,'revision':r['revision'],'content_hash':r['content_hash'],'withdrawn':bool(r['withdrawn']),
          'eligible':eligible,'review_states':sorted(valid),'markdown':contents,'quality_gaps':quality_gaps(data),'source_hash':hashlib.sha256(compact(data['sources']).encode()).hexdigest()}
    def list(self,subject,audience=None,eligible_only=False):
        rows=self.db.execute('SELECT id FROM stories WHERE owner=? OR id IN (SELECT story_id FROM access WHERE user_key=?) ORDER BY rowid DESC',(subject.subject_key,subject.subject_key)).fetchall()
        result=[]
        for r in rows:
            s=self.get(subject,r['id'])
            if s['withdrawn'] or (audience and s['audience']!=audience) or (eligible_only and not s['eligible']):continue
            result.append(s)
        return result
    def approve(self,subject,ident,expected,kind,reference,expires):
        self.get(subject,ident) # verify canonical Markdown before approval
        r=self._row(subject,ident)
        allowed=('ATLAS.Review','ATLAS.Reviewer','ATLAS.Admin') if kind=='facts' else ('ATLAS.Publish','ATLAS.Presales','ATLAS.Admin') if kind=='permission' else ()
        if not allowed or not set(getattr(subject,'roles',()) or ()).intersection(allowed):raise PermissionError('Assigned reviewer role required; local checkboxes cannot approve wiki content')
        if subject.subject_key==r['owner']:raise PermissionError('An independent reviewer is required')
        if r['content_hash']!=expected or r['withdrawn']:raise ValueError('Review targets a stale or withdrawn revision')
        if not isinstance(expires,(int,float)) or not time.time()<expires<=time.time()+366*86400:raise ValueError('Review expiry must be within a year')
        record=json.loads(r['record'])
        if kind=='facts':
            if quality_gaps(record):raise ValueError('Unresolved sections or source links remain. Inspect quality gaps before factual review.')
            if any(record['sections'][k].lstrip().startswith('Unknown') for k in ('challenge','contribution','approach','outcome','limitations','customer_fit','poor_fit')):raise ValueError('Resolve explicit core unknowns or write a qualified, supported account before review')
            covered={x for s in record['sources'] for x in s['supports']}
            if not {'challenge','contribution','approach','outcome'}<=covered:raise ValueError('Core story claims lack mapped source excerpts')
        with self.db:
            self.db.execute('INSERT OR REPLACE INTO approvals VALUES(?,?,?,?,?,?)',(ident,r['revision'],kind,subject.subject_key,text(reference,1500),expires))
            self._audit(subject,ident,'approve-'+kind,r['revision'])
        return self.get(subject,ident)
    def withdraw(self,subject,ident,expected):
        r=self._row(subject,ident)
        if r['owner']!=subject.subject_key and not set(getattr(subject,'roles',()) or ()).intersection(('ATLAS.Publish','ATLAS.Presales','ATLAS.Admin')):raise PermissionError('Withdrawal authority required')
        if expected!=r['content_hash']:raise ValueError('Revision conflict')
        with self.db:
            self.db.execute('UPDATE stories SET withdrawn=1 WHERE id=?',(ident,));self._audit(subject,ident,'withdraw',r['revision'])
        return {'withdrawn':True,'id':ident}
    def grant(self,owner,ident,user_key):
        r=self._row(owner,ident)
        if owner.subject_key!=r['owner']:raise PermissionError('Only owner grants story access')
        if not re.fullmatch('[a-f0-9]{32}',user_key):raise ValueError('Expected a server-derived subject key')
        with self.db:self.db.execute('INSERT OR IGNORE INTO access VALUES(?,?)',(ident,user_key));self._audit(owner,ident,'grant-access',r['revision'])
    def graph(self,subject,audience='internal'):
        nodes={};edges=[]
        for s in self.list(subject,audience,eligible_only=True):
            nodes[s['id']]={'id':s['id'],'label':s['title'],'type':'story','source_hash':s['content_hash'],'revision':s['revision']}
            for tag in s['tags']:
                tid='tag:'+tag;nodes[tid]={'id':tid,'label':tag,'type':'tag'}
                edges.append({'source':s['id'],'target':tid,'relationship':'tagged','provenance':'EXTRACTED','source_hash':s['content_hash']})
            for source in s['sources']:
                digest=hashlib.sha256(compact(source).encode()).hexdigest()
                sid='source:'+s['id']+':'+digest[:20]
                nodes[sid]={'id':sid,'label':source['id']+' · '+source['version'],'type':'evidence','source_hash':digest}
                edges.append({'source':s['id'],'target':sid,'relationship':'references-source','provenance':'EXTRACTED',
                              'source_hash':s['content_hash'],'supports_sections':source['supports'],
                              'meaning':'Explicit source link; not independently proven entailment or causality'})
        return {'nodes':list(nodes.values()),'edges':edges,'projection':'current authorized eligible Markdown only','not_a_native_graphify_run':True}

    def revoke(self,owner,ident,user_key):
        r=self._row(owner,ident)
        if owner.subject_key!=r['owner']:raise PermissionError('Only owner revokes story access')
        with self.db:
            self.db.execute('DELETE FROM access WHERE story_id=? AND user_key=?',(ident,user_key))
            self._audit(owner,ident,'revoke-access',r['revision'])
