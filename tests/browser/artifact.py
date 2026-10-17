"""Upgrade/rollback of two local binaries using one persistent test identity/profile.
Requires BUN_BINARY, PS_OLD_BINARY, PS_NEW_BINARY and Python Playwright.
Both binaries must support POCKETSHELL_TMUX_SOCKET; never use a legacy binary
without socket isolation. PS_BROWSER and PS_TEST_OUTPUT are optional.
"""
import hashlib,json,os,select,shutil,subprocess,time,urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
root=Path(__file__).resolve().parents[2]; bun=os.environ.get('BUN_BINARY','bun')
old=Path(os.environ['PS_OLD_BINARY']).resolve(); new=Path(os.environ['PS_NEW_BINARY']).resolve()
out=Path(os.environ.get('PS_TEST_OUTPUT','/tmp/pocketshell-v2-artifact')); out.mkdir(parents=True,exist_ok=True)
os.umask(0o077)
env=dict(os.environ,PATH=str(Path(bun).parent)+':'+os.environ['PATH']); info=None; server=None; result={}
def stop():
 global server
 if server:
  server.terminate()
  try: server.wait(timeout=8)
  except subprocess.TimeoutExpired: server.kill(); server.wait()
  server=None
def start(binary):
 global server
 server=subprocess.Popen([str(binary)],cwd=root,env=env,stdout=open(out/'binary.log','a'),stderr=subprocess.STDOUT)
 for i in range(200):
  if server.poll() is not None: raise RuntimeError('binary exited '+str(server.returncode))
  try:
   urllib.request.urlopen(url,timeout=.5).close(); return
  except Exception: time.sleep(.05)
 raise RuntimeError('binary startup timeout')
try:
 fixture=subprocess.Popen([bun,'run','e2e/setup-agent.ts'],cwd=root/'app',env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True)
 try:
  deadline=time.monotonic()+20
  while time.monotonic()<deadline:
   if select.select([fixture.stdout],[],[],.1)[0]:
    try:
     x=json.loads(fixture.stdout.readline())
     if 'browserIdentity' in x: info=x; break
    except ValueError: pass
  assert info
 finally: fixture.terminate(); fixture.wait(timeout=8)
 keys=Path(info['keyDir']); url='http://127.0.0.1:'+str(info['port'])
 env.update(POCKETSHELL_KEY_DIR=str(keys),POCKETSHELL_RUN_DIR=str(keys/'run'),POCKETSHELL_TMUX_SOCKET=str(keys/'tmux.sock'),POCKETSHELL_HOST='127.0.0.1',POCKETSHELL_PORT=str(info['port']),POCKETSHELL_UPDATE='0')
 for name in ['TMUX','TMUX_PANE','POCKETSHELL_PANE_TAP']: env.pop(name,None)
 (keys/'devices.json').write_text(json.dumps({'v':1,'devices':[{'pubKey':info['browserIdentity']['publicKey'],'name':'Artifact test','addedAt':'2026-10-17T00:00:00Z','lastSeen':None}]}))
 os.chmod(keys/'devices.json',0o600)
 identity={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in keys.iterdir() if p.is_file() and 'size-control' not in p.name and p.name!='devices.json'}
 versions={k:subprocess.check_output([str(p),'--version'],text=True).strip() for k,p in [('old',old),('new',new)]}
 assert versions['old']!=versions['new']
 with sync_playwright() as p:
  launch={'headless':True}
  if os.environ.get('PS_BROWSER'): launch['executable_path']=os.environ['PS_BROWSER']
  browser=p.chromium.launch(**launch)
  context=browser.new_context(viewport={'width':390,'height':844},locale='zh-CN')
  context.add_init_script('''const i='''+json.dumps(info)+'''; if(!localStorage.getItem('pocketshell.identity')) {
    localStorage.setItem('pocketshell.identity',JSON.stringify(i.browserIdentity));
    localStorage.setItem('pocketshell.agentPubKey',i.agentPubKey);
    localStorage.setItem('pocketshell.agentAddr','ws://127.0.0.1:'+i.port);
    localStorage.setItem('ps.settings',JSON.stringify({eink:true,theme:'eink',fontSize:18,uiSize:'large',kbLayout:'layered',language:'zh'}));
    localStorage.setItem('ps.kbTutSeen.layered','1'); }
  ''')
  page=context.new_page()
  for label,binary in [('old',old),('new',new),('rollback',old)]:
   stop()
   # Legacy binaries may trust a cached version from the replacement binary.
   # Discard only the derived server update cache when rolling back to one.
   if label=='rollback': (keys/'update-cache.json').unlink(missing_ok=True)
   start(binary)
   page.on('console',lambda m: print('CONSOLE',m.type,m.text[:300],flush=True) if m.type=='error' else None)
   page.on('pageerror',lambda e: print('PAGEERROR',str(e),flush=True))
   page.goto(url) # normal navigation; no cache/storage clearing
   expect(page.locator('.conn-online')).to_be_visible(timeout=40000)
   v=versions['new' if label=='new' else 'old']
   expect(page.locator('.version')).to_have_text('v'+v,timeout=40000)
   page.wait_for_function('(v)=>navigator.serviceWorker.controller?.scriptURL.endsWith("?v="+v)',arg=v,timeout=40000)
   page.reload(); expect(page.locator('.conn-online')).to_be_visible(timeout=40000)
   assert page.evaluate('document.documentElement.dataset.eink')=='true'
   assert page.evaluate('JSON.parse(localStorage.getItem("ps.settings")).uiSize')=='large'
   assert page.evaluate('localStorage.getItem("pocketshell.identity")')
   buckets=page.evaluate('caches.keys()')
   assert all(b=='ps-v'+v for b in buckets if b.startswith('ps-v')),buckets
   result[label]={'version':v,'cache_buckets':buckets,'paired':True,'preferences_retained':True}
   print('PASS',label,v,flush=True)
   page.close(); page=context.new_page() # same profile, reopen
  browser.close()
 stop()
 for name,digest in identity.items(): assert hashlib.sha256((keys/name).read_bytes()).hexdigest()==digest,name
 assert json.loads((keys/'devices.json').read_text())['devices'][0]['pubKey']==info['browserIdentity']['publicKey']
 result['identity_files_unchanged']=True
 (out/'report.json').write_text(json.dumps(result,indent=2))
finally:
 stop()
 if info:
  subprocess.run(['tmux','-S',str(keys/'tmux.sock'),'kill-server'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  shutil.rmtree(keys,ignore_errors=True)
