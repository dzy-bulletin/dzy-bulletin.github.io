// node test/bridge.test.js — M2（#7）：Apps Script 改當 Google 橋接
// 用假的 Google 服務（試算表／Drive／屬性／鎖／快取）把 gas/*.js 原封不動載進 vm，再開一個本機 HTTP 假「Web App」包住 doPost，
// 讓 server/bridge.js（M1 客戶端）真的打過來：驗 op 名稱與參數格式對得上、每條驗收各有對應的檢查。不連任何 Google。
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path'), http = require('http'), os = require('os'), crypto = require('crypto');
const { makeBridge } = require('../server/bridge.js');
let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; console.log('✗', name, '\n   got ', g, '\n   want', w); }
}

// ---------- 假 Google 服務 ----------
const props = {}, cache = {}, logged = [];
let lockFree = true, throwOnWrite = null, onTryLock = null, failRename = null, failDelete = null;   // failDelete：{name, n} 刪這個名稱的分頁時丟錯 n 次
   // onTryLock：等鎖期間發生的事（S2）；failRename：改成這個名稱時丟錯一次（還原時同名可以成功）                       // throwOnWrite：寫到這個分頁名稱時丟錯（模擬 mirror 寫到一半逾時）
function makeSheet(name, maxRows) {
  const sh = { name, data: [], max: maxRows || 1000, frozen: 0 };
  const cell = (r, c) => ((sh.data[r - 1] || [])[c - 1] ?? '');
  sh.getName = () => sh.name;
  sh.setName = (n) => { if (failRename === n) { failRename = null; throw new Error('模擬換名失敗：' + n); } if (book && book.sheets.some((x) => x !== sh && x.name === n)) throw new Error('分頁名稱重複：' + n); sh.name = n; return sh; };   // 真的 Sheets 遇到重名會丟錯
  sh.getLastRow = () => sh.data.length;
  sh.getMaxRows = () => sh.max;
  sh.maxCols = 26; sh.getMaxColumns = () => sh.maxCols; sh.insertColumnsAfter = (a, n) => { sh.maxCols += n; };   // #32-7：欄數防呆
  sh.insertRowsAfter = (after, n) => { sh.max += n; };
  sh.setFrozenRows = (n) => { sh.frozen = n; };
  sh.getRange = (r, c, nr = 1, nc = 1) => {
    if (r + nr - 1 > sh.max) throw new Error('範圍超出工作表');
    const rng = {
      getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => cell(r + i, c + j))),
      getValue: () => cell(r, c),
      setValues: (v) => {
        if (throwOnWrite && sh.name === throwOnWrite) throw new Error('模擬逾時：' + sh.name);
        v.forEach((row, i) => { const R = r + i - 1; sh.data[R] = sh.data[R] || []; row.forEach((x, j) => { sh.data[R][c + j - 1] = x; }); });
        return rng;
      },
      clearContent: () => { for (let i = r - 1; i < r - 1 + nr; i++) sh.data[i] = []; while (sh.data.length && !sh.data[sh.data.length - 1].length) sh.data.pop(); return rng; },
      setNumberFormat: () => rng, setFontWeight: () => rng
    };
    return rng;
  };
  return sh;
}
let book;
const snapSheet = makeSheet('名單快照'), snapBook = { getSheetByName: () => snapSheet, insertSheet: () => snapSheet };
function freshBook() {
  const sheets = [];
  book = {
    sheets,
    getSheetByName: (n) => sheets.find((s) => s.name === n) || null,
    getSheets: () => sheets.slice(),
    insertSheet: (n, idx) => { if (sheets.some((s) => s.name === n)) throw new Error('分頁已存在'); const s = makeSheet(n); sheets.splice(idx === undefined ? sheets.length : idx, 0, s); return s; },
    deleteSheet: (s) => { if (failDelete && failDelete.n > 0 && s.name === failDelete.name) { failDelete.n--; throw new Error('模擬刪除中斷：' + s.name); } const i = sheets.indexOf(s); if (i >= 0) sheets.splice(i, 1); }
  };
}
// Drive：資料夾與檔案
const drive = { folders: {}, files: {}, seq: 0 };
const iter = (arr) => { let i = 0; return { hasNext: () => i < arr.length, next: () => arr[i++] }; };
function folderObj(id) {
  const f = drive.folders[id];
  return {
    getId: () => id, getName: () => f.name, isTrashed: () => !!f.trashed,
    getParents: () => iter(f.parent ? [folderObj(f.parent)] : []),
    createFolder: (name) => folderObj(newFolder(name, id)),
    createFile: (blob) => fileObj(newFile(blob, id)),
    getFiles: () => iter(Object.keys(drive.files).filter((k) => drive.files[k].parent === id && !drive.files[k].trashed).map(fileObj)),
    getSharingAccess: () => f.sharing, setSharing: (a) => { f.sharing = a; },
    getEditors: () => (f.editors || []), getViewers: () => []
  };
}
function newFolder(name, parent) { const id = 'D' + (++drive.seq); drive.folders[id] = { name, parent, sharing: 'PRIVATE' }; return id; }
function newFile(blob, parent) { const id = 'G' + (++drive.seq); drive.files[id] = { name: blob.name, mime: blob.mime, bytes: blob.bytes, parent, sharing: 'PRIVATE', created: Date.now() }; return id; }
function fileObj(id) {
  const f = drive.files[id]; if (!f) throw new Error('找不到檔案');
  return {
    getId: () => id, getName: () => f.name, getMimeType: () => f.mime, getSize: () => f.bytes.length,
    getParents: () => iter([folderObj(f.parent)]), getDateCreated: () => new Date(f.created),
    getBlob: () => ({ getContentType: () => f.mime, getBytes: () => f.bytes }),
    getSharingAccess: () => f.sharing, setSharing: (a) => { f.sharing = a; }, setTrashed: (t) => { f.trashed = t; }, isTrashed: () => !!f.trashed
  };
}
// M7：假 Drive 的 md5Checksum／Files.list。垃圾桶內的檔照樣列（呼叫端沒帶 trashed=false）；刪掉 drive.files[id]＝模擬垃圾桶 30 天後永久刪除
const md5Of = (bytes) => crypto.createHash('md5').update(Buffer.from(bytes.map((b) => b & 255))).digest('hex');
function driveGet(id) { const f = drive.files[id]; if (!f) throw new Error('File not found: ' + id); return { md5Checksum: md5Of(f.bytes), size: String(f.bytes.length), trashed: !!f.trashed }; }
function driveList(o) {
  const m = /^'([^']+)' in parents$/.exec(String(o && o.q || '')); if (!m) throw new Error('不支援的查詢：' + (o && o.q));
  const ids = Object.keys(drive.files).filter((k) => drive.files[k].parent === m[1]).sort();
  const at = Number(o.pageToken) || 0, n = Number(o.pageSize) || 100, page = ids.slice(at, at + n);
  return { files: page.map((k) => { const f = drive.files[k]; return { id: k, name: f.name, mimeType: f.mime, size: String(f.bytes.length), md5Checksum: md5Of(f.bytes), trashed: !!f.trashed, createdTime: new Date(f.created).toISOString() }; }),
    nextPageToken: at + n < ids.length ? String(at + n) : undefined };
}
const signed = (buf) => Array.from(buf).map((b) => (b > 127 ? b - 256 : b));
const G = {
  console: Object.assign({}, console, { error: () => {}, warn: () => {} }),
  Logger: { log: (m) => logged.push(String(m)) },   // 預期中的錯誤（丟錯測試）不洗版
  DZYB: require('../js/logic.js'),
  PropertiesService: { getScriptProperties: () => ({
    getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = String(v); },
    getProperties: () => Object.assign({}, props), setProperties: (o) => { Object.keys(o).forEach((k) => { props[k] = String(o[k]); }); },
    deleteProperty: (k) => { delete props[k]; } }) },
  CacheService: { getScriptCache: () => ({
    get: (k) => (k in cache ? cache[k] : null),
    getAll: (ks) => { const o = {}; ks.forEach((k) => { if (k in cache) o[k] = cache[k]; }); return o; },
    put: (k, v) => { cache[k] = v; }, putAll: (o) => Object.assign(cache, o) }) },
  LockService: { getScriptLock: () => ({ tryLock: () => { if (onTryLock) { const f = onTryLock; onTryLock = null; f(); } return lockFree; }, releaseLock: () => {} }) },
  ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => ({ s, setMimeType() { return this; }, getContent() { return this.s; } }) },
  SpreadsheetApp: { openById: (id) => (id === 'SNAP' ? snapBook : book), flush: () => {} },
  DriveApp: {
    Access: { ANYONE_WITH_LINK: 'ANYONE_WITH_LINK', PRIVATE: 'PRIVATE' }, Permission: { VIEW: 'VIEW', NONE: 'NONE' },
    getFolderById: (id) => { if (!drive.folders[id]) throw new Error('找不到資料夾'); return folderObj(id); },
    createFolder: (name) => folderObj(newFolder(name, 'ROOT')),
    getFileById: (id) => fileObj(id), getRootFolder: () => folderObj('ROOT')
  },
  // M7（#18）：Drive 進階服務 Files.get（md5Checksum，Drive 已算好）／Files.list（q="'<資料夾>' in parents"，含垃圾桶、分頁）
  Drive: { Files: { update: () => {}, get: (id) => driveGet(id), list: (o) => driveList(o) }, About: { get: () => ({ storageQuota: { limit: '100', usage: '40' } }) } },
  Utilities: {
    sleep: () => {}, formatDate: () => '', getUuid: () => crypto.randomUUID(),
    DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
    computeDigest: (a, s) => signed(crypto.createHash('sha256').update(s, 'utf8').digest()),
    computeHmacSha256Signature: (m, k) => signed(crypto.createHmac('sha256', k).update(m, 'utf8').digest()),
    base64EncodeWebSafe: (b) => Buffer.from(b.map((x) => x & 255)).toString('base64url'),
    base64Encode: (b) => Buffer.from(b.map((x) => x & 255)).toString('base64'),
    base64Decode: (s) => signed(Buffer.from(s, 'base64')),
    newBlob: (bytes, mime, name) => ({ bytes, mime, name })
  }
};
drive.folders.ROOT = { name: '我的雲端硬碟', parent: null, sharing: 'PRIVATE' };
vm.createContext(G);
['gas/Auth.js', 'gas/Service.js', 'gas/Store.js', 'gas/Files.js', 'gas/Code.js'].forEach((f) => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), G, { filename: f }));
const doPost = (body) => JSON.parse(G.doPost({ postData: { contents: JSON.stringify(body) } }).getContent());
const store = () => vm.runInContext('makeStore_(makeFiles_())', G);
const bumpGen = () => vm.runInContext('bumpGen_()', G);   // 測試直接改試算表後讓快取失效

// 主試算表四分頁（與 setup() 相同表頭）＋一位同仁、一則公告
function seedBook() {
  freshBook();
  ['posts', 'staff', 'reads', 'log'].forEach((k) => { const d = G.SHEETS_[k], s = book.insertSheet(d.name); s.data.push(d.head.slice()); });
  const td = G.DZYB.today();
  book.getSheetByName('同仁').data.push(['S-001', '陳大安', 'mala', '', '', '0', '0', 'TRUE', '', '', '', '']);
  book.getSheetByName('公告').data.push(['P-1', '測試公告', '內容', 'mala', G.DZYB.addDays(td, -1), '', 'FALSE', 'TRUE', '', '[]', '', '']);
}
seedBook();
const KEY = 'k'.repeat(40);
Object.assign(props, { SPREADSHEET_ID: 'MAIN', SNAP_SS_ID: 'SNAP', TOKEN_SECRET: 'secret-xyz', ADMIN_HASH: 'ahash', ADMIN_SALT: 'asalt', ADMIN_VER: '3', BRIDGE_KEY: KEY });

// ---------- 本機假 Web App：把 HTTP POST 丟給 doPost（算呼叫次數） ----------
let hits = 0;
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; });
  req.on('end', () => { hits++; const out = G.doPost({ postData: { contents: b } }).getContent(); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(out); });
});

(async () => {
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const URL0 = 'http://127.0.0.1:' + srv.address().port + '/exec';
  const B = makeBridge(URL0, KEY);
  const raw = async (body) => JSON.parse(await (await fetch(URL0, { method: 'POST', body: JSON.stringify(body) })).text());
  const codeOf = async (p) => { try { await p; return 'OK'; } catch (e) { return e.code + '|' + (/ (AUTH|BAD_REQ|SERVER|MOVED) /.exec(e.detail + ' ') || [])[1]; } };

  // ===== 驗收 1：金鑰缺／短於 32／錯誤一律 AUTH；op 未知回 BAD_REQ =====
  eq('金鑰缺 → AUTH', (await raw({ action: 'bridge', op: 'quota' })).code, 'AUTH');
  eq('金鑰錯 → AUTH', (await raw({ action: 'bridge', key: 'x'.repeat(40), op: 'quota' })).code, 'AUTH');
  eq('金鑰長度對但差一字 → AUTH', (await raw({ action: 'bridge', key: KEY.slice(0, -1) + 'j', op: 'quota' })).code, 'AUTH');
  props.BRIDGE_KEY = 's'.repeat(31);
  eq('指令碼屬性 BRIDGE_KEY 短於 32 → 就算送一樣的也 AUTH', (await raw({ action: 'bridge', key: 's'.repeat(31), op: 'quota' })).code, 'AUTH');
  delete props.BRIDGE_KEY;
  eq('指令碼屬性沒設 BRIDGE_KEY → AUTH（空字串也不行）', (await raw({ action: 'bridge', key: '', op: 'quota' })).code, 'AUTH');
  props.BRIDGE_KEY = KEY;
  eq('AUTH 訊息不透露是哪一種錯', (await raw({ action: 'bridge', op: 'quota' })).message, '橋接金鑰錯誤');
  eq('未知 op → BAD_REQ', (await raw({ action: 'bridge', key: KEY, op: 'nope' })).code, 'BAD_REQ');
  eq('金鑰錯時連 op 未知也只回 AUTH（先驗金鑰）', (await raw({ action: 'bridge', key: 'bad', op: 'nope' })).code, 'AUTH');
  // #12 第 3 輪：bridge.js 只放行 BAD_REQ／BAD_TYPE／TOO_BIG 當業務錯誤，金鑰問題若回 BAD_REQ 會直接顯示給主管 → 一律 AUTH、且先於任何參數檢查
  eq('金鑰錯＋參數也錯（sigs 沒給 put/get、backup 空內容、upload 空檔）→ 仍是 AUTH 不是 BAD_REQ',
    [(await raw({ action: 'bridge', key: 'bad', op: 'sigs' })).code, (await raw({ action: 'bridge', op: 'backup' })).code, (await raw({ action: 'bridge', key: 'x'.repeat(31), op: 'upload' })).code], ['AUTH', 'AUTH', 'AUTH']);
  const biz = async (p) => { try { await p; return 'OK'; } catch (e) { return [e.code, !!e.business]; } };
  eq('bridge.js：金鑰錯 → BRIDGE、不是業務錯誤（不會把 AUTH／BAD_REQ 原文顯示給主管）', [await biz(makeBridge(URL0, 'z'.repeat(40)).call('sigs', {})), await biz(makeBridge(URL0, 'short').files.upload('a.pdf', 'application/pdf', ''))], [['BRIDGE', false], ['BRIDGE', false]]);
  eq('bridge.js 客戶端：quota 通', await B.files.quota(), { limit: 100, usage: 40 });
  eq('bridge.js 客戶端：金鑰錯 → 伺服器自己的 BRIDGE 碼（不原樣回 AUTH）', await codeOf(makeBridge(URL0, 'z'.repeat(40)).files.quota()), 'BRIDGE|AUTH');

  // ===== 驗收 2：PRIMARY=mini 時 ack 回 MOVED、board 照常；PRIMARY=gas 時照舊 =====
  props.PRIMARY = 'gas';
  let r = doPost({ action: 'setPin', staffId: 'S-001', pin: '2580' });
  eq('PRIMARY=gas：setPin 照常', r.ok, true);
  const tok = r.data.token;
  eq('PRIMARY=gas：board 照常', doPost({ action: 'board', token: tok }).ok, true);
  props.PRIMARY = 'mini';
  const readsBefore = book.getSheetByName('已讀').data.length;
  r = doPost({ action: 'ack', token: tok, postId: 'P-1', sig: 'data:image/png;base64,AAAA' });
  eq('PRIMARY=mini：ack → MOVED＋固定訊息', [r.ok, r.code, r.message], [false, 'MOVED', '系統已搬家，請重新整理']);
  eq('PRIMARY=mini：ack 沒寫進已讀', book.getSheetByName('已讀').data.length, readsBefore);
  r = doPost({ action: 'board', token: tok });
  eq('PRIMARY=mini：board 照常（讀得到公告）', [r.ok, r.data.posts.map((p) => p.id)], [true, ['P-1']]);
  eq('PRIMARY=mini：roster／history 照常', [doPost({ action: 'roster' }).ok, doPost({ action: 'history', token: tok }).ok], [true, true]);
  const W = vm.runInContext('WRITE_ACTIONS_', G);
  eq('PRIMARY=mini：12 個寫入動作全部 MOVED（含 uploadFile）', W.concat(['uploadFile']).map((a) => doPost({ action: a }).code), W.concat(['uploadFile']).map(() => 'MOVED'));
  props.PRIMARY = 'gas';
  r = doPost({ action: 'ack', token: tok, postId: 'P-1', sig: 'data:image/png;base64,AAAA' });
  eq('PRIMARY=gas：ack 照常寫入', [r.ok, book.getSheetByName('已讀').data.length], [true, readsBefore + 1]);
  delete props.PRIMARY;
  eq('PRIMARY 未設定＝gas（寫入照常）', doPost({ action: 'login', staffId: 'S-001', pin: '2580' }).ok, true);

  // ===== 驗收 4：sigs 批次上傳 15 張只產生 1 次橋接呼叫，回傳 15 個 Drive id =====
  const png = 'data:image/png;base64,' + Buffer.from('簽名圖').toString('base64');
  const items = Array.from({ length: 15 }, (_, i) => ({ name: 'P-1_S-' + String(i).padStart(3, '0'), data: png }));
  hits = 0;
  const up = await B.call('sigs', { put: items });
  const sigFolder = props.SIG_FOLDER_ID;
  eq('sigs put 15 張：1 次橋接呼叫', hits, 1);
  eq('sigs put 15 張：回 15 個 Drive id、都在簽名資料夾、檔名對應', [up.ids.length, new Set(up.ids).size, up.ids.every((id) => drive.files[id] && drive.files[id].parent === sigFolder),
    up.ids.map((id) => drive.files[id].name)], [15, 15, true, items.map((x) => x.name + '.png')]);
  hits = 0;
  const got = await B.call('sigs', { get: up.ids.slice(0, 3).concat(['G-nope']) });
  eq('sigs get：1 次呼叫、讀回 data URL、讀不到的給 null', [hits, got.sigs[up.ids[0]], got.sigs['G-nope']], [1, png, null]);
  eq('sigs 超過 20 張 → BAD_REQ', (await raw({ action: 'bridge', key: KEY, op: 'sigs', put: items.concat(items) })).code, 'BAD_REQ');
  eq('sigs put／get 都沒給或都給 → BAD_REQ', [(await raw({ action: 'bridge', key: KEY, op: 'sigs' })).code, (await raw({ action: 'bridge', key: KEY, op: 'sigs', put: items, get: [] })).code], ['BAD_REQ', 'BAD_REQ']);
  const mixed = await B.call('sigs', { put: [{ name: 'ok1', data: png }, { name: 'x', data: 'hello' }, { name: 'ok2', data: png }] });
  eq('sigs put 逐張處理：不是圖的那張回 null、其他照樣上傳（不整批失敗留孤兒）', [mixed.ids[1], !!drive.files[mixed.ids[0]], !!drive.files[mixed.ids[2]]], [null, true, true]);

  // ===== #13 B1：sig／sigs.get 只讀簽名資料夾裡的 PNG／JPEG；share／revoke 只動附件資料夾裡的附件 =====
  const other = newFile({ name: '薪資表.pdf', mime: 'application/pdf', bytes: [1, 2, 3] }, 'ROOT');             // 其他系統的檔案（雲端硬碟根目錄）
  const rootPng = newFile({ name: '別的圖.png', mime: 'image/png', bytes: [9] }, 'ROOT');                       // 是圖、但不在簽名資料夾
  const sigPdf = newFile({ name: '混進簽名資料夾.pdf', mime: 'application/pdf', bytes: [7] }, sigFolder);          // 在簽名資料夾、但不是圖
  const sheetLike = newFile({ name: '其他系統試算表', mime: 'application/vnd.google-apps.spreadsheet', bytes: [5] }, 'ROOT');
  eq('sig：根目錄的其他檔案 → null（不洩漏內容或檔名）', [await B.call('sig', { id: other }), await B.call('sig', { id: sheetLike }), await B.call('sig', { id: 'G-不存在' })], [null, null, null]);
  eq('sig：是圖但不在簽名資料夾 → null；在簽名資料夾但不是圖 → null', [await B.call('sig', { id: rootPng }), await B.call('sig', { id: sigPdf })], [null, null]);
  const gs = await B.call('sigs', { get: [other, rootPng, sigPdf, sheetLike, up.ids[2]] });
  eq('sigs get：範圍外全部 null、簽名資料夾裡的照常讀', [gs.sigs[other], gs.sigs[rootPng], gs.sigs[sigPdf], gs.sigs[sheetLike], gs.sigs[up.ids[2]]], [null, null, null, null, png]);
  eq('sig／sigs 回應不含檔名', JSON.stringify(gs).includes('薪資表') || JSON.stringify(gs).includes('別的圖'), false);
  eq('share：根目錄的 PDF（不在附件資料夾）→ BAD_REQ、分享狀態不變', [(await raw({ action: 'bridge', key: KEY, op: 'share', ids: [other] })).code, drive.files[other].sharing], ['BAD_REQ', 'PRIVATE']);
  eq('share：簽名資料夾裡的圖 → BAD_REQ、分享狀態不變', [(await raw({ action: 'bridge', key: KEY, op: 'share', ids: [up.ids[3]] })).code, drive.files[up.ids[3]].sharing], ['BAD_REQ', 'PRIVATE']);
  await B.files.revoke([other, up.ids[3], sheetLike]);
  eq('revoke：範圍外的檔案（根目錄 PDF、簽名圖、試算表）不會被丟垃圾桶', [drive.files[other].trashed, drive.files[up.ids[3]].trashed, drive.files[sheetLike].trashed], [undefined, undefined, undefined]);
  { const sf = props.SIG_FOLDER_ID, nf = Object.keys(drive.folders).length; delete props.SIG_FOLDER_ID;
    eq('讀取路徑不建資料夾：SIG_FOLDER_ID 遺失時 sig 回 null、沒有新建資料夾', [await B.call('sig', { id: up.ids[4] }), 'SIG_FOLDER_ID' in props, Object.keys(drive.folders).length], [null, false, nf]);
    props.SIG_FOLDER_ID = sf; }
  eq('物件型別的 key → AUTH（不是錯誤網頁）', [(await raw({ action: 'bridge', key: { toString: 1 }, op: 'quota' })).code, (await raw({ action: 'bridge', key: [KEY], op: 'quota' })).code], ['AUTH', 'AUTH']);

  // ===== 驗收 5：PRIMARY≠mini 時 mirror 回 AUTH（實際經 HTTP 打一次） =====
  const snapshot = () => JSON.stringify(['公告', '同仁', '已讀', '操作紀錄'].map((n) => book.getSheetByName(n).data));
  const sheetsBefore = snapshot();
  const mirrorData = { posts: [], staff: [], reads: [], log: [] };
  props.PRIMARY = 'gas';
  eq('PRIMARY=gas：mirror → AUTH（raw）', (await raw({ action: 'bridge', key: KEY, op: 'mirror', data: mirrorData })).code, 'AUTH');
  eq('PRIMARY=gas：mirror → bridge.js 拿到 BRIDGE（AUTH 在 detail）', await codeOf(B.call('mirror', { data: mirrorData })), 'BRIDGE|AUTH');
  props.EXPORT_ONCE = '1';
  eq('PRIMARY=gas：export → AUTH（raw）；bridge.js 拿到 BRIDGE、不是業務錯誤', [(await raw({ action: 'bridge', key: KEY, op: 'export' })).code, await biz(B.call('export', {})), await biz(B.call('mirror', { data: mirrorData }))], ['AUTH', ['BRIDGE', false], ['BRIDGE', false]]);
  eq('PRIMARY=gas 拒絕 export 時 EXPORT_ONCE 不被消耗', props.EXPORT_ONCE, '1');
  delete props.EXPORT_ONCE;
  delete props.PRIMARY;
  eq('PRIMARY 未設定：mirror → AUTH', (await raw({ action: 'bridge', key: KEY, op: 'mirror', data: mirrorData })).code, 'AUTH');
  eq('mirror 被拒後四分頁沒動', snapshot(), sheetsBefore);

  // ===== 驗收 6、7：export 守門與內容 =====
  props.PRIMARY = 'mini';
  eq('export：EXPORT_ONCE 缺席 → AUTH', (await raw({ action: 'bridge', key: KEY, op: 'export' })).code, 'AUTH');
  props.EXPORT_ONCE = '1'; props.PRIMARY = 'gas';
  eq('export：PRIMARY=gas 即使有 EXPORT_ONCE 也 AUTH', (await raw({ action: 'bridge', key: KEY, op: 'export' })).code, 'AUTH');
  props.PRIMARY = 'mini'; props.EXPORT_ONCE = 'true';
  eq('export：EXPORT_ONCE 不是 1 → AUTH', (await raw({ action: 'bridge', key: KEY, op: 'export' })).code, 'AUTH');
  props.EXPORT_ONCE = '1';
  lockFree = false;
  eq('export：拿不到 ScriptLock → SERVER 忙碌、EXPORT_ONCE 保留', [(await raw({ action: 'bridge', key: KEY, op: 'export' })).code, props.EXPORT_ONCE], ['SERVER', '1']);
  lockFree = true;
  const adminHash = props.ADMIN_HASH; delete props.ADMIN_HASH;
  eq('export：缺 ADMIN_HASH → 拒絕、EXPORT_ONCE 保留', [(await raw({ action: 'bridge', key: KEY, op: 'export' })).code, props.EXPORT_ONCE], ['SERVER', '1']);
  props.ADMIN_HASH = adminHash; const sec = props.TOKEN_SECRET; delete props.TOKEN_SECRET;
  eq('export：缺 TOKEN_SECRET → 拒絕、EXPORT_ONCE 保留', [(await raw({ action: 'bridge', key: KEY, op: 'export' })).code, props.EXPORT_ONCE], ['SERVER', '1']);
  props.TOKEN_SECRET = sec;
  // fresh：先讓快取存著舊的同仁表，再直接改試算表（不換世代）→ export 必須讀到試算表現況
  store().getStaff();
  book.getSheetByName('同仁').data.push(['S-002', '林雅婷', 'mala', '', '', '0', '0', 'TRUE', '', '', '', '']);
  book.getSheetByName('操作紀錄').data.push(['2026-09-30T01:00:00.000Z', 'savePost', 'P-1', '新增']);
  eq('（前提）一般讀取吃快取、看不到手動加的 S-002', store().getStaff().map((s) => s.id), ['S-001']);
  hits = 0;
  const ex = await B.call('export', {});
  eq('export 成功：1 次呼叫，EXPORT_ONCE 已刪', [hits, 'EXPORT_ONCE' in props], [1, false]);
  eq('export 內含 secret 與 admin.hash（與指令碼屬性一致）', [ex.secret, ex.admin.hash, ex.admin.salt, ex.admin.ver], ['secret-xyz', 'ahash', 'asalt', 3]);
  eq('export fresh 讀取：看得到快取外的 S-002', ex.staff.map((s) => s.id), ['S-001', 'S-002']);
  eq('export 帶出公告／已讀（簽名檔 id＝Drive id）／操作紀錄', [ex.posts.map((p) => p.id), ex.reads.length, !!drive.files[ex.reads[0].sigId], ex.log], [['P-1'], 1, true, [{ at: '2026-09-30T01:00:00.000Z', action: 'savePost', target: 'P-1', summary: '新增' }]]);
  eq('export 第二次 → AUTH（一次性）', (await raw({ action: 'bridge', key: KEY, op: 'export' })).code, 'AUTH');

  // ===== 驗收 8：mirror 後試算表與 Mac mini 逐筆一致（含已讀簽名檔 id＝Drive id） =====
  // 用 M1 的 SQLite store 當「Mac mini 正本」：塞資料 → dump() → 模擬 M3 回填 driveSigId → 經 bridge.js 鏡像 → 用 GAS store 讀回比對
  const { makeSqliteStore } = require('../server/store-sqlite.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dzyb-m2-'));
  const mini = makeSqliteStore(dir);
  const demo = require('../js/demo-data.js')(G.DZYB);
  const staffIn = demo.staff.map((s, i) => ({ id: s.id, name: s.name, unit: s.unit, pinHash: s.pin ? 'h' + i : '', salt: s.pin ? 's' + i : '', pinVer: s.pin ? 1 : 0,
    fail: 0, active: i !== 3, createdAt: '2026-09-29T00:00:00.000Z', deletedAt: i === 3 ? '2026-09-30T00:00:00.000Z' : '', src: '', store: s.store }));
  const readsIn = demo.posts.slice(0, 3).flatMap((p, i) => staffIn.slice(0, 4).map((s, j) => ({ postId: p.id, staffId: s.id, name: s.name, unit: s.unit, at: '2026-09-30T0' + i + ':0' + j + ':00.000Z', sigId: p.id + '_' + s.id + '.png' })));
  mini.load({ posts: demo.posts.map((p) => Object.assign({ createdAt: '2026-09-29T00:00:00.000Z', updatedAt: '' }, p)), staff: staffIn, reads: readsIn,
    log: [{ at: '2026-09-30T01:00:00.000Z', action: 'ack', target: 'P-1', summary: '簽名' }, { at: '2026-09-30T02:00:00.000Z', action: 'savePost', target: 'P-2', summary: '' }] });
  const dump = mini.dump(); mini.close();
  const mkSig = (fid) => newFile({ name: 'sig.png', mime: 'image/png', bytes: signed(Buffer.from('簽名圖')) }, fid || props.SIG_FOLDER_ID);   // 簽名資料夾裡的真簽名檔
  dump.reads.forEach((x, i) => { x.driveSigId = i % 5 === 4 ? '' : mkSig(); });   // 每 5 筆留 1 筆「還沒回填」；回填的都是簽名資料夾裡的真檔（sigs.put 產生的）
  props.PRIMARY = 'mini';
  hits = 0;
  const full = { posts: dump.posts, staff: dump.staff, reads: dump.reads, log: dump.log };
  const mres = await B.call('mirror', { data: full });
  eq('mirror：1 次呼叫、回報四分頁筆數', [hits, mres.counts], [1, { posts: dump.posts.length, staff: dump.staff.length, reads: dump.reads.length, log: dump.log.length }]);
  const S2 = store();
  const pick = (o, ks) => ks.reduce((a, k) => (a[k] = o[k], a), {});
  const PK = ['id', 'title', 'body', 'units', 'publishOn', 'expiresOn', 'pinned', 'published', 'offOn', 'files', 'createdAt', 'updatedAt'];
  eq('mirror 後公告逐筆一致', S2.getPosts().map((p) => pick(p, PK)), dump.posts.map((p) => pick(Object.assign({ expiresOn: '', offOn: '' }, p, { units: G.DZYB.normUnits(p.units) }), PK)));
  const SK = ['id', 'name', 'unit', 'pinHash', 'salt', 'pinVer', 'fail', 'active', 'createdAt', 'deletedAt', 'src', 'store'];
  eq('mirror 後同仁逐筆一致（含停用者、雜湊）', S2.getStaff().map((s) => pick(s, SK)), dump.staff.map((s) => pick(s, SK)));
  eq('mirror 後已讀逐筆一致，簽名檔 id＝driveSigId（Drive id），沒回填的留空、不寫 Mac mini 檔名',
    S2.getReads(), dump.reads.map((x) => ({ postId: x.postId, staffId: x.staffId, name: x.name, unit: x.unit, at: x.at, sigId: x.driveSigId })));
  eq('（確認資料含未回填列）', dump.reads.some((x) => !x.driveSigId) && dump.reads.some((x) => x.driveSigId), true);
  eq('mirror 後操作紀錄逐筆一致', S2.dump().log, dump.log);
  eq('mirror 後分頁順序與名稱不變、沒有殘留暫存分頁', book.getSheets().map((s) => s.name), ['公告', '同仁', '已讀', '操作紀錄']);
  eq('mirror 後分頁凍結表頭、MIRROR_PHASE=done', [book.getSheets().map((s) => s.frozen), props.MIRROR_PHASE], [[1, 1, 1, 1], 'done']);
  eq('mirror 換世代（快取失效）', !!props.DATA_GEN, true);

  // mirror 寫到一半丟錯（已讀寫完、寫操作紀錄時逾時）→ 正式四分頁仍是上一輪的完整資料；下一輪成功並清掉殘留暫存分頁
  const good = snapshot();
  const d2 = Object.assign({}, full, { log: dump.log.concat([{ at: 'x', action: 'y', target: '', summary: '' }]) });
  throwOnWrite = '操作紀錄__鏡像中';
  eq('mirror 中途丟錯 → 回錯誤', (await raw({ action: 'bridge', key: KEY, op: 'mirror', data: d2 })).ok, false);
  eq('mirror 中途丟錯 → 正式四分頁仍是上一輪完整資料', snapshot(), good);
  eq('（殘留暫存分頁存在，正式分頁不受影響）', book.getSheets().some((s) => s.name === '已讀__鏡像中'), true);
  throwOnWrite = null;
  eq('下一輪 mirror 成功', (await raw({ action: 'bridge', key: KEY, op: 'mirror', data: d2 })).ok, true);
  eq('下一輪清掉殘留暫存分頁、操作紀錄換成新資料', [book.getSheets().map((s) => s.name), book.getSheetByName('操作紀錄').data.length], [['公告', '同仁', '已讀', '操作紀錄'], dump.log.length + 2]);
  eq('mirror 缺任一份（例如沒帶 reads）→ BAD_REQ、正式分頁不被清空', [(await raw({ action: 'bridge', key: KEY, op: 'mirror', data: { posts: [], staff: [], log: [] } })).code, book.getSheetByName('已讀').data.length], ['BAD_REQ', dump.reads.length + 1]);
  lockFree = false;
  eq('mirror 拿不到 ScriptLock → SERVER 忙碌', (await raw({ action: 'bridge', key: KEY, op: 'mirror', data: d2 })).code, 'SERVER');
  lockFree = true;
  // #13 S2：鏡像已通過 PRIMARY 檢查、正在等鎖時，Eason 回退切 PRIMARY=gas → 拿到鎖後要再確認，不能蓋
  { const before = snapshot(); onTryLock = () => { props.PRIMARY = 'gas'; };
    eq('等鎖期間 PRIMARY 改成 gas → mirror 回 AUTH、四分頁沒動', [(await raw({ action: 'bridge', key: KEY, op: 'mirror', data: d2 })).code, snapshot() === before], ['AUTH', true]);
    props.PRIMARY = 'mini'; props.EXPORT_ONCE = '1'; onTryLock = () => { props.PRIMARY = 'gas'; };
    eq('等鎖期間 PRIMARY 改成 gas → export 回 AUTH、EXPORT_ONCE 不被消耗', [(await raw({ action: 'bridge', key: KEY, op: 'export' })).code, props.EXPORT_ONCE], ['AUTH', '1']);
    delete props.EXPORT_ONCE; props.PRIMARY = 'gas'; onTryLock = () => { props.PRIMARY = 'mini'; };
    const n0 = book.getSheetByName('同仁').data.length;
    eq('寫入等鎖期間 PRIMARY 改成 mini → 鎖內再確認、回 MOVED、沒落地', [doPost({ action: 'staffAdd', name: 'x' }).code, book.getSheetByName('同仁').data.length], ['MOVED', n0]);
    props.PRIMARY = ' Mini '; eq('PRIMARY 寫成「 Mini 」也算 mini（寫入擋、mirror 收）', [doPost({ action: 'ack' }).code, (await raw({ action: 'bridge', key: KEY, op: 'mirror', data: d2 })).ok], ['MOVED', true]);
    props.PRIMARY = 'mini'; }

  // #13 S1：全空、posts／staff 少一半以上 → 拒絕（force:true 才放行）
  { const cur = d2, base = snapshot();
    eq('mirror 四份全空 → BAD_REQ、四分頁沒動', [(await raw({ action: 'bridge', key: KEY, op: 'mirror', data: { posts: [], staff: [], reads: [], log: [] } })).code, snapshot() === base], ['BAD_REQ', true]);
    eq('mirror 全空帶 force 也拒絕', (await raw({ action: 'bridge', key: KEY, op: 'mirror', force: true, data: { posts: [], staff: [], reads: [], log: [] } })).code, 'BAD_REQ');
    const halfS = Math.floor(dump.staff.length / 2) - 1, halfP = Math.floor(dump.posts.length / 2) - 1;
    eq('mirror 同仁少一半以上 → BAD_REQ、四分頁沒動', [(await raw({ action: 'bridge', key: KEY, op: 'mirror', data: Object.assign({}, cur, { staff: dump.staff.slice(0, halfS) }) })).code, snapshot() === base], ['BAD_REQ', true]);
    eq('mirror 公告少一半以上 → BAD_REQ', (await raw({ action: 'bridge', key: KEY, op: 'mirror', data: Object.assign({}, cur, { posts: dump.posts.slice(0, halfP) }) })).code, 'BAD_REQ');
    eq('mirror 剛好一半 → 接受（只擋「少一半以上」）', (await raw({ action: 'bridge', key: KEY, op: 'mirror', data: Object.assign({}, cur, { staff: dump.staff.slice(0, Math.ceil(dump.staff.length / 2)) }) })).ok, true);
    await B.call('mirror', { data: cur });
    eq('mirror 少一半以上帶 force:true → 放行', [(await raw({ action: 'bridge', key: KEY, op: 'mirror', force: true, data: Object.assign({}, cur, { staff: dump.staff.slice(0, 1) }) })).ok, book.getSheetByName('同仁').data.length], [true, 2]);
    eq('force 必須是 true（字串 "true" 不算）', (await raw({ action: 'bridge', key: KEY, op: 'mirror', force: 'true', data: Object.assign({}, cur, { staff: [] }) })).code, 'BAD_REQ');
    await B.call('mirror', { data: cur, force: true }); }

  // #13 S6：已讀比現有少一筆就拒絕（不會被硬刪），force:true 才放行
  { const base = snapshot();
    eq('mirror reads:[]（posts／staff 正常）→ BAD_REQ、已讀沒被洗掉', [(await raw({ action: 'bridge', key: KEY, op: 'mirror', data: Object.assign({}, d2, { reads: [] }) })).code, snapshot() === base], ['BAD_REQ', true]);
    eq('mirror 已讀少 1 筆 → BAD_REQ', (await raw({ action: 'bridge', key: KEY, op: 'mirror', data: Object.assign({}, d2, { reads: d2.reads.slice(1) }) })).code, 'BAD_REQ');
    eq('mirror 已讀多 1 筆 → 接受', (await raw({ action: 'bridge', key: KEY, op: 'mirror', data: Object.assign({}, d2, { reads: d2.reads.concat([{ postId: 'P-X', staffId: 'S-001', name: 'a', unit: 'mala', at: 't', driveSigId: '' }]) }) })).ok, true);
    eq('mirror 已讀少帶 force:true → 放行', [(await raw({ action: 'bridge', key: KEY, op: 'mirror', force: true, data: Object.assign({}, d2, { reads: d2.reads.slice(2) }) })).ok, book.getSheetByName('已讀').data.length], [true, d2.reads.length - 1]);
    await B.call('mirror', { data: d2 });
    // 第 3 輪建議 2：操作紀錄也只增不減——log:[]、少一筆不重複的 → 拒絕；重複列不算；force:true 才放行
    const lb = snapshot();
    eq('mirror log:[]（其他正常）→ BAD_REQ、操作紀錄沒被洗掉', [(await raw({ action: 'bridge', key: KEY, op: 'mirror', data: Object.assign({}, d2, { log: [] }) })).code, snapshot() === lb], ['BAD_REQ', true]);
    eq('mirror 操作紀錄少 1 筆（用重複列湊數也不算）→ BAD_REQ', (await raw({ action: 'bridge', key: KEY, op: 'mirror', data: Object.assign({}, d2, { log: d2.log.slice(1).concat([d2.log[1]]) }) })).code, 'BAD_REQ');
    eq('mirror 操作紀錄少帶 force:true → 放行', [(await raw({ action: 'bridge', key: KEY, op: 'mirror', force: true, data: Object.assign({}, d2, { log: d2.log.slice(1) }) })).ok, book.getSheetByName('操作紀錄').data.length], [true, d2.log.length]);
    await B.call('mirror', { data: d2 });
    // M3 審查 S6：比「不重複 (postId, staffId)、非空白」的列數。分頁有 2 列重複＋1 列空白時，送去重後的資料要接受；真的少一筆不重複的要拒絕
    const sh = book.getSheetByName('已讀'); sh.data.push(sh.data[1].slice(), sh.data[2].slice(), ['', '', '', '', '', '']); bumpGen();
    eq('（前提）已讀分頁原始列數比 Mac mini 多 3', sh.data.length - 1, d2.reads.length + 3);
    eq('分頁有重複／空白已讀列：送去重後的資料 → 接受', (await raw({ action: 'bridge', key: KEY, op: 'mirror', data: d2 })).ok, true);
    sh.data.push(sh.data[1].slice()); bumpGen();
    eq('分頁有重複列、但真的少一筆不重複的已讀 → 拒絕', (await raw({ action: 'bridge', key: KEY, op: 'mirror', data: Object.assign({}, d2, { reads: d2.reads.slice(1).concat([d2.reads[2]]) }) })).code, 'BAD_REQ');
    const st = book.getSheetByName('同仁'), stn = st.data.length - 1; const orig = st.data.slice(1).map((r) => r.slice()); st.data.push(...orig.map((r) => r.slice()), ...orig.map((r) => r.slice())); bumpGen();   // 同仁分頁整份重複兩次（原始列數 ×3，比原始列數會被「少一半以上」擋下）
    eq('同仁分頁整份重複（原始列數 ×3）：送去重後的資料 → 接受（posts／staff 也比不重複 id）', [stn, (await raw({ action: 'bridge', key: KEY, op: 'mirror', data: d2 })).ok], [d2.staff.length, true]); }

  // #13 N1：mirror 只接受「分頁既有」或「目前簽名資料夾裡的圖」當簽名檔 id；否則整份拒絕，回條也讀不出雲端硬碟的其他檔案
  { const base = snapshot(), legacyDir = newFolder('舊簽名資料夾', 'ROOT');
    const inject = async (id) => (await raw({ action: 'bridge', key: KEY, op: 'mirror', data: Object.assign({}, d2, { reads: d2.reads.map((r, i) => (i === 0 ? Object.assign({}, r, { driveSigId: id }) : r)) }) })).code;
    eq('mirror 注入根目錄試算表／PDF／不在簽名資料夾的圖／簽名資料夾裡的 PDF／不存在的 id → 全部 BAD_REQ',
      [await inject(sheetLike), await inject(other), await inject(rootPng), await inject(sigPdf), await inject(mkSig(legacyDir)), await inject('G-不存在')], ['BAD_REQ', 'BAD_REQ', 'BAD_REQ', 'BAD_REQ', 'BAD_REQ', 'BAD_REQ']);
    eq('注入被拒後四分頁沒動', snapshot(), base);
    eq('bridge.js 看到的是業務錯誤 BAD_REQ（M3 會記 fail）', await biz(B.call('mirror', { data: Object.assign({}, d2, { reads: [Object.assign({}, d2.reads[0], { driveSigId: other })].concat(d2.reads.slice(1)) }) })), ['BAD_REQ', true]);
    // 就算分頁被人手動改成非圖檔的 id，GAS 自己的回條（receipts→getSigs→readSig）也只回 PNG／JPEG
    const sh = book.getSheetByName('已讀'), r0 = sh.data[1].slice(), r1 = sh.data[2].slice();
    const postOf = r0[0]; sh.data[1][5] = sheetLike; sh.data[2][5] = other;
    const au = vm.runInContext('makeAuth_(gasCrypto_(), DZYB)', G), atok = au.makeAdminToken(props.TOKEN_SECRET, props.ADMIN_VER, Date.now() + 3600e3);
    props.PRIMARY = 'gas'; bumpGen();
    const rc = doPost({ action: 'receipts', atoken: atok, postId: postOf });
    const sigOf = (sid) => (rc.data.rows.find((x) => x.staffId === sid) || {}).sig;
    eq('receipts：分頁上的非圖檔 id → sig 是 null（試算表、PDF 都讀不出）', [rc.ok, sigOf(r0[1]), sigOf(r1[1])], [true, null, null]);
    sh.data[1] = r0; sh.data[2] = r1; bumpGen();
    eq('receipts：正常簽名照常讀得到', doPost({ action: 'receipts', atoken: atok, postId: postOf }).data.rows.find((x) => x.staffId === r0[1]).sig, png);
    props.PRIMARY = 'mini'; }

  // #13 S3＋S5：資料夾重建過的舊簽名（分頁既有 id）第一次鏡像後不會消失，sig／sigs.get 也搬得走；不在分頁的舊資料夾檔案仍是 null
  { const oldDir = newFolder('簽名（重建前）', props.FOLDER_ID), o1 = mkSig(oldDir), o2 = mkSig(oldDir), stranger = mkSig(oldDir);
    const pre = [{ postId: 'P-OLD', staffId: 'S-001', name: '陳大安', unit: 'mala', at: '2026-09-29T00:00:00.000Z', sigId: o1 },
      { postId: 'P-OLD', staffId: 'S-002', name: '林雅婷', unit: 'mala', at: '2026-09-29T00:00:00.000Z', sigId: o2 }];
    const sh = book.getSheetByName('已讀'); sh.data = [G.SHEETS_.reads.head.slice()].concat(pre.map((r) => G.SHEETS_.reads.cols.map((c) => r[c]))); bumpGen();   // 模擬 GAS 時代留下的已讀
    const gg = await B.call('sigs', { get: [o1, o2, stranger] });
    eq('S5：sigs.get 放行分頁既有的舊資料夾簽名、不在分頁的舊資料夾檔案仍是 null', [gg.sigs[o1], gg.sigs[o2], gg.sigs[stranger], await B.call('sig', { id: o1 }), await B.call('sig', { id: stranger })], [png, png, null, png, null]);
    // Mac mini 端：搬遷後 SQLite 只有 sigId（本機檔名）、driveSigId 還沒回填；一筆改成新回填的；另有一筆 Mac mini 新簽的已回填
    const changed = mkSig(), fresh = mkSig();
    const minis = pre.map((r) => Object.assign({}, r, { sigId: r.postId + '_' + r.staffId + '.png' })).concat([{ postId: 'P-NEW', staffId: 'S-001', name: '陳大安', unit: 'mala', at: '2026-09-30T00:00:00.000Z', sigId: 'P-NEW_S-001.png', driveSigId: fresh }]);
    minis[1].driveSigId = changed;
    await B.call('mirror', { data: Object.assign({}, d2, { reads: minis }) });
    eq('S3：第一次鏡像後舊簽名 Drive id 保留、有新值就用新值、Mac mini 檔名不會寫進來', store().getReads().map((r) => r.sigId), [o1, changed, fresh]);
    await B.call('mirror', { data: Object.assign({}, d2, { reads: minis.map((r) => Object.assign({}, r, { driveSigId: '' })) }) });
    eq('S3：再鏡像一次（全部沒帶 driveSigId）id 仍在', store().getReads().map((r) => r.sigId), [o1, changed, fresh]);
    eq('S3：分頁既有的舊資料夾 id 可以原樣再送（不被 N1 擋）', (await raw({ action: 'bridge', key: KEY, op: 'mirror', data: Object.assign({}, d2, { reads: minis.map((r, i) => Object.assign({}, r, { driveSigId: [o1, changed, fresh][i] })) }) })).ok, true);
    await B.call('mirror', { data: d2, force: true }); }

  // 建議 3＋S7：換名的進度寫進 MIRROR_PHASE，heal 依標記還原（沒做完）或往前完成（只差刪備份）
  { const base = snapshot(); failRename = '同仁';                 // 第二張（同仁）的暫存分頁改成正式名稱時丟錯
    eq('換名中途失敗 → 回錯誤', (await raw({ action: 'bridge', key: KEY, op: 'mirror', data: Object.assign({}, d2, { log: d2.log.concat([{ at: 'fail', action: 'round', target: '', summary: '' }]) }) })).ok, false);
    eq('換名中途失敗 → 四個正式分頁都在且是上一輪資料、沒有「__上一輪」殘留、標記回 done', [snapshot() === base, book.getSheets().filter((x) => /__上一輪$/.test(x.name)).length, props.MIRROR_PHASE], [true, 0, 'done']);
    eq('換名失敗後 GAS roster 照常', doPost({ action: 'roster' }).ok, true);
    // 換名成功、刪「同仁__上一輪」時中斷兩次（mirror 本身與 catch 內的 heal 都失敗）→ 標記停在 tmp_renamed；手動 heal 往前完成、不改資料
    failDelete = { name: '同仁__上一輪', n: 2 };
    const d3 = Object.assign({}, d2, { log: d2.log.concat([{ at: 'new', action: 'round', target: '', summary: '' }]) });
    eq('刪備份時中斷 → 回錯誤、標記停在 tmp_renamed', [(await raw({ action: 'bridge', key: KEY, op: 'mirror', data: d3 })).ok, props.MIRROR_PHASE], [false, 'tmp_renamed']);
    const mid = snapshot();
    eq('（前提）四張正式分頁都是新一輪、還留著「同仁__上一輪」', [book.getSheetByName('操作紀錄').data.slice(-1)[0][1], !!book.getSheetByName('同仁__上一輪')], ['round', true]);
    eq('手動 mirrorHeal()：往前完成（只刪備份、四分頁資料不變）', [vm.runInContext('mirrorHeal_(ss_())', G), snapshot() === mid, book.getSheets().map((x) => x.name), props.MIRROR_PHASE], ['forward', true, ['公告', '同仁', '已讀', '操作紀錄'], 'done']);
    // 第 3 輪建議 4：手動 mirrorHeal() 先拿 ScriptLock，拿不到（鏡像正在換名）就回報 busy、不動分頁
    book.getSheetByName('同仁').setName('同仁__上一輪'); props.MIRROR_PHASE = 'backup_renamed'; const all = () => JSON.stringify(book.getSheets().map((x) => [x.name, x.data])), hb = all(), hn = book.getSheets().map((x) => x.name);
    lockFree = false;
    eq('mirrorHeal() 拿不到鎖 → busy、分頁與標記都沒動', [vm.runInContext('mirrorHeal()', G), all() === hb, book.getSheets().map((x) => x.name), props.MIRROR_PHASE, logged.slice(-1)[0]], ['busy', true, hn, 'backup_renamed', '鏡像進行中，稍後再試']);
    lockFree = true;
    eq('mirrorHeal() 拿到鎖 → 依標記還原', [vm.runInContext('mirrorHeal()', G), book.getSheets().map((x) => x.name).sort().join(), props.MIRROR_PHASE], ['restore', ['公告', '同仁', '已讀', '操作紀錄'].sort().join(), 'done']);
    // 同樣的中斷狀態，下一輪鏡像先 heal（往前完成）、接著被防呆擋下 → 分頁仍一致是新一輪，不會混合
    failDelete = { name: '同仁__上一輪', n: 2 };
    await raw({ action: 'bridge', key: KEY, op: 'mirror', data: Object.assign({}, d3, { log: d3.log.concat([{ at: 'new2', action: 'round2', target: '', summary: '' }]) }) });
    const mid2 = snapshot();
    eq('下一輪先 heal 再被防呆擋：分頁一致是上一輪成功換上的資料', [(await raw({ action: 'bridge', key: KEY, op: 'mirror', data: Object.assign({}, d3, { reads: [] }) })).code, book.getSheetByName('操作紀錄').data.slice(-1)[0][1], book.getSheets().map((x) => x.name), snapshot() === mid2], ['BAD_REQ', 'round2', ['公告', '同仁', '已讀', '操作紀錄'], true]);
    // 還原路徑：換名做到一半（標記 renaming、同仁已改成「__上一輪」）→ 下一輪開頭整組還原後成功
    book.getSheetByName('同仁').setName('同仁__上一輪'); props.MIRROR_PHASE = 'renaming';
    eq('（前提）正式同仁分頁不見', book.getSheetByName('同仁'), null);   // 下一行帶 force：前面幾輪的操作紀錄比 d2 多
    eq('下一輪 mirror 開頭自我修復後成功', [(await raw({ action: 'bridge', key: KEY, op: 'mirror', force: true, data: d2 })).ok, book.getSheets().map((x) => x.name)], [true, ['公告', '同仁', '已讀', '操作紀錄']]); }

  eq('鏡像後重寫公開名單快照（只有遮罩姓名）', [snapSheet.data.length - 1, snapSheet.data.slice(1).every((r) => r[1].includes('O') || r[1].length <= 2), JSON.stringify(snapSheet.data).includes('h1')], [d2.staff.filter((x) => x.active).length, true, false]);
  // 鏡像後回退（PRIMARY=gas）：GAS 的 readSig 讀得到鏡像寫回的 Drive id（用上面 sigs 上傳得到的真 id）
  await B.call('mirror', { data: Object.assign({}, d2, { reads: [Object.assign({}, dump.reads[0], { driveSigId: up.ids[0] })].concat(d2.reads.slice(1)) }), force: true });
  props.PRIMARY = 'gas';
  eq('回退後 GAS 用鏡像的簽名檔 id 讀得到簽名圖', store().getSigs(dump.reads[0].postId)[dump.reads[0].staffId], png);

  // ===== 驗收 9：備份檔落在獨立備份資料夾、分享狀態為「限制」 =====
  const zlib = require('zlib'), b64 = zlib.gzipSync(Buffer.from('gzip-bytes')).toString('base64');
  props.BACKUP_FOLDER_ID = vm.runInContext('attachFolder_()', G).createFolder('備份').getId();   // 模擬舊草稿：備份資料夾在附件資料夾底下
  drive.folders[props.BACKUP_FOLDER_ID].sharing = 'ANYONE_WITH_LINK';
  const oldFolder = props.BACKUP_FOLDER_ID;
  const bk = await B.call('backup', { name: 'dzyb-2026-09-30.db.gz', data: b64 });
  const bf = drive.files[bk.id], bfo = drive.folders[bf.parent];
  eq('備份：不在附件資料夾底下，改建在雲端硬碟根目錄的獨立資料夾', [bf.parent !== oldFolder, bfo.parent, bfo.name, props.BACKUP_FOLDER_ID === bf.parent], [true, 'ROOT', '鼎兆元｜電子佈告欄備份', true]);
  eq('備份：檔案與資料夾分享狀態都是「限制」', [bf.sharing, bfo.sharing], ['PRIVATE', 'PRIVATE']);
  eq('備份：內容與檔名', [zlib.gunzipSync(Buffer.from(bf.bytes.map((x) => x & 255))).toString(), bf.name, bf.mime], ['gzip-bytes', 'dzyb-2026-09-30.db.gz', 'application/gzip']);
  drive.folders[bf.parent].sharing = 'ANYONE_WITH_LINK';          // 有人把備份資料夾分享出去 → 下次備份時收回
  const oldId = newFile({ name: 'old.gz', mime: 'application/gzip', bytes: [1] }, bf.parent); drive.files[oldId].created = Date.now() - 31 * 86400e3;
  const bk2 = await B.call('backup', { name: '../../evil name.gz', data: b64 });
  eq('備份：資料夾被分享出去時收回成「限制」、超過 30 天的舊檔丟垃圾桶', [drive.folders[bf.parent].sharing, drive.files[oldId].trashed, bk2.trashed], ['PRIVATE', true, 1]);
  eq('備份：檔名去掉路徑字元', drive.files[bk2.id].name, '.._.._evil_name.gz');
  eq('備份：回報個別共用者人數（沒人＝0）', bk2.sharedWith, 0);
  drive.folders[bf.parent].editors = ['someone@example.com'];
  eq('備份：資料夾有個別共用者時回報人數（M3 標黃）', (await B.call('backup', { name: 'b.gz', data: b64 })).sharedWith, 1);
  // 第 3 輪建議 1：backup 只收 .gz（檔名＋magic bytes 1f 8b）、單檔 ≤ 14MB，其他一律 BAD_REQ、不建檔
  { const nf = Object.keys(drive.files).length, bkr = async (name, data) => (await raw({ action: 'bridge', key: KEY, op: 'backup', name, data })).code;
    eq('備份：檔名不是 .gz → BAD_REQ', [await bkr('x.db', b64), await bkr('x.gz.exe', b64), await bkr('x.zip', b64)], ['BAD_REQ', 'BAD_REQ', 'BAD_REQ']);
    eq('備份：檔名 .gz 但內容不是 gzip → BAD_REQ', [await bkr('x.gz', Buffer.from('not gzip').toString('base64')), await bkr('x.gz', Buffer.from([0x1f]).toString('base64')), await bkr('x.gz', Buffer.from([0x1f, 0x00, 1, 2]).toString('base64')), await bkr('x.gz', Buffer.from([0x00, 0x8b, 1, 2]).toString('base64'))], ['BAD_REQ', 'BAD_REQ', 'BAD_REQ', 'BAD_REQ']);
    const big = Buffer.alloc(14 * 1024 * 1024 + 16); big[0] = 0x1f; big[1] = 0x8b;
    eq('備份：超過 14MB → BAD_REQ；剛好 14MB → 接受', [await bkr('big.gz', big.toString('base64')), (await raw({ action: 'bridge', key: KEY, op: 'backup', name: 'ok.gz', data: big.subarray(0, 14 * 1024 * 1024).toString('base64') })).ok], ['BAD_REQ', true]);
    eq('備份：被拒的都沒有建檔（只多了剛好 14MB 那一個）', Object.keys(drive.files).length, nf + 1); }
  eq('備份：空內容 → BAD_REQ', (await raw({ action: 'bridge', key: KEY, op: 'backup', name: 'x.gz', data: '' })).code, 'BAD_REQ');

  // ===== 其他 op 與 bridge.js 格式對齊（upload／share／revoke／clock／sig） =====
  const pdf = Buffer.from('%PDF-1.4').toString('base64');
  const u = await B.files.upload('a.pdf', 'application/pdf', pdf);
  eq('upload：回 {id,name,type,size}、放在附件資料夾', [u.name, u.type, drive.files[u.id].parent === props.FOLDER_ID], ['a.pdf', 'pdf', true]);
  await B.files.share([u.id]);
  eq('share：附件改成知道連結者可看', drive.files[u.id].sharing, 'ANYONE_WITH_LINK');
  await B.files.revoke([u.id]);
  eq('R1：revoke 後再 share → BAD_REQ、分享狀態維持 PRIVATE（已撤銷的附件不能重新公開）', [(await raw({ action: 'bridge', key: KEY, op: 'share', ids: [u.id] })).code, drive.files[u.id].sharing], ['BAD_REQ', 'PRIVATE']);
  eq('R1：垃圾桶裡的附件再 revoke 不出錯（吞掉）、狀態不變', [await B.files.revoke([u.id]), drive.files[u.id].sharing, drive.files[u.id].trashed], [undefined, 'PRIVATE', true]);
  // 第 3 輪建議 1：upload 與 Service.uploadFile 同一套規則（DZYB.fileType／MAX_BYTES），mime 依副檔名
  { const upr = async (name, data, mime) => (await raw({ action: 'bridge', key: KEY, op: 'upload', name, mime: mime || 'application/pdf', data })).code, nf = Object.keys(drive.files).length;
    eq('upload：x.html／a.exe／沒有副檔名 → BAD_REQ', [await upr('x.html', pdf, 'text/html'), await upr('a.exe', pdf), await upr('noext', pdf)], ['BAD_REQ', 'BAD_REQ', 'BAD_REQ']);
    const big = Buffer.alloc(20 * 1024 * 1024 + 16).toString('base64');
    eq('upload：超過 20MB → BAD_REQ；空檔 → BAD_REQ', [await upr('big.pdf', big), await upr('empty.pdf', '')], ['BAD_REQ', 'BAD_REQ']);
    eq('upload：被拒的都沒有建檔', Object.keys(drive.files).length, nf);
    const w = await B.files.upload('報告.docx', 'text/html', pdf);
    eq('upload：mime 一律依副檔名（呼叫端送 text/html 也存成 docx 的 mime）', [w.type, drive.files[w.id].mime], ['docx', G.DZYB.fileMime('報告.docx')]);
    eq('upload：剛好 20MB 的 xlsx → 接受', (await raw({ action: 'bridge', key: KEY, op: 'upload', name: 'a.xlsx', mime: '', data: Buffer.alloc(20 * 1024 * 1024).toString('base64') })).ok, true); }
  eq('revoke：收回分享並丟垃圾桶', [drive.files[u.id].sharing, drive.files[u.id].trashed], ['PRIVATE', true]);
  eq('share 簽名圖（不是附件）→ BAD_REQ', (await raw({ action: 'bridge', key: KEY, op: 'share', ids: [up.ids[0]] })).code, 'BAD_REQ');
  eq('clock：沒設打卡來源時回空名單＋提示', (await B.clockSrc.read()).errors, ['未設定打卡來源']);
  eq('sig：單張讀回', await B.call('sig', { id: up.ids[1] }), png);

  // ===== M7（#18）：fileget／filelist 只回附件資料夾直屬、白名單 mime 的檔（含垃圾桶）；ours() 不放寬 =====
  { const attach = props.FOLDER_ID, fg = (id, off, len, extra) => raw(Object.assign({ action: 'bridge', key: KEY, op: 'fileget', id, off: off === undefined ? 0 : off, len: len === undefined ? 8 * 1024 * 1024 : len }, extra || {}));
    const md5 = (bytes) => crypto.createHash('md5').update(Buffer.from(bytes.map((b) => b & 255))).digest('hex');
    const live = await B.files.upload('M7附件.pdf', 'application/pdf', Buffer.from('%PDF-1.4 M7 live 0123456789').toString('base64'));
    const gone = await B.files.upload('M7已移除.docx', '', Buffer.from('docx bytes removed').toString('base64'));
    await B.files.revoke([gone.id]);
    eq('（前提）已移除的附件在垃圾桶', drive.files[gone.id].trashed, true);
    const ssPdf = newFile({ name: '正本試算表（假裝 PDF）', mime: 'application/pdf', bytes: [1] }, attach);   // id 設成 SPREADSHEET_ID：驗「排除正本試算表」這一道
    const gdoc = newFile({ name: 'Google 文件', mime: 'application/vnd.google-apps.document', bytes: [2] }, attach);
    const jpg = newFile({ name: '手動放的照片.jpg', mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff, 3] }, attach);
    const otherFolder = newFolder('其他系統資料夾', 'ROOT'), otherPdf = newFile({ name: '別的資料夾.pdf', mime: 'application/pdf', bytes: [4] }, otherFolder);
    const rootAttach = newFile({ name: '根目錄.pdf', mime: 'application/pdf', bytes: [5] }, 'ROOT');
    const gz = bk.id;                                                   // 備份 .gz（獨立備份資料夾）
    const sigImg = up.ids[0];                                           // 簽名圖（附件資料夾的子資料夾「簽名」）
    const ss0 = props.SPREADSHEET_ID; props.SPREADSHEET_ID = ssPdf;
    const outside = { 正本試算表: ssPdf, 簽名圖: sigImg, 備份gz: gz, 根目錄檔: other, 根目錄PDF: rootAttach, 其他資料夾PDF: otherPdf, Google文件: gdoc, 手動JPG: jpg, 不存在: 'G-nope' };
    const got = {}; for (const k of Object.keys(outside)) got[k] = (await fg(outside[k])).data;
    eq('fileget：範圍外一律 file:null（正本試算表、簽名圖、備份 .gz、根目錄、其他資料夾 PDF、Google 文件、手動 JPG、不存在）', got, Object.fromEntries(Object.keys(outside).map((k) => [k, { file: null }])));
    const g1 = (await fg(live.id)).data;
    eq('fileget：附件資料夾裡的 PDF 讀得到（位元組、md5＝Drive md5Checksum、eof）', [Buffer.from(g1.data, 'base64').toString(), g1.file.md5, g1.file.md5 === md5(drive.files[live.id].bytes), g1.file.size, g1.eof, g1.file.trashed, g1.file.mime, g1.off],
      ['%PDF-1.4 M7 live 0123456789', md5(drive.files[live.id].bytes), true, 27, true, false, 'application/pdf', 0]);
    const g2 = (await fg(gone.id)).data;
    eq('fileget：垃圾桶內的附件讀得到、trashed:true', [Buffer.from(g2.data, 'base64').toString(), g2.file.trashed, g2.file.name], ['docx bytes removed', true, 'M7已移除.docx']);
    const parts = [(await fg(live.id, 0, 10)).data, (await fg(live.id, 10, 10)).data, (await fg(live.id, 20, 10)).data];
    eq('fileget 分段：off／len 切片、最後一段 eof、合起來＝原檔', [parts.map((x) => [x.off, Buffer.from(x.data, 'base64').length, x.eof]), Buffer.concat(parts.map((x) => Buffer.from(x.data, 'base64'))).toString()],
      [[[0, 10, false], [10, 10, false], [20, 7, true]], '%PDF-1.4 M7 live 0123456789']);
    eq('fileget：off 超過檔案大小 → 空資料、eof', [(await fg(live.id, 999, 10)).data.data, (await fg(live.id, 999, 10)).data.eof], ['', true]);
    eq('fileget／filelist 回應不含範圍外檔名', /假裝|照片|別的資料夾|根目錄\.pdf/.test(JSON.stringify(Object.values(got))), false);
    const fl = (await raw({ action: 'bridge', key: KEY, op: 'filelist' })).data;
    const ids = fl.files.map((x) => x.id);
    eq('filelist：只列附件資料夾直屬的白名單附件（含垃圾桶），範圍外一律不列', [ids.includes(live.id), ids.includes(gone.id), Object.values(outside).filter((id) => ids.includes(id))], [true, true, []]);
    eq('filelist：每筆帶 id／name／mime／size／md5／trashed、不含位元組', [Object.keys(fl.files.find((x) => x.id === gone.id)).sort(), fl.files.find((x) => x.id === gone.id).trashed, fl.files.find((x) => x.id === live.id).md5 === md5(drive.files[live.id].bytes), fl.nextPageToken],
      [['createdTime', 'id', 'md5', 'mime', 'name', 'size', 'trashed'], true, true, '']);
    props.SPREADSHEET_ID = ss0;
    // 分頁：pageToken 原樣往下帶；附件資料夾塞到超過一頁（pageSize 200）
    const many = Array.from({ length: 205 }, (_, i) => newFile({ name: 'm' + i + '.pdf', mime: 'application/pdf', bytes: [i & 127] }, attach));
    const p1 = (await raw({ action: 'bridge', key: KEY, op: 'filelist' })).data, p2 = (await raw({ action: 'bridge', key: KEY, op: 'filelist', pageToken: p1.nextPageToken })).data;
    eq('filelist 分頁：第一頁 200 個＋nextPageToken、第二頁接著列完', [p1.files.length <= 200, !!p1.nextPageToken, many.every((id) => p1.files.concat(p2.files).some((x) => x.id === id)), p2.nextPageToken], [true, true, true, '']);
    many.forEach((id) => { delete drive.files[id]; });
    // 金鑰與參數：金鑰問題一律 AUTH（先於參數檢查）；參數錯 BAD_REQ
    const au = (extra) => raw(Object.assign({ action: 'bridge', op: 'fileget', id: live.id, off: 0, len: 10 }, extra)).then((r) => r.code);
    eq('fileget／filelist：沒有金鑰／金鑰錯／key 不是字串 → AUTH', [await au({}), await au({ key: 'x'.repeat(40) }), await au({ key: [KEY] }), await au({ key: { k: KEY } }), await au({ key: 'bad', off: -1 }),
      (await raw({ action: 'bridge', op: 'filelist' })).code, (await raw({ action: 'bridge', key: 'z'.repeat(40), op: 'filelist' })).code, (await raw({ action: 'bridge', key: 1, op: 'filelist' })).code], ['AUTH', 'AUTH', 'AUTH', 'AUTH', 'AUTH', 'AUTH', 'AUTH', 'AUTH']);
    const br = async (id, off, len) => (await fg(id, off, len)).code;
    eq('fileget：off<0、len>8MB、len≤0、非整數、id 含非法字元或不是字串 → BAD_REQ', [await br(live.id, -1, 10), await br(live.id, 0, 8 * 1024 * 1024 + 1), await br(live.id, 0, 0), await br(live.id, 0, -5), await br(live.id, 1.5, 10), await br(live.id, '0', 10),
      await br('../' + live.id, 0, 10), await br('a/b', 0, 10), await br('a.b', 0, 10), await br('', 0, 10), (await raw({ action: 'bridge', key: KEY, op: 'fileget', id: 123, off: 0, len: 10 })).code, (await raw({ action: 'bridge', key: KEY, op: 'filelist', pageToken: { x: 1 } })).code],
      ['BAD_REQ', 'BAD_REQ', 'BAD_REQ', 'BAD_REQ', 'BAD_REQ', 'BAD_REQ', 'BAD_REQ', 'BAD_REQ', 'BAD_REQ', 'BAD_REQ', 'BAD_REQ', 'BAD_REQ']);
    eq('fileget：len 剛好 8MB 可以', (await fg(live.id, 0, 8 * 1024 * 1024)).ok, true);
    const pr0 = props.PRIMARY;
    props.PRIMARY = 'gas'; const a1 = [(await fg(live.id)).ok, (await raw({ action: 'bridge', key: KEY, op: 'filelist' })).ok];
    props.PRIMARY = 'mini'; const a2 = [(await fg(live.id)).ok, (await raw({ action: 'bridge', key: KEY, op: 'filelist' })).ok];
    props.PRIMARY = pr0;
    eq('fileget／filelist 不受 PRIMARY 限制（gas／mini 都能讀）', [a1, a2], [[true, true], [true, true]]);
    eq('bridge.js 客戶端：files.get／files.list 對得上 op 格式', [Buffer.from((await B.files.get(live.id, 0, 4)).data, 'base64').toString(), (await B.files.list()).files.some((x) => x.id === gone.id)], ['%PDF', true]);
    // ours() 不放寬：share 對垃圾桶內的附件仍 BAD_REQ（M2 R1）
    eq('ours() 不變：share 垃圾桶內的附件 → BAD_REQ、仍是 PRIVATE', [(await raw({ action: 'bridge', key: KEY, op: 'share', ids: [gone.id] })).code, drive.files[gone.id].sharing], ['BAD_REQ', 'PRIVATE']);
    eq('ours() 不變：share 正常附件照常', [(await raw({ action: 'bridge', key: KEY, op: 'share', ids: [live.id] })).ok, drive.files[live.id].sharing], [true, 'ANYONE_WITH_LINK']);
    // 垃圾桶 30 天後永久刪除：fileget 回 null、filelist 看不到
    delete drive.files[gone.id];
    eq('Drive 永久刪除後：fileget file:null、filelist 不列', [(await fg(gone.id)).data, (await raw({ action: 'bridge', key: KEY, op: 'filelist' })).data.files.some((x) => x.id === gone.id)], [{ file: null }, false]);
    // 讀取路徑不建資料夾：FOLDER_ID 遺失時 fileget null、filelist 空、沒有新建資料夾
    const fid0 = props.FOLDER_ID, nf = Object.keys(drive.folders).length; delete props.FOLDER_ID;
    eq('FOLDER_ID 遺失：fileget null、filelist 空、不建資料夾', [(await fg(live.id)).data, (await raw({ action: 'bridge', key: KEY, op: 'filelist' })).data.files, Object.keys(drive.folders).length, 'FOLDER_ID' in props], [{ file: null }, [], nf, false]);
    props.FOLDER_ID = fid0; }

  // ===== 純函式：movedGate_ =====
  const gate = vm.runInContext('movedGate_', G);
  eq('movedGate_：只在 mini 擋寫入', [gate('ack', 'mini') && gate('ack', 'mini').code, gate('board', 'mini'), gate('ack', 'gas'), gate('ack', null), gate('ack', 'MINI') && 'MOVED', gate('ack', 'mini2')], ['MOVED', null, null, null, 'MOVED', null]);

  srv.close(); fs.rmSync(dir, { recursive: true, force: true });
  console.log(`bridge: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('✗ 執行中斷', e); process.exit(1); });
