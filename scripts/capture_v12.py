"""Capture actual HTML. Provider services remain disconnected."""
from pathlib import Path
import os,shutil
from playwright.sync_api import sync_playwright
R=Path(__file__).resolve().parents[1];out=R/'preview/v12';out.mkdir(parents=True,exist_ok=True)
with sync_playwright() as w:
 b=w.chromium.launch(executable_path=os.getenv('CHROMIUM_PATH') or shutil.which('chromium'),args=['--no-sandbox'])
 p=b.new_page(viewport={'width':1512,'height':1020});p.set_content((R/'ATLAS_Project_Intelligence.html').read_text(),wait_until='load');p.wait_for_timeout(800)
 p.screenshot(path=str(out/'desktop.png'),full_page=True)
 p.locator('[data-orb-preview=speaking]').click();p.wait_for_timeout(1400);p.screenshot(path=str(out/'speaking-preview.png'),full_page=True);p.locator('#studioPreview').click()
 p.locator('[data-intelligence=quality]').click();p.locator('#qualityVague').click();p.screenshot(path=str(out/'quality.png'),full_page=False)
 p.locator('[data-intel-tab=memory]').click();p.screenshot(path=str(out/'memory.png'),full_page=False)
 p.locator('#intelligenceDialog [data-close]').click();p.set_viewport_size({'width':390,'height':844});p.wait_for_timeout(350);p.screenshot(path=str(out/'mobile.png'),full_page=True)
 b.close()
