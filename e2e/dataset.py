# -*- coding: utf-8 -*-
"""資料帶入測試：隨機資料（分層）＋照規格獨立重寫的驗算。

⚠ 刻意不 import / 不讀 js/logic.js：驗算邏輯照 docs/spec.md、docs/task.md 共用契約（C3、C10、C15）自己寫，
  否則系統算錯、測試跟著錯（循環論證）。
"""
import random
from datetime import date, timedelta

UNITS = ['mzt', 'mala', 'cf']                       # C1：公告單位，順序固定
UNIT_NAME = {'mzt': '墨竹亭', 'mala': '小辛辣', 'cf': '央廚'}
STAFF_UNITS = UNITS + ['hq-dzy', 'hq-mzt', 'hq-mala']  # C15
STAFF_UNIT_NAME = dict(UNIT_NAME, **{'hq-dzy': '總部鼎兆元', 'hq-mzt': '總部墨竹亭', 'hq-mala': '總部小辛辣'})
STORES = {'mzt': ['光復', '金山', '六張犁']}   # C16
HQ_BRAND = {'hq-mzt': 'mzt', 'hq-mala': 'mala'}

SURNAMES = list('陳林黃張李王吳劉蔡楊許鄭謝郭洪曾邱廖賴周徐蘇葉莊呂江何蕭羅高潘簡朱鍾游彭詹胡施沈余盧梁趙顏柯翁魏孫戴')
GIVEN = list('怡君志明雅婷俊宇家豪佩琪文傑宜萱建宏淑芬冠廷詩涵嘉玲承恩品妤柏翰子晴信宏心怡思妤宗翰欣怡育誠')
TITLES = ['排班調整通知', '新品上市作業 SOP', '食安稽核重點', '颱風應變流程', '員工健檢通知', '消防演練時間表',
          '冷凍庫盤點調整', '節金發放說明', '制服更換公告', '教育訓練報名', '門市清潔標準更新', '請假流程調整']
FILE_NAMES = [('說明.pdf', 'pdf'), ('對照表.xlsx', 'xlsx'), ('SOP.docx', 'docx'), ('流程圖.pdf', 'pdf'), ('清單.xls', 'xlsx'), ('辦法.doc', 'docx')]


def weak(pin):  # C9
    return len(set(pin)) == 1 or pin in '0123456789' or pin in '9876543210'


def rand_pin(rng):
    while True:
        p = ''.join(rng.choice('0123456789') for _ in range(4))
        if not weak(p):
            return p


def iso(d):
    return d.isoformat()


def make(seed, today):
    """回傳 (data, meta)：data 注入假後端；meta 給測試流程挑人用。"""
    rng = random.Random(seed)
    used = set()

    def name():
        while True:
            n = rng.choice(SURNAMES) + ''.join(rng.choice(GIVEN) for _ in range(rng.choice([1, 2, 2, 2, 3])))
            if n not in used:
                used.add(n); return n

    # 同仁：每個單位人數各自抽（至少 1 人，讓六種單位規則都被測到）
    counts = {'mzt': rng.randint(2, 7), 'mala': rng.randint(2, 7), 'cf': rng.randint(2, 6),
              'hq-dzy': rng.randint(1, 3), 'hq-mzt': rng.randint(1, 2), 'hq-mala': rng.randint(1, 2)}
    staff, n = [], 0
    for u in STAFF_UNITS:
        for _ in range(counts[u]):
            n += 1
            staff.append({'id': 'S-%03d' % n, 'name': name(), 'unit': u, 'pin': rand_pin(rng), 'fail': 0,
                          'store': rng.choice(STORES[u] + [''] if rng.random() < 0.15 else STORES[u]) if u in STORES else ''})
    # 分層：約 1/5 沒設密碼、1 人被鎖定（連錯 3 次）
    firsts = {u: next(x['id'] for x in staff if x['unit'] == u) for u in STAFF_UNITS}   # 每個單位第一位保證有密碼（登入流程要用）
    for s in rng.sample([x for x in staff if x['id'] not in firsts.values()], max(1, len(staff) // 5)):
        s['pin'] = None
    lockable = [s for s in staff if s['pin'] and s['unit'] in UNITS and s['id'] not in firsts.values()] or [s for s in staff if s['pin'] and s['unit'] in UNITS]
    rng.choice(lockable)['fail'] = 3

    # 公告：四種狀態都要出現；單位組合含「全部」
    posts, pid = [], 0
    kinds = ['on'] * rng.randint(3, 6) + ['plan'] * rng.randint(1, 2) + ['expired'] * rng.randint(2, 4) + ['manual'] * rng.randint(1, 3) + ['soon'] * rng.randint(1, 2)
    rng.shuffle(kinds)
    for k in kinds:
        pid += 1
        units = UNITS[:] if rng.random() < 0.35 else sorted(rng.sample(UNITS, rng.randint(1, 2)), key=UNITS.index)
        pub = today - timedelta(days=rng.randint(1, 40))
        p = {'id': 'P-20260101-%03d' % pid, 'title': '%s（%d）' % (rng.choice(TITLES), pid), 'units': units,
             'pinned': rng.random() < 0.3, 'body': '第 %d 則測試公告內容。' % pid, 'published': True, 'offOn': '', 'expiresOn': '',
             'files': [{'id': 'demo-%d-%d' % (pid, i), 'name': '%d_%s' % (i, fn), 'type': t, 'size': rng.randint(10, 9000) * 1024}
                       for i, (fn, t) in enumerate(rng.sample(FILE_NAMES, rng.randint(0, 3)))]}
        if k == 'on':
            p['expiresOn'] = iso(today + timedelta(days=rng.randint(10, 60))) if rng.random() < 0.7 else ''
        elif k == 'soon':      # 階段 B 跳日期後會到期
            p['expiresOn'] = iso(today + timedelta(days=rng.randint(1, 3)))
        elif k == 'plan':
            pub = today + timedelta(days=rng.randint(1, 5)); p['expiresOn'] = iso(pub + timedelta(days=20))
        elif k == 'expired':
            p['expiresOn'] = iso(today - timedelta(days=rng.randint(1, 70)))
            pub = date.fromisoformat(p['expiresOn']) - timedelta(days=rng.randint(3, 20))
        elif k == 'manual':
            p['published'] = False; p['offOn'] = iso(today - timedelta(days=rng.randint(0, 50)))
            pub = date.fromisoformat(p['offOn']) - timedelta(days=rng.randint(1, 10))
        p['publishOn'] = iso(pub)
        posts.append(p)

    # 已讀：每則公告先抽已讀率（分層：0.05～0.95），應簽者依機率簽；只對已上架過的公告
    reads = []
    for p in posts:
        if p['publishOn'] > iso(today):
            continue
        rate = rng.choice([0.05, 0.3, 0.6, 0.95])
        for s in staff:
            if must_sign(s['unit'], p) and rng.random() < rate:
                reads.append({'postId': p['id'], 'staffId': s['id'], 'at': '%sT0%d:%02d:00.000Z' % (p['publishOn'], rng.randint(1, 9), rng.randint(0, 59))})

    # LINE 自動登入（2026-10-09）：一位單獨綁定、兩位綁同一個 LINE（測選人畫面）；另用一支亂數，不影響上面的抽樣
    rl = random.Random(seed * 7 + 3)
    lpool = [s for s in staff if s.get('fail', 0) < 3]
    solo, sh1, sh2 = rl.sample(lpool, 3)
    solo['lineUid'] = 'U-solo'; sh1['lineUid'] = 'U-shared'; sh2['lineUid'] = 'U-shared'

    # 打卡名單（同步用）：從現有同仁挑幾位對應，再加幾位新人、幾位離職
    clock = []
    for src, unit in (('gf', 'mala'), ('cf', 'cf'), ('js', 'mzt')):
        for s in [x for x in staff if x['unit'] == unit][:rng.randint(0, 2)]:
            clock.append({'src': src, 'unit': unit, 'store': '金山' if src == 'js' else '', 'empId': src.upper() + s['id'][-3:], 'name': s['name'], 'active': True, 'lineUid': s.get('lineUid', '')})
        for i in range(rng.randint(1, 3)):
            clock.append({'src': src, 'unit': unit, 'store': '金山' if src == 'js' else '', 'empId': src.upper() + 'N%d' % i, 'name': name(), 'active': True})
        clock.append({'src': src, 'unit': unit, 'store': '金山' if src == 'js' else '', 'empId': src.upper() + 'X', 'name': name(), 'active': False})

    admin_pass = 'E2E' + ''.join(rng.choice('abcdefghjk23456789') for _ in range(6))
    data = {'staff': staff, 'posts': posts, 'reads': reads, 'clock': clock, 'adminPass': admin_pass}
    data['firsts'] = firsts
    data['line'] = {'solo': solo['id'], 'shared': sorted([sh1['id'], sh2['id']])}
    return data


# ---------- 照規格獨立重寫的驗算 ----------
def mask(n):  # C3
    c = list(n.strip())
    if len(c) <= 1: return ''.join(c)
    if len(c) == 2: return c[0] + 'O'
    return c[0] + 'O' * (len(c) - 2) + c[-1]


def status(p, td):  # C10 → (state, offDate, month)
    if not p['published']:
        off = p['offOn'] or td; return 'off', off, off[:7]
    if p['expiresOn'] and p['expiresOn'] < td:
        return 'off', p['expiresOn'], p['expiresOn'][:7]
    if p['publishOn'] > td:
        return 'plan', None, None
    return 'on', None, None


def is_all(units): return all(u in units for u in UNITS)


def can_see(staff_unit, p):  # C15（2026-09-29 改：所有人都看得到全部公告）
    return True


def must_sign(staff_unit, p):  # C15
    if staff_unit == 'hq-dzy': return is_all(p['units'])
    return HQ_BRAND.get(staff_unit, staff_unit) in p['units']


def view_tabs(staff_unit):
    return UNITS[:]


def home_tab(staff_unit):
    return HQ_BRAND.get(staff_unit) or (staff_unit if staff_unit in UNITS else UNITS[0])


def board_order(posts):  # 置頂優先 → 上架日新到舊 → id 新到舊
    return sorted(posts, key=lambda p: (not p['pinned'], [-ord(c) for c in p['publishOn']], [-ord(c) for c in p['id']]))


def history_order(posts, td):
    return sorted(posts, key=lambda p: ([-ord(c) for c in status(p, td)[1]], [-ord(c) for c in p['id']]))


def fmt_ym(m):
    y, mo = m.split('-'); return '%s 年 %d 月' % (y, int(mo))


def unsigned_text(title, rows):  # 規格：只列在職且屬於公告對象、未簽者，依 STAFF_UNITS 分組
    pend = [r for r in rows if not r['read'] and r.get('active', True) and r.get('inTarget', True)]
    if not pend:
        return '「%s」全部已簽名 ✅' % title
    parts = []
    for u in STAFF_UNITS:
        ns = [r['name'] for r in pend if r['unit'] == u]
        if ns: parts.append(STAFF_UNIT_NAME[u] + '：' + '、'.join(ns))
    return '「%s」尚未簽名（%d 人）\n%s\n請盡快到電子佈告欄閱讀並簽名，謝謝！' % (title, len(pend), '\n'.join(parts))


class World:
    """測試端自己維護的「應有狀態」，每個操作後同步更新，再拿來比對畫面。"""
    def __init__(self, data):
        self.staff = {s['id']: dict(s, active=True) for s in data['staff']}
        self.posts = {p['id']: dict(p) for p in data['posts']}
        self.reads = {(r['postId'], r['staffId']) for r in data['reads']}

    def active_staff(self): return [s for s in self.staff.values() if s['active']]

    def targets(self, p): return [s for s in self.active_staff() if must_sign(s['unit'], p)]

    def read_count(self, p): return sum(1 for s in self.targets(p) if (p['id'], s['id']) in self.reads)

    def board(self, staff_unit, td):
        return [p for p in self.posts.values() if status(p, td)[0] == 'on' and can_see(staff_unit, p)]

    def history(self, staff_unit, td):
        return [p for p in self.posts.values() if status(p, td)[0] == 'off' and can_see(staff_unit, p)]

    def unread(self, sid, td):
        s = self.staff[sid]; home = home_tab(s['unit'])
        return [p for p in self.board(s['unit'], td) if home in p['units'] and must_sign(s['unit'], p) and (p['id'], sid) not in self.reads]

    def receipt_rows(self, p):
        rows = [{'name': s['name'], 'unit': s['unit'], 'read': (p['id'], s['id']) in self.reads, 'active': True, 'inTarget': True} for s in self.targets(p)]
        tids = {s['id'] for s in self.targets(p)}
        for (pid, sid) in self.reads:
            if pid == p['id'] and sid not in tids:
                s = self.staff[sid]; rows.append({'name': s['name'], 'unit': s['unit'], 'read': True, 'active': s['active'], 'inTarget': False})
        return rows
