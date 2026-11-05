// node test/announce.test.js — #28：新公告上架經光復小幫手直接推播（server/announce.js）。
// A 段在程序內用 makeAnnouncer（帶假的 now）驗規則；B 段以子程序跑真伺服器（server/index.js）驗計時器、/health、未設定與 E2E 不啟動。
// 小幫手用本機假 HTTP 伺服器模擬 push_text（自己找空埠、只關自己開的）；子程序一律帶 DZYB_NO_DOTENV=1，不讀真的 server/.env、不連任何外部網址。
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeSqliteStore } = require('../server/store-sqlite.js');
const A = require('../server/announce.js');
const { judgeHealth } = require('../server/health-rules.js');
const L = require('../js/logic.js');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; console.log('✗', name, '\n   got ', g, '\n   want', w); }
}
const tmps = [];
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p || 'dzyb-ann-')); tmps.push(d); return d; };
const TPE = (s) => new Date(s + '+08:00');
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

// 假小幫手：mode＝'push'｜'fallback'｜'dup'｜'pushFail'（ok:false mode push）｜'drop'（每次斷線）｜'notJson'｜'badToken'
//   ｜'legacy'（舊版小幫手：不認得 push_text，回裸的 {ok:true}）｜'noEcho'（有 mode 沒 action 回聲）｜'badMode'（mode 不認得）｜'busy'
//   delayMs＞0：每個回應延遲（測第一輪還沒跑完的 /health）
// 模擬 GAS 的 label 永久判重：同一 label 第二次回 dup；成功回應都帶 action:'push_text'
function fakeHelper() {
  const h = { mode: 'push', bodies: [], hits: 0, seen: new Set(), delayMs: 0 };
  h.server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      h.hits++;
      if (h.mode === 'drop') { req.socket.destroy(); return; }
      let j = {}; try { j = JSON.parse(b); } catch (e) {}
      h.bodies.push(j);
      res.setHeader('Content-Type', 'application/json');
      const end = res.end.bind(res);
      res.end = (x) => (h.delayMs ? setTimeout(() => end(x), h.delayMs) : end(x));
      const E = (o) => JSON.stringify(Object.assign({ action: 'push_text' }, o));
      if (h.mode === 'legacy') return res.end(JSON.stringify({ ok: true }));
      if (h.mode === 'noEcho') return res.end(JSON.stringify({ ok: true, mode: 'push', sent: 1 }));
      if (h.mode === 'badMode') return res.end(E({ ok: true, mode: 'weird' }));
      if (h.mode === 'busy') return res.end(E({ ok: false, error: 'busy' }));
      if (h.mode === 'notJson') return res.end('<html>找不到網頁</html>');
      if (j.action !== 'push_text' || j.token !== 'T-test' || h.mode === 'badToken') return res.end(JSON.stringify({ ok: false, error: 'bad token' }));
      if (h.mode === 'pushFail') return res.end(E({ ok: false, mode: 'push', fail: 1 }));
      if (h.seen.has(j.label)) return res.end(E({ ok: true, mode: 'dup' }));
      h.seen.add(j.label);
      if (h.mode === 'fallback') return res.end(E({ ok: true, mode: 'fallback', queued: 1 }));
      if (h.mode === 'dup') return res.end(E({ ok: true, mode: 'dup' }));
      res.end(E({ ok: true, mode: 'push', sent: 1 }));
    });
  });
  return new Promise((ok) => h.server.listen(0, '127.0.0.1', () => { h.url = 'http://127.0.0.1:' + h.server.address().port + '/exec'; ok(h); }));
}
const labels = (h) => h.bodies.map((b) => b.label);
const P = (id, o) => Object.assign({ id, title: '公告' + id, units: ['mala'], published: true, publishOn: '2026-10-01', expiresOn: '', offOn: '', files: [] }, o);

function newStore(posts) {
  const dir = tmp();
  const st = makeSqliteStore(dir);
  st.load({ posts: posts || [], staff: [], reads: [], log: [] });
  return { dir, st };
}
function ann(s, h, nowStr, extra) {
  let now = TPE(nowStr);
  const a = A.makeAnnouncer(Object.assign({ store: s.st, dir: s.dir, url: h.url, token: 'T-test', retryMs: 0, now: () => now, log: () => {} }, extra || {}));
  a.setNow = (x) => { now = TPE(x); };
  return a;
}
const putPost = (s, p) => s.st.savePost(p);
const kv = (s, k) => JSON.parse(s.st.kvGet(k) || 'null');

function freePort() {
  return new Promise((ok, no) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); s.on('error', no); });
}
// 起真伺服器（子程序）；回 { port, out(), stop() }，只關自己開的 PID
async function startServer(env) {
  const port = await freePort();
  const e = Object.assign({ PATH: process.env.PATH, DZYB_NO_DOTENV: '1', HOME: tmp('dzyb-home-'), PORT: String(port), ANNOUNCE_RETRY_MS: '0' }, env);
  const p = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], { env: e, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (c) => { out += c; }); p.stderr.on('data', (c) => { out += c; });
  for (let i = 0; i < 100 && !/啟動：127\.0\.0\.1/.test(out); i++) await sleep(50);
  return { port, out: () => out, stop: () => new Promise((ok) => { if (p.exitCode !== null) return ok(); p.on('exit', ok); p.kill('SIGTERM'); }) };
}
async function getJson(port, p) { const r = await fetch('http://127.0.0.1:' + port + p); return r.json(); }

async function main() {
  const h = await fakeHelper();
  try {
    // ---- A1 訊息格式、標題 200 字（以碼點計）----
    eq('A1 訊息格式', A.buildText('  十月排班  '), '📢 佈告欄新公告\n《十月排班》\n請到管理系統公告專區 https://dzy.mozhuting.com/#/bulletin 閱讀並簽名');
    const long = '😀'.repeat(250);
    eq('A1 標題全 emoji：受 330 個 UTF-16 單位限制（165 個 emoji、不切半）', Array.from(A.buildText(long).split('\n')[1]).length, 167);
    eq('A1 標題中文：截 200 個字', Array.from(A.buildText('字'.repeat(250)).split('\n')[1]).length, 202);
    // 小幫手 GAS 的嚴格格式（與 ~/mala-gas/line-oa-scheduler/程式碼.js 的 PUSH_TEXT_RE／PUSH_TITLE_BAD 相同；第 2 輪審查 R1）
    const GAS_RE = /^📢 佈告欄新公告\n《([^\r\n]*)》\n請到(?: https:\/\/dzy-bulletin\.github\.io|管理系統公告專區 https:\/\/dzy\.mozhuting\.com\/#\/bulletin) 閱讀並簽名$/, GAS_BAD = /http|:\/\/|www\./i;
    const gasOk = (t) => { const m = GAS_RE.exec(t); return !!m && !GAS_BAD.test(m[1]) && t.length <= 400; };
    const nasty = ['第一行\n第二行', 'a\r\nb\u2028c', '點 https://evil.example/login 領獎', '到 dzy-bulletin.github.io.evil.example', 'HTTP://X.COM',
      'www.evil.example', 'ftp://x', 'hTTps', '《書名號》與 emoji 😀', '😀'.repeat(250), '字'.repeat(250), '', '   '];
    eq('A1 各種標題清理後都符合小幫手格式', nasty.filter((t) => !gasOk(A.buildText(t))), []);
    eq('A1 換行改空白、網址改全形', A.buildText('a\nb https://x.y www.z').split('\n')[1], '《a b ｈｔｔｐｓ：／／x.y ｗｗｗ．z》');
    eq('A1 一般標題不變', A.buildText('十月排班 10/1 起'), '📢 佈告欄新公告\n《十月排班 10/1 起》\n請到管理系統公告專區 https://dzy.mozhuting.com/#/bulletin 閱讀並簽名');
    eq('A1 常數：每小時、3 次', [A.ANNOUNCE_EVERY_MS, A.MAX_FAILS], [3600000, 3]);

    // ---- A2 首次啟用：現有公告（排定未來的除外）標記已通知、不補推；印出那一行 ----
    {
      const s = newStore([P('OLD-1'), P('OLD-2', { units: ['mzt'] }), P('OLD-OFF', { published: false, offOn: '2026-09-30' }), P('FUT', { publishOn: '2026-10-05' })]);
      h.bodies = []; const logs = [];
      const a = ann(s, h, '2026-10-02T09:00', { log: (m) => logs.push(m) });
      const r = await a.run();
      eq('A2 首次啟用不推舊公告', [h.bodies.length, r.ok, r.pending], [0, true, 0]);
      eq('A2 標記：上架中、別單位、已下架都標；排定未來的不標', Object.keys(kv(s, A.KV_DONE)).sort(), ['OLD-1', 'OLD-2', 'OLD-OFF']);
      eq('A2 mode=init', kv(s, A.KV_DONE)['OLD-1'].mode, 'init');
      eq('A2 印出首次啟用那一行', logs.filter((m) => m === '首次啟用：已將 3 則現有公告標記為已通知').length, 1);
      eq('A2 announce.log 也有那一行', /首次啟用：已將 3 則現有公告標記為已通知/.test(fs.readFileSync(path.join(s.dir, 'logs', 'announce.log'), 'utf8')), true);
      // 第二輪不再「首次啟用」
      logs.length = 0; await a.run();
      eq('A2 第二輪不再首次啟用', logs.some((m) => /首次啟用/.test(m)), false);
      // 舊公告下架後重新上架：不推
      putPost(s, P('OLD-OFF', { published: true, offOn: '' }));
      await a.run();
      eq('A2 舊公告重新上架不推', h.bodies.length, 0);
      // ---- A3 排定未來上架的，到上架日才推 ----
      a.setNow('2026-10-04T23:59'); await a.run();
      eq('A3 上架日前一天不推', h.bodies.length, 0);
      a.setNow('2026-10-05T00:10'); await a.run();
      eq('A3 上架日當天推', labels(h), ['佈告欄新公告:FUT']);
      eq('A3 送出內容', [h.bodies[0].action, h.bodies[0].token, h.bodies[0].text], ['push_text', 'T-test', A.buildText('公告FUT')]);
      s.st.close();
    }

    // ---- A4 只推 mustSign('mala') 為真的；只推一次；編輯不重推；下架再上架不重推 ----
    {
      const s = newStore([]);
      h.bodies = []; h.seen.clear(); h.mode = 'push';
      const a = ann(s, h, '2026-10-02T09:00');
      await a.run();                                         // 空庫首次啟用：0 則
      eq('A4 空庫首次啟用', kv(s, A.KV_DONE), {});
      putPost(s, P('N-MALA'));
      putPost(s, P('N-ALL', { units: L.UNIT_IDS ? L.UNIT_IDS.slice() : ['mzt', 'mala', 'cf'] }));
      putPost(s, P('N-MZT', { units: ['mzt'] }));
      putPost(s, P('N-CF', { units: ['cf'] }));
      putPost(s, P('N-EXP', { publishOn: '2026-09-01', expiresOn: '2026-09-30' }));
      putPost(s, P('N-OFF', { published: false, offOn: '2026-10-02' }));
      const r = await a.run();
      eq('A4 只推小辛辣與全部', labels(h).sort(), ['佈告欄新公告:N-ALL', '佈告欄新公告:N-MALA']);
      eq('A4 結果', [r.ok, r.sent, r.pending], [true, 2, 0]);
      eq('A4 mode 記下來', kv(s, A.KV_DONE)['N-MALA'].mode, 'push');
      h.bodies = [];
      putPost(s, P('N-MALA', { title: '改過標題' }));          // 編輯（同 id）
      await a.run();
      eq('A4 編輯後不重推', h.bodies.length, 0);
      putPost(s, P('N-MALA', { published: false, offOn: '2026-10-02' })); await a.run();
      putPost(s, P('N-MALA', { published: true, offOn: '' })); await a.run();
      eq('A4 下架再上架不重推', h.bodies.length, 0);
      // 之後新的別單位公告改成含小辛辣（編輯單位）→ 還沒通知過，推一次
      putPost(s, P('N-MZT', { units: ['mzt', 'mala'] })); await a.run();
      eq('A4 編輯成含小辛辣的未通知公告會推', labels(h), ['佈告欄新公告:N-MZT']);
      s.st.close();
    }

    // ---- A5 假小幫手各種 mode：fallback／dup 都算已通知 ----
    for (const mode of ['fallback', 'dup']) {
      const s = newStore([]);
      h.bodies = []; h.seen.clear(); h.mode = mode;
      const a = ann(s, h, '2026-10-02T09:00');
      await a.run(); putPost(s, P('M-1'));
      const r = await a.run();
      eq('A5 ' + mode + ' 算成功、記 mode', [r.ok, r.sent, kv(s, A.KV_DONE)['M-1'].mode], [true, 1, mode]);
      h.bodies = []; await a.run();
      eq('A5 ' + mode + ' 之後不再送', h.bodies.length, 0);
      s.st.close();
    }

    // ---- A6 失敗重試與 3 次上限（ok:false／斷線／不是 JSON／token 錯）----
    for (const mode of ['pushFail', 'drop', 'notJson', 'badToken', 'legacy', 'noEcho', 'badMode', 'busy']) {
      const s = newStore([]);
      h.bodies = []; h.hits = 0; h.seen.clear(); h.mode = 'push';
      const a = ann(s, h, '2026-10-02T09:00');
      await a.run(); putPost(s, P('F-1'));
      h.mode = mode;
      const r1 = await a.run();
      eq('A6 ' + mode + ' 第 1 次失敗：不標記、pending=1、ok=false', [r1.ok, r1.pending, r1.failed, !!kv(s, A.KV_DONE)['F-1'], kv(s, A.KV_FAILS)['F-1'].n], [false, 1, 1, false, 1]);
      const retryHits = mode === 'drop' || mode === 'notJson' ? 2 : 1;   // 網路類錯誤當輪重試一次
      eq('A6 ' + mode + ' 當輪打幾次', h.hits, retryHits);
      eq('A6 ' + mode + ' /health 欄位', a.health(), { at: r1.at, ok: false, pending: 1, gaveup: 0 });
      a.setNow('2026-10-02T10:00');
      const r2 = await a.run();
      eq('A6 ' + mode + ' 第 2 次', [r2.ok, r2.pending, kv(s, A.KV_FAILS)['F-1'].n], [false, 1, 2]);
      a.setNow('2026-10-02T11:00');
      const r3 = await a.run();
      eq('A6 ' + mode + ' 第 3 次放棄：標 gaveup、pending=0', [r3.ok, r3.pending, r3.gaveUp, kv(s, A.KV_DONE)['F-1'].mode, kv(s, A.KV_FAILS)['F-1']], [false, 0, 1, 'gaveup', undefined]);
      const hits = h.hits; h.mode = 'push';
      a.setNow('2026-10-02T12:00');
      const r4 = await a.run();
      eq('A6 ' + mode + ' 放棄後不再重試', [h.hits - hits, r4.ok, r4.pending], [0, true, 0]);
      eq('A6 ' + mode + ' 放棄後 /health gaveup=1（持續）', a.health().gaveup, 1);
      eq('A6 ' + mode + ' 結果檔不含 token', /T-test/.test(fs.readFileSync(path.join(s.dir, 'logs', 'announce-last.json'), 'utf8') + fs.readFileSync(path.join(s.dir, 'logs', 'announce.log'), 'utf8')), false);
      s.st.close();
    }

    // ---- A6b 舊版小幫手（裸 {ok:true}）不會記成已推（#29 B1）；部署新版後下一輪推出 ----
    {
      const s = newStore([]);
      h.bodies = []; h.seen.clear(); h.mode = 'push';
      const a = ann(s, h, '2026-10-02T09:00');
      await a.run(); putPost(s, P('LEG-1'));
      h.mode = 'legacy'; const r = await a.run();
      eq('A6b 舊版 {ok:true} → 失敗、不標記', [r.ok, r.sent, r.failed, !!kv(s, A.KV_DONE)['LEG-1']], [false, 0, 1, false]);
      eq('A6b log 寫原因', /小幫手回應不符/.test(fs.readFileSync(path.join(s.dir, 'logs', 'announce.log'), 'utf8')), true);
      h.mode = 'push'; a.setNow('2026-10-02T10:00'); const r2 = await a.run();
      eq('A6b 部署新版後推出', [r2.ok, r2.sent, kv(s, A.KV_DONE)['LEG-1'].mode], [true, 1, 'push']);
      eq('A6b accepted()', [A.accepted({ ok: true }), A.accepted({ ok: true, mode: 'push' }), A.accepted({ ok: true, action: 'push_text', mode: 'x' }),
        A.accepted({ ok: false, action: 'push_text', mode: 'push' }), A.accepted({ ok: true, action: 'push_text', mode: 'fallback' })], [false, false, false, false, true]);
      s.st.close();
    }

    // ---- A6c 失敗次數用時間判斷：距上次不到 50 分鐘不累加（#29 S2）----
    {
      const s = newStore([]);
      h.bodies = []; h.seen.clear(); h.mode = 'push';
      const a = ann(s, h, '2026-10-02T09:00');
      await a.run(); putPost(s, P('GAP-1'));
      h.mode = 'pushFail';
      for (const t of ['09:00', '09:05', '09:10', '09:20', '09:49']) { a.setNow('2026-10-02T' + t); await a.run(); }
      eq('A6c 49 分鐘內 5 次失敗只算 1 次、沒放棄', [kv(s, A.KV_FAILS)['GAP-1'].n, !!kv(s, A.KV_DONE)['GAP-1']], [1, false]);
      a.setNow('2026-10-02T09:50'); await a.run();
      eq('A6c 滿 50 分鐘才算第 2 次', kv(s, A.KV_FAILS)['GAP-1'].n, 2);
      a.setNow('2026-10-02T10:30'); await a.run();
      eq('A6c 從第 2 次算起不到 50 分鐘不累加', kv(s, A.KV_FAILS)['GAP-1'].n, 2);
      a.setNow('2026-10-02T10:40'); await a.run();
      eq('A6c 第 3 次（距第 2 次 50 分）→ 放棄', kv(s, A.KV_DONE)['GAP-1'].mode, 'gaveup');
      // 舊格式（純數字）讀得懂
      s.st.kvSet(A.KV_FAILS, JSON.stringify({ OLD: 2 })); putPost(s, P('OLD')); 
      a.setNow('2026-10-02T10:41'); await a.run();
      eq('A6c 舊格式數字 2 → 第 3 次放棄', kv(s, A.KV_DONE)['OLD'].mode, 'gaveup');
      s.st.close();
    }

    // ---- A6d --retry／--retry-all 補推（#29 S1）----
    {
      const s = newStore([]);
      h.bodies = []; h.seen.clear(); h.mode = 'push';
      const a = ann(s, h, '2026-10-02T09:00');
      await a.run(); putPost(s, P('G-1')); putPost(s, P('G-2')); putPost(s, P('G-3'));
      h.mode = 'pushFail';
      for (const t of ['09:00', '10:00', '11:00']) { a.setNow('2026-10-02T' + t); await a.run(); }
      eq('A6d 三則都放棄、gaveup=3', a.health().gaveup, 3);
      putPost(s, P('G-4')); a.setNow('2026-10-02T12:00'); await a.run();   // G-4 失敗中（1 次）
      // 子程序跑 --retry G-1（伺服器開著也行：只動 kv）
      const cli = (args) => new Promise((ok) => {
        const p = spawn(process.execPath, [path.join(ROOT, 'server', 'announce.js')].concat(args), { env: { PATH: process.env.PATH, DZYB_NO_DOTENV: '1', DATA_DIR: s.dir }, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = ''; p.stdout.on('data', (c) => { out += c; }); p.stderr.on('data', (c) => { out += c; }); p.on('exit', (code) => ok({ code, out }));
      });
      const c1 = await cli(['--retry', 'G-1']);
      eq('A6d --retry G-1', [c1.code, /G-1：已清除/.test(c1.out), a.health().gaveup], [0, true, 2]);
      const c0 = await cli([]);
      eq('A6d 沒給參數 → 印用法 exit 2', [c0.code, /用法/.test(c0.out)], [2, true]);
      const cDone = await cli(['--retry', 'NOPE']);
      eq('A6d 沒紀錄的 id', [cDone.code, /沒有放棄或失敗紀錄/.test(cDone.out)], [0, true]);
      h.mode = 'push'; h.bodies = []; a.setNow('2026-10-02T13:00'); await a.run();
      eq('A6d 下一輪只重推 G-1 與失敗中的 G-4', labels(h).sort(), ['佈告欄新公告:G-1', '佈告欄新公告:G-4']);
      const cOk = await cli(['--retry', 'G-1']);
      eq('A6d 已通知的不動', /已通知過（push），不動/.test(cOk.out), true);
      const cAll = await cli(['--retry-all']);
      eq('A6d --retry-all 清掉剩下兩則', [cAll.code, (cAll.out.match(/已清除/g) || []).length, a.health().gaveup], [0, 2, 0]);
      h.bodies = []; a.setNow('2026-10-02T14:00'); await a.run();
      eq('A6d 下一輪推出 G-2、G-3', labels(h).sort(), ['佈告欄新公告:G-2', '佈告欄新公告:G-3']);
      eq('A6d announce.log 記手動補推', /手動補推：G-1：已清除/.test(fs.readFileSync(path.join(s.dir, 'logs', 'announce.log'), 'utf8')), true);
      // --skip：確認不推（標 skip、清黃燈、之後不推）
      putPost(s, P('SK-1')); h.mode = 'pushFail';
      for (const t of ['15:00', '16:00', '17:00']) { a.setNow('2026-10-02T' + t); await a.run(); }
      eq('A6d SK-1 放棄 → gaveup=1', a.health().gaveup, 1);
      const cSk = await cli(['--skip', 'SK-1']);
      eq('A6d --skip SK-1', [cSk.code, /SK-1：已標記為不推/.test(cSk.out), a.health().gaveup, kv(s, A.KV_DONE)['SK-1'].mode], [0, true, 0, 'skip']);
      putPost(s, P('SK-2')); h.mode = 'pushFail'; a.setNow('2026-10-02T18:00'); await a.run();
      const cSk2 = await cli(['--skip', 'SK-2']);
      eq('A6d --skip 失敗中的：清掉失敗計數', [/已標記為不推/.test(cSk2.out), kv(s, A.KV_FAILS)['SK-2'], kv(s, A.KV_DONE)['SK-2'].mode], [true, undefined, 'skip']);
      h.mode = 'push'; h.bodies = []; a.setNow('2026-10-02T19:00'); await a.run();
      eq('A6d skip 的之後不推', labels(h), []);
      const cSk3 = await cli(['--skip', 'G-1']);
      eq('A6d --skip 已推過的不動', [/已通知過（push），不動/.test(cSk3.out), kv(s, A.KV_DONE)['G-1'].mode], [true, 'push']);
      const cBoth = await cli(['--skip', 'X', '--retry', 'Y']);
      eq('A6d 同時給兩種 → 用法 exit 2', cBoth.code, 2);
      eq('A6d announce.log 記手動不推', /手動不推：SK-1：已標記為不推/.test(fs.readFileSync(path.join(s.dir, 'logs', 'announce.log'), 'utf8')), true);
      // 交易：伺服器正卡在 await（假小幫手延遲）時跑 --skip，伺服器寫回後 skip 不被蓋掉
      putPost(s, P('TX-1')); putPost(s, P('TX-2')); h.mode = 'push'; h.delayMs = 400; h.bodies = [];
      a.setNow('2026-10-02T20:00');
      const round = a.run();
      for (let k = 0; k < 40 && h.hits === 0; k++) await sleep(10);
      await sleep(50);
      const first = String(h.bodies[0] && h.bodies[0].label || '').replace(A.LABEL_PREFIX, ''), other = first === 'TX-1' ? 'TX-2' : 'TX-1';
      const cTx = await cli(['--skip', other]);              // 第一則還卡在 await 時，標掉第二則
      await round; h.delayMs = 0;
      eq('A6d 伺服器輪次中 --skip：第一則寫回 push、第二則仍是 skip 且沒推', [/已標記為不推/.test(cTx.out), (kv(s, A.KV_DONE)[first] || {}).mode, (kv(s, A.KV_DONE)[other] || {}).mode, labels(h)],
        [true, 'push', 'skip', [A.LABEL_PREFIX + first]]);
      s.st.close();
    }

    // ---- A7 失敗一次後恢復：成功、清掉失敗計數 ----
    {
      const s = newStore([]);
      h.bodies = []; h.seen.clear(); h.mode = 'push';
      const a = ann(s, h, '2026-10-02T09:00');
      await a.run(); putPost(s, P('R-1'));
      h.mode = 'pushFail'; await a.run();
      h.mode = 'push'; const r = await a.run();
      eq('A7 恢復後成功、清掉失敗計數', [r.ok, r.sent, kv(s, A.KV_DONE)['R-1'].mode, kv(s, A.KV_FAILS)['R-1']], [true, 1, 'push', undefined]);
      s.st.close();
    }

    // ---- A8 同時呼叫兩次 run 只跑一輪（不重複送）----
    {
      const s = newStore([]);
      h.bodies = []; h.seen.clear(); h.mode = 'push';
      const a = ann(s, h, '2026-10-02T09:00');
      await a.run(); putPost(s, P('C-1'));
      await Promise.all([a.run(), a.run()]);
      eq('A8 併發只送一次', h.bodies.length, 1);
      s.st.close();
    }

    // ---- A9 未設定不啟動；E2E 不啟動 ----
    {
      const s = newStore([]);
      const o = console.log; const said = []; console.log = (m) => said.push(String(m));
      let r1, r2, r3;
      try {
        r1 = A.startAnnouncer({ store: s.st, dir: s.dir, url: '', token: 'T-test' });
        r2 = A.startAnnouncer({ store: s.st, dir: s.dir, url: h.url, token: '' });
        r3 = A.startAnnouncer({ store: s.st, dir: s.dir, url: h.url, token: 'T-test', e2e: true });
      } finally { console.log = o; }
      eq('A9 未設定／E2E 都不啟動', [r1, r2, r3], [null, null, null]);
      eq('A9 未設定印一行說明', said.filter((m) => /未設定 REMIND_ENQUEUE_URL／TOKEN，不啟動/.test(m)).length, 2);
      eq('A9 沒寫 kv', s.st.kvGet(A.KV_DONE), null);
      s.st.close();
    }

    // ---- A10 燈號：announce null／ok=null／ok=true 不影響，ok=false → 黃「新公告通知失敗」----
    {
      const now = Date.parse('2026-10-02T02:00:00Z'), ago = (hr) => new Date(now - hr * 3600e3).toISOString();
      const base = { mirror: { at: ago(1), ok: true, fails: 0 }, backup: { at: ago(1), ok: true }, disk: { freeMB: 50000 } };
      const lv = (an) => judgeHealth(Object.assign({}, base, { announce: an }), now);
      eq('A10 燈號', [lv(null).level, lv({ at: null, ok: null, pending: null }).level, lv({ at: ago(1), ok: true, pending: 0 }).level, lv({ at: ago(1), ok: false, pending: 1 })],
        ['green', 'green', 'green', { level: 'yellow', why: ['新公告通知失敗'] }]);
      eq('A10 gaveup>0 持續黃（就算這輪 ok）', [lv({ at: ago(1), ok: true, pending: 0, gaveup: 1 }), lv({ at: ago(1), ok: true, pending: 0, gaveup: 0 }).level],
        [{ level: 'yellow', why: ['有新公告通知已放棄'] }, 'green']);
    }

    // ---- B 真伺服器（子程序）----
    {
      // B0 啟動時先跑一次（間隔設 10 分鐘：啟動後幾秒內就有結果＝不是等計時器）
      {
        const dir0 = tmp('dzyb-ann-data-');
        const sv0 = await startServer({ DATA_DIR: dir0, REMIND_ENQUEUE_URL: h.url, REMIND_ENQUEUE_TOKEN: 'T-test', ANNOUNCE_EVERY_MS: '600000' });
        try {
          let hh = null;
          for (let i = 0; i < 60; i++) { hh = await getJson(sv0.port, '/health'); if (hh.announce && hh.announce.at) break; await sleep(50); }
          eq('B0 啟動即跑第一輪、log 寫間隔', [!!(hh.announce && hh.announce.at), /已啟動（每 10 分鐘一次）/.test(sv0.out())], [true, true]);
        } finally { await sv0.stop(); }
      }
      // B0b 第一輪還沒跑完時 /health 的 announce 是四欄 null（和「沒啟用」的 null 分得開；#29 建議 1）
      {
        const dirB = tmp('dzyb-ann-data-');
        const stB = makeSqliteStore(dirB);
        stB.load({ posts: [P('SLOW-1', { publishOn: L.today() })], staff: [], reads: [], log: [] });
        stB.kvSet(A.KV_DONE, '{}');                            // 已啟用過 → 第一輪會真的去打小幫手
        stB.close();
        h.bodies = []; h.seen.clear(); h.mode = 'push'; h.delayMs = 1500;
        const svB = await startServer({ DATA_DIR: dirB, REMIND_ENQUEUE_URL: h.url, REMIND_ENQUEUE_TOKEN: 'T-test', ANNOUNCE_EVERY_MS: '600000' });
        try {
          for (let i = 0; i < 40 && h.hits === 0 && h.bodies.length === 0; i++) await sleep(25);
          const hh = await getJson(svB.port, '/health');
          eq('B0b 第一輪進行中：announce 四欄 null', hh.announce, { at: null, ok: null, pending: null, gaveup: null });
        } finally { await svB.stop(); h.delayMs = 0; }
      }
      // B1 設定了：啟動先跑一次（首次啟用，不推舊公告），之後依 ANNOUNCE_EVERY_MS 再跑；新公告會推；/health 有 announce
      const dir = tmp('dzyb-ann-data-');
      const st = makeSqliteStore(dir);
      st.load({ posts: [P('OLD-1', { publishOn: L.today() })], staff: [], reads: [], log: [] });
      st.close();
      h.bodies = []; h.seen.clear(); h.mode = 'push';
      const sv = await startServer({ DATA_DIR: dir, REMIND_ENQUEUE_URL: h.url, REMIND_ENQUEUE_TOKEN: 'T-test', ANNOUNCE_EVERY_MS: '400' });
      try {
        let hh = null;
        for (let i = 0; i < 60; i++) { hh = await getJson(sv.port, '/health'); if (hh.announce && hh.announce.at) break; await sleep(50); }
        eq('B1 啟動即跑一次、/health 有 announce', [!!hh.announce.at, hh.announce.ok, hh.announce.pending, hh.why.includes('新公告通知失敗')], [true, true, 0, false]);
        eq('B1 伺服器 log 有首次啟用那一行', /首次啟用：已將 1 則現有公告標記為已通知/.test(sv.out()), true);
        eq('B1 舊公告沒推', h.bodies.length, 0);
        // 在伺服器開著時從另一個連線加一則新公告（模擬主管上架）
        const st2 = makeSqliteStore(dir); st2.savePost(P('NEW-1', { publishOn: L.today() })); st2.close();
        for (let i = 0; i < 60 && h.bodies.length === 0; i++) await sleep(50);
        eq('B1 下一輪推新公告', labels(h), ['佈告欄新公告:NEW-1']);
        await sleep(1000);
        eq('B1 之後幾輪不重推', h.bodies.length, 1);
        // 小幫手壞掉 → /health 黃燈「新公告通知失敗」
        h.mode = 'pushFail';
        const st3 = makeSqliteStore(dir); st3.savePost(P('NEW-2', { publishOn: L.today() })); st3.close();
        for (let i = 0; i < 60; i++) { hh = await getJson(sv.port, '/health'); if (hh.announce.ok === false) break; await sleep(50); }
        eq('B1 失敗 → announce.ok=false、why 含新公告通知失敗', [hh.announce.ok, hh.why.includes('新公告通知失敗')], [false, true]);
        eq('B1 /health 不帶 token', JSON.stringify(hh).includes('T-test'), false);
      } finally { await sv.stop(); h.mode = 'push'; }

      // B2 沒設定 .env 兩個鍵：不啟動、印一行、/health announce=null、不打小幫手
      const dir2 = tmp('dzyb-ann-data-');
      h.hits = 0;
      const sv2 = await startServer({ DATA_DIR: dir2 });
      try {
        const hh = await getJson(sv2.port, '/health');
        eq('B2 未設定：announce=null、印說明、沒打小幫手', [hh.announce, /新公告通知：未設定 REMIND_ENQUEUE_URL／TOKEN，不啟動/.test(sv2.out()), h.hits], [null, true, 0]);
      } finally { await sv2.stop(); }

      // B3 E2E 模式：就算設了兩個鍵也不啟動
      const dir3 = tmp('dzyb-ann-e2e-');
      const sv3 = await startServer({ DATA_DIR: dir3, E2E: '1', REMIND_ENQUEUE_URL: h.url, REMIND_ENQUEUE_TOKEN: 'T-test', ANNOUNCE_EVERY_MS: '200' });
      try {
        await sleep(500);
        const hh = await getJson(sv3.port, '/health');
        eq('B3 E2E 不啟動', [hh.e2e, hh.announce, h.hits], [true, null, 0]);
      } finally { await sv3.stop(); }
    }
  } finally {
    h.server.close();
    tmps.forEach((d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} });
  }
  console.log(`announce: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
