// The re-sign-in landing page (§3.7): opened in a popup, it tells the waiting tab and closes. No data, no token.
// Kept beside the confirm page so the build can hash this script without importing the Worker.
export const SIGNED_IN_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ATLAS</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#15151c;color:#e8e8f0;font:15px/1.5 Arial,sans-serif;padding:16px;box-sizing:border-box}</style></head>
<body><p>You're signed in. This window closes by itself.</p>
<script>try{new BroadcastChannel('atlas-auth').postMessage('ok')}catch(e){}setTimeout(function(){window.close()},400)</script></body></html>`;
