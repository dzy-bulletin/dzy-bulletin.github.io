// node test/server.test.js — 啟動真的 Mac mini 伺服器（server/index.js，子程序）＋假 async 橋接，驗 #6 的伺服器驗收：
// 只聽 127.0.0.1、正式模式沒有測試入口、413／503、READONLY、無憑證不打橋接、阻塞測試、並發 p95、Node 版本檢查、/health 格式。
// 自給自足：自己找空埠、自己建暫存 DATA_DIR、跑完自己關；不連任何外部網址。
'use strict';
const { spawn, execFileSync } = require('child_process');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SERVER_JS = path.join(ROOT, 'server/index.js');
let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; console.log('✗', name, '\n   got ', g, '\n   want', w); }
}
const tmps = [], procs = [];

function freePort() {
  return new Promise((ok, no) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); s.on('error', no); });
}
function cleanEnv(extra) {
  const e = Object.assign({}, process.env);
  ['E2E', 'ALLOW_ORIGIN', 'BRIDGE_URL', 'BRIDGE_KEY', 'MAX_INFLIGHT_MB', 'BRIDGE_FAKE_DELAY_MS', 'DZYB_NODE_VERSION', 'PORT', 'DATA_DIR'].forEach((k) => delete e[k]);
  e.DZYB_NO_DOTENV = '1';
  return Object.assign(e, extra);
}
// 啟動伺服器；回傳 { port, dir, out(), stop() }。啟動失敗（程序結束）時回傳 { code, stderr }
async function start(env) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dzyb-srv-')); tmps.push(dir);
  const e = cleanEnv(Object.assign({ PORT: String(port), DATA_DIR: dir }, env));
  Object.keys(e).forEach((k) => { if (e[k] === null) delete e[k]; });   // env 值給 null＝不設這個變數
  const p = spawn(process.execPath, [SERVER_JS], { env: e, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(p);
  let out = '', err = '';
  p.stdout.on('data', (c) => { out += c; }); p.stderr.on('data', (c) => { err += c; });
  return new Promise((ok) => {
    const t = setInterval(() => { if (/啟動/.test(out)) { clearInterval(t); ok({ port, dir, proc: p, out: () => out, err: () => err, stop: () => p.kill() }); } }, 20);
    p.on('exit', (code) => { clearInterval(t); ok({ code, stderr: err, stdout: out }); });
  });
}
// HTTP 請求（每次新連線）；body 可為物件（JSON）、Buffer／字串；opts.chunked＝不帶 Content-Length
function request(port, method, p, body, opts) {
  opts = opts || {};
  return new Promise((ok, no) => {
    const buf = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const headers = Object.assign({ 'Content-Type': 'text/plain' }, opts.headers || {});
    if (buf && !opts.chunked) headers['Content-Length'] = buf.length;
    const t0 = process.hrtime.bigint();
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers, agent: false }, (res) => {
      const cs = []; res.on('data', (c) => cs.push(c));
      res.on('end', () => {
        const ms = Number(process.hrtime.bigint() - t0) / 1e6, txt = Buffer.concat(cs).toString();
        let json = null; try { json = JSON.parse(txt); } catch (e) {}
        ok({ status: res.statusCode, headers: res.headers, json, ms });
      });
    });
    r.on('error', (e) => ok({ status: 0, error: e.code || e.message, ms: Number(process.hrtime.bigint() - t0) / 1e6 }));
    if (buf) {
      if (opts.chunked) { for (let i = 0; i < buf.length; i += 1 << 20) r.write(buf.subarray(i, i + (1 << 20))); }
      else r.write(buf);
    }
    r.end();
  });
}
const api = (s, action, q) => request(s.port, 'POST', '/', Object.assign({}, q || {}, { action }));
const p95 = (xs) => { const a = xs.slice().sort((x, y) => x - y); return a[Math.ceil(a.length * 0.95) - 1]; };
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
async function login(s) {   // 以 demo 資料建一個同仁憑證＋主管憑證
  await request(s.port, 'POST', '/__seed', { demo: true });
  const at = (await api(s, 'adminLogin', { pass: '1234' })).json.data.atoken;
  const code = (await api(s, 'staffIssueCode', { atoken: at, staffId: 'S-013' })).json.data.code;
  const tok = (await api(s, 'setPin', { staffId: 'S-013', pin: '2580', code })).json.data.token;
  return { tok, at };
}
const calls = async (s) => (await request(s.port, 'GET', '/__bridgeCalls')).json.data;
const today = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
// 直接讀伺服器的 SQLite（唯讀連線），驗「沒有多寫一筆」這類 API 看不到的事
function dbq(dir, sql) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(dir, 'bulletin.db'), { readOnly: true });
  try { return db.prepare(sql).all().map((r) => Object.assign({}, r)); } finally { db.close(); }
}
// 開一條原始 TCP 連線、只送 header（不送或少送 body）；回傳 socket
function rawConn(port, head) {
  return new Promise((ok) => { const c = net.connect(port, '127.0.0.1', () => { c.write(head); ok(c); }); c.on('error', () => {}); });
}

async function main() {
  // ---- Node 版本檢查 ----
  const { nodeProblem, MIN_NODE } = require('../server/index.js');
  eq('MIN_NODE is 24', MIN_NODE, 24);
  eq('node 24 ok', [nodeProblem('24.0.0'), nodeProblem('v26.5.0')], ['', '']);
  eq('node 23/22 rejected', [!!nodeProblem('23.4.0'), !!nodeProblem('22.13.1')], [true, true]);
  { const r = await start({ E2E: '1', DZYB_NODE_VERSION: '22.13.1' });
    eq('old node exits with needed version', [r.code, /Node 24/.test(r.stderr || '')], [1, true]); }

  // ---- E2E 模式的保險：正式網域／沒指定或指定預設 DATA_DIR／有真橋接設定，一律拒絕啟動 ----
  { const r = await start({ E2E: '1', ALLOW_ORIGIN: 'https://dzy-bulletin.github.io' });
    eq('E2E with prod ALLOW_ORIGIN refuses to start', [r.code, /拒絕啟動/.test(r.stderr || '')], [1, true]);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dzyb-home-')); tmps.push(home);   // 假 HOME：就算保險失效也碰不到真的 ~/dzy-bulletin-data
    const r1 = await start({ E2E: '1', HOME: home, DATA_DIR: null });
    eq('E2E without DATA_DIR refuses to start', [r1.code, /DATA_DIR/.test(r1.stderr || '')], [1, true]);
    const r2 = await start({ E2E: '1', HOME: home, DATA_DIR: path.join(home, 'dzy-bulletin-data') });
    const r3 = await start({ E2E: '1', HOME: home, DATA_DIR: '~/dzy-bulletin-data/' });
    const r3b = await start({ E2E: '1', HOME: home, DATA_DIR: path.join(home, 'DZY-Bulletin-Data') });   // APFS 不分大小寫
    fs.mkdirSync(path.join(home, 'dzy-bulletin-data')); fs.symlinkSync(path.join(home, 'dzy-bulletin-data'), path.join(home, 'alias'));
    const r3c = await start({ E2E: '1', HOME: home, DATA_DIR: path.join(home, 'alias') });                  // 符號連結
    eq('E2E with default DATA_DIR refuses to start', [r2.code, r3.code, r3b.code, r3c.code, fs.readdirSync(path.join(home, 'dzy-bulletin-data'))], [1, 1, 1, 1, []]);
    const r4 = await start({ E2E: '1', BRIDGE_KEY: 'k' });
    const r5 = await start({ E2E: '1', BRIDGE_URL: 'https://example.invalid/exec' });
    eq('E2E with real bridge settings refuses to start', [r4.code, r5.code, /BRIDGE/.test(r4.stderr || '')], [1, 1, true]); }

  // ---- 正式模式（無 E2E）----
  const P = await start({});
  eq('prod server started', typeof P.port, 'number');
  { let lines = [];
    try { lines = execFileSync('lsof', ['-nP', '-iTCP:' + P.port, '-sTCP:LISTEN'], { encoding: 'utf8' }).split('\n').slice(1).filter(Boolean); } catch (e) {}
    eq('listens on 127.0.0.1 only (lsof)', [lines.length > 0, lines.every((l) => /127\.0\.0\.1:/.test(l))], [true, true]); }
  { const ext = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
    if (ext) {
      const refused = await new Promise((ok) => { const c = net.connect(P.port, ext.address); c.on('connect', () => { c.destroy(); ok(false); }); c.on('error', () => ok(true)); });
      eq('not reachable on LAN address', refused, true);
    } }
  eq('prod POST /__seed is 404', (await request(P.port, 'POST', '/__seed', { demo: true })).status, 404);
  eq('prod GET /__blob is 404', (await request(P.port, 'GET', '/__blob?id=x')).status, 404);
  eq('prod POST /__bridge and /__files (M7 test routes) are 404', [(await request(P.port, 'POST', '/__bridge', { op: 'filelist' })).status, (await request(P.port, 'POST', '/__files', {})).status], [404, 404]);
  { const h = await request(P.port, 'GET', '/health');
    eq('health shape', Object.keys(h.json).sort(), ['announce', 'backup', 'bridge', 'disk', 'e2e', 'files', 'level', 'mirror', 'ok', 'remind', 'uptime', 'v', 'why']);
    eq('health prod values', [h.json.ok, h.json.e2e, h.json.bridge, h.json.mirror, h.json.backup, h.json.files, h.json.remind, typeof h.json.disk.freeMB], [true, false, 'missing', null, null, null, null, 'number']);
    eq('health level red when jobs never ran', [h.json.level, h.json.why.slice(0, 2)], ['red', ['沒有鏡像紀錄', '沒有快照紀錄']]);
    eq('response has Content-Length', Number(h.headers['content-length']) > 0, true); }
  { fs.mkdirSync(path.join(P.dir, 'logs'));
    fs.writeFileSync(path.join(P.dir, 'logs/mirror-last.json'), JSON.stringify({ at: '2026-09-30T01:00:00Z', ok: false, sigPending: 3, error: '/Users/secret/path 失敗' }));
    fs.writeFileSync(path.join(P.dir, 'logs/backup-last.json'), JSON.stringify({ at: '2026-09-30T03:00:00Z', ok: true, file: '/Users/x/b.db' }));
    const h = (await request(P.port, 'GET', '/health')).json;
    eq('health mirror/backup status only', [h.mirror, h.backup], [{ at: '2026-09-30T01:00:00Z', ok: false, sigPending: 3, missing: 0, bad: 0, skipped: 0, fails: 0, notMigrated: false }, { at: '2026-09-30T03:00:00Z', ok: true, sharedWith: null }]);
    eq('health why has no raw error text', /secret|Users/.test(JSON.stringify(h)), false);
    // M7（#18 D8）：/health 帶出 files 六個欄位（從 mirror-last.json 的 files 挑），錯誤原文與清單不外露；stale > 0 → 黃
    fs.writeFileSync(path.join(P.dir, 'logs/mirror-last.json'), JSON.stringify({ at: new Date().toISOString(), ok: true, pending: 0, fails: 0,
      files: { ok: false, count: 12, bytes: 34567, pending: 2, stale: 1, fetched: 0, failed: 2, skipped: 1, lastScanAt: '2026-09-30T02:00:00.000Z', error: '/Users/secret 失敗', failedIds: ['F-9（x）'] } }));
    const h2 = (await request(P.port, 'GET', '/health')).json;
    eq('health files: six fields only', h2.files, { count: 12, bytes: 34567, pending: 2, stale: 1, skipped: 1, lastScanAt: '2026-09-30T02:00:00.000Z' });
    eq('health files stale > 0 → yellow reason', h2.why.includes('有附件超過 24 小時沒補齊'), true);
    eq('health files: no raw error text / id list', /secret|Users|F-9/.test(JSON.stringify(h2)), false);
    fs.writeFileSync(path.join(P.dir, 'logs/mirror-last.json'), JSON.stringify({ at: new Date().toISOString(), ok: true, pending: 0, fails: 0, files: { count: 1, bytes: 1, pending: 3, stale: 0, skipped: 0, lastScanAt: null } }));
    eq('health files pending > 0 && stale = 0 → no files reason', (await request(P.port, 'GET', '/health')).json.why.includes('有附件超過 24 小時沒補齊'), false);
    // #26：/health 帶出 remind 三個欄位（從 remind-last.json 挑），錯誤原文不外露；ok=false → 黃「未簽提醒送出失敗」，ok=true 不影響
    fs.writeFileSync(path.join(P.dir, 'logs/remind-last.json'), JSON.stringify({ at: '2026-10-02T10:00:00.000Z', ok: false, people: 3, posts: 2, queued: 0, error: '小幫手拒收：/Users/secret' }));
    const h3 = (await request(P.port, 'GET', '/health')).json;
    eq('health remind: three fields only', h3.remind, { at: '2026-10-02T10:00:00.000Z', ok: false, people: 3 });
    eq('health remind ok=false → yellow reason、no raw error', [h3.why.includes('未簽提醒送出失敗'), /secret|Users|拒收/.test(JSON.stringify(h3))], [true, false]);
    fs.writeFileSync(path.join(P.dir, 'logs/remind-last.json'), JSON.stringify({ at: '2026-10-02T10:00:00.000Z', ok: true, people: 0, posts: 0, queued: 0 }));
    eq('health remind ok=true → no remind reason', (await request(P.port, 'GET', '/health')).json.why.includes('未簽提醒送出失敗'), false); }
  { const big = Buffer.alloc(41 * 1024 * 1024, 0x41);
    eq('41MB body → 413', (await request(P.port, 'POST', '/', big)).status, 413);
    eq('41MB chunked body → 413', (await request(P.port, 'POST', '/', big, { chunked: true })).status, 413);
    eq('server alive after 413', (await api(P, 'roster')).status, 200); }
  // B1：只送 header、不送資料的連線不佔請求體額度（5×40MB 閒置連線時 roster 仍 200）
  { const conns = await Promise.all(Array.from({ length: 5 }, () => rawConn(P.port, 'POST / HTTP/1.1\r\nHost: x\r\nContent-Type: text/plain\r\nContent-Length: 41943040\r\n\r\n')));
    await sleep(100);
    const r = await api(P, 'roster');
    eq('5 idle 40MB header-only conns do not exhaust budget', [r.status, r.json && r.json.ok], [200, true]);
    conns.forEach((c) => c.destroy()); }
  { await api(P, 'login', { staffId: 'S-001', pin: '97531' });
    const lines = P.out().split('\n');
    eq('one log line per request: time action ms ok/code', [lines.some((l) => /^\d{4}-\d\d-\d\dT[\d:.]+Z roster \d+ms ok$/.test(l)), lines.some((l) => /^\S+Z login \d+ms NOT_FOUND$/.test(l))], [true, true]);
    eq('log has no parameters', /97531|S-001/.test(P.out()), false); }
  P.stop();

  // ---- 慢速連線：請求體 BODY_IDLE_MS 沒有新資料就中斷 ----
  { const S = await start({ E2E: '1', BODY_IDLE_MS: '300' });
    const c = await rawConn(S.port, 'POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 1000\r\n\r\n{"act');
    const closed = await new Promise((ok) => { const t = setTimeout(() => ok(false), 3000); c.on('close', () => { clearTimeout(t); ok(true); }); });
    eq('slow body is cut after idle timeout', closed, true);
    eq('server alive after idle cut', (await api(S, 'roster')).status, 200);
    S.stop(); }

  // ---- 橋接錯誤碼不原樣回傳（假橋接一律回 AUTH，模擬 BRIDGE_KEY 設錯）----
  { const F = await start({ E2E: '1', BRIDGE_FAKE_FAIL: '1' });
    const { at: atF } = await login(F);
    const r = await api(F, 'uploadFile', { atoken: atF, name: 'a.pdf', data: 'JVBERi0x' });
    eq('bridge AUTH error mapped to BRIDGE (admin not logged out)', [r.json.code, r.json.message], ['BRIDGE', 'Google 雲端暫時連不上，請稍後再試']);
    eq('bridge error on syncClock also BRIDGE', (await api(F, 'syncClock', { atoken: atF })).json.code, 'BRIDGE');
    eq('bridge detail only in stderr', /橋接金鑰錯誤/.test(F.err()), true);
    F.stop(); }

  // ---- E2E 伺服器（假橋接每個動作延遲 10 秒）----
  const A = await start({ E2E: '1', BRIDGE_FAKE_DELAY_MS: '10000' });
  const { tok, at } = await login(A);
  eq('e2e health flag', (await request(A.port, 'GET', '/health')).json.e2e, true);

  // 無有效管理憑證：不會打橋接
  { const c0 = await calls(A);
    const rs = await Promise.all([
      api(A, 'uploadFile', { name: 'a.pdf', data: 'JVBERi0x' }),
      api(A, 'uploadFile', { atoken: 'A.1.99999999999999.bad', name: 'a.pdf', data: 'JVBERi0x' }),
      api(A, 'uploadFile', { atoken: tok, name: 'a.pdf', data: 'JVBERi0x' }),
      api(A, 'syncClock', {}),
      api(A, 'syncClock', { atoken: 'A.1.99999999999999.bad' }),
      api(A, 'savePost', { post: { title: 't', units: ['mala'], publishOn: '2026-09-30', files: [{ id: 'F-9', name: 'x.pdf' }] } }),
      api(A, 'uploadFile', { atoken: at, name: 'evil.exe', data: 'AAAA' }),                                   // 有憑證但格式錯：也不打橋接
      api(A, 'savePost', { atoken: at, post: { title: '', units: ['mala'], publishOn: '2026-09-30', files: [{ id: 'F-9', name: 'x.pdf' }] } })   // 格式錯的公告不先分享附件
    ]);
    eq('unauthorized codes', rs.map((r) => r.json.code), ['AUTH', 'AUTH', 'AUTH', 'AUTH', 'AUTH', 'AUTH', 'BAD_TYPE', 'BAD_REQ']);
    eq('unauthorized all fast (no bridge wait)', rs.every((r) => r.ms < 1000), true);
    const c1 = await calls(A);
    eq('no bridge calls without valid admin token', [c1.upload - c0.upload, c1.clock - c0.clock, c1.share - c0.share], [0, 0, 0]); }

  // 阻塞測試：upload／share／clock 延遲 10 秒、quota 背景刷新也延遲 10 秒，期間 board 與 adminData 照常 1 秒內回
  { const c0 = await calls(A);
    const slow = [
      api(A, 'uploadFile', { atoken: at, name: 'a.pdf', data: 'JVBERi0x' }),
      api(A, 'syncClock', { atoken: at }),
      api(A, 'savePost', { atoken: at, post: { title: '附件公告', units: ['mala'], publishOn: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10), files: [{ id: 'F-77', name: 'x.pdf' }] } })
    ];
    await sleep(200);
    const fast = await Promise.all([api(A, 'board', { token: tok }), api(A, 'adminData', { atoken: at }), api(A, 'roster')]);
    eq('board < 1s while bridge busy', [fast[0].json.ok, fast[0].ms < 1000], [true, true]);
    eq('adminData < 1s while quota slow (reads cache)', [fast[1].json.ok, fast[1].ms < 1000], [true, true]);
    eq('roster < 1s while bridge busy', [fast[2].json.ok, fast[2].ms < 1000], [true, true]);
    const sl = await Promise.all(slow);
    eq('upload finished after delay', [sl[0].json.ok, sl[0].json.data && sl[0].json.data.type, sl[0].ms >= 9500], [true, 'pdf', true]);
    eq('syncClock finished after delay', [sl[1].json.ok, Array.isArray(sl[1].json.data && sl[1].json.data.added), sl[1].ms >= 9500], [true, true, true]);
    eq('savePost with file finished after share', [sl[2].json.ok, sl[2].ms >= 9500], [true, true]);
    const c1 = await calls(A);
    eq('adminData never calls quota on request path', c1.quota - c0.quota, 0);
    eq('each slow op hit bridge once', [c1.upload - c0.upload, c1.clock - c0.clock, c1.share - c0.share], [1, 1, 1]); }

  // READONLY 凍結開關
  { fs.writeFileSync(path.join(A.dir, 'READONLY'), '');
    const r1 = await api(A, 'ack', { token: tok, postId: 'P-20260920-001', sig: 'data:image/jpeg;base64,AA' });
    eq('READONLY: ack → MOVED', [r1.json.code, r1.json.message], ['MOVED', '系統搬家中，請稍後重新整理']);
    eq('READONLY: board still ok', (await api(A, 'board', { token: tok })).json.ok, true);
    eq('READONLY: login → MOVED', (await api(A, 'login', { staffId: 'S-013', pin: '2580' })).json.code, 'MOVED');
    fs.unlinkSync(path.join(A.dir, 'READONLY'));
    eq('READONLY removed: ack ok', (await api(A, 'ack', { token: tok, postId: 'P-20260920-001', sig: 'data:image/jpeg;base64,AA' })).json.ok, true); }

  // store 系統錯誤不外洩（sigs/ 沒有寫入權限時 ack 回通用 SERVER，不帶 EACCES 與路徑）
  { const np = (await api(A, 'savePost', { atoken: at, post: { title: '權限測試', units: ['mala'], publishOn: today(), files: [] } })).json.data.post.id;
    fs.chmodSync(path.join(A.dir, 'sigs'), 0o555);
    const r = await api(A, 'ack', { token: tok, postId: np, sig: 'data:image/png;base64,iVBORw0K' });
    fs.chmodSync(path.join(A.dir, 'sigs'), 0o755);
    eq('store error → generic SERVER', [r.json.code, r.json.message], ['SERVER', '系統忙碌，請稍後再試']);
    eq('store error text only in stderr', [/EACCES/.test(JSON.stringify(r.json)), /EACCES/.test(A.err())], [false, true]);
    eq('failed ack not recorded', (await api(A, 'board', { token: tok })).json.data.myReads[np], undefined); }

  // 並發 50 個 board
  { const rs = await Promise.all(Array.from({ length: 50 }, () => api(A, 'board', { token: tok })));
    const ms = rs.map((r) => r.ms);
    eq('50 concurrent board all 200 ok', rs.every((r) => r.status === 200 && r.json.ok), true);
    eq('50 concurrent board p95 < 300ms', p95(ms) < 300 ? true : p95(ms), true); }
  A.stop();

  // ---- 請求體總量上限 1MB：同時 3 個 600KB，至少 1 個 503 ----
  const B = await start({ E2E: '1', MAX_INFLIGHT_MB: '1', BRIDGE_FAKE_DELAY_MS: '2000' });
  { const { at: atB } = await login(B);
    const data = 'A'.repeat(600 * 1024);
    const rs = await Promise.all([0, 1, 2].map(() => api(B, 'uploadFile', { atoken: atB, name: 'a.pdf', data })));
    const busy = rs.filter((r) => r.status === 503);
    eq('inflight cap: at least one 503 BUSY', [busy.length >= 1, busy.every((r) => r.json && r.json.code === 'BUSY')], [true, true]);
    await sleep(300);   // M7（#18 D1）：上傳成功的那幾個在回應送出後、存完本機備份才釋放額度（毫秒級），再送下一個
    eq('inflight released after response', (await api(B, 'uploadFile', { atoken: atB, name: 'a.pdf', data })).json.ok, true); }
  // S1：等 share 橋接期間才建立的 READONLY 也擋得住寫入
  { const { at: atB } = await login(B);
    const n0 = dbq(B.dir, 'SELECT COUNT(*) AS n FROM posts')[0].n;
    const pr = api(B, 'savePost', { atoken: atB, post: { title: '凍結中', units: ['mala'], publishOn: today(), files: [{ id: 'F-1', name: 'x.pdf' }] } });
    await sleep(400); fs.writeFileSync(path.join(B.dir, 'READONLY'), '');
    const r = await pr;
    fs.unlinkSync(path.join(B.dir, 'READONLY'));
    eq('READONLY created during bridge wait blocks the write', [r.json.code, dbq(B.dir, 'SELECT COUNT(*) AS n FROM posts')[0].n - n0], ['MOVED', 0]);
    eq('READONLY blocks uploadFile too', (fs.writeFileSync(path.join(B.dir, 'READONLY'), ''), (await api(B, 'uploadFile', { atoken: atB, name: 'a.pdf', data: 'JVBERi0x' })).json.code), 'MOVED');
    fs.unlinkSync(path.join(B.dir, 'READONLY')); }
  // S4：重跑 Service 與 GAS 一樣冪等——同 reqId 依序送 A（含附件）→ B（改標題、不帶 id）→ B 重送：重送不 share、不重寫、不多記一筆
  { const { at: atB } = await login(B);
    const body = { title: '冪等附件', units: ['mala'], publishOn: today(), files: [{ id: 'F-9', name: 'x.pdf' }] };
    const share = async () => (await calls(B)).share;
    const s0 = await share();
    const ra = await api(B, 'savePost', { atoken: atB, post: body, reqId: 'rid-s4' }); const s1 = await share();
    const rb = await api(B, 'savePost', { atoken: atB, post: Object.assign({}, body, { title: '冪等附件（改）' }), reqId: 'rid-s4' }); const s2 = await share();
    const logs = dbq(B.dir, 'SELECT COUNT(*) AS n FROM log')[0].n;
    const rc = await api(B, 'savePost', { atoken: atB, post: Object.assign({}, body, { title: '冪等附件（改）' }), reqId: 'rid-s4' }); const s3 = await share();
    eq('same post id through A→B→B', [ra.json.ok, rb.json.data.post.id === ra.json.data.post.id, rc.json.data.post.id === ra.json.data.post.id], [true, true, true]);
    eq('resend: share 1/1/0', [s1 - s0, s2 - s1, s3 - s2], [1, 1, 0]);
    eq('resend: no extra log, updatedAt unchanged', [dbq(B.dir, 'SELECT COUNT(*) AS n FROM log')[0].n - logs, rc.json.data.post.updatedAt === rb.json.data.post.updatedAt], [0, true]); }
  // 第 2 輪應修-1（repro2 NA）：kv 有一筆壞掉的 req 紀錄時用同一個 reqId 存公告 → 當作新請求、真的存進去，絕不回 ok:true 卻沒寫入
  { const { at: atB } = await login(B);
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(B.dir, 'bulletin.db')); db.prepare("INSERT INTO kv (k, v) VALUES ('req:rid-bad', '{exp: 99999999999999, v: 1}')").run(); db.close();
    const r = await api(B, 'savePost', { atoken: atB, reqId: 'rid-bad', post: { title: '會不見的公告', units: ['mala'], publishOn: today(), files: [] } });
    const rows = dbq(B.dir, "SELECT COUNT(*) AS n FROM posts WHERE json LIKE '%會不見的公告%'")[0].n;
    eq('corrupt req row: ok:true only if really saved', [r.json.ok, rows], [true, 1]);
    eq('corrupt req row: other writes still work', (await api(B, 'savePost', { atoken: atB, reqId: 'rid-2', post: { title: '之後', units: ['mala'], publishOn: today(), files: [] } })).json.ok, true); }
  // 第 2 輪應修-2：Apps Script 回的業務錯誤（Files.js 的 BAD_REQ）照原 code／message 回
  { const { at: atB } = await login(B);
    const r = await api(B, 'savePost', { atoken: atB, post: { title: '失效附件', units: ['mala'], publishOn: today(), files: [{ id: 'F-GONE', name: 'x.pdf' }] } });
    eq('bridge business error passthrough (BAD_REQ)', [r.json.code, r.json.message], ['BAD_REQ', '找不到附件檔案']);
    eq('business error: post not saved', dbq(B.dir, "SELECT COUNT(*) AS n FROM posts WHERE json LIKE '%失效附件%'")[0].n, 0); }
  B.stop();

  // ---- M7（#18）：附件本機備份（上傳存本機、唯讀時不影響上傳並由 mirror 第 3 步補回、第二輪失敗不存、移除後永久保留）----
  { const C = await start({ E2E: '1', BRIDGE_FAKE_DELAY_MS: '600' });
    const crypto = require('crypto'), FL = require('../server/files-local.js'), { runMirror } = require('../server/mirror.js');
    const { at: atC } = await login(C);
    const fdir = path.join(C.dir, 'files');
    const hash = (alg, b) => crypto.createHash(alg).update(b).digest('hex');
    const until = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 5000)) { if (fn()) return true; await sleep(50); } return false; };
    // 1. 上傳 → files/<id> 與 <id>.json、sha256／md5 相同、meta.size＝Drive 回的 size
    const b1 = crypto.randomBytes(300 * 1024 + 1);
    const u1 = (await api(C, 'uploadFile', { atoken: atC, name: 'M7測試.pdf', data: b1.toString('base64') })).json;
    await until(() => { const m = FL.readMeta(C.dir, u1.data.id); return m && m.savedAt; });
    const m1 = FL.readMeta(C.dir, u1.data.id), l1 = fs.readFileSync(FL.bytesPath(C.dir, u1.data.id));
    eq('M7 upload: ok and local files exist', [u1.ok, fs.existsSync(path.join(fdir, u1.data.id)), fs.existsSync(path.join(fdir, u1.data.id + '.json'))], [true, true, true]);
    eq('M7 upload: sha256/md5 of local bytes = uploaded bytes; meta.size = Drive size', [hash('sha256', l1) === hash('sha256', b1), hash('md5', l1) === hash('md5', b1), m1.sha256, m1.md5, m1.size, u1.data.size, m1.source, m1.name, m1.mime],
      [true, true, hash('sha256', b1), hash('md5', b1), b1.length, b1.length, 'upload', 'M7測試.pdf', 'application/pdf']);
    eq('M7 upload: no tmp left', fs.readdirSync(fdir).filter((f) => /tmp/.test(f)), []);
    // 2. files/ 唯讀 → 主管照樣拿到 ok 與 fileId、公告可正常儲存；stderr 一行；下一輪 mirror 第 3 步補回（meta 也沒寫進去 → 由公告引用補建）
    fs.chmodSync(fdir, 0o555);
    const b2 = crypto.randomBytes(40000);
    const u2 = (await api(C, 'uploadFile', { atoken: atC, name: '唯讀.xlsx', data: b2.toString('base64') })).json;
    const sp = (await api(C, 'savePost', { atoken: atC, post: { title: 'M7 唯讀附件', units: ['mala'], publishOn: today(), files: [{ id: u2.data && u2.data.id, name: '唯讀.xlsx', size: b2.length }] } })).json;
    const logged = await until(() => new RegExp('附件本機備份失敗 ' + u2.data.id + '：').test(C.err()));
    fs.chmodSync(fdir, 0o755);
    eq('M7 read-only files/: upload still ok with fileId, post saved', [u2.ok, /^F-\d+$/.test(u2.data.id), sp.ok, (sp.data.post.files || []).map((f) => f.id)], [true, true, true, [u2.data.id]]);
    eq('M7 read-only files/: one stderr line, nothing written locally', [logged, C.err().split('\n').filter((l) => l.includes('附件本機備份失敗 ' + u2.data.id)).length, FL.readMeta(C.dir, u2.data.id), FL.hasBytes(C.dir, u2.data.id), /EACCES|\/files/.test(JSON.stringify(sp))], [true, 1, null, false, false]);
    const viaC = { call: async (op, pl) => {   // mirror 第 3 步打這台 E2E 伺服器的假 Drive（fileget／filelist）；簽名與鏡像回假成功
      if (op === 'fileget' || op === 'filelist') { const r = (await request(C.port, 'POST', '/__bridge', Object.assign({}, pl, { op }))).json; if (!r.ok) { const e = new Error(r.message); e.code = r.code; throw e; } return r.data; }
      if (op === 'sigs') return { ids: pl.put.map((x) => 'DRV-' + x.name) };
      if (op === 'mirror') return { counts: {} };
      throw new Error('未知 op ' + op); } };
    const rm = await runMirror({ dir: C.dir, bridge: viaC });
    const m2 = FL.readMeta(C.dir, u2.data.id);
    eq('M7 next mirror step 3 restores it (meta rebuilt from post, bytes md5 ok)', [!!m2, m2 && m2.source, FL.hasBytes(C.dir, u2.data.id) && hash('sha256', fs.readFileSync(FL.bytesPath(C.dir, u2.data.id))) === hash('sha256', b2), m2 && m2.md5, rm.ok],
      [true, 'posts', true, hash('md5', b2), true]);
    eq('M7 step 3 only leaves demo placeholders pending (not in fake Drive)', (rm.files.pendingIds || []).every((id) => /^demo-/.test(id)), true);
    // 4. 主管移除附件 → 本機位元組仍在、meta 補上 removedAt；revoke 照常送 Drive
    const post1 = (await api(C, 'savePost', { atoken: atC, post: { title: 'M7 移除測試', units: ['mala'], publishOn: today(), files: [{ id: u1.data.id, name: 'M7測試.pdf', size: b1.length }] } })).json.data.post;
    const rv0 = (await calls(C)).revoke;
    const ed = (await api(C, 'savePost', { atoken: atC, post: Object.assign({}, post1, { files: [] }) })).json;
    await until(() => { const m = FL.readMeta(C.dir, u1.data.id); return m && m.removedAt; });
    await sleep(900);   // 等背景 revoke 做完（假橋接延遲 600ms）
    const m1b = FL.readMeta(C.dir, u1.data.id);
    eq('M7 remove: post saved without the file, revoke sent to Drive', [ed.ok, ed.data.post.files, (await calls(C)).revoke - rv0, (await request(C.port, 'GET', '/__blob?id=' + u1.data.id)).json.data], [true, [], 1, null]);
    eq('M7 remove: local bytes kept (same sha256), meta gets removedAt', [FL.hasBytes(C.dir, u1.data.id), hash('sha256', fs.readFileSync(FL.bytesPath(C.dir, u1.data.id))) === hash('sha256', b1), !!Date.parse(m1b.removedAt), m1b.source], [true, true, true, 'upload']);
    const fl = (await request(C.port, 'POST', '/__files', {})).json.data.find((x) => x.id === u1.data.id);
    eq('M7 /__files (E2E only) shows removed file kept', [fl.bytes, !!fl.meta.removedAt], [true, true]);
    // 移除一個本機從來沒有的附件（例如搬遷前上傳的）→ 建 meta（source:revoke）＝pending，mirror 從 Drive 垃圾桶補抓
    const u4 = (await api(C, 'uploadFile', { atoken: atC, name: '搬遷前.docx', data: Buffer.from('old doc').toString('base64') })).json;
    await until(() => FL.hasBytes(C.dir, u4.data.id));
    fs.unlinkSync(FL.bytesPath(C.dir, u4.data.id)); fs.unlinkSync(FL.metaPath(C.dir, u4.data.id));
    const post4 = (await api(C, 'savePost', { atoken: atC, post: { title: 'M7 搬遷前附件', units: ['mala'], publishOn: today(), files: [{ id: u4.data.id, name: '搬遷前.docx', size: 7 }] } })).json.data.post;
    await api(C, 'savePost', { atoken: atC, post: Object.assign({}, post4, { files: [] }) });
    await until(() => FL.readMeta(C.dir, u4.data.id));
    const m4 = FL.readMeta(C.dir, u4.data.id);
    eq('M7 remove never-local file: meta source revoke with removedAt (pending)', [m4.source, !!m4.removedAt, FL.hasBytes(C.dir, u4.data.id)], ['revoke', true, false]);
    await sleep(700);   // 等背景 revoke 做完（假橋接延遲 600ms）
    await runMirror({ dir: C.dir, bridge: viaC });
    eq('M7 mirror fetches removed file from Drive trash', [FL.hasBytes(C.dir, u4.data.id) && fs.readFileSync(FL.bytesPath(C.dir, u4.data.id)).toString(), FL.readMeta(C.dir, u4.data.id).source, !!FL.readMeta(C.dir, u4.data.id).removedAt], ['old doc', 'revoke', true]);
    // 3. 第二輪 Service 失敗（上傳等 Drive 期間通行碼剛更換）→ Drive 檔被撤、本機 files/ 沒有它
    const before = new Set(fs.readdirSync(fdir)), c0 = await calls(C);
    const pu = api(C, 'uploadFile', { atoken: atC, name: '孤兒.pdf', data: crypto.randomBytes(5000).toString('base64') });
    await sleep(200); await request(C.port, 'POST', '/__adminInit', { pass: '654321' });
    const ru = (await pu).json;
    await sleep(900);
    const c1 = await calls(C);
    eq('M7 second-round failure: AUTH to admin, uploaded Drive file revoked', [ru.ok, ru.code, c1.upload - c0.upload, c1.revoke - c0.revoke], [false, 'AUTH', 1, 1]);
    eq('M7 second-round failure: nothing new in files/', fs.readdirSync(fdir).filter((f) => !before.has(f)), []);
    C.stop(); }

  // ---- 真橋接（async fetch）對本機假 Apps Script：302 轉址、錯誤碼、逾時 ----
  { const { makeBridge } = require('../server/bridge.js');
    let got = null; const hits = {};
    const gas = http.createServer((req, res) => {
      if (req.url === '/exec') { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { got = JSON.parse(b); res.writeHead(302, { Location: '/echo?op=' + got.op }); res.end(); }); return; }
      const op = new URL(req.url, 'http://x').searchParams.get('op');
      if (op === 'slow') return;                                              // 永不回應 → 逾時
      hits[op] = (hits[op] || 0) + 1;
      if (op === 'flaky' && hits[op] === 1 || op === 'html' || op === 'export') { res.writeHead(404, { 'Content-Type': 'text/html' }); return res.end('<html><title>找不到網頁</title></html>'); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(op === 'bad' ? { ok: false, code: 'BAD_REQ', message: '不行' } : op === 'authbad' ? { ok: false, code: 'AUTH', message: '橋接金鑰錯誤' }
        : { ok: true, data: { op, method: req.method } }));
    });
    await new Promise((ok) => gas.listen(0, '127.0.0.1', ok));
    const br = makeBridge('http://127.0.0.1:' + gas.address().port + '/exec', 'k');
    const r = await br.call('quota', { x: 1 });
    eq('real bridge follows 302 (POST→GET like curl -L)', [r, got.key, got.x], [{ op: 'quota', method: 'GET' }, 'k', 1]);
    let e1 = null; try { await br.call('bad'); } catch (e) { e1 = [e.code, e.message, !!e.business]; }
    eq('real bridge business error kept (BAD_REQ)', e1, ['BAD_REQ', '不行', true]);
    let e1b = null; try { await br.call('authbad'); } catch (e) { e1b = [e.code, e.message, /AUTH 橋接金鑰錯誤/.test(e.detail)]; }
    eq('real bridge AUTH mapped to BRIDGE (detail kept for log)', e1b, ['BRIDGE', 'Google 雲端暫時連不上，請稍後再試', true]);
    const t0 = Date.now(); let e2 = null; try { await br.call('slow', {}, 0.3); } catch (e) { e2 = e.code; }
    eq('real bridge timeout via AbortSignal', [e2, Date.now() - t0 < 2000], ['BRIDGE_TIMEOUT', true]);
    const rf = await br.call('flaky');
    eq('real bridge retries once when Google returns a non-JSON 404 page', [rf.op, hits.flaky], ['flaky', 2]);
    let eh = null; try { await br.call('html'); } catch (e) { eh = [e.code, /不是 JSON/.test(e.detail)]; }
    eq('real bridge gives up after one retry (2 attempts, BRIDGE)', [eh, hits.html], [['BRIDGE', true], 2]);
    let ex = null; try { await br.call('export'); } catch (e) { ex = e.code; }
    eq('real bridge never retries export (EXPORT_ONCE)', [ex, hits.export], ['BRIDGE', 1]);
    let e3 = null; try { await makeBridge('', '').call('quota'); } catch (e) { e3 = e.code; }
    eq('real bridge missing config', e3, 'BRIDGE');
    gas.closeAllConnections(); gas.close(); }

  // ---- store 單元：交易中 store 動作失敗 → ROLLBACK，丟給 Service 的錯誤沒有 code ----
  { const { makeSqliteStore } = require('../server/store-sqlite.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dzyb-st-')); tmps.push(dir);
    const st = makeSqliteStore(dir); let seen = 'none';   // id 給物件 → node:sqlite 丟帶 code 的 ERR_INVALID_ARG_TYPE
    const origErr = console.error; console.error = () => {};
    let txErr = null;   // 模擬 Service 自己吞掉 store 錯誤、回 ok:true：tx 仍要 ROLLBACK 並丟出例外（index.js 轉成 SERVER）
    try { st.tx(() => { st.savePost({ id: 'P-X', title: 'x' }); try { st.savePost({ id: { bad: 1 }, title: 'z' }); } catch (e) { seen = [e.code, e.message]; } return { ok: true }; }); }
    catch (e) { txErr = e.message; }
    console.error = origErr;
    eq('store error has no code', seen, [undefined, '資料層錯誤']);
    eq('tx with swallowed store error throws (never ok:true)', /ROLLBACK/.test(txErr || ''), true);
    eq('tx rolled back after store error', st.getPosts().length, 0);
    st.kvSet('req:bad5', '{exp: 99999999999999, v: 1}'); st.kvSet('req:garbage', 'not json at all');
    eq('purgeReqs clears malformed req rows instead of failing', [st.purgeReqs(Date.now()), st.kvGet('req:bad5'), st.kvGet('req:garbage')], [2, null, null]);
    st.kvSet('req:bad6', '{exp: 99999999999999, v: 1}');
    eq('getReq treats malformed row as missing and deletes it', [st.getReq('bad6'), st.kvGet('req:bad6')], [null, null]);
    st.tx(() => { st.savePost({ id: 'P-Y', title: 'y' }); return 1; });
    eq('next tx commits normally', st.getPosts().map((p) => p.id), ['P-Y']);
    st.close(); }

  // ---- store 單元：req:* 過期清除 ----
  { const { makeSqliteStore } = require('../server/store-sqlite.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dzyb-st-')); tmps.push(dir);
    const st = makeSqliteStore(dir);
    st.kvSet('req:old', JSON.stringify({ v: 'x', exp: Date.now() - 1000 }));
    st.putReq('new', 'y');
    eq('purgeReqs removes only expired', [st.purgeReqs(Date.now()), st.kvGet('req:old'), st.getReq('new')], [1, null, 'y']);
    st.close(); }
}

main().catch((e) => { fail++; console.error(e); }).finally(() => {
  procs.forEach((p) => { try { p.kill(); } catch (e) {} });
  tmps.forEach((d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} });
  console.log(`server: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
