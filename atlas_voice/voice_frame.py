"""Read the browser voice start without a bare close.

aiohttp closes a websocket when a frame is larger than max_msg_size, before
the handler can send an error. The voice socket therefore accepts a frame up
to READ_MAX_BYTES. A start above START_MAX_BYTES is refused here, and the
handler sends that refusal before it closes.
"""
import json

import aiohttp
from aiohttp import web

START_MAX_BYTES = 32768
READ_MAX_BYTES = 262144
OVERSIZE = 'The voice start is larger than 32 KB. Shorten the project and start again.'


def voice_response():
    return web.WebSocketResponse(max_msg_size=READ_MAX_BYTES, heartbeat=20)


async def read_start(ws):
    message = await ws.receive()
    if message.type != aiohttp.WSMsgType.TEXT:
        raise TypeError('Received message %s is not WSMsgType.TEXT' % message.type)
    if len(message.data.encode('utf-8')) > START_MAX_BYTES:
        raise ValueError(OVERSIZE)
    return json.loads(message.data)
