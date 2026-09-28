# ATLAS Project Intelligence · v12 repository map

```text
ATLAS_Project_Intelligence/
  ATLAS_Project_Intelligence.html  Self-contained primary browser build
  ATLAS_Voice.html                 Identical gateway-served build
  build.py                        Standard-library frontend builder
  src/
    voice-client.js               Selected provider / PCM / consent / end
    voice-worklet.js              Input capture, playback and actual audio energy
    orb-renderer.js               Speech sculpture and bounded phrase gestures
    intelligence-*.js             Quality, wiki, editorial, matching and memory UI
    engine.js, app.js              Local project, evidence and story authoring
    shell.html, *-panel.html       Interface and dialogs
    *.css                         Source-based Mantu interface styling
  atlas_voice/
    server.py, config.py           One application / explicit provider selection
    realtime.py                   Hosted speech-to-speech and validated tool calls
    audio.py, interview.py         PersonaPlex codec / interview prompt
    quality.py                    Exact-quote ledger and bounded next-question planner
    identity.py, memory.py         Entra identity and private Hindsight continuity
    wiki.py, wiki_export.py        Markdown revisions / authority registry / graph
    knowledge_routes.py           Authenticated wiki, editor and matching endpoints
    editor.py                     Optional source-grounded structured narrative pass
    jev.py                        Customer-specific typed decision scoring
    notes.py                      Optional Riva / post-session excerpt assignment
  docs/                           Current PRD, sources, architecture, live eval plan
  scripts/                        Preview, gateway, worker and trusted wiki grants
  tests/                          Unit, transport and explicit-adapter browser tests
  assets/Mantu.svg                Original supplied asset; no font files
```

The diagram describes this included source, not a scan of an external application.
One application, one selected voice provider, a private Hindsight dependency and a
private Markdown/SQLite vault. Optional editorial and JEV calls are explicit.
Graphify receives an authorized exported snapshot; it is not running in this kit.

Feature branch → reviewed PR and tests → main → identical artifact in staging →
native voice/identity/memory/authorization trials → authorized release.
