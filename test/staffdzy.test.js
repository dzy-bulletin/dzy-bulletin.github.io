// node test/staffdzy.test.js — 同仁名單改讀管理系統（F6／階段 7：G1 新同步路徑、G2 搬家＋雙跑＋快照＋回退開關、G3 拿掉打卡同步）
// 全部假資料（假姓名「測試甲」…、假 DZY 編號），本機假 HTTP 當管理系統，不連任何外部網址；子程序一律 DZYB_NO_DOTENV=1。
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), vm = require('vm'), crypto = require('crypto');
const { spawn } = require('child_process');
const L = require('../js/logic.js');
const { makeAuth_ } = require('../gas/Auth.js');
const { makeService_ } = require('../gas/Service.js');
const { makeSqliteStore } = require('../server/store-sqlite.js');
const { runMirror } = require('../server/mirror.js');
const SD = require('../server/staff-dzy.js');
const { makeFakeGas } = require('./fake-gas.js');

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; console.log('✗', name, '\n   got ', g, '\n   want', w); }
}
const tmps = [], servers = [];
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p || 'dzyb-sd-')); tmps.push(d); return d; };
const quiet = async (fn) => { const o = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = o; } };
const nodeCrypto = { sha256Hex: (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex'),
  hmacB64url: (k, m) => crypto.createHmac('sha256', Buffer.from(k, 'utf8')).update(m, 'utf8').digest('base64url'), randomHex: (n) => crypto.randomBytes(n).toString('hex') };
const A = makeAuth_(nodeCrypto, L);
const H1 = A.lineHash('U1'), H2 = A.lineHash('U2'), H3 = A.lineHash('U3');
const canon = (o) => JSON.stringify(Array.isArray(o) ? o.map((x) => JSON.parse(canon(x))) : Object.keys(o).sort().reduce((m, k) => { m[k] = o[k]; return m; }, {}));
const withHash = (list) => list.map((s) => Object.assign({ lineHash: '' }, s));
const NOW = '2026-10-13T02:00:00.000Z';

const S0 = (id, name, unit, extra) => Object.assign({ id, name, unit, pinHash: '', salt: '', pinVer: 0, fail: 0, active: true, createdAt: '', deletedAt: '', src: '', store: '', lineHash: '' }, extra || {});
// 管理系統的人：clocks 寫成 [store_code, emp_id, role]
const P = (dzy, name, unit, active, clocks) => ({ emp_no: dzy, name, unit, unit_name: unit, active, clocks: (clocks || []).map((c) => ({ store_code: c[0], emp_id: c[1], role: c[2] || 'home' })) });
const N = (list) => SD.normalizeDirectory(list);
const R = (src, empId, name, extra) => Object.assign({ src, unit: 'mala', store: '', empId, name, active: true, lineHash: '' }, extra || {});
const GOT = (rows, sources) => ({ rows, sources: sources || ['gf', 'js', 'mgf', 'cf', 'hq', 'lzl'], errors: [], counts: {}, messages: [] });
const by = (r, id) => r.staff.find((s) => s.id === id);

// ---------- 0. store_code 對照（寫死並測試）----------
eq('對照：佈告欄來源代號 → 管理系統 store_code', SD.STORE_OF_SRC, { gf: 'gf', js: 'mztjs', mgf: 'mztgf', lzl: 'mztlzl', hq: 'hq', cf: 'cf' });
eq('對照：反向查表一一對應', Object.keys(SD.STORE_OF_SRC).every((k) => SD.SRC_OF_STORE[SD.STORE_OF_SRC[k]] === k) && Object.keys(SD.SRC_OF_STORE).length === 6, true);
eq('對照：管理系統六家店 gf／mztjs／mztgf／mztlzl／hq／cf 都有對到', ['gf', 'mztjs', 'mztgf', 'mztlzl', 'hq', 'cf'].map((s) => !!SD.SRC_OF_STORE[s]), [true, true, true, true, true, true]);
eq('對照：clockKeyOfSrc', [SD.clockKeyOfSrc('js:J1'), SD.clockKeyOfSrc('mgf:G01'), SD.clockKeyOfSrc('xx:1'), SD.clockKeyOfSrc(''), SD.clockKeyOfSrc('gf:')], ['mztjs:J1', 'mztgf:G01', '', '', '']);
eq('對照：單位代碼', Object.keys(SD.UNIT_OF_DZY).sort(), ['ck', 'dzy-hq', 'mala-gf', 'mzt-gf', 'mzt-js', 'mzt-lzl']);

// ---------- 1. normalizeDirectory ----------
{ const d = N([P('DZY001', '測試甲', 'mala-gf', true, [['gf', 'A1']]), P('DZY002', '測試乙', 'mala-gf', true, [['gf', 'A1']]), P('DZY003', '', 'mala-gf', true), { emp_no: '', name: 'x' },
    P('DZY004', '測試丁', 'ck', true, [['cf', 'C1'], ['', 'x']]), P('DZY004', '重複編號', 'ck', true, [['cf', 'C9']])]);
  eq('目錄：壞列丟掉（2 列）、重複 emp_no 只留第一筆', [d.people.length, d.badRows.length, d.dupNo], [3, 2, ['DZY004']]);
  eq('目錄：同一打卡鍵掛在兩人身上＝不拿來對', Object.keys(d.ambiguousKeys).sort(), ['cf:C1', 'gf:A1']);
  eq('目錄：空的 store／emp_id 的 clock 丟掉', d.byDzy.DZY004.clocks.length, 1);
  let e = null; try { N({ x: 1 }); } catch (x) { e = x.code; } eq('目錄：不是陣列→丟錯 DIR_BAD', e, 'DIR_BAD'); }

// ---------- 2. G1 dzyApply：新增／停用／復職／改名／單位／主店 ----------
{ const staff = [S0('S-001', '舊名字', 'mala', { src: 'gf:A1', dzy: 'DZY001' }), S0('S-002', '測試乙', 'mzt', { src: 'js:J1', store: '金山', dzy: 'DZY002' }), S0('S-003', '測試丙', 'mala', { src: 'gf:A3', dzy: 'DZY003' }),
    S0('S-004', '測試丁', 'cf', { src: 'cf:C1', dzy: 'DZY004', active: false, deletedAt: 'x', offBy: 'dzy' }), S0('S-005', '手動刪的', 'mala', { src: 'gf:A5', dzy: 'DZY005', active: false, deletedAt: 'y' }),
    S0('S-006', '總部人', 'hq-mzt', { src: 'hq:H1', dzy: 'DZY006' })];
  const before = JSON.stringify(staff);
  const dir = N([P('DZY001', '新名字', 'mala-gf', true, [['gf', 'A1']]),                                  // 改名
    P('DZY002', '測試乙', 'mzt-gf', true, [['mztjs', 'J1', 'support'], ['mztgf', 'G7', 'home']]),         // 主店換成墨竹亭光復：src／單位門市跟著 home
    P('DZY003', '測試丙', 'mala-gf', false, [['gf', 'A3']]),                                              // 離職
    P('DZY004', '測試丁', 'ck', true, [['cf', 'C1']]),                                                    // dzy 停用的人復職
    P('DZY005', '手動刪的', 'mala-gf', true, [['gf', 'A5']]),                                             // 佈告欄手動刪的：不加回
    P('DZY006', '總部人', 'dzy-hq', true, [['hq', 'H1']]),                                                // 總部：維持原組別
    P('DZY007', '測試新人', 'mala-gf', true, [['gf', 'A7']]),                                             // 新人
    P('DZY008', '總部新人', 'dzy-hq', true, [['hq', 'H8']]),
    P('DZY009', '怪單位', 'zzz', true, [['gf', 'A9']])]);                                                 // 單位代碼不在對照表：不新增
  const r = SD.dzyApply(staff, dir, GOT([]), NOW);
  eq('G1 不改動傳入的名單', JSON.stringify(staff), before);
  eq('G1 改名同步：S-001 名字更新、其他欄位（S-xxx、src）不變', [by(r, 'S-001').name, by(r, 'S-001').id, by(r, 'S-001').src, r.ch.renamed], ['新名字', 'S-001', 'gf:A1', ['S-001']]);
  eq('G1 主店＝role home：src 跟著 home、單位＋門市更新', [by(r, 'S-002').src, by(r, 'S-002').unit, by(r, 'S-002').store, r.ch.moved, r.ch.srcChanged], ['mgf:G7', 'mzt', '光復', ['S-002'], ['S-002']]);
  eq('G1 離職停用：S-003 停用、記下是 dzy 停的、LINE 清空', [by(r, 'S-003').active, by(r, 'S-003').offBy, by(r, 'S-003').deletedAt, by(r, 'S-003').lineHash], [false, 'dzy', NOW, '']);
  eq('G1 復職：dzy 停用的人恢復、offBy 清掉', [by(r, 'S-004').active, 'offBy' in by(r, 'S-004'), by(r, 'S-004').deletedAt], [true, false, '']);
  eq('G1 手動刪除的人不被復活（只在 notes 提一句）', [by(r, 'S-005').active, r.notes.filter((n) => /S-005/.test(n)).length], [false, 1]);
  eq('G1 總部既有的人單位不動（管理系統不分三組）', [by(r, 'S-006').unit, r.ch.moved.includes('S-006')], ['hq-mzt', false]);
  const nw = r.staff.find((s) => s.dzy === 'DZY007');
  eq('G1 新人新增：S 編號接續最大號、單位門市 src 依管理系統', [nw.id, nw.unit, nw.store, nw.src, nw.active, nw.lineHash, !!nw.pinHash], ['S-007', 'mala', '', 'gf:A7', true, '', false]);
  const hq = r.staff.find((s) => s.dzy === 'DZY008');
  eq('G1 總部新人先歸總部鼎兆元並提示', [hq.id, hq.unit, r.notes.some((n) => /S-008/.test(n) && /總部/.test(n))], ['S-008', 'hq-dzy', true]);
  eq('G1 單位代碼不在對照表→不新增、列入 skipped', [r.staff.some((s) => s.dzy === 'DZY009'), r.ch.skipped], [false, ['DZY009']]);
  eq('G1 S-xxx 不改、不回收：原有 6 筆編號與順序不變', r.staff.slice(0, 6).map((s) => s.id), ['S-001', 'S-002', 'S-003', 'S-004', 'S-005', 'S-006']);
  eq('G1 notes 與 changed 不含姓名', /新名字|測試|手動刪的|總部人/.test(JSON.stringify([r.notes, r.ch, r.changed])), false);
  const r2 = SD.dzyApply(r.staff, dir, GOT([]), NOW);
  eq('G1 冪等：套用後再跑一次沒有任何變動', [r2.changed, r2.ch.added.length], [[], 0]); }

// G1 新人編號：已刪除的 S-xxx 也算最大號（不回收）
{ const r = SD.dzyApply([S0('S-001', '甲', 'mala', { active: false, dzy: 'DZY001' }), S0('S-009', '乙', 'mala', { active: false, dzy: 'DZY009' })], N([P('DZY010', '丙', 'mala-gf', true, [['gf', 'A1']])]), GOT([]), NOW);
  eq('G1 不回收編號：已刪除的 S-009 之後新人是 S-010', r.staff.find((s) => s.dzy === 'DZY010').id, 'S-010'); }

// G1 認領：既有 src 經 clocks 唯一對上才掛 dzy，不重複新增；對到兩筆在職不猜
{ const staff = [S0('S-001', '測試甲', 'mala', { src: 'gf:A1' }), S0('S-002', '測試乙', 'mala', { src: 'gf:A2' }), S0('S-003', '測試乙', 'mala', { src: 'gf:A2' }), S0('S-004', '手動人', 'mala')];
  const r = SD.dzyApply(staff, N([P('DZY001', '測試甲', 'mala-gf', true, [['gf', 'A1']]), P('DZY002', '測試乙', 'mala-gf', true, [['gf', 'A2']])]), GOT([]), NOW);
  eq('G1 認領：src 唯一對上→掛 dzy、不新增', [by(r, 'S-001').dzy, r.staff.length, r.ch.adopted], ['DZY001', 4, ['S-001']]);
  eq('G1 認領：同一 src 兩筆在職→不認領、不新增、notes 點名 S 編號', [by(r, 'S-002').dzy || '', by(r, 'S-003').dzy || '', r.notes.some((n) => /S-002、S-003/.test(n)), r.ch.skipped], ['', '', true, ['DZY002']]);
  eq('G1 沒有 dzy 的手動同仁不被碰（unmanaged 列出）', [by(r, 'S-004').active, r.unmanaged.includes('S-004')], [true, true]); }

// ---------- 3. G1 LINE 雜湊來源不變（仍由打卡名冊算，用 clocks 找到同一人的打卡列）----------
{ const dir = N([P('DZY001', '測試甲', 'mala-gf', true, [['gf', 'A1']]), P('DZY002', '測試乙', 'mzt-js', true, [['mztjs', 'J2', 'home'], ['mztgf', 'G2', 'support']]),
    P('DZY003', '測試丙', 'mala-gf', true, [['gf', 'A3']]), P('DZY004', '測試丁', 'mala-gf', true, [['gf', 'A4']])]);
  const staff = [S0('S-001', '測試甲', 'mala', { src: 'gf:A1', dzy: 'DZY001' }), S0('S-002', '測試乙', 'mzt', { src: 'js:J2', store: '金山', dzy: 'DZY002', lineHash: H1, pinVer: 2 }),
    S0('S-003', '測試丙', 'mala', { src: 'gf:A3', dzy: 'DZY003', lineHash: H3, pinVer: 5 }), S0('S-004', '測試丁', 'mala', { src: 'gf:A4', dzy: 'DZY004' })];
  const got = GOT([R('gf', 'A1', '測試甲', { lineHash: H1 }), R('js', 'J2', '測試乙'), R('mgf', 'G2', '測試乙', { unit: 'mzt', lineHash: H2 }), R('gf', 'A3', '測試丙', { lineHash: '' }), R('gf', 'A4', '測試丁', { lineHash: H3, active: false })]);
  const r = SD.dzyApply(staff, dir, got, NOW);
  eq('LINE：單一來源的人，結果與舊路徑 L.lineHashUpdates 一致（來源不變）', [by(r, 'S-001').lineHash, L.lineHashUpdates([{ id: 'S-001', src: 'gf:A1', lineHash: '' }], got)[0].lineHash], [H1, H1]);
  eq('LINE：主店沒綁、另一店綁了→取另一店（同舊路徑的合併）；換綁 pinVer+1', [by(r, 'S-002').lineHash, by(r, 'S-002').pinVer], [H2, 3]);
  eq('LINE：打卡解綁→清空並 pinVer+1（踢掉舊登入）', [by(r, 'S-003').lineHash, by(r, 'S-003').pinVer], ['', 6]);
  eq('LINE：打卡名冊裡已離職的列不算綁定；從沒綁→綁上不 bump', [by(r, 'S-004').lineHash, by(r, 'S-004').pinVer], ['', 0]);
  const g2 = GOT([R('gf', 'A1', '測試甲', { lineHash: H1 })], ['js']);       // gf 這輪讀不到
  eq('LINE：來源讀不到→不動（不清空、不 bump）', [SD.dzyApply(staff, dir, g2, NOW).staff.map((s) => s.lineHash + '|' + s.pinVer)], [staff.map((s) => s.lineHash + '|' + s.pinVer)]);
  const g3 = GOT([{ src: 'gf', empId: 'A3', name: 'x', active: true }, R('gf', 'A1', 'x', { lineHash: H2 })]);   // A3 那列沒有 lineHash 屬性＝名冊少了欄，但 gf 還有別列帶 lineHash
  eq('LINE：整個來源都沒有 lineHash 屬性＝不知道綁定狀態→那店整店不動', SD.dzyApply(staff, dir, GOT([{ src: 'gf', empId: 'A3', active: true }, { src: 'gf', empId: 'A1', active: true }]), NOW).staff.map((s) => s.lineHash), [ '', H1, H3, '']);
  eq('LINE：沒有打卡名單（橋接失敗 got=null）→全部不動，其他欄位照常同步', SD.dzyApply(staff, dir, null, NOW).staff.map((s) => s.lineHash), ['', H1, H3, '']);
  eq('LINE：換新的 got 讀取剛好部分來源（gf 在、js 不在）→主店在 js 的人不動', SD.dzyApply(staff, dir, g2, NOW).staff[1].lineHash, H1); }

// ---------- 4. 煞車 ----------
{ const st = Array.from({ length: 10 }, (_, i) => S0('S-' + String(i + 1).padStart(3, '0'), '甲' + i, 'mala', { dzy: 'DZY' + (i + 1) }));
  const dir = N(st.map((s, i) => P(s.dzy, s.name, 'mala-gf', i >= 3, [])));
  const r = SD.dzyApply(st, dir, null, NOW);
  eq('煞車：一次要停用 3 人（≤ max(3,20%)）可以', SD.massProblem(st, r.ch), '');
  const dir2 = N(st.map((s, i) => P(s.dzy, s.name, 'mala-gf', i >= 4, [])));
  eq('煞車：一次要停用 4 人（超過上限 3）→擋', /超過上限 3/.test(SD.massProblem(st, SD.dzyApply(st, dir2, null, NOW).ch)), true); }

// ---------- 5. 管理系統端點（本機假 HTTP）----------
function fakePlatform(rows, key) {
  const h = { mode: 'ok', hits: [], rows, key: key || 'KEY-OK' };
  h.server = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      let j = {}; try { j = JSON.parse(b); } catch (e) {}
      h.hits.push({ url: req.url, ct: req.headers['content-type'], action: j.action, hasKey: !!(j.payload && j.payload.svc_key), tokenInBody: 'token' in j });
      if (h.mode === 'down') { req.socket.destroy(); return; }
      res.setHeader('Content-Type', 'application/json');
      if (h.mode === 'html') return res.end('<html>x</html>');
      if (j.action !== 'svcDirectory' || !j.payload || j.payload.svc_key !== h.key) return res.end(JSON.stringify({ ok: false, error: '服務金鑰錯誤', code: 'unauthorized' }));
      res.end(JSON.stringify({ ok: true, data: h.rows }));
    });
  });
  return new Promise((ok) => h.server.listen(0, '127.0.0.1', () => { h.url = 'http://127.0.0.1:' + h.server.address().port + '/platform/api'; servers.push(h.server); ok(h); }));
}

const seed = (dir, staff, flag) => {
  const st = makeSqliteStore(dir);
  st.load({ posts: [], staff, reads: [], log: [] });
  if (flag) st.kvSet(SD.MIGRATED_KEY, 'x');
  st.close();
};
const dump = (dir) => { const st = makeSqliteStore(dir), s = st.getStaff(); st.close(); return s; };
const kvOf = (dir, k) => { const st = makeSqliteStore(dir), v = st.kvGet(k); st.close(); return v; };
const bridgeOf = (got, fail) => { const b = { calls: [] }; b.call = async (op, p) => { b.calls.push([op, JSON.stringify(p)]); if (op === 'clock') { if (fail) throw new Error('Google 雲端暫時連不上'); return JSON.parse(JSON.stringify(got)); }
  if (op === 'mirror') return { counts: {} }; if (op === 'sigs') return { ids: [] }; if (op === 'filelist') return { files: [], nextPageToken: '' }; throw new Error('未知 op ' + op); }; return b; };

(async () => {
  const people = [P('DZY001', '測試甲', 'mala-gf', true, [['gf', 'A1']]), P('DZY002', '測試乙', 'mzt-js', true, [['mztjs', 'J2']]), P('DZY003', '測試丙', 'mala-gf', true, [['gf', 'A3']])];
  const plat = await fakePlatform(people, 'KEY-OK');
  const cfgOk = { url: plat.url, key: 'KEY-OK' };
  let d = await SD.fetchDirectory(cfgOk);
  eq('端點：POST text/plain、action svcDirectory、金鑰在本文（不是網址）、不帶登入 token', [plat.hits[0].ct, plat.hits[0].action, plat.hits[0].hasKey, plat.hits[0].url, plat.hits[0].tokenInBody], ['text/plain', 'svcDirectory', true, '/platform/api', false]);
  eq('端點：讀到 3 人', d.people.length, 3);
  const bad = async (cfg, f) => { try { await SD.fetchDirectory(cfg, f); return 'no-error'; } catch (e) { return e.code + '|' + /KEY-/.test(e.message); } };
  eq('端點：金鑰錯→DIR_REJECT，訊息不帶金鑰', await bad({ url: plat.url, key: 'KEY-BAD' }), 'DIR_REJECT|false');
  eq('端點：沒設網址或金鑰→DIR_CFG', [await bad({ url: '', key: 'k' }), await bad({ url: plat.url, key: '' })], ['DIR_CFG|false', 'DIR_CFG|false']);
  eq('端點：非本機網址一律拒絕（金鑰不出本機）', await bad({ url: 'https://example.com/platform/api', key: 'KEY-OK' }), 'DIR_CFG|false');
  plat.mode = 'down'; eq('端點：連線被切斷→DIR_NET', await bad(cfgOk), 'DIR_NET|false');
  plat.mode = 'html'; eq('端點：回應不是 JSON→DIR_NET', await bad(cfgOk), 'DIR_NET|false'); plat.mode = 'ok';
  eq('端點：dirConfig 讀 DZY_PLATFORM_URL／BULLETIN_SVC_KEY', SD.dirConfig({ DZY_PLATFORM_URL: ' http://127.0.0.1:8799/platform/api ', BULLETIN_SVC_KEY: 'k' }), { url: 'http://127.0.0.1:8799/platform/api', key: 'k' });

  // ---------- 6. 回退開關：預設 clock ----------
  const kv = (v) => (k) => (k === SD.MIGRATED_KEY ? v : null);
  eq('開關：沒設 STAFF_SOURCE→clock（今天行為）', [SD.effectiveSource({}, kv('x')), SD.effectiveSource({ STAFF_SOURCE: '' }, kv('x')), SD.effectiveSource({ STAFF_SOURCE: 'clock' }, kv('x')), SD.effectiveSource({ STAFF_SOURCE: '亂寫' }, kv('x'))], ['clock', 'clock', 'clock', 'clock']);
  eq('開關：dzy 但搬家還沒通過→仍是 clock 並警告', [SD.effectiveSource({ STAFF_SOURCE: 'dzy' }, kv(null)), /搬家腳本還沒通過/.test(SD.sourceWarning({ STAFF_SOURCE: 'dzy' }, kv(null)))], ['clock', true]);
  eq('開關：dzy＋搬家通過→dzy（大小寫不拘）、無警告', [SD.effectiveSource({ STAFF_SOURCE: ' DZY ' }, kv('2026')), SD.sourceWarning({ STAFF_SOURCE: 'dzy' }, kv('2026'))], ['dzy', '']);
  const { config } = require('../server/index.js');
  eq('開關：伺服器設定預設 clock、dzy 要明確設', [config({}).STAFF_SOURCE, config({ STAFF_SOURCE: 'dzy' }).STAFF_SOURCE, config({ STAFF_SOURCE: 'x' }).STAFF_SOURCE], ['clock', 'dzy', 'clock']);

  // ---------- 7. G3 Service：dzy 時沒有打卡同步 ----------
  { const mem = (staff) => { const d = { posts: [], staff, reads: [], log: [] };
      return { d, getPosts: () => [], savePost: () => {}, getStaff: () => JSON.parse(JSON.stringify(d.staff)), saveStaff: (x) => { const i = d.staff.findIndex((y) => y.id === x.id); if (i >= 0) d.staff[i] = x; else d.staff.push(x); },
        getReads: () => [], addRead: () => {}, addLog: (e) => d.log.push(e), getAdmin: () => ({ hash: A.hashPin('s', 'adminpass'), salt: 's', ver: 1, fail: 0, lockUntil: 0, init: '' }), setAdmin: () => {}, secret: () => 'SECRET' }; };
    const clk = { nowMs: () => Date.now(), today: () => L.today(new Date()) };
    let synced = 0; const src = { read: () => { synced++; return { rows: [], errors: [], sources: [], counts: {} }; } };
    const st = mem([S0('S-001', '測試甲', 'mala')]);
    const at = A.makeAdminToken('SECRET', 1, Date.now() + 60e3);
    const sv0 = makeService_(L, st, { quota: () => null }, A, clk, src), sv1 = makeService_(L, st, { quota: () => null }, A, clk, src, null, { staffSource: 'dzy' }), sv2 = makeService_(L, st, { quota: () => null }, A, clk, src, null, { staffSource: 'clock' });
    eq('G3 Service：預設（沒給 opts）syncClock 照常讀打卡、adminData.staffSource＝clock', [sv0.call('syncClock', { atoken: at }).ok, synced, sv0.call('adminData', { atoken: at }).data.staffSource], [true, 1, 'clock']);
    eq('G3 Service：staffSource=clock 同上', [sv2.call('syncClock', { atoken: at }).ok, sv2.call('adminData', { atoken: at }).data.staffSource], [true, 'clock']);
    const r = sv1.call('syncClock', { atoken: at });
    eq('G3 Service：staffSource=dzy→syncClock 拒絕、不讀打卡名單', [r.ok, r.code, /管理系統/.test(r.message), synced], [false, 'BAD_REQ', true, 2]);
    eq('G3 Service：staffSource=dzy→adminData 告知前端', sv1.call('adminData', { atoken: at }).data.staffSource, 'dzy');
    eq('G3 Service：dzy 時其他同仁管理照常（新增同仁）', sv1.call('staffAdd', { atoken: at, name: '測試戊', unit: 'mala' }).ok, true); }
  // G3 管理頁：dzy 時不顯示打卡同步按鈕（測 js/admin.js 原始碼的條件分支）
  { const code = fs.readFileSync(path.join(__dirname, '..', 'js/admin.js'), 'utf8'), i = code.indexOf("a.data.staffSource === 'dzy'");
    const seg = code.slice(i, code.indexOf('return top +', i));
    const [dzyBranch, clockBranch] = seg.split("\n      : ");
    eq('G3 管理頁：按鈕 syncBtn 只在非 dzy 的分支出現', [i > 0, /id="syncBtn"/.test(dzyBranch), /id="syncBtn"/.test(clockBranch || '')], [true, false, true]);
    eq('G3 管理頁：dzy 分支不提打卡系統主店判定', /Eason 判定/.test(dzyBranch), false); }
  // G3 程式不再讀判定表：raw 模式的 GAS 打卡名冊讀取不套 CLOCK_PRIMARY_
  { const fg = makeFakeGas(), G = fg.G, book = fg.book, roster = book.insertSheet('roster');
    roster.getDataRange = () => ({ getValues: () => roster.data });
    roster.data.push(['emp_id', 'name', 'active', 'removed_at', 'line_user_id'], ['A1', '測試甲', true, '', 'U-a'], ['A2', '測試乙', true, '', '']);
    const save = G.SpreadsheetApp.openById, books = { GF: roster.data, JS: [roster.data[0], ['J1', '測試乙', true, '', 'U-b']] };
    G.SpreadsheetApp.openById = (id) => (books[id] ? { getSheetByName: () => ({ getDataRange: () => ({ getValues: () => books[id] }) }) } : save(id));
    G.CLOCK_SOURCES_ = [{ src: 'gf', unit: 'mala', ssId: 'GF', label: '光復' }, { src: 'js', unit: 'mzt', store: '金山', ssId: 'JS', label: '金山' }];
    G.CLOCK_PRIMARY_ = { 測試乙: { src: 'gf', unit: 'mala', store: '' } };
    const norm = vm.runInContext('clockSource_().read()', G), raw = vm.runInContext('clockSource_().read({ raw: true })', G);
    eq('GAS 一般模式：套用 CLOCK_PRIMARY_（跨店同名標 decided／dupOf）', norm.rows.some((r) => r.decided || r.dupOf), true);
    eq('GAS raw 模式：不套判定表（沒有 decided／dupOf／hold）、沒有判定訊息、帶 raw 標記', [raw.rows.some((r) => r.decided || r.dupOf || r.hold), raw.messages, raw.raw, raw.rows.length], [false, [], true, 3]);
    eq('GAS raw 模式：LINE 仍只交出雜湊', [JSON.stringify(raw).includes('U-a'), raw.rows.find((r) => r.empId === 'A1').lineHash], [false, A.lineHash('U-a')]);
    eq('GAS 橋接 clock op：帶 raw:true 才走 raw', [vm.runInContext('gasBridgeDeps_().clock({ raw: true })', G).raw, vm.runInContext('gasBridgeDeps_().clock({})', G).raw, vm.runInContext('gasBridgeDeps_().clock()', G).raw], [true, undefined, undefined]);
    eq('GAS 同仁表多一欄 dzy（最後一欄）', vm.runInContext('SHEETS_.staff.cols', G).slice(-2), ['lineHash', 'dzy']); }

  // ---------- 8. G1 runDzySync（SQLite）----------
  { const dir = tmp(); const staff = [S0('S-001', '舊名', 'mala', { src: 'gf:A1', dzy: 'DZY001' }), S0('S-002', '測試乙', 'mzt', { src: 'js:J2', store: '金山', dzy: 'DZY002', lineHash: H1 })];
    seed(dir, staff, false);
    const got = GOT([R('gf', 'A1', 'x', { lineHash: H1 }), R('js', 'J2', 'x', { unit: 'mzt' }), R('gf', 'A3', 'x')]);
    const fetchDir = () => SD.fetchDirectory(cfgOk), B = bridgeOf(got);
    let r = await SD.runDzySync({ dir, bridge: B, fetchDir });
    eq('sync：搬家沒通過（沒旗標）→拒絕、什麼都沒寫', [r.ok, /搬家腳本/.test(r.error), JSON.stringify(dump(dir))], [false, true, JSON.stringify(staff.map((s) => Object.assign({}, s)))]);
    seed(dir, dump(dir), true);
    r = await SD.runDzySync({ dir, bridge: B, fetchDir, dryRun: true });
    eq('sync dryRun：回報會做什麼但不寫', [r.ok, r.dryRun, r.changes.added, r.changes.renamed, dump(dir).length], [true, true, 1, 1, 2]);
    r = await SD.runDzySync({ dir, bridge: B, fetchDir, now: () => new Date(NOW) });
    const after = dump(dir);
    eq('sync：新人新增、改名同步、LINE 照打卡名冊（bridge 以 raw 模式讀）', [r.ok, after.length, after[0].name, after[2].dzy, after[2].id, B.calls[0][0], JSON.parse(B.calls[0][1]).raw], [true, 3, '測試甲', 'DZY003', 'S-003', 'clock', true]);
    eq('sync：S-002 的 LINE（打卡名冊沒綁）清空並 pinVer+1、S-001 綁上（不 bump）', [after[1].lineHash, after[1].pinVer, after[0].lineHash, after[0].pinVer], ['', 1, H1, 0]);
    eq('sync：回報只有筆數（不含姓名）', /測試|舊名/.test(JSON.stringify(r)), false);
    r = await SD.runDzySync({ dir, bridge: B, fetchDir });
    eq('sync：再跑一次冪等（updated 0）', [r.ok, r.updated], [true, 0]);
    // 讀不到管理系統＝整輪不動
    const before = JSON.stringify(dump(dir)); plat.mode = 'down';
    r = await SD.runDzySync({ dir, bridge: B, fetchDir });
    eq('sync：管理系統連不上→整輪不動（不會誤停用）', [r.ok, JSON.stringify(dump(dir)) === before], [false, true]); plat.mode = 'ok';
    // 空名單＝整輪不動
    r = await SD.runDzySync({ dir, bridge: B, fetchDir: async () => N([]) });
    eq('sync：管理系統回空名單→整輪不動', [r.ok, /空的/.test(r.error), JSON.stringify(dump(dir)) === before], [false, true, true]);
    // 打卡名冊讀不到：其他欄位照同步、LINE 不動
    seed(dir, dump(dir).map((s) => (s.id === 'S-001' ? Object.assign(s, { name: '又舊了' }) : s)), true);
    r = await SD.runDzySync({ dir, bridge: bridgeOf(got, true), fetchDir });
    eq('sync：打卡名冊讀不到→改名照做、LINE 不動、回報 lineSkipped', [r.ok, dump(dir)[0].name, dump(dir)[0].lineHash, /讀打卡名單失敗/.test(r.lineSkipped)], [true, '測試甲', H1, true]);
    // 大量停用煞車
    const big = Array.from({ length: 8 }, (_, i) => S0('S-' + String(i + 1).padStart(3, '0'), '人' + i, 'mala', { dzy: 'DZY' + (i + 1) })), dir2 = tmp(); seed(dir2, big, true);
    const gone = async () => N(big.map((s) => P(s.dzy, s.name, 'mala-gf', false, [])));
    r = await SD.runDzySync({ dir: dir2, bridge: B, fetchDir: gone });
    eq('sync：管理系統把 8 人全設離職→煞車、不動', [r.ok, /超過上限/.test(r.error), dump(dir2).filter((s) => s.active).length], [false, true, 8]);
    r = await SD.runDzySync({ dir: dir2, bridge: B, fetchDir: gone, allowMass: true });
    eq('sync：確認過加 allowMass 才停用', [r.ok, dump(dir2).filter((s) => s.active).length], [true, 0]); }

  // ---------- 9. G2 搬家分類 ----------
  { const dirN = N([P('DZY001', '測試甲', 'mala-gf', true, [['gf', 'A1']]), P('DZY002', '測試乙', 'mzt-js', true, [['mztjs', 'J2'], ['mztgf', 'G2', 'support']]), P('DZY003', '測試丙', 'mala-gf', true, [['gf', 'A3']]),
      P('DZY004', '測試丁', 'mala-gf', true, [['gf', 'A4']]), P('DZY005', '測試戊', 'mala-gf', true, [['gf', 'A4']]),                         // A4 掛在兩個人身上→多重
      P('DZY006', '測試己', 'mala-gf', true, [['gf', 'A6']]), P('DZY007', '另一個名字', 'mala-gf', true, [['gf', 'A7']]),
      P('DZY008', '手動庚', 'dzy-hq', true, [['hq', 'H8']])]);
    const staff = [S0('S-001', '測試甲', 'mala', { src: 'gf:A1' }), S0('S-002', '測試乙', 'mzt', { src: 'js:J2', store: '金山' }), S0('S-003', '測試丙', 'mala', { src: 'gf:A99' }),   // A99 管理系統沒有→無對照
      S0('S-004', '測試丁', 'mala', { src: 'gf:A4' }), S0('S-005', '手動新增', 'mala'),                                                                      // 沒有 src→無對照
      S0('S-006', '測試己', 'mala', { src: 'gf:A6' }), S0('S-007', '測試己舊', 'mala', { src: 'gf:A6', active: false }),                                   // 已刪除的同一人→只掛在職那筆
      S0('S-008', '本名', 'mala', { src: 'gf:A7' }), S0('S-009', '刪掉的', 'mala', { src: 'gf:ZZ', active: false })];
    const c = SD.classifyMigration(staff, dirN, {});
    const st = (id) => c.items.find((i) => i.id === id);
    eq('分類：唯一對上（src 經 clocks）', [st('S-001').status, st('S-001').dzy, st('S-002').status, st('S-002').dzy], ['unique', 'DZY001', 'unique', 'DZY002']);
    eq('分類：無對照（管理系統沒這個打卡編號／手動新增沒有 src）', [st('S-003').status, st('S-005').status], ['none', 'none']);
    eq('分類：多重對照（同一打卡編號掛在兩人身上）', st('S-004').status, 'multi');
    eq('分類：同一人兩筆、一筆已刪除→只掛在職那筆', [st('S-006').dzy, st('S-007').status, st('S-007').dzy], ['DZY006', 'none', '']);
    eq('分類：姓名與管理系統不同→標 nameDiff（零錯配檢查）', [st('S-008').status, st('S-008').nameDiff, st('S-001').nameDiff], ['unique', true, false]);
    eq('分類：在職／已刪除各三類筆數', [c.active, c.inactive], [{ unique: 4, none: 2, multi: 1 }, { unique: 0, none: 2, multi: 0 }]);
    eq('分類：在職有無對照／多重＝閘門不過', [c.gate.ok, c.gate.noneActive, c.gate.multiActive, c.gate.nameDiffActive], [false, ['S-003', 'S-005'], ['S-004'], ['S-008']]);
    const c2 = SD.classifyMigration(staff, dirN, { 'S-003': 'DZY003', 'S-005': 'DZY008', 'S-099': 'DZY001' });
    eq('分類：人工指定（--map）可補無對照，不能蓋掉 src 已對上的', [st2(c2, 'S-003'), st2(c2, 'S-005'), st2(c2, 'S-001')], [['unique', 'DZY003', 'map'], ['unique', 'DZY008', 'map'], ['unique', 'DZY001', 'src']]);
    // 兩個在職 S 對到同一個 dzy
    const c3 = SD.classifyMigration([S0('S-001', '測試甲', 'mala', { src: 'gf:A1' }), S0('S-002', '測試甲', 'hq-mala', { src: 'gf:A1' })], dirN, {});
    eq('分類：兩個在職 S 對到同一個 dzy→兩筆都算多重', c3.items.map((i) => i.status), ['multi', 'multi']);
    const c4 = SD.classifyMigration([S0('S-001', '測試甲', 'mala', { dzy: 'DZY001' }), S0('S-002', 'x', 'mala', { dzy: 'DZY777' })], dirN, {});
    eq('分類：已有 dzy 且管理系統查得到→算唯一；查不到→無對照', c4.items.map((i) => i.status), ['unique', 'none']); }
  function st2(c, id) { const i = c.items.find((x) => x.id === id); return [i.status, i.dzy, i.from]; }

  // ---------- 10. G2 runMigrate：拒絕、套用、快照、旗標 ----------
  { const people2 = [P('DZY001', '測試甲', 'mala-gf', true, [['gf', 'A1']]), P('DZY002', '測試乙', 'mzt-js', true, [['mztjs', 'J2']]), P('DZY003', '測試丙', 'mala-gf', true, [['gf', 'A3']])];
    const plat2 = await fakePlatform(people2, 'K2'), fetchDir = () => SD.fetchDirectory({ url: plat2.url, key: 'K2' });
    const staff = [S0('S-001', '測試甲', 'mala', { src: 'gf:A1', pinHash: 'PH1', salt: 'SA', pinVer: 2 }), S0('S-002', '測試乙', 'mzt', { src: 'js:J2', store: '金山', lineHash: H1 }), S0('S-003', '測試丙', 'mala', { src: 'gf:A3' }), S0('S-004', '舊人', 'mala', { src: 'gf:OLD', active: false })];
    const dirA = tmp(); seed(dirA, staff, false);
    let r = await SD.runMigrate({ dir: dirA, fetchDir });
    eq('搬家（只檢查）：三類筆數、沒寫入、沒旗標、沒快照', [r.ok, r.applied, r.active, r.inactive, JSON.stringify(dump(dirA)) === JSON.stringify(staff), kvOf(dirA, SD.MIGRATED_KEY), fs.existsSync(path.join(dirA, 'backups'))], [true, false, { unique: 3, none: 0, multi: 0 }, { unique: 0, none: 1, multi: 0 }, true, null, false]);
    r = await SD.runMigrate({ dir: dirA, fetchDir, apply: true, now: new Date(NOW) });
    const snap = JSON.parse(fs.readFileSync(path.join(dirA, 'backups', r.snapshot), 'utf8'));
    eq('搬家 --apply：dzy 填入 3 筆、旗標寫入、快照＝切換前原樣', [r.ok, r.applied, r.filled, dump(dirA).map((s) => s.dzy || ''), !!kvOf(dirA, SD.MIGRATED_KEY), canon(snap) === canon(withHash(staff))], [true, true, 3, ['DZY001', 'DZY002', 'DZY003', ''], true, true]);
    eq('搬家：除了 dzy 其他欄位（S-xxx、密碼、src、LINE）一個都沒變', canon(dump(dirA).map((s) => { const o = Object.assign({}, s); delete o.dzy; return o; })), canon(withHash(staff)));
    eq('搬家：結果物件不含姓名', /測試|舊人/.test(JSON.stringify(r)), false);
    r = await SD.runMigrate({ dir: dirA, fetchDir, apply: true });
    eq('搬家：重跑冪等（filled 0）', [r.ok, r.filled], [true, 0]);
    // 在職有無對照／多重 → 拒絕切換，什麼都不寫
    const dirB = tmp(), badStaff = staff.concat([S0('S-005', '手動新增', 'mala'), S0('S-006', '多重', 'mala', { src: 'gf:A1' })]); seed(dirB, badStaff, false);
    r = await SD.runMigrate({ dir: dirB, fetchDir, apply: true });
    eq('搬家：在職有「無對照」「多重對照」→拒絕切換（ok=false）、點名 S 編號', [r.ok, r.applied, r.active.none, r.active.multi, r.noneActive, r.multiActive, /拒絕切換/.test(r.error)], [false, false, 1, 2, ['S-005'], ['S-001', 'S-006'], true]);
    eq('搬家：拒絕時沒寫任何東西（staff 原樣、無旗標、無快照）', [canon(dump(dirB)) === canon(withHash(badStaff)), kvOf(dirB, SD.MIGRATED_KEY), fs.existsSync(path.join(dirB, 'backups'))], [true, null, false]);
    const dirB2 = tmp(); seed(dirB2, staff.concat([S0('S-005', '手動新增', 'mala')]), false);
    r = await SD.runMigrate({ dir: dirB2, fetchDir, apply: true, overrides: { 'S-005': 'DZY003' } });
    eq('搬家：人工指定撞到已被別人用的 dzy→仍是多重對照、拒絕', [r.ok, r.multiActive.sort()], [false, ['S-003', 'S-005']]);
    // 姓名不一致：擋，除非人工確認
    const dirC = tmp(); seed(dirC, [S0('S-001', '別人的名字', 'mala', { src: 'gf:A1' })], false);
    r = await SD.runMigrate({ dir: dirC, fetchDir, apply: true });
    eq('搬家：姓名與管理系統不同→擋（零錯配）', [r.ok, r.nameDiffActive, kvOf(dirC, SD.MIGRATED_KEY)], [false, ['S-001'], null]);
    r = await SD.runMigrate({ dir: dirC, fetchDir, apply: true, allowNameDiff: true });
    eq('搬家：人工確認姓名差異後（--allow-name-diff）才切', [r.ok, r.applied], [true, true]);
    // 回退開關：搬家通過後 STAFF_SOURCE=clock 仍是舊行為
    eq('回退：搬家通過後，STAFF_SOURCE=clock 仍走舊路徑（旗標不影響）', SD.effectiveSource({ STAFF_SOURCE: 'clock' }, (k) => kvOf(dirA, k)), 'clock');
    eq('回退：STAFF_SOURCE=dzy＋旗標→dzy', SD.effectiveSource({ STAFF_SOURCE: 'dzy' }, (k) => kvOf(dirA, k)), 'dzy');

    // CLI：輸出不含姓名
    const run = (args, env, dir) => new Promise((ok) => { const p = spawn(process.execPath, [path.join(__dirname, '..', 'server/staff-dzy.js')].concat(args), { env: Object.assign({}, process.env, { DZYB_NO_DOTENV: '1', DATA_DIR: dir, DZY_PLATFORM_URL: plat2.url, BULLETIN_SVC_KEY: 'K2' }, env || {}) });
      let out = ''; p.stdout.on('data', (c) => { out += c; }); p.stderr.on('data', (c) => { out += c; }); p.on('close', (code) => ok({ code, out })); });
    const dirD = tmp(); seed(dirD, badStaff, false);
    let o = await run(['migrate', '--apply'], {}, dirD);
    eq('CLI migrate：在職有無對照→exit 1、印三類筆數與 S 編號、不含姓名', [o.code, /在職：唯一對上 \d+、無對照 1、多重對照 2/.test(o.out), /S-005/.test(o.out), /測試|手動新增|多重/.test(o.out.replace(/多重對照/g, ''))], [1, true, true, false]);
    o = await run(['migrate'], {}, dirA);
    eq('CLI migrate（檢查）：通過 exit 0', [o.code, /檢查通過/.test(o.out)], [0, true]);
    o = await run(['migrate'], { BULLETIN_SVC_KEY: 'WRONG' }, dirA);
    eq('CLI：金鑰錯→exit 1、輸出不含金鑰', [o.code, /WRONG|K2/.test(o.out)], [1, false]);
    plat2.mode = 'ok';

    // ---------- 11. G2 雙跑比對 ----------
    const dirE = tmp(); const sE = [S0('S-001', '測試甲', 'mala', { src: 'gf:A1', dzy: 'DZY001', lineHash: H1 }), S0('S-002', '測試乙', 'mzt', { src: 'js:J2', store: '金山', dzy: 'DZY002', lineHash: H2 }), S0('S-003', '測試丙', 'mala', { src: 'gf:A3', dzy: 'DZY003' })];
    seed(dirE, sE, true);
    const gotE = GOT([R('gf', 'A1', 'x', { lineHash: H1 }), R('js', 'J2', 'x', { unit: 'mzt', lineHash: H2 }), R('gf', 'A3', 'x')]);
    const fetchE = () => SD.fetchDirectory({ url: plat2.url, key: 'K2' });
    const t0 = new Date('2026-10-13T04:00:00Z'), day = (n) => () => new Date(t0.getTime() + n * 86400e3);
    const dbBefore = JSON.stringify(dump(dirE));
    let v = await quiet(() => SD.runDual({ dir: dirE, bridge: bridgeOf(gotE), fetchDir: fetchE, now: day(0) }));
    eq('雙跑：新舊兩邊的在職、主店、LINE 雜湊全同→same', [v.same, v.compared, v.counts], [true, 3, { onlyNew: 0, onlyOld: 0, active: 0, home: 0, hash: 0 }]);
    eq('雙跑：只讀，不改 staff', JSON.stringify(dump(dirE)) === dbBefore, true);
    eq('雙跑：結果寫檔（當天檔＋last＋log），內容不含姓名', [fs.existsSync(path.join(dirE, 'logs', 'staff-dual-2026-10-13.json')), fs.existsSync(path.join(dirE, 'logs', 'staff-dual-last.json')), /全同/.test(fs.readFileSync(path.join(dirE, 'logs', 'staff-dual.log'), 'utf8')), /測試/.test(fs.readFileSync(path.join(dirE, 'logs', 'staff-dual-2026-10-13.json'), 'utf8'))], [true, true, true, false]);
    // 差異：LINE 雜湊不同、主店不同、在職不同、管理系統多一個新人
    plat2.rows.splice(0, plat2.rows.length, P('DZY001', '測試甲', 'mala-gf', true, [['gf', 'A1']]), P('DZY002', '測試乙', 'mzt-gf', true, [['mztgf', 'G2']]), P('DZY003', '測試丙', 'mala-gf', false, [['gf', 'A3']]), P('DZY009', '新來的', 'mala-gf', true, [['gf', 'A9']]));
    const gotD = GOT([R('gf', 'A1', 'x', { lineHash: H3 }), R('mgf', 'G2', 'x', { unit: 'mzt', lineHash: H2 })]);
    v = await quiet(() => SD.runDual({ dir: dirE, bridge: bridgeOf(gotD), fetchDir: fetchE, now: day(1) }));
    eq('雙跑：有差異就報不同（LINE／主店／在職／新路徑多出的人各歸各的）', [v.same, v.ids], [false, { onlyNew: ['S-004'], onlyOld: [], active: ['S-003'], home: ['S-002'], hash: ['S-001'] }]);
    eq('雙跑：差異報告只有 S 編號、沒有姓名與雜湊', /測試|新來的|[0-9a-f]{64}/.test(JSON.stringify(v)), false);
    v = await quiet(() => SD.runDual({ dir: dirE, bridge: bridgeOf(gotE, true), fetchDir: fetchE, now: day(2) }));
    eq('雙跑：打卡名冊讀不到＝雜湊沒比到，不能算全同', [v.same, !!v.lineSkipped], [false, true]);
    plat2.mode = 'down';
    let e = ''; try { await quiet(() => SD.runDual({ dir: dirE, bridge: bridgeOf(gotE), fetchDir: fetchE, now: day(3) })); } catch (x) { e = x.code; }
    eq('雙跑：管理系統連不上→丟錯、不留「全同」紀錄', [e, fs.existsSync(path.join(dirE, 'logs', 'staff-dual-2026-10-16.json'))], ['DIR_NET', false]); plat2.mode = 'ok';

    // 連續 7 天全同才可拆舊
    const dirF = tmp(); fs.mkdirSync(path.join(dirF, 'logs'), { recursive: true });
    const put = (date, same) => fs.writeFileSync(path.join(dirF, 'logs', 'staff-dual-' + date + '.json'), JSON.stringify({ date, same }));
    ['2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12'].forEach((x) => put(x, true));
    const nowF = new Date('2026-10-13T04:00:00Z');
    eq('雙跑狀態：連續 6 天全同→還不能拆舊', [SD.dualStatus(dirF, nowF).streak, SD.dualStatus(dirF, nowF).canRetire], [6, false]);
    put('2026-10-13', true);
    eq('雙跑狀態：連續 7 天全同→可拆舊', [SD.dualStatus(dirF, nowF).streak, SD.dualStatus(dirF, nowF).canRetire], [7, true]);
    put('2026-10-10', false);
    eq('雙跑狀態：中間有一天有差異→從那天之後重算，不能拆舊', [SD.dualStatus(dirF, nowF).streak, SD.dualStatus(dirF, nowF).canRetire], [3, false]);
    put('2026-10-10', true); fs.unlinkSync(path.join(dirF, 'logs', 'staff-dual-2026-10-09.json'));
    eq('雙跑狀態：中間缺一天（沒跑）也中斷連續', [SD.dualStatus(dirF, nowF).streak, SD.dualStatus(dirF, nowF).canRetire], [4, false]);
    eq('雙跑狀態：最新紀錄超過一天前→不能拆舊', SD.dualStatus(dirF, new Date('2026-10-20T04:00:00Z')).canRetire, false);
    eq('雙跑：需要天數常數＝7', SD.DUAL_NEED_DAYS, 7);

    // ---------- 12. mirror.js 整合：預設 clock 行為不變；dzy＋旗標才走新路徑 ----------
    const mk = (flag, staffX) => { const dd = tmp(); const st = makeSqliteStore(dd); st.load({ posts: [{ id: 'P-1', title: '公告', units: ['mala'] }], staff: staffX, reads: [], log: [] }); if (flag) st.kvSet(SD.MIGRATED_KEY, 'x'); st.close(); return dd; };
    const sM = [S0('S-001', '舊名', 'mala', { src: 'gf:A1', dzy: 'DZY001' })];
    plat2.rows.splice(0, plat2.rows.length, P('DZY001', '測試甲', 'mala-gf', true, [['gf', 'A1']]));
    const gotM = GOT([R('gf', 'A1', 'x', { lineHash: H1 })], ['gf']);
    let dd = mk(false, sM), B = bridgeOf(gotM);
    let m = await quiet(() => runMirror({ dir: dd, bridge: B, env: { STAFF_SOURCE: 'clock' }, fetchDir: fetchE }));
    eq('mirror 預設 clock：走舊路徑（bridge clock 不帶 raw）、不改名、不同步管理系統', [m.line.ok, m.line.source, JSON.parse(B.calls.find((c) => c[0] === 'clock')[1]).raw, dump(dd)[0].name], [true, undefined, undefined, '舊名']);
    dd = mk(false, sM); B = bridgeOf(gotM);
    m = await quiet(() => runMirror({ dir: dd, bridge: B, env: {}, fetchDir: fetchE }));
    eq('mirror 沒設 STAFF_SOURCE＝clock', [m.line.source, dump(dd)[0].name], [undefined, '舊名']);
    dd = mk(false, sM); B = bridgeOf(gotM);
    m = await quiet(() => runMirror({ dir: dd, bridge: B, env: { STAFF_SOURCE: 'dzy' }, fetchDir: fetchE }));
    eq('mirror dzy 但搬家沒通過→仍走舊路徑（安全預設）', [m.line.source, dump(dd)[0].name], [undefined, '舊名']);
    dd = mk(true, sM); B = bridgeOf(gotM);
    m = await quiet(() => runMirror({ dir: dd, bridge: B, env: { STAFF_SOURCE: 'dzy' }, fetchDir: fetchE }));
    eq('mirror dzy＋搬家通過→走新路徑：改名同步、LINE 綁上、bridge clock 帶 raw', [m.ok, m.line.source, m.line.ok, dump(dd)[0].name, dump(dd)[0].lineHash, JSON.parse(B.calls.find((c) => c[0] === 'clock')[1]).raw], [true, 'dzy', true, '測試甲', H1, true]);
    dd = mk(true, sM); plat2.mode = 'down';
    m = await quiet(() => runMirror({ dir: dd, bridge: bridgeOf(gotM), env: { STAFF_SOURCE: 'dzy' }, fetchDir: fetchE }));
    eq('mirror dzy：管理系統連不上→名單不動、鏡像本身照常 ok', [m.ok, m.line.ok, dump(dd)[0].name], [true, false, '舊名']); plat2.mode = 'ok';
  }
})().catch((e) => { fail++; console.log('✗ 例外', e && e.stack || e); }).finally(() => {
  servers.forEach((s) => { try { s.close(); } catch (e) {} });
  tmps.forEach((d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} });
  console.log(`staffdzy: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
