#!/usr/bin/env python3
"""鼎兆元｜電子佈告欄 — 整套關裁判腳本（端到端，local 假資料模式）

用法：
  python3 e2e/judge.py                      # 正常跑，全部 PASS 才 exit 0
  python3 e2e/judge.py --break sign         # 故意弄壞「沒簽名也能送出」，證明裁判抓得到錯（應 FAIL）
  python3 e2e/judge.py --base http://localhost:8792

需要本機伺服器提供專案根目錄（例：python3 -m http.server 8792 --directory ~/dzy-bulletin）。
上傳測試使用 spike/sample/ 的真實 Word／PDF／Excel 檔。
"""
import argparse, asyncio, math, os, re, sys
from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SAMPLE = os.path.join(ROOT, 'spike', 'sample')
results = []
# 出網防呆（#13 第 2 輪）：指向 Google Apps Script 的請求一律攔下並記錄，最後讓測試失敗
GOOGLE = re.compile(r'^https?://([^/]*\.)?(script\.google\.com|googleusercontent\.com)(/|$)')
NET_HITS = []


def check(name, ok, detail=''):
    results.append((name, bool(ok), detail))
    print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else f'  ← {detail}'))


async def main(base, brk):
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 390, 'height': 844}, locale='zh-TW', timezone_id='Asia/Taipei')
        await ctx.grant_permissions(['clipboard-read', 'clipboard-write'], origin=base)
        async def block(route):
            NET_HITS.append(route.request.method + ' ' + route.request.url[:120]); await route.abort()
        await ctx.route(GOOGLE, block)
        pg = await ctx.new_page()
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.on('dialog', lambda d: asyncio.ensure_future(d.accept()))
        if brk == 'sign':   # 故意弄壞：簽名長度檢查失效
            async def sabotage(route):
                r = await route.fetch(); body = (await r.text()).replace('if (len < 40)', 'if (false)')
                await route.fulfill(response=r, body=body)
            await pg.route(re.compile(r'.*/js/sign\.js.*'), sabotage)

        q = lambda sel: pg.locator(sel)
        txt = lambda sel: pg.locator(sel).inner_text()
        async def count(sel): return await pg.locator(sel).count()
        async def wait(ms=250): await pg.wait_for_timeout(ms)
        async def close_sheet(): await pg.evaluate('UI.closeSheet()'); await wait(300)
        async def login(sid, pin='0000', grp=None):
            if grp: await q(f'[data-pu="{grp}"]').click()
            await q(f'[data-pick="{sid}"]').click(); await q('#pv').fill(pin); await q('#pfGo').click()
            await pg.wait_for_selector('.card, .empty', timeout=5000); await wait(300)
        async def sign():
            box = await q('#sgPad').bounding_box(); x0, y0 = box['x'] + 30, box['y'] + 110
            await pg.mouse.move(x0, y0); await pg.mouse.down()
            for i in range(1, 50): await pg.mouse.move(x0 + i * 5, y0 - 40 * math.sin(i / 6))
            await pg.mouse.up()

        # ---------- 靜態檢查 ----------
        html = open(os.path.join(ROOT, 'index.html'), encoding='utf-8').read()
        check('S1 原始碼不含本機假資料提示（連結預覽不會抓到）', '本機假資料' not in html)
        check('S2 有 og:title／og:description／og:image', all(k in html for k in ('og:title', 'og:description', 'og:image')))

        await pg.goto(base + '/?mode=local'); await pg.evaluate('localStorage.clear()')
        await pg.goto(base + '/?mode=local'); await pg.wait_for_selector('[data-pick]')

        # ---------- 同仁端 ----------
        names = await pg.locator('[data-pick]').all_inner_texts()
        check('A1 名單顯示遮罩姓名', '陳O安' in names and '陳大安' not in ''.join(names), names)
        groups = await pg.locator('[data-pu]').all_inner_texts()
        check('A2 選名字有四個分組（含總部）', groups == ['墨竹亭', '小辛辣', '央廚', '總部'], groups)
        check('A3 選名字畫面有主管設定入口', await count('#toAdmin') == 1)

        await q('[data-pick="S-013"]').click()
        check('A3a 名單不透露誰沒設密碼：預設顯示輸入密碼', await count('#pv') == 1)
        await q('#pfFirst').click()
        await q('#p1').fill('2580'); await q('#p2').fill('2580'); await q('#pfGo').click()
        check('A3b 沒填啟用碼被擋', '啟用碼' in await txt('#pfErr'))
        await q('#ac').fill('135799'); await q('#pfGo').click(); await wait(300)
        check('A3c 啟用碼錯被擋、顯示剩餘次數', '還可以試 2 次' in await txt('#pfErr'), await txt('#pfErr'))
        await q('#ac').fill('246810')
        await q('#p1').fill('1234'); await q('#p2').fill('1234'); await q('#pfGo').click()
        check('A4 弱密碼被擋', '太好猜' in await txt('#pfErr'))
        await q('#p1').fill('2580'); await q('#p2').fill('2581'); await q('#pfGo').click()
        check('A5 兩次不一致被擋', '不一樣' in await txt('#pfErr'))
        await q('#p2').fill('2580'); await q('#pfGo').click()
        await pg.wait_for_selector('.card'); await wait(300)
        check('A6 設定密碼後進入公告', '測試員甲' in await txt('#meBar'))
        tabs = await pg.locator('#app .seg button').all_inner_texts()
        check('A7 未讀紅字只在自己單位分頁', tabs == ['墨竹亭', '小辛辣3', '央廚'], tabs)
        check('A8 未讀紅點 3 個', await count('.unread') == 3)

        await q('[data-post="P-20260920-001"]').click(); await wait()
        await q('[data-view="0"]').click(); await wait()
        vt = await txt('#viewer')
        check('A9 附件檢視開啟且標示不提供下載', '不提供下載' in vt and await count('#viewer a[download]') == 0)
        await q('#vclose').click()
        await q('#ackBtn').click(); await pg.wait_for_selector('#sgPad')
        await q('#sgOk').click(); await wait(400)
        check('A10 沒簽名不能送出', await count('#sgPad') == 1 and '請先簽名' in await txt('#sgErr'),
              '空白簽名被送出了' if await count('#sgPad') == 0 else '')
        if await count('#sgPad'):
            await sign(); await q('#sgOk').click()
        await pg.wait_for_selector('.done', timeout=5000)
        check('A11 簽名完成顯示簽名圖', await count('.done img') == 1)
        await close_sheet()
        check('A12 簽完紅點少一個', await count('.unread') == 2)

        await q('[data-tab="hist"]').click(); await wait(500)
        months = await pg.locator('[data-month]').all_inner_texts()
        check('A13 歷史區依下架月份分組', months == ['2026 年 8 月'], months)

        await q('#chgMe').click(); await pg.wait_for_selector('[data-pick]')
        await q('[data-pick="S-013"]').click()
        for i in range(2):
            await q('#pv').fill('1111'); await q('#pfGo').click(); await wait(300)
        check('A14 輸錯顯示剩餘次數', '還可以試 1 次' in await txt('#pfErr'))
        await q('#pv').fill('1111'); await q('#pfGo').click(); await wait(300)
        check('A15 連錯 3 次鎖定並顯示忘記密碼說明', '已鎖定' in await txt('.sheet') and '重設密碼' in await txt('.sheet'))
        await q('#pfBack2').click(); await wait()
        lockname = await pg.locator('[data-pick="S-013"]').inner_text()
        check('A16 名單標出鎖定', '🔒' in lockname, lockname)

        await login('S-017', grp='hq')
        tabs = await pg.locator('#app .seg button').all_inner_texts()
        check('A17 總部墨竹亭看到三個分頁、紅點只在墨竹亭', [t.rstrip('0123456789') for t in tabs] == ['墨竹亭', '小辛辣', '央廚'] and tabs[1] == '小辛辣' and tabs[2] == '央廚', tabs)
        await q('#chgMe').click(); await pg.wait_for_selector('[data-pick]')
        await login('S-016', grp='hq')
        tabs = await pg.locator('#app .seg button').all_inner_texts()
        check('A18 總部鼎兆元看到三個分頁、只簽「全部」', len(tabs) == 3 and await count('.unread') == 2, tabs)

        # ---------- 設定（主管）----------
        await q('#openAdmin').click(); await q('#pc').fill('9999'); await q('#pcGo').click(); await wait(400)
        check('B1 通行碼錯誤有提示', '錯誤' in await txt('#pcErr'))
        await q('#pc').fill('1234'); await q('#pcGo').click(); await pg.wait_for_selector('[data-af]')
        at = await pg.locator('[data-at]').all_inner_texts()
        check('B2 設定只有三個分頁（無通行碼）', at == ['公告管理', '新增公告', '同仁名單'], at)
        af = await pg.locator('[data-af]').all_inner_texts()
        check('B3 上架中／排定／已下架數量', af == ['上架中 5', '排定上架 1', '已下架 4'], af)
        await q('[data-rx="P-20260920-001"]').click(); await pg.wait_for_selector('.names img', timeout=5000)
        check('B4 回條顯示簽名者與簽名圖', '測試員甲' in await txt('.names') and await count('.names img') >= 1)
        first_names = await pg.locator('.names span').first.inner_text()
        check('B4a 未簽名的人排在最前面', first_names.startswith('✗'), first_names)
        await q('[data-cp="P-20260920-001"]').click(); await wait(400)
        clip = await pg.evaluate('navigator.clipboard.readText()')
        check('B4b 複製未簽名名單（依單位分組、不含已簽名者）',
              clip.startswith('「【新品】藤椒雞上市作業 SOP」尚未簽名（') and '林雅婷' in clip and '測試員甲' not in clip and '總部小辛辣：' in clip, clip)

        await q('[data-at="new"]').click(); await q('#fSave').click()
        check('B5 沒標題被擋', '請填標題' in await txt('#fErr'))
        await q('#fTitle').fill('【E2E】員工健檢通知'); await q('#fSave').click()
        check('B6 沒選單位被擋', '請選擇顯示單位' in await txt('#fErr'))
        await q('#uAll').click()
        await q('#fFile').set_input_files([os.path.join(SAMPLE, '測試_請假流程.pdf'), os.path.join(SAMPLE, '測試_請假流程.docx'),
                                           os.path.join(SAMPLE, '測試_假日對照表.xlsx'), os.path.join(SAMPLE, 'note.txt')])
        await wait(150)
        up = await pg.locator('#upMsg').count() and await txt('#upMsg')
        await pg.wait_for_function("!document.querySelector('#upMsg')", timeout=15000)
        fl = await pg.locator('.sheet .file .fn').all_inner_texts()
        check('B7 上傳真實 Word／PDF／Excel 並顯示進度', len(fl) == 3 and bool(up) and '上傳中' in (up or ''), f'{fl} {up}')
        check('B8 非 Office 檔被擋並說明', '只接受' in await txt('#fErr'))
        await q('#fSave').click(); await pg.wait_for_selector('[data-af]'); await wait(400)
        check('B9 上架後列在上架中', '【E2E】員工健檢通知' in await txt('.sheet'))

        await q('[data-at="new"]').click(); await q('#fTitle').fill('【E2E】下週排定')
        await q('.uOne[value="cf"]').check()
        await pg.evaluate("document.querySelector('#fPub').value = DZYB.addDays(DZYB.today(), 3); document.querySelector('#fPub').dispatchEvent(new Event('input'))")
        await q('#fSave').click(); await pg.wait_for_selector('[data-af]'); await wait(400)
        af = await pg.locator('[data-af]').all_inner_texts()
        check('B10 未來上架日進入排定上架', af[1] == '排定上架 2', af)

        await q('[data-af="on"]').click(); await wait()
        e2e_id = await pg.evaluate("[...document.querySelectorAll('[data-off]')].map(b=>b.dataset.off).find(id=>document.querySelector('[data-off=\"'+id+'\"]').closest('.arow').textContent.includes('【E2E】員工健檢'))")
        await q(f'[data-off="{e2e_id}"]').click(); await wait(500)
        await q('[data-af="off"]').click(); await wait()
        row = await pg.locator('.arow', has_text='【E2E】員工健檢').inner_text()
        check('B11 下架後封存於本月', '封存於' in row, row)
        await q(f'[data-re="{e2e_id}"]').click(); await wait(500)
        await q('[data-re="P-20260720-001"]').click(); await wait(300)
        check('B12 已過期公告重新上架會導向編輯改期', '編輯公告' in await txt('.sheet .seg .on'))
        await q('[data-at="posts"]').click(); await q('[data-af="on"]').click(); await wait()
        await q(f'[data-pin="{e2e_id}"]').click(); await wait(500)
        first = await pg.locator('.arow .t').first.inner_text()
        check('B13 置頂後排第一', first.startswith('📌') and '【E2E】員工健檢' in first, first)

        await q('[data-at="staff"]').click()
        await q('#sName').fill('總部新人'); await q('#sUnit').select_option('hq-mzt'); await q('#sAdd').click(); await wait(500)
        check('B14 新增總部同仁', '總部新人' in await txt('.sheet'))
        await q('#syncBtn').click(); await wait(900)
        s1 = await txt('.upbar')
        await q('#syncBtn').click(); await wait(900)
        s2 = await txt('.upbar')
        check('B15 打卡同步第一次新增、第二次不重複', '新增 3 人' in s1 and '新增 0 人' in s2, f'{s1} / {s2}')
        await q('[data-rp="S-002"]').click(); await wait(500)
        c2 = (await txt('#codeVal')).strip()
        check('B16a 重設密碼後顯示 6 位數啟用碼', re.fullmatch(r'\d{6}', c2) is not None, c2)
        await q('#cdBack').click(); await wait(500)
        check('B16 重設密碼後名單顯示啟用碼期限', '啟用碼' in await pg.locator('.arow', has_text='林雅婷').inner_text() and await count('[data-ic="S-002"]') == 1)
        await q('[data-ic="S-015"]').click(); await wait(500)
        check('B16b 未設密碼的人可產生啟用碼（舊碼作廢要先確認）', re.fullmatch(r'\d{6}', (await txt('#codeVal')).strip()) is not None)
        await q('#cdBack').click(); await wait(500)
        await q('[data-del="S-003"]').click(); await wait(500)
        check('B17 刪除同仁', '黃俊宇' not in await txt('.sheet'))

        await q('[data-rp="S-013"]').click(); await wait(600)   # 本機上被鎖過的測試員甲，由主管重設
        c13 = (await txt('#codeVal')).strip()
        await close_sheet()
        cards = await pg.locator('.card h3').all_inner_texts()
        check('B18 關閉設定後同仁端看到新公告（排定的看不到）', '【E2E】員工健檢通知' in cards and '【E2E】下週排定' not in cards, cards)
        await q('#chgMe').click(); await pg.wait_for_selector('[data-pu]'); await wait(600)
        await q('[data-pu="mala"]').click(); await wait(200)
        await q('[data-pick="S-013"]').click(); await wait(400)
        check('B19 被鎖過的人重設後，同一支手機點名字不卡已鎖定', '已鎖定' not in await txt('.sheet .bar'), await txt('.sheet .bar'))
        await q('#pfBack').click(); await wait(300)
        nm = await pg.locator('[data-pick="S-013"]').inner_text()
        await q('[data-pick="S-013"]').click(); await wait(300)
        await q('#pv').fill('2580'); await q('#pfGo').click(); await wait(400)
        check('B20 返回名單後不會又標回鎖定；舊密碼登入 → 自動換成第一次使用畫面', '🔒' not in nm and '第一次使用' in await txt('.sheet .bar'), f'{nm} / {await txt(".sheet .bar")}')
        await q('#ac').fill(c13); await q('#p1').fill('3691'); await q('#p2').fill('3691'); await q('#pfGo').click()
        await pg.wait_for_selector('.card, .empty', timeout=5000); await wait(300)
        check('B21 用主管給的啟用碼設定新密碼並進入', '測試員甲' in await txt('#meBar'))
        check('Z1 全程沒有頁面錯誤（pageerror）', not errs, errs)
        check('Z2 沒有任何請求打到 Google Apps Script（已攔截）', not NET_HITS, NET_HITS[:5])
        await b.close()


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--base', default='http://localhost:8792')
    ap.add_argument('--break', dest='brk', default=None)
    a = ap.parse_args()
    try:
        asyncio.run(main(a.base, a.brk))
    except Exception as e:
        check('X 執行中斷', False, repr(e)[:300])
    bad = [r for r in results if not r[1]]
    print(f'\n== {len(results) - len(bad)}/{len(results)} PASS ==' + ('  整套關：通過' if not bad else '  整套關：不通過'))
    sys.exit(1 if bad else 0)
