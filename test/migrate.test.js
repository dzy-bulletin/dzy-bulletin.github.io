// node test/migrate.test.js — M5（#10）：server/migrate.js 一次性搬遷。
// 假 Google（test/fake-gas.js：gas/*.js 原封不動載進 vm＋本機假 Web App）先用真的 doPost 做出資料（主管上架、新增同仁、
// 同仁設密碼、簽名 45 張 → Drive），再切 PRIMARY=mini、EXPORT_ONCE=1，以子程序跑 migrate.js 經 server/bridge.js 真的打過去。
// 搬完用真伺服器（子程序、暫存埠、暫存資料夾）拿**搬遷前**發的同仁 token／主管 atoken 直接用，驗證 secret 真的搬過去。
// 不連任何外部網址；只關自己開的程序；暫存資料夾結束時刪掉。
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { makeFakeGas } = require('./fake-gas.js');
const { makeBridge } = require('../server/bridge.js');
const { runMigrate, parseArgs } = require('../server/migrate.js');
const { runMirror } = require('../server/mirror.js');
const { makeSqliteStore } = require('../server/store-sqlite.js');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; console.log('✗', name, '\n   got ', g, '\n   want', w); }
}
const tmps = [], procs = [];
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p || 'dzyb-mig-')); tmps.push(d); return d; };
const q = (dir, sql) => { const db = new DatabaseSync(path.join(dir, 'bulletin.db'), { readOnly: true }); try { return db.prepare(sql).all().map((r) => Object.assign({}, r)); } finally { db.close(); } };
const n = (dir, t) => q(dir, 'SELECT COUNT(*) AS n FROM ' + t)[0].n;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const JPG = (s) => 'data:image/jpeg;base64,' + Buffer.concat([JPG_MAGIC, Buffer.from('簽名-' + s)]).toString('base64');   // 真的 JPEG 檔頭 FF D8 FF E0
const PNG = (s) => 'data:image/png;base64,' + Buffer.concat([PNG_MAGIC, Buffer.from('簽名-' + s)]).toString('base64');   // 帶真的 PNG 檔頭（migrate 會檢查魔術數字）
function freePort() { return new Promise((ok, no) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); s.on('error', no); }); }
function runJob(script, args, env) {
  return new Promise((ok) => {
    const e = Object.assign({ PATH: process.env.PATH, DZYB_NO_DOTENV: '1', HOME: env.HOME || tmp('dzyb-home-') }, env);
    const p = spawn(process.execPath, [path.join(ROOT, 'server', script)].concat(args || []), { env: e, stdio: ['ignore', 'pipe', 'pipe'] });
    procs.push(p);
    let out = '', err = '';
    p.stdout.on('data', (c) => { out += c; }); p.stderr.on('data', (c) => { err += c; });
    p.on('exit', (code) => ok({ code, out, err }));
  });
}
async function startServer(dir) {   // 正式模式（非 E2E）、沒有橋接：只測資料層與登入憑證
  const port = await freePort();
  const p = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], { env: { PATH: process.env.PATH, DZYB_NO_DOTENV: '1', HOME: tmp('dzyb-home-'), PORT: String(port), DATA_DIR: dir, ALLOW_ORIGIN: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(p);
  let out = '';
  p.stdout.on('data', (c) => { out += c; }); p.stderr.on('data', () => {});
  await new Promise((ok, no) => { const t = setInterval(() => { if (/啟動/.test(out)) { clearInterval(t); ok(); } }, 20); p.on('exit', (c) => { clearInterval(t); no(new Error('伺服器沒起來 ' + c)); }); });
  return { port, stop: () => new Promise((ok) => { if (p.exitCode !== null) return ok(); p.on('exit', () => ok()); p.kill(); }) };
}
function api(port, action, body) {
  return new Promise((ok) => {
    const buf = Buffer.from(JSON.stringify(Object.assign({}, body || {}, { action })));
    const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/', headers: { 'Content-Type': 'text/plain', 'Content-Length': buf.length }, agent: false }, (res) => {
      const cs = []; res.on('data', (c) => cs.push(c));
      res.on('end', () => { let json = null; try { json = JSON.parse(Buffer.concat(cs).toString()); } catch (e) {} ok(json); });
    });
    r.on('error', (e) => ok({ ok: false, code: e.code }));
    r.write(buf); r.end();
  });
}
const checks = (out) => (out.match(/^ {3}(✅|❌) .*$/gm) || []);

async function main() {
  // ================= 準備：假 Google 上用真的 doPost 做出資料 =================
  const FG = makeFakeGas();
  const URL0 = await FG.listen();
  const KEY = 'k'.repeat(40), SECRET = 'test-secret-migrate-0123456789';   // 測試用假值（非正式）
  Object.assign(FG.props, { BRIDGE_KEY: KEY, PRIMARY: 'gas', TOKEN_SECRET: SECRET, ADMIN_INIT: 'admin-pass-99' });
  const doPost = (b) => JSON.parse(FG.G.doPost({ postData: { contents: JSON.stringify(b) } }).getContent());
  const atoken = doPost({ action: 'adminLogin', pass: 'admin-pass-99' }).data.atoken;
  const today = FG.G.DZYB.today();
  const posts = ['公告一', '公告二', '公告三'].map((t, i) => doPost({ action: 'savePost', atoken, post: { title: t, body: '內容' + i, units: ['mala'], publishOn: today } }).data.post.id);
  const staff = Array.from({ length: 15 }, (_, i) => doPost({ action: 'staffAdd', atoken, name: '同仁' + i, unit: 'mala' }).data.staff.id);
  const tokens = staff.map((id) => doPost({ action: 'setPin', staffId: id, pin: '2580', code: doPost({ action: 'staffIssueCode', atoken, staffId: id }).data.code }).data.token);
  let acks = 0;
  posts.forEach((p) => tokens.forEach((t, i) => { if (doPost({ action: 'ack', token: t, postId: p, sig: p === posts[2] ? JPG(p + i) : PNG(p + i) }).ok) acks++; }));   // 第三則的 15 張用 JPEG（兩種格式都要測到）
  doPost({ action: 'staffAdd', atoken, name: '還沒設密碼', unit: 'cf' });
  eq('（前提）GAS 上 3 則公告、16 人、45 張簽名（Drive 上）', [posts.length, FG.sheetRows('同仁').length, acks, Object.keys(FG.drive.files).length], [3, 16, 45, 45]);
  const tokA = tokens[0];
  eq('（前提）搬遷前的同仁 token／主管 atoken 在 GAS 能用', [doPost({ action: 'board', token: tokA }).ok, doPost({ action: 'adminData', atoken }).ok], [true, true]);
  const gasLog = FG.sheetRows('操作紀錄').length;

  // 切換：PRIMARY=mini（寫入回 MOVED）、EXPORT_ONCE=1
  Object.assign(FG.props, { PRIMARY: 'mini', EXPORT_ONCE: '1' });
  const ENV = (dir, extra) => Object.assign({ DATA_DIR: dir, BRIDGE_URL: URL0, BRIDGE_KEY: KEY }, extra || {});

  // ================= 缺 secret：GAS 端拒絕 export → migrate.js exit≠0、不寫入、EXPORT_ONCE 保留 =================
  { const dir = path.join(tmp(), 'data');
    delete FG.props.TOKEN_SECRET;
    const r = await runJob('migrate.js', ['--save', path.join(path.dirname(dir), 'x.json')], ENV(dir));
    FG.props.TOKEN_SECRET = SECRET;
    eq('GAS 缺 TOKEN_SECRET：export 被拒 → exit 4、沒建資料庫、沒存檔、EXPORT_ONCE 保留',
      [r.code, fs.existsSync(path.join(dir, 'bulletin.db')), fs.existsSync(path.join(path.dirname(dir), 'x.json')), FG.props.EXPORT_ONCE], [4, false, false, '1']); }

  // ================= dry-run：呼叫 export 一次 → 存檔（600）→ 印筆數／張數／預估；不寫入 =================
  const base = tmp(), dir = path.join(base, 'data'), file = path.join(base, 'export.json');
  FG.st.hits = {};
  let r = await runJob('migrate.js', ['--dry-run', '--save', file], ENV(dir));
  eq('dry-run：exit 0、export 打 1 次、EXPORT_ONCE 已被刪掉', [r.code, FG.st.hits.export, 'EXPORT_ONCE' in FG.props], [0, 1, false]);
  eq('dry-run：匯出檔存在、權限 600', [fs.existsSync(file), fs.existsSync(file) && (fs.statSync(file).mode & 0o777).toString(8)], [true, '600']);
  eq('dry-run：印出各表筆數', /公告 3、同仁 16、已讀 45、操作紀錄 \d+/.test(r.out), true);
  eq('dry-run：印出簽名圖張數與批次、預估下載時間', [/簽名圖 45 張 → 3 次 sigs 橋接呼叫（每批 20 張）/.test(r.out), /預估下載 \d+ 秒～\d+ (秒|分鐘)/.test(r.out)], [true, true]);
  eq('dry-run：沒有下載簽名圖、沒有建資料庫', [FG.st.hits.sigs || 0, fs.existsSync(path.join(dir, 'bulletin.db'))], [0, false]);
  eq('dry-run：提示下一步用 --from', r.out.includes('--from ' + file), true);
  const exp = JSON.parse(fs.readFileSync(file, 'utf8'));
  eq('匯出檔：含 secret 與 admin.hash、已讀的 sigId＝Drive id', [exp.secret === SECRET, !!exp.admin.hash, exp.reads.every((x) => !!FG.drive.files[x.sigId])], [true, true, true]);
  eq('輸出不含 secret／密碼雜湊', [r.out.includes(SECRET), exp.staff.some((s) => s.pinHash && r.out.includes(s.pinHash)), r.out.includes(exp.admin.hash)], [false, false, false]);

  r = await runJob('migrate.js', ['--dry-run', '--save', path.join(base, 'again.json')], ENV(dir));
  eq('export 只能用一次：第二次呼叫 → exit 4、提示改用 --from、不留空檔', [r.code, /--from/.test(r.out), fs.existsSync(path.join(base, 'again.json'))], [4, true, false]);
  r = await runJob('migrate.js', ['--dry-run', '--save', file], ENV(dir));
  eq('--save 指到既有檔：不覆蓋、exit 2（那可能是唯一一份 export）', [r.code, fs.readFileSync(file, 'utf8') === JSON.stringify(exp)], [2, true]);

  // ================= 缺 secret／admin.hash 的匯出檔：exit 3、拒絕寫入 =================
  for (const [label, mut] of [['secret', (x) => { delete x.secret; }], ['admin.hash', (x) => { x.admin.hash = ''; }], ['reads', (x) => { delete x.reads; }]]) {
    const b2 = tmp(), f2 = path.join(b2, 'bad.json'), d2 = path.join(b2, 'data'), x = JSON.parse(JSON.stringify(exp));
    mut(x); fs.writeFileSync(f2, JSON.stringify(x), { mode: 0o600 });
    const r2 = await runJob('migrate.js', ['--from', f2], ENV(d2));
    eq(`匯出檔缺 ${label}：exit 3、拒絕寫入（沒建資料庫、沒建 sigs）`, [r2.code, fs.existsSync(path.join(d2, 'bulletin.db')), fs.existsSync(path.join(d2, 'sigs')), /拒絕寫入/.test(r2.out)], [3, false, false, true]);
  }

  // ================= 正式匯入（--from）：六項全 ✅、簽名圖批次 =================
  FG.st.hits = {};
  r = await runJob('migrate.js', ['--from', file], ENV(dir));
  const ck = checks(r.out);
  eq('正式匯入：exit 0、六項全 ✅', [r.code, ck.length, ck.filter((x) => x.includes('✅')).length], [0, 6, 6]);
  eq('簽名圖批次：45 張只打 3 次 sigs（每批 ≤20）、沒有再打 export', [FG.st.hits.sigs, FG.st.hits.export || 0], [3, 0]);
  eq('筆數＝GAS export 筆數', [n(dir, 'posts'), n(dir, 'staff'), n(dir, 'reads'), n(dir, 'log')], [exp.posts.length, exp.staff.length, exp.reads.length, exp.log.length]);
  eq('操作紀錄＝GAS 分頁筆數（凍結後 GAS 沒有新增）', [n(dir, 'log'), FG.sheetRows('操作紀錄').length], [gasLog, gasLog]);
  const rows = q(dir, 'SELECT postId, staffId, sigId, driveSigId FROM reads ORDER BY rowid');
  eq('已讀：driveSigId＝GAS 的 Drive id、sigId＝本機檔名（與伺服器同一套命名）',
    rows.every((x, i) => x.driveSigId === exp.reads[i].sigId && x.sigId === x.postId + '_' + x.staffId + (x.postId === posts[2] ? '.jpg' : '.png')), true);
  eq('簽名圖檔內容＝Drive 上的原圖（逐張）', rows.every((x) => fs.readFileSync(path.join(dir, 'sigs', x.sigId)).equals(Buffer.from(FG.drive.files[x.driveSigId].bytes.map((b) => b & 255)))), true);
  eq('提示刪除匯出檔', r.out.includes('rm ' + file), true);
  eq('輸出不含 secret', r.out.includes(SECRET), false);
  eq('mirror.js 空庫保險不擋搬遷後的庫（有同仁）', n(dir, 'staff') > 0, true);

  // ================= 搬遷後：伺服器認得搬遷前的 token（不必重新登入） =================
  { const S = await startServer(dir);
    const b = await api(S.port, 'board', { token: tokA });
    eq('同仁：搬遷前的 token 直接能看公告（secret 有搬過去）、已簽的 3 則都在', [b.ok, b.ok && Object.keys(b.data.myReads).length], [true, 3]);
    const ad = await api(S.port, 'adminData', { atoken });
    eq('主管：搬遷前的 atoken 直接能用（通行碼版本＋secret 有搬過去）', ad.ok, true);
    eq('同仁：原本的密碼能登入（密碼雜湊有搬過去）', (await api(S.port, 'login', { staffId: staff[5], pin: '2580' })).ok, true);
    eq('主管：原本的通行碼能登入', (await api(S.port, 'adminLogin', { pass: 'admin-pass-99' })).ok, true);
    eq('亂造的 token 仍被拒（不是放行一切）', (await api(S.port, 'board', { token: staff[0] + '.1.xxxx' })).code, 'AUTH');
    await S.stop();
    const st = makeSqliteStore(dir);
    const sigs = st.getSigs(posts[1]);
    eq('回條簽名圖看得到（本機 sigs/，內容＝原本簽的）', [Object.keys(sigs).length, sigs[staff[2]]], [15, PNG(posts[1] + 2)]);
    st.close(); }

  // ================= 目標非空：拒絕；--force 先備份再匯入（--from 重跑） =================
  { const before = n(dir, 'reads');
    FG.st.hits = {};
    const r1 = await runJob('migrate.js', ['--from', file], ENV(dir));
    eq('目標已有資料：exit 2、拒絕、沒打任何橋接、資料不動', [r1.code, /已有資料/.test(r1.out), Object.keys(FG.st.hits).length, n(dir, 'reads')], [2, true, 0, before]);
    const r1d = await runJob('migrate.js', ['--from', file, '--dry-run'], ENV(dir));
    eq('--from＋--dry-run 重看：exit 0、提醒要 --force', [r1d.code, /--force/.test(r1d.out)], [0, true]);
    fs.writeFileSync(path.join(dir, 'sigs', 'mini-only.png'), 'x');   // 模擬 Mac mini 期間新簽的圖（--force 不刪檔）
    const r2 = await runJob('migrate.js', ['--from', file, '--force'], ENV(dir));
    const bak = fs.readdirSync(dir).filter((f) => /^bulletin\.db\.before-migrate-/.test(f));
    eq('--force：exit 0、六項全 ✅、先備份舊庫', [r2.code, checks(r2.out).filter((x) => x.includes('✅')).length, bak.length], [0, 6, 1]);
    const bdb = new DatabaseSync(path.join(dir, bak[0]), { readOnly: true });
    eq('備份檔是完整的舊庫', Number(bdb.prepare('SELECT COUNT(*) AS n FROM reads').get().n), before); bdb.close();
    eq('--force 不刪 sigs/ 裡既有的圖', fs.existsSync(path.join(dir, 'sigs', 'mini-only.png')), true);
    const e2 = tmp(), r3 = await runJob('migrate.js', ['--from', path.join(e2, 'nope.json')], ENV(path.join(e2, 'data')));
    eq('--from 檔案不存在：exit 2', r3.code, 2);
    const loose = path.join(tmp(), 'loose.json'); fs.writeFileSync(loose, JSON.stringify(exp)); fs.chmodSync(loose, 0o644);
    const r4 = await runJob('migrate.js', ['--from', loose], ENV(path.join(path.dirname(loose), 'data')));
    eq('--from 檔權限太寬：自動改 600 後照常匯入', [r4.code, (fs.statSync(loose).mode & 0o777).toString(8)], [0, '600']); }

  // ================= 竄改一筆：逐筆比對抓得到（不是只比筆數） =================
  const bridge = makeBridge(URL0, KEY);
  const quietRun = async (o) => { const lines = []; const res = await runMigrate(Object.assign({ say: (s) => lines.push(s), bridge, from: file }, o)); res.out = lines.join('\n'); return res; };
  const status = (res) => res.checks.map((c) => (c.ok ? '✅' : '❌') + c.name.split('（')[0]);
  const ALL = ['✅公告', '✅同仁', '✅已讀', '✅操作紀錄', '✅簽名圖', '✅登入金鑰＋管理通行碼雜湊'];
  { const res = await quietRun({ dir: path.join(tmp(), 'data') });
    eq('（對照）程序內跑：六項全 ✅', [res.code, status(res)], [0, ALL]); }
  const tamper = async (label, sql, want) => {
    const res = await quietRun({ dir: path.join(tmp(), 'data'), afterLoad: (d) => {
      if (typeof sql === 'function') return sql(d);
      const db = new DatabaseSync(path.join(d, 'bulletin.db')); db.exec(sql); db.close();
    } });
    const w = [].concat(want);
    eq('竄改 ' + label + ' → exit 1、只有' + w.join('＋') + ' ❌', [res.code, status(res)], [1, ALL.map((x) => (w.includes(x.slice(1)) ? '❌' + x.slice(1) : x))]);
    return res;
  };
  const tS = await tamper('同仁一筆的密碼雜湊（筆數不變）', `UPDATE staff SET json = json_set(json, '$.pinHash', 'zzz') WHERE id = '${staff[7]}'`, '同仁');
  eq('❌ 那行列出是哪一筆（只列 id、不列雜湊）', [tS.out.includes(staff[7]), tS.out.includes('zzz')], [true, false]);
  await tamper('公告一筆的內文', `UPDATE posts SET json = json_set(json, '$.body', '被改了') WHERE id = '${posts[2]}'`, '公告');
  await tamper('已讀一筆的簽名時間', `UPDATE reads SET at = '2000-01-01' WHERE rowid = 10`, '已讀');
  await tamper('已讀一筆的 driveSigId', `UPDATE reads SET driveSigId = 'X' WHERE rowid = 11`, '已讀');
  await tamper('操作紀錄一筆的摘要', `UPDATE log SET summary = '被改了' WHERE seq = 2`, '操作紀錄');
  await tamper('一張簽名圖（長度相同、內容不同）', (d) => { const f = path.join(d, 'sigs', q(d, 'SELECT sigId FROM reads WHERE rowid = 5')[0].sigId); const b = fs.readFileSync(f); b[0] ^= 1; fs.writeFileSync(f, b); }, '簽名圖');
  await tamper('一張簽名圖（檔案不見）', (d) => fs.unlinkSync(path.join(d, 'sigs', q(d, 'SELECT sigId FROM reads WHERE rowid = 6')[0].sigId)), '簽名圖');
  await tamper('登入金鑰', `UPDATE kv SET v = 'other' WHERE k = 'secret'`, '登入金鑰＋管理通行碼雜湊');
  await tamper('管理通行碼的 salt（雜湊不變）', `UPDATE kv SET v = json_set(v, '$.salt', 'other-salt') WHERE k = 'admin'`, '登入金鑰＋管理通行碼雜湊');
  await tamper('少一筆已讀（筆數也不同；那筆的簽名圖也跟著對不上）', `DELETE FROM reads WHERE rowid = 3`, ['已讀', '簽名圖']);

  // Drive 上讀不到的簽名圖：Drive id 保留、簽名圖那項 ❌、exit 1
  { const gone = exp.reads[4].sigId, keep = FG.drive.files[gone]; delete FG.drive.files[gone];
    const d = path.join(tmp(), 'data'), res = await quietRun({ dir: d });
    FG.drive.files[gone] = keep;
    eq('Drive 少一張圖：exit 1、只有簽名圖 ❌、那筆 driveSigId 仍保留', [res.code, status(res), q(d, `SELECT driveSigId, sigId FROM reads WHERE driveSigId = '${gone}'`)[0]],
      [1, ALL.map((x) => (x === '✅簽名圖' ? '❌簽名圖' : x)), { driveSigId: gone, sigId: '' }]); }

  // 簽名圖下載失敗（Google 當掉）：每批重試，連 3 次失敗才中斷、資料庫沒有動
  { const d = path.join(tmp(), 'data');
    const flaky = { n: 0, call: async (op, p, t) => { if (op === 'sigs' && flaky.n++ < 2) throw Object.assign(new Error('x'), { code: 'BRIDGE' }); return bridge.call(op, p, t); } };
    const res = await quietRun({ dir: d, bridge: flaky });
    eq('sigs 失敗 2 次後成功：重試後六項全 ✅', [res.code, status(res)], [0, ALL]);
    const d2 = path.join(tmp(), 'data');
    const dead = { call: async () => { throw Object.assign(new Error('x'), { code: 'BRIDGE_TIMEOUT' }); } };
    const res2 = await quietRun({ dir: d2, bridge: dead });
    eq('sigs 連 3 次失敗：exit 5、資料庫沒有建、提示 --from 重跑', [res2.code, fs.existsSync(path.join(d2, 'bulletin.db')), /--from/.test(res2.out)], [5, false, true]); }
  { const d = path.join(tmp(), 'data'); FG.st.hits = {};
    const res = await quietRun({ dir: d, batch: 7 });
    eq('--batch 7：45 張打 7 次 sigs', [res.code, FG.st.hits.sigs], [0, 7]); }
  eq('參數：--batch 超過 20 一律 20、未知參數擋下', [parseArgs(['--batch', '50']).batch, !!parseArgs(['--nope']).bad, !!parseArgs(['--from']).bad], [20, true, true]);

  // ================= 已讀重複：照 GAS 語意去重（與 GAS 自己的 board／getSigs 看到的一致） =================
  { const sheet = FG.book.getSheetByName('已讀'), orig = sheet.data.map((r) => r.slice());
    const r0 = sheet.data[1], r1 = sheet.data[2];                          // 第 1、2 筆已讀（表頭是 data[0]）
    sheet.data.push([r0[0], r0[1], r0[2], r0[3], '2026-10-01T09:00:00.000Z', '']);          // 同一人同一則：較晚、沒簽名檔 id
    sheet.data.push([r1[0], r1[1], r1[2], r1[3], '2026-10-01T09:30:00.000Z', sheet.data[3][5]]);   // 同一人同一則：換成另一張 Drive 圖
    // 已刪除的同仁（不在名單裡）兩列：姓名／單位／時間都不同，第二列沒簽名檔 id → 回條（receipts）會顯示已讀列自己的姓名與單位
    sheet.data.push([posts[0], 'S-999', '離職甲', 'mala', '2026-09-01T01:00:00.000Z', sheet.data[4][5]]);
    sheet.data.push([posts[0], 'S-999', '離職乙', 'cf', '2026-09-02T01:00:00.000Z', '']);
    FG.G.bumpGen_ && FG.G.bumpGen_();
    FG.props.EXPORT_ONCE = '1';
    const d = path.join(tmp(), 'data'), f = path.join(path.dirname(d), 'dup.json');
    const res = await quietRun({ dir: d, from: '', save: f });
    eq('重複已讀：exit 0、六項全 ✅、印出去重筆數', [res.code, status(res), /已讀有 3 列重複/.test(res.out)], [0, ALL, true]);
    eq('重複已讀：Mac mini 每人每則只留一筆（45＋S-999 一筆）', n(d, 'reads'), 46);
    // 回條：GAS 與 Mac mini 用同一份 Service，拿兩邊的 receipts 直接比（姓名、單位、時間、簽名圖）
    const gasRc = doPost({ action: 'receipts', atoken, postId: posts[0] }).data.rows;
    const S = await startServer(d);
    const miniRc = (await api(S.port, 'receipts', { atoken, postId: posts[0] })).data.rows;
    await S.stop();
    const pick = (rows) => JSON.stringify(rows.map((x) => [x.staffId, x.name, x.unit, x.at, x.sig]).sort());
    eq('回條（receipts）Mac mini＝GAS：含重複列的姓名／單位／時間／簽名圖', pick(miniRc) === pick(gasRc), true);
    const g999 = gasRc.find((x) => x.staffId === 'S-999');
    eq('S-999：姓名、單位、時間取最後一列，簽名沿用前一列那張', [g999.name, g999.unit, g999.at, !!g999.sig], ['離職乙', 'cf', '2026-09-02T01:00:00.000Z', true]);
    const tok0 = tokens[staff.indexOf(r0[1])], tok1 = tokens[staff.indexOf(r1[1])];
    const gasAt0 = doPost({ action: 'board', token: tok0 }).data.myReads[r0[0]], gasAt1 = doPost({ action: 'board', token: tok1 }).data.myReads[r1[0]];
    const gs = FG.store(), gasSig0 = gs.getSigs(r0[0])[r0[1]], gasSig1 = gs.getSigs(r1[0])[r1[1]];
    const st = makeSqliteStore(d), at = (p, sid) => st.getReads().find((x) => x.postId === p && x.staffId === sid).at;
    eq('簽名時間＝GAS board 看到的（最後一列）', [at(r0[0], r0[1]), at(r1[0], r1[1])], [gasAt0, gasAt1]);
    eq('簽名圖＝GAS getSigs 看到的（最後一張有簽名的；最後一列沒簽名檔 id 時沿用前面的）', [st.getSigs(r0[0])[r0[1]] === gasSig0, st.getSigs(r1[0])[r1[1]] === gasSig1, !!gasSig0, gasSig1 === PNG(posts[0] + 2)], [true, true, true, true]);
    st.close();
    sheet.data = orig; FG.G.bumpGen_ && FG.G.bumpGen_(); }

  // ================= 簽名圖下載可續跑：中斷後重跑只補沒下載的；壞掉的暫存刪掉重下 =================
  { const d = path.join(tmp(), 'data'), dl = path.join(d, '.migrate-dl');
    let calls = 0;
    const dieAfter1 = { call: async (op, p, t) => { if (op === 'sigs' && ++calls > 1) throw Object.assign(new Error('x'), { code: 'BRIDGE' }); return bridge.call(op, p, t); } };
    const r1 = await quietRun({ dir: d, bridge: dieAfter1 });
    const imgs = fs.readdirSync(dl).filter((f) => f.endsWith('.img')).sort();
    eq('第 2 批起掛掉：exit 5、資料庫沒建、第 1 批 20 張＋20 份 manifest 留在暫存', [r1.code, fs.existsSync(path.join(d, 'bulletin.db')), imgs.length, fs.readdirSync(dl).filter((f) => f.endsWith('.json')).length], [5, false, 20, 20]);
    const man = (f) => path.join(dl, f.replace(/\.img$/, '.json'));
    const shaOf = (b) => require('crypto').createHash('sha256').update(b).digest('hex');
    // 三種壞暫存，各自只觸發一種檢查：
    fs.writeFileSync(path.join(dl, imgs[0]), Buffer.alloc(0));                                        // ① 0 byte（manifest 也改成一致，只剩「長度 > 0」擋得住）
    fs.writeFileSync(man(imgs[0]), JSON.stringify({ type: 'png', sha: shaOf(Buffer.alloc(0)), len: 0 }));
    const t1 = fs.readFileSync(path.join(dl, imgs[1])); fs.writeFileSync(path.join(dl, imgs[1]), t1.subarray(0, 6));   // ② 截斷（manifest 保持原樣＝長度／sha 不符）
    const t2 = fs.readFileSync(path.join(dl, imgs[2])); t2[0] = 0x00; fs.writeFileSync(path.join(dl, imgs[2]), t2);    // ③ 魔術數字錯（manifest 改成一致，只剩檔頭擋得住）
    fs.writeFileSync(man(imgs[2]), JSON.stringify({ type: 'png', sha: shaOf(t2), len: t2.length }));
    const t3 = fs.readFileSync(path.join(dl, imgs[3])); t3[t3.length - 2] ^= 0xff; fs.writeFileSync(path.join(dl, imgs[3]), t3);   // ④ 中間內容壞掉（長度、檔頭都對，manifest 保持原樣＝只剩 sha 擋得住）
    const cnt = { n: 0, ids: 0, call: async (op, p, t) => { if (op === 'sigs') { cnt.n++; cnt.ids += p.get.length; } return bridge.call(op, p, t); } };
    const r2 = await quietRun({ dir: d, bridge: cnt });
    eq('重跑：4 張壞暫存（0 byte／截斷／魔術數字／內容 sha 不符）被丟掉、重下 29 張（2 次 sigs）', [/暫存裡有 4 張簽名圖不完整/.test(r2.out), cnt.ids, cnt.n], [true, 29, 2]);
    eq('重跑：六項全 ✅、暫存刪掉、提示上次已下載 16 張', [r2.code, status(r2), fs.existsSync(dl), /上次已下載 16 張/.test(r2.out)], [0, ALL, false, true]);
    const rows2 = q(d, 'SELECT sigId, driveSigId FROM reads ORDER BY rowid');
    const fmtOk = (x, b) => (x.sigId.endsWith('.png') ? b.subarray(0, 4).equals(PNG_MAGIC.subarray(0, 4)) : x.sigId.endsWith('.jpg') && b.subarray(0, 3).equals(JPG_MAGIC.subarray(0, 3)));
    eq('每張最後寫進 sigs/ 的檔＝Drive 原圖、副檔名與實際格式一致（.png＋PNG 檔頭／.jpg＋FF D8 FF）', [rows2.every((x) => { const b = fs.readFileSync(path.join(d, 'sigs', x.sigId)); return fmtOk(x, b) && b.equals(Buffer.from(FG.drive.files[x.driveSigId].bytes.map((v) => v & 255))); }), rows2.filter((x) => x.sigId.endsWith('.jpg')).length], [true, 15]);
    eq('非 0 結束也提醒刪匯出檔', /匯出檔仍在/.test(r1.out), true); }

  // Drive 上那張不是有效的 PNG（檔頭不對）→ 當作讀不到，簽名圖 ❌
  { const id = exp.reads[7].sigId, keep = FG.drive.files[id].bytes; FG.drive.files[id].bytes = Array.from(Buffer.from('not-a-png'));
    const d = path.join(tmp(), 'data'), res = await quietRun({ dir: d });
    FG.drive.files[id].bytes = keep;
    eq('Drive 圖檔頭不對：exit 1、只有簽名圖 ❌、印出格式警告', [res.code, status(res), /不是有效的 PNG／JPEG/.test(res.out)], [1, ALL.map((x) => (x === '✅簽名圖' ? '❌簽名圖' : x)), true]); }

  // Drive 上宣稱是 JPEG、但只有第 1 個 byte 對（FF 00 00…）→ 當作讀不到（JPEG 檔頭要完整 FF D8 FF）
  { const r = exp.reads.find((x) => x.postId === posts[2]), keep = FG.drive.files[r.sigId].bytes;
    FG.drive.files[r.sigId].bytes = Array.from(Buffer.concat([Buffer.from([0xff, 0x00, 0x00]), Buffer.from('壞 JPEG')]));
    const d = path.join(tmp(), 'data'), res = await quietRun({ dir: d });
    FG.drive.files[r.sigId].bytes = keep;
    eq('JPEG 檔頭只有 FF 對（FF 00 00）：exit 1、只有簽名圖 ❌', [res.code, status(res), /不是有效的 PNG／JPEG/.test(res.out)], [1, ALL.map((x) => (x === '✅簽名圖' ? '❌簽名圖' : x)), true]); }

  // 公告／同仁 id 重複：GAS 語意不一致（看板顯示兩筆、編輯只認第一列）→ 列出並停下，dry-run 也停
  for (const [label, mut, want] of [['公告', (x) => { x.posts.push(Object.assign({}, x.posts[0], { title: '重複那列' })); }, posts[0]], ['同仁', (x) => { x.staff.push(Object.assign({}, x.staff[2], { name: '重複那列' })); }, staff[2]]]) {
    const b2 = tmp(), f2 = path.join(b2, 'dupid.json'), d2 = path.join(b2, 'data'), x = JSON.parse(JSON.stringify(exp));
    mut(x); fs.writeFileSync(f2, JSON.stringify(x), { mode: 0o600 });
    const rd = await runJob('migrate.js', ['--from', f2, '--dry-run'], ENV(d2)), rr = await runJob('migrate.js', ['--from', f2], ENV(d2));
    eq(`${label} id 重複：dry-run 與正式都 exit 3、列出重複的 id、沒寫入`, [rd.code, rr.code, rd.out.includes(label + ' id 重複 1 個：' + want), fs.existsSync(path.join(d2, 'bulletin.db'))], [3, 3, true, false]);
  }

  // ================= server/oldkey-check.sh：舊金鑰驗證（CUTOVER.md 第 7 步），用本機假 Apps Script 模擬 302 轉址 =================
  { const store = new Map(); let seq = 0, lastBody = '';
    const fake = http.createServer((req, res) => {
      let b = ''; req.on('data', (c) => { b += c; });
      req.on('end', () => {
        const u = new URL(req.url, 'http://x');
        if (u.pathname === '/exec' && req.method === 'POST') {           // 真的 Apps Script：/exec 處理完回 302 → echo 網址
          lastBody = b; let key = ''; try { key = JSON.parse(b).key; } catch (e) {}
          const out = key === 'OLD-KEY-0123456789012345678901234567' ? '{"ok":false,"code":"AUTH","message":"橋接金鑰錯誤"}'
            : key === 'STILL-VALID-KEY-01234567890123456789' ? '{"ok":true,"data":{"limit":1,"usage":0}}'
            : key === 'BUSY-KEY-012345678901234567890123456' ? '{"ok":false,"code":"SERVER","message":"忙碌中"}' : '<html>Google 暫時錯誤</html>';
          store.set(String(++seq), out); res.writeHead(302, { Location: '/echo?id=' + seq }); return res.end();
        }
        if (u.pathname === '/echo') {                                       // echo 網址只收 GET（非 GET 回 405 HTML）
          if (req.method !== 'GET') { res.writeHead(405, { 'Content-Type': 'text/html' }); return res.end('<html>405</html>'); }
          res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(store.get(u.searchParams.get('id')) || '');
        }
        res.writeHead(404); res.end();
      });
    });
    await new Promise((ok) => fake.listen(0, '127.0.0.1', ok));
    const W = 'http://127.0.0.1:' + fake.address().port + '/exec';
    const envOf = (key) => { const f = path.join(tmp(), '.env'); fs.writeFileSync(f, `BRIDGE_URL="${W}"\nBRIDGE_KEY='${key}'\n`, { mode: 0o600 }); return f; };
    const run = (f) => new Promise((ok) => { const c = spawn('sh', [path.join(ROOT, 'server/oldkey-check.sh'), f], { stdio: ['ignore', 'pipe', 'pipe'] }); procs.push(c); let o = ''; c.stdout.on('data', (x) => { o += x; }); c.stderr.on('data', (x) => { o += x; }); c.on('exit', (code) => ok({ code, o })); });
    const a = await run(envOf('OLD-KEY-0123456789012345678901234567'));
    eq('oldkey-check：跟著 302 拿到 AUTH → exit 0、印「舊金鑰已失效」、不印金鑰', [a.code, /舊金鑰已失效/.test(a.o), a.o.includes('OLD-KEY')], [0, true, false]);
    eq('oldkey-check：金鑰真的有送到（POST 本體），引號已去掉', JSON.parse(lastBody).key, 'OLD-KEY-0123456789012345678901234567');
    const b = await run(envOf('STILL-VALID-KEY-01234567890123456789'));
    eq('oldkey-check：回 ok:true → exit 1、請 Eason 確認屬性', [b.code, /舊金鑰仍然有效/.test(b.o)], [1, true]);
    const c = await run(envOf('WHATEVER-KEY-0123456789012345678901'));
    eq('oldkey-check：其他回應 → exit 3、停下並印原文', [c.code, /其他回應/.test(c.o), /Google 暫時錯誤/.test(c.o)], [3, true, true]);
    const bz = await run(envOf('BUSY-KEY-012345678901234567890123456'));
    eq('oldkey-check：JSON 但是別的錯誤碼（SERVER）→ exit 3、不當成通過', [bz.code, /其他回應/.test(bz.o), /"code":"SERVER"/.test(bz.o)], [3, true, true]);
    const nf = path.join(tmp(), '.env'); fs.writeFileSync(nf, 'PORT=1\n');
    eq('oldkey-check：.env 沒有金鑰 → exit 2', (await run(nf)).code, 2);
    const two = path.join(tmp(), '.env'); fs.writeFileSync(two, `BRIDGE_URL=${W}\nBRIDGE_KEY=STILL-VALID-KEY-01234567890123456789\nBRIDGE_KEY=OLD-KEY-0123456789012345678901234567\n`);
    const tw = await run(two);
    eq('oldkey-check：.env 有兩行 BRIDGE_KEY → exit 3、說明原因、不送出（不會誤判通過）', [tw.code, /有 2 行 BRIDGE_KEY/.test(tw.o), tw.o.includes('KEY-0')], [3, true, false]);
    const lead = path.join(tmp(), '.env'); fs.writeFileSync(lead, `BRIDGE_URL=${W}\n BRIDGE_KEY=STILL-VALID-KEY-01234567890123456789\nBRIDGE_KEY=OLD-KEY-0123456789012345678901234567\n`);
    eq('oldkey-check：開頭有空白的 BRIDGE_KEY 也算一行（與伺服器 loadEnv 一致）→ 兩行 → exit 3', (await run(lead)).code, 3);
    const sp = path.join(tmp(), '.env'); fs.writeFileSync(sp, `# BRIDGE_KEY=註解不算\n  BRIDGE_URL = ${W}\nBRIDGE_KEY = OLD-KEY-0123456789012345678901234567\n`);
    eq('oldkey-check：等號兩邊有空白也讀得到、# 註解行不算（與 loadEnv 一致）→ AUTH、exit 0', (await run(sp)).code, 0);
    const crlf = path.join(tmp(), '.env'); fs.writeFileSync(crlf, `BRIDGE_URL="${W}"\r\nBRIDGE_KEY=OLD-KEY-0123456789012345678901234567\r\n`);
    eq('oldkey-check：CRLF 換行的 .env 也讀得到（去掉 \\r）', (await run(crlf)).code, 0);
    const dead = path.join(tmp(), '.env'); fs.writeFileSync(dead, `BRIDGE_URL=http://127.0.0.1:${await freePort()}/exec\nBRIDGE_KEY=OLD-KEY-0123456789012345678901234567\n`);
    const dd = await run(dead);
    eq('oldkey-check：連不上 → exit 3、印出 curl 的錯誤原因、不印金鑰', [dd.code, /curl: \(\d+\)/.test(dd.o), dd.o.includes('OLD-KEY')], [3, true, false]);
    // 對照：第 2 輪手冊的寫法（-X POST）跟著 302 仍用 POST，echo 回 405，什麼 JSON 都拿不到
    const old = await new Promise((ok) => { const p2 = spawn('sh', ['-c', `printf '{"action":"bridge","key":"OLD-KEY-0123456789012345678901234567","op":"quota"}' | curl -sL -X POST -H 'Content-Type: text/plain' --data-binary @- "${W}"`], { stdio: ['ignore', 'pipe', 'ignore'] }); procs.push(p2); let o = ''; p2.stdout.on('data', (x) => { o += x; }); p2.on('exit', () => ok(o)); });
    eq('對照：加 -X POST 的舊寫法拿不到 AUTH（證明 R1 的問題存在）', /AUTH/.test(old), false);
    await new Promise((ok) => fake.close(ok)); }

  // ================= mirror.js 空庫保險：切換日 PRIMARY=mini 後、搬遷前，空庫不可蓋掉試算表 =================
  { const d = tmp(); makeSqliteStore(d).close();
    const calls = []; const B = { call: async (op) => { calls.push(op); return { counts: {} }; } };
    const lines = []; const o = console.log; console.log = (s) => lines.push(s);
    let res; try { res = await runMirror({ dir: d, bridge: B }); } finally { console.log = o; }
    eq('空庫：mirror 拒絕（ok:false）、一次橋接都沒打', [res.ok, calls, /資料庫是空的/.test(res.error)], [false, [], true]); }

  // ================= server/latency.js（切換後量測，CUTOVER.md 步驟 9） =================
  { const { fromLog, fromValues, valuesPass } = require('../server/latency.js');
    const log = Array.from({ length: 100 }, (_, i) => `2026-10-01T07:00:${String(i % 60).padStart(2, '0')}.000Z board ${i + 1}ms ok`)
      .concat(['2026-10-01T07:01:00.000Z ack 30ms ok', '2026-10-01T07:01:01.000Z ack 5000ms SERVER', '2026-09-30T07:00:00.000Z ack 999ms ok', '佈告欄伺服器 v0.5.4 啟動', 'garbage']).join('\n');
    const r0 = fromLog(log, { actions: ['board', 'ack'] });
    eq('latency：board 100 筆 p50＝50、p95＝95（nearest-rank）', [r0.board.n, r0.board.p50, r0.board.p95, r0.board.max], [100, 50, 95, 100]);
    eq('latency：錯誤回應不算進百分位、另計', [r0.ack.n, r0.ack.errors], [2, 1]);
    eq('latency：--since 過濾', fromLog(log, { actions: ['ack'], since: '2026-10-01T00:00:00Z' }).ack.n, 1);
    const v = fromValues(Array.from({ length: 30 }, (_, i) => ((i + 1) / 10).toFixed(3)).join('\n'));
    eq('latency --values：30 筆中位數＝第 15、16 筆平均，p90＝第 27 筆', [v.n, v.median, v.p90], [30, 1.55, 2.7]);
    const v3 = fromValues('1.2\n1.3\n1.4\n');
    eq('latency --values：結尾換行不會多出一筆 0（3 筆、中位數 1.3）', [v3.n, v3.failed, v3.median], [3, 0, 1.3]);
    const good = Array.from({ length: 30 }, () => '200 0.400').join('\n') + '\n';
    eq('latency --values：30 次 200、0.4 秒 → 達標', [fromValues(good).n, valuesPass(fromValues(good), 30)], [30, true]);
    const mixed = good + '000 0.000\n\n';
    const vm = fromValues(mixed);
    eq('latency --values：混進 1 次連不上（000 0.000）→ 失敗另列、不進百分位、不達標', [vm.n, vm.failed, vm.median, valuesPass(vm, 30)], [30, 1, 0.4, false]);
    eq('latency --values：http_code 500 也算失敗；舊格式耗時 0 也算失敗', [fromValues('500 0.2\n200 0.3').failed, fromValues('0.000\n0.3').failed], [1, 1]);
    eq('latency --values：成功次數不足 --expect 不達標', valuesPass(fromValues(good.split('\n').slice(0, 29).join('\n')), 30), false);
    const dead = await new Promise((ok) => { const c = spawn(process.execPath, [path.join(ROOT, 'server/latency.js'), '--values', '--expect', '3'], { stdio: ['pipe', 'pipe', 'ignore'] }); let o = ''; c.stdout.on('data', (x) => { o += x; }); c.on('exit', (code) => ok({ code, o })); c.stdin.end('000 0.000\n000 0.000\n000 0.000\n'); });
    eq('latency.js --values：3 次全連不上 → exit 1、不印達標', [dead.code, /✅/.test(dead.o), /失敗 3 次/.test(dead.o)], [1, false, true]);
    const nh = await runJob('latency.js', ['--hours'], {});
    eq('latency.js --hours 沒接數字 → exit 2、不丟 RangeError', [nh.code, /RangeError/.test(nh.err)], [2, false]);
    // 真伺服器的每請求紀錄格式要能被 latency.js 讀到（index.js 的格式一改這裡就會紅）
    const p = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], { env: { PATH: process.env.PATH, DZYB_NO_DOTENV: '1', HOME: tmp('dzyb-home-'), PORT: String(await freePort()), DATA_DIR: path.join(tmp(), 'lat'), ALLOW_ORIGIN: '' }, stdio: ['ignore', 'pipe', 'ignore'] });
    procs.push(p);
    let out = ''; p.stdout.on('data', (c) => { out += c; });
    await new Promise((ok) => { const t = setInterval(() => { if (/啟動/.test(out)) { clearInterval(t); ok(); } }, 20); });
    const port = Number(/127\.0\.0\.1:(\d+)/.exec(out)[1]);
    for (let i = 0; i < 5; i++) await api(port, 'roster');
    await api(port, 'board', { token: 'x' });
    await new Promise((ok) => setTimeout(ok, 100));
    const rl = fromLog(out, { actions: ['roster', 'board'] });
    eq('latency 讀得到真伺服器的紀錄：roster 5 次成功、board 1 次錯誤', [rl.roster && rl.roster.n, rl.board && rl.board.errors], [5, 1]);
    await new Promise((ok) => { p.on('exit', () => ok()); p.kill(); }); }

  await FG.close();
}

main().catch((e) => { fail++; console.error(e); }).finally(() => {
  procs.forEach((p) => { try { if (p.exitCode === null) p.kill(); } catch (e) {} });
  tmps.forEach((d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} });
  console.log(`migrate: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
