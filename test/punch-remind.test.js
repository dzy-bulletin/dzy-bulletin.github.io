// node test/punch-remind.test.js — 打卡回覆帶出未簽公告（server/punch-remind-push.js，docs/punch-remind.md）。
// A 段：純函式 pendingByLine／buildPayload；B 段：runPush 打本機假 /exec；C 段：子程序驗未設定與 --dry-run。
// 假 /exec 用本機 HTTP（自己找空埠）；子程序一律帶 DZYB_NO_DOTENV=1，不讀真的 server/.env。
'use strict';
const { spawn } = require('child_process');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeSqliteStore } = require('../server/store-sqlite.js');
const P = require('../server/punch-remind-push.js');
const L = require('../js/logic.js');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; console.log('✗', name, '\n   got ', g, '\n   want', w); }
}
const tmps = [];
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p || 'dzyb-punch-')); tmps.push(d); return d; };
const lastFile = (dir) => path.join(dir, 'logs', 'punch-remind-last.json');
const hash = (uid) => crypto.createHash('sha256').update(L.LINE_HASH_PREFIX + uid, 'utf8').digest('hex');
const TD = '2026-11-02';
const d = (n) => L.addDays(TD, -n);

function data() {
  return {
    posts: [
      { id: 'P-1', title: '十一月排班', units: ['mala'], published: true, publishOn: d(0), expiresOn: '' },               // 當天上架
      { id: 'P-2', title: '全部都要簽', units: ['mzt', 'mala', 'cf'], published: true, publishOn: d(2), expiresOn: '' },
      { id: 'P-3', title: '只給墨竹亭', units: ['mzt'], published: true, publishOn: d(1), expiresOn: '' },
      { id: 'P-4', title: '還沒上架', units: ['mala'], published: true, publishOn: d(-1), expiresOn: '' },
      { id: 'P-5', title: '已下架', units: ['mala'], published: false, offOn: d(1), publishOn: d(5), expiresOn: '' },
      { id: 'P-6', title: '已到期', units: ['mala'], published: true, publishOn: d(9), expiresOn: d(1) },
      { id: 'P-7', title: '央廚\n換線   通知', units: ['cf'], published: true, publishOn: d(3), expiresOn: '' }
    ],
    staff: [
      { id: 'S-1', name: '甲', unit: 'mala', active: true, lineHash: hash('U1') },
      { id: 'S-2', name: '乙', unit: 'mala', active: true, lineHash: hash('U2') },               // 簽了 P-1（沒有簽名圖也算）
      { id: 'S-3', name: '丙', unit: 'mzt', active: true, lineHash: hash('U3') },
      { id: 'S-4', name: '丁', unit: 'mala', active: true, lineHash: '' },                        // 沒綁 LINE
      { id: 'S-5', name: '戊', unit: 'mala', active: false, lineHash: hash('U5') },              // 離職
      { id: 'S-6', name: '己', unit: 'hq-dzy', active: true, lineHash: hash('U6') },             // 總部鼎兆元：只簽「全部」
      { id: 'S-7', name: '庚', unit: 'mzt', active: true, seeAll: true, lineHash: hash('U7') },   // 總監：看得到三區，要簽依自己單位
      { id: 'S-8', name: '辛', unit: 'cf', active: true, lineHash: hash('U8') },
      { id: 'S-9', name: '壬', unit: 'mala', active: true, lineHash: 'not-a-hash' }
    ],
    reads: [
      { postId: 'P-1', staffId: 'S-2' },
      { postId: 'P-2', staffId: 'S-8' }
    ]
  };
}

function fakeExec() {
  const h = { mode: 'ok', bodies: [], hits: 0 };
  h.server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      h.hits++;
      if (h.mode === 'drop') { req.socket.destroy(); return; }
      let j = {}; try { j = JSON.parse(b); } catch (e) {}
      h.bodies.push(j);
      res.setHeader('Content-Type', 'application/json');
      if (h.mode === 'reject' || j.key !== 'K-test-key-0123456789abcdef0123456789') return res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
      res.end(JSON.stringify({ ok: true, people: Object.keys(j.map || {}).length }));
    });
  });
  return new Promise((ok) => h.server.listen(0, '127.0.0.1', () => { h.url = 'http://127.0.0.1:' + h.server.address().port + '/exec'; ok(h); }));
}
function seedDb(dir, dat) {
  const st = makeSqliteStore(dir);
  st.load({ posts: dat.posts, staff: dat.staff,
    reads: dat.reads.map((r) => ({ postId: r.postId, staffId: r.staffId, name: 'x', unit: 'mala', at: '2026-11-01T00:00:00.000Z', sigId: '' })), log: [] });
  st.close();
}
function runJob(args, env) {
  return new Promise((ok) => {
    const e = Object.assign({ PATH: process.env.PATH, DZYB_NO_DOTENV: '1', HOME: tmp('dzyb-home-'), PUNCH_REMIND_RETRY_MS: '0' }, env);
    const p = spawn(process.execPath, [path.join(ROOT, 'server', 'punch-remind-push.js')].concat(args || []), { env: e, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (c) => { out += c; }); p.stderr.on('data', (c) => { err += c; });
    p.on('exit', (code) => ok({ code, out, err }));
  });
}

async function main() {
  // ===== A1 名單規則 =====
  {
    const m = P.pendingByLine(data(), TD);
    eq('A1 只有該提醒的人在 map 裡', Object.keys(m).sort(), [hash('U1'), hash('U2'), hash('U3'), hash('U6'), hash('U7'), hash('U8')].sort());
    // 甲（小辛辣）：P-1 當天上架、P-2 全部；排序照 sortBoard（上架日新到舊）
    eq('A1 甲', m[hash('U1')], { n: 2, titles: ['十一月排班', '全部都要簽'] });
    eq('A1 丙（墨竹亭）看不到小辛辣的 P-1', m[hash('U3')], { n: 2, titles: ['只給墨竹亭', '全部都要簽'] });
    eq('A1 庚（總監）看得到三區，但只提醒自己單位要簽的', m[hash('U7')], { n: 2, titles: ['只給墨竹亭', '全部都要簽'] });
    eq('A1 辛（央廚）簽了 P-2；標題換行與連續空白變一個空白', m[hash('U8')], { n: 1, titles: ['央廚 換線 通知'] });
    eq('A1 沒綁／離職／不合格雜湊不出現', [m[''], m[hash('U5')], m['not-a-hash']], [undefined, undefined, undefined]);
  }
  // 乙：簽了 P-1、還有 P-2
  {
    const m = P.pendingByLine(data(), TD);
    eq('A1b 乙只剩 P-2', m[hash('U2')], { n: 1, titles: ['全部都要簽'] });
  }
  // 總部鼎兆元：只簽「全部」（P-2 三單位全選）
  {
    const m = P.pendingByLine(data(), TD);
    eq('A1c 己（總部鼎兆元）只有全部公告', m[hash('U6')], { n: 1, titles: ['全部都要簽'] });
  }

  // ===== A2 上限、截斷、合併 =====
  {
    const dat = data();
    for (let i = 0; i < 5; i++) dat.posts.push({ id: 'Q-' + i, title: '小辛辣公告' + i, units: ['mala'], published: true, publishOn: d(4 + i), expiresOn: '' });
    dat.posts.push({ id: 'Q-long', title: '😀'.repeat(40), units: ['mala'], published: true, publishOn: d(0), expiresOn: '' });
    const m = P.pendingByLine(dat, TD);
    const a = m[hash('U1')];
    eq('A2 n 算全部未簽', a.n, 8);
    eq('A2 最多 3 則', a.titles.length, P.LIST_MAX);
    eq('A2 LIST_MAX＝3、TITLE_MAX＝30', [P.LIST_MAX, P.TITLE_MAX], [3, 30]);
    const long = a.titles.find((t) => t.indexOf('😀') === 0);
    eq('A2 30 字截斷加「…」、不切壞 emoji', [Array.from(long).length, long.slice(-1), Array.from(long).slice(0, 30).every((c) => c === '😀')], [31, '…', true]);
    // 同一個 lineHash 對到兩位在職同仁：合併、去重
    const dup = data();
    dup.staff.push({ id: 'S-10', name: '甲二', unit: 'mzt', active: true, lineHash: hash('U1') });
    const md = P.pendingByLine(dup, TD)[hash('U1')];
    eq('A2 同 hash 合併去重', md, { n: 3, titles: ['十一月排班', '只給墨竹亭', '全部都要簽'] });
    // 空標題
    const em = data(); em.posts = [{ id: 'E', title: '  ', units: ['mala'], published: true, publishOn: TD, expiresOn: '' }];
    eq('A2 空標題', P.pendingByLine(em, TD)[hash('U1')], { n: 1, titles: ['（無標題）'] });
  }

  // ===== A3 buildPayload 與 90KB 裁切 =====
  {
    const m = P.pendingByLine(data(), TD);
    const b = P.buildPayload(m, '2026-11-02T01:00:00.000Z', 'K');
    eq('A3 形狀', [b.payload.action, b.payload.key, b.payload.v, b.payload.at, b.trimmed], ['line_hub_bulletin_put', 'K', 1, '2026-11-02T01:00:00.000Z', false]);
    eq('A3 bytes＝JSON 位元組數', b.bytes, Buffer.byteLength(JSON.stringify(b.payload), 'utf8'));
    const big = {};
    for (let i = 0; i < 700; i++) big[hash('B' + i)] = { n: 5, titles: ['短', '很長的公告標題甲乙丙丁戊己庚辛壬癸一二三四五六七八九十', '很長的公告標題甲乙丙丁戊己庚辛壬癸一二三四五六七八九十'] };
    const bb = P.buildPayload(big, 'x', 'K');
    eq('A3 超過 90KB 改每人只留 1 則', [bb.trimmed, bb.bytes <= P.MAX_BYTES, bb.payload.map[hash('B0')].titles.length, bb.payload.map[hash('B0')].n], [true, true, 1, 5]);
  }

  // ===== A4 燈號 =====
  {
    const { judgeHealth } = require('../server/health-rules.js');
    const now = Date.parse('2026-11-02T02:00:00Z'), ago = (min) => new Date(now - min * 60e3).toISOString();
    const base = { mirror: { at: ago(60), ok: true, fails: 0 }, backup: { at: ago(60), ok: true }, disk: { freeMB: 50000 } };
    const lv = (pr) => judgeHealth(Object.assign({}, base, { punchRemind: pr }), now);
    eq('A4 null／剛跑過成功 → 綠', [lv(null).level, lv({ at: ago(4), ok: true, people: 3 }).level], ['green', 'green']);
    eq('A4 失敗 → 黃', lv({ at: ago(4), ok: false, people: 0 }), { level: 'yellow', why: ['打卡公告提醒送出失敗'] });
    eq('A4 超過 30 分鐘沒跑 → 黃', lv({ at: ago(31), ok: true, people: 0 }), { level: 'yellow', why: ['打卡公告提醒超過 30 分鐘沒跑'] });
  }

  // ===== B runPush =====
  const h = await fakeExec();
  const KEY = 'K-test-key-0123456789abcdef0123456789';
  const NOW = new Date('2026-11-02T10:00:00+08:00');
  {
    const dir = tmp(); seedDb(dir, data());
    const r = await P.runPush({ dir, url: h.url, key: KEY, now: NOW, retryMs: 0 });
    eq('B1 ok、送一次', [r.ok, h.hits], [true, 1]);
    const b = h.bodies[0];
    eq('B1 body', [b.action, b.v, Object.keys(b.map).length, typeof b.at], ['line_hub_bulletin_put', 1, 6, 'string']);
    const lj = JSON.parse(fs.readFileSync(lastFile(dir), 'utf8'));
    eq('B1 last 只有數字', [lj.ok, lj.people, lj.posts, lj.trimmed, typeof lj.bytes], [true, 6, 4, false, 'number']);
    const raw = fs.readFileSync(lastFile(dir), 'utf8') + fs.readFileSync(path.join(dir, 'logs', 'punch-remind.log'), 'utf8');
    eq('B1 last／log 不含姓名與標題', [/甲|乙|十一月排班|全部都要簽/.test(raw)], [false]);
  }
  {
    const dir = tmp(); seedDb(dir, data());
    h.mode = 'reject'; h.hits = 0;
    const r = await P.runPush({ dir, url: h.url, key: KEY, now: NOW, retryMs: 0 });
    eq('B2 拒收：ok false、不重試', [r.ok, h.hits, JSON.parse(fs.readFileSync(lastFile(dir), 'utf8')).ok], [false, 1, false]);
    h.mode = 'drop'; h.hits = 0;
    const r2 = await P.runPush({ dir, url: h.url, key: KEY, now: NOW, retryMs: 0 });
    eq('B2 斷線重試一次後失敗', [r2.ok, h.hits], [false, 2]);
    h.mode = 'ok';
  }
  {
    const dir = tmp(); const dat = data(); dat.posts = []; seedDb(dir, dat);
    h.bodies = []; h.hits = 0;
    const r = await P.runPush({ dir, url: h.url, key: KEY, now: NOW, retryMs: 0 });
    eq('B3 沒人要提醒也照送空 map（機器人才會清掉舊的）', [r.ok, h.hits, Object.keys(h.bodies[0].map).length, r.people], [true, 1, 0, 0]);
  }

  // ===== C 子程序 =====
  {
    const dir = tmp(); seedDb(dir, data());
    const c1 = await runJob([], { DATA_DIR: dir });
    eq('C1 未設定 → 尚未啟用、exit 0', [c1.code, /尚未啟用/.test(c1.out), fs.existsSync(lastFile(dir))], [0, true, false]);
    h.hits = 0;
    const c2 = await runJob(['--dry-run'], { DATA_DIR: dir, PUNCH_REMIND_URL: h.url, PUNCH_REMIND_KEY: KEY });
    eq('C2 dry-run 不送、不寫 last、只印數字', [c2.code, h.hits, fs.existsSync(lastFile(dir)), /6 人/.test(c2.out), /甲|十一月排班/.test(c2.out)], [0, 0, false, true, false]);
    const c3 = await runJob([], { DATA_DIR: dir, PUNCH_REMIND_URL: h.url, PUNCH_REMIND_KEY: KEY });
    eq('C3 正式送', [c3.code, h.hits, fs.existsSync(lastFile(dir))], [0, 1, true]);
  }

  h.server.close();
  tmps.forEach((t) => { try { fs.rmSync(t, { recursive: true, force: true }); } catch (e) {} });
  console.log(fail ? `✗ ${fail} 項失敗（${pass} 通過）` : `✓ 全部通過（${pass} 項）`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
