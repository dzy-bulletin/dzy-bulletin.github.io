/* 鼎兆元｜電子佈告欄 — Mac mini 伺服器的資料層（Service.js 的 store 介面，SQLite＋簽名圖存硬碟）
 * 與 gas/Store.js 同一套介面：getPosts savePost getStaff saveStaff getReads addRead getSigs addLog getAdmin setAdmin secret getReq putReq
 * 另有 tx(fn)：一個寫入請求包成一筆交易（只有 Service.WRITE_ACTIONS 會用）；purgeReqs()：清過期的冪等紀錄；
 * kvGet／kvSet：伺服器自用的小快取（例如雲端空間）；dump()／load()：搬遷與鏡像用。 */
'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 簽名圖檔名：檔名只留安全字元；有字元被換掉時補原字串的短雜湊，避免 P/1 與 P_1 撞成同一個檔（#12 審查 N5）。
// server/migrate.js 搬遷下載的簽名圖也用這個（與 Mac mini 上新簽的同一套命名）。type＝'png'｜'jpeg'
const safe = (s) => { s = String(s); const t = s.replace(/[^A-Za-z0-9_-]/g, '_'); return t === s ? t : t + '-' + crypto.createHash('sha1').update(s).digest('hex').slice(0, 8); };
function sigFileName(postId, staffId, type) { return safe(postId) + '_' + safe(staffId) + (type === 'png' ? '.png' : '.jpg'); }

function makeSqliteStore(dir) {
  const sigDir = path.join(dir, 'sigs');
  fs.mkdirSync(sigDir, { recursive: true });
  // 啟動時清掉上次當機留下的簽名暫存檔（*.tmp-<pid>；正式檔名一定是 .png／.jpg 結尾）
  fs.readdirSync(sigDir).filter((f) => /\.tmp-\d+$/.test(f)).forEach((f) => { try { fs.unlinkSync(path.join(sigDir, f)); } catch (e) {} });
  const db = new DatabaseSync(path.join(dir, 'bulletin.db'));
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS posts (id TEXT PRIMARY KEY, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS staff (id TEXT PRIMARY KEY, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS reads (postId TEXT NOT NULL, staffId TEXT NOT NULL, name TEXT, unit TEXT, at TEXT, sigId TEXT,
                                      driveSigId TEXT NOT NULL DEFAULT '', PRIMARY KEY (postId, staffId));
    CREATE TABLE IF NOT EXISTS log (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, action TEXT, target TEXT, summary TEXT);
    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
  `);
  // 簽名圖的 Drive id（#7／#8）：sigId＝Mac mini 本機檔名；driveSigId＝鏡像工作（server/mirror.js）批次上傳後回填的 Drive id，
  // 鏡像寫回試算表「已讀」分頁時用這一欄，回退到 GAS 後 readSig(id) 才讀得到。M1 建的舊庫沒有這欄 → 啟動時補上。
  if (!db.prepare('PRAGMA table_info(reads)').all().some((c) => c.name === 'driveSigId')) db.exec("ALTER TABLE reads ADD COLUMN driveSigId TEXT NOT NULL DEFAULT ''");
  const kvGet = db.prepare('SELECT v FROM kv WHERE k = ?');
  const kvSet = db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v');
  const kvDel = db.prepare('DELETE FROM kv WHERE k = ?');
  // req:* 的過期只在被讀到時才刪 → 每次寫入交易順手清（#6 審查發現 5）
  // 壞掉的紀錄（非標準 JSON）一併清掉，不然 json_extract 丟錯會讓每個寫入交易都失敗（#12 第 2 輪建議 4）；CASE 保證先驗再取
  const reqPurge = db.prepare("DELETE FROM kv WHERE k LIKE 'req:%' AND CASE WHEN json_valid(v) THEN json_extract(v, '$.exp') < ? ELSE 1 END");
  const get = (k) => { const r = kvGet.get(k); return r ? r.v : null; };
  const set = (k, v) => kvSet.run(k, String(v));
  const upsertPost = db.prepare('INSERT INTO posts (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json');
  const upsertStaff = db.prepare('INSERT INTO staff (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json');
  const insRead = db.prepare('INSERT OR IGNORE INTO reads (postId, staffId, name, unit, at, sigId) VALUES (?, ?, ?, ?, ?, ?)');
  const insReadFull = db.prepare('INSERT OR IGNORE INTO reads (postId, staffId, name, unit, at, sigId, driveSigId) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const insLog = db.prepare('INSERT INTO log (at, action, target, summary) VALUES (?, ?, ?, ?)');
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const adminInitFile = path.join(dir, 'ADMIN_INIT.txt');      // Eason 更換通行碼：在 Mac mini 建這個檔（內容＝新通行碼）

  if (!get('secret')) set('secret', crypto.randomBytes(32).toString('hex'));
  const state = { failed: false };

  const store = {
    getPosts: () => db.prepare('SELECT json FROM posts ORDER BY rowid').all().map((r) => JSON.parse(r.json)),
    savePost: (p) => { upsertPost.run(p.id, JSON.stringify(p)); },
    // 同仁存成 JSON：新欄位不需要 ALTER TABLE；舊資料沒有 lineHash（2026-10-09 LINE 自動登入）→ 讀出時補 ''
    getStaff: () => db.prepare('SELECT json FROM staff ORDER BY rowid').all().map((r) => { const s = JSON.parse(r.json); if (typeof s.lineHash !== 'string') s.lineHash = ''; return s; }),
    saveStaff: (s) => { upsertStaff.run(s.id, JSON.stringify(s)); },
    getReads: () => db.prepare('SELECT postId, staffId, name, unit, at, sigId FROM reads ORDER BY rowid').all().map((r) => Object.assign({}, r)),
    addRead: (r) => {
      let sigId = '';
      const m = /^data:(image\/(png|jpeg));base64,(.+)$/.exec(String(r.sig || ''));
      if (m) {
        sigId = sigFileName(r.postId, r.staffId, m[2]);
        // 先寫暫存再改名：寫到一半斷電／程序中止不會留下半張圖頂著正式檔名（#14 第 5 輪建議；mirror.js 也會驗結尾）
        const tmp = path.join(sigDir, sigId + '.tmp-' + process.pid);
        try { fs.writeFileSync(tmp, Buffer.from(m[3], 'base64')); fs.renameSync(tmp, path.join(sigDir, sigId)); }
        catch (e) { try { fs.unlinkSync(tmp); } catch (x) {} throw e; }   // 寫入失敗（磁碟滿等）不留暫存檔
      }
      insRead.run(r.postId, r.staffId, r.name, r.unit, r.at, sigId);
    },
    getSigs: (postId) => {
      const out = {};
      db.prepare('SELECT staffId, sigId FROM reads WHERE postId = ?').all(postId).forEach((r) => {
        if (!r.sigId) return;
        try {
          const b = fs.readFileSync(path.join(sigDir, path.basename(r.sigId)));
          out[r.staffId] = 'data:image/' + (r.sigId.endsWith('.png') ? 'png' : 'jpeg') + ';base64,' + b.toString('base64');
        } catch (e) { out[r.staffId] = null; }
      });
      return out;
    },
    addLog: (e) => { insLog.run(e.at, e.action, e.target || '', e.summary || ''); },
    getAdmin: () => {
      const a = JSON.parse(get('admin') || '{}');
      let init = '';
      try { init = fs.readFileSync(adminInitFile, 'utf8').trim(); } catch (e) {}
      return { hash: a.hash || '', salt: a.salt || '', init, ver: Number(a.ver) || 1, fail: Number(a.fail) || 0, lockUntil: Number(a.lockUntil) || 0 };
    },
    setAdmin: (a) => {
      set('admin', JSON.stringify({ hash: a.hash || '', salt: a.salt || '', ver: a.ver || 1, fail: a.fail || 0, lockUntil: a.lockUntil || 0 }));
      if (!a.init) { try { fs.unlinkSync(adminInitFile); } catch (e) {} }   // 轉成雜湊後刪掉明碼檔
    },
    secret: () => get('secret'),
    getReq: (rid) => {
      const v = get('req:' + rid); if (!v) return null;
      let o = null; try { o = JSON.parse(v); } catch (e) {}
      if (!o || typeof o !== 'object' || !(o.exp >= Date.now())) { kvDel.run('req:' + rid); return null; }   // 過期或壞紀錄：當作不存在並刪掉
      return o.v;
    },
    putReq: (rid, v) => { set('req:' + rid, JSON.stringify({ v, exp: Date.now() + 6 * 3600e3 })); },
    purgeReqs: (nowMs) => Number(reqPurge.run(nowMs || Date.now()).changes),
    kvGet: get,
    kvSet: set,

    // 一個寫入請求一筆交易（Service 的寫入全部成功或全部不寫）。Service 會把錯誤轉成回應、不往外丟（有些地方還會吞掉），
    // 所以資料層自己記「這筆交易裡有 store 動作失敗」（failed）：有就 ROLLBACK 並丟出例外，
    // 呼叫端（index.js）一律回 SERVER——就算 Service 自己吞掉錯誤回了 ok:true，也不能讓「已儲存」送出去（#12 S2、第 2 輪應修-1）。
    // 只包同步的程式碼：橋接（await）一律在 tx 外做完，寫鎖不會被 Google 佔住。
    // 註：BEGIN IMMEDIATE 遇到 mirror.js 回填 driveSigId 持有寫鎖時會同步等最多 busy_timeout（5 秒），這段期間事件迴圈停住；
    //     mirror.js 每批只 UPDATE 10～20 列的一欄、每小時一次（daily.js 的 VACUUM INTO 只讀），量很小，接受。
    tx: (fn) => {
      db.exec('BEGIN IMMEDIATE');
      state.failed = false;
      try {
        const r = fn();
        if (state.failed) { db.exec('ROLLBACK'); throw new Error('交易中資料層出錯，已 ROLLBACK'); }
        db.exec('COMMIT'); return r;
      } catch (e) { if (db.isTransaction) { try { db.exec('ROLLBACK'); } catch (x) {} } throw e; }
      finally { state.failed = false; }
    },
    // 搬遷／鏡像
    dump: () => ({
      posts: store.getPosts(), staff: store.getStaff(), reads: store.getReads(),
      log: db.prepare('SELECT at, action, target, summary FROM log ORDER BY seq').all().map((r) => Object.assign({}, r)),
      admin: JSON.parse(get('admin') || '{}')
    }),
    load: (d) => {                                            // 匯入（清空後寫入）；簽名圖另外放進 sigs/
      store.tx(() => {
        db.exec("DELETE FROM posts; DELETE FROM staff; DELETE FROM reads; DELETE FROM log; DELETE FROM kv WHERE k LIKE 'req:%';");
        (d.posts || []).forEach((p) => upsertPost.run(p.id, JSON.stringify(p)));
        (d.staff || []).forEach((s) => upsertStaff.run(s.id, JSON.stringify(s)));
        (d.reads || []).forEach((r) => insReadFull.run(r.postId, r.staffId, r.name, r.unit, r.at, r.sigId || '', r.driveSigId || ''));   // 搬遷時保留原 Drive id
        (d.log || []).forEach((e) => insLog.run(e.at, e.action, e.target || '', e.summary || ''));
        if (d.admin) set('admin', JSON.stringify(d.admin));
        if (d.secret) set('secret', d.secret);
      });
    },
    dropPost: (id) => { db.prepare('DELETE FROM posts WHERE id = ?').run(id); },   // 只給 E2E 測試入口用（驗「reqId 指向的公告不存在」）
    sigDir,
    close: () => db.close()
  };
  // Service 會呼叫的方法全部包一層：系統錯誤（EACCES、SQLITE_FULL、ERR_SQLITE_ERROR…）原文只進 stderr，
  // 丟給 Service 的是沒有 code 的錯誤 → Service 回通用的 SERVER，與 GAS 原生例外同樣處理，路徑與 SQLite 原文不外洩（C12）。
  ['getPosts', 'savePost', 'getStaff', 'saveStaff', 'getReads', 'addRead', 'getSigs', 'addLog', 'getAdmin', 'setAdmin', 'secret', 'getReq', 'putReq']
    .forEach((k) => {
      const fn = store[k];
      store[k] = function () {
        try { return fn.apply(null, arguments); }
        catch (e) {
          state.failed = true;
          console.error(new Date().toISOString() + ' store.' + k + ' 失敗：' + (e && e.stack || e));
          throw new Error('資料層錯誤');
        }
      };
    });
  return store;
}

module.exports = { makeSqliteStore, sigFileName };
