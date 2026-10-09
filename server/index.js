#!/usr/bin/env node
/* 鼎兆元｜電子佈告欄 — Mac mini 伺服器（Node.js，無第三方套件）
 * 商業邏輯沿用 gas/Service.js（與 Apps Script、本機假資料同一份），資料用 SQLite，簽名圖存硬碟，Google 動作走橋接。
 *
 * 環境變數（正式設定寫在 server/.env，不進 git）：
 *   PORT=8793  DATA_DIR=~/dzy-bulletin-data  BRIDGE_URL=<Apps Script 網址>  BRIDGE_KEY=<與 Apps Script 指令碼屬性相同>
 *   ALLOW_ORIGIN=https://dzy-bulletin.github.io（E2E 模式預設空白，且不得含正式網域）
 *   MAX_INFLIGHT_MB=200（同時累積中的請求體總量上限，依實際收到的位元組計；超過回 503 BUSY。
 *     註：原始位元組之外還有 Buffer.concat／toString／JSON.parse 的副本，實際記憶體約 3 倍，200MB ≈ 600MB）
 *   BODY_IDLE_MS=30000（請求體超過這麼久沒有新資料就中斷）；REQUEST_TIMEOUT_S=180（整個請求上限，含 27MB 附件經 4G 上傳）
 *   E2E=1（只在測試時開：/__seed、/__clock 等測試入口，改用假橋接）；E2E 必須明確指定非預設的 DATA_DIR，且不得設 BRIDGE_URL／BRIDGE_KEY
 *   BRIDGE_FAKE_DELAY_MS（E2E 假橋接每個動作延遲，阻塞測試用）；BRIDGE_FAKE_FAIL=1（E2E 假橋接一律失敗並回 AUTH，驗錯誤碼對應用）
 *   LINE_CHANNEL_ID=2011292256（選用；LINE 自動登入驗 ID token 用的 LINE Login 頻道 ID，預設就是鼎兆元打卡那個）
 *   LINE_LOGIN_PER_MIN=10、LINE_LOGIN_GLOBAL_PER_MIN=120（選用；lineLogin 真的要打 LINE verify 時才計數：每個來源 IP 每分鐘上限／全部加總每分鐘上限，超過回 BUSY）
 *
 * 不卡住事件迴圈（#6 審查發現 1）：Google 橋接一律 async，在 Service 之外 await。每個請求用自己的 files／clockSrc 墊片建 Service：
 * 墊片需要 Google 時丟出「待橋接」標記（Service 會先做完憑證與格式驗證才走到墊片，所以未授權的請求永遠不會打橋接），
 * index.js 接住後 await 真的橋接、把結果放進墊片，再重跑一次 Service。寫入交易只包 Service.WRITE_ACTIONS 的同步部分。
 *
 * 授權靠 token 不靠 CORS：cors() 只決定瀏覽器能不能讀回應；非允許 Origin 的請求照樣處理（與 GAS 相同），
 * 每個需要身分的動作都由 Service 驗 token／atoken。 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const MIN_NODE = 24;                                        // node:sqlite 的 DatabaseSync 不需旗標；DEPLOY.md 寫同一個數字
const MAX_BODY = 40 * 1024 * 1024;                          // 單一請求：附件 20MB → base64 約 27MB
const QUOTA_EVERY_MS = 10 * 60e3;                           // 雲端空間背景刷新間隔（請求路徑只讀快取）
const QUOTA_STALE_MS = 24 * 3600e3;                         // 快取超過 1 天（背景一直刷新失敗）就回 null，不顯示過時數字
const PENDING = 'BRIDGE_PENDING';                           // 墊片「待橋接」標記（只在伺服器內部流動，不會回給前端）
const PROD_ORIGIN = /dzy-bulletin\.github\.io/i;

function nodeProblem(v) {
  const major = parseInt(String(v || '').replace(/^v/, ''), 10);
  return major >= MIN_NODE ? '' : `需要 Node ${MIN_NODE} 以上（使用 node:sqlite），目前是 v${v}；請安裝 Node ${MIN_NODE}＋後再啟動`;
}

function loadEnv(file) {
  if (process.env.DZYB_NO_DOTENV === '1') return;          // 測試一律不讀 server/.env：已部署的機器上有真的 BRIDGE_URL／KEY，讀進來會讓 E2E 拒絕啟動，正式模式的測試還會打到真的 Apps Script
  try {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line) => {
      const m = /^\s*([A-Z_0-9]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    });
  } catch (e) {}
}

function defaultDataDir(env) { return path.join(env.HOME || '', 'dzy-bulletin-data'); }
function config(env) {
  const E2E = env.E2E === '1';
  const allowRaw = env.ALLOW_ORIGIN !== undefined ? env.ALLOW_ORIGIN : (E2E ? '' : 'https://dzy-bulletin.github.io');
  return {
    PORT: Number(env.PORT || 8793),
    DATA_DIR: path.resolve((env.DATA_DIR || defaultDataDir(env)).replace(/^~/, env.HOME)),
    DATA_DIR_SET: !!env.DATA_DIR,
    E2E,
    ALLOW: allowRaw.split(',').map((s) => s.trim()).filter(Boolean),
    MAX_INFLIGHT: Math.round((Number(env.MAX_INFLIGHT_MB) > 0 ? Number(env.MAX_INFLIGHT_MB) : 200) * 1024 * 1024),
    BRIDGE_URL: env.BRIDGE_URL || '', BRIDGE_KEY: env.BRIDGE_KEY || '',
    FAKE_DELAY_MS: Number(env.BRIDGE_FAKE_DELAY_MS) || 0,
    FAKE_FAIL: env.BRIDGE_FAKE_FAIL === '1',
    BODY_IDLE_MS: Number(env.BODY_IDLE_MS) > 0 ? Number(env.BODY_IDLE_MS) : 30000,
    REQUEST_TIMEOUT_MS: (Number(env.REQUEST_TIMEOUT_S) > 0 ? Number(env.REQUEST_TIMEOUT_S) : 180) * 1000,
    LINE_CHANNEL_ID: env.LINE_CHANNEL_ID || '2011292256',
    LINE_PER_MIN: Number(env.LINE_LOGIN_PER_MIN) > 0 ? Math.floor(Number(env.LINE_LOGIN_PER_MIN)) : 10,
    LINE_GLOBAL_PER_MIN: Number(env.LINE_LOGIN_GLOBAL_PER_MIN) > 0 ? Math.floor(Number(env.LINE_LOGIN_GLOBAL_PER_MIN)) : 120,
    LINE_VERIFY_URL: env.LINE_VERIFY_URL || 'https://api.line.me/oauth2/v2.1/verify'   // 只給測試指到本機假 LINE
  };
}
// 兩個路徑是否指同一個資料夾：存在就取真實路徑（解開符號連結），macOS APFS 預設不分大小寫，所以一律小寫比對（第 2 輪建議 3）
function realOrResolved(p) { try { return fs.realpathSync(p); } catch (e) { return path.resolve(p); } }
function samePath(a, b) { return realOrResolved(a).toLowerCase() === realOrResolved(b).toLowerCase(); }
// E2E 模式的保險（/__seed 可無金鑰清空全部資料）：回傳拒絕啟動的理由，沒問題回空字串
function e2eProblem(cfg, env) {
  if (!cfg.E2E) return '';
  if (cfg.ALLOW.some((o) => PROD_ORIGIN.test(o))) return 'E2E 測試模式不能搭配正式網域的 ALLOW_ORIGIN（/__seed 可無金鑰清空全部資料），拒絕啟動';
  if (!cfg.DATA_DIR_SET || samePath(cfg.DATA_DIR, defaultDataDir(env))) return 'E2E 測試模式必須用 DATA_DIR 指定一個測試用資料夾（不可是正式資料夾 ~/dzy-bulletin-data），拒絕啟動';
  if (cfg.BRIDGE_URL || cfg.BRIDGE_KEY) return 'E2E 測試模式不能設 BRIDGE_URL／BRIDGE_KEY（測試一律用假橋接；有真金鑰代表這是正式環境），拒絕啟動';
  return '';
}

// LINE ID token 驗證（lineLogin）：POST LINE 的 verify API → 要求 aud＝本頻道、exp 未過期 → 回 sub（LINE userId）。
// 憑證無效（LINE 回 4xx）＝null；網路錯誤或逾時（8 秒）丟出業務錯誤，前端退回選名字＋密碼。token 與 sub 都不寫進紀錄。
async function verifyLineToken(url, channel, idToken, nowMs) {
  let res, j;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id_token: idToken, client_id: channel }).toString(), redirect: 'error', signal: AbortSignal.timeout(8000) });
    if (res.status >= 400 && res.status < 500) return null;
    if (res.status !== 200) throw new Error('HTTP ' + res.status);
    j = await res.json();
  } catch (e) {
    console.error(new Date().toISOString() + ' LINE 驗證連不上：' + (e && e.name === 'TimeoutError' ? '逾時' : (e && e.message || e)));
    const be = new Error('LINE 驗證暫時連不上，請選你的名字登入'); be.code = 'LINE_DOWN'; be.business = true; throw be;
  }
  if (!j || String(j.aud) !== String(channel) || !(Number(j.exp) * 1000 > (nowMs || Date.now()))) return null;
  return typeof j.sub === 'string' && j.sub ? j.sub : null;
}

function makeApp(cfg) {
  const L = require(path.join(ROOT, 'js/logic.js'));
  const { makeAuth_ } = require(path.join(ROOT, 'gas/Auth.js'));
  const { makeService_ } = require(path.join(ROOT, 'gas/Service.js'));
  const { makeSqliteStore } = require('./store-sqlite.js');
  const { makeBridge, makeFakeBridge } = require('./bridge.js');
  const { judgeHealth } = require('./health-rules.js');
  const FL = require('./files-local.js');
  const J = require('./job-common.js');
  const { startAnnouncer } = require('./announce.js');

  const VERSION = (/VERSION: '([0-9.]+)'/.exec(fs.readFileSync(path.join(ROOT, 'js/config.js'), 'utf8')) || [])[1] || '?';
  const { DATA_DIR, E2E, ALLOW, MAX_INFLIGHT } = cfg;
  const READONLY_FILE = path.join(DATA_DIR, 'READONLY');   // 凍結開關：檔案存在＝寫入一律回 MOVED（回退用，見 #10）
  const nodeCrypto = {
    sha256Hex: (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex'),
    hmacB64url: (k, m) => crypto.createHmac('sha256', Buffer.from(k, 'utf8')).update(m, 'utf8').digest('base64url'),
    randomHex: (n) => crypto.randomBytes(n).toString('hex')
  };
  const auth = makeAuth_(nodeCrypto, L);
  const store = makeSqliteStore(DATA_DIR);
  const bridgeReady = E2E || !!(cfg.BRIDGE_URL && cfg.BRIDGE_KEY);
  const bridge = E2E ? makeFakeBridge(cfg.FAKE_DELAY_MS, cfg.FAKE_FAIL) : makeBridge(cfg.BRIDGE_URL, cfg.BRIDGE_KEY);
  const { BRIDGE_MSG } = require('./bridge.js');
  const WRITE = new Set(makeService_(L, {}, {}, {}, {}).WRITE_ACTIONS);
  let clockOffsetMs = 0;                                    // 只有 E2E 會改
  let announcer = null;                                     // #28 新公告通知（main() 啟動後經 startAnnounce 掛上）
  const clock = { nowMs: () => Date.now() + clockOffsetMs, today: () => L.today(new Date(Date.now() + clockOffsetMs)) };
  const ts = () => new Date().toISOString();

  // ---- 雲端空間：請求路徑只讀 kv 快取，背景每 10 分鐘刷新（請求永遠不碰 Google）----
  function cachedQuota() {
    try { const o = JSON.parse(store.kvGet('quota') || 'null'); return o && Date.now() - o.at < QUOTA_STALE_MS ? o.q : null; } catch (e) { return null; }
  }
  async function refreshQuota() {
    try { const q = await bridge.files.quota(); store.kvSet('quota', JSON.stringify({ at: Date.now(), q })); }
    catch (e) { console.error(ts() + ' quota 刷新失敗：' + (e.detail || e.message)); }
  }

  // ---- 每請求的墊片：需要 Google 時登記「要做的事」並丟出待橋接標記 ----
  function want(pre, fn) { pre.need = fn; const e = new Error('待橋接'); e.code = PENDING; throw e; }
  function shims(pre) {
    return {
      files: {
        upload: (name, mime, b64) => pre.uploaded || want(pre, async () => { pre.uploaded = await bridge.files.upload(name, mime, b64); }),
        share: (ids) => {
          const miss = ids.filter((id) => !pre.shared.has(id));
          if (miss.length) want(pre, async () => { await bridge.files.share(miss); miss.forEach((id) => pre.shared.add(id)); });
        },
        revoke: (ids) => { pre.revoke.push.apply(pre.revoke, ids); },   // 回應送出後才在背景撤銷（原本錯誤就吞掉）
        quota: () => cachedQuota()
      },
      clockSrc: { read: () => pre.clock || want(pre, async () => { pre.clock = await bridge.clockSrc.read(); }) },
      // LINE ID token：第一輪丟待橋接、在交易外 await LINE 的 verify，第二輪拿結果（null＝驗證失敗）。
      // E2E 模式不連 LINE：只認 'TEST:<uid>'（與本機假資料相同）
      // 限流只算「真的要去 LINE 驗證」的請求（Service 已擋掉空白／超長 idToken，#32-5）
      lineVerify: { verify: (tok) => (pre.line !== undefined ? pre.line : want(pre, async () => {
        if (lineBusy(pre.ip)) { const be = new Error('登入的人太多，請稍後再試'); be.code = 'BUSY'; be.business = true; throw be; }
        if (E2E) { const m = /^TEST:(.{1,64})$/.exec(String(tok)); pre.line = m ? m[1] : null; return; }
        pre.line = await verifyLineToken(cfg.LINE_VERIFY_URL, cfg.LINE_CHANNEL_ID, String(tok), Date.now());
      })) }
    };
  }

  // 跑一個 action：寫入動作才進交易；遇到待橋接就在交易外 await，再重跑（最多 3 輪）
  // 凍結檔在「每一輪進交易之後」才檢查：等 share／clock 橋接期間才建的 READONLY 也擋得住寫入（#12 審查 S1）。
  // uploadFile 不寫資料庫，但凍結期間上傳只會在 Drive 留孤兒檔，所以一併擋（N2）。
  // 每一輪用 q 的深拷貝：Service 會改 q.post（例如把 d.id 換成 prev.id），重跑時要跟 GAS 一樣從原始請求算指紋（S4）。
  const MOVED = { ok: false, code: 'MOVED', message: '系統搬家中，請稍後重新整理' };
  const frozen = () => fs.existsSync(READONLY_FILE);
  // lineLogin 限流（每個程序記憶體、滑動 1 分鐘；#32-5）：每次驗證都要打 LINE 的 verify API，公開網址不能讓人無限轉送。
  // 以來源 IP 分桶（每 IP LINE_PER_MIN），另有全體加總上限（LINE_GLOBAL_PER_MIN）——有人狂送時只擋他自己，
  // 偽造 X-Forwarded-For 換 IP 也只會撞到全體上限（全體被擋時同仁退回選名字＋密碼，功能仍在）。
  const lineByIp = new Map(), lineAll = [];
  const prune = (arr, now) => { while (arr.length && now - arr[0] >= 60e3) arr.shift(); };
  function lineBusy(ip) {
    const now = Date.now(), key = ip || '-';
    prune(lineAll, now);
    let mine = lineByIp.get(key) || [];
    prune(mine, now);
    if (lineByIp.size > 5000) for (const [k, v] of lineByIp) { prune(v, now); if (!v.length) lineByIp.delete(k); }   // 不讓 Map 無限長大
    if (mine.length >= cfg.LINE_PER_MIN || lineAll.length >= cfg.LINE_GLOBAL_PER_MIN) return true;
    mine.push(now); lineAll.push(now); lineByIp.set(key, mine); return false;
  }
  async function run(action, q, ip) {
    if ((WRITE.has(action) || action === 'uploadFile') && frozen()) return { out: MOVED, revoke: [] };
    const pre = { shared: new Set(), revoke: [], uploaded: null, clock: null, line: undefined, need: null, ip: ip || '' };
    for (let round = 0; round < 3; round++) {
      pre.need = null; pre.revoke = [];
      const sh = shims(pre);
      const svc = makeService_(L, store, sh.files, auth, clock, sh.clockSrc, sh.lineVerify);
      const out = WRITE.has(action)
        ? store.tx(() => { if (frozen()) return MOVED; store.purgeReqs(Date.now()); return svc.call(action, structuredClone(q)); })
        : svc.call(action, structuredClone(q));
      if (out.code !== PENDING || !pre.need) {
        const revoke = out.ok ? pre.revoke.slice() : [];
        if (!out.ok && pre.uploaded) revoke.push(pre.uploaded.id);    // 上傳後第二輪才失敗（例如通行碼剛更換）：撤掉孤兒檔
        return { out, revoke };
      }
      try { await pre.need(); }
      catch (e) {   // 業務錯誤（BAD_REQ 等）照原樣回；其餘只回伺服器自己的錯誤碼（絕不回 AUTH，否則前端會把主管登出），原文只進 stderr（S3）
        if (e && e.business) return { out: { ok: false, code: e.code, message: e.message }, revoke: [] };
        const code = e && e.code === 'BRIDGE_TIMEOUT' ? 'BRIDGE_TIMEOUT' : 'BRIDGE';
        console.error(ts() + ' 橋接失敗 ' + action + '：' + (e && (e.detail || e.message)));
        return { out: { ok: false, code, message: BRIDGE_MSG[code] }, revoke: [] };
      }
    }
    return { out: { ok: false, code: 'SERVER', message: '系統忙碌，請稍後再試' }, revoke: [] };
  }

  // ---- HTTP ----
  function cors(req, res) {
    const o = req.headers.origin || '';
    const ok = ALLOW.includes(o) || (E2E && /^http:\/\/localhost(:\d+)?$/.test(o));
    if (ok) { res.setHeader('Access-Control-Allow-Origin', o); res.setHeader('Vary', 'Origin'); }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  function send(res, code, obj, close) {
    const buf = Buffer.from(JSON.stringify(obj), 'utf8');
    const h = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': buf.length };
    if (close) h.Connection = 'close';
    res.writeHead(code, h);
    res.end(buf);
  }
  // 請求體總量上限：所有累積中的請求體加起來不超過 MAX_INFLIGHT（Funnel 是公開網址，記憶體才是風險）。
  // 依「實際收到的位元組」計，不用 Content-Length 預扣：只送 header 不送資料的連線不佔額度（#12 審查 B1）；
  // Content-Length 只用來提早擋超過 MAX_BODY 的請求。額度在回應送出後才釋放（上傳 await 期間 base64 仍在記憶體裡）。
  // 慢速連線：請求體 BODY_IDLE_MS 沒有新資料就中斷；整個請求另有 server.requestTimeout。
  let inflight = 0;
  function reserve(lease, n) { if (inflight + n > MAX_INFLIGHT) return false; inflight += n; lease.n += n; return true; }
  function release(lease) { inflight -= lease.n; lease.n = 0; }
  function tag(code) { const e = new Error(code); e.tag = code; return e; }
  function readBody(req, lease) {
    return new Promise((ok, no) => {
      const len = Number(req.headers['content-length']) || 0;
      const chunks = []; let n = 0, bad = len > MAX_BODY ? 'TOO_BIG' : '', done = false, drained = 0;
      const idle = () => { clearTimeout(timer); timer = setTimeout(() => { if (!done) { done = true; req.destroy(); no(tag('IDLE')); } }, cfg.BODY_IDLE_MS); };
      let timer = null; idle();
      // 超過上限時：丟掉已收的、剩下的照收照丟（最多再收 2×MAX_BODY，更大的直接斷線），收完才回 413／503，客戶端才讀得到回應（S6）
      const fail = (code) => { bad = code; chunks.length = 0; release(lease); };
      req.on('data', (c) => {
        if (done) return;
        idle();
        if (bad) { drained += c.length; if (drained > 2 * MAX_BODY) { done = true; clearTimeout(timer); req.destroy(); no(tag(bad)); } return; }
        n += c.length;
        if (n > MAX_BODY) return fail('TOO_BIG');
        if (!reserve(lease, c.length)) return fail('BUSY');
        chunks.push(c);
      });
      req.on('end', () => { if (done) return; done = true; clearTimeout(timer); if (bad) no(tag(bad)); else ok(Buffer.concat(chunks).toString('utf8')); });
      req.on('error', (e) => { if (done) return; done = true; clearTimeout(timer); no(e); });
    });
  }
  const BODY_ERR = {
    TOO_BIG: [413, { ok: false, code: 'TOO_BIG', message: '檔案太大' }],
    BUSY: [503, { ok: false, code: 'BUSY', message: '系統忙碌，請稍後再試' }]
  };
  // 來源 IP（只給 lineLogin 限流分桶）：經 Tailscale Funnel 進來的連線 socket 都是本機，取 X-Forwarded-For 第一段；沒有就用 socket 位址
  function clientIp(req) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    return (xff || (req.socket && req.socket.remoteAddress) || '').slice(0, 64);
  }
  function logLine(action, ms, out) {   // 每請求一行：時間 action 毫秒 ok/code（不記參數，供 #5 的伺服器端 p95）
    console.log(ts() + ' ' + (/^[A-Za-z]{1,32}$/.test(action) ? action : '-') + ' ' + ms + 'ms ' + (out.ok ? 'ok' : String(out.code)));
  }
  // 結果檔不存在＝還沒跑過（null）；存在但讀不到／JSON 壞掉＝at:null（燈號寫「結果檔讀不到」，不誤報成「沒有紀錄」）
  function job(file, pick) {
    let raw;
    try { raw = fs.readFileSync(path.join(DATA_DIR, 'logs', file), 'utf8'); } catch (e) { return e.code === 'ENOENT' ? null : pick({}); }
    try { return pick(JSON.parse(raw) || {}); } catch (e) { return pick({}); }
  }
  // 兩個背景工作各自的結果檔（server/mirror.js、server/daily.js）只挑狀態欄位帶出，錯誤原文不外露（#6 審查發現 3）。
  // mirror-last.json 的待回填筆數欄位叫 pending（#8），對外沿用 #6 的 sigPending；fails＝連續失敗次數（「連續 2 次 → 黃」用）；
  // mirror.missing／bad＝本機缺圖／壞圖筆數（>0 → 黃）；skipped＝人工略過筆數（只帶出、不轉黃）；backup.sharedWith＝備份資料夾共用者人數（>0 或 -1 讀不到 → 黃；null＝還沒回報）。
  // level／why：#8 監看判定（server/health-rules.js），守門可以直接看燈號，也可以自己拿 at 重算。
  function health() {
    let freeMB = null;
    try { const s = fs.statfsSync(DATA_DIR); freeMB = Math.floor(s.bavail * s.bsize / 1048576); } catch (e) {}
    const num = (v) => (v === undefined || v === null || isNaN(Number(v)) ? null : Number(v));
    const h = {
      ok: true, v: VERSION, uptime: Math.round(process.uptime()), e2e: E2E,
      bridge: (cfg.BRIDGE_URL && cfg.BRIDGE_KEY && !E2E) ? 'configured' : 'missing',
      mirror: job('mirror-last.json', (j) => ({ at: j.at || null, ok: !!j.ok, sigPending: num(j.pending !== undefined ? j.pending : j.sigPending), missing: num(j.missing) || 0, bad: num(j.bad) || 0, skipped: num(j.skipped) || 0, fails: num(j.fails) || 0, notMigrated: !!j.notMigrated })),
      backup: job('backup-last.json', (j) => ({ at: j.at || null, ok: !!j.ok, sharedWith: num(j.sharedWith) })),
      // M7（#18 D8）：附件本機備份（mirror.js 第 3 步寫在 mirror-last.json 的 files）；只挑六個狀態欄位，錯誤原文不外露
      files: job('mirror-last.json', (j) => { const f = j.files; if (!f || typeof f !== 'object') return null;
        return { count: num(f.count), bytes: num(f.bytes), pending: num(f.pending), stale: num(f.stale), skipped: num(f.skipped) || 0, lastScanAt: typeof f.lastScanAt === 'string' ? f.lastScanAt : null }; }),
      // #26 光復未簽提醒（server/sign-remind.js，選用）：只挑 at／ok／people；檔案不存在（沒裝或還沒啟用）＝null。最後一次失敗 → 黃
      remind: job('remind-last.json', (j) => ({ at: j.at || null, ok: !!j.ok, people: num(j.people) })),
      // #28 新公告上架通知（server/announce.js，伺服器內計時器）：null＝沒啟用（.env 沒設或 E2E）；啟用但第一輪還沒跑完＝四欄 null。最後一輪失敗、或有放棄的（gaveup>0）→ 黃
      announce: announcer ? (announcer.health() || { at: null, ok: null, pending: null, gaveup: null }) : null,
      disk: { freeMB }
    };
    return Object.assign(h, judgeHealth(h, Date.now()));
  }

  // ---- 測試入口（E2E=1 才有）：以帶入格式重設資料，密碼用真的雜湊 ----
  function seed(d) {
    const staff = d.staff.map((x) => {
      const salt = x.pin ? auth.newSalt() : '';
      return { id: x.id, name: x.name, unit: x.unit, salt, pinHash: x.pin ? auth.hashPin(salt, x.pin) : '', pinVer: 1, fail: x.fail || 0,
        active: true, createdAt: '2026-01-01T00:00:00.000Z', deletedAt: '', src: x.src || '', store: x.store || '',
        lineHash: x.lineUid ? auth.lineHash(x.lineUid) : '' };
    });
    const posts = d.posts.map((p) => Object.assign({ body: '', expiresOn: '', pinned: false, published: true, offOn: '', files: [],
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }, p));
    const reads = d.reads.map((r) => { const s = staff.find((x) => x.id === r.staffId); return { postId: r.postId, staffId: r.staffId, name: s.name, unit: s.unit, at: r.at, sigId: '' }; });
    store.load({ posts, staff, reads, log: [], admin: {} });
    fs.writeFileSync(path.join(DATA_DIR, 'ADMIN_INIT.txt'), d.adminPass);
    bridge.setClock(d.clock || []);
  }
  function testRoute(pathname, url, body, res) {
    if (pathname === '/__dropPost') { store.dropPost(String(body.id)); return send(res, 200, { ok: true }); }
    if (pathname === '/__seed') { seed(body.demo ? require(path.join(ROOT, 'js/demo-data.js'))(L) : body); return send(res, 200, { ok: true }); }
    if (pathname === '/__clock') { clockOffsetMs = (Number(body.offDays) || 0) * 86400e3; return send(res, 200, { ok: true, data: { today: clock.today() } }); }
    if (pathname === '/__clockActive') { const rows = bridge.getClock().rows; rows.forEach((r) => { if (r.empId === body.empId) r.active = !!body.on; }); bridge.setClock(rows); return send(res, 200, { ok: true }); }
    if (pathname === '/__adminInit') { fs.writeFileSync(path.join(DATA_DIR, 'ADMIN_INIT.txt'), String(body.pass)); return send(res, 200, { ok: true }); }
    if (pathname === '/__blob') return send(res, 200, { ok: true, data: bridge.blobOf(url.searchParams.get('id')) });
    if (pathname === '/__bridgeCalls') return send(res, 200, { ok: true, data: bridge.calls() });
    // M7：假橋接的 fileget／filelist（測試讓 mirror.js 第 3 步打這台伺服器的假 Drive）；本機 files/ 現況（run.py 驗移除後仍保留）
    if (pathname === '/__bridge') return bridge.call(String(body.op), body).then((d) => send(res, 200, { ok: true, data: d }), (e) => send(res, 200, { ok: false, code: e.code || 'SERVER', message: e.message }));
    if (pathname === '/__files') {
      const sc = FL.scan(DATA_DIR);
      return send(res, 200, { ok: true, data: sc.metas.map((id) => ({ id, meta: FL.readMeta(DATA_DIR, id), bytes: FL.hasBytes(DATA_DIR, id) })) });
    }
    return send(res, 404, { ok: false, code: 'NOT_FOUND', message: 'no' });
  }

  async function handle(req, res) {
    cors(req, res);
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Content-Length': 0 }); return res.end(); }
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, health());
    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, { ok: true, data: { app: 'dzy-bulletin-server', v: VERSION } });
    const isTest = E2E && url.pathname.startsWith('/__');
    if (isTest && req.method !== 'POST' && !/^\/__(blob|bridgeCalls)$/.test(url.pathname)) { req.resume(); return send(res, 405, { ok: false, code: 'BAD_REQ', message: '只收 POST' }); }
    if (req.method !== 'POST' && !isTest) { req.resume(); return send(res, 404, { ok: false, code: 'NOT_FOUND', message: '找不到' }); }
    if (req.method === 'POST' && url.pathname !== '/' && !isTest) { req.resume(); return send(res, 404, { ok: false, code: 'NOT_FOUND', message: '找不到' }); }
    const lease = { n: 0 };
    const t0 = Date.now();
    try {
      let raw;
      try { raw = req.method === 'POST' ? await readBody(req, lease) : ''; }
      catch (e) {
        const [code, obj] = BODY_ERR[e.tag] || [400, { ok: false, code: e.tag || 'BAD_REQ', message: '格式錯誤' }];
        logLine('-', Date.now() - t0, obj);
        if (e.tag !== 'IDLE' && !res.destroyed) send(res, code, obj, true);   // 慢速連線已被中斷，不回應
        return;
      }
      if (isTest) return testRoute(url.pathname, url, JSON.parse(raw || '{}'), res);
      let q;
      try { q = JSON.parse(raw); } catch (e) { const o = { ok: false, code: 'BAD_REQ', message: '格式錯誤' }; logLine('-', Date.now() - t0, o); return send(res, 400, o); }
      const action = String(q && q.action || '');
      let r;
      try { r = await run(action, q, clientIp(req)); }
      catch (e) { console.error(action + ': ' + (e && e.stack || e)); r = { out: { ok: false, code: 'SERVER', message: '系統忙碌，請稍後再試' }, revoke: [] }; }
      logLine(action, Date.now() - t0, r.out);
      send(res, 200, r.out);
      // M7（#18 D1）：附件本機備份。回應已送出、lease 還沒釋放（base64 佔的額度仍算在上限內）；失敗只進 stderr，
      // 之後由 mirror.js 第 3 步補（meta 寫進去了＝pending；meta 也沒寫進去＝公告引用時從 posts 補建）。不進 tx：不碰 SQLite。
      // 第二輪 Service 失敗（撤孤兒檔那條路，out.ok=false）不存。
      if (action === 'uploadFile' && r.out.ok && r.out.data) {
        const fid = r.out.data.id;
        try { const w = await FL.saveLocal(DATA_DIR, fid, q.name, q.data, r.out.data.size); if (w) console.error(ts() + ' 附件本機備份 ' + fid + '：' + w); }
        catch (e) { console.error(ts() + ' 附件本機備份失敗 ' + (FL.validId(fid) ? fid : '-') + '：' + (e && (e.code || e.message))); }
      }
      // 移除後永久保留：送 revoke 之前先確保 meta 存在並標 removedAt（位元組永遠不刪，revoke 只動 Drive）
      if (action === 'savePost' && r.out.ok && r.revoke.length) {
        for (const fid of r.revoke) {
          try { await FL.markRemoved(DATA_DIR, fid, ''); } catch (e) { console.error(ts() + ' 附件移除標記失敗 ' + (FL.validId(fid) ? fid : '-') + '：' + (e && (e.code || e.message))); }
        }
      }
      if (r.revoke.length) Promise.resolve().then(() => bridge.files.revoke(r.revoke)).catch((e) => console.error('revoke: ' + e.message));
    } finally { release(lease); }
  }

  // #28：新公告上架通知計時器（E2E 不啟動、.env 沒設不啟動；判斷在 announce.js startAnnouncer）
  function startAnnounce(env) {
    const { url, token } = J.helperEnv(env);
    announcer = startAnnouncer({ store, dir: DATA_DIR, url, token, e2e: E2E,
      everyMs: Number(env.ANNOUNCE_EVERY_MS) || 0, retryMs: env.ANNOUNCE_RETRY_MS === undefined ? 5000 : Number(env.ANNOUNCE_RETRY_MS) });
    return announcer;
  }

  return {
    handle, store, refreshQuota, bridgeReady, VERSION, startAnnounce,
    onRequest: (req, res) => { handle(req, res).catch((e) => { console.error(e); try { send(res, 500, { ok: false, code: 'SERVER', message: '系統忙碌' }, true); } catch (x) {} }); }
  };
}

function main() {
  const bad = nodeProblem(process.env.DZYB_NODE_VERSION || process.versions.node);   // DZYB_NODE_VERSION 只給測試注入
  if (bad) { console.error('✗ ' + bad); process.exit(1); }
  loadEnv(path.join(__dirname, '.env'));
  const cfg = config(process.env);
  const e2eBad = e2eProblem(cfg, process.env);
  if (e2eBad) { console.error('✗ ' + e2eBad); process.exit(1); }
  const app = makeApp(cfg);
  if (app.bridgeReady) { app.refreshQuota(); setInterval(app.refreshQuota, QUOTA_EVERY_MS); }
  const server = http.createServer(app.onRequest);
  server.headersTimeout = 15000;                           // header 15 秒內要送完
  server.requestTimeout = cfg.REQUEST_TIMEOUT_MS;           // 整個請求（含請求體）上限
  server
    .listen(cfg.PORT, '127.0.0.1', () => {
      console.log(new Date().toISOString() + ` 佈告欄伺服器 v${app.VERSION} 啟動：127.0.0.1:${cfg.PORT}，資料 ${cfg.DATA_DIR}${cfg.E2E ? '（E2E 測試模式）' : ''}`);
      app.startAnnounce(process.env);                       // #28：啟動時先跑一次，之後每小時（ANNOUNCE_EVERY_MS）
    });
}

if (require.main === module) main();
module.exports = { nodeProblem, config, e2eProblem, makeApp, verifyLineToken, MIN_NODE };
