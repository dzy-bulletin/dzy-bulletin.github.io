// node test/line.test.js — LINE 自動登入（2026-10-09）：雜湊一致、打卡同步 lineHash、lineLogin、Mac mini 每小時刷新、鏡像不帶 lineHash、伺服器限流
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), net = require('net'), vm = require('vm'), crypto = require('crypto');
const { spawn } = require('child_process');
const L = require('../js/logic.js');
const SHA = require('../js/sha256.js');
const { makeAuth_ } = require('../gas/Auth.js');
const { makeService_ } = require('../gas/Service.js');
const { makeSqliteStore } = require('../server/store-sqlite.js');
const { runMirror, refreshLineHash } = require('../server/mirror.js');
const { verifyLineToken } = require('../server/index.js');
const { makeFakeGas } = require('./fake-gas.js');

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; console.log('✗', name, '\n   got ', g, '\n   want', w); }
}
const tmps = [], procs = [];
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p || 'dzyb-line-')); tmps.push(d); return d; };
const quiet = async (fn) => { const o = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = o; } };
const nodeCrypto = { sha256Hex: (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex'),
  hmacB64url: (k, m) => crypto.createHmac('sha256', Buffer.from(k, 'utf8')).update(m, 'utf8').digest('base64url'), randomHex: (n) => crypto.randomBytes(n).toString('hex') };
const A = makeAuth_(nodeCrypto, L);

// ---------- 1. 測試向量：Node crypto ＝ 純 JS（本機假資料）＝ Apps Script（假 Utilities.computeDigest 回有號位元組）----------
const UID = 'U4af4980629a1b2c3d4e5f60718293a4b';
const VECTOR = 'a7b11111d93a0ce93ece2286d7e983768c3fbc770886a57bca2eccea720ccb12';   // sha256('dzyb-line:' + UID)：固定向量，改了前綴或演算法這裡就會紅
const want = nodeCrypto.sha256Hex('dzyb-line:' + UID);
eq('向量：Node 算出固定值', want, VECTOR);
const fg = makeFakeGas();
eq('向量：auth.lineHash＝sha256(dzyb-line:+sub)', A.lineHash(UID), want);
eq('向量：純 JS sha256 與 Node 相同', SHA.hex('dzyb-line:' + UID), want);
eq('向量：GAS lineHashOf_ 與 Node 相同', vm.runInContext('lineHashOf_(' + JSON.stringify(UID) + ')', fg.G), want);
eq('向量：GAS gasCrypto_ 經 makeAuth_ 也相同', vm.runInContext('makeAuth_(gasCrypto_(), DZYB).lineHash(' + JSON.stringify(UID) + ')', fg.G), want);
eq('向量：已知值', SHA.hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
[['中文😀'.repeat(9)], ['x'.repeat(55)], ['x'.repeat(64)], ['y'.repeat(1000)]].forEach(([s]) => eq('純 JS sha256 長度 ' + s.length, SHA.hex(s), nodeCrypto.sha256Hex(s)));

// ---------- 2. L.lineHashUpdates ----------
const H1 = A.lineHash('U1'), H2 = A.lineHash('U2');
{ const staff = [{ id: 'S-1', src: 'gf:A1', lineHash: '' }, { id: 'S-2', src: 'gf:A2', lineHash: H2 }, { id: 'S-3', src: 'cf:C1', lineHash: H1 },
    { id: 'S-4', src: '', lineHash: '' }, { id: 'S-5', src: 'gf:A5', lineHash: H1 }, { id: 'S-6', src: 'gf:A6', lineHash: H1 }];
  const got = { sources: ['gf'], errors: ['央廚：讀取失敗'], rows: [
    { src: 'gf', empId: 'A1', active: true, lineHash: H1 }, { src: 'gf', empId: 'A2', active: false, lineHash: H2 },
    { src: 'gf', empId: 'A6', active: true, lineHash: 'not-a-hash' }] };
  eq('lineHashUpdates：在職→填、離職→清、名單裡找不到→清、格式錯→清；讀取失敗的來源（cf）與沒有來源的不動',
    L.lineHashUpdates(staff, got), [{ id: 'S-1', lineHash: H1, bump: false }, { id: 'S-2', lineHash: '', bump: true }, { id: 'S-5', lineHash: '', bump: true }, { id: 'S-6', lineHash: '', bump: true }]);
  eq('lineHashUpdates：同一工號重複，在職有綁定的優先', L.lineHashUpdates([{ id: 'S-1', src: 'gf:A1', lineHash: '' }],
    { sources: ['gf'], rows: [{ src: 'gf', empId: 'A1', active: true, lineHash: H1 }, { src: 'gf', empId: 'A1', active: false, lineHash: '' }] }), [{ id: 'S-1', lineHash: H1, bump: false }]);
  eq('lineHashUpdates：來源的列完全沒有 lineHash 欄位（橋接舊版）→ 那店整店不動、不 bump',
    L.lineHashUpdates([{ id: 'S-1', src: 'gf:A1', lineHash: H1 }, { id: 'S-2', src: 'js:B1', lineHash: H2 }],
      { sources: ['gf', 'js'], rows: [{ src: 'gf', empId: 'A1', active: true }, { src: 'js', empId: 'B1', active: true, lineHash: '' }] }),
    [{ id: 'S-2', lineHash: '', bump: true }]);
  eq('lineHashUpdates：改綁別的 LINE→bump', L.lineHashUpdates([{ id: 'S-1', src: 'gf:A1', lineHash: H1 }], { sources: ['gf'], rows: [{ src: 'gf', empId: 'A1', active: true, lineHash: H2 }] }), [{ id: 'S-1', lineHash: H2, bump: true }]);
  eq('lineHashUpdates：沒變就不列', L.lineHashUpdates([{ id: 'S-1', src: 'gf:A1', lineHash: H1 }], { sources: ['gf'], rows: [{ src: 'gf', empId: 'A1', active: true, lineHash: H1 }] }), []);
}

// ---------- 3. Service：syncClock 填 lineHash、lineLogin 0／1／多人＋staffId、憑證可讀 board、輸出不含 lineHash ----------
function memStore(staff) {
  const d = { posts: [{ id: 'P-1', title: '公告', body: '', units: ['mala', 'mzt', 'cf'], publishOn: '2026-01-01', expiresOn: '', pinned: false, published: true, offOn: '', files: [] }],
    staff: staff, reads: [], log: [], admin: {}, saves: 0 };
  return { d, getPosts: () => JSON.parse(JSON.stringify(d.posts)), savePost: () => {}, getStaff: () => JSON.parse(JSON.stringify(d.staff)),
    saveStaff: (s) => { d.saves++; const i = d.staff.findIndex((x) => x.id === s.id); if (i >= 0) d.staff[i] = JSON.parse(JSON.stringify(s)); else d.staff.push(JSON.parse(JSON.stringify(s))); },
    getReads: () => [], addRead: () => {}, addLog: (e) => d.log.push(e), getAdmin: () => ({ hash: A.hashPin('s', 'adminpass'), salt: 's', ver: 1, fail: 0, lockUntil: 0, init: '' }),
    setAdmin: () => {}, secret: () => 'SECRET' };
}
const S0 = (id, name, unit, extra) => Object.assign({ id, name, unit, pinHash: '', salt: '', pinVer: 0, fail: 0, active: true, createdAt: '', deletedAt: '', src: '', store: '', lineHash: '' }, extra || {});
const clock = { nowMs: () => Date.now(), today: () => '2026-10-09' };
const verifyTEST = { verify: (t) => { const m = /^TEST:(.+)$/.exec(t); return m ? m[1] : null; } };
{ const H3 = A.lineHash('U3');
  const st = memStore([S0('S-001', '測試一', 'mala', { src: 'gf:A1' }), S0('S-002', '測試二', 'mala', { src: 'gf:A2', lineHash: H2, pinHash: A.hashPin('y', '1357'), salt: 'y', pinVer: 1 }), S0('S-003', '測試三', 'cf'),
    S0('S-004', '測試四', 'mzt', { pinHash: A.hashPin('x', '2580'), salt: 'x', pinVer: 2, fail: 3 }),
    S0('S-005', '測試五', 'mala', { src: 'gf:A5', lineHash: H3, pinVer: 4 }), S0('S-006', '測試六', 'mzt', { src: 'js:J6', lineHash: H3, pinVer: 7 })]);
  const rows = [{ src: 'gf', unit: 'mala', empId: 'A1', name: '測試一', active: true, lineHash: H1 }, { src: 'gf', unit: 'mala', empId: 'A2', name: '測試二', active: false, lineHash: H2 },
    { src: 'gf', unit: 'mala', empId: 'A9', name: '測試九', active: true, lineHash: '' }, { src: 'cf', unit: 'cf', empId: 'C3', name: '測試三', active: true, lineHash: H2 },
    { src: 'gf', unit: 'mala', empId: 'A5', name: '測試五', active: true, lineHash: A.lineHash('U5') }];
  const src = { read: () => ({ rows, errors: ['墨竹亭金山：讀取失敗'], sources: ['gf', 'cf'], counts: {} }) };   // js 讀取失敗
  const sv = makeService_(L, st, { quota: () => null }, A, clock, src, verifyTEST);
  const at = A.makeAdminToken('SECRET', 1, Date.now() + 60e3);
  const by = (id) => st.d.staff.find((s) => s.id === id);
  const tok2 = sv.call('lineLogin', { idToken: 'TEST:U2' }).data.token, tok5 = sv.call('lineLogin', { idToken: 'TEST:U3' });
  eq('同步前：S-002 用 LINE 登入的憑證有效；U3 對到 S-005 與 S-006 兩人', [sv.call('board', { token: tok2 }).ok, tok5.data.choices.map((c) => c.id)], [true, ['S-005', 'S-006']]);
  const tok6 = sv.call('lineLogin', { idToken: 'TEST:U3', staffId: 'S-006' }).data.token;
  const r = sv.call('syncClock', { atoken: at });
  eq('syncClock ok', r.ok, true);
  // #32-2：解綁或改綁 → pinVer+1（舊憑證失效、密碼不變）；'' → 值不動；讀取失敗的來源不動
  eq('syncClock pinVer：沒綁→綁上不變、解綁+1、改綁+1、讀取失敗那店不變', [by('S-001').pinVer, by('S-002').pinVer, by('S-005').pinVer, by('S-006').pinVer], [0, 2, 5, 7]);
  eq('syncClock：解綁後用舊 LINE 登入的手機被踢出', sv.call('board', { token: tok2 }).code, 'AUTH');
  eq('syncClock：讀取失敗那店的人憑證仍有效、lineHash 不變', [sv.call('board', { token: tok6 }).ok, by('S-006').lineHash], [true, H3]);
  eq('syncClock：解綁不動密碼，密碼照樣能登入', sv.call('login', { staffId: 'S-002', pin: '1357' }).ok, true);
  eq('syncClock：改綁後新的 LINE 對到、舊的對不到', [sv.call('lineLogin', { idToken: 'TEST:U5' }).data.me.id, sv.call('lineLogin', { idToken: 'TEST:U3' }).data.me.id], ['S-005', 'S-006']);
  eq('syncClock：在職且綁定→lineHash；離職→清空；新加入沒綁→空；手動建的同名同仁被對應後也填上', [by('S-001').lineHash, by('S-002').lineHash, st.d.staff.find((s) => s.name === '測試九').lineHash, by('S-003').lineHash], [H1, '', '', H2]);
  const saves = st.d.saves; sv.call('syncClock', { atoken: at });
  eq('syncClock：第二次沒有變化就不寫', st.d.saves, saves);
  // 輸出不含 lineHash
  eq('roster 不含 lineHash', JSON.stringify(sv.call('roster').data).includes('lineHash') || JSON.stringify(sv.call('roster').data).includes(H1), false);
  const ad = sv.call('adminData', { atoken: at }).data;
  eq('adminData 不含 lineHash', JSON.stringify(ad).includes('lineHash') || JSON.stringify(ad).includes(H1), false);
  // lineLogin
  eq('lineLogin：對不到→LINE_NOT_LINKED', [sv.call('lineLogin', { idToken: 'TEST:U-nobody' }).code, sv.call('lineLogin', { idToken: 'TEST:U-nobody' }).message], ['LINE_NOT_LINKED', '這個 LINE 還沒對到佈告欄名單，請選你的名字登入']);
  eq('lineLogin：驗證失敗→LINE_BAD', sv.call('lineLogin', { idToken: 'garbage' }).code, 'LINE_BAD');
  eq('lineLogin：沒帶 idToken→BAD_REQ', sv.call('lineLogin', {}).code, 'BAD_REQ');
  const one = sv.call('lineLogin', { idToken: 'TEST:U1' });
  eq('lineLogin：剛好一人→與 login 同格式', [one.ok, Object.keys(one.data).sort(), one.data.me], [true, ['board', 'me', 'token'], { id: 'S-001', name: '測試一', unit: 'mala' }]);
  eq('lineLogin：沒設密碼也能登入，憑證可以讀 board', sv.call('board', { token: one.data.token }).data.me.id, 'S-001');
  eq('lineLogin：不動 PIN／連錯次數', [by('S-001').pinHash, by('S-001').fail, by('S-001').pinVer], ['', 0, 0]);
  eq('lineLogin：不帶 lineHash 給前端', JSON.stringify(one.data).includes('lineHash') || JSON.stringify(one.data).includes(H1), false);
  // 鎖住的人：鎖保護密碼，LINE 是獨立證明 → 照樣登入，鎖不解、也不加
  by('S-004').lineHash = A.lineHash('U4');
  const locked = sv.call('lineLogin', { idToken: 'TEST:U4' });
  eq('lineLogin：密碼被鎖的人也能用 LINE 登入，鎖定狀態不變', [locked.ok, by('S-004').fail, sv.call('board', { token: locked.data.token }).ok], [true, 3, true]);
  eq('lineLogin：PIN 登入仍然鎖住', sv.call('login', { staffId: 'S-004', pin: '2580' }).code, 'LOCKED');
  // 重設密碼（pinVer+1）→ LINE 發的憑證也失效
  sv.call('staffResetPin', { atoken: at, staffId: 'S-004' });
  eq('lineLogin 憑證：重設密碼後失效', sv.call('board', { token: locked.data.token }).code, 'AUTH');
  // 多人：同一個 LINE 對到兩位
  by('S-003').lineHash = H1;
  const two = sv.call('lineLogin', { idToken: 'TEST:U1' });
  eq('lineLogin：兩人→choices（遮罩姓名）', two.data, { choices: [{ id: 'S-001', name: '測O一', unit: 'mala' }, { id: 'S-003', name: '測O三', unit: 'cf' }] });
  eq('lineLogin：choices 不含憑證', 'token' in two.data, false);
  eq('lineLogin：帶 staffId 選其中一人', sv.call('lineLogin', { idToken: 'TEST:U1', staffId: 'S-003' }).data.me.id, 'S-003');
  eq('lineLogin：staffId 不在對到的人裡→LINE_NOT_LINKED', sv.call('lineLogin', { idToken: 'TEST:U1', staffId: 'S-002' }).code, 'LINE_NOT_LINKED');
  sv.call('staffDelete', { atoken: at, staffId: 'S-003' });
  eq('lineLogin：已刪除的同仁不算', sv.call('lineLogin', { idToken: 'TEST:U1' }).data.me.id, 'S-001');
  eq('lineLogin：沒注入 lineVerify→LINE_OFF', makeService_(L, st, {}, A, clock, src).call('lineLogin', { idToken: 'TEST:U1' }).code, 'LINE_OFF');
}
// WRITE_ACTIONS：Service 與 Code.js 一致、都含 lineLogin
{ const code = fs.readFileSync(path.join(__dirname, '..', 'gas/Code.js'), 'utf8'), m = /var WRITE_ACTIONS_ = (\[[^\]]*\])/.exec(code);
  const svcW = makeService_(L, {}, {}, {}, {}).WRITE_ACTIONS;
  eq('WRITE_ACTIONS 含 lineLogin（Service／Code.js）', [svcW.includes('lineLogin'), eval(m[1]).includes('lineLogin')], [true, true]);
  eq('WRITE_ACTIONS Service＝Code.js', eval(m[1]).slice().sort(), svcW.slice().sort()); }

// ---------- 4. GAS：clockSource_ 只交出雜湊、舊表沒有欄位也能讀、鏡像不寫 lineHash、LINE 驗證回應判斷 ----------
{ const G = fg.G, book = fg.book;
  const roster = book.insertSheet('roster');
  roster.getDataRange = () => ({ getValues: () => roster.data });
  roster.data.push(['emp_id', 'name', 'active', 'removed_at', 'line_user_id'], ['A1', '測試一', true, '', UID], ['A2', '測試二', true, '', ''], ['A3', '測試三', false, '2026-09-01', 'U-left']);
  G.CLOCK_SOURCES_ = [{ src: 'gf', unit: 'mala', ssId: 'ROSTER', label: '光復' }];
  const got = vm.runInContext('clockSource_().read()', G);
  eq('GAS clockSource_：在職綁定→雜湊、沒綁→空、離職也算雜湊（同步時才清）', got.rows.map((r) => [r.empId, r.lineHash]), [['A1', want], ['A2', ''], ['A3', A.lineHash('U-left')]]);
  eq('GAS clockSource_：輸出不含原始 LINE userId', JSON.stringify(got).includes(UID) || JSON.stringify(got).includes('U-left'), false);
  roster.data[0] = ['emp_id', 'name', 'active', 'removed_at']; roster.data = roster.data.map((r) => r.slice(0, 4));
  eq('GAS clockSource_：舊表沒有 line_user_id 欄→不給 lineHash 屬性（logic 整店不動，#34 N4）', vm.runInContext('clockSource_().read()', G).rows.map((r) => 'lineHash' in r), [false, false, false]);
  eq('GAS clockSource_：舊表沒有 line_user_id 欄→lineHashUpdates 不動（不會全店解綁登出）',
     L.lineHashUpdates([{ id: 'S1', src: 'gf:A1', lineHash: want }], vm.runInContext('clockSource_().read()', G)).length, 0);
  // 2026-10-11 Eason：總部、六張犁名冊也是來源。總部同仁的主店判定在別店（例：金山），在總部綁的 LINE 經 resolveClockRows 合併到主店那位
  { const save = { data: roster.data, open: G.SpreadsheetApp.openById, srcs: G.CLOCK_SOURCES_, prim: G.CLOCK_PRIMARY_ };
    const H = ['emp_id', 'name', 'active', 'removed_at', 'line_user_id'], books = {};
    const sheetOf = (d) => ({ getSheetByName: () => ({ getDataRange: () => ({ getValues: () => d }) }) });
    G.SpreadsheetApp.openById = (id) => (books[id] ? sheetOf(books[id]) : save.open(id));
    books.JS = [H, ['J1', '測試一', true, '', ''], ['J2', '測試二', true, '', '']];
    books.HQ = [H, ['HQ-02', '測試一', true, '', 'U-hq'], ['HQ-05', '測試三', true, '', ''], ['HQ-09', '測試二', true, '', 'U-other']];
    G.CLOCK_SOURCES_ = [{ src: 'js', unit: 'mzt', store: '金山', ssId: 'JS', label: '金山' }, { src: 'hq', unit: 'hq-dzy', ssId: 'HQ', label: '總部' }];
    G.CLOCK_PRIMARY_ = { '測試一': { src: 'js', unit: 'hq-dzy', store: '' }, '測試三': { src: 'hq', unit: 'hq-mzt', store: '' } };
    const got = vm.runInContext('clockSource_().read()', G);
    const st = [{ id: 'S1', src: 'js:J1', lineHash: '' }, { id: 'S2', src: 'js:J2', lineHash: '' }];
    eq('總部當來源：已判定的人，總部綁的 LINE 合併到主店（金山）那位', JSON.parse(JSON.stringify(L.lineHashUpdates(st, got))), [{ id: 'S1', lineHash: A.lineHash('U-hq'), bump: false }]);
    eq('總部當來源：沒判定的跨店同名→hold、不動、請 Eason 判定', [!!got.rows.find((r) => r.empId === 'J2').hold, got.messages.some((m) => /測試二/.test(m))], [true, true]);
    eq('總部當來源：只在總部、已判定組別的人→主店列、套用判定的組別', (() => { const r = got.rows.find((x) => x.empId === 'HQ-05'); return [r.decided, r.unit]; })(), [true, 'hq-mzt']);
    // #35 R1／R2／R6：接上 Service.syncClock，跑兩輪
    books.HQ = [H, ['HQ-02', '測試一', true, '', 'U-hq'], ['HQ-05', '測試三', true, '', ''], ['HQ-07', '測試四', true, '', '']];
    G.CLOCK_SOURCES_ = [{ src: 'js', unit: 'mzt', store: '金山', ssId: 'JS', label: '金山' }, { src: 'hq', unit: 'hq-dzy', decide: true, ssId: 'HQ', label: '總部' }];
    books.JS = [H, ['J1', '測試一', true, '', '']];
    const st2 = memStore([S0('S-101', '測試一', 'hq-dzy', { src: 'js:J1', pinHash: A.hashPin('z', '2468'), salt: 'z' }), S0('S-103', '測試三', 'hq-mzt')]);
    const src2 = { read: () => JSON.parse(JSON.stringify(vm.runInContext('clockSource_().read()', G))) };
    const sv2 = makeService_(L, st2, { quota: () => null }, A, clock, src2, verifyTEST);
    const at2 = A.makeAdminToken('SECRET', 1, Date.now() + 60e3), by2 = (id) => st2.d.staff.find((s) => s.id === id);
    let y = sv2.call('syncClock', { atoken: at2 });
    eq('#35 第 1 輪：總部綁的 LINE 合併到金山主店那位（不 bump）', [by2('S-101').lineHash, by2('S-101').pinVer], [A.lineHash('U-hq'), 0]);
    eq('#35 只在總部、已判定組別的手動同仁→對應、不重複新增', [by2('S-103').src, st2.d.staff.filter((s) => s.name === '測試三').length], ['hq:HQ-05', 1]);
    eq('#35 R2：只在總部、沒判定的人→不新增、訊息請 Eason 判定', [st2.d.staff.some((s) => s.name === '測試四'), JSON.stringify(y.data).includes('請 Eason 判定歸總部哪一組')], [false, true]);
    const tk = sv2.call('lineLogin', { idToken: 'TEST:U-hq' }).data.token;
    eq('#35 第 1 輪後：總部綁的 LINE 直接登入那位', sv2.call('board', { token: tk }).ok, true);
    G.SpreadsheetApp.openById = (id) => { if (id === 'HQ') throw new Error('暫時打不開'); return books[id] ? sheetOf(books[id]) : save.open(id); };
    y = sv2.call('syncClock', { atoken: at2 });
    eq('#35 R1：總部讀不到那輪→綁定不動、不 bump、憑證仍有效', [by2('S-101').lineHash, by2('S-101').pinVer, sv2.call('board', { token: tk }).ok], [A.lineHash('U-hq'), 0, true]);
    G.SpreadsheetApp.openById = (id) => (books[id] ? sheetOf(books[id]) : save.open(id));
    books.HQ = books.HQ.map((r) => r.slice(0, 4));
    y = sv2.call('syncClock', { atoken: at2 });
    eq('#35 R1／R4：總部名冊少了 line_user_id 欄→不動、錯誤說出來', [by2('S-101').lineHash, by2('S-101').pinVer, JSON.stringify(y.data).includes('沒有 line_user_id 欄')], [A.lineHash('U-hq'), 0, true]);
    roster.data = save.data; G.SpreadsheetApp.openById = save.open; G.CLOCK_SOURCES_ = save.srcs; G.CLOCK_PRIMARY_ = save.prim; }
  // 舊的同仁分頁（12 欄、沒有 lineHash）照樣讀得到；寫入時自動補第 13 欄表頭
  const sh = book.getSheetByName('同仁');
  sh.data = [['id', '姓名', '單位', '密碼雜湊', 'salt', '密碼版本', '連續錯誤次數', '在職', '建立時間', '刪除時間', '來源（打卡系統）', '門市'],
    ['S-001', '測試一', 'mala', '', '', '0', '0', 'TRUE', '', '', 'gf:A1', '']];
  sh.maxCols = 12;                                          // #32-7：分頁只有 12 欄（讀第 13 欄會越界）
  fg.bumpGen();
  const s1 = fg.store().getStaff()[0];
  eq('GAS 舊同仁表（沒有 lineHash 欄）讀出 lineHash=""', [s1.id, s1.lineHash], ['S-001', '']);
  s1.lineHash = want; const st2 = fg.store(); st2.saveStaff(s1);
  eq('GAS 寫入後加欄、補上表頭、值在第 13 欄', [sh.maxCols, sh.data[0][12], sh.data[1][12]], [13, 'LINE 綁定（雜湊）', want]);
  fg.bumpGen();
  eq('GAS 讀回 lineHash', fg.store().getStaff()[0].lineHash, want);
  const mr = vm.runInContext('mirrorRows_', G)({ posts: [], staff: [{ id: 'S-001', name: '測試一', active: true, lineHash: want }], reads: [], log: [] }, (p) => p, {});
  eq('GAS mirrorRows_：鏡像不寫 lineHash', mr.staff[0].lineHash, '');
  const sub = vm.runInContext('lineClaimsSub_', G), now = Date.now();
  eq('lineClaimsSub_：aud 對、未過期→sub', sub({ aud: '2011292256', exp: now / 1000 + 60, sub: 'Uabc' }, '2011292256', now), 'Uabc');
  eq('lineClaimsSub_：aud 不對→null', sub({ aud: '999', exp: now / 1000 + 60, sub: 'Uabc' }, '2011292256', now), null);
  eq('lineClaimsSub_：過期→null', sub({ aud: '2011292256', exp: now / 1000 - 1, sub: 'Uabc' }, '2011292256', now), null);
  let sent = null;
  G.UrlFetchApp = { fetch: (u, o) => { sent = [u, o.method, o.payload.client_id, o.payload.id_token]; return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ aud: '2011292256', exp: Date.now() / 1000 + 600, sub: 'Ugas' }) }; } };
  eq('GAS lineVerify_：POST verify，client_id 預設 2011292256', [vm.runInContext('lineVerify_()', G).verify('tok'), sent], ['Ugas', ['https://api.line.me/oauth2/v2.1/verify', 'post', '2011292256', 'tok']]);
  G.UrlFetchApp = { fetch: () => ({ getResponseCode: () => 400, getContentText: () => '{"error":"invalid_request"}' }) };
  eq('GAS lineVerify_：LINE 回 400→null', vm.runInContext('lineVerify_()', G).verify('tok'), null);
}

// ---------- 5. Mac mini 每小時工作：只動 lineHash；橋接失敗跳過；鏡像送出的同仁沒有 lineHash ----------
function bridgeWith(clockData, failClock) {
  const b = { calls: [], mirrored: null };
  b.call = async (op, p) => {
    b.calls.push(op);
    if (op === 'clock') { if (failClock) { const e = new Error('Google 雲端暫時連不上'); e.code = 'BRIDGE'; throw e; } return JSON.parse(JSON.stringify(clockData)); }
    if (op === 'mirror') { b.mirrored = JSON.parse(JSON.stringify(p.data)); return { counts: {} }; }
    if (op === 'sigs') return { ids: p.put.map(() => 'D') };
    if (op === 'filelist') return { files: [], nextPageToken: '' };
    throw new Error('未知 op ' + op);
  };
  return b;
}
(async () => {
  const dir = tmp();
  const st = makeSqliteStore(dir);
  const base = [S0('S-001', '測試一', 'mala', { src: 'gf:A1', pinHash: 'PH', salt: 'SA', pinVer: 3, fail: 1 }), S0('S-002', '測試二', 'mala', { src: 'gf:A2', lineHash: H2 }), S0('S-003', '測試三', 'cf', { src: 'cf:C1', lineHash: H1 })];
  delete base[0].lineHash;                                  // 模擬改版前存的同仁 JSON（沒有 lineHash 欄位）
  st.load({ posts: [{ id: 'P-1', title: '公告', units: ['mala'] }], staff: base, reads: [], log: [] });
  // 舊資料（沒有 lineHash 欄位）讀出來補 ''
  eq('SQLite：舊資料沒有 lineHash→讀出 ""', st.getStaff()[0].lineHash, '');
  st.close();
  const before = JSON.parse(JSON.stringify(base));
  const clockData = { sources: ['gf'], errors: ['央廚：讀取失敗'], counts: {}, rows: [
    { src: 'gf', unit: 'mala', empId: 'A1', name: '測試一', active: true, lineHash: H1 }, { src: 'gf', unit: 'mala', empId: 'A2', name: '測試二', active: false, lineHash: H2 },
    { src: 'gf', unit: 'mala', empId: 'A7', name: '打卡新人', active: true, lineHash: H2 }] };
  const B = bridgeWith(clockData);
  const r = await quiet(() => runMirror({ dir, bridge: B }));
  const st2 = makeSqliteStore(dir), after = st2.getStaff(); st2.close();
  eq('每小時：鏡像 ok，有讀打卡名單', [r.ok, B.calls.includes('clock'), r.line && r.line.ok, r.line && r.line.updated], [true, true, true, 2]);
  eq('每小時：S-001 填上、S-002 離職清空、S-003（央廚讀取失敗）不動', after.map((s) => s.lineHash), [H1, '', H1]);
  eq('每小時：不新增同仁（打卡新人不會被加進來）', after.length, 3);
  const strip = (s) => { const o = Object.assign({}, s); delete o.lineHash; delete o.pinVer; return o; };
  eq('每小時：除了 lineHash／pinVer 其他欄位一個都沒變', after.map(strip), before.map(strip));
  eq('每小時 pinVer：沒綁→綁上不變（3）、解綁 +1（0→1）、讀取失敗那店不變（0）', after.map((s) => s.pinVer), [3, 1, 0]);
  eq('鏡像：送出的同仁沒有 lineHash', B.mirrored.staff.some((s) => 'lineHash' in s), false);
  const B2 = bridgeWith(clockData, true);
  const r2 = await quiet(() => runMirror({ dir, bridge: B2 }));
  eq('每小時：讀打卡名單失敗→跳過，鏡像照樣 ok', [r2.ok, r2.line.ok, /讀打卡名單失敗/.test(r2.line.error)], [true, false, true]);
  const r3 = await quiet(() => runMirror({ dir, bridge: bridgeWith(clockData), all: true }));
  eq('--all 不做 LINE 刷新', r3.line, undefined);
  eq('refreshLineHash 單獨呼叫：沒變化 updated 0', (await refreshLineHash({ dir, bridge: bridgeWith(clockData) })).updated, 0);
  eq('refreshLineHash：格式不符就跳過', (await refreshLineHash({ dir, bridge: bridgeWith({ rows: 'x' }) })).ok, false);

  // ---------- 6. verifyLineToken（打本機假 LINE）----------
  let lastBody = '', mode = 'ok';
  const fake = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
      lastBody = b;
      if (mode === 'slow') return;                          // 不回應→逾時
      if (mode === 'bad') { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end('{"error":"invalid_request"}'); }
      if (mode === '500') { res.writeHead(500); return res.end('x'); }
      const p = new URLSearchParams(b);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ aud: mode === 'aud' ? '1' : p.get('client_id'), exp: Math.floor(Date.now() / 1000) + (mode === 'exp' ? -5 : 600), sub: 'Utest' }));
    });
  });
  await new Promise((ok) => fake.listen(0, '127.0.0.1', ok));
  const url = 'http://127.0.0.1:' + fake.address().port + '/verify';
  eq('verifyLineToken：成功→sub，送 id_token 與 client_id', [await verifyLineToken(url, '2011292256', 'tok-1'), Object.fromEntries(new URLSearchParams(lastBody))], ['Utest', { id_token: 'tok-1', client_id: '2011292256' }]);
  mode = 'bad'; eq('verifyLineToken：LINE 回 400→null', await verifyLineToken(url, '2011292256', 'tok'), null);
  mode = 'aud'; eq('verifyLineToken：aud 不是本頻道→null', await verifyLineToken(url, '2011292256', 'tok'), null);
  mode = 'exp'; eq('verifyLineToken：過期→null', await verifyLineToken(url, '2011292256', 'tok'), null);
  const ce = console.error; console.error = () => {};
  mode = '500'; let e5 = null; try { await verifyLineToken(url, '2011292256', 'tok'); } catch (e) { e5 = e; }
  eq('verifyLineToken：LINE 500→業務錯誤 LINE_DOWN', [e5 && e5.code, e5 && e5.business], ['LINE_DOWN', true]);
  console.error = ce;
  fake.close();

  // ---------- 7. 伺服器（E2E 假橋接）：lineLogin 端到端、限流 BUSY ----------
  async function startSrv(extra) {
    const port = await new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
    const env = Object.assign({}, process.env, { DZYB_NO_DOTENV: '1', E2E: '1', PORT: String(port), DATA_DIR: tmp('dzyb-line-srv-'), HOME: tmp('dzyb-line-home-') }, extra);
    ['BRIDGE_URL', 'BRIDGE_KEY', 'ALLOW_ORIGIN'].forEach((k) => delete env[k]);
    const p = spawn(process.execPath, [path.join(__dirname, '..', 'server/index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    procs.push(p);
    let o = ''; p.stdout.on('data', (c) => { o += c; }); p.stderr.on('data', () => {});
    await new Promise((ok, no) => { const t = setInterval(() => { if (/啟動/.test(o)) { clearInterval(t); ok(); } }, 20); p.on('exit', (c) => { clearInterval(t); no(new Error('伺服器沒起來 ' + c)); }); });
    // xff：整個 X-Forwarded-For 標頭（不給＝不帶這個標頭）
    const post = (pth, body, xff) => new Promise((ok) => {
      const buf = Buffer.from(JSON.stringify(body));
      const rq = http.request({ host: '127.0.0.1', port, method: 'POST', path: pth, agent: false,
        headers: Object.assign({ 'Content-Type': 'text/plain', 'Content-Length': buf.length }, xff ? { 'X-Forwarded-For': xff } : {}) }, (res) => {
        const cs = []; res.on('data', (c) => cs.push(c)); res.on('end', () => ok(JSON.parse(Buffer.concat(cs).toString())));
      });
      rq.end(buf);
    });
    await post('/__seed', { staff: [{ id: 'S-001', name: '測試一', unit: 'mala', pin: null, lineUid: 'U-s1' }, { id: 'S-002', name: '測試二', unit: 'cf', pin: '2580', lineUid: 'U-s2' }],
      posts: [{ id: 'P-1', title: '公告', units: ['mala', 'mzt', 'cf'], publishOn: '2026-01-01' }], reads: [], adminPass: 'adminpass88', clock: [] });
    return { post, out: () => o };
  }
  const SV = await startSrv({ LINE_LOGIN_PER_MIN: '3', LINE_LOGIN_GLOBAL_PER_MIN: '5' }), post = SV.post;
  // X-Forwarded-For 取最後一段（代理加上的）：前面客戶端自己塞的那段不算（#32-8）
  const IA = '9.9.9.9, 203.0.113.1', IB = '9.9.9.9, 203.0.113.2', IA2 = '8.8.8.8, 7.7.7.7, 203.0.113.1';
  for (let k = 0; k < 6; k++) await post('/', { action: 'lineLogin', idToken: '' }, IA);
  const s1 = await post('/', { action: 'lineLogin', idToken: 'TEST:U-s1' }, IA);
  eq('伺服器 lineLogin：空白 idToken 不算進限流（6 次 BAD_REQ 後仍能登入）；沒設密碼的同仁用 LINE 登入', [s1.ok, s1.data && s1.data.me.id], [true, 'S-001']);
  eq('伺服器 lineLogin：憑證可讀 board', (await post('/', { action: 'board', token: s1.data.token })).data.me.id, 'S-001');
  eq('伺服器 lineLogin：對不到→LINE_NOT_LINKED', (await post('/', { action: 'lineLogin', idToken: 'TEST:U-x' }, IA)).code, 'LINE_NOT_LINKED');
  eq('伺服器 lineLogin：非 TEST 憑證（E2E 不連 LINE）→LINE_BAD', (await post('/', { action: 'lineLogin', idToken: 'eyJ.x.y' }, IA)).code, 'LINE_BAD');
  eq('伺服器 限流：最後一段相同（前面塞的不同）算同一 IP，第 4 次→BUSY', (await post('/', { action: 'lineLogin', idToken: 'TEST:U-s2' }, IA2)).code, 'BUSY');
  eq('伺服器 限流：第一段相同、最後一段不同＝不同 IP，不受影響；有密碼的同仁也可以', (await post('/', { action: 'lineLogin', idToken: 'TEST:U-s2' }, IB)).data.me.id, 'S-002');
  eq('伺服器 限流：全體第 5 次仍可', (await post('/', { action: 'lineLogin', idToken: 'TEST:U-s2' }, IB)).ok, true);
  eq('伺服器 限流：全體超過 5 次→BUSY（換 IP、不帶標頭也一樣）', [(await post('/', { action: 'lineLogin', idToken: 'TEST:U-s2' }, IB)).code, (await post('/', { action: 'lineLogin', idToken: 'TEST:U-s2' }, '203.0.113.9')).code, (await post('/', { action: 'lineLogin', idToken: 'TEST:U-s2' })).code], ['BUSY', 'BUSY', 'BUSY']);
  // 沒有 X-Forwarded-For：只套全體上限（不用 socket 分桶，否則經 Funnel 全部人共用每 IP 的 10 次）
  const SV2 = await startSrv({ LINE_LOGIN_PER_MIN: '10', LINE_LOGIN_GLOBAL_PER_MIN: '15' });
  const codes = [];
  for (let k = 0; k < 16; k++) codes.push((await SV2.post('/', { action: 'lineLogin', idToken: 'TEST:U-s' + (1 + k % 2) })).ok ? 'ok' : 'BUSY');
  eq('伺服器 限流：沒帶 X-Forwarded-For 時 11 次以上照常（只到全體 15 才 BUSY）', [codes.slice(0, 15).every((c) => c === 'ok'), codes[15]], [true, 'BUSY']);
  const out = SV.out() + SV2.out();
  eq('伺服器 roster 不含 lineHash', JSON.stringify((await post('/', { action: 'roster' })).data).includes('lineHash'), false);
  eq('伺服器 紀錄不含 idToken／sub', /TEST:U-s1|U-s1/.test(out), false);
})().catch((e) => { fail++; console.log('✗ 例外', e && e.stack || e); }).finally(() => {
  procs.forEach((x) => { try { x.kill(); } catch (e) {} });
  tmps.forEach((d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} });
  console.log(`line: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
