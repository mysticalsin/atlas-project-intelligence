"""The preview must expose only the HTML, never secrets or provider endpoints."""
import http.client
import threading
from http.server import ThreadingHTTPServer
import pytest
from scripts.preview import PreviewHandler
@pytest.fixture
def preview():
    server=ThreadingHTTPServer(('127.0.0.1',0),PreviewHandler)
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    yield server.server_port
    server.shutdown();server.server_close();thread.join()
def request(port,path,host='localhost',method='GET'):
    c=http.client.HTTPConnection('127.0.0.1',port,timeout=3)
    c.request(method,path,headers={'Host':f'{host}:{port}'})
    r=c.getresponse();body=r.read();headers=dict(r.getheaders());status=r.status;c.close();return status,headers,body
@pytest.mark.parametrize('path',['/','/ATLAS_Voice_Studio.html'])
def test_serves_html(preview,path):
    status,h,b=request(preview,path);assert status==200;assert b'orbCanvas' in b;assert h['Content-Type'].startswith('text/html')
@pytest.mark.parametrize('path',['/.env','/src/app.js','/../.env','/%2e%2e/.env','/api/bootstrap','/?token=secret'])
def test_never_exposes_files_or_fake_provider_api(preview,path):
    assert request(preview,path)[0]==404
def test_host_boundary(preview):
    assert request(preview,'/',host='attacker.invalid')[0]==403
@pytest.mark.parametrize('path',[
    'http://evil.example/',
    'http://evil.example/ATLAS_Voice_Studio.html',
    'http://localhost@evil.example/',
    'http://127.0.0.1@evil.example/',
    'http://127.0.0.1.evil.example/',
])
def test_absolute_form_for_another_host_is_refused(preview,path):
    assert request(preview,path)[0]==403
def test_head_and_policy(preview):
    s,h,b=request(preview,'/',method='HEAD');assert s==200 and b==b'';assert 'microphone=()' in h['Permissions-Policy'];assert h['Cache-Control']=='no-store'
