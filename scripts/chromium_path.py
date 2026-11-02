#!/usr/bin/env python3
"""Print a Chromium binary for the browser suites (`make test-ui`), or nothing when Playwright's own build is installed.

Playwright expects one exact Chromium revision. When that revision is missing but another cached build exists (a newer or
older `playwright install`), the suites fail to launch. This prints the newest cached `chrome-headless-shell` (or full
Chromium) so the Makefile can export CHROMIUM_PATH. An explicit CHROMIUM_PATH in the environment always wins.
"""
import glob, os, sys

def expected():
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            return p.chromium.executable_path
    except Exception:
        return None

def cached():
    roots = [os.environ.get('PLAYWRIGHT_BROWSERS_PATH') or '', os.path.expanduser('~/.cache/ms-playwright'), os.path.expanduser('~/Library/Caches/ms-playwright')]
    pats = ['chromium_headless_shell-*/chrome-*/chrome-headless-shell', 'chromium_headless_shell-*/chrome-*/headless_shell',
            'chromium-*/chrome-linux*/chrome', 'chromium-*/chrome-mac*/Chromium.app/Contents/MacOS/Chromium',
            'chromium-*/chrome-mac*/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing']
    rev = lambda p: int(''.join(c for c in p.split('ms-playwright')[-1].split('/')[1].split('-')[-1] if c.isdigit()) or 0)
    for pat in pats:
        found = [f for r in roots if r for f in glob.glob(os.path.join(r, pat)) if os.access(f, os.X_OK)]
        if found:
            return max(found, key=rev)
    return None

def main():
    if os.environ.get('CHROMIUM_PATH'):
        print(os.environ['CHROMIUM_PATH']); return 0
    exp = expected()
    if exp and os.path.exists(exp):
        return 0  # Playwright's own build is there: no override needed
    c = cached()
    if c:
        print(c)
    return 0

if __name__ == '__main__':
    sys.exit(main())
