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
  'mzt-lzl': { unit: 'mzt', store: '六張犁' }, 'ck': { unit: 'cf', store: '' },
  // 總部（org 單位代碼見 dzy apps-script/platform/Staff.gs 預設資料）：墨竹亭總部／小辛辣總部對得到佈告欄的總部組別；鼎兆元總部（dzy-hq）底下分部門，
  // 管理系統不分三組 → 既有的維持原組別、新人先歸 hq-dzy。其餘單位（mzt-wx／mzt-rg／mzt-mc／yiwu-*）佈告欄沒有對應單位，不新增、單位不動
  'mzt-hq': { hq: true, hqUnit: 'hq-mzt' }, 'mala-hq': { hq: true, hqUnit: 'hq-mala' }, 'dzy-hq': { hq: true }
};
// 總監級以上（2026-10-25 v0.8.0，docs/brand-visibility.md）：管理系統職稱代碼在這裡的人，佈告欄三個品牌分頁都看得到（seeAll）。
// 正本＝dzy apps-script/platform/Staff.gs 的 org 職稱：hm 總監、odir 品牌辦公室總監、rdd 廚藝總監、ceo 執行長、gm 總經理、chair 董事長
const SEE_ALL_TITLES = ['hm', 'odir', 'rdd', 'ceo', 'gm', 'chair'];
const MIGRATED_KEY = 'staff_dzy_migrated';          // 已搬家（dzy 欄填好、有快照）
const SNAP_KEY = 'staff_dzy_snapshot';               // 搬家前快照的檔名（rollback 用；已搬家後再跑 --apply 不會覆蓋它）
const SWITCH_KEY = 'staff_dzy_switchable';          // 可切換（雙跑連續 7 天全同才由 dual 寫入，G8）
const DUAL_NEED_DAYS = 7;
const HASH_RE = /^[0-9a-f]{64}$/;
const clone = (o) => JSON.parse(JSON.stringify(o));
const srcKey = (s) => String(s || '');

// ================= 純函式 =================

// 管理系統回來的名單整理成內部格式。壞列丟掉並記數；同一 emp_no 出現兩次、同一個 store_code+emp_id 掛在兩個人身上 → 那把 key 不拿來對（ambiguousKeys）
function normalizeDirectory(data, meta) {
  // 平台 svcDirectory 實際回應：{ ok:true, data:[…全部 staff 含停用…], total:<數字>, generated_at:'yyyy-MM-dd HH:mm:ss' }（total／generated_at 在最外層，meta 帶進來）。
  // total 必須存在且是數字、與 data 筆數相符，否則整輪失敗（G6）
  const list = data;
  if (!Array.isArray(list)) throw bad('管理系統回傳的名單格式不符');
  const total = meta && meta.total, generatedAt = String(meta && meta.generated_at || '');
  if (typeof total !== 'number' || !Number.isFinite(total)) throw bad('管理系統回應缺少 total（或不是數字），整輪中止', 'DIR_NO_TOTAL');
  if (total !== list.length) throw bad(`管理系統名單筆數（${list.length}）與 total（${total}）不符，整輪中止`, 'DIR_TOTAL');
  const people = [], seen = {}, dupNo = [], owners = {}, badRows = [];
  list.forEach((r, i) => {
    const dzy = String(r && r.emp_no || '').trim(), name = String(r && r.name || '').trim();
    if (!dzy || !name) { badRows.push(i); return; }
    if (seen[dzy]) { if (dupNo.indexOf(dzy) < 0) dupNo.push(dzy); return; }
    seen[dzy] = 1;
    const clocks = (Array.isArray(r.clocks) ? r.clocks : []).map((c) => ({ store: String(c && c.store_code || '').trim().toLowerCase(), empId: String(c && c.emp_id || '').trim(), role: String(c && c.role || '').trim() }))
      .filter((c) => c.store && c.empId);
    // title：管理系統舊版沒有這一欄 → null（dzyApply 不動 seeAll）
    const title = Object.prototype.hasOwnProperty.call(r, 'title') ? String(r.title == null ? '' : r.title).trim().toLowerCase() : null;
    people.push({ dzy, name, unit: String(r.unit || '').trim(), title, active: r.active === true, clocks });
  });
  if (dupNo.length) throw bad(`管理系統名單有重複的 emp_no（${dupNo.length} 個：${dupNo.slice(0, 10).join('、')}），整輪中止`, 'DIR_DUP');   // G2：不取第一筆
  people.forEach((p) => p.clocks.forEach((c) => { const k = c.store + ':' + c.empId; (owners[k] = owners[k] || []).indexOf(p.dzy) < 0 && owners[k].push(p.dzy); }));
  const ambiguousKeys = {};
  Object.keys(owners).forEach((k) => { if (owners[k].length > 1) ambiguousKeys[k] = owners[k]; });
  return { people, byDzy: Object.fromEntries(people.map((p) => [p.dzy, p])), owners, ambiguousKeys, badRows, dupNo, total, generatedAt };
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

// 這個人的 LINE 雜湊應有的值，依「來源」逐家判斷（G7）：
//   來源讀不到（沒在 got.sources、或名冊沒有 line_user_id 欄）＝不知道，不影響其他來源的結論；
//   來源讀得到＝該店那列在職且有綁→該雜湊，否則（沒那列、已離職、沒綁）＝已解除綁定。
//   有綁定→取之；不同來源出現不同雜湊→conflict（鎖住自動登入：值給 ''，呼叫端告警）；
//   全部讀得到的來源都已解除→''（不因其他來源讀不到而保留）；全部讀不到／沒有對照→undefined（不動）。
function wantedLineHash(p, got) {
  const r0 = { v: undefined, conflict: false };
  if (!got || !Array.isArray(got.rows) || !Array.isArray(got.sources)) return r0;
  const idx = {}, has = {};
  got.rows.forEach((r) => {
    if (!r) return;
    if (Object.prototype.hasOwnProperty.call(r, 'lineHash')) has[r.src] = 1;
    const k = r.src + ':' + r.empId; if (!idx[k] || (r.active && !idx[k].active)) idx[k] = r;
  });
  const cl = p.clocks.filter((c) => SRC_OF_STORE[c.store]);
  const readable = cl.filter((c) => got.sources.indexOf(SRC_OF_STORE[c.store]) >= 0 && has[SRC_OF_STORE[c.store]]);
  if (!readable.length) return r0;
  const hs = [];
  readable.forEach((c) => {
    const r = idx[SRC_OF_STORE[c.store] + ':' + c.empId];
    if (r && r.active && HASH_RE.test(String(r.lineHash || '')) && hs.indexOf(r.lineHash) < 0) hs.push(r.lineHash);
  });
  if (hs.length > 1) return { v: '', conflict: true };
  return { v: hs.length ? hs[0] : '', conflict: false };
}

// 核心：以 dzy 為鍵把名單整理成「管理系統認為的樣子」。不改傳入物件；回傳新名單與變動。notes 只有 S-xxx／DZY 編號，沒有姓名
// 回傳另有：manual（姓名不一致、不自動認領，要人工確認：G3）、orphans（已連結 dzy 的在職帳號，其 dzy 不在管理系統名單：G6）、
// ambiguous（一個打卡鍵對到兩個以上 DZY：G1）、dupHash（同一個非空 lineHash 會寫給兩個以上在職帳號：G1）、lineConflicts（G7）
function dzyApply(staff, dirNorm, got, nowIso) {
  const cur = clone(staff || []), notes = [];
  const ch = { added: [], adopted: [], deactivated: [], reactivated: [], renamed: [], moved: [], srcChanged: [], lineChanged: [], access: [], skipped: [] };
  const manual = [], lineConflicts = [];
  const amb = dirNorm.ambiguousKeys;
  const sOfDzy = (d) => { const m = cur.filter((s) => s.dzy === d); return m.filter((s) => s.active)[0] || m[0] || null; };
  const sorted = dirNorm.people.slice().sort((a, b) => (a.dzy < b.dzy ? -1 : 1));
  sorted.forEach((p) => {
    let S = sOfDzy(p.dzy);
    const m = UNIT_OF_DZY[p.unit], home = homeSrcOf(p);
    if (!S) {                                                   // 沒有 dzy 對應：先用既有 src 認領（唯一且姓名一致才認），再不然才當新人
      const keys = {}; p.clocks.forEach((c) => { if (!amb[c.store + ':' + c.empId]) keys[c.store + ':' + c.empId] = 1; });
      const cands = cur.filter((s) => !s.dzy && s.src && keys[clockKeyOfSrc(s.src)]);
      const act = cands.filter((s) => s.active);
      if (act.length > 1) { notes.push(p.dzy + ' 對到佈告欄 ' + act.length + ' 筆在職同仁（' + act.map((s) => s.id).join('、') + '），不認領也不新增，請處理多的那筆'); ch.skipped.push(p.dzy); return; }
      const hit = act.length === 1 ? act[0] : cands[0];
      if (hit) {
        if (String(hit.name || '').trim() !== p.name) {          // G3：同一個打卡編號、名字卻不同＝可能是舊帳號被轉給新人，不自動認領（會繼承舊密碼與簽名紀錄）
          manual.push({ id: hit.id, dzy: p.dzy }); ch.skipped.push(p.dzy);
          notes.push(hit.id + ' 與 ' + p.dzy + ' 打卡編號相同但姓名不一致，不自動認領；確認是同一人後用 claim 指令（會清掉舊密碼與 LINE 綁定）'); return;
        }
        S = hit; S.dzy = p.dzy; ch.adopted.push(S.id);           // 已刪除的同一人：只掛 dzy，不復活
      }
    }
    if (!S) {
      if (!p.active) return;
      if (!m) { notes.push(p.dzy + ' 的單位代碼不在對照表，不新增，請確認'); ch.skipped.push(p.dzy); return; }
      const unit = m.hq ? (m.hqUnit || 'hq-dzy') : m.unit, store = m.hq ? '' : m.store;
      S = { id: nextSId(cur), name: p.name, unit, pinHash: '', salt: '', pinVer: 0, fail: 0, active: true, createdAt: nowIso, deletedAt: '', src: home, store, lineHash: '', dzy: p.dzy };
      cur.push(S); ch.added.push(S.id);
      if (m.hq && !m.hqUnit) notes.push(S.id + ' 是鼎兆元總部新人，先歸「總部鼎兆元」，要改組請到同仁名單處理');
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
      const unit = m.hq ? (m.hqUnit || (String(S.unit).indexOf('hq-') === 0 ? S.unit : 'hq-dzy')) : m.unit, store = m.hq ? '' : m.store;
      if (unit !== S.unit || store !== String(S.store || '')) { S.unit = unit; S.store = store; ch.moved.push(S.id); }
    } else notes.push(S.id + ' 的單位代碼不在對照表，單位不動');
    if (home && S.src !== home) { S.src = home; ch.srcChanged.push(S.id); }
  });
  // 總監級以上看全部品牌（seeAll）：只在管理系統有回 title 時才動；離職一律清掉。只存 true，不是就刪掉這個欄位
  cur.forEach((S) => {
    const p = S.dzy && dirNorm.byDzy[S.dzy];
    if (!p || (p.title === null && p.active)) return;   // 沒有 title（管理系統舊版）：只在管理系統確認離職時清（#45-13）
    const want = S.active && SEE_ALL_TITLES.indexOf(p.title) >= 0;
    if (want === (S.seeAll === true)) return;
    if (want) S.seeAll = true; else delete S.seeAll;
    ch.access.push(S.id);
  });
  // LINE 雜湊（來源：打卡名冊 raw；在職→依來源撤銷規則，離職→清空）
  cur.forEach((S) => {
    const p = S.dzy && dirNorm.byDzy[S.dzy];
    if (!p) return;
    let want;
    if (!S.active) want = '';
    else { const w = wantedLineHash(p, got); want = w.v; if (w.conflict) lineConflicts.push(S.id); }
    if (want === undefined) return;
    const old = S.lineHash || '';
    if (old !== want) { S.lineHash = want; if (old) S.pinVer = (Number(S.pinVer) || 0) + 1; ch.lineChanged.push(S.id); }   // 解綁／改綁／鎖定：pinVer+1 踢掉舊登入
  });
  const before = {}; (staff || []).forEach((s) => { before[s.id] = JSON.stringify(s); });
  const changed = cur.filter((s) => before[s.id] !== JSON.stringify(s)).map((s) => s.id);
  const orphans = cur.filter((s) => s.active && s.dzy && !dirNorm.byDzy[s.dzy]).map((s) => s.id);
  const unmanaged = cur.filter((s) => s.active && !s.dzy).map((s) => s.id);
  const hashOwners = {}; cur.forEach((s) => { if (s.active && s.lineHash) (hashOwners[s.lineHash] = hashOwners[s.lineHash] || []).push(s.id); });
  const dupHash = []; Object.keys(hashOwners).forEach((h) => { if (hashOwners[h].length > 1) hashOwners[h].forEach((id) => dupHash.push(id)); });
  const ambiguous = Object.keys(amb).map((k) => amb[k].join('/'));
  return { staff: cur, changed, ch, notes, orphans, unmanaged, manual, dupHash, ambiguous, lineConflicts };
}

// 一輪「整輪拒寫」的條件（G1／G6）：打卡鍵歧義、同一個 lineHash 寫給兩個在職帳號、已連結 dzy 的在職帳號不在管理系統名單。回傳中文原因或 ''
function roundProblem(r) {
  const out = [];
  if (r.ambiguous.length) out.push(`${r.ambiguous.length} 個打卡編號對到兩個以上管理系統帳號（${r.ambiguous.slice(0, 5).join('、')}）`);
  if (r.dupHash.length) out.push(`同一個 LINE 綁定會寫給 ${r.dupHash.length} 個在職帳號（${r.dupHash.slice(0, 6).join('、')}）`);
  if (r.orphans.length) out.push(`${r.orphans.length} 個已連結管理系統的在職帳號不在名單裡（${r.orphans.slice(0, 6).join('、')}）`);
  return out.length ? '整輪不寫入：' + out.join('；') : '';
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
    if (o[id].active && n[id].active && (o[id].lineHash || '') !== (n[id].lineHash || '')) out.hash.push(id);   // #30：已刪除的人不比雜湊
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
  return normalizeDirectory(j.data, { total: j.total, generated_at: j.generated_at });
}

// 管理系統「公告專區」入場券兌換（2026-10-16，平台 svcSsoRedeem）：aud＝'bulletin'（預設）回 {emp_no:'DZY###'}；
// aud＝'bulletin-admin'（2026-10-17 公告管理）回 {admin:true, emp_no, uid, name}；券無效／過期／用過＝null；
// 連不上、金鑰錯、設定缺 → 丟 business 錯誤 DZY_DOWN（前端退回選名字）。金鑰只放 POST 本文、只送本機
async function redeemTicket(cfg, ticket, aud, opts) {
  const o = opts || {}, want = aud === 'bulletin-admin' ? 'bulletin-admin' : 'bulletin';
  const down = (why) => { const e = new Error('管理系統暫時連不上，請選你的名字登入'); e.code = 'DZY_DOWN'; e.business = true; e.detail = why; return e; };
  if (!cfg || !cfg.url || !cfg.key || !isLoopback(cfg.url)) throw down('未設定或非本機網址');
  let j;
  try {
    const res = await (o.fetchImpl || fetch)(cfg.url, { method: 'POST', headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ action: 'svcSsoRedeem', payload: { svc_key: cfg.key, ticket: String(ticket), aud: want } }), redirect: 'error', signal: AbortSignal.timeout(o.timeoutMs || 8000) });
    if (res.status !== 200) throw new Error('HTTP ' + res.status);
    j = await res.json();
  } catch (e) { throw down(e && e.name === 'TimeoutError' ? '逾時' : String(e && e.message || e).replace(cfg.key, '***')); }
  const d = j && j.ok === true ? j.data : null;
  if (d && want === 'bulletin' && /^DZY[0-9]{3}$/.test(String(d.emp_no || ''))) return { emp_no: String(d.emp_no) };
  if (d && want === 'bulletin-admin' && d.admin === true) return { admin: true, emp_no: String(d.emp_no || '').slice(0, 20), uid: String(d.uid || '').slice(0, 40), name: String(d.name || '').slice(0, 40) };
  if (j && j.ok === false && j.code === 'ticket_invalid') return null;
  throw down('管理系統拒絕' + (j && j.code ? '（' + String(j.code).slice(0, 30) + '）' : ''));
}

// ================= DB 與紀錄（背景工作的做法：自己開一般連線，不經 makeSqliteStore） =================
const readStaff = (db) => J.rows(db, 'SELECT json FROM staff ORDER BY rowid').map((r) => { const s = JSON.parse(r.json); if (typeof s.lineHash !== 'string') s.lineHash = ''; return s; });
const kvGet = (db, k) => { const r = db.prepare('SELECT v FROM kv WHERE k = ?').get(k); return r ? r.v : null; };
const kvSet = (db, k, v) => db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, String(v));
function saveChanged(db, newStaff, ids) {
  const up = db.prepare('INSERT INTO staff (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json');
  ids.forEach((id) => { const s = newStaff.find((x) => x.id === id); if (s) up.run(s.id, JSON.stringify(s)); });
}
// 目前實際採用的來源：環境變數說 dzy、而且「已搬家」「可切換」兩個旗標都在（G8：搬家腳本通過＋雙跑連續 7 天全同）才算 dzy；否則 clock（安全預設）
function effectiveSource(env, dbOrKv) {
  const want = String(env.STAFF_SOURCE || 'clock').trim().toLowerCase();
  if (want !== 'dzy') return 'clock';
  const get = (k) => { try { return typeof dbOrKv === 'function' ? dbOrKv(k) : kvGet(dbOrKv, k); } catch (e) { return null; } };
  return get(MIGRATED_KEY) && get(SWITCH_KEY) ? 'dzy' : 'clock';
}
function sourceWarning(env, dbOrKv) {
  return String(env.STAFF_SOURCE || '').trim().toLowerCase() === 'dzy' && effectiveSource(env, dbOrKv) !== 'dzy'
    ? 'STAFF_SOURCE=dzy 但還不能切換（要先 migrate --apply，再雙跑連續 7 天全同由 dual 寫入「可切換」旗標），先照打卡同步（clock）運作' : '';
}
const brief = (ch) => ({ added: ch.added.length, adopted: ch.adopted.length, deactivated: ch.deactivated.length, reactivated: ch.reactivated.length, renamed: ch.renamed.length, moved: ch.moved.length, srcChanged: ch.srcChanged.length, lineChanged: ch.lineChanged.length, skipped: ch.skipped.length });

// ================= G1：dzy 同步（mirror.js 第 4 步在 STAFF_SOURCE=dzy 時呼叫；也可手動） =================
const LASTFILE = 'staff-dzy-last.json';
// 橋接回的打卡名單必須是 raw 模式（GAS v0.7.5）；舊版 GAS 會忽略 raw 回判定表整理過的列（#32）
async function readRawClock(bridge) {
  try {
    const got = await bridge.call('clock', { raw: true }, 90);
    if (!got || !Array.isArray(got.rows) || !Array.isArray(got.sources)) return { got: null, err: '打卡名單格式不符' };
    if (got.raw !== true) return { got: null, err: '橋接回應不是 raw 模式（Apps Script 還沒部署 v0.7.5），不使用' };
    return { got, err: '' };
  } catch (e) { return { got: null, err: '讀打卡名單失敗：' + J.errText(e) }; }
}
function recordLast(dir, res) {                              // G11：記最後成功時間；失敗保留上次成功的時間與這次的原因
  const prev = J.readLast(dir, LASTFILE) || {}, at = new Date().toISOString();
  J.writeLast(dir, LASTFILE, { lastOkAt: res.ok ? at : (prev.lastOkAt || ''), lastTryAt: at, ok: !!res.ok, error: res.ok ? '' : String(res.error || '') });
  res.lastOkAt = res.ok ? at : (prev.lastOkAt || '');
  return res;
}
// o: { dir, bridge, fetchDir()→normalized, now(→Date), busyMs, allowMass, dryRun, force }。
// 管理系統讀不到／空名單／歧義／lineHash 重複／已連結者缺列＝整輪不動且 ok:false（mirror 會跟著 ok=false、退出碼非 0）；讀不到打卡名冊＝只不動 LINE 雜湊
async function runDzySync(o) {
  const fin = (r) => (o.dryRun ? r : recordLast(o.dir, r));
  let dirN;
  try { dirN = await o.fetchDir(); } catch (e) { return fin({ ok: false, error: J.errText(e) }); }
  if (!dirN.people.length) return fin({ ok: false, error: '管理系統回傳的名單是空的，整輪不動' });
  const { got, err: lineErr } = await readRawClock(o.bridge);
  const db = J.openDb(o.dir, { busyMs: o.busyMs });
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      if (!o.force && !(kvGet(db, MIGRATED_KEY) && kvGet(db, SWITCH_KEY))) { db.exec('ROLLBACK'); return fin({ ok: false, error: '還不能切換（沒有「已搬家」＋「可切換」旗標），不同步' }); }
      const staff = readStaff(db), nowIso = (o.now ? o.now() : new Date()).toISOString();
      const r = dzyApply(staff, dirN, got, nowIso), rp = roundProblem(r), mp = o.allowMass ? '' : massProblem(staff, r.ch);
      if (rp || mp) { db.exec('ROLLBACK'); return fin({ ok: false, error: rp || mp, planned: brief(r.ch), orphans: r.orphans.length }); }
      if (o.dryRun) { db.exec('ROLLBACK'); return { ok: true, dryRun: true, changes: brief(r.ch), notes: r.notes, orphans: 0, unmanaged: r.unmanaged.length, manual: r.manual.length, alerts: r.lineConflicts, lineSkipped: lineErr || undefined }; }
      saveChanged(db, r.staff, r.changed);
      db.exec('COMMIT');
      const c = brief(r.ch);
      return fin({ ok: true, updated: r.changed.length, linked: r.staff.filter((s) => s.active && s.lineHash).length, sourceErrors: Array.isArray(got && got.errors) ? got.errors.length : 0,
        changes: c, notes: r.notes, orphans: 0, unmanaged: r.unmanaged.length, manual: r.manual.length, manualIds: r.manual.map((x) => x.id), alerts: r.lineConflicts, lineSkipped: lineErr || undefined });
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
      let snapName = kvGet(db, SNAP_KEY);                                        // 已經搬過家：保留最早那份（切換前的原樣），不覆蓋
      if (!snapName || !fs.existsSync(path.join(snapDir, snapName))) {
        snapName = snapshotName(o.now); fs.writeFileSync(path.join(snapDir, snapName), JSON.stringify(staff), { mode: 0o600 }); kvSet(db, SNAP_KEY, snapName);
      }
      const snapFile = path.join(snapDir, snapName);
      const up = db.prepare('UPDATE staff SET json = ? WHERE id = ?'); let filled = 0, cleared = 0;
      rep.items.forEach((it) => {
        if (it.status !== 'unique' || !it.dzy) return;
        const s = staff.find((x) => x.id === it.id); if (s.dzy === it.dzy) return;
        s.dzy = it.dzy;
        if (it.nameDiff) { clearCredentials(s); cleared++; }                     // G3：姓名不一致、人工確認後才認領＝不繼承舊密碼與 LINE 綁定
        up.run(JSON.stringify(s), s.id); filled++;
      });
      kvSet(db, MIGRATED_KEY, (o.now || new Date()).toISOString());
      db.exec('COMMIT');
      Object.assign(res, { applied: true, filled, credsCleared: cleared, snapshot: path.basename(snapFile) });
      return res;
    } catch (e) { try { db.exec('ROLLBACK'); } catch (y) {} throw e; }
  } finally { try { db.close(); } catch (e) {} }
}
// G3：人工確認認領時清掉舊帳號的憑證：密碼、LINE 綁定都清，pinVer+1 讓已登入的手機失效
// seeAll 一起清（#45-2）：換人認領不繼承前一位的總監可見，下一輪同步依新的人的職稱再給
function clearCredentials(s) { s.pinHash = ''; s.salt = ''; s.fail = 0; s.lineHash = ''; delete s.seeAll; s.pinVer = (Number(s.pinVer) || 0) + 1; }
// 人工認領：S-xxx 與 DZY 編號由人確認是同一人（姓名不一致時 dzyApply 不會自動認領）。o: { dir, fetchDir, id, dzy }
async function runClaim(o) {
  const dirN = await o.fetchDir();
  if (!dirN.byDzy[o.dzy]) return { ok: false, error: '管理系統名單沒有 ' + o.dzy };
  const db = J.openDb(o.dir, { busyMs: o.busyMs });
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      const staff = readStaff(db), s = staff.find((x) => x.id === o.id);
      if (!s) { db.exec('ROLLBACK'); return { ok: false, error: '找不到 ' + o.id }; }
      if (s.dzy) { db.exec('ROLLBACK'); return { ok: false, error: o.id + ' 已經掛了 ' + s.dzy }; }
      const other = staff.find((x) => x.dzy === o.dzy && x.active);
      if (other) { db.exec('ROLLBACK'); return { ok: false, error: o.dzy + ' 已經被 ' + other.id + ' 使用' }; }
      s.dzy = o.dzy; clearCredentials(s);
      db.prepare('UPDATE staff SET json = ? WHERE id = ?').run(JSON.stringify(s), s.id);
      db.exec('COMMIT');
      return { ok: true, id: s.id, dzy: o.dzy, credsCleared: true };
    } catch (e) { try { db.exec('ROLLBACK'); } catch (y) {} throw e; }
  } finally { try { db.close(); } catch (e) {} }
}

// G12：回退。把搬家前快照裡的每一筆同仁資料（姓名、單位、門市、在職、src…）恢復成搬家前的樣子，但**保留現有的密碼**（不把已改過的舊密碼救回來）；
// 快照之後才新增的同仁保留（他們可能已簽過公告）；清掉兩個旗標；**所有**同仁 pinVer+1（已登入的手機全部重新登入）。
// 呼叫端還要把 STAFF_SOURCE 改回 clock 並重啟。o: { dir, snapshot(檔名，預設搬家時記下的那份), busyMs }
function runRollback(o) {
  const release = J.takeLock(o.dir, 'mirror');
  if (!release) return { ok: false, error: '另一輪鏡像正在跑，請稍後再執行 rollback' };
  const db = J.openDb(o.dir, { busyMs: o.busyMs });
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      const name = o.snapshot || kvGet(db, SNAP_KEY);
      const file = name && path.join(o.dir, 'backups', path.basename(name));
      if (!file || !fs.existsSync(file)) { db.exec('ROLLBACK'); return { ok: false, error: '找不到搬家前快照（backups/staff-snapshot-*.json），沒有動任何資料' }; }
      const snap = JSON.parse(fs.readFileSync(file, 'utf8')), cur = readStaff(db), byId = {}; snap.forEach((x) => { byId[x.id] = x; });
      const up = db.prepare('UPDATE staff SET json = ? WHERE id = ?'); let restored = 0;
      cur.forEach((c) => {
        let n = c;
        if (byId[c.id]) { n = Object.assign({}, byId[c.id], { pinHash: c.pinHash, salt: c.salt, fail: c.fail, pinVer: c.pinVer }); delete n.offBy; restored++; }
        n.pinVer = (Number(n.pinVer) || 0) + 1;
        delete n.seeAll;   // 回打卡模式後沒有任何同步會收回 seeAll → 一律清掉（#45-2）；總監回退期只看自己單位
        up.run(JSON.stringify(n), n.id);
      });
      db.prepare('DELETE FROM kv WHERE k IN (?, ?)').run(MIGRATED_KEY, SWITCH_KEY);
      db.exec('COMMIT');
      return { ok: true, snapshot: path.basename(file), restored, total: cur.length, pinVerBumped: cur.length };
    } catch (e) { try { db.exec('ROLLBACK'); } catch (y) {} throw e; }
  } finally { try { db.close(); } catch (e) {} release(); }
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
  const { got, err: lineErr } = await readRawClock(o.bridge);
  const db = J.openDb(o.dir, { readOnly: true });
  let staff; try { staff = readStaff(db); } finally { try { db.close(); } catch (e) {} }
  const now = o.now ? o.now() : new Date(), date = L.today(now);
  const plan = dzyApply(staff, dirN, got, now.toISOString()), cmp = compareStaff(staff, plan.staff), problem = roundProblem(plan);
  // 雜湊沒比到（打卡名冊讀不到／不是 raw）、或新路徑這輪會被拒寫（歧義、lineHash 重複、已連結者缺列）＝不能算「全同」
  const res = { at: now.toISOString(), date, ok: !lineErr, same: cmp.same && !lineErr && !problem, lineSkipped: lineErr || undefined, problem: problem || undefined, compared: cmp.compared,
    counts: { onlyNew: cmp.onlyNew.length, onlyOld: cmp.onlyOld.length, active: cmp.active.length, home: cmp.home.length, hash: cmp.hash.length },
    ids: { onlyNew: cmp.onlyNew, onlyOld: cmp.onlyOld, active: cmp.active, home: cmp.home, hash: cmp.hash }, notes: plan.notes, unmanaged: plan.unmanaged.length, manual: plan.manual.map((x) => x.id) };
  if (!o.noWrite) {
    J.writeLast(o.dir, 'staff-dual-' + date + '.json', res); J.writeLast(o.dir, 'staff-dual-last.json', res);
    J.logLine(o.dir, 'staff-dual.log', `${date} 雙跑比對：${res.same ? '全同' : '有差異'}｜比對 ${res.compared} 筆｜新路徑多 ${res.counts.onlyNew}、舊路徑多 ${res.counts.onlyOld}、在職不同 ${res.counts.active}、主店不同 ${res.counts.home}、LINE 不同 ${res.counts.hash}` + (lineErr ? '｜' + lineErr : '') + (problem ? '｜' + problem : ''));
    // G8：只有連續 7 天全同（dualStatus.canRetire）才寫「可切換」旗標；沒搬家過不寫；這裡只會寫入、不會清除（已切換期間不能因為某天有差異就讓服務自己退回 clock）
    const dbw = J.openDb(o.dir, { busyMs: o.busyMs });
    try { if (kvGet(dbw, MIGRATED_KEY) && dualStatus(o.dir, now).canRetire) { kvSet(dbw, SWITCH_KEY, now.toISOString()); res.switchable = true; } } finally { try { dbw.close(); } catch (e) {} }
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
    if (r.problem) console.log('⚠ ' + r.problem);
    if (r.switchable) console.log('★ 連續 7 天全同，已寫入「可切換」旗標');
    process.exit(r.same ? 0 : 1);
  } else if (cmd === 'dual-status') {
    const s = dualStatus(dir);
    console.log(`雙跑紀錄 ${s.days} 天｜連續全同 ${s.streak} 天（需要 ${s.need} 天）｜最近一次 ${s.last || '無'}${s.lastSame === false ? '（有差異）' : ''}｜${s.canRetire ? '可拆舊' : '還不能拆舊'}`);
    process.exit(s.canRetire ? 0 : 1);
  } else if (cmd === 'sync') {
    const r = await runDzySync({ dir, bridge, fetchDir, allowMass: has('--allow-mass'), dryRun: has('--dry-run') });
    console.log(r.ok ? `同步${r.dryRun ? '（試跑，沒寫入）' : '完成'}：` + JSON.stringify(r.changes) + `｜管理系統沒有的在職 ${r.orphans} 人、未掛 dzy 的在職 ${r.unmanaged} 人` : '✗ ' + r.error);
    (r.notes || []).forEach((n) => console.log('  ' + n));
    if (r.manual) console.log(`  需人工認領 ${r.manual} 筆（姓名不一致）：` + (r.manualIds || []).join('、'));
    (r.alerts || []).length && console.log('  ⚠ 多來源 LINE 綁定不同、已鎖定自動登入：' + r.alerts.join('、'));
    process.exit(r.ok ? 0 : 1);
  } else if (cmd === 'claim') {
    const r = await runClaim({ dir, fetchDir, id: process.argv[3], dzy: process.argv[4] });
    console.log(r.ok ? `已認領：${r.id} → ${r.dzy}（舊密碼與 LINE 綁定已清除，同仁要重設密碼）` : '✗ ' + r.error);
    process.exit(r.ok ? 0 : 1);
  } else if (cmd === 'rollback') {
    const r = runRollback({ dir, snapshot: arg('--snapshot') });
    console.log(r.ok ? `已回退：恢復快照 ${r.snapshot} 的 ${r.restored} 筆、清除「已搬家」「可切換」旗標、全部 ${r.pinVerBumped} 筆 pinVer+1。請把 server/.env 的 STAFF_SOURCE 改回 clock（或刪掉）並重啟伺服器` : '✗ ' + r.error);
    process.exit(r.ok ? 0 : 1);
  } else { console.log('用法：node server/staff-dzy.js claim S-xxx DZYxxx | rollback [--snapshot 檔名] | node server/staff-dzy.js migrate [--apply] [--map 檔.json] [--allow-name-diff] | dual | dual-status | sync [--dry-run] [--allow-mass]'); process.exit(2); }
}
if (require.main === module) main().catch((e) => { console.error('✗ ' + (e && e.message || e)); process.exit(1); });

module.exports = { redeemTicket, SEE_ALL_TITLES, SWITCH_KEY, SNAP_KEY, roundProblem, runClaim, runRollback, clearCredentials, readRawClock, STORE_OF_SRC, SRC_OF_STORE, UNIT_OF_DZY, MIGRATED_KEY, DUAL_NEED_DAYS, normalizeDirectory, dzyApply, compareStaff, classifyMigration, massProblem, wantedLineHash,
  clockKeyOfSrc, homeSrcOf, dirConfig, fetchDirectory, effectiveSource, sourceWarning, runDzySync, runMigrate, runDual, dualStatus, loadOverrides };
