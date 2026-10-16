// node test/dzysso.test.js — 管理系統「公告專區」自動登入（2026-10-16）：Service dzyLogin、redeemTicket（假平台）、伺服器端到端（E2E 假券）
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), net = require('net'), crypto = require('crypto');
const { spawn } = require('child_process');
const L = require('../js/logic.js');
const { makeAuth_ } = require('../gas/Auth.js');
const { makeService_ } = require('../gas/Service.js');
const { redeemTicket } = require('../server/staff-dzy.js');

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; console.log('✗', name, '\n   got ', g, '\n   want', w); }
}
const tmps = [], procs = [];
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); tmps.push(d); return d; };
const nodeCrypto = { sha256Hex: (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex'),
  hmacB64url: (k, m) => crypto.createHmac('sha256', Buffer.from(k, 'utf8')).update(m, 'utf8').digest('base64url'), randomHex: (n) => crypto.randomBytes(n).toString('hex') };
const A = makeAuth_(nodeCrypto, L);

// ---------- 1. Service.dzyLogin ----------
function memStore(staff) {
  const d = { posts: [{ id: 'P-1', title: '公告', body: '', units: ['mala', 'mzt', 'cf'], publishOn: '2026-01-01', expiresOn: '', pinned: false, published: true, offOn: '', files: [] }], staff, log: [] };
  return { d, getPosts: () => JSON.parse(JSON.stringify(d.posts)), savePost: () => {}, getStaff: () => JSON.parse(JSON.stringify(d.staff)), saveStaff: () => {},
    getReads: () => [], addRead: () => {}, addLog: (e) => d.log.push(e), getAdmin: () => ({}), setAdmin: () => {}, secret: () => 'SECRET' };
}
const S0 = (id, name, unit, extra) => Object.assign({ id, name, unit, pinHash: '', salt: '', pinVer: 0, fail: 0, active: true, createdAt: '', deletedAt: '', src: '', store: '', lineHash: '', dzy: '' }, extra || {});
const clock = { nowMs: () => Date.now(), today: () => '2026-10-16' };
const T = (n) => 'e2e0' + '0'.repeat(57) + n;   // 64 位十六進位假券，最後 3 碼＝DZY 編號
const TA = (n) => 'e2ea' + '0'.repeat(57) + n;   // 公告管理券
const fakeRedeem = { redeem: (t, aud) => {
  const m = /^e2e([0a])[0-9a-f]{57}([0-9]{3})$/.exec(t);
  if (!m) return null;
  if (aud === 'bulletin' && m[1] === '0') return { emp_no: 'DZY' + m[2] };
  if (aud === 'bulletin-admin' && m[1] === 'a') return { admin: true, emp_no: 'DZY' + m[2], uid: '', name: '測試主管' };
  return null;
} };
{
  const st = memStore([
    S0('S-001', '測試一', 'mala', { dzy: 'DZY001', fail: 3, pinHash: A.hashPin('x', '2580'), salt: 'x', pinVer: 2 }),
    S0('S-002', '測試二', 'cf', { dzy: 'dzy002' }),
    S0('S-003', '測試三', 'mala', { dzy: 'DZY003', active: false }),
    S0('S-004', '測試四', 'mala', { dzy: 'DZY004', deletedAt: '2026-10-01' }),
    S0('S-005', '測試五', 'mala', { dzy: 'DZY005' }), S0('S-006', '測試六', 'mzt', { dzy: 'DZY005' })]);
  const sv = makeService_(L, st, { quota: () => null }, A, clock, null, null, { staffSource: 'dzy', dzyRedeem: fakeRedeem });
  const r1 = sv.call('dzyLogin', { ticket: T('001') });
  eq('dzyLogin：對到在職同仁 → 登入（密碼被鎖也可以，不動連錯次數）', [r1.ok, r1.data.me.id, r1.data.needPin, st.d.staff[0].fail], [true, 'S-001', false, 3]);
  eq('dzyLogin：拿到的憑證可讀 board', sv.call('board', { token: r1.data.token }).data.me.id, 'S-001');
  eq('dzyLogin：佈告欄存的編號大小寫不一也對得到', sv.call('dzyLogin', { ticket: T('002') }).data.me.id, 'S-002');
  eq('dzyLogin：停用、已刪除 → DZY_NOT_LINKED', [sv.call('dzyLogin', { ticket: T('003') }).code, sv.call('dzyLogin', { ticket: T('004') }).code], ['DZY_NOT_LINKED', 'DZY_NOT_LINKED']);
  eq('dzyLogin：一個編號對到兩位 → DZY_AMBIGUOUS（不讓人選）', sv.call('dzyLogin', { ticket: T('005') }).code, 'DZY_AMBIGUOUS');
  eq('dzyLogin：沒人有這個編號 → DZY_NOT_LINKED', sv.call('dzyLogin', { ticket: T('999') }).code, 'DZY_NOT_LINKED');
  eq('dzyLogin：券無效 → DZY_BAD', sv.call('dzyLogin', { ticket: 'f'.repeat(64) }).code, 'DZY_BAD');
  eq('dzyLogin：券格式不對 → BAD_REQ（不去兌換）', [sv.call('dzyLogin', {}).code, sv.call('dzyLogin', { ticket: 'abc' }).code, sv.call('dzyLogin', { ticket: ['x'] }).code], ['BAD_REQ', 'BAD_REQ', 'BAD_REQ']);
  const odd = makeService_(L, st, {}, A, clock, null, null, { dzyRedeem: { redeem: () => ({ emp_no: 'S-001' }) } });
  eq('dzyLogin：兌換回來不是 DZY 編號 → DZY_BAD', odd.call('dzyLogin', { ticket: T('001') }).code, 'DZY_BAD');
  const off = makeService_(L, st, {}, A, clock, null, null, { staffSource: 'dzy' });
  eq('dzyLogin：沒接兌換（GAS 回退期間）→ DZY_OFF', off.call('dzyLogin', { ticket: T('001') }).code, 'DZY_OFF');
  eq('dzyLogin 在 WRITE_ACTIONS', sv.WRITE_ACTIONS.includes('dzyLogin'), true);
  // dzyAdminLogin（2026-10-17 公告管理）
  st.getAdmin = () => ({ hash: 'x', salt: 's', ver: 3, fail: 4, lockUntil: 0, init: '' });
  const ad = sv.call('dzyAdminLogin', { ticket: TA('009') });
  eq('dzyAdminLogin：管理券 → 管理憑證＋設定頁資料', [ad.ok, /^A\.3\./.test(ad.data.atoken), Array.isArray(ad.data.data.posts)], [true, true, true]);
  const exp = Number(ad.data.atoken.split('.')[2]);
  eq('dzyAdminLogin：憑證效期 8 小時（不是 7 天）', Math.round((exp - Date.now()) / 3600e3), 8);
  eq('dzyAdminLogin：憑證可讀 adminData', sv.call('adminData', { atoken: ad.data.atoken }).ok, true);
  eq('dzyAdminLogin：操作紀錄記下是誰', st.d.log.some((e) => e.action === '管理系統登入' && e.target === 'DZY009' && e.summary.includes('測試主管')), true);
  eq('dzyAdminLogin：一般登入券不能換管理權', sv.call('dzyAdminLogin', { ticket: T('001') }).code, 'DZY_BAD');
  eq('dzyLogin：管理券不能當一般登入', sv.call('dzyLogin', { ticket: TA('001') }).code, 'DZY_BAD');
  eq('dzyAdminLogin：格式錯 → BAD_REQ', sv.call('dzyAdminLogin', { ticket: 'x' }).code, 'BAD_REQ');
  eq('dzyAdminLogin：兌換回來沒有 admin:true → DZY_BAD', makeService_(L, st, {}, A, clock, null, null, { dzyRedeem: { redeem: () => ({ emp_no: 'DZY001' }) } }).call('dzyAdminLogin', { ticket: TA('001') }).code, 'DZY_BAD');
  eq('dzyAdminLogin：GAS 回退期 → DZY_OFF', off.call('dzyAdminLogin', { ticket: TA('001') }).code, 'DZY_OFF');
  eq('dzyAdminLogin：不動通行碼連錯次數（getAdmin 不被寫）', st.getAdmin().fail, 4);
  eq('dzyAdminLogin 在 WRITE_ACTIONS', sv.WRITE_ACTIONS.includes('dzyAdminLogin'), true);
}

(async () => {
  // ---------- 2. redeemTicket：假平台 ----------
  let mode = 'ok', lastBody = null;
  const fake = http.createServer((q, s) => {
    let b = ''; q.on('data', (c) => { b += c; }); q.on('end', () => {
      lastBody = JSON.parse(b);
      if (mode === '500') { s.writeHead(500); return s.end('x'); }
      s.writeHead(200, { 'Content-Type': 'application/json' });
      s.end(JSON.stringify(mode === 'ok' ? { ok: true, data: { emp_no: 'DZY042' } } : mode === 'admin' ? { ok: true, data: { admin: true, emp_no: '', uid: 'u001', name: '系統管理者' } } : mode === 'bad' ? { ok: false, code: 'ticket_invalid' } : mode === 'weird' ? { ok: true, data: { emp_no: 'x' } } : { ok: false, code: 'unauthorized' }));
    });
  });
  await new Promise((ok) => fake.listen(0, '127.0.0.1', ok));
  const cfg = { url: 'http://127.0.0.1:' + fake.address().port + '/platform/api', key: 'fake-svc-key-1' };
  eq('redeemTicket：成功 → 編號', await redeemTicket(cfg, T('042')), { emp_no: 'DZY042' });
  eq('redeemTicket：送 svcSsoRedeem＋金鑰＋aud＝bulletin', [lastBody.action, lastBody.payload.svc_key, lastBody.payload.aud, lastBody.payload.ticket], ['svcSsoRedeem', 'fake-svc-key-1', 'bulletin', T('042')]);
  mode = 'admin'; eq('redeemTicket：管理券 → admin 物件、送 aud＝bulletin-admin', [await redeemTicket(cfg, TA('042'), 'bulletin-admin'), lastBody.payload.aud], [{ admin: true, emp_no: '', uid: 'u001', name: '系統管理者' }, 'bulletin-admin']);
  mode = 'ok'; eq('redeemTicket：要管理券卻回一般結果 → DZY_DOWN', await (async () => { try { await redeemTicket(cfg, TA('042'), 'bulletin-admin'); return 'no'; } catch (e) { return e.code; } })(), 'DZY_DOWN');
  mode = 'bad'; eq('redeemTicket：券無效 → null', await redeemTicket(cfg, T('042')), null);
  const codeOf = async (c) => { try { await redeemTicket(c, T('042')); return 'no-throw'; } catch (e) { return [e.code, e.business, String(e.detail || '').includes('fake-svc-key-1')]; } };
  mode = 'unauth'; eq('redeemTicket：金鑰錯 → DZY_DOWN（不洩漏金鑰）', await codeOf(cfg), ['DZY_DOWN', true, false]);
  mode = 'weird'; eq('redeemTicket：回的不是編號 → DZY_DOWN', (await codeOf(cfg))[0], 'DZY_DOWN');
  mode = '500'; eq('redeemTicket：平台 500 → DZY_DOWN', (await codeOf(cfg))[0], 'DZY_DOWN');
  eq('redeemTicket：非本機網址一律拒絕（金鑰不出本機）', (await codeOf({ url: 'https://example.com/platform/api', key: 'k' }))[0], 'DZY_DOWN');
  eq('redeemTicket：沒設定 → DZY_DOWN', (await codeOf({ url: '', key: '' }))[0], 'DZY_DOWN');
  fake.close();

  // ---------- 3. 伺服器端到端（E2E：'e2e0…###' 假券） ----------
  const port = await new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
  const env = Object.assign({}, process.env, { DZYB_NO_DOTENV: '1', E2E: '1', PORT: String(port), DATA_DIR: tmp('dzyb-sso-srv-'), HOME: tmp('dzyb-sso-home-'), DZY_LOGIN_PER_MIN: '4', DZY_LOGIN_GLOBAL_PER_MIN: '9' });
  ['BRIDGE_URL', 'BRIDGE_KEY', 'ALLOW_ORIGIN', 'DZY_PLATFORM_URL', 'BULLETIN_SVC_KEY'].forEach((k) => delete env[k]);
  const p = spawn(process.execPath, [path.join(__dirname, '..', 'server/index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(p);
  let o = ''; p.stdout.on('data', (c) => { o += c; }); p.stderr.on('data', () => {});
  await new Promise((ok, no) => { const t = setInterval(() => { if (/啟動/.test(o)) { clearInterval(t); ok(); } }, 20); p.on('exit', (c) => { clearInterval(t); no(new Error('伺服器沒起來 ' + c)); }); });
  const post = (body, xff) => new Promise((ok) => {
    const buf = Buffer.from(JSON.stringify(body));
    const rq = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/', agent: false,
      headers: Object.assign({ 'Content-Type': 'text/plain', 'Content-Length': buf.length }, xff ? { 'X-Forwarded-For': xff } : {}) }, (res) => {
      const cs = []; res.on('data', (c) => cs.push(c)); res.on('end', () => ok(JSON.parse(Buffer.concat(cs).toString())));
    });
    rq.end(buf);
  });
  await new Promise((ok) => {
    const buf = Buffer.from(JSON.stringify({ staff: [{ id: 'S-001', name: '測試一', unit: 'mala', pin: '2580', dzy: 'DZY001' }, { id: 'S-002', name: '測試二', unit: 'cf', pin: null }],
      posts: [{ id: 'P-1', title: '公告', units: ['mala', 'mzt', 'cf'], publishOn: '2026-01-01' }], reads: [], adminPass: 'adminpass88', clock: [] }));
    const rq = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/__seed', agent: false, headers: { 'Content-Type': 'text/plain', 'Content-Length': buf.length } }, (res) => { res.resume(); res.on('end', ok); });
    rq.end(buf);
  });
  const IP = '203.0.113.7';
  const s1 = await post({ action: 'dzyLogin', ticket: T('001') }, IP);
  eq('伺服器 dzyLogin：對到 → 登入、憑證可讀 board', [s1.ok, s1.data && s1.data.me.id, (await post({ action: 'board', token: s1.data.token })).data.me.id], [true, 'S-001', 'S-001']);
  // 種子帶的通行碼是「待生效」（ADMIN_INIT）：要先用通行碼登入一次才生效；生效前所有管理憑證一律無效（含管理系統換來的）
  eq('伺服器 dzyAdminLogin：通行碼更換待生效時 → AUTH', (await post({ action: 'dzyAdminLogin', ticket: TA('003') }, '203.0.113.20')).code, 'AUTH');
  await post({ action: 'adminLogin', pass: 'adminpass88' }, '203.0.113.21');
  const ad = await post({ action: 'dzyAdminLogin', ticket: TA('003') }, '203.0.113.20');
  eq('伺服器 dzyAdminLogin：管理券 → 憑證可讀 adminData', [ad.ok, (await post({ action: 'adminData', atoken: ad.data.atoken })).ok], [true, true]);
  eq('伺服器 dzyAdminLogin：一般券 → DZY_BAD', (await post({ action: 'dzyAdminLogin', ticket: T('001') }, '203.0.113.20')).code, 'DZY_BAD');
  eq('伺服器 dzyLogin：沒有編號的同仁 → DZY_NOT_LINKED', (await post({ action: 'dzyLogin', ticket: T('002') }, IP)).code, 'DZY_NOT_LINKED');
  eq('伺服器 dzyLogin：假券以外 → DZY_BAD', (await post({ action: 'dzyLogin', ticket: 'f'.repeat(64) }, IP)).code, 'DZY_BAD');
  eq('伺服器 dzyLogin：同一 IP 第 4 次仍可', (await post({ action: 'dzyLogin', ticket: T('001') }, IP)).ok, true);
  eq('伺服器 dzyLogin：同一 IP 第 5 次 → BUSY', (await post({ action: 'dzyLogin', ticket: T('001') }, IP)).code, 'BUSY');
  eq('伺服器 限流分開（審查 #42-1）：dzyLogin 被擋時同一 IP 的 LINE 登入不受影響', (await post({ action: 'lineLogin', idToken: 'TEST:U-x' }, IP)).code, 'LINE_NOT_LINKED');
  eq('伺服器 dzyLogin：格式錯不算進限流、別的 IP 照常（全體第 8、9 次）', [(await post({ action: 'dzyLogin', ticket: 'x' }, '203.0.113.8')).code, (await post({ action: 'dzyLogin', ticket: T('001') }, '203.0.113.8')).ok, (await post({ action: 'dzyLogin', ticket: T('001') }, '203.0.113.9')).ok], ['BAD_REQ', true, true]);
  eq('伺服器 dzyLogin：全體超過上限 → BUSY（換 IP 也一樣）', (await post({ action: 'dzyLogin', ticket: T('001') }, '203.0.113.10')).code, 'BUSY');

  procs.forEach((x) => { try { x.kill(); } catch (e) {} });
  tmps.forEach((d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} });
  console.log('dzysso: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); procs.forEach((x) => { try { x.kill(); } catch (er) {} }); process.exit(1); });
