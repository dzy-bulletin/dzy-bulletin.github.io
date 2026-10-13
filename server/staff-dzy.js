#!/usr/bin/env node
/* 鼎兆元｜電子佈告欄 — 同仁名單改讀管理系統（dzy 平台）：F6／階段 7（G1～G3）
 *
 * 管理系統（同一台 Mac mini，127.0.0.1:8799/platform/api）提供唯讀 action svcDirectory：
 *   [{ emp_no, name, unit, active, clocks:[{ store_code, emp_id, role }] }]（驗 BULLETIN_SVC_KEY；只含 confirmed 對照；沒有手機／生日／地址）。
 * 佈告欄 staff 加欄 `dzy`（＝emp_no），之後以 dzy 為鍵：新人新增、離職停用、改名同步、單位更新；主店＝clocks 中 role=home。
 * LINE 雜湊仍照舊由打卡名冊算（經 bridge 的 clock raw 模式），用 clocks 的 store_code＋emp_id 找到同一人的打卡列。
 * S-xxx 永遠不改、不回收（舊公告簽名紀錄靠它）。
 *
 * 開關（環境變數 STAFF_SOURCE，預設 clock＝今天行為，一切照舊）：
 *   clock＝名單由「打卡同步」產生（Service.syncClock、CLOCK_PRIMARY_ 主店判定表）。
 *   dzy  ＝名單由本檔同步（mirror.js 每小時）；管理頁不顯示「打卡同步」按鈕、syncClock 回錯、橋接讀打卡名冊走 raw（不讀 CLOCK_PRIMARY_）。
 *   設了 dzy 但搬家腳本還沒通過（kv staff_dzy_migrated 沒有）→ 視為 clock，並在紀錄警告（effectiveSource）。回退＝改回 clock、重啟伺服器。
 *
 * 用法（都不印姓名，只印筆數與 S-xxx／DZY 編號）：
 *   node server/staff-dzy.js migrate [--apply] [--map 檔.json] [--allow-name-diff]   搬家：檢查（預設只報告）／填 dzy（先存快照）
 *   node server/staff-dzy.js dual                                                    雙跑比對：今天新舊兩條算出的名單（在職、主店、LINE 雜湊）比一次
 *   node server/staff-dzy.js dual-status                                             連續幾天全同；滿 7 天印「可拆舊」
 *   node server/staff-dzy.js sync [--dry-run]                                        手動跑一次 dzy 同步（STAFF_SOURCE=dzy 時 mirror 每小時也會跑）
 * 環境變數：DZY_PLATFORM_URL（例 http://127.0.0.1:8799/platform/api）、BULLETIN_SVC_KEY、DATA_DIR（server/.env 會讀）。 */
'use strict';
const fs = require('fs');
const path = require('path');
const J = require('./job-common.js');
const L = require('../js/logic.js');

// ---- store_code 對照：佈告欄來源代號（staff.src 冒號前）↔ 管理系統 clock_stores.store_code ----
const STORE_OF_SRC = { gf: 'gf', js: 'mztjs', mgf: 'mztgf', lzl: 'mztlzl', hq: 'hq', cf: 'cf' };
const SRC_OF_STORE = {}; Object.keys(STORE_OF_SRC).forEach((k) => { SRC_OF_STORE[STORE_OF_SRC[k]] = k; });
// 管理系統單位代碼（org unit_code）→ 佈告欄單位／門市。總部（dzy-hq）在管理系統不分三組：新人先歸總部鼎兆元、既有的維持原組別
const UNIT_OF_DZY = {
  'mala-gf': { unit: 'mala', store: '' }, 'mzt-js': { unit: 'mzt', store: '金山' }, 'mzt-gf': { unit: 'mzt', store: '光復' },
  'mzt-lzl': { unit: 'mzt', store: '六張犁' }, 'ck': { unit: 'cf', store: '' }, 'dzy-hq': { hq: true }
};
const MIGRATED_KEY = 'staff_dzy_migrated';
const DUAL_NEED_DAYS = 7;
const HASH_RE = /^[0-9a-f]{64}$/;
const clone = (o) => JSON.parse(JSON.stringify(o));
const srcKey = (s) => String(s || '');

// ================= 純函式 =================

// 管理系統回來的名單整理成內部格式。壞列丟掉並記數；同一 emp_no 出現兩次、同一個 store_code+emp_id 掛在兩個人身上 → 那把 key 不拿來對（ambiguousKeys）
function normalizeDirectory(data) {
  if (!Array.isArray(data)) throw bad('管理系統回傳的名單格式不符');
  const people = [], seen = {}, dupNo = {}, owners = {}, badRows = [];
  data.forEach((r, i) => {
    const dzy = String(r && r.emp_no || '').trim(), name = String(r && r.name || '').trim();
    if (!dzy || !name) { badRows.push(i); return; }
    if (seen[dzy]) { dupNo[dzy] = 1; return; }
    seen[dzy] = 1;
    const clocks = (Array.isArray(r.clocks) ? r.clocks : []).map((c) => ({ store: String(c && c.store_code || '').trim().toLowerCase(), empId: String(c && c.emp_id || '').trim(), role: String(c && c.role || '').trim() }))
      .filter((c) => c.store && c.empId);
    people.push({ dzy, name, unit: String(r.unit || '').trim(), active: r.active === true, clocks });
  });
  people.forEach((p) => p.clocks.forEach((c) => { const k = c.store + ':' + c.empId; (owners[k] = owners[k] || []).indexOf(p.dzy) < 0 && owners[k].push(p.dzy); }));
  const ambiguousKeys = {};
  Object.keys(owners).forEach((k) => { if (owners[k].length > 1) ambiguousKeys[k] = owners[k]; });
  Object.keys(dupNo).forEach((d) => { people.filter((p) => p.dzy === d).forEach((p) => p.clocks.forEach((c) => { ambiguousKeys[c.store + ':' + c.empId] = [d]; })); });
  return { people, byDzy: Object.fromEntries(people.map((p) => [p.dzy, p])), owners, ambiguousKeys, badRows, dupNo: Object.keys(dupNo) };
}
function bad(msg, code) { const e = new Error(msg); e.code = code || 'DIR_BAD'; return e; }

// 佈告欄 src（'gf:123'）→ 管理系統打卡鍵（'gf:123' 的 store_code 版；store_code 小寫，emp_id 原字串）
function clockKeyOfSrc(src) {
  const m = /^([a-z]+):(.+)$/.exec(srcKey(src));
  return m && STORE_OF_SRC[m[1]] ? STORE_OF_SRC[m[1]] + ':' + m[2] : '';
}
function homeSrcOf(p) {
  const h = p.clocks.filter((c) => c.role === 'home' && SRC_OF_STORE[c.store])[0];
  return h ? SRC_OF_STORE[h.store] + ':' + h.empId : '';
}
function nextSId(list) {
  let n = 0; list.forEach((x) => { if (String(x.id).indexOf('S-') === 0) n = Math.max(n, parseInt(String(x.id).slice(2), 10) || 0); });
  let s = String(n + 1); while (s.length < 3) s = '0' + s; return 'S-' + s;
}

// 這個人的 LINE 雜湊應有的值：undefined＝不知道（來源讀不到／名冊沒有 line_user_id 欄／沒有任何對照），呼叫端不動
function wantedLineHash(p, got) {
  if (!got || !Array.isArray(got.rows) || !Array.isArray(got.sources)) return undefined;
  const idx = {}, has = {};
  got.rows.forEach((r) => {
    if (!r) return;
    if (Object.prototype.hasOwnProperty.call(r, 'lineHash')) has[r.src] = 1;
    const k = r.src + ':' + r.empId; if (!idx[k] || (r.active && !idx[k].active)) idx[k] = r;
  });
  const cl = p.clocks.filter((c) => SRC_OF_STORE[c.store]).sort((a, b) => (b.role === 'home') - (a.role === 'home'));
  if (!cl.length) return undefined;
  const readable = cl.filter((c) => got.sources.indexOf(SRC_OF_STORE[c.store]) >= 0 && has[SRC_OF_STORE[c.store]]);
  for (let i = 0; i < readable.length; i++) {
    const r = idx[SRC_OF_STORE[readable[i].store] + ':' + readable[i].empId];
    if (r && r.active && HASH_RE.test(String(r.lineHash || ''))) return r.lineHash;
  }
  return readable.length === cl.length ? '' : undefined;      // 有來源讀不到：綁定可能在那邊，這輪不清空
}

// 核心：以 dzy 為鍵把名單整理成「管理系統認為的樣子」。不改傳入物件；回傳新名單與變動。notes 只有 S-xxx／DZY 編號，沒有姓名
function dzyApply(staff, dirNorm, got, nowIso) {
  const cur = clone(staff || []), notes = [];
  const ch = { added: [], adopted: [], deactivated: [], reactivated: [], renamed: [], moved: [], srcChanged: [], lineChanged: [], skipped: [] };
  const amb = dirNorm.ambiguousKeys;
  const sOfDzy = (d) => { const m = cur.filter((s) => s.dzy === d); return m.filter((s) => s.active)[0] || m[0] || null; };
  const sorted = dirNorm.people.slice().sort((a, b) => (a.dzy < b.dzy ? -1 : 1));
  sorted.forEach((p) => {
    let S = sOfDzy(p.dzy);
    const m = UNIT_OF_DZY[p.unit], home = homeSrcOf(p);
    if (!S) {                                                   // 沒有 dzy 對應：先用既有 src 認領（唯一才認），再不然才當新人
      const keys = {}; p.clocks.forEach((c) => { if (!amb[c.store + ':' + c.empId]) keys[c.store + ':' + c.empId] = 1; });
      const cands = cur.filter((s) => !s.dzy && s.src && keys[clockKeyOfSrc(s.src)]);
      const act = cands.filter((s) => s.active);
      if (act.length > 1) { notes.push(p.dzy + ' 對到佈告欄 ' + act.length + ' 筆在職同仁（' + act.map((s) => s.id).join('、') + '），不認領也不新增，請處理多的那筆'); ch.skipped.push(p.dzy); return; }
      if (act.length === 1) { S = act[0]; S.dzy = p.dzy; ch.adopted.push(S.id); }
      else if (cands.length) { S = cands[0]; S.dzy = p.dzy; ch.adopted.push(S.id); }      // 佈告欄已刪除的同一人：只掛 dzy，不復活
    }
    if (!S) {
      if (!p.active) return;
      if (!m) { notes.push(p.dzy + ' 的單位代碼不在對照表，不新增，請確認'); ch.skipped.push(p.dzy); return; }
      const unit = m.hq ? 'hq-dzy' : m.unit, store = m.hq ? '' : m.store;
      S = { id: nextSId(cur), name: p.name, unit, pinHash: '', salt: '', pinVer: 0, fail: 0, active: true, createdAt: nowIso, deletedAt: '', src: home, store, lineHash: '', dzy: p.dzy };
      cur.push(S); ch.added.push(S.id);
      if (m.hq) notes.push(S.id + ' 是總部新人，先歸「總部鼎兆元」，要改組請到同仁名單處理');
      return;
    }
    if (!p.active) {                                            // 離職停用（記下是 dzy 停的，復職時才自動恢復；主管手動刪除的不會被復活）
      if (S.active) { S.active = false; S.deletedAt = nowIso; S.offBy = 'dzy'; S.lineHash = ''; ch.deactivated.push(S.id); }
      return;
    }
    if (!S.active) {
      if (S.offBy === 'dzy') { S.active = true; S.deletedAt = ''; delete S.offBy; ch.reactivated.push(S.id); }
      else { notes.push(S.id + ' 在佈告欄被手動刪除，管理系統仍在職：不自動加回（要加回請在同仁名單手動新增）'); return; }
    }
    if (S.name !== p.name) { S.name = p.name; ch.renamed.push(S.id); }
    if (m) {
      const unit = m.hq ? (String(S.unit).indexOf('hq-') === 0 ? S.unit : 'hq-dzy') : m.unit, store = m.hq ? '' : m.store;
      if (unit !== S.unit || store !== String(S.store || '')) { S.unit = unit; S.store = store; ch.moved.push(S.id); }
    } else notes.push(S.id + ' 的單位代碼不在對照表，單位不動');
    if (home && S.src !== home) { S.src = home; ch.srcChanged.push(S.id); }
  });
  // LINE 雜湊（來源：打卡名冊 raw；在職→主店優先的綁定，離職→清空）
  cur.forEach((S) => {
    const p = S.dzy && dirNorm.byDzy[S.dzy];
    if (!p) return;
    const want = S.active ? wantedLineHash(p, got) : '';
    if (want === undefined) return;
    const old = S.lineHash || '';
    if (old !== want) { S.lineHash = want; if (old) S.pinVer = (Number(S.pinVer) || 0) + 1; ch.lineChanged.push(S.id); }   // 解綁／改綁：pinVer+1 踢掉舊登入（同 L.lineHashUpdates）
  });
  const before = {}; (staff || []).forEach((s) => { before[s.id] = JSON.stringify(s); });
  const changed = cur.filter((s) => before[s.id] !== JSON.stringify(s)).map((s) => s.id);
  const orphans = cur.filter((s) => s.active && s.dzy && !dirNorm.byDzy[s.dzy]).map((s) => s.id);
  const unmanaged = cur.filter((s) => s.active && !s.dzy).map((s) => s.id);
  return { staff: cur, changed, ch, notes, orphans, unmanaged };
}

// 大量停用煞車：一輪要停用的人超過 max(3, 在職且已掛 dzy 的 20%) 就不做（管理系統誤把一堆人設離職時不讓佈告欄跟著崩）
function massProblem(staff, ch) {
  const managed = (staff || []).filter((s) => s.active && s.dzy).length, lim = Math.max(3, Math.ceil(managed * 0.2));
  return ch.deactivated.length > lim ? `這一輪要停用 ${ch.deactivated.length} 人（超過上限 ${lim}），先不動；確認管理系統名單正確後用 --allow-mass 再跑` : '';
}

// 新舊雙跑比對：old＝今天佈告欄實際的名單（舊路徑產生），neu＝dzyApply 算出的名單。三項：在職、主店（單位＋門市）、LINE 雜湊
function compareStaff(oldStaff, newStaff) {
  const o = {}, n = {};
  (oldStaff || []).forEach((s) => { o[s.id] = s; }); (newStaff || []).forEach((s) => { n[s.id] = s; });
  const out = { compared: 0, onlyNew: [], onlyOld: [], active: [], home: [], hash: [] };
  Object.keys(Object.assign({}, o, n)).sort().forEach((id) => {
    if (!o[id]) { out.onlyNew.push(id); return; }
    if (!n[id]) { out.onlyOld.push(id); return; }
    out.compared++;
    if (!!o[id].active !== !!n[id].active) out.active.push(id);
    if (o[id].active && n[id].active && (o[id].unit !== n[id].unit || String(o[id].store || '') !== String(n[id].store || ''))) out.home.push(id);
    if ((o[id].lineHash || '') !== (n[id].lineHash || '')) out.hash.push(id);
  });
  out.same = !(out.onlyNew.length || out.onlyOld.length || out.active.length || out.home.length || out.hash.length);
  return out;
}

// 搬家分類：每個 S-xxx 用既有 src（店:emp_id）經管理系統的 clocks 對到 dzy。overrides＝{ 'S-001': 'DZY001' }（人工指定，只補「無對照」的）
function classifyMigration(staff, dirNorm, overrides) {
  const items = [], ov = overrides || {};
  (staff || []).forEach((s) => {
    const it = { id: s.id, active: !!s.active, status: 'none', dzy: '', nameDiff: false, from: 'src' };
    if (s.dzy) { const p = dirNorm.byDzy[s.dzy]; it.status = p ? 'unique' : 'none'; it.dzy = p ? s.dzy : ''; it.from = 'already'; }
    else {
      const k = clockKeyOfSrc(s.src);
      const owners = k ? (dirNorm.ambiguousKeys[k] || dirNorm.owners[k] || []) : [];
      if (owners.length === 1 && !dirNorm.ambiguousKeys[k]) { it.status = 'unique'; it.dzy = owners[0]; }
      else if (owners.length > 1) it.status = 'multi';
      else if (k && dirNorm.ambiguousKeys[k]) it.status = 'multi';
    }
    if (it.status === 'none' && ov[s.id] && dirNorm.byDzy[ov[s.id]]) { it.status = 'unique'; it.dzy = ov[s.id]; it.from = 'map'; }
    if (it.status === 'unique' && dirNorm.byDzy[it.dzy] && String(dirNorm.byDzy[it.dzy].name) !== String(s.name || '').trim()) it.nameDiff = true;
    items.push(it);
  });
  // 兩個 S-xxx 對到同一個 dzy：同一個人在佈告欄有兩筆。兩筆都在職 → 都算多重對照（不准切）；一筆已刪除 → 只掛在職那筆
  const by = {}; items.forEach((it) => { if (it.status === 'unique' && it.dzy) (by[it.dzy] = by[it.dzy] || []).push(it); });
  Object.keys(by).forEach((d) => {
    const g = by[d]; if (g.length < 2) return;
    const act = g.filter((x) => x.active);
    if (act.length > 1) act.forEach((x) => { x.status = 'multi'; });
    g.filter((x) => !x.active).forEach((x) => { x.status = 'none'; x.dzy = ''; x.dupInactive = true; });
  });
  const cnt = (f) => ({ unique: items.filter((i) => f(i) && i.status === 'unique').length, none: items.filter((i) => f(i) && i.status === 'none').length, multi: items.filter((i) => f(i) && i.status === 'multi').length });
  const activeCnt = cnt((i) => i.active), inactiveCnt = cnt((i) => !i.active);
  const ids = (f) => items.filter(f).map((i) => i.id);
  const gate = {
    ok: activeCnt.none === 0 && activeCnt.multi === 0,
    noneActive: ids((i) => i.active && i.status === 'none'), multiActive: ids((i) => i.active && i.status === 'multi'),
    nameDiffActive: ids((i) => i.active && i.status === 'unique' && i.nameDiff)
  };
  return { items, active: activeCnt, inactive: inactiveCnt, gate, total: items.length };
}

// ================= 管理系統名單（唯讀 svcDirectory） =================
function dirConfig(env) { return { url: String(env.DZY_PLATFORM_URL || '').trim(), key: String(env.BULLETIN_SVC_KEY || '') }; }
function isLoopback(url) { try { const h = new URL(url).hostname; return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1'; } catch (e) { return false; } }
// 回傳 normalizeDirectory 的結果。金鑰只放在 POST 本文，錯誤訊息一律不帶金鑰與回應本文。非本機網址一律拒絕（金鑰不出本機）
async function fetchDirectory(cfg, opts) {
  const o = opts || {};
  if (!cfg || !cfg.url || !cfg.key) throw bad('未設定管理系統網址或服務金鑰（DZY_PLATFORM_URL／BULLETIN_SVC_KEY）', 'DIR_CFG');
  if (!isLoopback(cfg.url)) throw bad('管理系統網址必須是本機（127.0.0.1），金鑰不送出本機', 'DIR_CFG');
  let res, j;
  try {
    res = await (o.fetchImpl || fetch)(cfg.url, { method: 'POST', headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ action: 'svcDirectory', payload: { svc_key: cfg.key } }), redirect: 'error', signal: AbortSignal.timeout(o.timeoutMs || 20000) });
    if (res.status !== 200) throw new Error('HTTP ' + res.status);
    j = await res.json();
  } catch (e) { throw bad('讀管理系統名單失敗：' + (e && e.name === 'TimeoutError' ? '逾時' : String(e && e.message || e).replace(cfg.key, '***')), 'DIR_NET'); }
  if (!j || j.ok !== true) throw bad('管理系統拒絕或出錯' + (j && j.code ? '（' + String(j.code).slice(0, 30) + '）' : ''), 'DIR_REJECT');
  return normalizeDirectory(j.data);
}

// ================= DB 與紀錄（背景工作的做法：自己開一般連線，不經 makeSqliteStore） =================
const readStaff = (db) => J.rows(db, 'SELECT json FROM staff ORDER BY rowid').map((r) => { const s = JSON.parse(r.json); if (typeof s.lineHash !== 'string') s.lineHash = ''; return s; });
const kvGet = (db, k) => { const r = db.prepare('SELECT v FROM kv WHERE k = ?').get(k); return r ? r.v : null; };
const kvSet = (db, k, v) => db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, String(v));
function saveChanged(db, newStaff, ids) {
  const up = db.prepare('INSERT INTO staff (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json');
  ids.forEach((id) => { const s = newStaff.find((x) => x.id === id); if (s) up.run(s.id, JSON.stringify(s)); });
}
// 目前實際採用的來源：環境變數說 dzy、而且搬家腳本通過過（kv 有旗標）才算 dzy；否則 clock（安全預設）
function effectiveSource(env, dbOrKv) {
  const want = String(env.STAFF_SOURCE || 'clock').trim().toLowerCase();
  if (want !== 'dzy') return 'clock';
  let flag = null; try { flag = typeof dbOrKv === 'function' ? dbOrKv(MIGRATED_KEY) : kvGet(dbOrKv, MIGRATED_KEY); } catch (e) {}
  return flag ? 'dzy' : 'clock';
}
function sourceWarning(env, dbOrKv) {
  return String(env.STAFF_SOURCE || '').trim().toLowerCase() === 'dzy' && effectiveSource(env, dbOrKv) !== 'dzy'
    ? 'STAFF_SOURCE=dzy 但搬家腳本還沒通過（node server/staff-dzy.js migrate --apply），先照打卡同步（clock）運作' : '';
}
const brief = (ch) => ({ added: ch.added.length, adopted: ch.adopted.length, deactivated: ch.deactivated.length, reactivated: ch.reactivated.length, renamed: ch.renamed.length, moved: ch.moved.length, srcChanged: ch.srcChanged.length, lineChanged: ch.lineChanged.length, skipped: ch.skipped.length });

// ================= G1：dzy 同步（mirror.js 第 4 步在 STAFF_SOURCE=dzy 時呼叫；也可手動） =================
// o: { dir, bridge, fetchDir()→normalized, now(ISO), busyMs, allowMass, dryRun }。讀不到管理系統＝整輪不動（不會誤停用）；讀不到打卡名冊＝只不動 LINE 雜湊
async function runDzySync(o) {
  let dirN;
  try { dirN = await o.fetchDir(); } catch (e) { return { ok: false, error: J.errText(e) }; }
  if (!dirN.people.length) return { ok: false, error: '管理系統回傳的名單是空的，整輪不動' };
  let got = null, lineErr = '';
  try { got = await o.bridge.call('clock', { raw: true }, 90); if (!got || !Array.isArray(got.rows) || !Array.isArray(got.sources)) { got = null; lineErr = '打卡名單格式不符'; } }
  catch (e) { lineErr = '讀打卡名單失敗：' + J.errText(e); }
  const db = J.openDb(o.dir, { busyMs: o.busyMs });
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      if (!kvGet(db, MIGRATED_KEY) && !o.force) { db.exec('ROLLBACK'); return { ok: false, error: '搬家腳本還沒通過（kv ' + MIGRATED_KEY + ' 沒有），不同步' }; }
      const staff = readStaff(db), nowIso = (o.now ? o.now() : new Date()).toISOString();
      const r = dzyApply(staff, dirN, got, nowIso), mp = o.allowMass ? '' : massProblem(staff, r.ch);
      if (mp) { db.exec('ROLLBACK'); return { ok: false, error: mp, planned: brief(r.ch) }; }
      if (o.dryRun) { db.exec('ROLLBACK'); return { ok: true, dryRun: true, changes: brief(r.ch), notes: r.notes, orphans: r.orphans.length, unmanaged: r.unmanaged.length }; }
      saveChanged(db, r.staff, r.changed);
      db.exec('COMMIT');
      const c = brief(r.ch);
      return { ok: true, updated: r.changed.length, linked: r.staff.filter((s) => s.active && s.lineHash).length, sourceErrors: Array.isArray(got && got.errors) ? got.errors.length : 0,
        changes: c, notes: r.notes, orphans: r.orphans.length, unmanaged: r.unmanaged.length, lineSkipped: lineErr || undefined };
    } catch (e) { try { db.exec('ROLLBACK'); } catch (y) {} throw e; }
  } finally { try { db.close(); } catch (e) {} }
}

// ================= G2：搬家 =================
function snapshotName(now) { return 'staff-snapshot-' + J.taipeiStamp(now || new Date()) + '.json'; }
// o: { dir, fetchDir, apply, overrides, allowNameDiff, now(Date), busyMs }
async function runMigrate(o) {
  const dirN = await o.fetchDir();
  const db = J.openDb(o.dir, { busyMs: o.busyMs });
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      const staff = readStaff(db), rep = classifyMigration(staff, dirN, o.overrides);
      const blocked = !rep.gate.ok || (rep.gate.nameDiffActive.length > 0 && !o.allowNameDiff);
      const res = { ok: !blocked, applied: false, total: rep.total, active: rep.active, inactive: rep.inactive,
        noneActive: rep.gate.noneActive, multiActive: rep.gate.multiActive, nameDiffActive: rep.gate.nameDiffActive };
      if (!o.apply || blocked) {
        db.exec('ROLLBACK');
        if (o.apply && blocked) res.error = '在職同仁有「無對照」或「多重對照」' + (rep.gate.nameDiffActive.length && rep.gate.ok ? '（或姓名與管理系統不同，需人工確認後加 --allow-name-diff）' : '') + '，拒絕切換；沒有寫入任何資料';
        return res;
      }
      // 先存快照（回退用）：整張 staff 表原樣，存在資料夾 backups/，再寫 dzy
      const snapDir = path.join(o.dir, 'backups'); fs.mkdirSync(snapDir, { recursive: true });
      const snapFile = path.join(snapDir, snapshotName(o.now)); fs.writeFileSync(snapFile, JSON.stringify(staff), { mode: 0o600 });
      const up = db.prepare('UPDATE staff SET json = ? WHERE id = ?'); let filled = 0;
      rep.items.forEach((it) => {
        if (it.status !== 'unique' || !it.dzy) return;
        const s = staff.find((x) => x.id === it.id); if (s.dzy === it.dzy) return;
        s.dzy = it.dzy; up.run(JSON.stringify(s), s.id); filled++;
      });
      kvSet(db, MIGRATED_KEY, (o.now || new Date()).toISOString());
      db.exec('COMMIT');
      Object.assign(res, { applied: true, filled, snapshot: path.basename(snapFile) });
      return res;
    } catch (e) { try { db.exec('ROLLBACK'); } catch (y) {} throw e; }
  } finally { try { db.close(); } catch (e) {} }
}
function loadOverrides(file) {
  const m = JSON.parse(fs.readFileSync(file, 'utf8')), out = {};
  Object.keys(m || {}).forEach((k) => { if (/^S-\d+$/.test(k) && typeof m[k] === 'string') out[k] = m[k]; });
  return out;
}

// ================= G2：雙跑比對（STAFF_SOURCE=clock 期間每天跑一次） =================
// 新路徑「如果現在就切」會算出的名單 vs 今天佈告欄實際的名單；只讀、不寫 staff。結果寫 logs/staff-dual-<日期>.json 與 staff-dual-last.json
async function runDual(o) {
  const dirN = await o.fetchDir();
  let got = null, lineErr = '';
  try { got = await o.bridge.call('clock', { raw: true }, 90); if (!got || !Array.isArray(got.rows) || !Array.isArray(got.sources)) { got = null; lineErr = '打卡名單格式不符'; } }
  catch (e) { lineErr = '讀打卡名單失敗：' + J.errText(e); }
  const db = J.openDb(o.dir, { readOnly: true });
  let staff; try { staff = readStaff(db); } finally { try { db.close(); } catch (e) {} }
  const now = o.now ? o.now() : new Date(), date = L.today(now);
  const plan = dzyApply(staff, dirN, got, now.toISOString()), cmp = compareStaff(staff, plan.staff);
  // 雜湊沒比到（打卡名冊讀不到）＝不能算「全同」
  const res = { at: now.toISOString(), date, ok: !lineErr, same: cmp.same && !lineErr, lineSkipped: lineErr || undefined, compared: cmp.compared,
    counts: { onlyNew: cmp.onlyNew.length, onlyOld: cmp.onlyOld.length, active: cmp.active.length, home: cmp.home.length, hash: cmp.hash.length },
    ids: { onlyNew: cmp.onlyNew, onlyOld: cmp.onlyOld, active: cmp.active, home: cmp.home, hash: cmp.hash }, notes: plan.notes, unmanaged: plan.unmanaged.length };
  if (!o.noWrite) {
    J.writeLast(o.dir, 'staff-dual-' + date + '.json', res); J.writeLast(o.dir, 'staff-dual-last.json', res);
    J.logLine(o.dir, 'staff-dual.log', `${date} 雙跑比對：${res.same ? '全同' : '有差異'}｜比對 ${res.compared} 筆｜新路徑多 ${res.counts.onlyNew}、舊路徑多 ${res.counts.onlyOld}、在職不同 ${res.counts.active}、主店不同 ${res.counts.home}、LINE 不同 ${res.counts.hash}` + (lineErr ? '｜' + lineErr : ''));
  }
  return res;
}
// 連續全同的天數（從最新一天往回數；中間缺一天或有差異就中斷）。「可拆舊」＝連續 7 天且最新一天是今天或昨天
function dualStatus(dir, now) {
  const d = path.join(dir, 'logs'); let files = [];
  try { files = fs.readdirSync(d).filter((f) => /^staff-dual-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort(); } catch (e) {}
  const days = files.map((f) => { try { return JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); } catch (e) { return null; } }).filter(Boolean);
  let streak = 0, expect = null;
  for (let i = days.length - 1; i >= 0; i--) {
    const x = days[i];
    if (!x.same) break;
    if (expect && x.date !== expect) break;
    streak++; expect = L.addDays(x.date, -1);
  }
  const today = L.today(now || new Date()), last = days.length ? days[days.length - 1].date : '';
  const fresh = last === today || last === L.addDays(today, -1);
  return { days: days.length, streak, last, lastSame: days.length ? !!days[days.length - 1].same : null, canRetire: streak >= DUAL_NEED_DAYS && fresh, need: DUAL_NEED_DAYS };
}

// ================= CLI =================
async function main() {
  J.loadEnv(path.join(__dirname, '.env'));
  const { makeBridge } = require('./bridge.js');
  const dir = J.dataDir(process.env), cmd = process.argv[2], has = (f) => process.argv.includes(f);
  const arg = (f) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : ''; };
  const fetchDir = () => fetchDirectory(dirConfig(process.env));
  const bridge = makeBridge(process.env.BRIDGE_URL, process.env.BRIDGE_KEY);
  const idList = (a) => (a.length ? a.join('、') : '無');
  if (cmd === 'migrate') {
    const r = await runMigrate({ dir, fetchDir, apply: has('--apply'), overrides: arg('--map') ? loadOverrides(arg('--map')) : {}, allowNameDiff: has('--allow-name-diff') });
    console.log(`搬家${r.applied ? '完成' : (r.ok ? '檢查通過（尚未寫入，加 --apply 才寫）' : '不通過')}｜S-xxx 共 ${r.total} 筆`);
    console.log(`在職：唯一對上 ${r.active.unique}、無對照 ${r.active.none}、多重對照 ${r.active.multi}｜已刪除：唯一對上 ${r.inactive.unique}、無對照 ${r.inactive.none}、多重對照 ${r.inactive.multi}`);
    console.log('在職無對照：' + idList(r.noneActive)); console.log('在職多重對照：' + idList(r.multiActive)); console.log('在職但姓名與管理系統不同：' + idList(r.nameDiffActive));
    if (r.applied) console.log(`已寫入 dzy ${r.filled} 筆；快照 ${r.snapshot}（在 ${path.join(dir, 'backups')}）`);
    if (r.error) console.log('✗ ' + r.error);
    process.exit(r.ok ? 0 : 1);
  } else if (cmd === 'dual') {
    const r = await runDual({ dir, bridge, fetchDir });
    console.log(`${r.date} 雙跑比對：${r.same ? '全同' : '有差異'}｜比對 ${r.compared} 筆｜新路徑多 ${r.counts.onlyNew}、舊路徑多 ${r.counts.onlyOld}、在職不同 ${r.counts.active}、主店不同 ${r.counts.home}、LINE 不同 ${r.counts.hash}`);
    ['onlyNew', 'onlyOld', 'active', 'home', 'hash'].forEach((k) => { if (r.ids[k].length) console.log(`  ${k}：` + r.ids[k].join('、')); });
    if (r.lineSkipped) console.log('⚠ ' + r.lineSkipped + '（這天不算全同）');
    process.exit(r.same ? 0 : 1);
  } else if (cmd === 'dual-status') {
    const s = dualStatus(dir);
    console.log(`雙跑紀錄 ${s.days} 天｜連續全同 ${s.streak} 天（需要 ${s.need} 天）｜最近一次 ${s.last || '無'}${s.lastSame === false ? '（有差異）' : ''}｜${s.canRetire ? '可拆舊' : '還不能拆舊'}`);
    process.exit(s.canRetire ? 0 : 1);
  } else if (cmd === 'sync') {
    const r = await runDzySync({ dir, bridge, fetchDir, allowMass: has('--allow-mass'), dryRun: has('--dry-run') });
    console.log(r.ok ? `同步${r.dryRun ? '（試跑，沒寫入）' : '完成'}：` + JSON.stringify(r.changes) + `｜管理系統沒有的在職 ${r.orphans} 人、未掛 dzy 的在職 ${r.unmanaged} 人` : '✗ ' + r.error);
    (r.notes || []).forEach((n) => console.log('  ' + n));
    process.exit(r.ok ? 0 : 1);
  } else { console.log('用法：node server/staff-dzy.js migrate [--apply] [--map 檔.json] [--allow-name-diff] | dual | dual-status | sync [--dry-run] [--allow-mass]'); process.exit(2); }
}
if (require.main === module) main().catch((e) => { console.error('✗ ' + (e && e.message || e)); process.exit(1); });

module.exports = { STORE_OF_SRC, SRC_OF_STORE, UNIT_OF_DZY, MIGRATED_KEY, DUAL_NEED_DAYS, normalizeDirectory, dzyApply, compareStaff, classifyMigration, massProblem, wantedLineHash,
  clockKeyOfSrc, homeSrcOf, dirConfig, fetchDirectory, effectiveSource, sourceWarning, runDzySync, runMigrate, runDual, dualStatus, loadOverrides };
