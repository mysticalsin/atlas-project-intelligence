"""Prepare a standalone page for a browser test that rewrites the protocol guard.

The depth harness replaces the guard inside inline scripts before set_content. The
naive replace is what the page does today: the meta script-src hashes no longer
match, so the browser refuses the scripts and the quality dialog never opens.
"""
PROTOCOL_GUARD = "if(!['http:','https:'].includes(location.protocol))"


def standalone_html(html):
    return html.replace(PROTOCOL_GUARD, 'if(false)')
