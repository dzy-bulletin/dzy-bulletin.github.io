#!/usr/bin/env node
/* 鼎兆元｜電子佈告欄 — 打卡回覆帶出未簽公告（launchd com.dzy.bulletin.punchremind，每 5 分鐘；規格 docs/punch-remind.md）
 *   算出「每個 LINE 帳號（lineHash）還有哪些要簽、還沒簽的公告」，整包送到光復打卡 Apps Script（line_hub_bulletin_put）放著；
 *   同仁 LINE 打卡成功時，機器人回覆卡片只讀那包，不即時連這台（Apps Script 的 UrlFetch 不能設逾時）。
 *   要提醒＝上架中（L.status on）＋看得到（L.canSee，含 seeAll）＋要簽（L.mustSign）＋reads 沒有那一列；當天上架就算。
 *   沒有人要提醒也照送空 map，機器人那邊才會把簽完的人清掉。
 * 不經 makeSqliteStore（見 job-common.js）：唯讀連線，只做 SELECT（loadData 與 sign-remind.js 共用）。
 *
 * 結果寫 DATA_DIR/logs/punch-remind-last.json＝{ at, ok, people, posts, bytes, trimmed, error }（只數字，不寫姓名、不寫標題）；
 *   每次一行進 logs/punch-remind.log。連線失敗重試 1 次；對方明確回 ok:false（金鑰錯、太大）不重試。
 *
 * 用法：node server/punch-remind-push.js            （launchd 每 5 分鐘）
 *       node server/punch-remind-push.js --dry-run  （只印人數與則數、不送出、不寫結果檔）
 * 環境變數：DATA_DIR  PUNCH_REMIND_URL（光復打卡 /exec）  PUNCH_REMIND_KEY（＝光復 Script Property BULLETIN_PUSH_KEY）；
 *   沒設定 → 印「尚未啟用」並 exit 0。PUNCH_REMIND_RETRY_MS（重試前等幾毫秒，預設 5000，只給測試縮短） */
'use strict';
const path = require('path');
const J = require('./job-common.js');
const { loadData } = require('./sign-remind.js');
const L = require(path.join(__dirname, '..', 'js', 'logic.js'));

const LAST = 'punch-remind-last.json', LOG = 'punch-remind.log';
const LIST_MAX = 3;                 // 卡片最多列幾則標題（其餘寫「還有 N 則」，機器人那邊組字）
const TITLE_MAX = 30;               // 每則標題最多幾個字（碼點），超過截斷加「…」
const MAX_BYTES = 90000;            // 機器人 CacheService 單一值上限 100KB，留餘裕
const HASH_RE = /^[0-9a-f]{64}$/;

// 標題：換行／連續空白變一個空白；以碼點計長度，不切壞 emoji
function cleanTitle(t) {
  const s = String(t || '').replace(/\s+/g, ' ').trim();
  if (!s) return '（無標題）';
  const cps = Array.from(s);
  return cps.length > TITLE_MAX ? cps.slice(0, TITLE_MAX).join('') + '…' : s;
}

// 純函式：{ <lineHash>: { n, titles } }，只放 n ≥ 1 的人。同一個 lineHash 對到多位在職同仁（同步端本來就擋）時合併、去重
function pendingByLine(data, td) { return collect(data, td).map; }
// map＋有人要提醒的公告 id（結果檔的 posts 用）
function collect(data, td) {
  const done = new Set(data.reads.map((r) => r.postId + '\t' + r.staffId));
  const posts = data.posts.filter((p) => L.status(p, td).state === 'on').sort(L.sortBoard);
  const ids = {};
  data.staff.forEach((s) => {
    if (!s.active || !HASH_RE.test(String(s.lineHash || ''))) return;
    posts.forEach((p) => {
      if (!L.canSee(s.unit, p, s.seeAll === true) || !L.mustSign(s.unit, p) || done.has(p.id + '\t' + s.id)) return;
      (ids[s.lineHash] = ids[s.lineHash] || new Set()).add(p.id);
    });
  });
  const out = {}, used = new Set();
  Object.keys(ids).forEach((h) => {
    const mine = posts.filter((p) => ids[h].has(p.id));     // 照 sortBoard 的順序
    mine.forEach((p) => used.add(p.id));
    out[h] = { n: mine.length, titles: mine.slice(0, LIST_MAX).map((p) => cleanTitle(p.title)) };
  });
  return { map: out, posts: used };
}

// 送出的 body；超過 MAX_BYTES 改每人只留第 1 則標題。仍超過就照送，機器人回 too_big → ok:false、/health 黃燈（不偷偷送空的）
function buildPayload(map, at, key) {
  const make = (m) => { const payload = { action: 'line_hub_bulletin_put', key, at, v: 1, map: m }; return { payload, bytes: Buffer.byteLength(JSON.stringify(payload), 'utf8') }; };
  let r = make(map), trimmed = false;
  if (r.bytes > MAX_BYTES) {
    const m = {}; Object.keys(map).forEach((h) => { m[h] = { n: map[h].n, titles: map[h].titles.slice(0, 1) }; });
    r = make(m); trimmed = true;
  }
  return { payload: r.payload, bytes: r.bytes, trimmed };
}

async function runPush(o) {
  const dir = o.dir, now = o.now || new Date(), td = L.today(now);
  const res = { at: new Date().toISOString(), ok: false, people: 0, posts: 0, bytes: 0, trimmed: false };
  const release = J.takeLock(dir, 'punch-remind', 4 * 60e3);
  if (!release) { J.logLine(dir, LOG, '上一輪還在跑，這輪跳過'); return Object.assign(res, { ok: true, skipped: true }); }
  try {
    let c;
    try { c = collect(loadData(dir), td); }
    catch (e) {
      res.error = J.errText(e);
      if (!o.dryRun) J.writeLast(dir, LAST, res);
      J.logLine(dir, LOG, '讀取資料失敗：' + res.error);
      return res;
    }
    res.people = Object.keys(c.map).length;
    res.posts = c.posts.size;
    const b = buildPayload(c.map, now.toISOString(), o.key);
    res.bytes = b.bytes; res.trimmed = b.trimmed;
    if (o.dryRun) {
      console.log(`（試跑，未送出）${td}：${res.people} 人有未簽公告、整包 ${res.bytes} bytes${res.trimmed ? '（已裁切）' : ''}`);
      res.ok = true; res.dryRun = true;
      J.logLine(dir, LOG, `試跑（--dry-run，未送出）：${res.people} 人`);
      return res;
    }
    try {
      await J.postHelperRetry(o.url, b.payload, { retryMs: o.retryMs, onRetry: (m) => J.logLine(dir, LOG, m) });
      res.ok = true;
    } catch (e) { res.error = J.errText(e).replace(/小幫手/g, '打卡機器人'); }   // job-common 的字句寫的是小幫手，這支送的是光復打卡
    J.writeLast(dir, LAST, res);
    J.logLine(dir, LOG, (res.ok ? '已送到打卡機器人' : '送出失敗') + `：${res.people} 人、${res.bytes} bytes` + (res.trimmed ? '（已裁切）' : '') + (res.ok ? '' : '；' + res.error));
    return res;
  } finally { release(); }
}

async function main() {
  J.loadEnv(path.join(__dirname, '.env'));
  const dryRun = process.argv.includes('--dry-run');
  const url = process.env.PUNCH_REMIND_URL || '', key = process.env.PUNCH_REMIND_KEY || '';
  if (!dryRun && (!url || !key)) { console.log('未設定 PUNCH_REMIND_URL／PUNCH_REMIND_KEY，尚未啟用'); process.exit(0); }
  const retryMs = process.env.PUNCH_REMIND_RETRY_MS === undefined ? 5000 : Number(process.env.PUNCH_REMIND_RETRY_MS);
  const res = await runPush({ dir: J.dataDir(process.env), url, key, dryRun, retryMs });
  if (!dryRun) console.log(JSON.stringify(res));
  process.exit(res.ok ? 0 : 1);
}

if (require.main === module) main().catch((e) => { console.error(J.errText(e)); process.exit(1); });
module.exports = { pendingByLine, buildPayload, runPush, cleanTitle, LIST_MAX, TITLE_MAX, MAX_BYTES };
