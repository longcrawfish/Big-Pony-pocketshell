"""Real browser + isolated Agent/tmux regression. Requires Python Playwright and Bun.
BUN_BINARY, PS_BROWSER (optional executable), PS_TEST_OUTPUT configure local tools.
No production sockets, identity directories or services are used.
"""
import json
import os
from pathlib import Path
import select
import shlex
import shutil
import subprocess
import tempfile
import time
import urllib.request
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[2]
BUN = os.environ.get('BUN_BINARY', 'bun')
OUT = Path(os.environ.get('PS_TEST_OUTPUT', '/tmp/pocketshell-v2-browser'))
OUT.mkdir(parents=True, exist_ok=True)
env = dict(os.environ, PATH=str(Path(BUN).parent) + ':' + os.environ['PATH'], VITE_POCKETSHELL_DEV_HELPERS='1', PS_E2E_ORIGIN='http://127.0.0.1:5283')
processes = []
info = None
report = {'hardware': 'Chromium emulation; not a Bigme/Brave acceptance', 'checks': [], 'metrics': {}}
started = time.monotonic()

def check(name):
    report['checks'].append(name)
    print('PASS', name, flush=True)

def tmux(*args):
    return subprocess.check_output(['tmux', '-S', str(Path(info['keyDir']) / 'tmux.sock'), *args], text=True).strip()

def seed(page, settings=None):
    payload = {'info': info, 'settings': settings}
    page.add_init_script('''const seed = ''' + json.dumps(payload) + ''';
      const i=seed.info;
      localStorage.setItem('pocketshell.agentPubKey',i.agentPubKey);
      localStorage.setItem('pocketshell.agentAddr','ws://127.0.0.1:'+i.port);
      localStorage.setItem('pocketshell.identity',JSON.stringify(i.browserIdentity));
      localStorage.setItem('ps.kbTutSeen.layered','1');
      localStorage.setItem('ps.kbTutSeen.flick','1');
      if(seed.settings && !localStorage.getItem('ps.settings')) localStorage.setItem('ps.settings',JSON.stringify(seed.settings));
    ''')

def size_panel(page):
    if not page.locator('.size-controls').count():
        page.locator('.tab.active .size-toggle').click()
    return page.locator('.size-controls')

def close_size(page):
    if page.locator('.size-controls').count(): page.keyboard.press('Escape')

try:
    log = open(OUT / 'vite.log', 'w')
    vite = subprocess.Popen([BUN, 'run', 'dev', '--host', '127.0.0.1', '--port', '5283', '--strictPort'], cwd=ROOT/'app', env=env, stdout=log, stderr=subprocess.STDOUT)
    processes.append(vite)
    agentlog = open(OUT / 'agent-stderr.log', 'w')
    agent = subprocess.Popen([BUN, 'run', 'e2e/setup-agent.ts'], cwd=ROOT/'app', env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=agentlog, text=True)
    processes.append(agent)
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        if select.select([agent.stdout], [], [], 0.1)[0]:
            line = agent.stdout.readline()
            try:
                candidate = json.loads(line)
                if 'browserIdentity' in candidate: info = candidate; break
            except ValueError: pass
    assert info, 'Agent did not start'
    # Drain agent stdout so diagnostics cannot fill the pipe during the test.
    import threading
    threading.Thread(target=lambda: [None for _ in agent.stdout], daemon=True).start()
    while time.monotonic() < deadline:
        try:
            urllib.request.urlopen('http://127.0.0.1:5283', timeout=1).close(); break
        except Exception: time.sleep(.1)
    with sync_playwright() as p:
        launch = {'headless': True}
        if os.environ.get('PS_BROWSER'): launch['executable_path'] = os.environ['PS_BROWSER']
        browser = p.chromium.launch(**launch)
        errors = []
        mobile = browser.new_context(viewport={'width': 360, 'height': 800}, is_mobile=True, has_touch=True, locale='zh-CN')
        page = mobile.new_page(); page.on('pageerror', lambda e: errors.append(str(e)))
        seed(page)
        page.goto('http://127.0.0.1:5283')
        try:
            page.wait_for_function('window.pocketshell?.getState().status === "online"')
        except Exception:
            print('Browser startup errors:', errors, flush=True)
            print('Browser startup UI:', page.locator('body').inner_text()[:400], flush=True)
            page.screenshot(path=str(OUT/'startup-failure.png'))
            raise
        # Inspect real xterm viewport positions without adding a production API.
        # Import the already loaded Vite module and capture subsequent terminals.
        page.evaluate('''async () => {
          const url = performance.getEntriesByType('resource').map(r => r.name)
            .find(name => name.includes('/@xterm_xterm.js'));
          if (!url) throw new Error('xterm module not loaded');
          const { Terminal } = await import(url);
          const open = Terminal.prototype.open;
          window.scrollTerms = [];
          Terminal.prototype.open = function(...args) {
            window.scrollTerms.push(this);
            return open.apply(this, args);
          };
          window.activeScrollTerm = () => window.scrollTerms.find(t =>
            t.element?.closest('.term-wrap:not(.hidden)'));
        }''')
        name = 'v2-acceptance'
        first = time.monotonic()
        page.evaluate('(s)=>window.pocketshell.newSession(s)', name)
        expect(size_panel(page)).to_contain_text('本页控制尺寸', timeout=15000)
        report['metrics']['local_first_control_ms'] = round((time.monotonic()-first)*1000)
        check('first entry automatically acquires size control')
        close_size(page)
        page.wait_for_timeout(700)
        grid = tmux('display-message', '-p', '-t', name, '#{window_width}x#{window_height}')
        term_box = page.locator('.term-wrap:not(.hidden) .term').bounding_box()
        for _ in range(3):
            page.locator('.tab.active .name').click()
            expect(page.locator('.size-controls')).to_be_visible()
            page.wait_for_timeout(450)
            assert tmux('display-message', '-p', '-t', name, '#{window_width}x#{window_height}') == grid
            assert page.locator('.term-wrap:not(.hidden) .term').bounding_box() == term_box
            page.locator('.tab.active .name').click()
            expect(page.locator('.size-controls')).to_have_count(0)
        page.locator('.tab.active .name').dblclick(delay=50)
        expect(page.locator('.size-controls')).to_have_count(0)
        expect(page.locator('.dlg')).to_have_count(0)
        size_panel(page)
        page.evaluate("window.sizeDismissClicks=0;document.querySelector('.term-wrap:not(.hidden) .term').addEventListener('pointerdown',()=>window.sizeDismissClicks++)")
        page.locator('.size-backdrop').click(position={'x': 10, 'y': 500})
        expect(page.locator('.size-controls')).to_have_count(0)
        assert page.evaluate('window.sizeDismissClicks') == 0
        assert tmux('display-message', '-p', '-t', name, '#{window_width}x#{window_height}') == grid
        check('panel toggles preserve real tmux grid and terminal bounds; rapid taps do not close; outside press is consumed')
        page.evaluate('window.pocketshell.sendInput("for i in $(seq 1 250); do echo SCROLL_ROW_$i; done\\n")')
        page.wait_for_function('window.activeScrollTerm()?.buffer.active.baseY > 150')
        page.wait_for_timeout(500)
        for direction, label in [('top', '滚动到顶部'), ('bottom', '滚动到底部'), ('bottom', '滚动到底部')]:
            size_panel(page)
            page.get_by_role('button', name=label, exact=True).click()
            expect(page.locator('.size-controls')).to_have_count(0)
            page.wait_for_function('''(direction) => {
              const b = window.activeScrollTerm().buffer.active;
              return b.viewportY === (direction === 'top' ? 0 : b.baseY);
            }''', arg=direction)
            assert not page.evaluate("document.activeElement?.matches('input, textarea')")
        assert page.evaluate('window.sizeDismissClicks') == 0
        assert tmux('display-message', '-p', '-t', name, '#{window_width}x#{window_height}') == grid
        check('mobile scroll actions reach real xterm endpoints, dismiss without input focus or click-through, and preserve size')
        second = 'size-menu-second-session-with-a-long-title'
        page.evaluate('(s)=>window.pocketshell.newSession(s)', second)
        expect(page.locator('.tab.active .size-toggle')).to_be_visible()
        page.locator('.tab.active .size-toggle').click()
        page.locator('.tab[title="'+name+'"] .size-toggle').click()
        expect(page.locator('.size-controls')).to_have_attribute('aria-label', '页面控制: '+name)
        close_size(page)
        page.locator('.tab[title="'+second+'"] .name').click()
        expect(page.locator('.size-controls')).to_have_count(0)
        expect(page.locator('.tab.active')).to_have_attribute('title', second)
        page.evaluate('(s)=>window.pocketshell.enterSession(s)', name)
        expect(page.locator('.tab.active')).to_have_attribute('title', name)
        check('inactive labels select without opening; inactive arrows select and open the matching session')

        close_size(page)
        page.evaluate('window.pocketshell.openPanel("set")')
        page.get_by_role('switch').click()
        page.get_by_role('button', name='大字', exact=True).click()
        page.wait_for_function('document.documentElement.dataset.uiSize === "large"')
        assert page.evaluate('getComputedStyle(document.documentElement).getPropertyValue("--dimmer").trim()') == '#444'
        for width, height in [(320,800),(360,800),(390,844),(844,390)]:
            page.set_viewport_size({'width':width,'height':height})
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), (width,height)
            assert page.locator('.stg-scroll').evaluate('(el)=>el.scrollWidth <= el.clientWidth + 1'), (width,height)
            assert page.locator('nav.bar .btab').first.evaluate('(el)=>el.getBoundingClientRect().height >= 44')
            assert page.locator('.conn-label').evaluate('(el)=>el.getBoundingClientRect().bottom <= document.querySelector(".topbar").getBoundingClientRect().bottom')
        page.set_viewport_size({'width':360,'height':800})
        page.screenshot(path=str(OUT/'eink-settings.png'))
        for width, height in [(320,800),(360,800),(390,844),(844,390),(360,300)]:
            page.set_viewport_size({'width':width,'height':height})
            panel = size_panel(page)
            box = panel.bounding_box()
            assert box['x'] >= 0 and box['x']+box['width'] <= width+1, box
            assert box['y']+box['height'] <= height+1, box
            assert page.locator('.tab.active .name').evaluate('(el)=>el.getBoundingClientRect().width >= 20')
            assert page.locator('.tab.active .size-summary').evaluate('(el)=>el.scrollWidth <= el.clientWidth+1')
            assert page.locator('.tab.active .x').evaluate('(el)=>el.getBoundingClientRect().right <= document.querySelector(".strip").getBoundingClientRect().right+1')
            if width == 320: page.screenshot(path=str(OUT/'size-menu-eink-320.png'))
            close_size(page)
        page.set_viewport_size({'width':360,'height':800})
        check('size panel and tab controls fit e-ink large text at 320/360/390px, landscape and reduced keyboard viewport')
        check('large e-ink settings, navigation and contrast at 320/360/390px and landscape')
        page.reload(); page.wait_for_function('window.pocketshell?.getState().status === "online"')
        assert page.evaluate('JSON.parse(localStorage.getItem("ps.settings")).eink') is True
        close_size(page)
        page.evaluate('window.pocketshell.openPanel("set")')
        page.get_by_role('switch').click()
        normal = page.evaluate('JSON.parse(localStorage.getItem("ps.settings"))')
        assert normal['fontSize'] == 10 and normal['theme'] == 'cream-dark' and normal['uiSize'] == 'compact'
        page.get_by_role('switch').click()
        page.evaluate('window.pocketshell.openPanel("kbd")')
        page.evaluate('(s)=>window.pocketshell.enterSession(s)',name)
        size_panel(page).locator('.actions button').first.click()  # explicitly reacquire after reload
        expect(size_panel(page)).to_contain_text('本页控制尺寸')
        check('reload persists e-ink preferences; mode exit restores ordinary preferences')
        desktop = browser.new_context(viewport={'width':1280,'height':900},locale='en-US')
        other = desktop.new_page(); other.on('pageerror', lambda e: errors.append(str(e)))
        seed(other)
        other.goto('http://127.0.0.1:5283')
        other.wait_for_function('window.pocketshell?.getState().status === "online"')
        other.evaluate('(s)=>window.pocketshell.enterSession(s)',name)
        expect(size_panel(other)).to_contain_text('Another client controls size',timeout=15000)
        other.get_by_role('button',name='Take size control',exact=True).click()
        expect(size_panel(other)).to_contain_text('This tab controls size')
        expect(size_panel(page)).to_contain_text('另一客户端控制尺寸')
        remote_cols = int(tmux('display-message','-p','-t',name,'#{pane_width}'))
        assert remote_cols > 80
        assert page.locator('.term-wrap.observing .term').evaluate('(el)=>el.scrollWidth > el.clientWidth')
        page.locator('.term-wrap.observing .term').evaluate('(el)=>el.scrollLeft=el.scrollWidth')
        assert page.locator('.term-wrap.observing .term').evaluate('(el)=>el.scrollLeft') > 0
        page.screenshot(path=str(OUT/'observer-scroll.png'))
        check('desktop takeover preserves authoritative grid with horizontal scroll on mobile')
        # Observers retain input permission; compare with tmux, not renderer internals.
        page.evaluate('window.pocketshell.sendInput("printf \'中文输入 SIZE_INPUT_OK\\n\'\\n")')
        deadline = time.monotonic()+10
        while 'SIZE_INPUT_OK' not in tmux('capture-pane','-p','-t',name) and time.monotonic()<deadline: time.sleep(.1)
        assert 'SIZE_INPUT_OK' in tmux('capture-pane','-p','-t',name)
        check('observer still sends Chinese input to the same live session')
        # Exercise a real alternate screen with ANSI, inverse text and a marker
        # in the far-right column; the narrow observer must expose that column.
        program = "import os; os.write(1, b'\\x1b[?1049h\\x1b[2J\\x1b[H'+ '全屏中文 '.encode()+b'\\x1b[31mANSI\\x1b[0m \\x1b[7mREVERSE\\x1b[0m\\x1b[2;1HLEFT\\x1b[2;"+str(remote_cols)+"HR'); input(); os.write(1,b'\\x1b[?1049l')"
        page.evaluate('(cmd)=>window.pocketshell.sendInput(cmd)', 'python3 -c '+shlex.quote(program)+'\n')
        deadline=time.monotonic()+10
        while tmux('display-message','-p','-t',name,'#{alternate_on}') != '1' and time.monotonic()<deadline: time.sleep(.1)
        captured=tmux('capture-pane','-p','-t',name).splitlines()
        assert '全屏中文' in captured[0] and 'REVERSE' in captured[0]
        assert captured[1].endswith('R') and len(captured[1])==remote_cols
        size_panel(page)
        expect(page.get_by_role('button', name='滚动到顶部', exact=True)).to_be_disabled(timeout=10000)
        expect(page.get_by_role('button', name='滚动到底部', exact=True)).to_be_disabled()
        page.locator('.term-wrap.observing .term').evaluate('(el)=>el.scrollLeft=el.scrollWidth')
        page.screenshot(path=str(OUT/'alternate-screen-right-edge.png'))
        close_size(other)
        other.get_by_role('button',name='✂ Quick ops',exact=True).click()
        other.get_by_role('button',name='Select text',exact=True).click()
        expect(other.locator('.cm-rows')).to_contain_text('全屏中文')
        other.locator('.cm-rows').scroll_into_view_if_needed()
        bounds=other.locator('.cm-rows').bounding_box()
        other.mouse.move(bounds['x']+3,bounds['y']+5); other.mouse.down()
        other.mouse.move(bounds['x']+90,bounds['y']+5,steps=10); other.mouse.up()
        other.wait_for_function('window.getSelection()?.toString().length > 0')
        other.locator('.cm-bar .primary').click()
        page.evaluate('window.pocketshell.sendInput("\\n")')
        expect(page.get_by_role('button', name='滚动到顶部', exact=True)).to_be_enabled(timeout=10000)
        check('alternate screen, Chinese, ANSI/inverse output and desktop selection remain usable')
        size_panel(other)
        other.get_by_role('button',name='Release size',exact=True).click()
        expect(size_panel(other)).to_contain_text('Size released')
        assert tmux('show-options','-wv','-t',name,'window-size') == ''
        other.set_viewport_size({'width':900,'height':600}); page.set_viewport_size({'width':800,'height':360})
        other.reload(); other.wait_for_function('window.pocketshell?.getState().status === "online"')
        other.evaluate('(s)=>window.pocketshell.enterSession(s)',name)
        expect(size_panel(other)).to_contain_text('Size released')
        assert tmux('show-options','-wv','-t',name,'window-size') == ''
        check('release restores inheritance; rotation and reload cannot reacquire')
        page.set_viewport_size({'width':360,'height':800})
        page.get_by_role('button',name='接管尺寸',exact=True).click()
        expect(size_panel(page)).to_contain_text('本页控制尺寸')
        close_size(page)
        page.evaluate('window.pocketshell.openPanel("set")')
        slider=page.locator('input[type="range"]')
        slider.evaluate('(el)=>{el.value="24";el.dispatchEvent(new Event("input",{bubbles:true}));}')
        page.evaluate('window.pocketshell.openPanel("kbd")')
        page.set_viewport_size({'width':240,'height':360})
        expect(page.locator('.size-warning')).to_be_visible(timeout=10000)
        assert int(tmux('display-message','-p','-t',name,'#{window_width}')) >= 20
        page.set_viewport_size({'width':390,'height':844})
        expect(page.locator('.size-warning')).not_to_be_visible(timeout=10000)
        check('24px terminal font keeps 20x4 guard and exposes/recoveries a too-small viewport')
        # Real background/connection-loss grace, with the observer still connected.
        page.close()
        expect(size_panel(other)).to_contain_text('Size released',timeout=40000)
        assert tmux('show-options','-wv','-t',name,'window-size') == ''
        check('closed controller expires and restores policy while observer remains connected')
        assert errors == [], errors
        report['browser'] = browser.version
        report['elapsed_seconds'] = round(time.monotonic()-started,2)
        browser.close()
finally:
    (OUT/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
    for child in reversed(processes):
        child.terminate()
        try: child.wait(timeout=5)
        except subprocess.TimeoutExpired: child.kill(); child.wait()
    if info: shutil.rmtree(info['keyDir'],ignore_errors=True)
