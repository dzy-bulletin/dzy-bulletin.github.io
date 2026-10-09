// node test/jobs.test.js — M3（#8）：每小時鏡像與簽名回填（server/mirror.js）、每日快照（server/daily.js）、還原（server/restore.js）、/health 判定。
// A～C 段在程序內用假橋接物件（算呼叫次數）；D 段端到端：假 Google 載入 gas/*.js（test/fake-gas.js）＋真的 E2E 伺服器（子程序）
// ＋以子程序跑 mirror.js／daily.js／restore.js，經 server/bridge.js 真的打過去。自己找空埠、自己建暫存資料夾、只關自己開的程序；不連任何外部網址。
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { DatabaseSync } = require('node:sqlite');
const { makeSqliteStore } = require('../server/store-sqlite.js');
const { runMirror, runFilesOnly } = require('../server/mirror.js');
const FL = require('../server/files-local.js');
const crypto = require('crypto');
const { runDaily } = require('../server/daily.js');
const { restore } = require('../server/restore.js');
const { judgeHealth } = require('../server/health-rules.js');
const { makeFakeGas } = require('./fake-gas.js');

const ROOT = path.join(__dirname, '..');
process.env.MIRROR_BACKOFF_MS = '0';                         // --all 退避（預設 30 秒）在測試裡關掉；另有一條專門測退避
let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; console.log('✗', name, '\n   got ', g, '\n   want', w); }
}
const tmps = [], procs = [];
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p || 'dzyb-job-')); tmps.push(d); return d; };
const quiet = async (fn) => { const o = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = o; } };
const last = (dir, f) => JSON.parse(fs.readFileSync(path.join(dir, 'logs', f), 'utf8'));
const q = (dir, sql) => { const db = new DatabaseSync(path.join(dir, 'bulletin.db'), { readOnly: true }); try { return db.prepare(sql).all().map((r) => Object.assign({}, r)); } finally { db.close(); } };
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);   // 真的 PNG 檔頭（mirror.js 會先驗本機檔頭與結尾）
const PNG_END = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);   // IEND chunk（mirror.js 也驗結尾）
const PNG = (s) => 'data:image/png;base64,' + Buffer.concat([PNG_HEAD, Buffer.from('簽名-' + s), PNG_END]).toString('base64');
const J_lock = (dir) => require('../server/job-common.js').takeLock(dir, 'mirror');   // 模擬另一輪鏡像正在跑（本程序持有鎖）
function freePort() { return new Promise((ok, no) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); s.on('error', no); }); }

// 假橋接物件：sigs 依序回 Drive id、mirror／backup 記下收到的內容；fail[op]＝這個 op 一律丟錯
function fakeBridge(fail) {
  // nullIf(name)＝這張回 null（M2 saveSigs 逐張失敗）；onSigs(put)＝sigs 呼叫進行中（Apps Script 處理那幾分鐘）要做的事；names＝每張被送出的名稱
  const b = { calls: [], sizes: [], names: [], mirrored: null, backup: null, fail: fail || {}, idsShort: false, nullIf: null, onSigs: null, onMirror: null };
  // M7 第 3 步（fileget／filelist）另外記在 fcalls，不混進 calls（既有斷言只看簽名與鏡像）。drive＝假附件資料夾 { id: { name, mime, buf, trashed } }；
  // ffail(op, p)＝'timeout'｜'auth'｜'null'｜'md5'｜假值：模擬橋接逾時、金鑰錯、Drive 找不到、md5 不符。segs＝每次 fileget 回的位元組數
  Object.assign(b, { fcalls: [], drive: {}, ffail: null, segs: [], extraList: [], onGet: null });
  b.call = async (op, p) => {
    if (op === 'fileget' || op === 'filelist') {
      b.fcalls.push(op);
      const mode = b.ffail && b.ffail(op, p);
      if (mode === 'timeout') { const e = new Error('連線 Google 逾時，請稍後再試'); e.code = 'BRIDGE_TIMEOUT'; e.detail = op + ': timeout'; throw e; }
      if (mode === 'auth') { const e = new Error('Google 雲端暫時連不上，請稍後再試'); e.code = 'BRIDGE'; e.detail = op + ': AUTH 橋接金鑰錯誤'; throw e; }
      const md5 = (buf) => require('crypto').createHash('md5').update(buf).digest('hex');
      if (op === 'filelist') return { files: Object.keys(b.drive).map((id) => { const x = b.drive[id]; return { id, name: x.name, mime: x.mime, size: x.buf.length, md5: md5(x.buf), trashed: !!x.trashed }; }).concat(b.extraList), nextPageToken: '' };
      const x = b.drive[p.id];
      if (b.onGet) b.onGet(p);
      if (!x || mode === 'null') return { file: null };
      const end = Math.min(x.buf.length, p.off + p.len);
      b.segs.push(end - p.off);
      return { file: { id: p.id, name: x.name, mime: x.mime, size: x.buf.length, md5: mode === 'md5' ? '0'.repeat(32) : md5(x.buf), trashed: !!x.trashed }, off: mode === 'badoff' ? p.off + 1 : p.off, data: x.buf.subarray(p.off, end).toString('base64'), eof: end >= x.buf.length };
    }
    b.calls.push(op);
    if (b.fail[op]) { const e = new Error('Google 雲端暫時連不上，請稍後再試'); e.code = 'BRIDGE'; e.detail = op + ': 假錯誤'; throw e; }
    if (op === 'sigs') {
      b.sizes.push(p.put.length); p.put.forEach((x) => b.names.push(x.name));
      if (b.onSigs) b.onSigs(p.put);
      const ids = p.put.map((x) => (b.nullIf && b.nullIf(x.name) ? null : 'DRV-' + x.name));
      return { ids: b.idsShort ? ids.slice(1) : ids };
    }
    if (op === 'mirror') { if (b.onMirror) b.onMirror(); b.mirrored = JSON.parse(JSON.stringify(p.data)); return { counts: {} }; }
    if (op === 'backup') { b.backup = p; return { id: 'BK-1', size: 1, trashed: 0 }; }
    throw new Error('未知 op ' + op);
  };
  b.n = (op) => b.calls.concat(b.fcalls).filter((x) => x === op).length;
  return b;
}
// 建一個有資料的正式庫：同仁 30、公告 2；nSig 筆帶簽名圖的已讀＋1 筆沒簽名圖＋1 筆搬遷來的（已有 Drive id）
function seedDb(dir, nSig, noOld) {   // noOld：不放搬遷來的那筆（它的 Drive id 不在假 Drive 裡，真的 gas mirror 會拒收）
  const st = makeSqliteStore(dir);
  const staff = Array.from({ length: Math.max(30, nSig) }, (_, i) => ({ id: 'S-' + String(i).padStart(3, '0'), name: '同仁' + i, unit: 'mala', active: true }));
  st.load({
    posts: [{ id: 'P-1', title: '公告一', units: ['mala'] }, { id: 'P-2', title: '公告二', units: ['mala'] }],
    staff,
    reads: noOld ? [] : [{ postId: 'P-2', staffId: 'S-029', name: '同仁29', unit: 'mala', at: '2026-09-29T01:00:00.000Z', sigId: 'OLD_S-029.png', driveSigId: 'DRV-OLD' }],
    log: [{ at: '2026-09-30T01:00:00.000Z', action: 'ack', target: 'P-1', summary: '簽名' }]
  });
  fs.writeFileSync(path.join(st.sigDir, 'OLD_S-029.png'), 'old');
  for (let i = 0; i < nSig; i++) st.addRead({ postId: 'P-1', staffId: staff[i].id, name: staff[i].name, unit: 'mala', at: '2026-09-30T02:00:0' + (i % 10) + '.000Z', sig: PNG(i) });
  st.addRead({ postId: 'P-2', staffId: 'S-000', name: '同仁0', unit: 'mala', at: '2026-09-30T03:00:00.000Z', sig: '' });   // 沒簽名圖
  st.close();
}

// 子程序：跑一支 server/*.js（只帶指定的環境變數＋PATH／HOME，不繼承 BRIDGE_* 等）
function runJob(script, args, env) {
  return new Promise((ok) => {
    const e = Object.assign({ PATH: process.env.PATH, DZYB_NO_DOTENV: '1', HOME: env.HOME || tmp('dzyb-home-'), MIRROR_BACKOFF_MS: '0' }, env);
    const p = spawn(process.execPath, [path.join(ROOT, 'server', script)].concat(args || []), { env: e, stdio: ['ignore', 'pipe', 'pipe'] });
    procs.push(p);
    let out = '', err = '';
    p.stdout.on('data', (c) => { out += c; }); p.stderr.on('data', (c) => { err += c; });
    p.on('exit', (code) => ok({ code, out, err }));
  });
}
async function startServer(dir, extra) {
  const port = await freePort();
  const p = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], { env: Object.assign({ PATH: process.env.PATH, DZYB_NO_DOTENV: '1', HOME: tmp('dzyb-home-'), PORT: String(port), DATA_DIR: dir }, extra || {}), stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(p);
  let out = '';
  p.stdout.on('data', (c) => { out += c; }); p.stderr.on('data', () => {});
  await new Promise((ok, no) => { const t = setInterval(() => { if (/啟動/.test(out)) { clearInterval(t); ok(); } }, 20); p.on('exit', (c) => { clearInterval(t); no(new Error('伺服器沒起來 ' + c)); }); });
  return { port, stop: () => new Promise((ok) => { if (p.exitCode !== null) return ok(); p.on('exit', () => ok()); p.kill(); }) };
}
function request(port, method, p, body) {
  return new Promise((ok) => {
    const buf = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: buf ? { 'Content-Type': 'text/plain', 'Content-Length': buf.length } : {}, agent: false }, (res) => {
      const cs = []; res.on('data', (c) => cs.push(c));
      res.on('end', () => { let json = null; try { json = JSON.parse(Buffer.concat(cs).toString()); } catch (e) {} ok({ status: res.statusCode, json }); });
    });
    r.on('error', (e) => ok({ status: 0, error: e.code }));
    if (buf) r.write(buf);
    r.end();
  });
}
const api = (port, action, body) => request(port, 'POST', '/', Object.assign({}, body || {}, { action }));

async function main() {
  // ================= A. 鏡像與簽名回填（程序內、假橋接物件） =================
  { const dir = tmp(); seedDb(dir, 25);
    const before = q(dir, 'SELECT postId, staffId, name, unit, at, sigId FROM reads ORDER BY rowid');
    const B = fakeBridge();
    const r = await quiet(() => runMirror({ dir, bridge: B, batch: 10, maxPerRun: 20 }));
    eq('回填：每輪上限 20 張、每批 ≤10 張（2 次 sigs 呼叫）', [r.uploaded, B.sizes], [20, [10, 10]]);
    eq('回填：pending＝剩下還沒回填的（25－20）', r.pending, 5);
    eq('鏡像：先回填再鏡像，mirror 1 次（之後第 4 步讀打卡名單）、ok、fails 0', [B.calls, r.ok, r.fails], [['sigs', 'sigs', 'mirror', 'clock'], true, 0]);
    const mr = B.mirrored.reads;
    eq('鏡像內容：四份都有、筆數與庫一致', [Object.keys(B.mirrored), B.mirrored.posts.length, B.mirrored.staff.length, mr.length, B.mirrored.log.length], [['posts', 'staff', 'reads', 'log'], 2, 30, 27, 1]);
    eq('鏡像保留 driveSigId：搬遷來的原 Drive id 不變', mr.find((x) => x.staffId === 'S-029').driveSigId, 'DRV-OLD');
    eq('鏡像保留 driveSigId：這一輪剛回填的 id 已帶上（前 20 張）', mr.filter((x) => x.postId === 'P-1').slice(0, 20).every((x) => x.driveSigId === 'DRV-' + x.sigId.replace(/\.png$/, '')), true);
    eq('鏡像：還沒回填的 driveSigId 送空白、沒簽名圖的也空白', [mr.filter((x) => x.postId === 'P-1' && !x.driveSigId).length, mr.find((x) => x.postId === 'P-2' && x.staffId === 'S-000').driveSigId], [5, '']);
    eq('鏡像：公告／同仁是原本的物件', [B.mirrored.posts[0].title, B.mirrored.staff[3].name], ['公告一', '同仁3']);
    eq('回填只寫 driveSigId 一欄（其他欄位與順序完全沒變）', q(dir, 'SELECT postId, staffId, name, unit, at, sigId FROM reads ORDER BY rowid'), before);
    eq('回填：庫裡 20 筆拿到 Drive id', q(dir, "SELECT COUNT(*) AS n FROM reads WHERE driveSigId LIKE 'DRV-P-1%'")[0].n, 20);
    eq('結果檔 mirror-last.json＝{ at, ok, uploaded, pending, … }', (({ at, ok, uploaded, pending }) => [typeof at, ok, uploaded, pending])(last(dir, 'mirror-last.json')), ['string', true, 20, 5]);
    const B2 = fakeBridge();
    const r2 = await quiet(() => runMirror({ dir, bridge: B2, batch: 10, maxPerRun: 20 }));
    eq('下一輪：補完剩下 5 張、pending 0', [r2.uploaded, r2.pending, B2.sizes], [5, 0, [5]]);
    const B3 = fakeBridge();
    const r3 = await quiet(() => runMirror({ dir, bridge: B3 }));
    eq('沒有待回填時不打 sigs，只鏡像（＋第 4 步讀打卡名單）', [B3.calls, r3.uploaded, r3.pending], [['mirror', 'clock'], 0, 0]);
    // 批次上限夾在 20（Apps Script SIGS_MAX_）；--all 不設每輪上限
    const dir2 = tmp(); seedDb(dir2, 25);
    const B4 = fakeBridge();
    await quiet(() => runMirror({ dir: dir2, bridge: B4, batch: 99, all: true }));
    eq('批次大小最多 20；--all 一輪補完', B4.sizes, [20, 5]); }

  // 本機缺圖：跳過、不佔名額、算在 pending 與 missing
  { const dir = tmp(); seedDb(dir, 3);
    fs.unlinkSync(path.join(dir, 'sigs', q(dir, "SELECT sigId FROM reads WHERE postId = 'P-1' ORDER BY rowid LIMIT 1")[0].sigId));
    const B = fakeBridge();
    const r = await quiet(() => runMirror({ dir, bridge: B, maxPerRun: 2 }));
    eq('缺圖：跳過不佔名額（仍上傳 2 張）、missing 1、pending 不算缺圖（0）、列出是哪一筆', [r.uploaded, r.missing, r.pending, r.ok, r.missingIds], [2, 1, 0, true, ['P-1/S-000']]); }

  // 橋接失敗：ok:false，同一輪不重試；連續失敗計數
  { const dir = tmp(); seedDb(dir, 25);
    const B = fakeBridge({ sigs: true });
    const r = await quiet(() => runMirror({ dir, bridge: B, batch: 10, maxPerRun: 60 }));
    eq('sigs 失敗：只打 1 次 sigs（剩下的批次不再送）、鏡像照做 1 次、ok:false', [B.n('sigs'), B.n('mirror'), r.ok, r.uploaded, r.pending], [1, 1, false, 0, 25]);
    eq('失敗結果檔帶時間戳與 ok:false、fails 1', (({ at, ok, fails }) => [!!Date.parse(at), ok, fails])(last(dir, 'mirror-last.json')), [true, false, 1]);
    const B2 = fakeBridge({ mirror: true });
    const r2 = await quiet(() => runMirror({ dir, bridge: B2, batch: 10, maxPerRun: 10 }));
    eq('mirror 失敗：mirror 只打 1 次、回填照做、ok:false、fails 連續 2', [B2.n('mirror'), r2.uploaded, r2.ok, r2.fails], [1, 10, false, 2]);
    const B3 = fakeBridge(); B3.idsShort = true;
    const r3 = await quiet(() => runMirror({ dir, bridge: B3, batch: 10, maxPerRun: 10 }));
    eq('sigs 回傳 id 筆數不符：不回填、ok:false', [r3.uploaded, r3.pending, r3.ok, r3.fails], [0, 15, false, 3]);
    const r4 = await quiet(() => runMirror({ dir, bridge: fakeBridge(), maxPerRun: 100 }));
    eq('恢復後 fails 歸 0', [r4.ok, r4.fails, r4.pending], [true, 0, 0]); }

  // ---- #14 B1：saveSigs 逐張 null → 成功的照回填、null 的留在 pending 只重傳它（Drive 端失敗一律暫時故障，不判壞圖） ----
  { const dir = tmp(); seedDb(dir, 25);
    const B = fakeBridge(); B.nullIf = (n) => n === 'P-1_S-000';     // 排在最前面的那張 Drive 一直收不下
    const rs = [];
    for (let i = 0; i < 3; i++) rs.push(await runMirror({ dir, bridge: B, batch: 10, maxPerRun: 10 }));
    eq('B1：一批 10 張裡 1 張 null → 其餘 9 張照回填；每小時模式有失敗就 ok:false、連續失敗累加；後面的簽名照樣前進', rs.map((r) => [r.uploaded, r.failed, r.ok, r.fails, r.bad]), [[9, 1, false, 1, 0], [9, 1, false, 2, 0], [6, 1, false, 3, 0]]);
    eq('B1：那一張永遠不會被判壞、一直在 pending；成功的每張只送一次（沒有孤兒檔）', [rs[2].pending, rs[2].failedIds, new Set(B.names).size, B.names.length], [1, ['P-1/S-000'], 25, 27]);
    eq('B1：每小時模式的錯誤訊息照實寫（Drive 端傳不上去、不判壞圖、下一輪再試）', /Drive 端有 1 張傳不上去（暫時故障，不判壞圖），下一輪再試/.test(rs[2].error), true);
    B.nullIf = null;
    const r4 = await runMirror({ dir, bridge: B });
    eq('B1：Drive 恢復 → 下一輪補上、ok、fails 歸 0', [r4.uploaded, r4.pending, r4.ok, r4.fails], [1, 0, true, 0]); }
  // 真的 gas saveSigs（fake-gas 注入「第 k 張 Drive 寫入失敗」與 0 位元組圖）：逐張契約端到端
  { const dir = tmp(); seedDb(dir, 5);
    fs.writeFileSync(path.join(dir, 'sigs', q(dir, "SELECT sigId FROM reads WHERE staffId = 'S-002' AND postId = 'P-1'")[0].sigId), '');   // 0 位元組（磁碟滿時寫壞）
    const FG = makeFakeGas(); const files = require('vm').runInContext('makeFiles_()', FG.G);
    const bridge = { call: async (op, p) => (op === 'sigs' ? { ids: files.saveSigs(p.put) } : {}) };
    FG.st.failCreate = (name, k) => k === 0;                   // 第 0 張 Drive 寫入失敗（只這一次）
    const r1 = await runMirror({ dir, bridge, batch: 10, all: true });
    eq('真 saveSigs：0 位元組本機判壞（不上傳）；第 0 張 Drive 暫時失敗 → --all 下一輪掃描補上，4 張全回填、pending 0、exit 0', [r1.ok, r1.uploaded, r1.pending, r1.bad, r1.badIds], [true, 4, 0, 1, ['P-1/S-002（本機檔損毀）']]);
    const sigFiles = Object.values(FG.drive.files).filter((f) => f.parent === FG.props.SIG_FOLDER_ID).length;
    eq('真 saveSigs：Drive 簽名資料夾只有 4 個檔（沒有孤兒檔）', [sigFiles, q(dir, "SELECT COUNT(*) AS n FROM reads WHERE driveSigId LIKE 'G%'")[0].n], [4, 4]); }
  // UPDATE 的保護：上傳這幾分鐘裡別人已填 driveSigId（搬遷）→ 不覆蓋；sigId 被重建成別張圖 → 不套用舊圖的 id
  { const dir = tmp(); seedDb(dir, 3);
    const B = fakeBridge();
    B.onSigs = () => { const w = new DatabaseSync(path.join(dir, 'bulletin.db')); w.exec("PRAGMA busy_timeout = 5000; UPDATE reads SET driveSigId = 'MIGRATED' WHERE staffId = 'S-000' AND postId = 'P-1'; UPDATE reads SET sigId = 'REBUILT.png' WHERE staffId = 'S-001' AND postId = 'P-1'"); w.close(); };
    await runMirror({ dir, bridge: B });
    eq('已有 driveSigId 的不覆蓋（AND driveSigId = \'\'）', q(dir, "SELECT driveSigId FROM reads WHERE staffId = 'S-000' AND postId = 'P-1'")[0].driveSigId, 'MIGRATED');
    eq('sigId 變了的不套用舊圖的 id（AND sigId = ?）', q(dir, "SELECT driveSigId FROM reads WHERE staffId = 'S-001' AND postId = 'P-1'")[0].driveSigId, '');
    eq('其他照常回填', q(dir, "SELECT driveSigId FROM reads WHERE staffId = 'S-002' AND postId = 'P-1'")[0].driveSigId, 'DRV-P-1_S-002'); }
  // #14 S1：四份資料是同一個快照；呼叫 mirror 時讀交易已結束（不擋 checkpoint）
  { const dir = tmp(); seedDb(dir, 2);
    const B = fakeBridge(); let ck = null;
    B.onMirror = () => { const w = new DatabaseSync(path.join(dir, 'bulletin.db')); ck = Object.assign({}, w.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()); w.close(); };
    await runMirror({ dir, bridge: B, _betweenReads: () => {
      const w = new DatabaseSync(path.join(dir, 'bulletin.db'));
      w.exec("PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE; INSERT INTO posts VALUES ('P-NEW', '{\"id\":\"P-NEW\"}'); INSERT INTO reads (postId, staffId, name, unit, at, sigId) VALUES ('P-NEW', 'S-005', 'n', 'mala', 'x', ''); COMMIT"); w.close(); } });
    const m = B.mirrored;
    eq('S1：讀的中途伺服器提交的新公告與已讀都不在這一份（同一個快照、沒有孤兒已讀）', [m.posts.map((p) => p.id), m.reads.filter((r) => !m.posts.some((p) => p.id === r.postId)).length], [['P-1', 'P-2'], 0]);
    eq('S1：呼叫 mirror 時沒有開著的讀交易（checkpoint TRUNCATE 不 busy）', ck && ck.busy, 0);
    const B2 = fakeBridge();
    await runMirror({ dir, bridge: B2 });
    eq('S1：下一輪就帶上新公告', B2.mirrored.posts.map((p) => p.id), ['P-1', 'P-2', 'P-NEW']); }
  // #14 S2：--all 的完成條件是 pending=0；缺圖與壞圖另外計、列出清單、不卡住
  { const dir = tmp(); seedDb(dir, 6);
    fs.unlinkSync(path.join(dir, 'sigs', q(dir, "SELECT sigId FROM reads WHERE staffId = 'S-001' AND postId = 'P-1'")[0].sigId));
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'sigs', q(dir, "SELECT sigId FROM reads WHERE staffId = 'S-004' AND postId = 'P-1'")[0].sigId), '');   // 0 位元組＝壞圖
    const B = fakeBridge();
    const r = await runMirror({ dir, bridge: B, all: true });
    eq('S2：--all 一次跑到 pending 0（缺圖 1、壞圖 1 另計），ok', [r.ok, r.pending, r.missing, r.bad, r.uploaded, r.missingIds, r.badIds], [true, 0, 1, 1, 4, ['P-1/S-001'], ['P-1/S-004（本機檔損毀）']]);
    const log = fs.readFileSync(path.join(dir, 'logs/mirror.log'), 'utf8');
    eq('S2：mirror.log 印出缺圖與壞圖警告並列出是哪幾筆', [/⚠ 本機缺簽名圖 1 筆.*P-1\/S-001/.test(log), /⚠ 壞簽名圖 1 筆.*P-1\/S-004/.test(log)], [true, true]);
    const c = await runJob('mirror.js', ['--all'], { DATA_DIR: dir, BRIDGE_URL: 'http://127.0.0.1:9/exec', BRIDGE_KEY: 'x'.repeat(40) });
    eq('S2：mirror.js --all 在終端印出 pending／missing／bad 與清單', [/pending=0｜本機缺圖 missing=1｜壞圖 bad=1/.test(c.out), /⚠ 本機缺圖：P-1\/S-001/.test(c.out)], [true, true]); }

  // ---- 第 5 輪 (c)：本機驗圖——0 位元組、檔頭不對、結尾缺（截斷）都判壞、不上傳 ----
  { const dir = tmp(); seedDb(dir, 7);
    const f = (sid) => path.join(dir, 'sigs', q(dir, `SELECT sigId FROM reads WHERE staffId = '${sid}' AND postId = 'P-1'`)[0].sigId);
    const png = Buffer.concat([PNG_HEAD, Buffer.from('圖'), PNG_END]);
    fs.writeFileSync(f('S-000'), '');                                              // 0 位元組
    fs.writeFileSync(f('S-001'), 'GIF89a 不是 PNG');                                // 檔頭不對
    fs.writeFileSync(f('S-002'), png.subarray(0, png.length - 5));                 // PNG 截斷：開頭對、沒有 IEND
    fs.writeFileSync(f('S-003'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));  // JPEG 截斷：開頭對、結尾不是 FF D9
    fs.writeFileSync(f('S-004'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 0xff, 0xd9]));   // 完整 JPEG（副檔名 .png 也照收）
    const B = fakeBridge();
    const r = await runMirror({ dir, bridge: B });
    eq('本機驗圖：0 位元組／壞檔頭／PNG 截斷／JPEG 截斷判壞（本機檔損毀）、不上傳；完整 JPEG 照常上傳', [r.ok, r.bad, r.pending, r.uploaded, r.badIds.map((x) => x.split('（')[0]), ['P-1_S-000', 'P-1_S-001', 'P-1_S-002', 'P-1_S-003'].some((n) => B.names.includes(n)), B.names.includes('P-1_S-004')],
      [true, 4, 0, 3, ['P-1/S-000', 'P-1/S-001', 'P-1/S-002', 'P-1/S-003'], false, true]);
    const { localDamaged } = require('../server/mirror.js');
    eq('localDamaged：完整 PNG／JPEG 不判壞、讀不到的檔不判（交給 missing）', [localDamaged(f('S-005')), localDamaged(f('S-004')), localDamaged(path.join(dir, 'nope.png'))], [false, false, false]); }
  // ---- 第 5 輪 (b)：Drive 暫時故障、閃斷、限流（審查 t8～t10）——好圖永遠不判壞；還有 pending 時 --all 不會 exit 0 ----
  { const dir = tmp(); seedDb(dir, 30);                      // Drive 全掛
    const B = fakeBridge(); B.nullIf = () => true;
    const ra = await runMirror({ dir, bridge: B, all: true });
    eq('Drive 全掛：--all 第一輪沒進展就停 → ok:false、bad 0、pending 30、訊息寫「稍後再跑；多次重跑仍失敗請找 MacBook Claude」、列出清單',
      [ra.ok, ra.bad, ra.pending, /Drive 端有 30 張傳不上去.*稍後再跑；多次重跑仍失敗請找 MacBook Claude/.test(ra.error), ra.failedIds.length, B.n('sigs')], [false, 0, 30, true, 30, 2]);
    const hourly = [];
    for (let i = 0; i < 3; i++) { const r = await runMirror({ dir, bridge: B }); hourly.push([r.bad, r.ok, r.fails]); }
    eq('Drive 全掛：每小時模式 bad 始終 0、ok:false、連續失敗累加（S9：只有一批時也一樣）', hourly, [[0, false, 2], [0, false, 3], [0, false, 4]]);
    B.nullIf = null;
    const rb = await runMirror({ dir, bridge: B, all: true });
    eq('Drive 恢復後 --all 全部上傳、pending 0、ok', [rb.ok, rb.uploaded, rb.pending, rb.bad], [true, 30, 0, 0]); }
  { const dir = tmp(); seedDb(dir, 90);                      // t8：第 1 批閃斷，之後正常
    const B = fakeBridge(); let call = 0; B.onSigs = () => { call++; }; B.nullIf = () => call === 1;
    const r = await runMirror({ dir, bridge: B, all: true });
    eq('閃斷（第 1 批整批失敗、之後正常）：--all 重掃補上 → ok、pending 0、bad 0', [r.ok, r.pending, r.bad, r.uploaded], [true, 0, 0, 90]); }
  { const dir = tmp(); seedDb(dir, 90);                      // t9：第 1 批部分成功後 Drive 全掛
    const B = fakeBridge(); let call = 0; B.onSigs = () => { call++; }; B.nullIf = (n) => call > 1 || n.endsWith('0');
    const r = await runMirror({ dir, bridge: B, all: true });
    eq('中途掛掉：--all → ok:false、bad 0、pending > 0（不會 exit 0）', [r.ok, r.bad, r.pending > 0], [false, 0, true]); }
  { // t10：限流——每張每次上傳各有 30% 機率失敗（固定種子）；10 次 --all
    const out = [];
    for (let sd = 1; sd <= 10; sd++) {
      const dir = tmp(); seedDb(dir, 100);
      let seed = 777 + sd; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
      const B = fakeBridge(); B.nullIf = () => rnd() < 0.3;
      const runs = [];
      for (let k = 0; k < 5; k++) { const r = await runMirror({ dir, bridge: B, all: true }); runs.push([r.ok, r.pending, r.bad]); if (r.ok) break; }   // 照手冊：沒到 pending=0 就重跑
      out.push(runs);
    }
    const flat = out.flat();
    console.log('   （限流模擬：10 組各需要跑 --all 的次數 ' + out.map((x) => x.length).join(',') + '）');
    eq('限流（每張 30% 失敗）：每一次 --all 都是 bad 0；ok ⇔ pending 0（還有 pending 就不會 exit 0）；重跑後都能補完',
      [flat.every((x) => x[2] === 0), flat.every((x) => x[0] === (x[1] === 0)), out.every((x) => x[x.length - 1][0])], [true, true, true]); }
  { const dir = tmp(); seedDb(dir, 20);                      // 每一輪都有進展、但總有失敗：--all 一直掃到沒進展才停，結尾沒補完就不 exit 0
    const B = fakeBridge(); B.nullIf = (n) => n === 'P-1_S-007';
    const r = await runMirror({ dir, bridge: B, all: true });
    eq('一張一直傳不上去：--all 補完其餘 19 張後停 → ok:false、pending 1、bad 0、列出那一張', [r.ok, r.pending, r.bad, r.uploaded, r.failedIds], [false, 1, 0, 19, ['P-1/S-007']]); }
  // ---- 第 5 輪 (d)：人工略過（逃生門）：只有人會寫 logs/sig-skip.json；mirror 把它當 bad 列出並跳過 ----
  { const dir = tmp(); seedDb(dir, 20);
    const B = fakeBridge(); B.nullIf = (n) => n === 'P-1_S-007';
    const r0 = await runMirror({ dir, bridge: B, all: true });
    fs.writeFileSync(path.join(dir, 'logs/sig-skip.json'), JSON.stringify({ 'P-1/S-007': '2026-10-01 Drive 一直拒收，Eason 同意略過' }));
    const r = await runMirror({ dir, bridge: B, all: true });
    eq('人工略過：之前 ok:false；寫進 sig-skip.json 後 --all → ok、pending 0、另計 skipped 1（不算 bad）、不再送那一張', [r0.ok, r.ok, r.pending, r.bad, r.skipped, r.skippedIds, B.names.filter((x) => x === 'P-1_S-007').length], [false, true, 0, 0, 1, ['P-1/S-007（2026-10-01 Drive 一直拒收，Eason 同意略過）'], 2]);
    const hs = judgeHealth({ mirror: { at: r.at, ok: true, sigPending: 0, missing: r.missing, bad: r.bad, skipped: r.skipped, fails: 0 }, backup: { at: r.at, ok: true }, disk: { freeMB: 99999 } });
    eq('S14：只有 skipped → /health 綠燈', hs.level, 'green');
    // S15：格式錯 → 照常上傳（好圖照樣回填）、這一輪不略過任何一張、ok:false 並寫原因
    const st5 = makeSqliteStore(dir); st5.addRead({ postId: 'P-2', staffId: 'S-011', name: 'n', unit: 'mala', at: 'x', sig: PNG('new') }); st5.close();
    fs.writeFileSync(path.join(dir, 'logs/sig-skip.json'), '{"P-1/S-007": 1}');   // 原因不是字串
    const r2 = await runMirror({ dir, bridge: B, all: true });
    eq('S15：人工略過清單格式錯 → ok:false 寫原因、這一輪不略過（S-007 又送一次、回到 pending）、好圖照常回填', [r2.ok, /sig-skip\.json 格式錯誤/.test(r2.error), r2.pending, r2.skipped, B.names.filter((x) => x === 'P-1_S-007').length > 2, r2.uploaded, B.names.includes('P-2_S-011')], [false, true, 1, 0, true, 1, true]);
    eq('程式從不自動寫人工略過清單', fs.readFileSync(path.join(dir, 'logs/sig-skip.json'), 'utf8'), '{"P-1/S-007": 1}');
    fs.writeFileSync(path.join(dir, 'logs/sig-skip.json'), JSON.stringify({ 'P-1/S-007': '略過', 'P-1/s-007': '打錯大小寫', 'P-9/S-001': '沒這則' }));
    const r3 = await runMirror({ dir, bridge: B });
    eq('建議 3：sig-skip 裡對不到任何已讀的鍵 → 警告列出、ok 不受影響', [r3.ok, r3.skipUnmatched, /有 2 個鍵對不到任何已讀/.test((r3.warnings || []).join())], [true, ['P-1/s-007', 'P-9/S-001'], true]); }
  // S14：本機壞圖、缺圖寫進 sig-skip 也算 skipped（不算 bad／missing）；未略過的 bad／missing 仍亮黃
  { const dir = tmp(); seedDb(dir, 4);
    const f = (sid) => path.join(dir, 'sigs', q(dir, `SELECT sigId FROM reads WHERE staffId = '${sid}' AND postId = 'P-1'`)[0].sigId);
    fs.writeFileSync(f('S-000'), ''); fs.unlinkSync(f('S-001')); fs.writeFileSync(f('S-002'), '');
    const r0 = await runMirror({ dir, bridge: fakeBridge() });
    fs.writeFileSync(path.join(dir, 'logs/sig-skip.json'), JSON.stringify({ 'P-1/S-000': '壞圖確認放棄', 'P-1/S-001': '缺圖確認放棄' }));
    const r = await runMirror({ dir, bridge: fakeBridge() });
    const H = (x) => judgeHealth({ mirror: { at: x.at, ok: x.ok, sigPending: x.pending, missing: x.missing, bad: x.bad, skipped: x.skipped, fails: 0 }, backup: { at: x.at, ok: true }, disk: { freeMB: 99999 } });
    eq('S14：略過前 bad 2、missing 1 → 黃；略過壞圖與缺圖後 skipped 2、bad 1、missing 0 → 仍黃（還有 S-002 沒略過）', [[r0.bad, r0.missing, H(r0).level], [r.skipped, r.bad, r.missing, H(r).level, H(r).why]], [[2, 1, 'yellow'], [2, 1, 0, 'yellow', ['有壞簽名圖']]]);
    fs.writeFileSync(path.join(dir, 'logs/sig-skip.json'), JSON.stringify({ 'P-1/S-000': 'x', 'P-1/S-001': 'y', 'P-1/S-002': 'z' }));
    const r2 = await runMirror({ dir, bridge: fakeBridge() });
    eq('S14：全部略過 → skipped 3、bad 0、missing 0 → 綠燈；/health 帶出 skipped', [r2.skipped, r2.bad, r2.missing, H(r2).level], [3, 0, 0, 'green']); }
  // 建議 1：--all 每輪更新結果檔的 at（心跳）；失敗超過一半時退避
  { const dir = tmp(); seedDb(dir, 6);
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'logs/mirror-last.json'), JSON.stringify({ at: '2026-01-01T00:00:00.000Z', ok: true, fails: 0 }));
    const B = fakeBridge(); let call = 0, seenAt = null; B.onSigs = () => { call++; if (call === 2) seenAt = last(dir, 'mirror-last.json'); }; B.nullIf = (n) => call === 1 && n !== 'P-1_S-000';
    const t0 = Date.now();
    const r = await runMirror({ dir, bridge: B, all: true, backoffMs: 300 });
    eq('建議 1：--all 第 1 輪後結果檔 at 已更新（running）、沿用上次 ok；失敗 5/6 → 退避 300ms 後第 2 輪補完', [!!seenAt && seenAt.at > '2026-01-02', seenAt && seenAt.running, seenAt && seenAt.ok, Date.now() - t0 >= 300, r.ok, r.pending], [true, true, true, true, true, 0]); }
  // 建議 4：store-sqlite 寫簽名先寫暫存再改名；失敗時清掉暫存檔、啟動時清殘檔
  { const dir = tmp(); fs.mkdirSync(path.join(dir, 'sigs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'sigs', 'P-1_S-001.png.tmp-4242'), 'half');
    const st = makeSqliteStore(dir);
    const left0 = fs.readdirSync(path.join(dir, 'sigs'));
    fs.mkdirSync(path.join(dir, 'sigs', 'P-1_S-002.png'));    // 正式檔名被一個資料夾佔住 → rename 失敗
    const oe = console.error; console.error = () => {};
    let threw = false; try { st.addRead({ postId: 'P-1', staffId: 'S-002', name: 'n', unit: 'u', at: 'x', sig: PNG('x') }); } catch (e) { threw = true; }
    console.error = oe; st.close();
    eq('建議 4：啟動時清掉 *.tmp-<pid> 殘檔；改名失敗時丟錯且不留暫存檔', [left0, threw, fs.readdirSync(path.join(dir, 'sigs')).filter((f) => /\.tmp-/.test(f))], [[], true, []]); }
  // 建議 2：--all 結束時只要 pending > 0（或算不出來）就 exit 1，即使 ok（例如跑到一半伺服器又收到新簽名、下一輪才會補）
  { const { exitCode } = require('../server/mirror.js');
    const dir = tmp(); seedDb(dir, 2);
    const r = await runMirror({ dir, bridge: fakeBridge(), all: true });
    eq('建議 2：exitCode——--all pending 0 → 0；ok 但 pending 1 → 1；pending 算不出來 → 1；每小時模式只看 ok', [exitCode(r, true), exitCode({ ok: true, pending: 1 }, true), exitCode({ ok: true, pending: null }, true), exitCode({ ok: true, pending: 1 }, false), exitCode({ ok: false, pending: 0 }, false)], [0, 1, 1, 0, 1]); }
  // carry 寫不進去 → 這一輪不上傳（免得重傳成孤兒檔）
  { const dir = tmp(); seedDb(dir, 3);
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'logs/sig-state.json'), JSON.stringify({ unsaved: { 'P-1\tS-000\tP-1_S-000.png': 'DRV-X' } }));
    const w = new DatabaseSync(path.join(dir, 'bulletin.db')); w.exec('BEGIN IMMEDIATE');
    const B = fakeBridge();
    const r = await runMirror({ dir, bridge: B, busyMs: 50 });
    w.exec('ROLLBACK'); w.close();
    eq('carry 寫庫失敗 → sigs 0 次、ok:false、unsaved 保留', [B.n('sigs'), r.ok, JSON.parse(fs.readFileSync(path.join(dir, 'logs/sig-state.json'), 'utf8')).unsaved['P-1\tS-000\tP-1_S-000.png']], [0, false, 'DRV-X']); }
  // 表外：sig-state 損毀時這一輪不上傳（免得重傳成孤兒檔）
  { const dir = tmp(); seedDb(dir, 3);
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true }); fs.writeFileSync(path.join(dir, 'logs/sig-state.json'), '{"unsaved":');
    const B = fakeBridge();
    const r = await runMirror({ dir, bridge: B, all: true });
    eq('sig-state 損毀時照樣上傳 → 不可以：sigs 0 次、uploaded 0、鏡像照做', [B.n('sigs'), r.uploaded, B.n('mirror'), r.ok], [0, 0, 1, false]); }
  // ---- 第 5 輪 (a)：回退情境——先 READONLY、不再有新簽名，只剩本機壞圖；--all 一次就要 pending=0、bad=N、exit 0 ----
  for (const [label0, bads] of [['1 張 0 位元組', ['zero']], ['5 張（2 張 0 位元組＋2 張壞檔頭＋1 張截斷）', ['zero', 'zero', 'head', 'head', 'cut']]]) {
    const FG = makeFakeGas(); const URL0 = await FG.listen(); const KEY = 'k'.repeat(40);
    Object.assign(FG.props, { BRIDGE_KEY: KEY, PRIMARY: 'mini' });
    const dir = tmp(); seedDb(dir, 10, true);
    const JOBR = { DATA_DIR: dir, BRIDGE_URL: URL0, BRIDGE_KEY: KEY };
    eq(`回退（${label0}）：（前提）先正常回填完`, (await runJob('mirror.js', [], JOBR)).code, 0);
    fs.writeFileSync(path.join(dir, 'READONLY'), '');
    const st = makeSqliteStore(dir);
    bads.forEach((b, i) => { st.addRead({ postId: 'P-2', staffId: 'S-02' + i, name: 'n', unit: 'mala', at: 'x', sig: PNG('b' + i) }); });
    st.close();
    bads.forEach((b, i) => { const p0 = path.join(dir, 'sigs', q(dir, `SELECT sigId FROM reads WHERE staffId = 'S-02${i}' AND postId = 'P-2'`)[0].sigId); fs.writeFileSync(p0, b === 'zero' ? '' : b === 'head' ? 'NOTPNG' : fs.readFileSync(p0).subarray(0, 12)); });
    const c = await runJob('mirror.js', ['--all'], JOBR);
    const ml = last(dir, 'mirror-last.json');
    eq(`回退（${label0}）：--all 一次 → exit 0、pending 0、bad ${bads.length}、印出 pending=0 與本機檔損毀`, [c.code, ml.pending, ml.bad, /pending=0/.test(c.out), /本機檔損毀/.test(c.out)], [0, 0, bads.length, true, true]);
    await FG.close(); }
  // --all 遇到 Drive 故障（端到端）：exit 1、印出實際判斷與清單
  { const FG = makeFakeGas(); const URL0 = await FG.listen(); const KEY = 'k'.repeat(40);
    Object.assign(FG.props, { BRIDGE_KEY: KEY, PRIMARY: 'mini' });
    const dir = tmp(); seedDb(dir, 20, true);
    FG.st.failCreate = () => true;                             // Drive 每一張都寫不進去
    const c = await runJob('mirror.js', ['--all'], { DATA_DIR: dir, BRIDGE_URL: URL0, BRIDGE_KEY: KEY, SIG_BATCH: '5' });
    eq('--all Drive 故障 → exit 1、印「Drive 端有 20 張傳不上去，稍後再跑；多次重跑仍失敗請找 MacBook Claude」＋清單、bad 0', [c.code, /✗ Drive 端有 20 張傳不上去，稍後再跑；多次重跑仍失敗請找 MacBook Claude：P-1\/S-000/.test(c.out), last(dir, 'mirror-last.json').bad], [1, true, 0]);
    await FG.close(); }
  // ---- S13 對應：回填寫進資料庫失敗 → 這一輪停止上傳（不會往下傳） ----
  { const dir = tmp(); seedDb(dir, 30);
    const B = fakeBridge(); let w = null;
    B.onSigs = () => { if (!w) { w = new DatabaseSync(path.join(dir, 'bulletin.db')); w.exec('BEGIN IMMEDIATE'); } };
    const r = await runMirror({ dir, bridge: B, batch: 10, all: true, busyMs: 50 });
    w.exec('ROLLBACK'); w.close();
    eq('寫庫失敗 → 停止、不再送下一批（sigs 1 次）、ok:false、uploaded 不算', [B.n('sigs'), r.ok, r.uploaded, /回填寫入/.test(r.error)], [1, false, 0, true]); }
  // ---- S8：sig-state.json 的 unsaved 型別不對 → 跟損毀一樣：改名保留、ok:false、鏡像照做 ----
  for (const [lab, bad] of [['unsaved 是字串', { unsaved: 'abc' }], ['unsaved 是陣列', { unsaved: ['x'] }], ['unsaved 的值不是字串', { unsaved: { a: 1 } }]]) {
    const dir = tmp(); seedDb(dir, 2);
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true }); fs.writeFileSync(path.join(dir, 'logs/sig-state.json'), JSON.stringify(bad));
    const B = fakeBridge();
    const r = await runMirror({ dir, bridge: B });
    const r2 = await runMirror({ dir, bridge: B });
    eq(`S8：${lab} → 改名 .corrupt-*、ok:false、鏡像照做；下一輪恢復正常`, [r.ok, /損毀/.test(r.error), fs.readdirSync(path.join(dir, 'logs')).some((f) => /^sig-state\.json\.corrupt-/.test(f)), B.n('mirror'), r2.ok, r2.pending], [false, true, true, 2, true, 0]); }
  { const dir = tmp(); seedDb(dir, 2);                        // 舊格式（還有 fails、seq 等欄位）照讀，存檔時只留 unsaved
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true }); fs.writeFileSync(path.join(dir, 'logs/sig-state.json'), JSON.stringify({ fails: { a: { n: 3, at: 0 } }, seq: 5, unsaved: {} }));
    const r = await runMirror({ dir, bridge: fakeBridge() });
    eq('舊格式 sig-state 照讀、存回只剩 unsaved', [r.ok, Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'logs/sig-state.json'), 'utf8')))], [true, ['unsaved']]); }

  // ---- #14 S5：還原後不讓鏡像用舊資料蓋掉試算表 ----
  { const dir = tmp(); seedDb(dir, 5);
    const B = fakeBridge();
    const r0 = await runMirror({ dir, bridge: B });
    eq('S5：成功鏡像記下送出的筆數（lastSent）', [r0.ok, last(dir, 'mirror-last.json').lastSent.reads], [true, 7]);
    { const w = new DatabaseSync(path.join(dir, 'bulletin.db')); w.exec("DELETE FROM reads WHERE staffId IN ('S-003', 'S-004') AND postId = 'P-1'"); w.close(); }   // 模擬從較舊的快照還原
    const B2 = fakeBridge();
    const r1 = await runMirror({ dir, bridge: B2 });
    eq('S5：本機 reads 比上次鏡像少 → 不送、ok:false、原因寫明', [r1.ok, B2.n('mirror'), /本機筆數比上次鏡像少（可能剛還原）/.test(r1.error), /reads 5＜7/.test(r1.error)], [false, 0, true, true]);
    const r2 = await runMirror({ dir, bridge: B2 });
    eq('S5：失敗那輪不改 lastSent，下一輪照樣擋', [r2.ok, B2.n('mirror'), last(dir, 'mirror-last.json').lastSent.reads], [false, 0, 7]);
    let sent = null; const B3 = fakeBridge(); const call0 = B3.call; B3.call = (op, p) => { if (op === 'mirror') sent = p; return call0(op, p); };
    const r3 = await runMirror({ dir, bridge: B3, force: true });
    eq('S5：--force → 送出、帶 force:true 給 Apps Script、lastSent 更新', [r3.ok, sent && sent.force, r3.forced, last(dir, 'mirror-last.json').lastSent.reads], [true, true, true, 5]);
    const B4 = fakeBridge(); let sent4 = null; const c4 = B4.call; B4.call = (op, p) => { if (op === 'mirror') sent4 = p; return c4(op, p); };
    const r4 = await runMirror({ dir, bridge: B4 });
    eq('S5：之後一般輪照常、不帶 force', [r4.ok, sent4 && 'force' in sent4], [true, false]);
    const c = await runJob('mirror.js', ['--force'], { DATA_DIR: dir, BRIDGE_URL: 'http://127.0.0.1:9/exec', BRIDGE_KEY: 'x'.repeat(40) });
    eq('S5：mirror.js 接受 --force 參數（橋接連不上 → exit 1、印結論）', [c.code, /鏡像失敗｜/.test(c.out)], [1, true]); }
  { const dir = tmp(); seedDb(dir, 2);                       // S11：只有操作紀錄變少（快照裡 posts／staff／reads 相同）也要擋
    await runMirror({ dir, bridge: fakeBridge() });
    { const w = new DatabaseSync(path.join(dir, 'bulletin.db')); w.exec('DELETE FROM log'); w.close(); }
    const B = fakeBridge();
    const r = await runMirror({ dir, bridge: B });
    eq('S11：只有 log 變少 → 不送、ok:false、原因列出 log', [r.ok, B.n('mirror'), /log 0＜1/.test(r.error)], [false, 0, true]);
    const r2 = await runMirror({ dir, bridge: B, force: true });
    eq('S11：--force 之後放行、lastSent.log 下修', [r2.ok, B.n('mirror'), last(dir, 'mirror-last.json').lastSent.log], [true, 1, 0]); }

  // ---- #14 S7：已上傳未寫庫的 carry；鎖檔 6 小時上限 ----
  { const dir = tmp(); seedDb(dir, 4);
    const B = fakeBridge(); let w = null;
    B.onSigs = () => { w = new DatabaseSync(path.join(dir, 'bulletin.db')); w.exec('BEGIN IMMEDIATE'); };   // 上傳期間伺服器拿著寫鎖 → 回填寫不進去
    const r1 = await runMirror({ dir, bridge: B, busyMs: 50 });
    w.exec('ROLLBACK'); w.close(); B.onSigs = null;
    const un = JSON.parse(fs.readFileSync(path.join(dir, 'logs/sig-state.json'), 'utf8')).unsaved;
    eq('S7：寫庫失敗 → ok:false、已上傳的 id 記在 unsaved', [r1.ok, /回填寫入/.test(r1.error), Object.keys(un).length, r1.uploaded], [false, true, 4, 0]);
    const r2 = await runMirror({ dir, bridge: B });
    eq('S7：下一輪直接寫入上一輪的 id、不重傳（sigs 總共 1 次）、pending 0', [r2.ok, r2.carried, r2.uploaded, B.n('sigs'), r2.pending, q(dir, "SELECT COUNT(*) AS n FROM reads WHERE driveSigId LIKE 'DRV-P-1%'")[0].n], [true, 4, 0, 1, 0, 4]); }
  { const dir = tmp(); seedDb(dir, 1);
    const sleeper = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e5)'], { stdio: 'ignore' }); procs.push(sleeper);
    const lf = path.join(dir, 'logs/mirror.lock'); fs.mkdirSync(path.dirname(lf), { recursive: true });
    fs.writeFileSync(lf, String(sleeper.pid));
    eq('S7：鎖由活著的程序持有、未過期 → 跳過', (await runMirror({ dir, bridge: fakeBridge() })).busy, true);
    const c = await runJob('mirror.js', ['--all'], { DATA_DIR: dir, BRIDGE_URL: 'http://127.0.0.1:9/exec', BRIDGE_KEY: 'x'.repeat(40) });
    eq('建議 1：--all 撞到鎖 → exit 1、印「已跳過」', [c.code, /另一輪鏡像正在跑.*已跳過/.test(c.out)], [1, true]);
    const old = (Date.now() - 7 * 3600e3) / 1000; fs.utimesSync(lf, old, old);   // PID 被重用的情形：程序活著，但鎖檔已 7 小時沒更新
    const r = await runMirror({ dir, bridge: fakeBridge() });
    eq('S7：鎖檔超過 6 小時 → 視為殘留、照常跑', [r.busy, r.ok], [undefined, true]);
    sleeper.kill(); }
  // ---- 建議 2／3：sig-state.json 損毀改名保留並 ok:false；存狀態失敗只記警告、鏡像照做 ----
  { const dir = tmp(); seedDb(dir, 1);
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true }); fs.writeFileSync(path.join(dir, 'logs/sig-state.json'), '{"fails":{');
    const B = fakeBridge();
    const r = await runMirror({ dir, bridge: B });
    eq('建議 2：sig-state.json 損毀 → 改名 .corrupt-* 保留、ok:false 說明、這一輪不上傳（免得重傳成孤兒）、鏡像照做', [r.ok, /損毀/.test(r.error), fs.readdirSync(path.join(dir, 'logs')).some((f) => /^sig-state\.json\.corrupt-/.test(f)), B.n('mirror')], [false, true, true, 1]);
    fs.mkdirSync(path.join(dir, 'logs/sig-state.json.tmp'));   // 暫存檔路徑被佔（模擬寫不進去）
    const st = makeSqliteStore(dir); st.addRead({ postId: 'P-2', staffId: 'S-005', name: 'n', unit: 'mala', at: 'x', sig: PNG('w') }); st.close();
    const B2 = fakeBridge();
    const r2 = await runMirror({ dir, bridge: B2 });
    eq('建議 3：存狀態失敗 → 只記 warning、回填與鏡像照做、ok', [r2.ok, !!(r2.warnings && /sig-state/.test(r2.warnings[0])), r2.uploaded, B2.n('mirror')], [true, true, 2, 1]); }

  // ================= B. 背景工作不經 makeSqliteStore：不寫 secret、不改表 =================
  { const dir = tmp(); seedDb(dir, 2);
    const s0 = q(dir, "SELECT v FROM kv WHERE k = 'secret'")[0].v;
    for (let i = 0; i < 10; i++) { await quiet(() => runDaily({ dir, bridge: fakeBridge() })); await quiet(() => runMirror({ dir, bridge: fakeBridge() })); }
    eq('daily／mirror 各跑 10 次，kv.secret 不變', q(dir, "SELECT v FROM kv WHERE k = 'secret'")[0].v, s0);
    { const db = new DatabaseSync(path.join(dir, 'bulletin.db')); db.exec("DELETE FROM kv WHERE k = 'secret'"); db.close(); }
    for (let i = 0; i < 3; i++) { await quiet(() => runDaily({ dir, bridge: fakeBridge() })); await quiet(() => runMirror({ dir, bridge: fakeBridge() })); }
    eq('庫裡缺 secret 時 daily／mirror 都不會寫入新的 secret', q(dir, "SELECT COUNT(*) AS n FROM kv WHERE k = 'secret'")[0].n, 0);
    const r = await runJob('daily.js', [], { DATA_DIR: dir, BRIDGE_URL: 'http://127.0.0.1:9/exec', BRIDGE_KEY: 'x'.repeat(40) });
    eq('（子程序）缺 secret 時 daily.js 也不寫 secret', [r.code, q(dir, "SELECT COUNT(*) AS n FROM kv WHERE k = 'secret'")[0].n], [1, 0]); }
  { const dir = tmp();   // M1 舊庫（沒有 driveSigId 欄）：mirror 不自己改表，回 ok:false
    const db = new DatabaseSync(path.join(dir, 'bulletin.db'));
    db.exec("CREATE TABLE posts (id TEXT PRIMARY KEY, json TEXT); CREATE TABLE staff (id TEXT PRIMARY KEY, json TEXT); CREATE TABLE reads (postId TEXT, staffId TEXT, name TEXT, unit TEXT, at TEXT, sigId TEXT); CREATE TABLE log (seq INTEGER PRIMARY KEY, at TEXT, action TEXT, target TEXT, summary TEXT); CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT);");
    db.close();
    const r = await quiet(() => runMirror({ dir, bridge: fakeBridge() }));
    eq('舊庫沒有 driveSigId：mirror ok:false、不自己 ALTER TABLE', [r.ok, q(dir, 'PRAGMA table_info(reads)').some((c) => c.name === 'driveSigId')], [false, false]);
    makeSqliteStore(dir).close();
    eq('伺服器（makeSqliteStore）啟動時補上 driveSigId 欄', q(dir, 'PRAGMA table_info(reads)').some((c) => c.name === 'driveSigId'), true); }
  { const dir = tmp();   // 沒有資料庫：背景工作不建空庫
    const r = await quiet(() => runMirror({ dir, bridge: fakeBridge() }));
    const d = await quiet(() => runDaily({ dir, bridge: fakeBridge() }));
    eq('沒有資料庫：mirror／daily 都 ok:false、不建 bulletin.db', [r.ok, d.ok, fs.existsSync(path.join(dir, 'bulletin.db'))], [false, false, false]); }

  // ================= C. 每日快照、保留天數、還原 =================
  { const dir = tmp(); seedDb(dir, 4);
    const bk = path.join(dir, 'backups'); fs.mkdirSync(bk);
    const old = (name, days) => { const p = path.join(bk, name); fs.writeFileSync(p, 'x'); const t = (Date.now() - days * 86400e3) / 1000; fs.utimesSync(p, t, t); return p; };
    const o20 = old('bulletin-2026-09-10_0330.db.gz', 20), o13 = old('bulletin-2026-09-17_0330.db.gz', 13), other = old('其他檔案.txt', 20);
    const B = fakeBridge();
    const r = await quiet(() => runDaily({ dir, bridge: B, now: new Date('2026-09-30T19:30:00Z') }));
    eq('快照：ok、檔名用台北時間、backup 1 次', [r.ok, r.file, B.n('backup')], [true, 'bulletin-2026-10-01_0330.db.gz', 1]);
    eq('保留策略：20 天前的假快照被清、13 天的留著、不是快照的檔案不動', [fs.existsSync(o20), fs.existsSync(o13), fs.existsSync(other), r.removed], [false, true, true, 1]);
    eq('backup-last.json＝{ at, ok, file, sizeKB, diskFreeMB }', (({ at, ok, file, sizeKB, diskFreeMB }) => [!!Date.parse(at), ok, file, sizeKB > 0, typeof diskFreeMB])(last(dir, 'backup-last.json')), [true, true, r.file, true, 'number']);
    eq('本機只留 .gz、沒有未壓縮暫存檔', fs.readdirSync(bk).filter((f) => /\.db$/.test(f)), []);
    eq('上傳內容＝本機 .gz 原檔（base64）', Buffer.from(B.backup.data, 'base64').equals(fs.readFileSync(path.join(bk, r.file))), true);
    const logLine = fs.readFileSync(path.join(dir, 'logs/daily.log'), 'utf8').split('\n').find((l) => l.includes('快照 ' + r.file));
    const logged = (/：(公告 \d+、同仁 \d+、已讀 \d+、紀錄 \d+)/.exec(logLine) || [])[1];
    eq('daily.log 記下快照筆數', logged, '公告 2、同仁 30、已讀 6、紀錄 1');

    // 還原演練：拿「雲端」那份（上傳的 base64）還原到乾淨的 DATA_DIR
    const cloud = path.join(tmp(), r.file); fs.writeFileSync(cloud, Buffer.from(B.backup.data, 'base64'));
    const clean = tmp('dzyb-restore-');
    const lines = [];
    const rr = await restore({ dir: clean, file: cloud, port: await freePort(), say: (s) => lines.push(s) });
    eq('還原後筆數＝daily.log 當日記的筆數', (/還原完成：(.*)$/.exec(lines.find((l) => l.startsWith('還原完成')) || '') || [])[1], logged);
    eq('還原：kv.secret 與原庫相同（同仁不用重新登入）', q(clean, "SELECT v FROM kv WHERE k = 'secret'")[0].v, q(dir, "SELECT v FROM kv WHERE k = 'secret'")[0].v);
    eq('乾淨目錄沒有 sigs/：已讀簽名圖都算「只在 Drive／兩邊都沒有」', [rr.sig.total, rr.sig.local], [5, 0]);
    fs.cpSync(path.join(dir, 'sigs'), path.join(clean, 'sigs'), { recursive: true });
    const S = await startServer(clean);
    eq('還原後起伺服器：/health 200、roster 正常', [(await request(S.port, 'GET', '/health')).status, (await api(S.port, 'roster')).json.ok], [200, true]);
    eq('還原的伺服器不能被第二次還原蓋掉（伺服器開著 → 拒絕）', await restore({ dir: clean, file: cloud, port: S.port, say: () => {} }).then(() => 'ok', (e) => /還開著/.test(e.message)), true);
    eq('拒絕時不留 .restoring 暫存檔', fs.existsSync(path.join(clean, 'bulletin.db.restoring')), false);
    await S.stop();
    const st = makeSqliteStore(clean);
    eq('還原後回條簽名圖看得到（本機 sigs/）', Object.values(st.getSigs('P-1')).filter((x) => x && x.startsWith('data:image/png')).length, 4);
    st.close();
    // M7（#18 D7）：restore.js 只換 bulletin.db，不碰 files/ 與 sigs/（兩個資料夾內容位元組不變）
    FL.writeMeta(clean, 'F-keep', { name: '保留.pdf', wantedAt: '2026-09-30T00:00:00.000Z', source: 'upload' }); fs.writeFileSync(FL.bytesPath(clean, 'F-keep'), crypto.randomBytes(4096));
    FL.writeMeta(clean, 'F-pend', { name: '待補.pdf', wantedAt: '2026-09-30T00:00:00.000Z', source: 'posts' });
    const digestDir = (d) => fs.readdirSync(d).sort().map((f) => f + ':' + crypto.createHash('sha256').update(fs.readFileSync(path.join(d, f))).digest('hex')).join('|');
    const beforeFiles = digestDir(path.join(clean, 'files')), beforeSigs = digestDir(path.join(clean, 'sigs'));
    // 子程序：不帶任何秘密（沒有 BRIDGE_*、沒有 .env）也能還原；舊庫改名保留
    const r2 = await runJob('restore.js', [cloud], { DATA_DIR: clean, PORT: String(await freePort()) });
    eq('M7：restore.js 還原後 files/ 與 sigs/ 內容位元組不變（檔名與 sha256 全同）', [r2.code, digestDir(path.join(clean, 'files')) === beforeFiles, digestDir(path.join(clean, 'sigs')) === beforeSigs, beforeFiles.split('|').length, beforeSigs.split('|').length > 0], [0, true, true, 3, true]);
    eq('restore.js 不依賴秘密：exit 0、印出同樣筆數', [r2.code, (/還原完成：(.*)/.exec(r2.out) || [])[1]], [0, logged]);
    eq('舊庫改名保留、不刪', fs.readdirSync(clean).some((f) => /^bulletin\.db\.before-restore-/.test(f)), true);
    const bad = path.join(tmp(), 'bad.db.gz'); fs.writeFileSync(bad, zlib.gzipSync(Buffer.from('not sqlite')));
    const r3 = await runJob('restore.js', [bad], { DATA_DIR: clean, PORT: String(await freePort()) });
    eq('壞快照：拒絕還原、現有資料庫不動', [r3.code, q(clean, 'SELECT COUNT(*) AS n FROM staff')[0].n], [1, 30]);
    eq('沒給快照檔：用法說明、exit 2', (await runJob('restore.js', [], { DATA_DIR: clean })).code, 2); }
  // #14 S3：換檔前 lsof／工作鎖／改名前殘留檢查；拿不到條件就拒絕並說明原因
  { const src = tmp(); seedDb(src, 2);
    const d0 = await quiet(() => runDaily({ dir: src, bridge: fakeBridge() }));
    const snapFile = path.join(src, 'backups', d0.file);
    const target = tmp(); seedDb(target, 5);
    const staffN = () => q(target, 'SELECT COUNT(*) AS n FROM reads')[0].n;
    const n0 = staffN();
    const tryRestore = (extra) => freePort().then((port) => restore(Object.assign({ dir: target, file: snapFile, port, say: () => {} }, extra)).then(() => 'ok', (e) => e.message));
    // (a) 另一個程序開著資料庫（例如伺服器卡住、或跑在別的 PORT、或 mirror／daily 拿著連線）
    const holder = spawn(process.execPath, ['-e', "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);d.exec('SELECT 1');console.log('ready');setInterval(()=>{},1e5)", path.join(target, 'bulletin.db')], { stdio: ['ignore', 'pipe', 'ignore'] });
    procs.push(holder);
    await new Promise((ok) => holder.stdout.once('data', ok));
    const ra = await tryRestore();
    eq('S3：別的程序開著資料庫 → lsof 查到、拒絕並列出 PID、資料庫不動', [/還有程序開著資料庫（PID /.test(ra) && ra.includes(String(holder.pid)), staffN(), fs.existsSync(path.join(target, 'bulletin.db.restoring'))], [true, n0, false]);
    // (b) 伺服器卡住不回 /health（只收連線不回應）＋同一個程序還拿著連線（審查重現）
    const hung = net.createServer(() => {}); await new Promise((ok) => hung.listen(0, '127.0.0.1', ok));
    holder.kill(); await new Promise((ok) => holder.on('exit', ok));
    const live = new DatabaseSync(path.join(target, 'bulletin.db')); live.exec('SELECT 1');
    const rb = await restore({ dir: target, file: snapFile, port: hung.address().port, say: () => {} }).then(() => 'ok', (e) => e.message);
    live.close(); hung.close();
    eq('S3：/health 沒回應但有連線開著 → 仍拒絕', [/還有程序開著資料庫/.test(rb), staffN()], [true, n0]);
    // (c) mirror 工作正在跑（鎖由活著的程序持有）
    const sleeper = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e5)'], { stdio: 'ignore' }); procs.push(sleeper);
    fs.mkdirSync(path.join(target, 'logs'), { recursive: true }); fs.writeFileSync(path.join(target, 'logs/mirror.lock'), String(sleeper.pid));
    const rc = await tryRestore();
    eq('S3：mirror 正在跑（mirror.lock）→ 拒絕', [/mirror 工作正在跑/.test(rc), staffN()], [true, n0]);
    eq('鎖由活著的程序持有時 mirror／daily 自己跳過（不寫結果檔、不開庫）', [(await runMirror({ dir: target, bridge: fakeBridge() })).busy], [true]);
    sleeper.kill(); await new Promise((ok) => sleeper.on('exit', ok));
    // 建議 5：lsof 被 signal 殺掉或異常結束 → 一律「無法確認」、拒絕
    const fakeBin = tmp('dzyb-bin-');
    fs.writeFileSync(path.join(fakeBin, 'lsof'), '#!/bin/sh\nkill -9 $$\n', { mode: 0o755 });
    const rk = await runJob('restore.js', [snapFile], { DATA_DIR: target, PORT: String(await freePort()), PATH: fakeBin + ':' + process.env.PATH });
    fs.writeFileSync(path.join(fakeBin, 'lsof'), '#!/bin/sh\nexit 2\n', { mode: 0o755 });
    const r2x = await runJob('restore.js', [snapFile], { DATA_DIR: target, PORT: String(await freePort()), PATH: fakeBin + ':' + process.env.PATH });
    eq('建議 5：lsof 被 signal 殺掉／exit 2 → 拒絕（無法確認）、資料庫不動', [rk.code, /lsof 無法執行或異常結束/.test(rk.err), r2x.code, /lsof 無法執行或異常結束/.test(r2x.err), staffN()], [1, true, 1, true, n0]);
    // S5：同一個 DATA_DIR 還原前鏡像過（lastSent 較大）→ 還原後 mirror 自己擋；restore 印出「mirror 沒有載回」
    await runMirror({ dir: target, bridge: fakeBridge() });
    // (d) 舊庫改名後、新庫就位前被重新建了 -wal（例如 KeepAlive 把伺服器拉起來）→ 改名前檢查到、拒絕，舊庫保留
    const rd = await tryRestore({ _afterMove: () => fs.writeFileSync(path.join(target, 'bulletin.db-wal'), 'x') });
    eq('S3：換檔途中出現 -wal → 拒絕、說明舊庫保留在哪、新庫沒有被放上去', [/換檔途中有程序重新開了資料庫（bulletin\.db-wal）/.test(rd), fs.existsSync(path.join(target, 'bulletin.db')), fs.readdirSync(target).some((f) => /^bulletin\.db\.before-restore-.*\d$/.test(f))], [true, false, true]);
    eq('拒絕後鎖都有放掉', [fs.existsSync(path.join(target, 'logs/mirror.lock')), fs.existsSync(path.join(target, 'logs/daily.lock'))], [false, false]);
    fs.unlinkSync(path.join(target, 'bulletin.db-wal'));
    const lines = [];
    const ro = await freePort().then((port) => restore({ dir: target, file: snapFile, port, say: (s) => lines.push(s) }).then(() => 'ok', (e) => e.message));
    eq('條件都滿足時照常還原', [ro, q(target, 'SELECT COUNT(*) AS n FROM reads')[0].n], ['ok', 4]);
    eq('S5：restore 不載回 mirror、印出確認後手動 --force 的提示', [lines.some((l) => /mirror 沒有載回/.test(l) && /mirror\.js --force/.test(l)), lines.some((l) => /bootstrap[^；]*com\.dzy\.bulletin\.mirror\.plist；/.test(l))], [true, false]);
    const rm = await runMirror({ dir: target, bridge: fakeBridge() });
    eq('S5：還原後第一輪鏡像被擋（本機筆數比上次鏡像少）', [rm.ok, /可能剛還原/.test(rm.error)], [false, true]); }
  { const dir = tmp(); seedDb(dir, 1);
    const bk = path.join(dir, 'backups'); fs.mkdirSync(bk);
    fs.writeFileSync(path.join(bk, 'bulletin-2026-09-29_0330.db.gz.tmp'), 'half');
    const r0 = await runDaily({ dir, bridge: fakeBridge() });
    eq('.gz 先寫暫存再改名：備份資料夾沒有 .tmp 以外的半成品、本輪沒留 .tmp', [r0.ok, fs.readdirSync(bk).filter((f) => f.endsWith('.tmp') && f.includes(r0.file)).length], [true, 0]);
    const r = await quiet(() => runDaily({ dir, bridge: fakeBridge({ backup: true }) }));
    eq('上傳失敗：ok:false、本機快照仍在、結果檔有時間戳', [r.ok, fs.existsSync(path.join(dir, 'backups', r.file)), !!Date.parse(last(dir, 'backup-last.json').at)], [false, true, true]); }

  // ================= 空庫不鏡像（M5 #10）：切換日 PRIMARY=mini 之後、搬遷之前，空的 Mac mini 庫不可蓋掉試算表 =================
  { const dir = tmp(); makeSqliteStore(dir).close();
    const B = fakeBridge();
    const r = await quiet(() => runMirror({ dir, bridge: B }));
    eq('空庫：mirror 拒絕（ok:false、錯誤寫明空庫）、一次橋接都沒打', [r.ok, /資料庫是空的/.test(r.error || ''), B.calls], [false, true, []]);
    eq('M7：空庫（還沒搬遷）第 3 步也不跑（fileget／filelist 0 次）', B.fcalls, []);
    const ml = last(dir, 'mirror-last.json');
    eq('空庫：mirror-last.json 照樣寫、at＝這一輪、ok:false、notMigrated:true、原因「尚未搬遷」', [ml.at === r.at && Date.now() - Date.parse(ml.at) < 60e3, ml.ok, ml.notMigrated, /資料庫是空的（尚未搬遷）/.test(ml.error)], [true, false, true, true]);
    const r2 = await quiet(() => runMirror({ dir, bridge: B }));
    eq('空庫：每一輪都更新 at（不會停在部署當下）', [Date.parse(last(dir, 'mirror-last.json').at) >= Date.parse(ml.at), r2.notMigrated, r2.fails], [true, true, 2]); }

  // ================= E. M7（#18）附件補齊：mirror.js 第 3 步（程序內、假橋接物件） =================
  { const MB = 1024 * 1024, PDF = 'application/pdf';
    const md5 = (b) => crypto.createHash('md5').update(b).digest('hex'), sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
    const iso = (ms) => new Date(ms).toISOString();
    const put = (B, id, size, extra) => { const buf = crypto.randomBytes(size); B.drive[id] = Object.assign({ name: id + '.pdf', mime: PDF, buf }, extra || {}); return buf; };
    const want = (dir, id, extra) => FL.writeMeta(dir, id, Object.assign({ name: id + '.pdf', wantedAt: iso(Date.now()), source: 'upload' }, extra || {}));
    const meta = (dir, id) => FL.readMeta(dir, id);
    const tmpLeft = (dir) => fs.readdirSync(path.join(dir, 'files')).filter((f) => /\.tmp/.test(f));
    const localBuf = (dir, id) => fs.readFileSync(FL.bytesPath(dir, id));
    const setPostFiles = (dir, files) => { const db = new DatabaseSync(path.join(dir, 'bulletin.db')); db.exec('PRAGMA busy_timeout = 5000');
      const p = JSON.parse(db.prepare("SELECT json FROM posts WHERE id = 'P-1'").get().json); p.files = files; db.prepare("UPDATE posts SET json = ? WHERE id = 'P-1'").run(JSON.stringify(p)); db.close(); };

    // 分段：20MB → fileget 3 次（8＋8＋4MB）、合併後 md5 相符、rename 成功
    { const dir = tmp(); seedDb(dir, 2);
      const B = fakeBridge(), buf = put(B, 'F-20MB', 20 * MB); want(dir, 'F-20MB', { name: '大檔.pdf' });
      const r = await quiet(() => runMirror({ dir, bridge: B }));
      const m = meta(dir, 'F-20MB');
      eq('M7 分段：20MB 附件 fileget 3 次、每段 8＋8＋4MB', [B.n('fileget'), B.segs], [3, [8 * MB, 8 * MB, 4 * MB]]);
      eq('M7 分段：合併後位元組與 md5 相符、rename 成功、沒有 .tmp、meta 補上 md5／sha256／savedAt／size', [localBuf(dir, 'F-20MB').equals(buf), m.md5, m.sha256, !!Date.parse(m.savedAt), m.size, m.name, tmpLeft(dir)],
        [true, md5(buf), sha(buf), true, 20 * MB, '大檔.pdf', []]);
      eq('M7 分段：files 結果 fetched 1、pending 0、count 1、bytes 20MB；鏡像照常 ok', [r.files.fetched, r.files.pending, r.files.count, r.files.bytes, r.files.failed, r.ok, B.calls], [1, 0, 1, 20 * MB, 0, true, ['sigs', 'mirror', 'clock']]);
      eq('M7：mirror-last.json 帶 files', last(dir, 'mirror-last.json').files.count, 1); }

    // 背景補齊：刪位元組（meta 留著）→ 下一輪補回；刪位元組與 meta、但公告仍引用 → 下一輪先補 meta 再補位元組
    { const dir = tmp(); seedDb(dir, 0);
      const B = fakeBridge(), a = put(B, 'F-A', 3000), b = put(B, 'F-B', 5000);
      setPostFiles(dir, [{ id: 'F-B', name: '公告附件.xlsx', type: 'xlsx', size: 5000 }]);
      want(dir, 'F-A');
      await quiet(() => runMirror({ dir, bridge: B }));
      eq('M7 補齊（前提）：F-A 由 meta 補、F-B 由公告引用補建 meta 後補抓', [localBuf(dir, 'F-A').equals(a), localBuf(dir, 'F-B').equals(b), meta(dir, 'F-B').source, meta(dir, 'F-B').name], [true, true, 'posts', '公告附件.xlsx']);
      fs.unlinkSync(FL.bytesPath(dir, 'F-A'));
      const r1 = await quiet(() => runMirror({ dir, bridge: B }));
      eq('M7 補齊：刪掉 F-A 位元組（meta 留著）→ 下一輪補回、pending 0', [localBuf(dir, 'F-A').equals(a), r1.files.fetched, r1.files.pending, meta(dir, 'F-A').source], [true, 1, 0, 'upload']);
      fs.unlinkSync(FL.bytesPath(dir, 'F-B')); fs.unlinkSync(FL.metaPath(dir, 'F-B'));
      const n0 = B.n('fileget');
      const r2 = await quiet(() => runMirror({ dir, bridge: B }));
      eq('M7 補齊：刪掉 F-B 位元組與 meta、公告仍引用 → 同一輪先補 meta（source:posts）再補位元組', [!!meta(dir, 'F-B'), meta(dir, 'F-B').source, localBuf(dir, 'F-B').equals(b), B.n('fileget') - n0, r2.files.pending, r2.files.count], [true, 'posts', true, 1, 0, 2]); }

    // 失敗語意：(a) BRIDGE_TIMEOUT (b) AUTH (c) file:null (d) md5 錯 → 留 pending、.tmp 不殘留、mirror.ok／pending／fails 不變、files.failed 有數字；下一輪恢復就補齊
    for (const mode of ['timeout', 'auth', 'null', 'md5', 'badoff']) {
      const dir = tmp(); seedDb(dir, 3);
      const B = fakeBridge(), buf = put(B, 'F-X', 9 * MB), ok2 = put(B, 'F-Y', 1000);
      want(dir, 'F-X', { wantedAt: iso(Date.now() - 1000) }); want(dir, 'F-Y');
      B.ffail = (op, p) => (op === 'fileget' && p.id === 'F-X' ? mode : null);
      const r = await quiet(() => runMirror({ dir, bridge: B }));
      eq(`M7 失敗語意（${mode}）：mirror.ok／pending／fails 不變、沒有 error`, [r.ok, r.pending, r.fails, r.error, r.uploaded], [true, 0, 0, undefined, 3]);
      eq(`M7 失敗語意（${mode}）：F-X 留 pending、files.failed 1、.tmp 不殘留、同一輪不重試、其他檔照常補`, [FL.hasBytes(dir, 'F-X'), r.files.failed, r.files.pending, tmpLeft(dir), B.fcalls.filter((x) => x === 'fileget').length >= 1, r.files.fetched, FL.hasBytes(dir, 'F-Y'), /^F-X（/.test((r.files.failedIds || [])[0])],
        [false, 1, 1, [], true, 1, true, true]);
      if (mode === 'timeout' || mode === 'auth' || mode === 'null') eq(`M7 失敗語意（${mode}）：同一輪只打 F-X 一次`, B.segs.length === 1 && B.fcalls.filter((x) => x === 'fileget').length, 2);
      const h = judgeHealth({ mirror: { at: r.at, ok: r.ok, sigPending: r.pending, fails: r.fails }, backup: { at: r.at, ok: true }, files: r.files, disk: { freeMB: 99999 } });
      eq(`M7 失敗語意（${mode}）：待補未滿 24 小時不轉燈`, h.level, 'green');
      B.ffail = null;
      const r2 = await quiet(() => runMirror({ dir, bridge: B }));
      eq(`M7 失敗語意（${mode}）：下一輪恢復正常就補齊`, [r2.files.fetched, r2.files.pending, r2.files.failed, localBuf(dir, 'F-X').equals(buf), md5(localBuf(dir, 'F-Y')) === md5(ok2)], [1, 0, 0, true, true]);
    }
    // 待補超過 24 小時 → stale（燈號黃）
    { const dir = tmp(); seedDb(dir, 0);
      const B = fakeBridge(); want(dir, 'F-OLD', { wantedAt: iso(Date.now() - 25 * 3600e3) }); want(dir, 'F-NEW');
      const r = await quiet(() => runMirror({ dir, bridge: B }));
      eq('M7 stale：Drive 找不到（暫時）的兩筆都留 pending；超過 24 小時的算 stale、/health 黃', [r.files.pending, r.files.stale, judgeHealth({ mirror: { at: r.at, ok: true, fails: 0 }, backup: { at: r.at, ok: true }, files: r.files, disk: { freeMB: 99999 } }).why],
        [2, 1, ['有附件超過 24 小時沒補齊']]); }

    // 人工略過：logs/file-skip.json 列的不再抓、計入 skipped、不轉黃；格式錯 → 這一輪不略過任何一個、files.ok:false（鏡像不受影響）
    { const dir = tmp(); seedDb(dir, 0);
      const B = fakeBridge(); put(B, 'F-S2', 100); want(dir, 'F-S1', { wantedAt: iso(Date.now() - 72 * 3600e3) }); want(dir, 'F-S2');
      fs.mkdirSync(path.join(dir, 'logs'), { recursive: true }); fs.writeFileSync(path.join(dir, 'logs/file-skip.json'), JSON.stringify({ 'F-S1': 'Drive 已永久刪除，確認放棄', 'F-typo': 'x' }));
      const r = await quiet(() => runMirror({ dir, bridge: B }));
      const h = judgeHealth({ mirror: { at: r.at, ok: true, fails: 0 }, backup: { at: r.at, ok: true }, files: r.files, disk: { freeMB: 99999 } });
      eq('M7 略過：F-S1 不抓（只抓 F-S2）、skipped 1、pending 0、stale 0、不轉黃、列出原因、對不到的 id 警告', [B.segs.length, r.files.skipped, r.files.pending, r.files.stale, h.level, r.files.skippedIds, /F-typo/.test((r.files.warnings || []).join()), r.files.ok],
        [1, 1, 0, 0, 'green', ['F-S1（Drive 已永久刪除，確認放棄）'], true, true]);
      B.drive['F-S1'] = { name: 'F-S1.pdf', mime: PDF, buf: crypto.randomBytes(50) };
      for (const badSkip of ['[1,2]', '{"F-S1": 1}', '{壞掉']) {
        fs.writeFileSync(path.join(dir, 'logs/file-skip.json'), badSkip);
        try { fs.unlinkSync(FL.bytesPath(dir, 'F-S1')); } catch (e) {}
        const rb = await quiet(() => runMirror({ dir, bridge: B }));
        eq(`M7 略過清單格式錯（${badSkip}）：files.ok:false、這一輪不略過任何一個（F-S1 照抓）、鏡像 ok 不受影響`, [rb.files.ok, /file-skip\.json 格式錯誤/.test(rb.files.error), rb.files.skipped, FL.hasBytes(dir, 'F-S1'), rb.ok, rb.fails], [false, true, 0, true, true, 0]);
      } }

    // 每輪上限：15 個 pending 一輪只抓 10 個；3 個各 50MB 一輪只抓 2 個
    { const dir = tmp(); seedDb(dir, 0);
      const B = fakeBridge(); for (let i = 0; i < 15; i++) { put(B, 'F-N' + i, 100); want(dir, 'F-N' + i); }
      const r = await quiet(() => runMirror({ dir, bridge: B }));
      eq('M7 上限：15 個 pending → 一輪抓 10 個、剩 5', [r.files.fetched, r.files.pending, B.n('fileget')], [10, 5, 10]);
      const r2 = await quiet(() => runMirror({ dir, bridge: B }));
      eq('M7 上限：下一輪補完剩下 5 個', [r2.files.fetched, r2.files.pending], [5, 0]); }
    { const dir = tmp(); seedDb(dir, 0);
      const B = fakeBridge(); for (let i = 0; i < 3; i++) { put(B, 'F-BIG' + i, 50 * MB); want(dir, 'F-BIG' + i, { size: 50 * MB, wantedAt: iso(Date.now() - (10 - i) * 1000) }); }
      const r = await quiet(() => runMirror({ dir, bridge: B }));
      eq('M7 上限：3 個各 50MB → 一輪只抓 2 個（100MB）、剩 1', [r.files.fetched, r.files.pending, r.files.bytes, FL.hasBytes(dir, 'F-BIG2')], [2, 1, 100 * MB, false]);
      const r1 = await quiet(() => runMirror({ dir, bridge: B, filesMaxMB: 1000 }));
      eq('M7 上限可調（FILES_MAX_MB_PER_RUN）：放大後補完', [r1.files.fetched, r1.files.pending], [1, 0]); }
    { const dir = tmp(); seedDb(dir, 0);                       // 預估會超量就停：3×40MB，第三個 40＋80＞100 → 一輪只抓 2 個（不是抓到 120MB 才停）
      const B = fakeBridge(); for (let i = 0; i < 3; i++) { put(B, 'F-40M' + i, 40 * MB); want(dir, 'F-40M' + i, { size: 40 * MB, wantedAt: iso(Date.now() - (10 - i) * 1000) }); }
      const r = await quiet(() => runMirror({ dir, bridge: B }));
      eq('第 1 輪建議 4a：3×40MB → 預估下一個會超過 100MB 就停，一輪只抓 2 個', [r.files.fetched, r.files.pending, r.files.bytes, B.n('fileget')], [2, 1, 80 * MB, 10]); }
    // 第 1 輪應修 1：補不到的檔不能把每輪額度吃光——從沒試過的先、再依 lastTryAt；Drive 找不到不算額度、死檔每輪最多再試 2 個
    { const dir = tmp(); seedDb(dir, 0);
      const B = fakeBridge(); const old = Date.now() - 5 * 86400e3;
      for (let i = 0; i < 15; i++) want(dir, 'F-DEAD' + i, { wantedAt: iso(old + i * 1000) });   // Drive 上都沒有（已被垃圾桶永久刪除）
      const r0 = await quiet(() => runMirror({ dir, bridge: B }));
      eq('應修 1（前提）：15 個死檔第一次都試過、file:null 不算額度（15 次 fileget）、都記 lastTryAt／lastDead', [B.n('fileget'), r0.files.failed, r0.files.pending, !!meta(dir, 'F-DEAD0').lastTryAt, meta(dir, 'F-DEAD0').lastDead], [15, 15, 15, true, true]);
      const buf = put(B, 'F-NEW', 2000); want(dir, 'F-NEW');
      const n0 = B.n('fileget');
      const r1 = await quiet(() => runMirror({ dir, bridge: B }));
      eq('應修 1：累積 15 個死檔之後，新附件仍在同一輪補到；死檔這一輪只重試 2 個', [FL.hasBytes(dir, 'F-NEW') && localBuf(dir, 'F-NEW').equals(buf), r1.files.fetched, B.n('fileget') - n0, r1.files.pending], [true, 1, 3, 15]);
      const tried1 = Array.from({ length: 15 }, (_, i) => 'F-DEAD' + i).filter((id) => meta(dir, id).lastTryAt !== meta(dir, 'F-DEAD14').lastTryAt || id === 'F-DEAD14');
      const r2 = await quiet(() => runMirror({ dir, bridge: B }));
      eq('應修 1：死檔依 lastTryAt 輪流重試（每輪 2 個、不會永遠是同兩個）', [r2.files.pending, B.n('fileget') - n0 - 3], [15, 2]);
      // 死檔之外還有別種失敗（md5 錯）也不會卡住新檔：試過的排到後面
      const bad = put(B, 'F-BADMD5', 500); want(dir, 'F-BADMD5', { wantedAt: iso(old - 1000) });
      B.ffail = (op, p) => (op === 'fileget' && p.id === 'F-BADMD5' ? 'md5' : null);
      await quiet(() => runMirror({ dir, bridge: B }));
      const nb = put(B, 'F-NEW2', 700); want(dir, 'F-NEW2');
      const r3 = await quiet(() => runMirror({ dir, bridge: B, filesMax: 1 }));
      eq('應修 1：額度只有 1 個時，從沒試過的新檔排在試過失敗的舊檔前面', [FL.hasBytes(dir, 'F-NEW2'), FL.hasBytes(dir, 'F-BADMD5'), r3.files.fetched], [true, false, 1]);
      void bad; void nb; void tried1; B.ffail = null; }
    // 建議 1：lastScanAt 壞掉 → 當作沒掃過、這一輪重掃並重寫（不永久失敗）
    { const dir = tmp(); seedDb(dir, 0);
      const B = fakeBridge(); put(B, 'F-LS', 100);
      await quiet(() => runMirror({ dir, bridge: B }));
      const L0 = last(dir, 'mirror-last.json'); L0.files.lastScanAt = '壞掉的時間'; fs.writeFileSync(path.join(dir, 'logs/mirror-last.json'), JSON.stringify(L0));
      const nl = B.n('filelist');
      const r = await quiet(() => runMirror({ dir, bridge: B }));
      eq('建議 1：lastScanAt 壞掉 → 重掃一次、寫回正確時間、files.ok', [B.n('filelist') - nl, !isNaN(Date.parse(r.files.lastScanAt)), r.files.ok, r.files.error], [1, true, true, undefined]);
      await quiet(() => runMirror({ dir, bridge: B }));
      eq('建議 1：之後同一天不再掃', B.n('filelist') - nl, 1); }
    // 建議 2：補抓期間主管移除附件（markRemoved 寫了 removedAt）→ 補抓完寫 meta 不可蓋掉
    { const dir = tmp(); seedDb(dir, 0);
      const B = fakeBridge(); put(B, 'F-RM', 3000); want(dir, 'F-RM');
      const stamp = '2026-10-01T01:02:03.000Z';
      B.onGet = (p) => { if (p.id === 'F-RM') { const m = meta(dir, 'F-RM'); FL.writeMeta(dir, 'F-RM', Object.assign(m, { removedAt: stamp })); } };
      await quiet(() => runMirror({ dir, bridge: B }));
      eq('建議 2：下載中途被移除 → 補抓完 removedAt 仍是移除當下的時間、位元組已存', [meta(dir, 'F-RM').removedAt, FL.hasBytes(dir, 'F-RM'), !!meta(dir, 'F-RM').savedAt], [stamp, true, true]); }
    // 建議 5：--files 分批、每批放掉鏡像鎖（每小時那輪插得進來）
    { const dir = tmp(); seedDb(dir, 0);
      const B = fakeBridge(); for (let i = 0; i < 25; i++) { put(B, 'F-BT' + i, 100); want(dir, 'F-BT' + i); }
      await quiet(() => runMirror({ dir, bridge: B, filesMax: 1 }));
      const grabbed = [];
      const rf = await quiet(() => runFilesOnly({ dir, bridge: B, waitMs: 10, _betweenBatches: async (n) => {
        const rel = J_lock(dir); grabbed.push(!!rel);           // 模擬每小時那輪在批次之間拿到鎖、跑一下再放掉
        if (rel) setTimeout(rel, 30);
      } }));
      eq('建議 5：--files 分 3 批（10＋10＋4）、批次之間鎖都放掉（另一輪拿得到）、仍補到 pending=0', [rf.files.batches, grabbed, rf.files.fetched, rf.files.pending], [3, [true, true], 24, 0]); }

    // --all 不做第 3 步（fileget 0 次、files 沿用上一輪）；--files 不設上限補到 pending=0
    { const dir = tmp(); seedDb(dir, 3);
      const B = fakeBridge(); for (let i = 0; i < 15; i++) { put(B, 'F-M' + i, 200); want(dir, 'F-M' + i); }
      const r0 = await quiet(() => runMirror({ dir, bridge: B, filesMax: 1 }));
      const n0 = B.fcalls.length;
      const ra = await quiet(() => runMirror({ dir, bridge: B, all: true }));
      eq('M7 --all：不執行第 3 步（fileget／filelist 0 次）、files 沿用上一輪、回退門檻 pending 照常', [B.fcalls.length - n0, JSON.stringify(ra.files) === JSON.stringify(r0.files), ra.pending, ra.ok], [0, true, 0, true]);
      eq('M7 --all：mirror-last.json 的 files 仍在（lastScanAt 不遺失）', last(dir, 'mirror-last.json').files.lastScanAt, r0.files.lastScanAt);
      const before = last(dir, 'mirror-last.json');
      const rf = await quiet(() => runFilesOnly({ dir, bridge: B }));
      const after = last(dir, 'mirror-last.json');
      eq('M7 --files：不設上限一次補到 pending=0（14 個）', [rf.files.fetched, rf.files.pending, rf.files.count], [14, 0, 15]);
      eq('M7 --files：只更新 files，鏡像欄位 at／ok／pending／fails 原樣保留、不打簽名與鏡像', [after.at, after.ok, after.pending, after.fails, after.files.count, B.calls.filter((x) => x === 'mirror').length], [before.at, before.ok, before.pending, before.fails, 15, 2]);
      const rel = J_lock(dir);
      eq('M7 --files：撞到另一輪正在跑 → busy', (await runFilesOnly({ dir, bridge: B })).busy, true);
      rel(); }

    // filelist：3 個檔（1 個 trashed、1 個非白名單 mime）→ 建 2 個 meta、trashed 的有 removedAt；--files-scan 與「當天第一輪（台北日期）」各觸發一次、同一天第二輪不掃
    { const dir = tmp(); seedDb(dir, 0);
      const B = fakeBridge(); put(B, 'F-L1', 300); put(B, 'F-L2', 400, { trashed: true, name: '已移除.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
      B.extraList = [{ id: 'F-L3', name: '照片.jpg', mime: 'image/jpeg', size: 3, md5: 'x', trashed: false }];
      const d1 = Date.parse('2026-10-01T23:30:00+08:00'), sameDay = Date.parse('2026-10-01T23:50:00+08:00'), nextDay = Date.parse('2026-10-02T00:30:00+08:00');   // 後兩個是同一個 UTC 日、不同的台北日
      const lists = () => B.fcalls.filter((x) => x === 'filelist').length;
      const r1 = await quiet(() => runMirror({ dir, bridge: B, now: d1 }));
      eq('M7 filelist：建 2 個 meta（白名單），照片不建；trashed 的有 removedAt、source:filelist', [lists(), !!meta(dir, 'F-L1'), !!meta(dir, 'F-L2'), meta(dir, 'F-L3'), meta(dir, 'F-L2').source, !!Date.parse(meta(dir, 'F-L2').removedAt), meta(dir, 'F-L2').trashed, meta(dir, 'F-L1').removedAt],
        [1, true, true, null, 'filelist', true, true, undefined]);
      eq('M7 filelist：掃到的附件同一輪補抓（含垃圾桶內的）、lastScanAt＝這一輪', [r1.files.fetched, r1.files.count, r1.files.pending, r1.files.lastScanAt, r1.files.scanned], [2, 2, 0, iso(d1), 2]);
      await quiet(() => runMirror({ dir, bridge: B, now: sameDay }));
      eq('M7 filelist：同一天（台北）第二輪不再掃', lists(), 1);
      await quiet(() => runMirror({ dir, bridge: B, now: nextDay }));
      eq('M7 filelist：台北日期換了的第一輪自動掃一次（同一個 UTC 日也算）', lists(), 2);
      await quiet(() => runMirror({ dir, bridge: B, now: nextDay + 60e3 }));
      eq('M7 filelist：換日後的第二輪不再掃', lists(), 2);
      await quiet(() => runFilesOnly({ dir, bridge: B, scan: true, now: nextDay + 120e3 }));
      eq('M7 --files-scan：手動強制掃一次', lists(), 3);
      B.ffail = (op) => (op === 'filelist' ? 'timeout' : null);
      const rx = await quiet(() => runMirror({ dir, bridge: B, now: nextDay + 86400e3 }));
      eq('M7 filelist 失敗：暫時故障（lastScanAt 不動、files.ok:false）、鏡像 ok 不受影響、下一輪再掃', [rx.files.lastScanAt, rx.files.ok, rx.ok, rx.fails], [iso(nextDay + 120e3), false, true, 0]);
      B.ffail = null;
      const ry = await quiet(() => runMirror({ dir, bridge: B, now: nextDay + 86400e3 + 60e3 }));
      eq('M7 filelist 恢復：下一輪補掃', [lists(), ry.files.lastScanAt], [5, iso(nextDay + 86400e3 + 60e3)]);
      // 已有 meta（例如回退到 GAS 期間主管移除的）但 Drive 上已在垃圾桶 → 掃描時補標 removedAt
      B.drive['F-L1'].trashed = true;
      await quiet(() => runFilesOnly({ dir, bridge: B, scan: true }));
      eq('M7 filelist：已有 meta、Drive 端已丟垃圾桶 → 補標 removedAt、位元組不動', [!!meta(dir, 'F-L1').removedAt, FL.hasBytes(dir, 'F-L1')], [true, true]); }

    // fileId 防路徑穿越：公告引用非法 id 不建 meta、不打 fileget
    { const dir = tmp(); seedDb(dir, 0);
      const B = fakeBridge(); setPostFiles(dir, [{ id: '../../evil', name: 'x.pdf' }, { id: 'a/b', name: 'y.pdf' }]);
      await quiet(() => runMirror({ dir, bridge: B }));
      eq('M7 id 驗證：非法 fileId 不建 meta、不打 fileget、DATA_DIR 外沒有多出檔案', [fs.existsSync(path.join(dir, 'files')) ? fs.readdirSync(path.join(dir, 'files')) : [], B.n('fileget'), fs.existsSync(path.join(dir, '..', 'evil.json'))], [[], 0, false]);
      let e1 = null; try { FL.bytesPath(dir, '../x'); } catch (e) { e1 = e.code; }
      eq('M7 id 驗證：files-local 拒絕非法 id', e1, 'BAD_ID'); }
  }

  // ================= /health 判定（純函式） =================
  { const now = Date.parse('2026-09-30T12:00:00Z'), ago = (h) => new Date(now - h * 3600e3).toISOString();
    const H = (m, b, free) => judgeHealth({ mirror: m, backup: b, disk: { freeMB: free === undefined ? 50000 : free } }, now);
    const okM = { at: ago(0.5), ok: true, sigPending: 0, fails: 0 }, okB = { at: ago(5), ok: true };
    eq('全部正常 → green', H(okM, okB), { level: 'green', why: [] });
    eq('#26 remind：null／ok=true 不影響、ok=false → 黃', [judgeHealth({ mirror: okM, backup: okB, remind: null, disk: { freeMB: 50000 } }, now).level,
      judgeHealth({ mirror: okM, backup: okB, remind: { at: ago(1), ok: true, people: 2 }, disk: { freeMB: 50000 } }, now).level,
      judgeHealth({ mirror: okM, backup: okB, remind: { at: ago(1), ok: false, people: 2 }, disk: { freeMB: 50000 } }, now)],
      ['green', 'green', { level: 'yellow', why: ['未簽提醒送出失敗'] }]);
    eq('mirror.at > 3h → yellow；> 6h → red', [H(Object.assign({}, okM, { at: ago(3.5) }), okB).level, H(Object.assign({}, okM, { at: ago(6.5) }), okB).level], ['yellow', 'red']);
    eq('backup.at > 26h → red（25h 還是 green）', [H(okM, { at: ago(26.5), ok: true }).level, H(okM, { at: ago(25), ok: true }).level], ['red', 'green']);
    eq('mirror 連續失敗 1 次不黃、2 次黃', [H(Object.assign({}, okM, { ok: false, fails: 1 }), okB).level, H(Object.assign({}, okM, { ok: false, fails: 2 }), okB).level], ['green', 'yellow']);
    eq('backup.ok=false → yellow；disk < 5000 → yellow；pending > 200 → yellow', [H(okM, { at: ago(1), ok: false }).why, H(okM, okB, 4999).why, H(Object.assign({}, okM, { sigPending: 201 }), okB).why],
      [['快照失敗'], ['磁碟剩餘不足 5GB'], ['待回填簽名超過 200 張']]);
    eq('從沒跑過 → red', H(null, null).level, 'red');
    eq('備份資料夾有共用者 → yellow；0／-1（讀不到）／沒回報不判', [H(okM, Object.assign({}, okB, { sharedWith: 1 })).why, H(okM, Object.assign({}, okB, { sharedWith: 0 })).level, H(okM, Object.assign({}, okB, { sharedWith: -1 })).level, H(okM, Object.assign({}, okB, { sharedWith: null })).level],
      [['備份資料夾有共用者'], 'green', 'yellow', 'green']);
    eq('sharedWith=-1 → 黃「備份資料夾權限讀不到」', H(okM, Object.assign({}, okB, { sharedWith: -1 })).why, ['備份資料夾權限讀不到']);
    eq('時間戳比現在晚 5 分鐘以上 → 黃（4 分鐘不判）', [H(Object.assign({}, okM, { at: ago(-24 * 30) }), okB).why, H(okM, Object.assign({}, okB, { at: ago(-0.1) })).level, H(okM, Object.assign({}, okB, { at: ago(-4 / 60) })).level],
      [['時間戳異常（比現在還晚）'], 'yellow', 'green']);
    eq('mirror.bad／missing > 0 → 黃', [H(Object.assign({}, okM, { bad: 1 }), okB).why, H(Object.assign({}, okM, { missing: 2 }), okB).why], [['有壞簽名圖'], ['本機缺簽名圖']]);
    eq('尚未搬遷（notMigrated）→ 最多黃「尚未搬遷」：不判「鏡像連續失敗」、鏡像超過 6 小時也不判紅；快照規則照常',
      [H(Object.assign({}, okM, { ok: false, fails: 5, notMigrated: true }), okB), H(Object.assign({}, okM, { at: ago(4), ok: false, fails: 5, notMigrated: true }), okB), H(Object.assign({}, okM, { notMigrated: true }), { at: ago(27), ok: true }).level],
      [{ level: 'yellow', why: ['尚未搬遷'] }, { level: 'yellow', why: ['尚未搬遷'] }, 'red']);
    eq('第 1 輪應修 2：notMigrated 只蓋「連續失敗」與「超過 3 小時」；鏡像超過 6 小時沒跑的紅燈照判（at 變舊＝mirror 死了）',
      [H(Object.assign({}, okM, { at: ago(6.5), ok: false, fails: 7, notMigrated: true }), okB), H(Object.assign({}, okM, { at: ago(48), notMigrated: true }), okB).level],
      [{ level: 'red', why: ['鏡像超過 6 小時沒跑', '尚未搬遷'] }, 'red']);
    eq('結果檔讀不到（at 為 null）→ 紅、寫「結果檔讀不到」', H({ at: null, ok: false }, { at: null, ok: false }).why.slice(0, 2), ['鏡像結果檔讀不到', '快照結果檔讀不到']);
    const HF = (files) => judgeHealth({ mirror: okM, backup: okB, files, disk: { freeMB: 50000 } }, now);
    eq('M7：files.stale > 0 → 黃「有附件超過 24 小時沒補齊」；pending > 0 且 stale = 0 → 綠；沒有 files（還沒跑過第 3 步）→ 綠',
      [HF({ count: 3, bytes: 9, pending: 2, stale: 1, skipped: 0, lastScanAt: null }), HF({ count: 3, bytes: 9, pending: 5, stale: 0, skipped: 2, lastScanAt: null }).level, HF(null).level],
      [{ level: 'yellow', why: ['有附件超過 24 小時沒補齊'] }, 'green', 'green']); }

  // ================= launchd 範本：三個 job、佔位字串、不含金鑰 =================
  { const { execFileSync } = require('child_process');
    const L = path.join(ROOT, 'server/launchd');
    const pl = (f) => JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', path.join(L, f)], { encoding: 'utf8' }));
    const s = pl('com.dzy.bulletin.plist'), m = pl('com.dzy.bulletin.mirror.plist'), d = pl('com.dzy.bulletin.daily.plist');
    eq('launchd：三個 Label', [s.Label, m.Label, d.Label], ['com.dzy.bulletin', 'com.dzy.bulletin.mirror', 'com.dzy.bulletin.daily']);
    eq('launchd：伺服器 KeepAlive、mirror StartInterval 3600、daily 每天一次', [s.KeepAlive, s.RunAtLoad, m.StartInterval, m.RunAtLoad, d.StartCalendarInterval], [true, true, 3600, true, { Hour: 3, Minute: 30 }]);
    eq('launchd：指到對的腳本、路徑用佔位字串', [s, m, d].map((x) => [x.ProgramArguments[0], x.ProgramArguments[1].replace('__REPO__/server/', ''), x.EnvironmentVariables.DATA_DIR]),
      [['__NODE__', 'index.js', '__DATA_DIR__'], ['__NODE__', 'mirror.js', '__DATA_DIR__'], ['__NODE__', 'daily.js', '__DATA_DIR__']]);
    eq('launchd：範本不含金鑰（金鑰只在 server/.env）', fs.readdirSync(L).some((f) => /BRIDGE_KEY<\/key>|BRIDGE_URL<\/key>/.test(fs.readFileSync(path.join(L, f), 'utf8'))), false); }

  // ================= D. 端到端：假 Google（gas/*.js）＋ E2E 伺服器＋子程序 job =================
  { const FG = makeFakeGas();
    const URL0 = await FG.listen();
    const KEY = 'k'.repeat(40);                              // 測試用假金鑰（非正式）
    Object.assign(FG.props, { BRIDGE_KEY: KEY, PRIMARY: 'mini', TOKEN_SECRET: 'test-secret' });
    const dir = tmp('dzyb-e2e-');
    const S = await startServer(dir, { E2E: '1' });
    const JOB = { DATA_DIR: dir, BRIDGE_URL: URL0, BRIDGE_KEY: KEY };
    const BAD = { DATA_DIR: dir, BRIDGE_URL: 'http://127.0.0.1:' + (await freePort()) + '/exec', BRIDGE_KEY: KEY };
    await request(S.port, 'POST', '/__seed', { demo: true });
    const tok = (await api(S.port, 'setPin', { staffId: 'S-013', pin: '2580' })).json.data.token;
    const board = (await api(S.port, 'board', { token: tok })).json.data;
    const todo = board.posts.map((p) => p.id).filter((id) => !board.myReads[id]);
    const acks = []; for (const id of todo) { if (acks.length >= 3) break; if ((await api(S.port, "ack", { token: tok, postId: id, sig: PNG(id) })).json.ok) acks.push(id); }
    // 之後再簽的用其他同仁（S-013 能簽的公告已簽完）：回傳第一筆簽成功的回應
    const signAs = async (tag) => {
      let last = null;
      for (let i = 1; i <= 12; i++) {
        const t = (await api(S.port, 'login', { staffId: 'S-' + String(i).padStart(3, '0'), pin: '0000' })).json.data.token;
        const b = (await api(S.port, 'board', { token: t })).json.data;
        for (const id of b.posts.map((p) => p.id).filter((id) => !b.myReads[id])) { last = await api(S.port, 'ack', { token: t, postId: id, sig: PNG(tag + id) }); if (last.json.ok) return last; }
      }
      return last;
    };
    eq('（前提）簽 3 筆', q(dir, "SELECT COUNT(*) AS n FROM reads WHERE sigId <> ''")[0].n, 3);

    let r = await runJob('mirror.js', [], JOB);
    const ml = last(dir, 'mirror-last.json');
    eq('簽 3 筆 → 下一輪 3 筆都有 driveSigId、pending 0', [r.code, ml.ok, ml.uploaded, ml.pending, q(dir, "SELECT COUNT(*) AS n FROM reads WHERE sigId <> '' AND driveSigId <> ''")[0].n], [0, true, 3, 0, 3]);
    const sigFolder = FG.props.SIG_FOLDER_ID;
    eq('Drive 簽名資料夾多 3 個檔、1 次 sigs 呼叫', [Object.values(FG.drive.files).filter((f) => f.parent === sigFolder).length, FG.st.hits.sigs], [3, 1]);
    const rows = FG.sheetRows('已讀'), db = q(dir, 'SELECT postId, staffId, name, unit, at, sigId, driveSigId FROM reads ORDER BY rowid');
    eq('鏡像後「已讀」筆數與 Mac mini 一致', rows.length, db.length);
    const signedRows = db.filter((x) => x.sigId);
    eq('抽 3 筆簽名：試算表的簽名檔 id＝Drive id（不是 Mac mini 檔名）', signedRows.map((x) => { const row = rows.find((y) => y[0] === x.postId && y[1] === x.staffId); return [row[4] === x.at, row[5] === x.driveSigId, !!FG.drive.files[row[5]]]; }), [[true, true, true], [true, true, true], [true, true, true]]);
    eq('Drive 上的簽名圖內容＝本機簽名圖', signedRows.every((x) => Buffer.from(FG.drive.files[x.driveSigId].bytes.map((b) => b & 255)).equals(fs.readFileSync(path.join(dir, 'sigs', x.sigId)))), true);
    eq('鏡像後公告／同仁筆數一致', [FG.sheetRows('公告').length, FG.sheetRows('同仁').length], [q(dir, 'SELECT COUNT(*) AS n FROM posts')[0].n, q(dir, 'SELECT COUNT(*) AS n FROM staff')[0].n]);
    r = await runJob('daily.js', [], JOB);
    const bl = last(dir, 'backup-last.json');
    const bkFolder = FG.props.BACKUP_FOLDER_ID;
    eq('daily.js：ok、備份檔落在獨立備份資料夾、分享「限制」', [r.code, bl.ok, !!FG.drive.files[bl.driveId], FG.drive.files[bl.driveId].parent === bkFolder, FG.drive.files[bl.driveId].sharing], [0, true, true, true, 'PRIVATE']);
    let h = (await request(S.port, 'GET', '/health')).json;
    eq('/health 讀兩個檔：mirror／backup 的 at 與結果檔一致（含 missing／bad／skipped）', [h.mirror.at, h.mirror.ok, h.mirror.sigPending, h.mirror.fails, h.mirror.missing, h.mirror.bad, h.mirror.skipped, h.backup.at, h.backup.ok], [ml.at, true, 0, 0, 0, 0, 0, bl.at, true]);
    eq('備份資料夾僅 owner：sharedWith 0 記進結果檔、/health 帶出', [bl.sharedWith, h.backup.sharedWith], [0, 0]);
    eq('/health 兩個 job 剛跑完：沒有紅燈、沒有鏡像／快照相關的黃燈', [h.level !== 'red', h.why.filter((w) => /鏡像|快照|回填/.test(w))], [true, []]);

    FG.drive.folders[bkFolder].editors = [{ email: 'x' }];      // 有人把備份資料夾加了共用者 → 下一次快照回報、/health 黃燈
    r = await runJob('daily.js', [], JOB);
    h = (await request(S.port, 'GET', '/health')).json;
    eq('備份資料夾被加共用者：sharedWith 1、/health 黃燈原因含「備份資料夾有共用者」', [r.code, last(dir, 'backup-last.json').sharedWith, h.backup.sharedWith, h.why.includes('備份資料夾有共用者'), h.level === 'red' ? 'red' : 'not-red'], [0, 1, 1, true, 'not-red']);
    delete FG.drive.folders[bkFolder].editors;

    // 驗收 1：BRIDGE_URL 改錯 → *-last.json ok:false 帶時間戳；/health 仍 200、同仁照樣能簽名
    r = await runJob('mirror.js', [], BAD);
    const r2 = await runJob('mirror.js', [], BAD);
    const rd = await runJob('daily.js', [], BAD);
    const mf = last(dir, 'mirror-last.json'), bf = last(dir, 'backup-last.json');
    eq('BRIDGE_URL 錯：mirror.js／daily.js exit 1、ok:false 帶時間戳', [r.code, r2.code, rd.code, mf.ok, !!Date.parse(mf.at), bf.ok, !!Date.parse(bf.at)], [1, 1, 1, false, true, false, true]);
    const hr = await request(S.port, 'GET', '/health');
    eq('BRIDGE_URL 錯：/health 仍 200、mirror 連續失敗 2 次＋快照失敗 → 黃燈', [hr.status, hr.json.mirror.fails, hr.json.why.includes('鏡像連續失敗'), hr.json.why.includes('快照失敗'), hr.json.level === 'red' ? 'red' : 'not-red'], [200, 2, true, true, 'not-red']);
    const ack = await signAs('after');
    eq('BRIDGE_URL 錯：同仁照樣能簽名', ack.json.ok, true);
    eq('/health 不帶錯誤原文', /127\.0\.0\.1|BRIDGE|fetch/.test(JSON.stringify(hr.json)), false);

    // Google 回一次非 JSON（500 錯誤頁）→ 橋接層自動重試一次就成功（2026-09-30 切換當天發現的 404 頁問題）；
    // 「Drive 端整批失敗、同一輪不重試」由其他 null 情境的測試驗
    FG.st.hits = {}; FG.st.failNext = 'sigs';
    r = await runJob('mirror.js', [], JOB);
    eq('sigs 回一次非 JSON：橋接重試一次成功（sigs 2 次）、鏡像照做、pending 0', [r.code, FG.st.hits.sigs, FG.st.hits.mirror, last(dir, 'mirror-last.json').pending], [0, 2, 1, 0]);
    r = await runJob('mirror.js', [], JOB);
    eq('下一輪補上：pending 0、fails 歸 0', [r.code, last(dir, 'mirror-last.json').pending, last(dir, 'mirror-last.json').fails], [0, 0, 0]);

    // 鏡像寫到一半丟錯（M2 暫存分頁）：正式四分頁仍是上一輪；PRIMARY=gas 時 mirror 被拒、試算表不動
    const snap = () => JSON.stringify(['公告', '同仁', '已讀', '操作紀錄'].map((n) => FG.book.getSheetByName(n).data));
    const good = snap();
    eq('（前提）再簽 1 筆', (await signAs('x')).json.ok, true);
    FG.st.throwOnWrite = '操作紀錄__鏡像中';
    r = await runJob('mirror.js', [], JOB);
    eq('mirror 寫到一半丟錯：ok:false、正式四分頁仍是上一輪', [r.code, last(dir, 'mirror-last.json').ok, snap() === good], [1, false, true]);
    FG.st.throwOnWrite = null; FG.props.PRIMARY = 'gas';
    r = await runJob('mirror.js', [], JOB);
    eq('PRIMARY=gas：mirror 被拒（ok:false）、試算表不動', [r.code, snap() === good], [1, true]);
    FG.props.PRIMARY = 'mini';
    r = await runJob('mirror.js', [], JOB);
    eq('恢復後鏡像成功、新簽名進試算表', [r.code, FG.sheetRows('已讀').length], [0, q(dir, 'SELECT COUNT(*) AS n FROM reads')[0].n]);

    // #14 S6（配合 M2 316ef4e）：分頁有重複列＋空白列（搬遷自 GAS 的 append 殘留），鏡像仍被接受
    const sh = FG.book.getSheetByName('已讀'); sh.data.push(sh.data[1].slice(), sh.data[2].slice(), ['', '', '', '', '', '']); FG.bumpGen();
    r = await runJob('mirror.js', [], JOB);
    eq('S6：分頁已讀有 2 列重複＋1 列空白 → mirror.js 鏡像仍被接受、分頁換成去重後的資料', [r.code, last(dir, 'mirror-last.json').ok, FG.sheetRows('已讀').length], [0, true, q(dir, 'SELECT COUNT(*) AS n FROM reads')[0].n]);
    // S5 端到端：本機已讀變少（模擬還原）→ mirror.js 自己擋；--force → 帶 force:true，Apps Script 放行、試算表跟著本機
    { const w = new DatabaseSync(path.join(dir, 'bulletin.db')); w.exec('PRAGMA busy_timeout = 5000'); w.exec('DELETE FROM reads WHERE rowid = (SELECT MAX(rowid) FROM reads)'); w.close(); }
    const nLocal = q(dir, 'SELECT COUNT(*) AS n FROM reads')[0].n, sheetBefore = FG.sheetRows('已讀').length;
    FG.st.hits = {};
    r = await runJob('mirror.js', [], JOB);
    eq('S5：本機已讀少 1 → mirror.js 不送（沒有 mirror 呼叫）、exit 1、試算表不動', [r.code, FG.st.hits.mirror || 0, FG.sheetRows('已讀').length], [1, 0, sheetBefore]);
    r = await runJob('mirror.js', ['--force'], JOB);
    eq('S5：--force → Apps Script 放行（M2 已讀不減防呆靠 force:true 越過）、試算表＝本機', [r.code, FG.sheetRows('已讀').length, /鏡像完成/.test(r.out)], [0, nLocal, true]);

    // ---- M7（#18）端到端：真的 gas/*.js（fileget／filelist）＋子程序 mirror.js --files-scan／--files／--files-verify ----
    { const vmx = require('vm'), attach = vmx.runInContext('attachFolder_().getId()', FG.G), sigF = vmx.runInContext('sigFolder_().getId()', FG.G);
      const mk = (name, mime, bytes, parent, trashed) => { const id = 'G' + (++FG.drive.seq); FG.drive.files[id] = { name, mime, bytes: Array.from(bytes).map((b) => (b > 127 ? b - 256 : b)), parent, sharing: 'PRIVATE', created: Date.now(), trashed: !!trashed }; return id; };
      const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      const big = crypto.randomBytes(20 * 1024 * 1024 + 5);
      const good = [mk('a.pdf', 'application/pdf', crypto.randomBytes(1000), attach), mk('b.xlsx', XLSX, crypto.randomBytes(2000), attach), mk('大檔.pdf', 'application/pdf', big, attach)];
      const trashedId = mk('已移除.pdf', 'application/pdf', crypto.randomBytes(500), attach, true);
      const outside = [mk('照片.jpg', 'image/jpeg', [1, 2, 3], attach), mk('Google 文件', 'application/vnd.google-apps.document', [1], attach), mk('簽名.png', 'image/png', [1], sigF), mk('根目錄.pdf', 'application/pdf', [1], 'ROOT')];
      // 示範資料（/__seed demo）的公告引用 demo-1～8，假 Drive 沒有 → 先由人寫進 file-skip.json（順便驗略過清單在子程序也生效）
      const demoSkip = Object.fromEntries(Array.from({ length: 8 }, (_, i) => ['demo-' + (i + 1), '示範資料，不在 Drive']));
      fs.writeFileSync(path.join(dir, 'logs/file-skip.json'), JSON.stringify(demoSkip));
      FG.st.hits = {};
      r = await runJob('mirror.js', ['--files-scan'], JOB);
      const hasM = (id) => !!FL.readMeta(dir, id);
      eq('M7 E2E --files-scan：exit 0、印出 count／pending=0', [r.code, /附件補齊完成｜count=4｜bytes=\d+｜pending=0｜stale=0｜fetched=4｜failed=0｜skipped=8/.test(r.out)], [0, true]);
      eq('M7 E2E --files-scan：附件資料夾的 3 個＋垃圾桶 1 個都有 meta 與位元組；照片／Google 文件／簽名圖／根目錄 PDF 一律沒有', [good.concat([trashedId]).map((id) => hasM(id) && FL.hasBytes(dir, id)), outside.map(hasM)], [[true, true, true, true], [false, false, false, false]]);
      eq('M7 E2E：20MB 附件經真的 gas fileget 分 3 段、位元組相同；垃圾桶的有 removedAt', [FG.st.hits.fileget, fs.readFileSync(FL.bytesPath(dir, good[2])).equals(big), !!FL.readMeta(dir, trashedId).removedAt, FL.readMeta(dir, trashedId).md5.length], [3 + 3, true, true, 32]);
      const ml = last(dir, 'mirror-last.json');
      eq('M7 E2E --files-scan：只更新 files，鏡像欄位不動', [ml.files.count, ml.files.pending, !!ml.files.lastScanAt, ml.ok, ml.fails], [4, 0, true, true, 0]);
      h = (await request(S.port, 'GET', '/health')).json;
      eq('M7 E2E /health：files 六個欄位、count 4、pending 0、stale 0、沒有附件黃燈', [Object.keys(h.files).sort(), h.files.count, h.files.pending, h.files.stale, h.why.includes('有附件超過 24 小時沒補齊')], [['bytes', 'count', 'lastScanAt', 'pending', 'skipped', 'stale'], 4, 0, 0, false]);
      FG.st.hits = {};
      r = await runJob('mirror.js', [], JOB);
      eq('M7 E2E：同一天每小時那輪不再 filelist、沒有待補就不 fileget、鏡像照常', [r.code, FG.st.hits.filelist || 0, FG.st.hits.fileget || 0, FG.st.hits.mirror, last(dir, 'mirror-last.json').files.count], [0, 0, 0, 1, 4]);
      // Drive 已永久刪除（垃圾桶清掉）的附件：--files 補不到 → exit 1、印出清單；人寫進 file-skip.json 後 exit 0
      FL.writeMeta(dir, 'G-purged', { name: '早就刪了.pdf', wantedAt: new Date().toISOString(), source: 'posts' });
      r = await runJob('mirror.js', ['--files'], JOB);
      eq('M7 E2E --files：補不到（Drive 找不到）→ exit 1、pending=1、印出沒補到的清單', [r.code, /pending=1/.test(r.out), /沒補到.*G-purged/.test(r.out)], [1, true, true]);
      fs.writeFileSync(path.join(dir, 'logs/file-skip.json'), JSON.stringify(Object.assign({ 'G-purged': '超過 30 天已被 Drive 永久刪除' }, demoSkip)));
      r = await runJob('mirror.js', ['--files'], JOB);
      eq('M7 E2E --files：人工略過後 pending=0、skipped=9（含示範 8 個）、exit 0', [r.code, /pending=0/.test(r.out), /skipped=9/.test(r.out)], [0, true, true]);
      // --files-verify：本機檔被改 → 列出來、exit 1、不自動刪
      const vf = FL.bytesPath(dir, good[0]), orig = fs.readFileSync(vf);
      fs.writeFileSync(vf, Buffer.from('被改過'));
      r = await runJob('mirror.js', ['--files-verify'], JOB);
      eq('M7 E2E --files-verify：sha256 不符 → 列出、exit 1、檔案不刪', [r.code, r.out.includes(good[0]), fs.existsSync(vf)], [1, true, true]);
      fs.writeFileSync(vf, orig);
      r = await runJob('mirror.js', ['--files-verify'], JOB);
      eq('M7 E2E --files-verify：全部相符 → exit 0', [r.code, /不符 0 個/.test(r.out)], [0, true]); }
    await S.stop(); await FG.close(); }
}

main().catch((e) => { fail++; console.error(e); }).finally(() => {
  procs.forEach((p) => { try { if (p.exitCode === null) p.kill(); } catch (e) {} });
  tmps.forEach((d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} });
  console.log(`jobs: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
