"""Trusted server-operator access provisioning; run only with authorized vault access.
Not an HTTP impersonation endpoint. Grants one exact story, never private memory.
Subject keys are shown by authenticated /api/intelligence, not invented from names.
"""
from pathlib import Path
import argparse,sys,re
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from atlas_voice.wiki import WikiVault
from types import SimpleNamespace
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--vault',required=True);p.add_argument('--story',required=True);p.add_argument('--owner-key',required=True);p.add_argument('--recipient-key',required=True);p.add_argument('--revoke',action='store_true');p.add_argument('--authorization-reference',required=True)
a=p.parse_args()
if any(not re.fullmatch('[a-f0-9]{32}',k) for k in (a.owner_key,a.recipient_key)):p.error('Use the exact server-derived subject keys')
v=WikiVault(a.vault)
try:
 owner=SimpleNamespace(subject_key=a.owner_key)
 (v.revoke if a.revoke else v.grant)(owner,a.story,a.recipient_key)
 with v.db:v._audit(owner,a.story,('operator-revoke' if a.revoke else 'operator-grant')+': '+a.authorization_reference[:200],v._row(owner,a.story)['revision'])
 print('Access updated for one story. This did not approve publication or grant a Hindsight bank.')
finally:v.close()
