// node test/passcode-off.test.js — 管理通行碼停用（2026-11-18）：adminLogin 一律拒絕、既有 A 種憑證失效、
// 管理系統換來的 D 憑證照常（上架／編輯／下架／置頂／回條）、同仁名單類維護動作（只有 A 能做）一併收起、開關可恢復。
// 兩層：①服務層（記憶體 store）②真伺服器（子程序、暫存資料夾、正式模式＝非 E2E）。不連任何外部網址。
'use strict';
const crypto = require('crypto');
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
global.DZYB = require('../js/logic.js');
const { makeAuth_ } = require('../gas/Auth.js');
const { makeService_ } = require('../gas/Service.js');
const { makeSqliteStore } = require('../server/store-sqlite.js');
const L = global.DZYB, ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; console.log('✗', name, '\n   got ', g, '\n   want', w); }
}
const nc = { sha256Hex: (x) => crypto.createHash('sha256').update(x, 'utf8').digest('hex'),
  hmacB64url: (k, m) => crypto.createHmac('sha256', Buffer.from(k, 'utf8')).update(m, 'utf8').digest('base64url'), randomHex: (n) => crypto.randomBytes(n).toString('hex') };
const A = makeAuth_(nc, L);
const OFF_MSG = '通行碼登入已停用，請從管理系統進入';

// ---------- ① 服務層 ----------
function fixture(init) {
  const salt = A.newSalt();
  const st = { posts: [], staff: [{ id: 'S-1', name: '甲', unit: 'mala', pinHash: '', salt: '', pinVer: 0, fail: 0, active: true, store: '', lineHash: '' }],
    reads: [], logs: [], admin: { hash: A.hashPin(salt, 'passcode-77'), salt, init: init || '', ver: 1, fail: 0, lockUntil: 0 } };
  const store = { getPosts: () => st.posts, savePost: (p) => { const i = st.posts.findIndex((x) => x.id === p.id); if (i < 0) st.posts.push(p); else st.posts[i] = p; },
    getStaff: () => st.staff, saveStaff: (s) => { const i = st.staff.findIndex((x) => x.id === s.id); if (i < 0) st.staff.push(s); else st.staff[i] = s; },
    getReads: () => st.reads, addRead: (r) => st.reads.push(r), addLog: (e) => st.logs.push(e),
    getAdmin: () => Object.assign({}, st.admin), setAdmin: (a) => { st.admin = Object.assign({}, a); }, secret: () => 'sec' };
  return { st, store };
}
const clock = { nowMs: () => Date.now(), today: () => L.today() };
const redeem = { redeem: (t, aud) => (aud === 'bulletin-admin' && /^[0-9a-f]{64}$/.test(t) ? { admin: true, emp_no: 'DZY001', uid: 'u1', name: '測試' } : null) };
const TICKET = 'a'.repeat(64);
const post = (title) => ({ title, body: '內容', units: ['mala'], publishOn: L.today(), expiresOn: '', pinned: false, published: true, files: [] });

{
  const { st, store } = fixture();
  const off = makeService_(L, store, {}, A, clock, null, null, { adminPasscode: false, dzyRedeem: redeem });
  const before = JSON.stringify(st.admin);
  // 通行碼登入：對的、錯的都拒絕；不比對、不累計連錯、不改資料庫的雜湊
  eq('停用：正確通行碼 → PASSCODE_OFF（明確訊息）', (({ ok, code, message }) => ({ ok, code, message }))(off.call('adminLogin', { pass: 'passcode-77' })), { ok: false, code: 'PASSCODE_OFF', message: OFF_MSG });
  for (let i = 0; i < 8; i++) off.call('adminLogin', { pass: 'wrong' + i });
  eq('停用：猜 8 次不累計連錯、不鎖定、雜湊原樣保留', JSON.stringify(st.admin), before);
  // 舊的 A 種憑證（停用前簽的、仍在 7 天效期內）一律不接受，每個需要管理身分的動作都擋
  const aTok = A.makeAdminToken('sec', 1, Date.now() + 7 * 86400e3);
  const acts = ['adminData', 'receipts', 'uploadFile', 'savePost', 'setPublished', 'setPinned', 'staffAdd', 'staffSetStore', 'syncClock', 'staffDelete', 'staffResetPin', 'staffIssueCode'];
  eq('停用：舊 A 憑證打每個管理動作都 AUTH', acts.map((a) => { const r = off.call(a, { atoken: aTok, postId: 'x', staffId: 'S-1' }); return [a, r.code]; }), acts.map((a) => [a, 'AUTH']));
  eq('停用：舊 A 憑證的訊息指向管理系統', off.call('adminData', { atoken: aTok }).message, OFF_MSG);
  eq('停用：沒憑證／亂寫憑證 → AUTH', [off.call('adminData', {}).code, off.call('adminData', { atoken: 'A.1.9999999999999.xxx' }).code], ['AUTH', 'AUTH']);
  eq('停用：不是 A 種也不是 D 種的字首照樣擋', off.call('adminData', { atoken: aTok.replace(/^A/, 'S') }).code, 'AUTH');
  eq('停用：A 憑證沒有被 savePost 寫進任何公告', st.posts.length, 0);

  // D 憑證（管理系統換來的）：上架、編輯、置頂、下架、回條、已讀名單照常
  const lg = off.call('dzyAdminLogin', { ticket: TICKET });
  eq('D：管理系統入場券換憑證成功', [lg.ok, lg.ok && lg.data.atoken[0]], [true, 'D']);
  const dTok = lg.data.atoken;
  eq('D：adminData', off.call('adminData', { atoken: dTok }).ok, true);
  const sp = off.call('savePost', { atoken: dTok, post: post('D 上架') });
  eq('D：上架 savePost', sp.ok, true);
  const pid = sp.ok ? sp.data.post.id : '';
  eq('D：編輯 savePost', off.call('savePost', { atoken: dTok, post: Object.assign(post('D 改標題'), { id: pid }) }).ok, true);
  eq('D：置頂', off.call('setPinned', { atoken: dTok, postId: pid, on: true }).data.post.pinned, true);
  eq('D：回條 receipts', off.call('receipts', { atoken: dTok, postId: pid }).ok, true);
  eq('D：下架', off.call('setPublished', { atoken: dTok, postId: pid, on: false }).ok, true);
  eq('D：adminData 不含密碼狀態欄位（只有 id／name／unit／store）', Object.keys(off.call('adminData', { atoken: dTok }).data.staff[0]).sort(), ['id', 'name', 'store', 'unit']);
  // 只有 A 才能做的維護動作：D 不行（FORBIDDEN）；停用後沒有人有 A，所以全部沒入口（同仁名單已由管理系統同步）
  eq('D：同仁名單類／打卡同步維護 → FORBIDDEN', ['staffAdd', 'staffSetStore', 'syncClock', 'staffDelete', 'staffResetPin', 'staffIssueCode'].map((a) => off.call(a, { atoken: dTok, staffId: 'S-1', name: 'x', unit: 'mala' }).code), Array(6).fill('FORBIDDEN'));
  eq('D：操作紀錄有留下是誰登入', st.logs.filter((e) => e.action === '管理系統登入').length, 1);

  // 同仁端不受影響
  eq('同仁端：roster／login 路徑不受影響', off.call('roster').ok, true);
}

// ADMIN_INIT 待生效：停用時不能反過來卡住 D 憑證；開著通行碼時照舊（更換後舊憑證全失效、要先用新碼登入一次）
{
  const { store } = fixture('new-passcode-88');
  const off = makeService_(L, store, {}, A, clock, null, null, { adminPasscode: false, dzyRedeem: redeem });
  const lg = off.call('dzyAdminLogin', { ticket: TICKET });
  eq('停用＋有待生效的 ADMIN_INIT：D 照常登入、照常用', [lg.ok, lg.ok && off.call('adminData', { atoken: lg.data.atoken }).ok], [true, true]);
  eq('停用＋有待生效的 ADMIN_INIT：adminLogin 不消化它（仍是 PASSCODE_OFF，檔案不被刪）', [off.call('adminLogin', { pass: 'new-passcode-88' }).code, store.getAdmin().init], ['PASSCODE_OFF', 'new-passcode-88']);
  const on = makeService_(L, store, {}, A, clock, null, null, { adminPasscode: true, dzyRedeem: redeem });
  eq('開著通行碼＋待生效 ADMIN_INIT：dzyAdminLogin 回 ADMIN_INIT（舊行為不變）', on.call('dzyAdminLogin', { ticket: TICKET }).code, 'ADMIN_INIT');
}

// 開關可恢復：同一份資料、不動雜湊，把開關打開就回到舊行為（緊急退回用）
{
  const { st, store } = fixture();
  const on1 = makeService_(L, store, {}, A, clock, null, null, { adminPasscode: true });
  const r1 = on1.call('adminLogin', { pass: 'passcode-77' });
  eq('恢復：明確傳 adminPasscode:true → 原通行碼可登入，A 憑證可管理', [r1.ok, on1.call('adminData', { atoken: r1.data.atoken }).ok, r1.data.atoken[0]], [true, true, 'A']);
  eq('通行碼登入成功寫操作紀錄（退回開關被用過會留痕跡），不含通行碼', [st.logs.filter((e) => e.action === '通行碼登入').length, JSON.stringify(st.logs).includes('passcode-77')], [1, false]);
  eq('通行碼登入失敗不寫那筆紀錄', (() => { const n = st.logs.length; on1.call('adminLogin', { pass: 'nope' }); return st.logs.length; })(), st.logs.length);
  const off = makeService_(L, store, {}, A, clock, null, null, { adminPasscode: false });
  eq('再關掉：剛登入拿到的 A 憑證立刻失效', off.call('adminData', { atoken: r1.data.atoken }).code, 'AUTH');
}

// 預設停用：服務層沒帶選項、或帶了不是「布林 true」的值，一律停用（任何入口忘了傳都在安全的一邊）
{
  const { st, store } = fixture();
  const kinds = [undefined, {}, { adminPasscode: undefined }, { adminPasscode: false }, { adminPasscode: 'true' }, { adminPasscode: 1 }, { adminPasscode: '1' }, { adminPasscode: null }];
  const codes = kinds.map((o) => (o === undefined ? makeService_(L, store, {}, A, clock) : makeService_(L, store, {}, A, clock, null, null, o)).call('adminLogin', { pass: 'passcode-77' }).code);
  eq('服務層預設（沒帶／{}／undefined／false／\'true\'／1／\'1\'／null）全部停用', codes, Array(kinds.length).fill('PASSCODE_OFF'));
  eq('預設停用的服務層，停用前簽的 A 憑證也不能用', makeService_(L, store, {}, A, clock).call('adminData', { atoken: A.makeAdminToken('sec', 1, Date.now() + 86400e3) }).code, 'AUTH');
}

// gas/Code.js（Google 回退版入口）：呼叫 makeService_ 一定帶 serviceOpts_()，且不帶指令碼屬性時是停用
{
  const vm = require('vm'), src = fs.readFileSync(path.join(ROOT, 'gas/Code.js'), 'utf8');
  eq('gas/Code.js 的 makeService_ 呼叫帶 serviceOpts_()', /makeService_\([\s\S]{0,400}?serviceOpts_\(\)\)/.test(src), true);
  const mk = (props) => { const ctx = { PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null) }) }, console, Logger: { log() {} } };
    vm.createContext(ctx); vm.runInContext(src, ctx); return ctx.serviceOpts_(); };
  eq('gas/Code.js：沒設指令碼屬性 → adminPasscode:false（入口不帶參數＝停用）', mk({}).adminPasscode, false);
  eq('gas/Code.js：ADMIN_PASSCODE_LOGIN=1 才開；其他值不開', [mk({ ADMIN_PASSCODE_LOGIN: '1' }).adminPasscode, mk({ ADMIN_PASSCODE_LOGIN: 'true' }).adminPasscode, mk({ ADMIN_PASSCODE_LOGIN: '0' }).adminPasscode], [true, false, false]);
  const { st, store } = fixture();
  const viaCode = makeService_(L, store, {}, A, clock, null, null, mk({}));
  eq('用 Code.js 組出的選項建服務：通行碼登入被拒（等於回退到 Google 也停用）', viaCode.call('adminLogin', { pass: 'passcode-77' }).code, 'PASSCODE_OFF');
}

// /health 燈號規則（純函式）
{
  const { judgeHealth } = require('../server/health-rules.js');
  const base = { mirror: { at: new Date().toISOString(), ok: true, sigPending: 0, fails: 0, missing: 0, bad: 0 }, backup: { at: new Date().toISOString(), ok: true, sharedWith: 0 }, disk: { freeMB: 99999 }, e2e: false };
  const j0 = judgeHealth(Object.assign({}, base, { adminPasscode: { on: false, via: null } })), j1 = judgeHealth(Object.assign({}, base, { adminPasscode: { on: true, via: 'file' } }));
  const j2 = judgeHealth(Object.assign({}, base, { adminPasscode: { on: true, via: 'env' }, e2e: true }));
  eq('health 規則：停用＝綠；開啟（非 E2E）＝黃並附原因；E2E 開啟不算', [j0.level, j1.level, j1.why, j2.level], ['green', 'yellow', ['管理通行碼登入已開啟（應為停用）'], 'green']);
  eq('health 規則：欄位缺（舊格式）不影響', judgeHealth(base).level, 'green');
}

// ---------- ② 真伺服器（正式模式、沒有橋接） ----------
const procs = [], tmps = [];
const freePort = () => new Promise((ok, no) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); s.on('error', no); });
function seedDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dzyb-pcoff-')); tmps.push(dir);
  const st = makeSqliteStore(dir), salt = A.newSalt();
  st.setAdmin({ hash: A.hashPin(salt, 'passcode-77'), salt, init: '', ver: 1, fail: 0, lockUntil: 0 });
  const secret = st.secret(); st.close();
  seedDir.secret = secret;
  return dir;
}
async function startServer(dir, env) {
  const port = await freePort();
  const e = Object.assign({ PATH: process.env.PATH, DZYB_NO_DOTENV: '1', HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'dzyb-home-')), PORT: String(port), DATA_DIR: dir, ALLOW_ORIGIN: '' }, env || {});
  tmps.push(e.HOME);
  const p = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], { env: e, stdio: ['ignore', 'pipe', 'ignore'] });
  procs.push(p);
  let out = '';
  p.stdout.on('data', (c) => { out += c; });
  await new Promise((ok, no) => { const t = setInterval(() => { if (/啟動/.test(out)) { clearInterval(t); ok(); } }, 20); p.on('exit', (c) => { clearInterval(t); no(new Error('伺服器沒起來 ' + c)); }); });
  return { port, out: () => out, stop: () => new Promise((ok) => { if (p.exitCode !== null) return ok(); p.on('exit', () => ok()); p.kill(); }) };
}
function api(port, action, body) {
  return new Promise((ok) => {
    const buf = Buffer.from(JSON.stringify(Object.assign({}, body || {}, { action })));
    const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/', headers: { 'Content-Type': 'text/plain', 'Content-Length': buf.length }, agent: false }, (res) => {
      const cs = []; res.on('data', (c) => cs.push(c));
      res.on('end', () => { let json = null; try { json = JSON.parse(Buffer.concat(cs).toString()); } catch (e) {} ok(json); });
    });
    r.on('error', () => ok(null)); r.end(buf);
  });
}

(async () => {
  try {
    // 正式模式、沒設任何開關 ＝ 預設停用（這才是上線後的狀態）
    const dir = seedDir();
    let S = await startServer(dir);
    const pre = A.makeAdminToken(seedDir.secret, 1, Date.now() + 7 * 86400e3);   // 停用前簽的 A 憑證（同一把 secret、版本 1、7 天效期）
    const hget = (port) => new Promise((ok) => http.get({ host: '127.0.0.1', port, path: '/health', agent: false }, (res) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => ok(JSON.parse(t))); }));
    const h0 = await hget(S.port);
    eq('/health 新欄位 adminPasscode（停用）：on=false、via=null、燈號原因不含通行碼；ok 仍為 true（監看只認 ok）', [h0.adminPasscode, h0.ok, h0.why.includes('管理通行碼登入已開啟（應為停用）')], [{ on: false, via: null }, true, false]);
    eq('啟動紀錄有一行通行碼狀態（停用）', /管理通行碼登入：停用/.test(S.out()), true);
    const r0 = await api(S.port, 'adminLogin', { pass: 'passcode-77' });
    eq('伺服器預設（正式模式、沒設開關）：通行碼登入被拒', [r0.ok, r0.code, r0.message], [false, 'PASSCODE_OFF', OFF_MSG]);
    eq('伺服器預設：停用前簽的 A 憑證被拒', (await api(S.port, 'adminData', { atoken: pre })).code, 'AUTH');
    // 檔案開關：建 ADMIN_PASSCODE_ON → 下一個請求就恢復（不用重啟）；刪掉 → 立刻再停用，剛拿的 A 憑證也失效
    // 旗標是目錄（或指向不存在的連結）不算開：只有一般檔案才算
    fs.mkdirSync(path.join(dir, 'ADMIN_PASSCODE_ON'));
    eq('旗標是目錄 → 不算開', [(await api(S.port, 'adminLogin', { pass: 'passcode-77' })).code, (await hget(S.port)).adminPasscode.on], ['PASSCODE_OFF', false]);
    fs.rmdirSync(path.join(dir, 'ADMIN_PASSCODE_ON'));
    fs.symlinkSync(path.join(dir, 'nowhere'), path.join(dir, 'ADMIN_PASSCODE_ON'));
    eq('旗標是壞掉的連結 → 不算開', (await api(S.port, 'adminLogin', { pass: 'passcode-77' })).code, 'PASSCODE_OFF');
    fs.unlinkSync(path.join(dir, 'ADMIN_PASSCODE_ON'));
    fs.writeFileSync(path.join(dir, 'ADMIN_PASSCODE_ON'), '');
    const hOn = await hget(S.port);
    eq('/health：旗標檔開啟 → on=true、via=file、附原因、ok 仍 true（這個空資料夾沒有鏡像紀錄所以整體是紅，與通行碼無關；黃燈規則由上面的純函式測試驗）', [hOn.adminPasscode, hOn.level, hOn.why.includes('管理通行碼登入已開啟（應為停用）'), hOn.ok], [{ on: true, via: 'file' }, 'red', true, true]);
    const r1 = await api(S.port, 'adminLogin', { pass: 'passcode-77' });
    eq('檔案開關 ADMIN_PASSCODE_ON：不重啟就恢復通行碼登入', [r1.ok, r1.ok && (await api(S.port, 'adminData', { atoken: r1.data.atoken })).ok], [true, true]);
    eq('伺服器：通行碼登入成功寫了一筆操作紀錄', (() => { const db = new (require('node:sqlite').DatabaseSync)(path.join(dir, 'bulletin.db'), { readOnly: true }); const n = db.prepare("SELECT COUNT(*) c FROM log WHERE action='通行碼登入'").get().c; db.close(); return n; })(), 1);
    fs.unlinkSync(path.join(dir, 'ADMIN_PASSCODE_ON'));
    eq('刪掉檔案開關：立刻再停用，A 憑證失效', [(await api(S.port, 'adminLogin', { pass: 'passcode-77' })).code, (await api(S.port, 'adminData', { atoken: r1.data.atoken })).code], ['PASSCODE_OFF', 'AUTH']);
    await S.stop();
    // 環境變數開關：ADMIN_PASSCODE_LOGIN=1 → 開；=0 → 關
    S = await startServer(dir, { ADMIN_PASSCODE_LOGIN: '1' });
    eq('環境變數 ADMIN_PASSCODE_LOGIN=1：恢復；/health via=env、啟動紀錄標【開啟】', [(await api(S.port, 'adminLogin', { pass: 'passcode-77' })).ok, (await hget(S.port)).adminPasscode, /管理通行碼登入：【開啟】（原因：env，應為停用/.test(S.out())], [true, { on: true, via: 'env' }, true]);
    await S.stop();
    for (const v of ['true', 'yes', 'on', '', ' ', '10', '１', '0', 'false']) {   // 怪值一律停用：只有（去掉空白後的）'1' 才算開
      S = await startServer(dir, { ADMIN_PASSCODE_LOGIN: v });
      const rr = await api(S.port, 'adminLogin', { pass: 'passcode-77' });
      eq('環境變數怪值 ' + JSON.stringify(v) + ' → 停用', rr.code, 'PASSCODE_OFF');
      await S.stop();
    }
    S = await startServer(dir, { ADMIN_PASSCODE_LOGIN: ' 1 ' });
    eq('環境變數 \' 1 \'（前後空白）→ 開', (await api(S.port, 'adminLogin', { pass: 'passcode-77' })).ok, true);
    await S.stop();
    S = await startServer(dir, { ADMIN_PASSCODE_LOGIN: '0' });
    eq('環境變數 ADMIN_PASSCODE_LOGIN=0：停用', (await api(S.port, 'adminLogin', { pass: 'passcode-77' })).code, 'PASSCODE_OFF');
    await S.stop();
    // E2E 測試模式沒設時預設開（整套測試登得進）；明確設 0 才關
    const edir = seedDir();
    S = await startServer(edir, { E2E: '1', ALLOW_ORIGIN: '' });
    eq('E2E 測試模式沒設開關：預設開', (await api(S.port, 'adminLogin', { pass: 'passcode-77' })).ok, true);
    await S.stop();
    S = await startServer(edir, { E2E: '1', ADMIN_PASSCODE_LOGIN: '0' });
    eq('E2E 測試模式明確設 0：停用', (await api(S.port, 'adminLogin', { pass: 'passcode-77' })).code, 'PASSCODE_OFF');
    // 真伺服器、通行碼停用：D 憑證整條路（入場券 → 上架 → 編輯 → 置頂 → 回條 → 下架）照常，維護動作收起，通行碼與 A 憑證不通
    S = await startServer(edir, { E2E: '1', ADMIN_PASSCODE_LOGIN: '0' });
    const TA = 'e2ea' + '0'.repeat(57) + '001', pl = (t) => ({ title: t, body: '內容', units: ['mala'], publishOn: L.today(), expiresOn: '', pinned: false, published: true, files: [] });
    const dl = await api(S.port, 'dzyAdminLogin', { ticket: TA }), dt = dl && dl.ok ? dl.data.atoken : '';
    eq('伺服器（停用）：D 入場券換憑證成功', [dl.ok, dt[0]], [true, 'D']);
    const sp2 = await api(S.port, 'savePost', { atoken: dt, post: pl('伺服器 D 上架') }), id2 = sp2.ok ? sp2.data.post.id : '';
    eq('伺服器（停用）：D 上架', sp2.ok, true);
    eq('伺服器（停用）：D 編輯／置頂／回條／下架', [(await api(S.port, 'savePost', { atoken: dt, post: Object.assign(pl('伺服器 D 改'), { id: id2 }) })).ok, (await api(S.port, 'setPinned', { atoken: dt, postId: id2, on: true })).ok,
      (await api(S.port, 'receipts', { atoken: dt, postId: id2 })).ok, (await api(S.port, 'setPublished', { atoken: dt, postId: id2, on: false })).ok], [true, true, true, true]);
    eq('伺服器（停用）：D 做同仁名單維護 → FORBIDDEN；通行碼登入 → PASSCODE_OFF', [(await api(S.port, 'staffAdd', { atoken: dt, name: 'x', unit: 'mala' })).code, (await api(S.port, 'adminLogin', { pass: 'passcode-77' })).code], ['FORBIDDEN', 'PASSCODE_OFF']);
    await S.stop();
  } catch (e) { fail++; console.log('✗ 伺服器層測試例外', e && e.stack || e); }
  procs.forEach((p) => { try { p.kill(); } catch (e) {} });
  tmps.forEach((d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} });
  console.log(`passcode-off: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
