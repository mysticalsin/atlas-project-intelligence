"""Protocol test fixture ONLY. Emits an explicit test label and a tone, not speech or inference."""
import asyncio
import math
import struct
from aiohttp import web, WSMsgType

async def opus_tone(seconds=1.5):
    pcm=b''.join(struct.pack('<h', int(8000*math.sin(2*math.pi*440*i/24000))) for i in range(int(24000*seconds)))
    p=await asyncio.create_subprocess_exec('ffmpeg','-hide_banner','-loglevel','error','-f','s16le','-ar','24000','-ac','1','-i','pipe:0','-c:a','libopus','-application','voip','-frame_duration','20','-page_duration','20000','-flush_packets','1','-f','ogg','pipe:1',stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.DEVNULL)
    data,_=await p.communicate(pcm)
    assert p.returncode==0 and data.startswith(b'OggS')
    return data

class MockPersonaPlex:
    def __init__(self, tone, delay=0, handshake=b'\x00'):
        self.tone=tone;self.delay=delay;self.handshake=handshake
        self.prompts=[];self.received=[];self.active=0;self.maximum=0
    async def chat(self, request):
        self.prompts.append(dict(request.query))
        ws=web.WebSocketResponse();await ws.prepare(request)
        self.active+=1;self.maximum=max(self.active,self.maximum)
        try:
            await asyncio.sleep(self.delay)
            await ws.send_bytes(self.handshake)
            sent=False
            async for msg in ws:
                if msg.type==WSMsgType.BINARY:
                    self.received.append(msg.data)
                    if not sent:
                        sent=True
                        await ws.send_bytes(b'\x02PROTOCOL TEST FIXTURE. This is a test tone, not NVIDIA speech.')
                        for i in range(0,len(self.tone),180):
                            await ws.send_bytes(b'\x01'+self.tone[i:i+180])
                            await asyncio.sleep(.015)
        except (ConnectionError, asyncio.CancelledError):
            pass
        finally:
            self.active-=1
            await ws.close()
        return ws
    def app(self):
        a=web.Application();a.router.add_get('/api/chat',self.chat);return a
