"""Compiled Agent + real browser security regression; all identities/files are temporary.
Build agent first; set BUN_BINARY and optional PS_BROWSER / PS_TEST_BINARY.
"""
import json, os, select, shutil, subprocess, time, urllib.request, urllib.error
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[2]
bun = os.environ.get('BUN_BINARY', 'bun')
fixture = subprocess.Popen([bun, 'agent/scripts/security-browser-fixture.ts'], cwd=root,
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
info = None
def read_json(timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if select.select([fixture.stdout], [], [], .1)[0]:
            line = fixture.stdout.readline()
            if not line: raise RuntimeError('fixture exited')
            try: return json.loads(line)
            except ValueError: pass
    raise TimeoutError('fixture reply')
def rpc(method, params):
    fixture.stdin.write(json.dumps({'id': 'test', 'method': method, 'params': params})+'\n'); fixture.stdin.flush()
    return read_json()['response']
def status(url):
    try:
        with urllib.request.urlopen(url) as r: return r.status
    except urllib.error.HTTPError as e: return e.code

try:
    while not info:
        obj = read_json()
        if 'browserIdentity' in obj: info = obj
    url = 'http://127.0.0.1:'+str(info['port'])
    with sync_playwright() as p:
        launch = {'headless': True}
        if os.environ.get('PS_BROWSER'): launch['executable_path'] = os.environ['PS_BROWSER']
        browser = p.chromium.launch(**launch)
        context = browser.new_context(viewport={'width': 1280, 'height': 900}, locale='zh-CN')
        context.add_init_script('''if(window===top){const i='''+json.dumps(info)+''';
          localStorage.setItem('pocketshell.identity',JSON.stringify(i.browserIdentity));
          localStorage.setItem('pocketshell.agentPubKey',i.agentPubKey);
          localStorage.setItem('pocketshell.agentAddr','ws://127.0.0.1:'+i.port);
          localStorage.setItem('pocketshell.projectRoot',i.project);
          localStorage.setItem('ps.kbTutSeen.layered','1');
          localStorage.setItem('ps.settings',JSON.stringify({language:'zh'}));
          window.cspViolations=[];
          document.addEventListener('securitypolicyviolation',e=>window.cspViolations.push(e.violatedDirective));}
        ''')
        page = context.new_page(); errors=[]
        page.on('pageerror', lambda e: errors.append(str(e)))
        response = page.goto(url)
        assert 'Content-Security-Policy'.lower() in response.headers
        expect(page.locator('.conn-online')).to_be_visible(timeout=30000)
        assert page.evaluate('window.cspViolations') == []
        page.evaluate('''()=>{const s=document.createElement('script');s.textContent='window.injected=true';document.head.appendChild(s)}''')
        assert page.evaluate('window.injected === undefined')
        print('PASS compiled binary: Noise connection and enforced main-page CSP', flush=True)
        page.locator('button:has-text("文件")').first.click()
        page.locator('.tree .row', has_text='page.html').first.click()
        iframe = page.locator('.preview:not(.hidden) iframe')
        expect(iframe).to_be_visible()
        expect(iframe).to_have_attribute('sandbox', '')
        frame = iframe.content_frame
        expect(frame.locator('h1')).to_have_text('Preview fixture')
        expect(frame.locator('h1')).to_have_css('color', 'rgb(12, 34, 56)')
        assert frame.locator('body').get_attribute('data-ran') is None
        src = iframe.get_attribute('src')
        assert status(src.split('/page.html')[0]+'/.env') == 403
        print('PASS HTML defaults: scripts blocked, relative CSS loads, leaked token cannot read secrets', flush=True)
        page.locator('.preview:not(.hidden) details summary').click()
        page.on('dialog', lambda d: d.accept())
        page.get_by_role('button', name='启用交互脚本', exact=True).click()
        expect(iframe).to_have_attribute('sandbox', 'allow-scripts')
        expect(iframe.content_frame.locator('body')).to_have_attribute('data-ran', 'yes')
        expect(iframe.content_frame.locator('body')).to_have_attribute('data-parent', 'blocked')
        enabled_src = iframe.get_attribute('src')
        assert status(enabled_src.split('/page.html')[0]+'/.env') == 403
        assert status(src) == 403
        assert rpc('preview.mint', {'base':info['project'],'files':['link.png']})['ok'] is False
        print('PASS opted-in scripts remain isolated; old tokens and symlink grants refused', flush=True)
        # Opening a different preview hides and revokes the previous token.
        page.locator('.tree .row', has_text='readme.md').first.click()
        expect(page.locator('.preview:not(.hidden) .md-body h1')).to_have_text('Markdown fixture')
        assert status(enabled_src) == 403
        page.locator('.tree .row', has_text='edit.txt').first.click()
        page.locator('.preview:not(.hidden)').get_by_role('button', name='编辑', exact=True).click()
        expect(page.locator('.cm-editor')).to_be_visible()
        assert not errors, errors
        print('PASS Markdown sanitizer, preview lifecycle, and lazy CodeMirror under CSP', flush=True)
        browser.close()
finally:
    fixture.terminate()
    try: fixture.wait(timeout=10)
    except subprocess.TimeoutExpired: fixture.kill(); fixture.wait()
    if info: shutil.rmtree(info['keyDir'], ignore_errors=True)
