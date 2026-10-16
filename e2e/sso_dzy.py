"""python3 e2e/sso_dzy.py [截圖資料夾] — 管理系統公告專區自動登入（v0.7.7，審查 #42-8）。需要本機 ~/dzy（管理系統 repo）；沒有就跳過。
兩邊串起來的瀏覽器實測：管理系統（本機檔案，假裝在 https://dzy.mozhuting.com）嵌入佈告欄（本機檔案，假裝在 https://dzy-bulletin.github.io），
佈告欄 API 轉到本機 E2E 佈告欄伺服器；平台後端用 dzy e2e 的 MockBackend，另補 ssoTicket。"""
import os, sys, json, mimetypes, subprocess, socket, time, urllib.request
sys.path.insert(0, os.path.expanduser('~/dzy/test/e2e'))
from common import MockBackend, USERS
from playwright.sync_api import sync_playwright

OUT = sys.argv[1] if len(sys.argv) > 1 else '/tmp'
if not os.path.isdir(os.path.expanduser('~/dzy/test/e2e')):
    print('SKIP：找不到 ~/dzy'); sys.exit(0)
DZY = os.path.expanduser('~/dzy'); BUL = os.path.expanduser('~/dzy-bulletin')
T = lambda n: 'e2e0' + '0' * 57 + n

def free_port():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]; s.close(); return p

port = free_port()
data = subprocess.check_output(['mktemp', '-d']).decode().strip(); home = subprocess.check_output(['mktemp', '-d']).decode().strip()
env = dict(os.environ, DZYB_NO_DOTENV='1', E2E='1', PORT=str(port), DATA_DIR=data, HOME=home)
for k in ['BRIDGE_URL', 'BRIDGE_KEY', 'ALLOW_ORIGIN', 'DZY_PLATFORM_URL', 'BULLETIN_SVC_KEY']: env.pop(k, None)
srv = subprocess.Popen(['node', os.path.join(BUL, 'server/index.js')], env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
for _ in range(100):
    try:
        urllib.request.urlopen('http://127.0.0.1:%d/health' % port, timeout=1); break
    except Exception: time.sleep(0.1)
def bpost(path, body):
    r = urllib.request.Request('http://127.0.0.1:%d%s' % (port, path), data=json.dumps(body).encode(), headers={'Content-Type': 'text/plain'})
    return json.loads(urllib.request.urlopen(r).read())
bpost('/__seed', {'staff': [{'id': 'S-001', 'name': '測試同仁甲', 'unit': 'mala', 'pin': '2580', 'dzy': 'DZY001'}, {'id': 'S-002', 'name': '測試同仁乙', 'unit': 'mala', 'pin': '1357'}],
                  'posts': [{'id': 'P-1', 'title': '單一登入測試公告', 'units': ['mala', 'mzt', 'cf'], 'publishOn': '2026-01-01'}], 'reads': [], 'adminPass': 'adminpass88', 'clock': []})

def serve_static(root, prefix):
    def h(route):
        from urllib.parse import urlparse
        p = urlparse(route.request.url).path
        if p.endswith('/'): p += 'index.html'
        f = os.path.join(root, p.lstrip('/'))
        if not os.path.isfile(f): return route.fulfill(status=404, body='nf')
        route.fulfill(status=200, body=open(f, 'rb').read(), content_type=mimetypes.guess_type(f)[0] or 'application/octet-stream')
    return h

TICKET = {'v': None}
results = []
def check(c, label): results.append((bool(c), label)); print(('PASS' if c else 'FAIL') + ': ' + label)

mock = MockBackend('https://dzy.mozhuting.com')
orig = mock.platform_action
def pa(action, body):
    if action == 'ssoTicket':
        mock.sso_calls = getattr(mock, 'sso_calls', 0) + 1
        if (body.get('payload') or {}).get('aud') != 'bulletin': return {'ok': False, 'code': 'bad_aud'}
        return {'ok': True, 'data': {'ticket': TICKET['v'], 'expires_in': 60}} if TICKET['v'] else {'ok': False, 'code': 'no_emp', 'error': '這個帳號沒有同仁編號'}
    return orig(action, body)
mock.platform_action = pa

try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        def run(name, ticket, w=1280, h=900):
            TICKET['v'] = ticket
            ctx = b.new_context(viewport={'width': w, 'height': h}); page = ctx.new_page()
            mock.install(page)
            page.route('https://dzy.mozhuting.com/**', serve_static(DZY, '/'))
            page.route('https://dzy-bulletin.github.io/**', serve_static(BUL, '/'))
            def bul_api(route):
                from urllib.parse import urlparse
                u = urlparse(route.request.url)
                if u.path.startswith('/platform'): return route.fallback()
                r = urllib.request.Request('http://127.0.0.1:%d%s' % (port, u.path or '/'), data=(route.request.post_data or '').encode() or None,
                                           headers={'Content-Type': 'text/plain', 'X-Forwarded-For': '203.0.113.50'}, method=route.request.method)
                body = urllib.request.urlopen(r).read()
                route.fulfill(status=200, body=body, content_type='application/json', headers={'Access-Control-Allow-Origin': 'https://dzy-bulletin.github.io'})
            page.route('https://dingzhaoyuandemac-mini.tailc27c34.ts.net/**', bul_api)
            page.goto('https://dzy.mozhuting.com/index.html')
            page.fill('#login-username', 'admin'); page.fill('#login-password', USERS['admin']['password']); page.click('[data-role="submit"]')
            page.wait_for_selector('[data-role="view-content"]', state='attached', timeout=10000)
            page.click('[data-nav="bulletin"]:visible')
            fr = page.frame_locator('[data-role="bulletin-frame"]')
            page.wait_for_timeout(3500)
            page.screenshot(path=os.path.join(OUT, 'sso_' + name + '.png'))
            txt = fr.locator('body').inner_text()
            ctx.close()
            return txt
        t1 = run('ok', T('001'))
        check('單一登入測試公告' in t1 and '測試同仁甲' in t1 and '請選擇你是誰' not in t1, '同仁帳號：公告專區直接登入佈告欄（看到公告與自己的名字，沒出現選名字）')
        t2 = run('noemp', None)
        check('請選擇你是誰' in t2, '系統帳號（換不到券）：退回選名字')
        t3 = run('unlinked', T('777'))
        check('請選擇你是誰' in t3 and '還沒對到佈告欄名單' in t3, '編號對不到佈告欄名單：退回選名字，並說明原因')
        t4 = run('phone', T('001'), 390, 800)
        check('單一登入測試公告' in t4, '手機寬度也能自動登入')
        check(getattr(mock, 'sso_calls', 0) == 4, '每次打開公告專區只換一張券（共 4 次）')
        check(mock.leaked == [], '沒有請求漏到真網路：%s' % mock.leaked)
        b.close()
finally:
    srv.kill()
print('結果：%d／%d 通過' % (sum(1 for ok, _ in results if ok), len(results)))
sys.exit(0 if all(ok for ok, _ in results) else 1)
