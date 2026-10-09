// node test/store.test.js — 用假的 SpreadsheetApp／CacheService／PropertiesService 跑 gas/Store.js，
// 驗證讀取快取世代：寫入後不讀到舊資料、跨請求的舊快取不會污染、越界加列、就地更新 memo。
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; console.log('✗', name, '\n   got ', g, '\n   want', w); }
}

// ---- 假 Google 服務 ----
function makeSheet(maxRows) {
  const sh = { data: [], max: maxRows, reads: 0 };
  const cell = (r, c) => ((sh.data[r - 1] || [])[c - 1] ?? '');
  sh.getLastRow = () => sh.data.length;
  sh.getMaxRows = () => sh.max;
  sh.maxCols = 26; sh.getMaxColumns = () => sh.maxCols; sh.insertColumnsAfter = (a, n) => { sh.maxCols += n; };   // #32-7：欄數防呆
  sh.insertRowsAfter = (after, n) => { sh.max += n; };
  sh.getRange = (r, c, nr = 1, nc = 1) => {
    if (r + nr - 1 > sh.max) throw new Error('範圍超出工作表');
    const rng = {
      getValues: () => { sh.reads++; return Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => cell(r + i, c + j))); },
      getValue: () => cell(r, c),
      setValues: (v) => { v.forEach((row, i) => { const R = r + i - 1; sh.data[R] = sh.data[R] || []; row.forEach((x, j) => { sh.data[R][c + j - 1] = x; }); }); return rng; },
      setNumberFormat: () => rng, setFontWeight: () => rng
    };
    return rng;
  };
  return sh;
}
const props = {}, cache = {};
const sheets = {};
const G = {
  DZYB: require('../js/logic.js'),
  PropertiesService: { getScriptProperties: () => ({
    getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = String(v); },
    getProperties: () => Object.assign({}, props), setProperties: o => Object.assign(props, o), deleteProperty: k => { delete props[k]; } }) },
  CacheService: { getScriptCache: () => ({
    get: k => (k in cache ? cache[k] : null),
    getAll: ks => { const o = {}; ks.forEach(k => { if (k in cache) o[k] = cache[k]; }); return o; },
    put: (k, v) => { cache[k] = v; }, putAll: o => Object.assign(cache, o) }) },
  SpreadsheetApp: {
    openById: id => { if (id === 'SNAP') { if (snapFail) throw new Error('快照試算表打不開'); return snapBook; } return { getSheetByName: n => sheets[n] }; },
    create: () => snapBook, flush: () => {} },
  Utilities: { sleep: () => {}, formatDate: () => '' },
  console
};
vm.createContext(G);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../gas/Store.js'), 'utf8'), G);
props.SPREADSHEET_ID = 'fake';
['公告', '同仁', '已讀', '操作紀錄'].forEach(n => { sheets[n] = makeSheet(3); });
const snapSheet = makeSheet(3); let snapFail = false;
snapSheet.getRange0 = snapSheet.getRange;
snapSheet.getRange = (r, c, nr = 1, nc = 1) => { const g = snapSheet.getRange0(r, c, nr, nc); g.clearContent = () => { for (let i = r - 1; i < r - 1 + nr; i++) snapSheet.data[i] = []; snapSheet.data = snapSheet.data.filter(x => x && x.length); return g; }; return g; };
const snapBook = { getId: () => 'SNAP', getSheets: () => [{ setName: () => {} }], getSheetByName: n => n === '名單快照' ? snapSheet : null, insertSheet: () => snapSheet };
// 同仁表：表頭＋1 人（最大 3 列）
const staffHead = G.SHEETS_.staff.head;
sheets['同仁'].data = [staffHead, ['S-001', '甲', 'mala', '', '', '0', '0', 'TRUE', '', '', '']];
const files = { saveSig: () => 'sig', readSig: () => '' };
const S = { name: '乙', unit: 'cf', pinHash: '', salt: '', pinVer: 0, fail: 0, active: true, createdAt: '', deletedAt: '', src: '' };

// 1) 請求 A 讀名單（寫入快取），請求 B 新增一人 → 之後的新請求必須看到兩人，不能吃 A 放的舊快取
const A = vm.runInContext('makeStore_', G)(files);
eq('A 讀到 1 人', A.getStaff().length, 1);
const readsAfterA = sheets['同仁'].reads;
const A2 = vm.runInContext('makeStore_', G)(files);
eq('快取命中不讀試算表', [A2.getStaff().length, sheets['同仁'].reads], [1, readsAfterA]);
const B = vm.runInContext('makeStore_', G)(files);
B.saveStaff(Object.assign({ id: 'S-002' }, S));
const C = vm.runInContext('makeStore_', G)(files);
eq('寫入後新請求看到 2 人', C.getStaff().map(s => s.id), ['S-001', 'S-002']);

// 2) 舊快照污染：R 在寫入前就讀了（memo＝舊資料），W 寫入後，R 才去放快取 → 只會放在舊世代，新請求不受影響
const R = vm.runInContext('makeStore_', G)(files);
R.getStaff();                                         // 舊資料（2 人）＋舊世代
const W = vm.runInContext('makeStore_', G)(files);
W.saveStaff(Object.assign({ id: 'S-003' }, S, { name: '丙' }));
eq('R 仍是自己的舊快照（本請求內一致）', R.getStaff().length, 2);
const N = vm.runInContext('makeStore_', G)(files);
eq('新請求看到 3 人（舊快照沒污染新世代）', N.getStaff().length, 3);

// 3) 越界加列：最大 3 列、已用 3 列 → 第 4 列寫入前要先加列，不能丟例外
eq('寫第 4 列前已滿', [sheets['同仁'].getLastRow(), sheets['同仁'].getMaxRows()], [4, 3 + 200]);   // 上一步寫第 4 列時已加列

// 4) 同一請求連續新增：memo 就地更新，不整表重讀，且列號正確
const M = vm.runInContext('makeStore_', G)(files);
M.getStaff(); const before = sheets['同仁'].reads;
M.saveStaff(Object.assign({ id: 'S-004' }, S, { name: '丁' }));
M.saveStaff(Object.assign({ id: 'S-005' }, S, { name: '戊' }));
eq('連續新增不重讀試算表', sheets['同仁'].reads, before);
eq('memo 含新增兩人', M.getStaff().map(s => s.id).slice(-2), ['S-004', 'S-005']);
M.saveStaff(Object.assign({ id: 'S-004' }, S, { name: '丁（改）' }));
eq('更新寫回原列、不重複', [sheets['同仁'].data.filter(r => r[0] === 'S-004').length, sheets['同仁'].data[4][1]], [1, '丁（改）']);
const F = vm.runInContext('makeStore_', G)(files);
eq('新請求讀到的與試算表一致', F.getStaff().map(s => s.name), ['甲', '乙', '丙', '丁（改）', '戊']);

// 6) 有人手動刪掉試算表一列（沒有換世代）→ 快取列號過期，寫回時要偵測並寫到正確的列
const P = vm.runInContext('makeStore_', G)(files); P.getStaff();         // 讓快取有舊列號
sheets['同仁'].data.splice(2, 1);                                          // 手動刪掉第 3 列（乙）
const Q = vm.runInContext('makeStore_', G)(files);                         // 新請求：讀到的是舊快取（列號過期）
Q.saveStaff(Object.assign({ id: 'S-005' }, S, { name: '戊（改）' }));
const col = sheets['同仁'].data.map(r => r[0] + ':' + r[1]);
eq('手動刪列後寫回正確的列、沒有蓋到別人', col, ['id:姓名', 'S-001:甲', 'S-003:丙', 'S-004:丁（改）', 'S-005:戊（改）']);

// 7) 名單快照：同仁表寫入後重寫，只有公開欄位、姓名遮罩、不含雜湊
const Z = vm.runInContext('makeStore_', G)(files);
Z.saveStaff(Object.assign({ id: 'S-006' }, S, { name: '歐陽娜娜', unit: 'mzt', store: '金山', pinHash: 'HASH', salt: 'SALT' }));
eq('請求結束前不寫快照（批次同步只寫一次）', snapSheet.data.length, 0);
Z.endRequest();
const snap = snapSheet.data;
eq('快照寫在獨立的公開名單試算表（主試算表沒有名單快照分頁）', [props.SNAP_SS_ID, sheets['名單快照']], ['SNAP', undefined]);
eq('快照表頭', snap[0], ['id', 'name', 'unit', 'store', 'hasPin', 'locked']);
eq('快照含新同仁（遮罩、門市、有密碼）', snap.find(r => r[0] === 'S-006'), ['S-006', '歐OO娜', 'mzt', '金山', 'Y', '']);
eq('快照不含雜湊或 salt', JSON.stringify(snap).includes('HASH') || JSON.stringify(snap).includes('SALT'), false);
eq('快照筆數＝在職同仁', snap.length - 1, vm.runInContext('makeStore_', G)(files).getStaff().filter(s => s.active).length);
snapFail = true;
const Y = vm.runInContext('makeStore_', G)(files);
Y.saveStaff(Object.assign({ id: 'S-007' }, S, { name: '己' }));
const snapRowsBefore = JSON.stringify(snapSheet.data); let created = 0; const origCreate = G.SpreadsheetApp.create; G.SpreadsheetApp.create = () => { created++; return snapBook; };
let threw = false; try { Y.endRequest(); } catch (e) { threw = true; }
eq('快照失敗不拋例外、同仁仍寫入成功', [threw, sheets['同仁'].data.some(r => r[0] === 'S-007')], [false, true]);
eq('快照試算表打不開時真的沒寫入、也沒偷偷重建新表', [JSON.stringify(snapSheet.data) === snapRowsBefore, created, props.SNAP_SS_ID], [true, 0, 'SNAP']);
G.SpreadsheetApp.create = origCreate;
snapFail = false;

// 5) 操作紀錄不換世代（不讓快取失效）
const genBefore = props.DATA_GEN;
F.addLog({ at: 'x', action: 'y', target: '', summary: '' });
eq('addLog 不換世代', props.DATA_GEN, genBefore);

console.log(`store: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
