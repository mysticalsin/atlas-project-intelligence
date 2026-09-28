"""Bake-off scripts: syntax, pod request shape and upload hygiene. No RunPod call is made."""
import json,subprocess,pathlib
ROOT=pathlib.Path(__file__).resolve().parents[1]

def sh(*args,**kw):return subprocess.run(args,cwd=ROOT,capture_output=True,text=True,**kw)

def test_scripts_parse():
    for f in ('scripts/runpod_bakeoff.sh','scripts/pod_setup.sh'):assert sh('bash','-n',f).returncode==0,f

def test_plan_exposes_only_ssh_on_one_secure_gpu_without_secrets(tmp_path):
    out=sh('bash','scripts/runpod_bakeoff.sh','plan','ssh-ed25519 AAAATEST atlas-bakeoff',env={'PATH':'/usr/bin:/bin','HOME':str(tmp_path)})
    assert out.returncode==0,out.stderr
    body=json.loads(out.stdout)
    assert body['ports']==['22/tcp'] and body['gpuCount']==1 and body['cloudType']=='SECURE'
    assert body['gpuTypeIds']==['NVIDIA L40S'] and set(body['env'])=={'PUBLIC_KEY'}
    assert 'devel' in body['imageName']

def test_upload_excludes_secrets_vault_and_duplicate_aliases():
    tar=('tar','czf','-',"--exclude=.venv","--exclude=data","--exclude=.env","--exclude=*.key","--exclude=.playwright-mcp",
         "--exclude=__pycache__","--exclude=.pytest_cache","--exclude=preview","--exclude=handoff/provenance",
         "--exclude=ATLAS_Intelligence.html","--exclude=ATLAS_Project_Intelligence.html","--exclude=ATLAS_Voice_Studio.html",'.')
    script=(ROOT/'scripts/runpod_bakeoff.sh').read_text()
    for flag in tar[3:-1]:assert flag.split('=',1)[1] in script,flag
    listing=subprocess.run(' '.join(f"'{a}'" for a in tar)+' | tar tzf -',shell=True,cwd=ROOT,capture_output=True,text=True).stdout.split('\n')
    names=[n.lstrip('./') for n in listing if n]
    assert 'ATLAS_Voice.html' in names and 'scripts/pod_setup.sh' in names and 'atlas_voice/cascade.py' in names
    assert not [n for n in names if n.endswith('.key') or n=='.env' or n.startswith('data/') or '.playwright-mcp' in n]

def test_pod_setup_binds_loopback_and_replaces_public_token():
    s=(ROOT/'scripts/pod_setup.sh').read_text()
    assert s.count('--addr 127.0.0.1')==2 and 'authorized_ids' in s and 'public_token' not in s.split('authorized_ids',1)[1][:200]
    assert 'ATLAS_BIND=127.0.0.1' in s and 'set -x' not in s and 'rm -f "$ATLAS/.workers-ai.key"' in s
