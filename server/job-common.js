/* 鼎兆元｜電子佈告欄 — 背景工作共用（server/mirror.js 每小時、server/daily.js 每日、server/restore.js 還原）
 * 背景工作與伺服器是兩個程序同時開同一個 bulletin.db，所以這裡**不經 makeSqliteStore**（#8 審查發現）：
 *   makeSqliteStore 會跑 CREATE TABLE／ALTER TABLE／PRAGMA journal_mode，而且 kv.secret 缺的時候會寫入一把新 secret——
 *   在正式庫上、伺服器開著時，這是危險的副作用。背景工作自己開一般連線＋busy_timeout，只做 SELECT、VACUUM INTO、
 *   `UPDATE reads SET driveSigId`（只寫那一欄），以及 mirror.js 第 4 步在交易內只改同仁 JSON 的 lineHash（2026-10-09）。 */
'use strict';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const BUSY_MS = 5000;                                       // 與 store-sqlite.js 相同：等伺服器的寫入交易最多 5 秒

// server/.env（只補沒設的變數）；與 index.js 同一個格式
function loadEnv(file) {
  if (process.env.DZYB_NO_DOTENV === '1') return;          // 測試一律不讀 server/.env：已部署的機器上有真的 BRIDGE_URL／KEY，讀進來會讓 E2E 拒絕啟動，正式模式的測試還會打到真的 Apps Script
  try {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line) => {
      const m = /^\s*([A-Z_0-9]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    });
  } catch (e) {}
}
function dataDir(env) { return path.resolve((env.DATA_DIR || path.join(env.HOME || '', 'dzy-bulletin-data')).replace(/^~/, env.HOME || '')); }

// 開正式庫：檔案不存在就丟錯（DatabaseSync 預設會默默建一個空檔，背景工作不該建庫）
function openDb(dir, opts) {
  const file = path.join(dir, 'bulletin.db');
  if (!fs.existsSync(file)) throw new Error('找不到資料庫 ' + file);
  const db = new DatabaseSync(file, opts && opts.readOnly ? { readOnly: true } : {});
  db.exec('PRAGMA busy_timeout = ' + (opts && opts.busyMs >= 0 ? Math.floor(opts.busyMs) : BUSY_MS));   // busyMs 只給測試縮短等待
  return db;
}
const rows = (db, sql, ...a) => db.prepare(sql).all(...a).map((r) => Object.assign({}, r));
function counts(db) {
  const n = (t) => Number(db.prepare('SELECT COUNT(*) AS n FROM ' + t).get().n);
  return { posts: n('posts'), staff: n('staff'), reads: n('reads'), log: n('log') };
}
const countText = (c) => `公告 ${c.posts}、同仁 ${c.staff}、已讀 ${c.reads}、紀錄 ${c.log}`;

// 台北時間戳（檔名用）：伺服器其他地方用 L.today()（Asia/Taipei），這裡同樣用時區格式化，不手算 +8h（#8 審查發現）
function taipeiStamp(d) {
  const p = {};
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(d || new Date()).forEach((x) => { p[x.type] = x.value; });
  return `${p.year}-${p.month}-${p.day}_${p.hour}${p.minute}`;
}

function logsDir(dir) { const d = path.join(dir, 'logs'); fs.mkdirSync(d, { recursive: true }); return d; }
// 紀錄只寫進 logs/*.log；終端機手動執行時才同時印出（launchd 下 stdout 另有 *.out.log，不重複一份）
function logLine(dir, file, s) {
  const line = new Date().toISOString() + ' ' + s;
  if (process.stdout.isTTY) console.log(line);
  fs.appendFileSync(path.join(logsDir(dir), file), line + '\n');
}
// 讀狀態檔：不存在回 { v:null }；存在但壞掉回 { corrupt:true }（呼叫端決定怎麼處理，不默默當成空的）
function readState(dir, file) {
  let raw;
  try { raw = fs.readFileSync(path.join(dir, 'logs', file), 'utf8'); } catch (e) { return e.code === 'ENOENT' ? { v: null } : { corrupt: true }; }
  try { const v = JSON.parse(raw); return v && typeof v === 'object' ? { v } : { corrupt: true }; } catch (e) { return { corrupt: true }; }
}
function readLast(dir, file) { try { return JSON.parse(fs.readFileSync(path.join(dir, 'logs', file), 'utf8')); } catch (e) { return null; } }
// 結果檔先寫暫存再改名：/health 或守門不會讀到寫一半的 JSON
function writeLast(dir, file, obj) {
  const p = path.join(logsDir(dir), file), tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, p);
}
// 註：兩個程序同時判定同一把殘留鎖時仍有極小的競態（後者可能刪掉前者剛拿的新鎖）；只在「殘留＋同一秒兩個搶」時發生，
//     launchd 同一 job 不重疊、回退時手動 --all 也會先看到「另一輪正在跑」，接受。
// 工作鎖（logs/<name>.lock，內容＝PID）：同一個 DATA_DIR 同時只有一個持有者。
// PID 已不在、或鎖檔超過 maxAgeMs（預設 6 小時；防 PID 被別的程序重用後永遠跳過）就當作殘留、清掉重拿。
// 拿到回傳釋放函式，拿不到回傳 null。mirror.js／daily.js 各拿自己的鎖；restore.js 兩把都拿，換檔期間背景工作不會開庫。
function takeLock(dir, name, maxAgeMs) {
  const f = path.join(dir, 'logs', name + '.lock');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  for (let i = 0; i < 2; i++) {
    try {
      fs.writeFileSync(f, String(process.pid), { flag: 'wx' });
      const release = () => { try { if (fs.readFileSync(f, 'utf8') === String(process.pid)) fs.unlinkSync(f); } catch (e) {} };
      release.touch = () => { try { const t = new Date(); fs.utimesSync(f, t, t); } catch (e) {} };   // 長時間執行（--all）定期更新 mtime，不被當成殘留
      return release;
    }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let pid = 0, age = 0;
      try { pid = Number(fs.readFileSync(f, 'utf8')) || 0; age = Date.now() - fs.statSync(f).mtimeMs; } catch (x) { continue; }
      let alive = false; try { if (pid) { process.kill(pid, 0); alive = true; } } catch (x) { alive = x.code === 'EPERM'; }
      if (alive && age < (maxAgeMs || 6 * 3600e3)) return null;
      try { fs.unlinkSync(f); } catch (x) {}
    }
  }
  return null;
}
function diskFreeMB(dir) { try { const s = fs.statfsSync(dir); return Math.floor(s.bavail * s.bsize / 1048576); } catch (e) { return null; } }
// ---- 光復小幫手（訂貨小幫手 @954wknja）的 /exec：sign-remind.js（#26 enqueue_text）與 announce.js（#28 push_text）共用 ----
// .env 兩個鍵（Eason 親手貼）：REMIND_ENQUEUE_URL、REMIND_ENQUEUE_TOKEN；兩支沿用同一組，換 token 只換一處
function helperEnv(env) { return { url: env.REMIND_ENQUEUE_URL || '', token: env.REMIND_ENQUEUE_TOKEN || '' }; }
const HELPER_TIMEOUT_SEC = 60;                              // 小幫手 Apps Script 冷啟動＋寫試算表，60 秒很寬
// 打小幫手一次：網路錯誤／逾時／回應不是 JSON → e.retry＝true；小幫手回 ok:false → 不重試
async function postHelper(url, payload, timeoutSec) {
  let text;
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload),
      redirect: 'follow', signal: AbortSignal.timeout((timeoutSec || HELPER_TIMEOUT_SEC) * 1000) });
    text = await res.text();
  } catch (e) {
    const x = new Error((e && (e.name === 'TimeoutError' || e.name === 'AbortError')) ? '連線小幫手逾時' : '連不上小幫手：' + (e && e.message));
    x.retry = true; throw x;
  }
  let j;
  try { j = JSON.parse(text); } catch (e) { const x = new Error('小幫手回應不是 JSON'); x.retry = true; throw x; }
  if (!j || !j.ok) throw new Error('小幫手拒收：' + String((j && j.error) || (j && j.mode ? j.mode + ' 失敗' : '') || '未知原因').slice(0, 100));   // 只留對方的短句，不會含我們的 token
  return j;
}
// 可重試的錯誤（e.retry）等 retryMs 後再試一次；onRetry(訊息) 給呼叫端記 log
async function postHelperRetry(url, payload, o) {
  o = o || {};
  try { return await postHelper(url, payload, o.timeoutSec); }
  catch (e) {
    if (!e.retry) throw e;
    if (o.onRetry) o.onRetry(e.message + '，重試一次');
    await new Promise((ok) => setTimeout(ok, o.retryMs >= 0 ? o.retryMs : 5000));
    return postHelper(url, payload, o.timeoutSec);
  }
}

// 錯誤只留代碼與短句（結果檔是本機檔，/health 不會帶出，但也不要把整個 stack 寫進去）
const errText = (e) => String((e && (e.code ? e.code + ' ' : '') + (e.detail || e.message)) || e).slice(0, 300);

module.exports = { helperEnv, postHelper, postHelperRetry, HELPER_TIMEOUT_SEC, BUSY_MS, loadEnv, dataDir, openDb, rows, counts, countText, taipeiStamp, logLine, readState, readLast, writeLast, takeLock, diskFreeMB, errText };
