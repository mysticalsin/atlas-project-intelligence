#!/usr/bin/env python3
"""Run the installed official PersonaPlex worker on loopback without prompt/access logs.

The audited stock module parses --host but did not pass it to web.run_app, and
logged the full text_prompt. Apply two explicit runtime-only source substitutions.
Fail closed when the expected source differs. No installed file is modified.
Run in the model's virtualenv, not the gateway virtualenv.
"""
import hashlib
import importlib.util
from pathlib import Path
import sys

def transform(source):
    substitutions = {
        'web.run_app(app, port=args.port, ssl_context=ssl_context)':
            'web.run_app(app, host="127.0.0.1", port=args.port, ssl_context=ssl_context, access_log=None)',
        '''clog.log("info", f"text prompt: {request.query['text_prompt']}")''':
            '''clog.log("info", "text prompt: [redacted by ATLAS private launcher]")''',
    }
    for old,new in substitutions.items():
        if source.count(old)!=1:
            raise RuntimeError('The installed PersonaPlex source differs from the reviewed version. Review its binding/logging before adapting this launcher. It has NOT been started.')
        source=source.replace(old,new)
    return source

def main():
    if any(x.startswith('--gradio-tunnel') for x in sys.argv[1:]):
        raise SystemExit('Do not expose the GPU worker through a public tunnel. Use the ATLAS gateway.')
    if '--static' not in sys.argv:
        sys.argv.extend(['--static','none'])
    elif sys.argv[sys.argv.index('--static')+1] != 'none':
        raise SystemExit('Use --static none: ATLAS serves the user interface.')
    try:
        spec=importlib.util.find_spec('moshi.server')
        if spec is None or not spec.origin:raise ImportError()
    except (ImportError,ModuleNotFoundError):
        raise SystemExit('Install the official NVIDIA PersonaPlex moshi package in the GPU model environment first.')
    path=Path(spec.origin)
    original=path.read_text();source=transform(original)
    print('Official PersonaPlex source SHA256:',hashlib.sha256(original.encode()).hexdigest())
    print('ATLAS private worker: forced loopback; full-prompt logging and HTTP access logging disabled.')
    namespace={'__name__':'__main__','__file__':str(path),'__package__':'moshi'}
    exec(compile(source,str(path),'exec'),namespace)

if __name__=='__main__':main()
