#!/usr/bin/env node
/* 鼎兆元｜電子佈告欄 — 光復未簽提醒（launchd com.dzy.bulletin.remind，每天 18:00；#26）
 *   小辛辣光復店同仁（staff.src 以 `gf:` 開頭＝光復打卡系統同步進來的）有公告上架滿 3 天還沒簽，
 *   就把「全名＋公告標題」經光復小幫手（訂貨小幫手 @954wknja）的文字候補入口送進光復群組，每天提醒到簽完為止。
 *   小幫手入口：POST { action:'enqueue_text', token, label, text } 到它的 /exec → { ok, queued }。
 *     同一天、同一個 label、同一群組只收一次（GAS 端判重），所以 label 固定 `佈告欄未簽提醒`；手動重跑同一天不會重複洗版。
 *     群組有人說話時用免費 reply 帶出、不吃月額度；18:00 與小幫手 FALLBACK_FROM_HOUR=18 一致。不 @ 人（小幫手沒有同仁的 userId）。
 * 不經 makeSqliteStore（見 job-common.js）：唯讀連線，只做 SELECT。
 *
 * 「上架天數」的定義（台北時間）：N ＝ 今天（L.today()，Asia/Taipei）與上架日（publishOn）的日期差。N ≥ 3 才提醒。
 *   例：10/1 上架 → 10/4 00:00 起提醒（10/3 23:59＝上架 2 天 23 小時，不提醒）。publishOn 是日期、等於上架日 00:00，
 *   所以這與「上架日 00:00 起滿 3×24 小時」是同一條線；程式只用日期差，不算時分。
 * 「目前上架中」沿用 L.status（Service 的 board 用同一個判斷）：state === 'on'＝已到上架日、未過到期日、沒有手動下架。
 * 要不要簽沿用 L.mustSign(staff.unit, post)。已讀＝reads 有 (postId, staffId) 那一列（有沒有簽名圖都算已讀）。
 *
 * 結果寫 DATA_DIR/logs/remind-last.json＝{ at, ok, people, posts, queued, error }；每次一行進 logs/remind.log。
 *   people＝要提醒的人次（同一人兩則公告算 2），posts＝有人未簽的公告則數，queued＝小幫手回的寫入列數（GAS 判重時為 0）。
 * 連線失敗（網路錯誤、逾時、回應不是 JSON）重試 1 次；仍失敗 ok:false、exit 1（佈告欄伺服器是另一個程序，不受影響）。
 *   小幫手明確回 ok:false（例如 token 錯）不重試。
 *
 * 用法：node server/sign-remind.js            （launchd 每天 18:00）
 *       node server/sign-remind.js --dry-run  （只印出訊息內容、不送出、不寫 remind-last.json；不需要先設定 .env 兩個鍵）
 * 環境變數：DATA_DIR  REMIND_ENQUEUE_URL  REMIND_ENQUEUE_TOKEN（server/.env，Eason 親手貼）；
 *   沒設定 → 印出「未設定 REMIND_ENQUEUE_URL／TOKEN，尚未啟用」並 exit 0。REMIND_RETRY_MS（重試前等幾毫秒，預設 5000，只給測試縮短） */
'use strict';
const path = require('path');
const J = require('./job-common.js');
const L = require(path.join(__dirname, '..', 'js', 'logic.js'));

const LAST = 'remind-last.json', LOG = 'remind.log';
const LABEL = '佈告欄未簽提醒';
const MIN_DAYS = 3;
const MAX_CHARS = 4500;                                     // 小幫手寫入候補時截 5000 字（text.slice(0, 5000)），留餘裕
const SITE = 'https://dzy-bulletin.github.io';
const SRC_PREFIX = 'gf:';                                   // gf＝小辛辣光復（cf＝央廚、js＝墨竹亭金山）

// 日期差（兩個 YYYY-MM-DD，以 UTC 午夜計，不受夏令時間影響；台灣也沒有）
function daysBetween(from, to) { return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400e3); }

// 從資料庫取資料（唯讀）。posts／staff 存的是 JSON，reads 只要 (postId, staffId)
function loadData(dir) {
  const db = J.openDb(dir, { readOnly: true });
  try {
    const posts = J.rows(db, 'SELECT json FROM posts ORDER BY rowid').map((r) => JSON.parse(r.json));
    const staff = J.rows(db, 'SELECT json FROM staff ORDER BY rowid').map((r) => JSON.parse(r.json));
    const reads = J.rows(db, 'SELECT postId, staffId FROM reads');
    return { posts, staff, reads };
  } finally { db.close(); }
}

// 純函式：算出要提醒的名單，依公告分組 → [{ id, title, days, names:[…] }]
function pending(data, td) {
  const done = new Set(data.reads.map((r) => r.postId + '\t' + r.staffId));
  const people = data.staff.filter((s) => s.active && String(s.src || '').indexOf(SRC_PREFIX) === 0);
  return data.posts
    .filter((p) => L.status(p, td).state === 'on' && L.isDate(p.publishOn) && daysBetween(p.publishOn, td) >= MIN_DAYS)
    .sort(L.sortBoard)
    .map((p) => ({
      id: p.id, title: String(p.title || '').trim(), days: daysBetween(p.publishOn, td),
      names: people.filter((s) => L.mustSign(s.unit, p) && !done.has(p.id + '\t' + s.id)).map((s) => s.name)
    }))
    .filter((g) => g.names.length > 0);
}

// 訊息本文；超過 MAX_CHARS 就截斷名單並加「…等」，第一行與最後的網址一定留著（#27 S1）
//   以碼點（Array.from）為單位累加，不切出孤立代理字元（emoji 是兩個 UTF-16 單位）；長度仍以 UTF-16 單位（String.length）計，
//   與小幫手 text.slice(0, 5000) 的算法一致。切點往回退到最後一個「、」或換行之前，不切斷姓名、尾端不留「、」。
function buildText(groups) {
  const head = '📋 佈告欄未簽提醒', foot = `請到 ${SITE} 簽名，謝謝！`, more = '…等';
  const body = groups.map((g) => `《${g.title}》上架 ${g.days} 天：${g.names.join('、')}`).join('\n');
  const full = head + '\n' + body + '\n' + foot;
  if (full.length <= MAX_CHARS) return full;
  const room = MAX_CHARS - head.length - foot.length - 2 - more.length;
  const cps = Array.from(body);
  let k = 0, len = 0;
  while (k < cps.length && len + cps[k].length <= room) len += cps[k++].length;
  let cut = cps.slice(0, k).join('');
  if (cps[k] !== '、' && cps[k] !== '\n') cut = cut.slice(0, Math.max(cut.lastIndexOf('、'), cut.lastIndexOf('\n'), 0));   // 切點在姓名中間：退回上一個分隔
  return head + '\n' + cut + more + '\n' + foot;
}

// unit=mala、在職、但沒有 gf: 來源的同仁（手動建的、刪除後又手動加回的）：不會被提醒，列給 Eason 對照回條（#27 建議 1）
//   mala 沒有門市欄位，分不出光復／美村／南昌，所以只列出、不納入提醒
function unsynced(staff) {
  return staff.filter((s) => s.active && s.unit === 'mala' && String(s.src || '').indexOf(SRC_PREFIX) !== 0).map((s) => s.name);
}
const UNSYNCED_TITLE = '⚠ 以下光復同仁不在打卡同步名單，不會被提醒';

async function runRemind(o) {
  const dir = o.dir, td = L.today(o.now || new Date());
  const res = { at: new Date().toISOString(), ok: false, people: 0, posts: 0, queued: 0 };
  let groups, text, miss = [];
  try {
    const data = loadData(dir);
    groups = pending(data, td);
    miss = unsynced(data.staff);
    res.posts = groups.length;
    res.people = groups.reduce((n, g) => n + g.names.length, 0);
    text = groups.length ? buildText(groups) : '';
  } catch (e) {
    res.error = J.errText(e);
    if (!o.dryRun) J.writeLast(dir, LAST, res);
    J.logLine(dir, LOG, '讀取資料失敗：' + res.error);
    return res;
  }
  const missText = miss.length ? `${UNSYNCED_TITLE}（${miss.length} 位）：${miss.join('、')}` : '';
  if (missText) J.logLine(dir, LOG, missText);           // 每天一行進 remind.log（本機檔，不外送）
  if (o.dryRun) {
    console.log(text || `（${td}：沒有人需要提醒，不會送出）`);
    if (missText) console.log('\n' + missText);
    res.ok = true; res.dryRun = true; res.text = text; res.unsynced = miss;   // 只回給呼叫端（測試用），--dry-run 不寫結果檔
    J.logLine(dir, LOG, `試跑（--dry-run，未送出）：${res.posts} 則公告、${res.people} 人次`);
    return res;
  }
  if (!groups.length) {
    res.ok = true;
    J.writeLast(dir, LAST, res);
    J.logLine(dir, LOG, `${td} 沒有人需要提醒，不送出`);
    return res;
  }
  const payload = { action: 'enqueue_text', token: o.token, label: LABEL, text };
  try {
    const r = await J.postHelperRetry(o.url, payload, { retryMs: o.retryMs, onRetry: (m) => J.logLine(dir, LOG, m) });   // 打法與重試共用 job-common.js（#28 抽出）
    res.queued = Number(r.queued) || 0;
    res.ok = true;
  } catch (e) { res.error = J.errText(e); }
  J.writeLast(dir, LAST, res);
  J.logLine(dir, LOG, (res.ok ? '已送進小幫手候補' : '送出失敗') + `：${res.posts} 則公告、${res.people} 人次、寫入 ${res.queued} 列` + (res.ok ? (res.queued ? '' : '（今天已送過，小幫手判重）') : '；' + res.error));
  return res;
}

async function main() {
  J.loadEnv(path.join(__dirname, '.env'));
  const dryRun = process.argv.includes('--dry-run');
  const { url, token } = J.helperEnv(process.env);
  if (!dryRun && (!url || !token)) { console.log('未設定 REMIND_ENQUEUE_URL／TOKEN，尚未啟用'); process.exit(0); }
  const retryMs = process.env.REMIND_RETRY_MS === undefined ? 5000 : Number(process.env.REMIND_RETRY_MS);
  const res = await runRemind({ dir: J.dataDir(process.env), url, token, dryRun, retryMs });
  if (!dryRun) console.log(JSON.stringify(res));
  process.exit(res.ok ? 0 : 1);
}

if (require.main === module) main().catch((e) => { console.error(J.errText(e)); process.exit(1); });
module.exports = { runRemind, pending, buildText, unsynced, daysBetween, loadData, LABEL, MAX_CHARS, UNSYNCED_TITLE };   // loadData 也給 punch-remind-push.js 用
