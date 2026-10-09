/* 鼎兆元｜電子佈告欄 — 試算表讀寫（Service.js 的 store 介面）
 * 四個分頁全部設成純文字格式（setup 時），避免日期被 Sheets 自動轉型；讀取時仍防呆轉回字串。 */
'use strict';

var SHEETS_ = {
  posts: { name: '公告', cols: ['id', 'title', 'body', 'units', 'publishOn', 'expiresOn', 'pinned', 'published', 'offOn', 'files', 'createdAt', 'updatedAt'],
    head: ['id', '標題', '內容', '單位', '上架日', '到期日', '置頂', '上架中', '手動下架日', '附件', '建立時間', '最後修改時間'] },
  // lineHash（2026-10-09，LINE 自動登入）：欄位只能加在最後、不可重排；沒有這一欄的舊表讀到空字串（write 會自動補表頭）
  staff: { name: '同仁', cols: ['id', 'name', 'unit', 'pinHash', 'salt', 'pinVer', 'fail', 'active', 'createdAt', 'deletedAt', 'src', 'store', 'lineHash'],
    head: ['id', '姓名', '單位', '密碼雜湊', 'salt', '密碼版本', '連續錯誤次數', '在職', '建立時間', '刪除時間', '來源（打卡系統）', '門市', 'LINE 綁定（雜湊）'] },
  // 名單快照欄位定義（寫在獨立的公開名單試算表，見 snapBook_；setup 不在主試算表建這個分頁）
  snap: { name: '名單快照', cols: ['id', 'name', 'unit', 'store', 'hasPin', 'locked'], head: ['id', 'name', 'unit', 'store', 'hasPin', 'locked'] },
  reads: { name: '已讀', cols: ['postId', 'staffId', 'name', 'unit', 'at', 'sigId'],
    head: ['公告 id', '同仁 id', '姓名', '單位', '簽名時間', '簽名檔 id'] },
  log: { name: '操作紀錄', cols: ['at', 'action', 'target', 'summary'], head: ['時間', '動作', '對象', '摘要'] }
};

function props_() { return PropertiesService.getScriptProperties(); }
function ss_() {
  var id = props_().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('尚未執行 setup()');
  return SpreadsheetApp.openById(id);
}
function cellStr_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Taipei', 'yyyy-MM-dd');
  return v === null || v === undefined ? '' : String(v);
}
function bool_(v) { return v === true || String(v).toUpperCase() === 'TRUE'; }

/* 讀取快取：Apps Script 冷啟動＋開試算表常要數秒。資料讀過就放 CacheService，
 * 鍵名帶「資料世代」DATA_GEN，任何寫入就把世代 +1，舊快取自然失效（不會讀到過期資料）。 */
var CACHE_TTL_ = 600, CACHE_CHUNK_ = 30000;   // CacheService 單值上限 100KB 以位元組計，中文一字 3 bytes
function dataGen_() { return props_().getProperty('DATA_GEN') || '0'; }
function bumpGen_() {
  var v = Date.now() + '-' + Math.floor(Math.random() * 1e6);
  try { props_().setProperty('DATA_GEN', v); } catch (e) { Utilities.sleep(200); props_().setProperty('DATA_GEN', v); }   // 失敗重試一次
}
function cacheGet_(key) {
  try {
    var c = CacheService.getScriptCache(), head = c.get(key + ':n');
    if (!head) return null;
    var n = Number(head), keys = [];
    for (var i = 0; i < n; i++) keys.push(key + ':' + i);
    var parts = c.getAll(keys), s = '';
    for (var j = 0; j < n; j++) { if (parts[key + ':' + j] == null) return null; s += parts[key + ':' + j]; }
    return JSON.parse(s);
  } catch (e) { return null; }
}
function cachePut_(key, obj) {
  try {
    var s = JSON.stringify(obj), o = {}, n = Math.ceil(s.length / CACHE_CHUNK_) || 1;
    if (n > 50) return;                                     // 太大就不快取（CacheService 單次上限）
    for (var i = 0; i < n; i++) o[key + ':' + i] = s.slice(i * CACHE_CHUNK_, (i + 1) * CACHE_CHUNK_);
    o[key + ':n'] = String(n);
    CacheService.getScriptCache().putAll(o, CACHE_TTL_);
  } catch (e) {}
}

// 名單快照：放在**獨立的試算表**「鼎兆元｜電子佈告欄｜公開名單」（只有公開欄位），發布到網路整份也不會外洩密碼資料。
// 絕不可寫進主試算表（主試算表有密碼雜湊與 salt，發布時選錯範圍就全外洩）。
function snapBook_() {
  var pr = props_(), id = pr.getProperty('SNAP_SS_ID');
  if (id) return SpreadsheetApp.openById(id);                      // 打不開就丟例外（暫時性錯誤不可重建，否則已發布的網址會凍結在舊資料）
  var bk = SpreadsheetApp.create('鼎兆元｜電子佈告欄｜公開名單');
  pr.setProperty('SNAP_SS_ID', bk.getId());
  bk.getSheets()[0].setName(SHEETS_.snap.name);
  return bk;
}
function writeSnap_(staffRows) {
  var def = SHEETS_.snap, bk = snapBook_(), sh = bk.getSheetByName(def.name) || bk.insertSheet(def.name);
  var rows = [def.head].concat(staffRows.filter(function (r) { return r.id && bool_(r.active); }).map(function (r) {
    return [r.id, DZYB.maskName(r.name), r.unit, r.store || '', r.pinHash ? 'Y' : '', (Number(r.fail) || 0) >= DZYB.STAFF_MAX_FAIL ? 'Y' : ''];
  }));
  if (rows.length > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), rows.length - sh.getMaxRows() + 50);
  sh.getRange(1, 1, rows.length, def.cols.length).setNumberFormat('@').setValues(rows);           // 先覆寫再清尾端，不留空快照空窗
  var last = sh.getLastRow();
  if (last > rows.length) sh.getRange(rows.length + 1, 1, last - rows.length, def.cols.length).clearContent();
}

/* 鏡像用：四分頁、暫存與舊分頁的後綴；mirrorRows_ 把 Mac mini 的資料轉成各分頁欄位（純函式，node 測試直接驗） */
var MIRROR_KEYS_ = ['posts', 'staff', 'reads', 'log'], MIRROR_TMP_ = '__鏡像中', MIRROR_OLD_ = '__上一輪';
// oldSig：現有「已讀」分頁的 postId|staffId → 簽名檔 id。新資料沒帶 driveSigId 時保留原值（#13 S3）：
// 搬遷前的舊簽名 Drive id 已在分頁裡，Mac mini 端漏回填或欄位名對不上時，第一次鏡像也不會把它洗成空白。
function distinct_(list, keyOf) {                                     // 不重複、非空白的鍵數
  var seen = Object.create(null), n = 0;
  list.forEach(function (x) { var k = keyOf(x); if (k && !seen[k]) { seen[k] = true; n++; } });
  return n;
}
function mirrorRows_(d, fromPost, oldSig) {
  oldSig = oldSig || {};
  return {
    posts: d.posts.map(fromPost),
    // lineHash 不鏡像（Mac mini 是正本時試算表那一欄永遠空白；回退到 GAS 後下一次「打卡同步」會重新填）
    staff: d.staff.map(function (s) { var o = Object.assign({}, s); o.active = s.active ? 'TRUE' : 'FALSE'; o.lineHash = ''; return o; }),
    reads: d.reads.map(function (r) { return { postId: r.postId, staffId: r.staffId, name: r.name, unit: r.unit, at: r.at, sigId: r.driveSigId || oldSig[r.postId + '|' + r.staffId] || '' }; }),
    log: d.log.map(function (e) { return { at: e.at, action: e.action, target: e.target || '', summary: e.summary || '' }; })
  };
}
// 鏡像換名的進度標記（指令碼屬性 MIRROR_PHASE），mirrorHeal_ 依標記決定還原或往前完成，不用猜（#13 S7）：
//   renaming        正式分頁正改名成「__上一輪」→ 可能只改了一部分 → 整組還原成上一輪
//   backup_renamed  正式分頁都已改成「__上一輪」、暫存分頁正換上來 → 整組還原成上一輪
//   tmp_renamed     四張新分頁都已換上正式名稱，只差刪「__上一輪」→ 往前完成（只刪舊分頁、不動資料）
//   done／未設      沒有進行中的換名；若還留著「__上一輪」：四張正式分頁都在就只刪舊的，缺任何一張才整組還原
// 鏡像開頭與換名失敗時各跑一次；回退（#10）前也可以在編輯器手動執行 mirrorHeal()。
function mirrorHeal_(book) {
  var phase = props_().getProperty('MIRROR_PHASE') || 'done';
  var named = function (sfx) { return MIRROR_KEYS_.map(function (k) { return book.getSheetByName(SHEETS_[k].name + sfx); }); };
  var olds = named(MIRROR_OLD_);
  if (!olds.some(Boolean)) { if (phase !== 'done') props_().setProperty('MIRROR_PHASE', 'done'); return 'clean'; }
  var allCur = named('').every(Boolean);
  if (phase === 'tmp_renamed' || (phase === 'done' && allCur)) {
    olds.forEach(function (x) { if (x) book.deleteSheet(x); });
    props_().setProperty('MIRROR_PHASE', 'done'); return 'forward';
  }
  MIRROR_KEYS_.forEach(function (k, i) {                               // 整組還原：已換上來的新分頁退回「__鏡像中」、上一輪改回正式名稱
    var n = SHEETS_[k].name, old = olds[i];
    if (!old) return;
    var cur = book.getSheetByName(n);
    if (cur) { var t = book.getSheetByName(n + MIRROR_TMP_); if (t) book.deleteSheet(t); cur.setName(n + MIRROR_TMP_); }
    old.setName(n);
  });
  props_().setProperty('MIRROR_PHASE', 'done'); return 'restore';
}
// 編輯器手動執行用（clean／forward／restore）：先拿 ScriptLock，每小時的鏡像正在換名時不插手（#13 第 3 輪建議 4）
function mirrorHeal() {
  var l = LockService.getScriptLock();
  if (!l.tryLock(30000)) { Logger.log('鏡像進行中，稍後再試'); return 'busy'; }
  try { var r = mirrorHeal_(ss_()); Logger.log('鏡像修復：' + r); return r; } finally { l.releaseLock(); }
}

function makeStore_(files) {
  var book = null, memo = {}, gen = null, snapDirty = false;                              // gen 惰性讀取：寫入動作在鎖內才第一次讀
  function sheet(key) { if (!book) book = ss_(); return book.getSheetByName(SHEETS_[key].name); }
  function rows(key, fresh) {
    if (memo[key] && !fresh) return memo[key];
    if (gen === null) gen = dataGen_();
    var ck = 'rows:' + key + ':' + gen, hit = fresh ? null : cacheGet_(ck);
    if (hit) { memo[key] = hit; return hit; }
    var sh = sheet(key), n = sh.getLastRow() - 1, cols = SHEETS_[key].cols;
    var nc = Math.min(cols.length, sh.getMaxColumns());                // 舊分頁欄數比定義少（例如沒有 lineHash 欄）：只讀現有的，缺的當空白
    var vals = n > 0 ? sh.getRange(2, 1, n, nc).getValues() : [];
    memo[key] = vals.map(function (r, i) {
      var o = { _row: i + 2 }; cols.forEach(function (c, j) { o[c] = cellStr_(r[j]); }); return o;
    });
    cachePut_(ck, memo[key]);
    return memo[key];
  }
  function write(key, obj, row) {
    var cols = SHEETS_[key].cols, sh = sheet(key);
    if (sh.getMaxColumns() < cols.length) sh.insertColumnsAfter(sh.getMaxColumns(), cols.length - sh.getMaxColumns());   // 分頁欄數不夠先加欄（getRange 越界會丟例外）
    if (sh.getRange(1, cols.length).getValue() === '') {                 // 舊表補新欄表頭（例如同仁的「來源」欄）
      sh.getRange(1, 1, 1, cols.length).setValues([SHEETS_[key].head]).setFontWeight('bold');
      sh.getRange(1, cols.length, sh.getMaxRows(), 1).setNumberFormat('@');
    }
    var vals = [cols.map(function (c) { var v = obj[c]; return v === undefined || v === null ? '' : String(v); })];
    var target = row || sh.getLastRow() + 1;
    if (target > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 200);   // 超過現有列數先加列（getRange 越界會丟例外）
    var r = sh.getRange(target, 1, 1, cols.length);
    r.setNumberFormat('@').setValues(vals);                           // 每列寫入前設純文字：超過 setup 當下的列數也不會把 ISO 時間轉成日期
    SpreadsheetApp.flush();                                          // 先落地再換世代、再放鎖，避免下一個寫入者算到同一列或快取到舊值
    if (key === 'log') return;
    // 就地更新本次請求的 memo（不整表重讀：批次同步數十人時才不會越來越慢）
    if (memo[key]) {
      var o = { _row: target }; cols.forEach(function (c, j) { o[c] = vals[0][j]; });
      var i = memo[key].findIndex(function (x) { return x._row === target; });
      if (i >= 0) memo[key][i] = o; else memo[key].push(o);
    }
    bumpGen_(); gen = dataGen_();                                    // 資料變了：快取世代換新
    if (memo[key]) cachePut_('rows:' + key + ':' + gen, memo[key]);
    if (key === 'staff') snapDirty = true;                          // 快照在請求結束時寫一次（批次同步不必每人重寫）
  }
  // 寫回既有列之前，確認那一列的 id 還是它（有人手動刪列／排序過試算表時，快取裡的列號會錯）；對不上就重讀試算表
  function upsert(key, obj) {
    var hit = rows(key).filter(function (r) { return r.id === obj.id; })[0];
    var sh0 = hit && sheet(key);
    if (hit && (hit._row > sh0.getLastRow() || String(sh0.getRange(hit._row, 1).getValue()) !== String(obj.id))) {   // 列號超出現有資料也視為過期
      hit = rows(key, true).filter(function (r) { return r.id === obj.id; })[0];
    }
    write(key, obj, hit ? hit._row : null);
  }

  function toPost(r) {
    var fl = []; try { fl = JSON.parse(r.files || '[]'); } catch (e) { fl = []; }
    return { id: r.id, title: r.title, body: r.body, units: DZYB.normUnits(r.units.split(',')), publishOn: r.publishOn,
      expiresOn: r.expiresOn, pinned: bool_(r.pinned), published: bool_(r.published), offOn: r.offOn, files: fl,
      createdAt: r.createdAt, updatedAt: r.updatedAt };
  }
  function fromPost(p) {
    return { id: p.id, title: p.title, body: p.body, units: (p.units || []).join(','), publishOn: p.publishOn, expiresOn: p.expiresOn || '',
      pinned: p.pinned ? 'TRUE' : 'FALSE', published: p.published ? 'TRUE' : 'FALSE', offOn: p.offOn || '',
      files: JSON.stringify(p.files || []), createdAt: p.createdAt || '', updatedAt: p.updatedAt || '' };
  }
  function toStaff(r) {
    return { id: r.id, name: r.name, unit: r.unit, pinHash: r.pinHash, salt: r.salt, pinVer: Number(r.pinVer) || 0,
      fail: Number(r.fail) || 0, active: bool_(r.active), createdAt: r.createdAt, deletedAt: r.deletedAt, src: r.src || '', store: r.store || '',
      lineHash: r.lineHash || '' };
  }

  return {
    getPosts: function () { return rows('posts').filter(function (r) { return r.id; }).map(toPost); },
    savePost: function (p) { upsert('posts', fromPost(p)); },
    getStaff: function () { return rows('staff').filter(function (r) { return r.id; }).map(toStaff); },
    saveStaff: function (s) {
      var o = Object.assign({}, s); o.active = s.active ? 'TRUE' : 'FALSE'; upsert('staff', o);
    },
    // 已讀：簽名圖存 Drive，試算表只存檔案 id（簽名量大，放試算表會拖慢整份表）
    getReads: function () {
      return rows('reads').filter(function (r) { return r.postId; })
        .map(function (r) { return { postId: r.postId, staffId: r.staffId, name: r.name, unit: r.unit, at: r.at, sigId: r.sigId }; });
    },
    addRead: function (r) {
      var sigId = files.saveSig(r.sig, r.postId + '_' + r.staffId);
      write('reads', { postId: r.postId, staffId: r.staffId, name: r.name, unit: r.unit, at: r.at, sigId: sigId }, null);
    },
    getSigs: function (postId) {
      var out = {};
      this.getReads().forEach(function (r) {
        if (r.postId === postId && r.sigId) { try { out[r.staffId] = files.readSig(r.sigId); } catch (e) { out[r.staffId] = null; } }
      });
      return out;
    },
    addLog: function (e) { write('log', e, null); },
    getReq: function (rid) { try { return CacheService.getScriptCache().get('req:' + rid); } catch (e) { return null; } },
    putReq: function (rid, id) { try { CacheService.getScriptCache().put('req:' + rid, id, 21600); } catch (e) {} },
    getAdmin: function () {
      var p = props_().getProperties();
      return { hash: p.ADMIN_HASH || '', salt: p.ADMIN_SALT || '', init: p.ADMIN_INIT || '', ver: Number(p.ADMIN_VER) || 1,
        fail: Number(p.ADMIN_FAIL) || 0, lockUntil: Number(p.ADMIN_LOCK) || 0 };
    },
    setAdmin: function (a) {
      var pr = props_();
      pr.setProperties({ ADMIN_HASH: a.hash || '', ADMIN_SALT: a.salt || '', ADMIN_VER: String(a.ver || 1),
        ADMIN_FAIL: String(a.fail || 0), ADMIN_LOCK: String(a.lockUntil || 0) });
      if (!a.init) pr.deleteProperty('ADMIN_INIT');          // 初始通行碼轉成雜湊後刪除原文
    },
    secret: function () { return props_().getProperty('TOKEN_SECRET'); },
    // 搬遷匯出（橋接 export）：一律直接讀試算表、不走 10 分鐘快取（fresh），呼叫端必須在 ScriptLock 內（#7）
    dump: function () {
      MIRROR_KEYS_.forEach(function (k) { rows(k, true); });
      return { posts: this.getPosts(), staff: this.getStaff(), reads: this.getReads(),
        log: rows('log').filter(function (r) { return r.at || r.action; }).map(function (r) { return { at: r.at, action: r.action, target: r.target, summary: r.summary }; }) };
    },
    // 鏡像（橋接 mirror，PRIMARY=mini 時每小時一次）：Mac mini 的正本整份覆寫回四分頁（給人看＋回退到 GAS 用）。
    // 先寫到暫存分頁「<名稱>__鏡像中」，四份都寫完、筆數核對過才換名：中途逾時（6 分鐘上限）或丟錯時，正式四分頁仍是上一輪的完整資料（#7、#8）。
    // 已讀的「簽名檔 id」只寫 driveSigId（Drive 檔案 id），還沒回填的留空——Mac mini 的本機檔名寫進來，回退後 readSig(id) 會全部失敗（#7）。
    // 已讀分頁裡既有的簽名檔 id（fresh）：橋接 sig／sigs.get 放行舊資料夾的簽名用（#13 S5）
    sigIds: function () {
      var o = Object.create(null);
      rows('reads', true).forEach(function (r) { if (r.sigId) o[r.sigId] = true; });
      return o;
    },
    mirror: function (d, opt) {
      d = d || {}; opt = opt || {};
      var bad = function (m) { var e = new Error(m); e.code = 'BAD_REQ'; return e; };
      MIRROR_KEYS_.forEach(function (k) { if (!Array.isArray(d[k])) throw bad('鏡像資料缺 ' + k); });   // 缺一份就拒絕，不可把正式分頁清空
      if (!book) book = ss_();
      mirrorHeal_(book);                                                    // 上一輪換名做一半 → 先救回正式分頁
      // 防呆（#13 S1）：Mac mini 開到空 DB 或 DATA_DIR 設錯時，每小時鏡像會把回退唯一的正本蓋掉
      if (MIRROR_KEYS_.every(function (k) { return !d[k].length; })) throw bad('鏡像資料全空，拒絕覆寫');
      var oldReads = rows('reads', true).filter(function (r) { return r.postId; });
      if (!opt.force) {                                                     // force 只由 Eason 手動帶，mirror.js 預設不帶
        // 筆數一律比「不重複、非空白」的鍵：正式分頁可能有重複或空白列，搬到 Mac mini 時會去重，比原始列數會被永久拒絕（M3 審查 S6）
        var idOf = function (r) { return r && r.id ? String(r.id) : ''; }, readOf = function (r) { return r && r.postId && r.staffId ? r.postId + '|' + r.staffId : ''; };
        ['posts', 'staff'].forEach(function (k) {
          var have = distinct_(rows(k, true), idOf), send = distinct_(d[k], idOf);
          if (send * 2 < have) throw bad('鏡像的' + SHEETS_[k].name + '筆數（' + send + '）比現有（' + have + '）少一半以上，拒絕覆寫（確認無誤請帶 force）');
        });
        // 已讀不會被硬刪（每人每則一次），筆數只增不減 → 少一筆就拒絕（#13 S6）
        var haveR = distinct_(oldReads, readOf), sendR = distinct_(d.reads, readOf);
        if (sendR < haveR) throw bad('鏡像的已讀筆數（' + sendR + '）比現有（' + haveR + '）少，拒絕覆寫（確認無誤請帶 force）');
        // 操作紀錄也只增不減（Mac mini 只有匯入時才清），#10 回退也要看它 → 不重複列數少就拒絕（#13 第 3 輪建議 2）
        var logOf = function (e) { return e && (e.at || e.action) ? [e.at, e.action, e.target || '', e.summary || ''].join('\u0001') : ''; };
        var haveL = distinct_(rows('log', true), logOf), sendL = distinct_(d.log, logOf);
        if (sendL < haveL) throw bad('鏡像的操作紀錄筆數（' + sendL + '）比現有（' + haveL + '）少，拒絕覆寫（確認無誤請帶 force）');
      }
      var oldSig = {}, known = Object.create(null);
      oldReads.forEach(function (r) { if (r.sigId) { oldSig[r.postId + '|' + r.staffId] = r.sigId; known[r.sigId] = true; } });
      var objs = mirrorRows_(d, fromPost, oldSig), counts = {};
      // 簽名檔 id 只能是「分頁裡本來就有的值」或「目前簽名資料夾裡的圖」（sigs.put 產生的都是）；
      // 否則持有金鑰的一方能把任意 Drive id 塞進已讀分頁，再經回條（receipts→getSigs）讀出雲端硬碟的檔案（#13 N1 a）
      var checked = Object.create(null), badN = 0;
      objs.reads.forEach(function (r) {
        var id = r.sigId; if (!id || known[id]) return;
        if (!(id in checked)) checked[id] = files.isSigFile(id);
        if (!checked[id]) badN++;
      });
      if (badN) throw bad('鏡像的簽名檔 id 有 ' + badN + ' 筆不在簽名資料夾，拒絕覆寫');
      MIRROR_KEYS_.forEach(function (k) {                                   // 清掉上一輪失敗留下的暫存分頁
        var x = book.getSheetByName(SHEETS_[k].name + MIRROR_TMP_); if (x) book.deleteSheet(x);
      });
      MIRROR_KEYS_.forEach(function (k) {
        var def = SHEETS_[k], sh = book.insertSheet(def.name + MIRROR_TMP_, book.getSheets().length);
        var vals = [def.head].concat(objs[k].map(function (o) { return def.cols.map(function (c) { var v = o[c]; return v === undefined || v === null ? '' : String(v); }); }));
        if (vals.length > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), vals.length - sh.getMaxRows() + 100);
        sh.getRange(1, 1, vals.length, def.cols.length).setNumberFormat('@').setValues(vals);
        sh.getRange(1, 1, 1, def.cols.length).setFontWeight('bold'); sh.setFrozenRows(1);
        counts[k] = vals.length - 1;
      });
      SpreadsheetApp.flush();
      MIRROR_KEYS_.forEach(function (k) {                                   // 筆數核對：少一列就不換名
        if (book.getSheetByName(SHEETS_[k].name + MIRROR_TMP_).getLastRow() !== counts[k] + 1) throw new Error('鏡像筆數不符：' + k);
      });
      // 換名：正式分頁先改名成「__上一輪」（備份）、暫存分頁改成正式名稱，最後才刪備份；每一步前後寫 MIRROR_PHASE，
      // 中途失敗由 mirrorHeal_ 依標記還原（換名沒做完）或往前完成（只差刪備份）
      var pr = props_();
      try {
        pr.setProperty('MIRROR_PHASE', 'renaming');
        MIRROR_KEYS_.forEach(function (k) { var cur = book.getSheetByName(SHEETS_[k].name); if (cur) cur.setName(SHEETS_[k].name + MIRROR_OLD_); });
        pr.setProperty('MIRROR_PHASE', 'backup_renamed');
        MIRROR_KEYS_.forEach(function (k) { book.getSheetByName(SHEETS_[k].name + MIRROR_TMP_).setName(SHEETS_[k].name); });
        pr.setProperty('MIRROR_PHASE', 'tmp_renamed');
        MIRROR_KEYS_.forEach(function (k) { var x = book.getSheetByName(SHEETS_[k].name + MIRROR_OLD_); if (x) book.deleteSheet(x); });
        pr.setProperty('MIRROR_PHASE', 'done');
      } catch (e) {
        try { mirrorHeal_(book); } catch (x) { console.error('鏡像修復失敗：' + x); }
        SpreadsheetApp.flush(); bumpGen_();                                 // 往前完成時資料已換新：快取世代也要換
        throw e;
      }
      SpreadsheetApp.flush(); bumpGen_(); gen = null; memo = {};
      try { writeSnap_(rows('staff', true)); } catch (e) { console.error('鏡像後名單快照寫入失敗：' + e); }   // 回退後若填回 ROSTER_CSV 也不是凍結的舊名單
      return counts;
    },
    // 請求結束：有同仁異動才重寫名單快照；快照失敗只記紀錄，不影響已成功的寫入
    endRequest: function () {
      if (!snapDirty) return; snapDirty = false;
      try { writeSnap_(rows('staff')); } catch (e) { console.error('名單快照寫入失敗：' + e); }
    },
    refreshSnap: function () { writeSnap_(rows('staff')); }
  };
}
