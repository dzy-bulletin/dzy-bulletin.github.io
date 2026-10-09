#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""鼎兆元｜電子佈告欄 — 資料帶入測試（data-drive-test）

  python3 e2e/run.py                 # 隨機種子
  E2E_SEED=12345 python3 e2e/run.py  # 重現同一組資料
  E2E_BASE=http://localhost:8792     # 本機伺服器（服務專案根目錄）

每次執行全部資料重抽（同仁、公告、日期、已讀、打卡名單、管理通行碼）；預期值由 dataset.py 照規格獨立計算；
每一顆按鈕都要點過（clickmap 稽核）；階段 B 以假日期跳到 4 天後驗證自動到期。存證截圖在 e2e/artifacts/。
"""
import json, math, os, random, sys, time
from datetime import datetime, timedelta, timezone, date
from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dataset as D
from clickmap import ClickMap, _KEY_LOGIC

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ART = os.path.join(ROOT, 'e2e', 'artifacts'); os.makedirs(ART, exist_ok=True)
SAMPLE = os.path.join(ROOT, 'spike', 'sample')
BASE = os.environ.get('E2E_BASE', 'http://localhost:8792')
SEED = int(os.environ.get('E2E_SEED') or random.randrange(1, 10 ** 9))
TODAY = (datetime.now(timezone.utc) + timedelta(hours=8)).date()
JUMP = 4                                    # 階段 B 往後跳幾天
BACKEND = os.environ.get('E2E_BACKEND', 'local')   # server＝打 Mac mini 伺服器（需以 E2E=1 啟動在 SERVER）
SERVER = os.environ.get('SERVER', 'http://127.0.0.1:8793')


def srv(path, body):
    import urllib.request
    req = urllib.request.Request(SERVER + path, data=json.dumps(body, ensure_ascii=False).encode(), headers={'Content-Type': 'text/plain'})
    return json.loads(urllib.request.urlopen(req, timeout=30).read())
def urllib_get(url):
    import urllib.request
    return json.loads(urllib.request.urlopen(url, timeout=30).read())
results, cm = [], ClickMap()
# 出網防呆（#13 第 2 輪）：任何指向 Google Apps Script 的請求一律攔下（abort）並記下來，最後讓測試失敗——測試絕不能打到正式 GAS
import re as _re
GOOGLE = _re.compile(r'^https?://([^/]*\.)?(script\.google\.com|googleusercontent\.com)(/|$)')
NET_HITS = []
def guard_google(ctx):
    def block(route):
        NET_HITS.append(route.request.method + ' ' + route.request.url[:120]); route.abort()
    ctx.route(GOOGLE, block)


def check(name, ok, detail=''):
    results.append((name, bool(ok)))
    print(('  PASS ' if ok else '  FAIL ') + name + ('' if ok else '  ← ' + str(detail)[:400]))


DATE_SHIFT_JS = """(() => { const off = +(localStorage.getItem('e2e_off') || 0) * 86400000; if (!off) return;
  const R = Date; class FakeDate extends R { constructor(...a) { if (a.length === 0) super(R.now() + off); else super(...a); } static now() { return R.now() + off; } }
  window.Date = FakeDate; })();"""


def main():
    if BACKEND == 'server' and not _re.match(r'^http://(127\.0\.0\.1|localhost):\d+/?$', SERVER):
        print(f'✗ E2E_BACKEND=server 時 SERVER 必須是 http://127.0.0.1:埠 或 http://localhost:埠（現在是 {SERVER}），拒絕執行'); sys.exit(2)
    data = D.make(SEED, TODAY)
    W = D.World(data)
    td = D.iso(TODAY)
    print(f'資料帶入測試（{"Mac mini 伺服器" if BACKEND == "server" else "本機假資料"}）｜種子 {SEED}｜今天 {td}｜同仁 {len(data["staff"])} 人、公告 {len(data["posts"])} 則、已讀 {len(data["reads"])} 筆')

    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={'width': 390, 'height': 844}, locale='zh-TW', timezone_id='Asia/Taipei')
        ctx.grant_permissions(['clipboard-read', 'clipboard-write'], origin=BASE)
        guard_google(ctx)
        ctx.add_init_script('window.__E2E_DATA = ' + json.dumps(data, ensure_ascii=False) + ';')
        ctx.add_init_script(DATE_SHIFT_JS)
        pg = ctx.new_page()
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.on('dialog', lambda d: d.accept())

        def wait(ms=280): pg.wait_for_timeout(ms)
        def scan(screen): cm.scan(pg, screen)
        def click(sel, verified='', nth=None):
            loc = pg.locator(sel).first if nth is None else pg.locator(sel).nth(nth)
            k = loc.evaluate(KEY_OF)
            loc.click(); cm.mark(k, verified or sel); wait()
        def text(sel): return pg.locator(sel).inner_text()
        def shot(name): pg.screenshot(path=os.path.join(ART, name + '.png'))
        def cards():
            return pg.evaluate("[...document.querySelectorAll('#app .card')].map(c => [c.querySelector('h3').textContent, !!c.querySelector('.unread')])")
        def tabs(): return pg.evaluate("[...document.querySelectorAll('#app .seg button')].map(b => b.textContent)")

        def verify_board(sid, day, label):
            s = W.staff[sid]; home = D.home_tab(s['unit'])
            exp_tabs = [D.UNIT_NAME[u] + (str(len(W.unread(sid, day))) if u == home and W.unread(sid, day) else '') for u in D.view_tabs(s['unit'])]
            check(f'{label} 分頁與未讀紅字', tabs() == exp_tabs, f'{tabs()} vs {exp_tabs}')
            for u in D.view_tabs(s['unit']):
                click(f'[data-unit="{u}"]', f'切到{D.UNIT_NAME[u]}分頁'); scan(f'{label}-{u}')
                exp = [[p['title'], D.must_sign(s['unit'], p) and (p['id'], sid) not in W.reads]
                       for p in D.board_order([p for p in W.board(s['unit'], day) if u in p['units']])]
                check(f'{label} {D.UNIT_NAME[u]}分頁公告順序與紅點', cards() == exp, f'{cards()} vs {exp}')

        def picker_names(grp):
            return pg.evaluate("[...document.querySelectorAll('[data-pick]')].map(b => b.innerText.replace(/\\s+/g, ' ').trim())")

        def store_of(s): return s.get('store') if s.get('store') in D.STORES.get(s['unit'], []) else '未分店'
        def expect_stores(grp):
            lst = [s for s in W.active_staff() if s['unit'] == grp]
            names = D.STORES[grp] + (['未分店'] if any(store_of(s) == '未分店' for s in lst) else [])
            return ['%s %d 人' % (n, sum(1 for s in lst if store_of(s) == n)) for n in names]
        def expect_picker(grp, store=None):
            out = []
            for s in W.active_staff():
                g = 'hq' if s['unit'].startswith('hq-') else s['unit']
                if g != grp: continue
                if store and store_of(s) != store: continue
                t = D.mask(s['name']) + (' 🔒' if s.get('fail', 0) >= 3 else '')
                if grp == 'hq': t += ' ' + D.STAFF_UNIT_NAME[s['unit']].replace('總部', '')
                out.append(t)
            return out

        def open_group(s):
            grp = 'hq' if s['unit'].startswith('hq-') else s['unit']
            click(f'[data-pu="{grp}"]', '切換名單分組')
            if grp in D.STORES: click(f'[data-ps="{store_of(s)}"]', '選門市')
        def login(sid, pin=None):
            s = W.staff[sid]; open_group(s)
            click(f'[data-pick="{sid}"]', '點名字進入密碼畫面')
            pg.fill('#pv', pin or s['pin']); click('#pfGo', '輸入密碼登入')
            pg.wait_for_selector('#app .card, #app .empty', timeout=8000); wait(400)

        # =============== 階段 A ===============
        print('— 階段 A：今天 —')
        START = BASE + ('/?mode=cloud&api=' + SERVER if BACKEND == 'server' else '/?mode=local')
        if BACKEND == 'server': srv('/__seed', data); srv('/__clock', {'offDays': 0})
        pg.goto(START); pg.evaluate('localStorage.clear()'); pg.goto(START)
        pg.wait_for_selector('[data-pu]'); scan('選名字'); shot('A01-選名字')
        check('A 頁尾有版本號與教學連結', 'v' in text('#foot') and '使用教學' in text('#foot'))
        for grp in ['mzt', 'mala', 'cf', 'hq']:
            click(f'[data-pu="{grp}"]', f'名單分組 {grp}'); scan('選名字-' + grp)
            if grp in D.STORES:
                got = pg.evaluate("[...document.querySelectorAll('[data-ps]')].map(b => b.innerText.replace(/\\s+/g, ' ').trim())")
                check('A 墨竹亭先顯示門市與各店人數', got == expect_stores(grp), f'{got} vs {expect_stores(grp)}')
                check('A 墨竹亭未選門市前不列名字', pg.locator('[data-pick]').count() == 0)
                for st in [x.split(' ')[0] for x in expect_stores(grp)]:
                    click(f'[data-ps="{st}"]', '選門市'); scan('選名字-門市')
                    check(f'A 墨竹亭 {st} 遮罩姓名與順序', picker_names(grp) == expect_picker(grp, st), f'{picker_names(grp)} vs {expect_picker(grp, st)}')
                    click('#backStore', '換門市')
            else:
                check(f'A 名單分組 {grp} 遮罩姓名與順序', picker_names(grp) == expect_picker(grp), f'{picker_names(grp)} vs {expect_picker(grp)}')
        click('#toAdmin', '⚙ 主管設定入口'); scan('主管登入'); check('A 主管設定入口開啟通行碼畫面', pg.locator('#pc').count() == 1)
        click('[data-close]', '取消'); pg.wait_for_selector('[data-pu]'); wait(300)
        check('A 取消主管設定後回到選名字（未登入）', '請選擇你是誰' in text('.sheet .bar'))
        if BACKEND != 'server':
            click('#testMe', '本機測試員按鈕（無測試員時仍回到選名字）'); pg.wait_for_selector('[data-pu]'); scan('選名字')
            check('A 測試員按鈕後仍在選名字', '請選擇你是誰' in text('.sheet .bar'))
        else:
            check('A 伺服器模式不顯示本機假資料提示', pg.locator('#demoBar').is_hidden())

        locked = next(s for s in W.active_staff() if s.get('fail', 0) >= 3)
        open_group(locked); click(f'[data-pick="{locked["id"]}"]', '點鎖定者'); scan('已鎖定')
        check('A 鎖定者顯示忘記密碼說明', '已鎖定' in text('.sheet') and '重設密碼' in text('.sheet'))
        click('#pfBack2', '我知道了→回名單'); click(f'[data-pick="{locked["id"]}"]'); click('#pfBack', '返回→回名單')

        nopin = next(s for s in W.active_staff() if not s['pin'])
        open_group(nopin); click(f'[data-pick="{nopin["id"]}"]', '點未設密碼者'); scan('設定密碼')
        check('A 未設密碼者進入設定密碼', '設定個人密碼' in text('.sheet .bar'))
        pg.fill('#p1', '1234'); pg.fill('#p2', '1234'); click('#pfGo')
        check('A 弱密碼被擋', '太好猜' in text('#pfErr'))
        newpin = D.rand_pin(random.Random(SEED + 1))
        pg.fill('#p1', newpin); pg.fill('#p2', str((int(newpin) + 1) % 10000).zfill(4)); click('#pfGo')
        check('A 兩次不一致被擋', '不一樣' in text('#pfErr'))
        pg.fill('#p2', newpin); click('#pfGo', '設定密碼並進入')
        pg.wait_for_selector('#app .card, #app .empty', timeout=8000); wait(400)
        W.staff[nopin['id']]['pin'] = newpin
        scan('公告'); shot('A02-公告')
        verify_board(nopin['id'], td, f'A 同仁（{D.STAFF_UNIT_NAME[nopin["unit"]]}）')

        # 簽一則：挑有附件的未讀優先
        me = nopin['id']; mu = W.staff[me]['unit']
        un = W.unread(me, td)
        pool = un or [p for p in W.board(mu, td) if D.home_tab(mu) in p['units']] or W.board(mu, td)
        target = sorted(pool, key=lambda p: -len(p['files']))[0]
        tab = D.home_tab(mu) if D.home_tab(mu) in target['units'] else target['units'][0]
        click(f'[data-unit="{tab}"]'); click(f'[data-post="{target["id"]}"]', '打開公告'); scan('公告內容')
        check('A 公告內容標題正確（不論是否需簽）', target['title'] in text('.sheet h2'))
        if not un:
            for i, f in enumerate(target['files']):
                click(f'[data-view="{i}"]', '開附件'); scan('附件檢視'); click('#vclose', '關閉附件')
            click('[data-close]', '關閉公告')
        if un:
            check('A 公告內容標題正確', target['title'] in text('.sheet h2'))
            for i, f in enumerate(target['files']):
                click(f'[data-view="{i}"]', '開附件'); scan('附件檢視')
                check(f'A 附件 {i + 1} 檢視器開啟且名稱正確', text('#vname') == f['name'] and '不提供下載' in text('#viewer'))
                click('#vclose', '關閉附件')
            click('#ackBtn', '我已閱讀'); scan('簽名')
            click('#sgOk'); check('A 空白簽名被擋', '請先簽名' in text('#sgErr'))
            click('#sgClear', '清除重簽'); click('#sgBack', '返回公告'); click('#ackBtn')
            box = pg.locator('#sgPad').bounding_box(); x0, y0 = box['x'] + 30, box['y'] + 110
            pg.mouse.move(x0, y0); pg.mouse.down()
            for i in range(1, 50): pg.mouse.move(x0 + i * 5, y0 - 40 * math.sin(i / 6))
            pg.mouse.up(); click('#sgOk', '確認簽名'); pg.wait_for_selector('.done'); scan('簽名完成'); shot('A03-簽名完成')
            check('A 簽名完成顯示簽名圖', pg.locator('.done img').count() == 1)
            W.reads.add((target['id'], me))
            click('[data-close]', '關閉公告')
            verify_board(me, td, 'A 簽名後')
        else:
            check('A 本組資料此人無未讀（跳過簽名，仍驗證公告）', True)

        click('[data-tab="hist"]', '歷史區'); pg.wait_for_selector('#app .hint'); wait(400); scan('歷史區'); shot('A04-歷史區')
        for u in D.view_tabs(mu):
            click(f'[data-unit="{u}"]')
            hist = [p for p in W.history(mu, td) if u in p['units']]
            months = sorted({D.status(p, td)[2] for p in hist}, reverse=True)
            got = pg.evaluate("[...document.querySelectorAll('[data-month]')].map(b => b.textContent)")
            check(f'A 歷史區 {D.UNIT_NAME[u]} 月份', got == [D.fmt_ym(m) for m in months], f'{got} vs {months}')
            for m in months:
                click(f'[data-month="{m}"]', '切換月份')
                exp = [p['title'] for p in D.history_order([p for p in hist if D.status(p, td)[2] == m], td)]
                got = [c[0] for c in cards()]
                check(f'A 歷史區 {D.UNIT_NAME[u]} {m} 公告與順序', got == exp, f'{got} vs {exp}')
        click('[data-tab="board"]', '回公告'); wait(400)

        click('#foot a', '使用教學連結'); pg.wait_for_load_state('load')
        check('A 使用教學連結導向講義', pg.url.endswith('/guide.html') and '使用教學' in pg.title())
        pg.go_back(); pg.wait_for_selector('#app .card, #app .empty', timeout=8000); wait(400)

        # 總部兩種身分
        click('#chgMe', '不是我→登出'); pg.wait_for_selector('[data-pu]')
        hqb = data['firsts'][random.Random(SEED).choice(['hq-mzt', 'hq-mala'])]
        grp = 'hq'; click('[data-pu="hq"]'); click(f'[data-pick="{hqb}"]')
        scan('輸入密碼'); pg.fill('#pv', '0000' if W.staff[hqb]['pin'] != '0000' else '1357'); click('#pfGo')
        check('A 輸錯顯示剩餘次數', '還可以試 2 次' in text('#pfErr'))
        W.staff[hqb]['fail'] = 1
        click('#pfForgot', '忘記密碼'); scan('忘記密碼'); check('A 忘記密碼說明', '重設密碼' in text('.sheet .content'))
        click('#fgBack', '返回密碼'); click('#pfForgot'); click('#fgOk', '我知道了→回名單')
        login(hqb); W.staff[hqb]['fail'] = 0
        verify_board(hqb, td, f'A {D.STAFF_UNIT_NAME[W.staff[hqb]["unit"]]}')
        click('#chgMe'); pg.wait_for_selector('[data-pu]')
        dzy = data['firsts']['hq-dzy']; login(dzy)
        verify_board(dzy, td, 'A 總部鼎兆元')

        # =============== 設定（主管） ===============
        click('#openAdmin', '⚙ 設定'); scan('主管登入'); pg.fill('#pc', 'wrong-pass'); click('#pcGo')
        check('A 管理通行碼錯誤有提示', '錯誤' in text('#pcErr'))
        pg.fill('#pc', data['adminPass']); click('#pcGo', '進入設定'); pg.wait_for_selector('[data-af]'); scan('設定-公告管理'); shot('A05-公告管理')

        def admin_rows():
            return pg.evaluate("""[...document.querySelectorAll('.sheet .panel .arow')].map(r => {
              const m = /已讀\\s*(\\d+)\\/(\\d+)/.exec(r.textContent); return [r.querySelector('.t').textContent.replace(/^📌 /, ''), m ? +m[1] : null, m ? +m[2] : null]; })""")

        def verify_admin_lists(label, day):
            groups = {'on': [], 'plan': [], 'off': []}
            for p in W.posts.values(): groups[D.status(p, day)[0]].append(p)
            got = pg.evaluate("[...document.querySelectorAll('[data-af]')].map(b => b.textContent)")
            exp = ['上架中 %d' % len(groups['on']), '排定上架 %d' % len(groups['plan']), '已下架 %d' % len(groups['off'])]
            check(f'{label} 三種狀態數量', got == exp, f'{got} vs {exp}')
            for st in ['on', 'plan', 'off']:
                click(f'[data-af="{st}"]', f'狀態篩選 {st}'); scan('設定-' + st)
                lst = D.history_order(groups[st], day) if st == 'off' else D.board_order(groups[st])
                exp = [[p['title'], None if st == 'plan' else W.read_count(p), None if st == 'plan' else len(W.targets(p))] for p in lst]
                check(f'{label} {st} 列表順序與已讀人數', admin_rows() == exp, f'{admin_rows()} vs {exp}')

        verify_admin_lists('A 設定', td)

        # 回條與複製未簽名名單：每則已上架過的公告都驗
        for st in ['on', 'off']:
            click(f'[data-af="{st}"]')
            for p in [p for p in W.posts.values() if D.status(p, td)[0] == st]:
                click(f'[data-rx="{p["id"]}"]', '展開回條'); pg.wait_for_selector(f'[data-cp="{p["id"]}"]', timeout=5000); scan('回條')
                got = pg.evaluate("[...document.querySelectorAll('.names span')].map(s => [s.textContent.trim().slice(2).split(/\\s/)[0], s.textContent.trim()[0] === '✓'])")
                rows = W.receipt_rows(p)
                exp_sorted = sorted([[r['name'], r['read']] for r in rows], key=lambda x: x[1])
                check(f'A 回條 {p["title"]} 名單與已簽／未簽（未簽在前）', sorted(got) == sorted(exp_sorted) and all(not g[1] for g in got[:sum(1 for r in rows if not r['read'])]), f'{got} vs {exp_sorted}')
                click(f'[data-cp="{p["id"]}"]', '複製未簽名名單'); wait(300)
                clip = pg.evaluate('navigator.clipboard.readText()')
                exp = D.unsigned_text(p['title'], rows)
                check(f'A 複製未簽名 {p["title"]} 文字一字不差', clip == exp, f'{clip!r} vs {exp!r}')
                click(f'[data-rx="{p["id"]}"]', '收起回條')
        shot('A06-回條')

        # 新增公告（隨機內容＋真實檔案）
        r2 = random.Random(SEED + 2)
        click('[data-at="new"]', '新增公告分頁'); scan('設定-新增'); click('#fSave')
        check('A 沒標題被擋', '請填標題' in text('#fErr'))
        title = '【帶入測試】%s-%d' % (r2.choice(D.TITLES), SEED % 1000)
        pg.fill('#fTitle', title); pg.fill('#fBody', '帶入測試內容 %d' % SEED); click('#fSave')
        check('A 沒單位被擋', '請選擇顯示單位' in text('#fErr'))
        click('#uAll', '全部'); click('#uAll', '取消全部')
        units = sorted(r2.sample(D.UNITS, r2.randint(1, 3)), key=D.UNITS.index)
        for u in units: click(f'.uOne[value="{u}"]', '勾單位')
        exp_d = D.iso(TODAY + timedelta(days=r2.randint(5, 30))) if r2.random() < 0.7 else ''
        pg.evaluate("v => { const e = document.querySelector('#fExp'); e.value = v; e.dispatchEvent(new Event('input')); }", exp_d)
        pinned = r2.random() < 0.5
        if pinned: click('#fPin', '置頂')
        else: click('#fPin'); click('#fPin', '勾選再取消置頂')
        fls = r2.sample(['測試_請假流程.pdf', '測試_請假流程.docx', '測試_假日對照表.xlsx'], r2.randint(2, 3))
        cm.mark('#fFile', '選附件'); pg.set_input_files('#fFile', [os.path.join(SAMPLE, f) for f in fls])
        pg.wait_for_function("!document.querySelector('#upMsg')", timeout=20000); wait(300); scan('設定-新增')
        got = pg.evaluate("[...document.querySelectorAll('.sheet .file .fn')].map(e => e.textContent)")
        check('A 真實附件上傳完成', got == fls, f'{got} vs {fls}')
        click('#fSave', '上架公告'); pg.wait_for_selector('[data-af]'); wait(400)
        nid = pg.evaluate("t => { const r = [...document.querySelectorAll('.sheet .arow')].find(a => a.querySelector('.t').textContent.replace(/^📌 /, '') === t); return r && r.querySelector('[data-ed]').dataset.ed; }", title)
        check('A 新公告出現在上架中', bool(nid))
        W.posts[nid] = {'id': nid, 'title': title, 'units': units, 'publishOn': td, 'expiresOn': exp_d, 'pinned': pinned,
                        'published': True, 'offOn': '', 'files': [{'name': f} for f in fls]}
        shot('A07-新增公告')

        # 編輯：改標題、移除一個附件、取消編輯
        click(f'[data-ed="{nid}"]', '編輯'); scan('設定-編輯')
        click('#fCancel', '取消編輯'); click('[data-af="on"]'); click(f'[data-ed="{nid}"]')
        click('[data-rmf]', '移除附件', nth=0)
        pg.fill('#fTitle', title + '（改）'); click('#fSave', '儲存修改'); pg.wait_for_selector('[data-af]'); wait(400)
        W.posts[nid]['title'] = title + '（改）'; W.posts[nid]['files'] = W.posts[nid]['files'][1:]
        if BACKEND == 'server':   # M7（#18）：主管移除附件後，Mac mini 本機那份仍保留（位元組還在、meta 補上 removedAt）；revoke 照常送 Drive
            kept = None
            for _ in range(50):
                kept = next((x for x in srv('/__files', {})['data'] if (x.get('meta') or {}).get('name') == fls[0] and (x.get('meta') or {}).get('removedAt')), None)
                if kept: break
                time.sleep(0.1)
            revoked = urllib_get(SERVER + '/__bridgeCalls')['data']['revoke']
            check('A 移除的附件本機仍保留、meta 有 removedAt、revoke 已送（M7）', bool(kept and kept['bytes']) and revoked >= 1, f'{kept} revoke={revoked}')
        click('[data-af="on"]')
        check('A 編輯後標題更新', any(r[0] == title + '（改）' for r in admin_rows()))

        # 置頂／下架／重新上架／過期重新上架導向編輯
        onp = [p for p in W.posts.values() if D.status(p, td)[0] == 'on' and p['id'] != nid]
        tp = r2.choice(onp)
        click(f'[data-pin="{tp["id"]}"]', '置頂切換'); W.posts[tp['id']]['pinned'] = not tp['pinned']
        click('[data-af="on"]'); op = r2.choice([p for p in W.posts.values() if D.status(p, td)[0] == 'on'])
        click(f'[data-off="{op["id"]}"]', '下架'); W.posts[op['id']]['published'] = False; W.posts[op['id']]['offOn'] = td
        click('[data-af="off"]')
        man = next((p for p in W.posts.values() if D.status(p, td)[0] == 'off' and not p['published'] and not (p['expiresOn'] and p['expiresOn'] < td)), None)
        click(f'[data-re="{man["id"]}"]', '重新上架'); W.posts[man['id']]['published'] = True; W.posts[man['id']]['offOn'] = ''
        exp_p = next((p for p in W.posts.values() if D.status(p, td)[0] == 'off' and p['published'] and p['expiresOn'] and p['expiresOn'] < td), None)
        if exp_p:
            click('[data-af="off"]'); click(f'[data-re="{exp_p["id"]}"]')
            check('A 已過期公告重新上架導向編輯改期', '編輯公告' in text('.sheet .seg .on'))
            click('#fCancel')
        click('[data-at="posts"]', '公告管理分頁')
        verify_admin_lists('A 操作後', td)

        # 同仁名單
        click('[data-at="staff"]', '同仁名單分頁'); scan('設定-同仁'); shot('A08-同仁名單')
        def panel_counts(): return pg.evaluate("[...document.querySelectorAll('.sheet .panel h4')].map(h => h.textContent).filter(t => /人$/.test(t))")
        def exp_counts(): return ['%s %d 人' % (D.STAFF_UNIT_NAME[u], sum(1 for s in W.active_staff() if s['unit'] == u)) for u in D.STAFF_UNITS]
        check('A 各單位人數', panel_counts() == exp_counts(), f'{panel_counts()} vs {exp_counts()}')
        nn = '帶入新人%d' % (SEED % 100); nu = r2.choice(D.STAFF_UNITS)
        pg.fill('#sName', 'X' + nn); scan('設定-同仁-墨竹亭')
        check('A 預設單位墨竹亭時門市選單一開始就看得到（不需切換）', pg.locator('#sUnit').input_value() == 'mzt' and pg.locator('#sStore').is_visible())
        pg.select_option('#sUnit', 'cf'); check('A 切到央廚門市選單隱藏', not pg.locator('#sStore').is_visible())
        pg.select_option('#sUnit', 'mzt'); cm.mark('#sUnit', '選單位')
        check('A 切回墨竹亭門市選單出現', pg.locator('#sStore').is_visible())
        click('#sAdd'); check('A 墨竹亭沒選門市被擋', '請選擇門市' in text('#sErr'))
        pg.select_option('#sStore', D.STORES['mzt'][0]); cm.mark('#sStore', '選門市')
        pg.select_option('#sUnit', nu); pg.fill('#sName', nn)
        nst = r2.choice(D.STORES['mzt']) if nu in D.STORES else ''
        if nst: pg.select_option('#sStore', nst); cm.mark('#sStore', '選門市')
        click('#sAdd', '新增同仁')
        W.staff['NEW'] = {'id': 'NEW', 'name': nn, 'unit': nu, 'pin': None, 'active': True, 'fail': 0, 'store': nst}
        check('A 新增後各單位人數', panel_counts() == exp_counts(), f'{panel_counts()} vs {exp_counts()}')
        mv = r2.choice([s for s in W.active_staff() if s['unit'] == 'mzt' and s['id'] != 'NEW'])
        to = r2.choice([x for x in D.STORES['mzt'] if x != mv.get('store')])
        cm.mark(pg.locator(f'[data-st="{mv["id"]}"]').evaluate(KEY_OF), '換門市'); pg.select_option(f'[data-st="{mv["id"]}"]', to); wait(700)
        W.staff[mv['id']]['store'] = to
        check('A 換門市後顯示新門市', pg.locator(f'[data-st="{mv["id"]}"]').input_value() == to)
        cand = [s for s in W.active_staff() if s['pin'] and s['id'] not in (dzy, 'NEW')]
        rs = r2.choice(cand)
        click(f'[data-rp="{rs["id"]}"]', '重設密碼'); W.staff[rs['id']]['pin'] = None
        check('A 重設後顯示未設密碼', '未設密碼' in pg.locator('.sheet .arow', has_text=rs['name']).inner_text())
        dl = r2.choice([s for s in W.active_staff() if s['id'] not in (dzy, 'NEW', rs['id'])])
        click(f'[data-del="{dl["id"]}"]', '刪除同仁'); W.staff[dl['id']]['active'] = False
        check('A 刪除後各單位人數', panel_counts() == exp_counts(), f'{panel_counts()} vs {exp_counts()}')
        # 打卡同步：預期值照規格自己算
        added, adopted = [], 0
        for row in data['clock']:
            if not row['active']: continue
            same = next((s for s in W.active_staff() if s['name'] == row['name'] and s['unit'] == row['unit'] and not s.get('src')), None)
            gone = next((s for s in W.staff.values() if not s['active'] and s['name'] == row['name'] and s['unit'] == row['unit'] and not s.get('src')), None)
            if same: same['src'] = 1; adopted += 1
            elif gone: gone['src'] = 1
            else:
                added.append('%s（%s）' % (row['name'], D.STAFF_UNIT_NAME[row['unit']]))
                W.staff['SYNC%d' % len(added)] = {'id': 'x', 'name': row['name'], 'unit': row['unit'], 'pin': None, 'active': True, 'fail': 0, 'src': 1, 'store': row.get('store', '')}
        click('#syncBtn', '從打卡系統同步'); wait(600)
        s1 = text('.upbar')
        check('A 打卡同步新增名單與對應數', ('新增 %d 人' % len(added)) in s1 and all(a in s1 for a in added) and (adopted == 0 or ('對應既有名單 %d 人' % adopted) in s1), f'{s1} / 預期新增 {added}、對應 {adopted}')
        check('A 同步後各單位人數', panel_counts() == exp_counts(), f'{panel_counts()} vs {exp_counts()}')
        click('#syncBtn'); wait(600)
        check('A 第二次同步不重複', '新增 0 人' in text('.upbar'))

        click('#lock', '登出設定'); wait(400)
        check('A 登出設定後回到公告', pg.locator('.sheet').is_hidden() or not pg.locator('#mask.show').count())
        verify_board(dzy, td, 'A 設定操作後同仁端')
        click('#openAdmin'); pg.fill('#pc', data['adminPass']); click('#pcGo'); pg.wait_for_selector('[data-af]')
        click('[data-close]', '關閉設定'); wait(400)

        # =============== 階段 B：跳到 JUMP 天後 ===============
        print(f'— 階段 B：日期跳到 {JUMP} 天後 —')
        tb = D.iso(TODAY + timedelta(days=JUMP))
        if BACKEND == 'server': srv('/__clock', {'offDays': JUMP})
        pg.evaluate(f"localStorage.setItem('e2e_off', '{JUMP}')"); pg.reload()
        pg.wait_for_selector('#app .card, #app .empty', timeout=8000); wait(900)
        check('B 假日期生效', pg.evaluate('DZYB.today()') == tb, pg.evaluate('DZYB.today()'))
        soon = [p for p in W.posts.values() if D.status(p, td)[0] == 'on' and D.status(p, tb)[0] == 'off']
        check('B 本組資料有會在跳日期後到期的公告', len(soon) > 0, '資料產生器應保證 soon 類型')
        verify_board(dzy, tb, 'B 總部鼎兆元')
        click('[data-tab="hist"]'); wait(500)
        for u in D.UNITS:
            click(f'[data-unit="{u}"]')
            months = sorted({D.status(p, tb)[2] for p in W.history('hq-dzy', tb) if u in p['units']}, reverse=True)
            got = pg.evaluate("[...document.querySelectorAll('[data-month]')].map(b => b.textContent)")
            check(f'B 歷史區 {D.UNIT_NAME[u]} 月份（含剛到期）', got == [D.fmt_ym(m) for m in months], f'{got} vs {months}')
        shot('B01-歷史區')
        click('[data-tab="board"]'); wait(300)

        if BACKEND != 'server':
            click('#resetDemo', '重置假資料'); pg.wait_for_selector('[data-pu]', timeout=8000); scan('重置後')
            check('B 重置假資料後回到選名字', '請選擇你是誰' in text('.sheet .bar'))

            # =============== 階段 L：LINE 自動登入（line.html 本機模擬，不經 LIFF）===============
            print('— 階段 L：LINE 自動登入 —')
            LN = data['line']; solo = W.staff[LN['solo']]
            HOME_RE = _re.compile(r'/index\.html\?mode=local$')
            def line_go(uid):
                pg.goto(BASE + '/line.html?mode=local' + ('&test_uid=' + uid if uid else ''))
            def at_home(): pg.wait_for_url(HOME_RE, timeout=8000); pg.wait_for_selector('#app .card, #app .empty, [data-pu]', timeout=8000); wait(400)
            line_go(None); at_home()
            check('L 沒設 LIFF_ID、沒帶測試帳號：直接轉首頁', bool(HOME_RE.search(pg.url)) and pg.locator('#pkNotice').count() == 0, pg.url)
            line_go('U-solo'); at_home()
            check('L 綁定一人：自動登入並回首頁（不用選名字）', pg.locator('#meName').count() == 1 and text('#meName').startswith(solo['name']), pg.locator('#meName').all_inner_texts())
            check('L 登入後首頁有公告列表', pg.locator('#app .card, #app .empty').count() > 0)
            line_go('U-shared'); pg.wait_for_selector('.sheet [data-pick]', timeout=8000); wait(300); scan('LINE 選人'); shot('L01-LINE選人')
            got = pg.evaluate("[...document.querySelectorAll('.sheet [data-pick]')].map(b => b.dataset.pick + ' ' + b.innerText.split('\\n')[0])")
            exp = [i + ' ' + D.mask(W.staff[i]['name']) for i in LN['shared']]
            check('L 一個 LINE 對到兩人：列出遮罩姓名讓本人選', got == exp, f'{got} vs {exp}')
            pick = LN['shared'][1]
            click(f'.sheet [data-pick="{pick}"]', 'LINE 選人→登入'); at_home()
            check('L 選人後以該同仁登入', text('#meName').startswith(W.staff[pick]['name']), text('#meName'))
            line_go('U-shared'); pg.wait_for_selector('#lcNone', timeout=8000); wait(300); scan('LINE 選人')
            click('#lcNone', '都不是我→回首頁'); at_home()
            check('L 「都不是我」回首頁、不改登入的人', text('#meName').startswith(W.staff[pick]['name']))
            line_go('U-nobody'); at_home()
            check('L 對不到人（已登入）：回首頁並提示一次', '還沒對到名單' in text('#toast'), text('#toast'))
            click('#chgMe', '不是我→登出'); pg.wait_for_selector('[data-pu]')
            line_go('U-nobody'); at_home(); pg.wait_for_selector('#pkNotice', timeout=8000)
            check('L 對不到人（未登入）：選名字畫面上方顯示提示', '還沒對到名單' in text('#pkNotice'), text('#pkNotice'))
            pg.reload(); pg.wait_for_selector('[data-pu]', timeout=8000); wait(300)
            check('L 提示只顯示一次（重新整理後消失）', pg.locator('#pkNotice').count() == 0)
            scan('選名字')

        try: moved_check(b)
        except Exception as e: check('M 後端搬家檢查執行中斷（可能是重載迴圈）', False, repr(e))
        try: netfail_check(b)
        except Exception as e: check('N 後端打不通檢查執行中斷', False, repr(e))
        check('Z 全程沒有頁面錯誤（pageerror）', not errs, errs)
        b.close()

    rep = cm.report()
    print(f'\n按鈕稽核：畫面上出現 {rep["total"]} 種可點元素，已點過驗證 {rep["clicked"]} 種')
    if rep['missed']: print('  漏點：', rep['missed'])
    if rep['extra']: print('  key 不一致（點過但沒掃描到）：', rep['extra'])
    check('Z 沒有任何請求打到 Google Apps Script（已攔截）', not NET_HITS, NET_HITS[:5])
    check('Z 每一顆按鈕都點過（clickmap 稽核）', not rep['missed'] and not rep['extra'], rep['missed'] or rep['extra'])
    bad = [r for r in results if not r[1]]
    print(f'\n共 {len(results)} 項檢查，通過 {len(results) - len(bad)}，失敗 {len(bad)}｜種子 {SEED}' + ('' if not bad else f'（重現：E2E_SEED={SEED} python3 e2e/run.py）'))
    sys.exit(1 if bad else 0)


def moved_check(b):
    """#7 後端搬家：舊後端回 MOVED → 自動重載；持續 MOVED 時 5 分鐘內只重載 1 次，之後停在提示。
    假後端（Playwright 攔截）：名單正常、其餘動作一律 MOVED——等同 PRIMARY=mini 的 GAS、或 GitHub Pages 快取還給舊網址。"""
    import re
    print('— 後端搬家（MOVED）—')
    fake = 'http://127.0.0.1:9/'
    ctx = b.new_context(viewport={'width': 390, 'height': 844}, locale='zh-TW', timezone_id='Asia/Taipei')
    guard_google(ctx)
    pg = ctx.new_page()
    errs, calls, loads = [], [], [0]
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.on('load', lambda _: loads.__setitem__(0, loads[0] + 1))
    def handle(route):
        a = json.loads(route.request.post_data or '{}').get('action'); calls.append(a)
        body = ({'ok': True, 'data': [{'id': 'S-001', 'name': '陳O安', 'unit': 'mala', 'store': '', 'hasPin': True, 'locked': False}]} if a == 'roster'
                else {'ok': False, 'code': 'MOVED', 'message': '系統已搬家，請重新整理'})
        route.fulfill(status=200, content_type='application/json', headers={'Access-Control-Allow-Origin': '*'}, body=json.dumps(body, ensure_ascii=False))
    pg.route(re.compile(r'^http://127\.0\.0\.1:9/'), handle)
    def wait_loads(n, ms=6000):
        t = time.time()
        while loads[0] < n and time.time() - t < ms / 1000: pg.wait_for_timeout(100)
        return loads[0]
    def try_login():
        pg.wait_for_selector('[data-pu]', timeout=8000); pg.wait_for_timeout(300)
        pg.click('[data-pu="mala"]'); pg.click('[data-pick="S-001"]'); pg.fill('#pv', '2580'); pg.click('#pfGo')
    pg.goto(BASE + '/?mode=cloud&api=' + fake); wait_loads(1)
    got = pg.evaluate('CFG.GAS_URL')
    if got != fake: raise RuntimeError(f'?api= 沒生效（CFG.GAS_URL={got}），為免打到正式 GAS 中止；E2E_BASE 請用 localhost 或 127.0.0.1')
    pg.evaluate("localStorage.setItem('dzyb_lastBad', 'x')")
    try_login()
    n1 = wait_loads(2)
    check('M 收到 MOVED 自動重載一次', n1 == 2 and 'login' in calls, f'載入 {n1} 次、呼叫 {calls}')
    check('M 重載前清掉 lastBad、記下重載時間', pg.evaluate("[localStorage.getItem('dzyb_lastBad'), !!sessionStorage.getItem('dzyb_movedReloadAt')]") == [None, True])
    try_login(); pg.wait_for_selector('#pfErr:not(:empty)', timeout=8000); pg.wait_for_timeout(1500)
    msg = pg.inner_text('#pfErr')
    check('M 5 分鐘內再收到 MOVED 不再重載、停在提示文字', loads[0] == 2 and msg == '系統搬家中，約 10 分鐘後請重新整理', f'載入 {loads[0]} 次、提示「{msg}」')
    pg.click('#pfGo'); pg.wait_for_timeout(1500)
    check('M 持續 MOVED：連按多次仍只重載過 1 次', loads[0] == 2 and calls.count('login') >= 3, f'載入 {loads[0]} 次、login {calls.count("login")} 次')
    pg.screenshot(path=os.path.join(ART, 'M01-搬家提示.png'))
    pg.evaluate("sessionStorage.setItem('dzyb_movedReloadAt', String(Date.now() - 5 * 60 * 1000 - 1000))")   # 上次重載是 5 分鐘前
    pg.fill('#pv', '2580'); pg.click('#pfGo')
    check('M 超過 5 分鐘後再收到 MOVED 可以再自動重載一次', wait_loads(3) == 3, f'載入 {loads[0]} 次')
    # 管理端走同一個 call()：主管登入收到 MOVED 也自動重載；5 分鐘內再一次就停在提示
    pg.evaluate("sessionStorage.setItem('dzyb_movedReloadAt', String(Date.now() - 5 * 60 * 1000 - 1000))")
    pg.wait_for_selector('#toAdmin', timeout=8000); pg.wait_for_timeout(300)
    pg.click('#toAdmin'); pg.fill('#pc', 'x' * 8); pg.click('#pcGo')
    check('M 主管登入收到 MOVED 自動重載', wait_loads(4) == 4 and 'adminLogin' in calls, f'載入 {loads[0]} 次')
    pg.wait_for_selector('#toAdmin', timeout=8000); pg.wait_for_timeout(300)
    pg.click('#toAdmin'); pg.fill('#pc', 'x' * 8); pg.click('#pcGo'); pg.wait_for_selector('#pcErr:not(:empty)', timeout=8000); pg.wait_for_timeout(800)
    check('M 主管登入 5 分鐘內再 MOVED：停在提示', loads[0] == 4 and pg.inner_text('#pcErr') == '系統搬家中，約 10 分鐘後請重新整理', f'載入 {loads[0]} 次、「{pg.inner_text("#pcErr")}」')
    check('M 全程沒有頁面錯誤（pageerror）', not errs, errs)
    ctx.close()


def _dead_port():
    """挑一個現在沒有程式在聽的本機埠：先綁一個臨時埠拿到號碼，立刻關掉。"""
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as so:
        so.bind(('127.0.0.1', 0)); port = so.getsockname()[1]
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as so:          # 再確認一次真的沒人接
        so.settimeout(0.5)
        if so.connect_ex(('127.0.0.1', port)) == 0: raise RuntimeError(f'埠 {port} 有程式在聽，換一次再跑')
    return port


def netfail_check(b):
    """CUTOVER 8-3：後端打不通（Mac mini 關機、Funnel 斷線）時不白屏，畫面講清楚「連不上伺服器」。
    頁面一定要從 localhost 打開：js/config.js 只在本機網址才接受 ?api=，否則會直接打正式後端。"""
    import re
    print('— 後端打不通（不白屏）—')
    if not re.match(r'^http://localhost:\d+/?$', BASE):
        raise RuntimeError(f'E2E_BASE 必須是 http://localhost:埠（現在是 {BASE}），否則 ?api= 不生效')
    dead = 'http://127.0.0.1:%d' % _dead_port()
    ctx = b.new_context(viewport={'width': 390, 'height': 844}, locale='zh-TW', timezone_id='Asia/Taipei')
    guard_google(ctx)
    pg = ctx.new_page()
    errs, reqs = [], []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.on('request', lambda r: reqs.append(r.url))
    pg.goto(BASE.rstrip('/') + '/?mode=cloud&api=' + dead)
    got = pg.evaluate('CFG.GAS_URL')
    if got != dead: raise RuntimeError(f'?api= 沒生效（CFG.GAS_URL={got}），為免打到正式後端中止')
    pg.wait_for_selector('.errbox:not(:empty)', timeout=20000); pg.wait_for_timeout(300)
    msg = pg.inner_text('.errbox')
    check('N 後端打不通：畫面出現「連不上伺服器，請確認網路」', msg == '連不上伺服器，請確認網路', f'畫面：「{msg}」')
    check('N 後端打不通：頁面有內容（有重試鈕，不是白屏）', pg.locator('#rt').is_visible() and len(pg.inner_text('body').strip()) > 10)
    check('N 後端打不通：真的有去打那個沒人聽的埠', any(u.startswith(dead) for u in reqs), reqs[-5:])
    pg.screenshot(path=os.path.join(ART, 'N01-連不上伺服器.png'))
    check('N 全程沒有頁面錯誤（pageerror）', not errs, errs)
    ctx.close()


KEY_OF = 'e => {' + _KEY_LOGIC + '}'   # 與 clickmap 共用同一段 key 規則，不另抄


if __name__ == '__main__':
    main()
