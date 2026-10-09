#!/usr/bin/env node
/* 鼎兆元｜電子佈告欄 — 每小時鏡像工作（launchd com.dzy.bulletin.mirror，StartInterval 3600；同一個 job 不會重疊）
 *   1. 簽名回填：找出 driveSigId 空白、本機有圖的已讀，批次（一次 ≤20 張、一次橋接呼叫）經 `sigs` op 上傳到 Drive 簽名資料夾，
 *      回填 driveSigId（只寫這一欄）。每輪最多 SIG_MAX_PER_RUN 張，避免撞 Apps Script 6 分鐘上限。這同時是簽名圖的異地備份。
 *      M2 契約：saveSigs 逐張處理，失敗的那張回 null——拿到 id 的照常回填，null 的留到下一輪只重傳它（不整批作廢，#14 B1）。
 *   2. 鏡像：Mac mini 正本整份寫回試算表四分頁（走 `mirror` op；Apps Script 先寫暫存分頁再換名，見 gas/Store.js）。
 *      四份資料＋待回填清單在同一個讀交易裡取（同一個快照，#14 S1），COMMIT 之後才呼叫橋接（不在交易開著時等 Google，免得擋住 checkpoint）。
 *      已讀帶 driveSigId（Drive id），試算表「簽名檔 id」只寫它、還沒回填的留空——回退到 GAS 後 readSig(id) 才讀得到。
 *   先回填再鏡像：這一輪剛拿到的 Drive id 就跟著這一輪寫進試算表。
 *   3. 附件補齊（M7，#18 D3～D6）：Mac mini 保留公告附件的位元組（DATA_DIR/files/，格式見 server/files-local.js），只當備份。
 *      待補清單每輪從檔案系統算出來、不另存：① files/*.json 有 meta 沒位元組 ② 公告目前引用、本機沒 meta 的（當場補建 meta）
 *      ③ 每天第一輪（台北日期換了）用 `filelist` 掃附件資料夾（含垃圾桶）補建 meta；扣掉位元組已在的與 logs/file-skip.json 列的。
 *      逐檔用 `fileget` 分段下載（每段 ≤ 8MB）到 .tmp，收齊後 md5（Drive 的 md5Checksum）與 size 都對才 rename；每輪上限 10 個檔或 100MB。
 *      與鏡像完全隔開（D4）：第 3 步自己 try/catch，**不寫進 errs**，不影響 ok／pending／fails（回退門檻與守門的鏡像燈號），
 *      結果只寫在 mirror-last.json 的 files：{ ok, count, bytes, pending, stale, fetched, failed, skipped, lastScanAt, … }。
 *      失敗語意（D5，與上面簽名的簡化設計一致）：橋接錯誤、fileget 回 file:null（Drive 找不到）、md5／size 不符，一律暫時故障——
 *      刪 .tmp、留 pending、同一輪不重試、剩下的檔照常繼續；程式永遠不判定放棄。要放棄由人寫進 logs/file-skip.json＝{ "<fileId>": "原因" }
 *      （格式同 sig-skip.json；格式錯就 files.ok=false、這一輪不略過任何一個），略過的另計 skipped、不轉黃。
 *      /health：files.stale（待補超過 24 小時）> 0 → 黃；pending > 0 但 stale = 0 是正常排隊，不轉燈。
 *
 *   4. LINE 綁定刷新（2026-10-09，LINE 自動登入）：經橋接 `clock` 讀打卡名單（只有 lineHash，沒有 LINE userId），
 *      在一筆寫入交易裡只更新同仁的 lineHash（規則 js/logic.js lineHashUpdates，與 Service.syncClock 共用）——
 *      不新增、不刪除同仁，不需要管理通行碼。讀不到（橋接失敗）就記一行紀錄、跳過，不影響 ok／fails；結果在 mirror-last.json 的 line。
 *      --all／--files* 不做。鏡像（第 2 步）送出的同仁一律拿掉 lineHash，試算表不存這一欄的值。
 *
 * 壞圖只由本機判定（#14 第 5 輪設計簡化，Eason 拍板的「直接驗證」）：
 *   0 位元組；PNG 開頭不是 89 50 4E 47 或結尾沒有 IEND chunk；JPEG 開頭不是 FF D8 FF 或結尾不是 FF D9 → 本機檔損毀，計入 bad、不上傳。
 *   本機驗過的圖，saveSigs 回 null 只剩「Drive 端出錯」（createFile 丟錯），所以 Drive 端失敗一律視為暫時故障：
 *   不計數、不判壞，留在 pending，下一輪自然重試。每小時模式有失敗就 ok:false（連續失敗 → /health 黃燈）。
 *   --all 重複掃描到 pending=0 才 exit 0；一整輪沒有任何進展（上傳成功 0 張而 pending>0）就停下、exit 1，
 *   印出「Drive 端有 N 張傳不上去，稍後再跑；多次重跑仍失敗請找 MacBook Claude」並列出是哪幾張。
 *   逃生門（只能人手動做，程式永遠不自動判定）：真的有某張本機驗過、Drive 卻永遠拒收（或本機壞圖／缺圖確認放棄），
 *   在 logs/sig-skip.json 加一筆 { "<postId>/<staffId>": "原因" }，mirror 就跳過它、另計 skipped（不算 bad／missing，/health 不因此轉黃）。
 *   檔案格式錯：照常上傳、這一輪不略過任何一張、ok:false 並寫原因。對不到任何已讀的鍵（打錯字）會列在警告裡。
 *
 * 待回填的四種狀態（#14 S2／S14；回退步驟「回填到 pending=0」的判準就是 pending）：
 *   pending＝本機有圖、驗過、還沒回填、沒被人工略過（mirror.js 還能處理的）
 *   missing＝有 sigId 但本機找不到圖檔、沒被人工略過（傳不了，列出清單讓人決定）
 *   bad    ＝本機檔損毀、沒被人工略過；列出清單並寫原因
 *   skipped＝寫在 sig-skip.json 的（人已判斷過）；列出清單，但不讓 /health 轉黃
 *   missing／bad 大於 0 時印警告並列出是哪幾筆，但不卡住；/health 亮黃。
 * 「已上傳、還沒寫進庫」的 Drive id 記在 logs/sig-state.json 的 unsaved，下一輪先寫、不重傳（避免孤兒檔）。
 *   不要手改或刪掉這個檔（刪掉會讓那些圖再傳一次、變成孤兒檔）；壞掉或型別不對會改名成 .corrupt-* 保留並 ok:false。
 * 結果寫 DATA_DIR/logs/mirror-last.json＝{ at, ok, uploaded, pending, missing, bad, skipped, failed, fails, …Ids }（--all 每輪更新 at 當心跳），
 *   每輪一行進 logs/mirror.log。fails＝連續失敗次數（守門規則「mirror.ok=false 連續 2 次 → 黃」用）；failed＝這一輪 Drive 端傳不上去的張數。
 * 還原防呆（#14 S5）：posts／staff／reads／log 任一比上次成功送出的筆數少就不送（多半是剛從快照還原，試算表比本機新）、ok:false。
 * 橋接出錯不在同一輪重試（橋接打的是會排隊的 Apps Script，重試只會更塞）。
 *
 * 用法：node server/mirror.js          （launchd 每小時）
 *       node server/mirror.js --all    （回退前手動跑：不設每輪上限、重複掃描；完成條件是印出 pending=0 並 exit 0，見 #10）
 *       node server/mirror.js --force  （還原後、確認試算表可被覆寫時手動跑：越過筆數防呆，並帶 force:true 給 Apps Script）
 *       --all 不做第 3 步（附件與回退無關，不拖長回退窗口；files 欄位沿用上一輪）；庫不存在或是空庫（還沒搬遷）也不做。以下三個只做第 3 步、不碰簽名與鏡像：
 *       node server/mirror.js --files        （不設上限補到 pending=0 才 exit 0；CUTOVER 之後首次拉檔用。分批做、每批放掉鏡像鎖，每小時那輪照常插得進來）
 *       node server/mirror.js --files-scan   （先 filelist 掃附件資料夾〔含垃圾桶〕再補；**M7 部署當天必跑一次**、切回 Mac mini 後也跑一次）
 *       node server/mirror.js --files-verify （重算本機每個附件的 sha256 與 meta 比對，不符的列出來、不自動刪）
 *   手動執行撞到另一輪正在跑時印「已跳過」並以非 0 結束。
 * 環境變數：DATA_DIR  BRIDGE_URL  BRIDGE_KEY（server/.env）；SIG_BATCH（每批張數，預設 15、上限 20）；SIG_MAX_PER_RUN（預設 60）；
 *   FILES_MAX_PER_RUN（第 3 步每輪最多幾個檔，預設 10）；FILES_MAX_MB_PER_RUN（每輪最多下載幾 MB，預設 100） */
'use strict';
const fs = require('fs');
const path = require('path');
const J = require('./job-common.js');
const FL = require('./files-local.js');

const SIGS_MAX = 20;                                        // 與 gas/Code.js SIGS_MAX_ 相同：Apps Script 一次最多收 20 張
const LAST = 'mirror-last.json', STATE = 'sig-state.json', SKIP = 'sig-skip.json';
const LIST_MAX = 50;                                        // 結果檔與警告最多列幾筆
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47]), PNG_TAIL = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);   // IEND＋CRC
const JPG_HEAD = Buffer.from([0xff, 0xd8, 0xff]), JPG_TAIL = Buffer.from([0xff, 0xd9]);

// 本機驗圖：開頭與結尾都對才算完整（前端只產生 PNG／JPEG；寫到一半就截斷的圖結尾會缺）。讀不到＝缺圖，由 hasFile 判
function localDamaged(file) {
  let b;
  try { b = fs.readFileSync(file); } catch (e) { return false; }
  const at = (sig, i) => b.length >= sig.length && b.subarray(i, i + sig.length).equals(sig);
  if (at(PNG_HEAD, 0)) return !at(PNG_TAIL, b.length - PNG_TAIL.length);
  if (at(JPG_HEAD, 0)) return !at(JPG_TAIL, b.length - JPG_TAIL.length);
  return true;                                               // 0 位元組或不是 PNG／JPEG
}
const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const allStrings = (o) => Object.values(o).every((x) => typeof x === 'string' && x);
function clampInt(v, dflt, lo, hi) { const n = Math.floor(Number(v)); return n >= lo ? Math.min(n, hi) : dflt; }
const keyOf = (r) => r.postId + '\t' + r.staffId + '\t' + r.sigId;   // 含 sigId：同一格被重建成別張圖時，舊的 unsaved id 不沿用
const label = (r) => r.postId + '/' + r.staffId;

// ================= 3. 附件補齊（M7，#18） =================
const FILE_SKIP = 'file-skip.json';
const SEG = 8 * 1024 * 1024;                                 // 與 gas/Code.js FILEGET_MAX_ 相同：每段 ≤ 8MB 原始位元組
const SEG_MAX = 8;                                           // 每個檔最多幾段（附件 ≤ 20MB＝3 段；多留餘裕，防 eof 永遠不來）
const STALE_MS = 24 * 3600e3, TMP_OLD_MS = 3600e3;
const DEAD_MAX = 2;                                          // 每輪最多重試幾個「上次 Drive 回找不到」的檔（死檔另計額度，不吃掉 10 個的名額）
const taipeiDay = (ms) => J.taipeiStamp(new Date(ms)).slice(0, 10);

// 下載一個檔：成功回 { ok:true, size }；暫時故障回 { ok:false, why }（呼叫端記 failed、留 pending）。.tmp 一律不殘留。
async function fetchFile(o, id, meta, nowIso) {
  const dest = FL.bytesPath(o.dir, id), tmp = dest + '.tmp-' + process.pid;
  const md5 = require('crypto').createHash('md5'), sha = require('crypto').createHash('sha256');
  let off = 0, file = null;
  try {
    fs.mkdirSync(FL.filesDir(o.dir), { recursive: true });
    fs.writeFileSync(tmp, '');
    for (let seg = 0; ; seg++) {
      if (seg >= SEG_MAX) return { ok: false, why: '段數超過上限' };
      let out;
      try { out = await o.bridge.call('fileget', { id, off, len: SEG }, 120); }
      catch (e) { return { ok: false, why: J.errText(e) }; }   // 橋接錯誤：暫時故障，同一輪不重試（不去撞排隊中的 Apps Script）
      if (o.touch) o.touch();
      if (!out || !out.file) return { ok: false, dead: true, why: 'Drive 上找不到（暫時，不判遺失）' };
      if (!file) file = out.file;
      const size = Number(file.size);
      if (out.off !== off || typeof out.data !== 'string' || !(size >= 0)) return { ok: false, why: 'fileget 回應格式不符' };
      const buf = Buffer.from(out.data, 'base64');
      if (buf.length !== Math.min(SEG, size - off)) return { ok: false, why: 'fileget 段落長度不符' };
      fs.appendFileSync(tmp, buf); md5.update(buf); sha.update(buf); off += buf.length;
      if (off >= size) break;
      if (out.eof) return { ok: false, why: 'fileget 提早結束' };
    }
    // 完整性：Drive 的 md5Checksum 與 size 都對才 rename（D4）；不符＝這一輪下載壞了，下一輪重抓
    const got = md5.digest('hex');
    if (!file.md5 || got !== String(file.md5).toLowerCase() || off !== Number(file.size)) return { ok: false, why: 'md5／size 與 Drive 不符' };
    // 寫之前重讀一次 meta 再合併：下載這幾分鐘裡主管剛好在伺服器上移除它（markRemoved 寫了 removedAt），不可以蓋掉
    const cur = FL.readMeta(o.dir, id) || meta;
    const m = Object.assign({}, cur, { name: cur.name || String(file.name || ''), mime: String(file.mime || cur.mime || ''), size: off, md5: got, sha256: sha.digest('hex'), savedAt: nowIso, lastTryAt: nowIso, lastDead: false });
    if (file.trashed && !m.removedAt) { m.removedAt = nowIso; m.removedNote = '補抓時已在 Drive 垃圾桶，實際移除時間不可知'; }
    FL.writeMeta(o.dir, id, m);                               // meta 先寫、位元組後寫（D0）
    fs.renameSync(tmp, dest);
    return { ok: true, size: off };
  } catch (e) {
    return { ok: false, why: J.errText(e) };
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) {}                  // rename 成功後已不存在；其他情況一律清掉
  }
}

// o：{ dir, bridge, unlimited, scan（強制掃描）, now（毫秒，測試用）, maxCount, maxMB, touch }；prev＝上一輪的 files（取 lastScanAt）
async function fillFiles(o, prev) {
  const now = o.now || Date.now(), nowIso = new Date(now).toISOString(), dir = o.dir;
  const f = { ok: true, count: 0, bytes: 0, pending: 0, stale: 0, fetched: 0, failed: 0, skipped: 0, lastScanAt: (prev && prev.lastScanAt) || null };
  const errors = [], warns = [], failed = new Map();
  // 人工略過清單：格式錯就 ok:false、這一輪不略過任何一個（補抓照常）
  const sk = J.readState(dir, FILE_SKIP);
  let skip = {};
  if (sk.corrupt || (sk.v && !(plain(sk.v) && allStrings(sk.v)))) { f.ok = false; errors.push(`logs/${FILE_SKIP} 格式錯誤（應為 { "<fileId>": "原因" }），這一輪不略過任何一個`); }
  else if (sk.v) skip = sk.v;
  const isSkipped = (id) => Object.prototype.hasOwnProperty.call(skip, id);
  // 殘留暫存檔（下載或上傳中途當掉）：超過 1 小時的才清（伺服器可能正在寫它自己的 .tmp）
  const sc0 = FL.scan(dir);
  sc0.tmps.forEach((n) => { const p = path.join(FL.filesDir(dir), n); try { if (now - fs.statSync(p).mtimeMs > TMP_OLD_MS) fs.unlinkSync(p); } catch (e) {} });
  // 有位元組沒 meta（只可能是人手動放的）：補 meta
  sc0.bytes.filter((id) => !sc0.metas.includes(id)).forEach((id) => {
    try { const b = fs.readFileSync(FL.bytesPath(dir, id)), h = FL.hashes(b); FL.writeMeta(dir, id, { name: '', mime: '', size: b.length, md5: h.md5, sha256: h.sha256, savedAt: nowIso, wantedAt: nowIso, source: 'local' }); }
    catch (e) { warns.push('補 meta 失敗 ' + id + '：' + J.errText(e)); }
  });
  const ensure = (id, base) => {   // 沒 meta 才建；回傳是否新建
    if (!FL.validId(id) || FL.readMeta(dir, id)) return false;
    try { FL.writeMeta(dir, id, Object.assign({ wantedAt: nowIso }, base)); return true; } catch (e) { warns.push('建 meta 失敗 ' + id + '：' + J.errText(e)); return false; }
  };
  // 第二層：公告目前引用的附件（D1 全失敗也補得回來）。只 SELECT，不寫 DB
  try {
    const db = J.openDb(dir, { readOnly: true });
    try {
      J.rows(db, 'SELECT json FROM posts').forEach((r) => {
        let p = null; try { p = JSON.parse(r.json); } catch (e) {}
        ((p && Array.isArray(p.files)) ? p.files : []).forEach((x) => { if (x && typeof x.id === 'string') ensure(x.id, { name: String(x.name || ''), mime: FL.mimeOf(x.name), size: Number(x.size) || 0, source: 'posts' }); });
      });
    } finally { db.close(); }
  } catch (e) { warns.push('讀不到公告清單（這一輪只補已有 meta 的）：' + J.errText(e)); }
  // 第三層：filelist（指定時機：--files-scan，或每天第一輪＝台北日期換了）
  if (f.lastScanAt && isNaN(Date.parse(f.lastScanAt))) f.lastScanAt = null;   // 壞掉（手改）當作沒掃過，這一輪重掃並重寫，不永久失敗
  if (!o.noScan && (o.scan || !f.lastScanAt || taipeiDay(Date.parse(f.lastScanAt)) !== taipeiDay(now))) {
    try {
      let token = '', n = 0, made = 0;
      for (let page = 0; page < 500; page++) {
        const out = await o.bridge.call('filelist', { pageToken: token }, 120);
        if (!out || !Array.isArray(out.files)) throw new Error('filelist 回應格式不符');
        out.files.forEach((x) => {
          if (!x || !FL.validId(x.id) || !FL.okMime(x.mime)) return;   // Apps Script 已過白名單，這裡再擋一次
          n++;
          const base = { name: String(x.name || ''), mime: String(x.mime || ''), size: Number(x.size) || 0, md5: String(x.md5 || ''), source: 'filelist' };
          if (x.trashed) Object.assign(base, { trashed: true, removedAt: nowIso, removedNote: '掃描時已在 Drive 垃圾桶，實際移除時間不可知' });
          if (ensure(x.id, base)) made++;
          else if (x.trashed) {   // 已有 meta（例如回退到 GAS 期間主管移除的）：補標 removedAt
            const m = FL.readMeta(dir, x.id);
            if (m && !m.removedAt) { try { FL.writeMeta(dir, x.id, Object.assign(m, { trashed: true, removedAt: nowIso, removedNote: '掃描時已在 Drive 垃圾桶，實際移除時間不可知' })); } catch (e) {} }
          }
        });
        token = typeof out.nextPageToken === 'string' ? out.nextPageToken : '';
        if (!token) break;
      }
      f.lastScanAt = nowIso; f.scanned = n; f.scanNew = made;
    } catch (e) { f.ok = false; errors.push('附件掃描（filelist）：' + J.errText(e)); }   // 暫時故障：lastScanAt 不動，下一輪再掃
  }
  // 補抓順序：從沒試過的先（依 wantedAt 由舊到新），再依 lastTryAt 由舊到新——補不到的檔不會一直卡在最前面把額度吃光。
  // 每輪上限 maxCount 個檔（算嘗試次數）或 maxMB（算下載量），先到為準；預估下一個會超過 maxMB 就停。
  // Drive 回找不到（file:null）不算進 maxCount；上次就找不到的「死檔」每輪最多再試 DEAD_MAX 個。unlimited 重複掃到沒進展
  const maxN = o.unlimited ? Infinity : o.maxCount, maxB = o.unlimited ? Infinity : o.maxMB * 1024 * 1024;
  let tried = 0, got = 0, deadTried = 0;
  const order = (a, b) => (!!a.m.lastTryAt - !!b.m.lastTryAt) ||
    (a.m.lastTryAt ? String(a.m.lastTryAt).localeCompare(String(b.m.lastTryAt)) : String(a.m.wantedAt || '').localeCompare(String(b.m.wantedAt || '')));
  const pendingNow = () => FL.scan(dir).metas.filter((id) => !FL.hasBytes(dir, id) && !isSkipped(id))
    .map((id) => ({ id, m: FL.readMeta(dir, id) || {} })).sort(order);
  const markTry = (id, dead) => { try { const m = FL.readMeta(dir, id); if (m) FL.writeMeta(dir, id, Object.assign(m, { lastTryAt: nowIso, lastDead: !!dead })); } catch (e) {} };
  for (let pass = 0; ; pass++) {
    let progress = 0, stop = false;
    const round = new Set();
    failed.clear();
    for (const x of pendingNow()) {
      if (tried >= maxN || got >= maxB) { stop = true; break; }
      const size = Number(x.m.size) || 0;
      if (tried > 0 && size > 0 && got + size > maxB) { stop = true; break; }
      if (round.has(x.id)) continue;
      if (x.m.lastDead && deadTried >= DEAD_MAX) continue;    // 死檔額度用完：這一輪不再試，留 pending
      round.add(x.id); tried++;
      const r = await fetchFile(o, x.id, x.m, nowIso);
      if (r.ok) { f.fetched++; got += r.size; progress++; }
      else {
        failed.set(x.id, r.why);
        if (r.dead) { tried--; deadTried++; }
        markTry(x.id, r.dead);
      }
    }
    if (!o.unlimited || stop || progress === 0) break;
  }
  f.failed = failed.size;
  if (failed.size) f.failedIds = [...failed.entries()].slice(0, LIST_MAX).map(([id, why]) => id + '（' + why + '）');
  // 統計（位元組在的才算 count／bytes）
  const sc = FL.scan(dir), has = new Set(sc.bytes);
  sc.metas.forEach((id) => {
    if (has.has(id)) { f.count++; try { f.bytes += fs.statSync(FL.bytesPath(dir, id)).size; } catch (e) {} return; }
    if (isSkipped(id)) { f.skipped++; return; }
    f.pending++;
    const w = Date.parse((FL.readMeta(dir, id) || {}).wantedAt || '');
    if (!isNaN(w) && now - w > STALE_MS) f.stale++;
  });
  if (f.pending) f.pendingIds = sc.metas.filter((id) => !has.has(id) && !isSkipped(id)).slice(0, LIST_MAX);
  if (f.skipped) f.skippedIds = sc.metas.filter((id) => !has.has(id) && isSkipped(id)).slice(0, LIST_MAX).map((id) => id + '（' + skip[id] + '）');
  const unmatched = Object.keys(skip).filter((id) => !sc.metas.includes(id));
  if (unmatched.length) warns.push(`${FILE_SKIP} 有 ${unmatched.length} 個 id 對不到任何附件：` + unmatched.slice(0, LIST_MAX).join('、'));
  if (errors.length) f.error = errors.join('；');
  if (warns.length) f.warnings = warns;
  return f;
}
// --files-verify：重算本機每個附件的 sha256 與 meta 比對；不符的列出來、不自動刪（人決定）
function verifyFiles(dir) {
  const sc = FL.scan(dir), bad = [];
  let n = 0;
  sc.bytes.forEach((id) => {
    const m = FL.readMeta(dir, id);
    if (!m || !m.sha256) return;
    n++;
    try { if (FL.hashes(fs.readFileSync(FL.bytesPath(dir, id))).sha256 !== m.sha256) bad.push(id); } catch (e) { bad.push(id); }
  });
  return { checked: n, bad };
}
const filesText = (x) => x ? `附件 count=${x.count} bytes=${x.bytes} pending=${x.pending} stale=${x.stale} fetched=${x.fetched} failed=${x.failed} skipped=${x.skipped}` : '附件（未執行）';

// 跑一輪；回傳結果物件（也寫進 mirror-last.json）。bridge 只需要 call(op, payload, timeoutSec)。
// o.force：還原後手動覆寫（越過筆數防呆，並帶 force:true 給 Apps Script）。o.busyMs／o.backoffMs：測試用。
// o._betweenReads：測試用鉤子，在讀交易的第一個 SELECT 之後呼叫（驗四份是同一個快照）。
async function runMirror(o) {
  const dir = o.dir, bridge = o.bridge;
  const batch = clampInt(o.batch, 15, 1, SIGS_MAX);
  const maxPerRun = o.all ? Infinity : clampInt(o.maxPerRun, 60, 1, 100000);
  const envBackoff = process.env.MIRROR_BACKOFF_MS === undefined ? NaN : Number(process.env.MIRROR_BACKOFF_MS);   // 只給測試縮短
  const backoffMs = o.backoffMs >= 0 ? o.backoffMs : envBackoff >= 0 ? envBackoff : 30000;
  const prev = J.readLast(dir, LAST);
  const res = { at: new Date().toISOString(), ok: false, uploaded: 0, carried: 0, pending: null, missing: 0, bad: 0, skipped: 0, failed: 0, fails: 0 };
  const errs = [], warns = [];
  const release = J.takeLock(dir, 'mirror');
  if (!release) {   // 另一輪還在跑（或正在還原）：不寫結果檔、不算失敗（--all 由 main() 以非 0 結束並印原因）
    J.logLine(dir, 'mirror.log', '另一輪鏡像還在跑（或正在還原），這次跳過');
    return Object.assign(res, { ok: true, busy: true });
  }
  // 上一次「成功送出」的筆數（還原防呆用）：失敗的那輪沒有 counts，沿用更早的
  res.lastSent = (prev && (prev.counts || prev.lastSent)) || null;
  // sig-state.json：壞掉或 unsaved 型別不對 → 改名保留成 .corrupt-時間、記 ok:false（不默默歸零——裡面已上傳的 Drive id 會跟著不見）
  const st = J.readState(dir, STATE);
  if (!st.corrupt && st.v && st.v.unsaved !== undefined && !(plain(st.v.unsaved) && allStrings(st.v.unsaved))) st.corrupt = true;
  if (st.corrupt) {
    const bak = STATE + '.corrupt-' + J.taipeiStamp(new Date()) + '-' + process.pid;
    try { fs.renameSync(path.join(dir, 'logs', STATE), path.join(dir, 'logs', bak)); } catch (e) {}
    errs.push(`logs/${STATE} 損毀，已改名保留為 ${bak}（裡面已上傳未寫庫的 Drive id 需人工核對）`);
  }
  const unsaved = (!st.corrupt && st.v && st.v.unsaved) || {};
  // 人工略過清單（逃生門，只有人會寫）：格式錯就 ok:false、這一輪不略過任何一張（上傳照常）
  const sk = J.readState(dir, SKIP);
  let skip = {};
  if (sk.corrupt || (sk.v && !(plain(sk.v) && allStrings(sk.v)))) errs.push(`logs/${SKIP} 格式錯誤（應為 { "公告id/同仁id": "原因" }），這一輪不略過任何一張`);
  else if (sk.v) skip = sk.v;
  // 存狀態失敗（例如磁碟滿）只記警告，鏡像照做
  const saveState = () => { try { J.writeLast(dir, STATE, { unsaved }); } catch (e) { if (!warns.length) warns.push(`${STATE} 寫不進去：` + J.errText(e)); } };
  let db = null, dbReady = false;                            // dbReady：庫可用且不是空庫（第 3 步才跑；空庫＝還沒搬遷，一次橋接都不打，M5 保險不變）
  try {
    db = J.openDb(dir, { busyMs: o.busyMs });
    if (!db.prepare('PRAGMA table_info(reads)').all().some((c) => c.name === 'driveSigId')) throw new Error('資料庫還沒有 driveSigId 欄（伺服器升級後重新啟動一次即會補上）');
    // 空庫不鏡像（#10）：切換日 PRIMARY=mini 之後、migrate.js 匯入之前，若每小時鏡像先跑到，會把空的 Mac mini 庫整份蓋掉試算表
    // （之後的 export 也就是空的）。正式資料一定有同仁；沒有同仁也沒有公告＝還沒搬遷，拒絕。
    const c0 = J.counts(db);
    // 結果檔照樣寫（at＝現在、ok:false），另標 notMigrated：/health 最多判黃「尚未搬遷」，不因部署到搬遷之間的空窗誤判紅燈
    if (!c0.staff && !c0.posts) { res.notMigrated = true; throw new Error('資料庫是空的（尚未搬遷），拒絕鏡像以免蓋掉試算表'); }
    dbReady = true;
    const sigDir = path.join(dir, 'sigs');
    const TODO_SQL = "SELECT postId, staffId, sigId FROM reads WHERE sigId <> '' AND driveSigId = '' ORDER BY rowid";
    const fileOf = (r) => path.join(sigDir, path.basename(r.sigId));   // sigId 由 store-sqlite.js 產生（只有安全字元），basename 是多一道保險
    const hasFile = (r) => fs.existsSync(fileOf(r));
    const dmg = new Map();
    const isDamaged = (r) => { const k = keyOf(r); if (!dmg.has(k)) dmg.set(k, localDamaged(fileOf(r))); return dmg.get(k); };
    const isSkipped = (r) => Object.prototype.hasOwnProperty.call(skip, label(r));
    // 只寫 driveSigId 一欄；已有 id 的不覆蓋、sigId 變了（上傳這幾分鐘裡被 load() 重建）的不套用
    const upd = db.prepare("UPDATE reads SET driveSigId = ? WHERE postId = ? AND staffId = ? AND sigId = ? AND driveSigId = ''");
    const writeIds = (pairs) => {   // pairs: [{ r, id }]；寫不進去（busy 逾時等）就把 id 記在 sig-state.json，下一輪先用、不重傳
      if (!pairs.length) return true;
      try {
        db.exec('BEGIN IMMEDIATE');
        try { pairs.forEach((x) => upd.run(x.id, x.r.postId, x.r.staffId, x.r.sigId)); db.exec('COMMIT'); }
        catch (e) { try { db.exec('ROLLBACK'); } catch (y) {} throw e; }
        pairs.forEach((x) => { delete unsaved[keyOf(x.r)]; });
        return true;
      } catch (e) {
        pairs.forEach((x) => { unsaved[keyOf(x.r)] = x.id; });
        errs.push('回填寫入：' + J.errText(e));
        return false;
      }
    };

    // ---- 1. 簽名回填 ----
    // 1a. 上一輪已上傳、但沒寫進庫的 Drive id：先寫，不重傳（避免孤兒檔）
    const todo0 = J.rows(db, TODO_SQL);
    const carry = todo0.filter((r) => unsaved[keyOf(r)]).map((r) => ({ r, id: unsaved[keyOf(r)] }));
    Object.keys(unsaved).forEach((k) => { if (!todo0.some((r) => keyOf(r) === k)) delete unsaved[k]; });   // 那一格已被回填或重建：丟掉
    let carryFailed = false;
    if (carry.length) { if (writeIds(carry)) res.carried = carry.length; else carryFailed = true; }
    // 人工略過清單裡對不到任何已讀的鍵（打錯字、大小寫不對）：列在警告裡，免得人以為已經略過了
    const allLabels = new Set(J.rows(db, 'SELECT postId, staffId FROM reads').map(label));
    const unmatched = Object.keys(skip).filter((k) => !allLabels.has(k));
    if (unmatched.length) { res.skipUnmatched = unmatched.slice(0, LIST_MAX); warns.push(`${SKIP} 有 ${unmatched.length} 個鍵對不到任何已讀：` + res.skipUnmatched.join('、')); }
    // 1b. 逐批上傳。Drive 端失敗（null）一律是暫時故障：留在 pending。--all 重複掃描到 pending=0，一整輪沒進展就停
    let budget = maxPerRun, stop = !!st.corrupt || carryFailed;   // sig-state 損毀、carry 寫不進去：這一輪不上傳，免得重傳成孤兒檔（sig-skip 格式錯不擋上傳）
    let pass = 0;
    const failedNow = new Map();                             // 最後一輪仍傳不上去的
    while (!stop && budget > 0) {
      let pick = J.rows(db, TODO_SQL).filter((r) => !unsaved[keyOf(r)] && hasFile(r) && !isDamaged(r) && !isSkipped(r));
      if (budget !== Infinity) pick = pick.slice(0, budget);
      if (!pick.length) break;
      let progress = 0;
      failedNow.clear();
      for (let i = 0; i < pick.length && !stop; i += batch) {
        const part = pick.slice(i, i + batch).map((r) => {   // 傳這一批時才讀這一批的圖（--all 不會一次把全部圖讀進記憶體）
          const file = path.basename(r.sigId);
          return { r, name: file.replace(/\.(png|jpe?g)$/i, ''), data: 'data:' + (/\.png$/i.test(file) ? 'image/png' : 'image/jpeg') + ';base64,' + fs.readFileSync(fileOf(r)).toString('base64') };
        });
        budget -= part.length;
        if (o.all) release.touch();                          // --all 可能跑很久：每批更新鎖檔 mtime，不被當成殘留鎖
        let ids;
        try {
          const out = await bridge.call('sigs', { put: part.map((x) => ({ name: x.name, data: x.data })) }, 300);
          ids = out && out.ids;
          if (!Array.isArray(ids) || ids.length !== part.length) throw new Error('sigs 回傳筆數不符');
        } catch (e) { errs.push('簽名回填：' + J.errText(e)); stop = true; break; }   // 橋接出錯：同一輪不重試，剩下的留給下一輪
        const good = [];
        part.forEach((x, k) => {
          if (typeof ids[k] === 'string' && ids[k]) good.push({ r: x.r, id: ids[k] });
          else failedNow.set(keyOf(x.r), x.r);               // Drive 端失敗：暫時故障，留在 pending
        });
        if (!writeIds(good)) { stop = true; break; }
        res.uploaded += good.length; progress += good.length;
        saveState();
      }
      if (!o.all || progress === 0) break;                   // 每小時模式只掃一次；--all 一整輪沒有進展就停
      // --all 長時間回填：每輪更新結果檔的 at（其餘欄位沿用上一次），守門才不會把「正在補」誤判成「鏡像很久沒跑」
      pass++;
      try { J.writeLast(dir, LAST, Object.assign({}, prev || {}, { at: new Date().toISOString(), running: true, pass })); } catch (e) {}
      // 退避：這一輪失敗超過一半就先等一下再掃（Drive 限流時不要一直打）
      if (failedNow.size * 2 > pick.length) await new Promise((ok) => setTimeout(ok, backoffMs));
    }
    res.failed = failedNow.size;
    if (failedNow.size) {
      res.failedIds = [...failedNow.values()].slice(0, LIST_MAX).map(label);
      errs.push(`簽名回填：Drive 端有 ${failedNow.size} 張傳不上去（暫時故障，不判壞圖）` +
        (o.all ? '，稍後再跑；多次重跑仍失敗請找 MacBook Claude' : '，下一輪再試'));
    }
    saveState();

    // ---- 2. 鏡像：四份＋待回填清單在同一個讀交易（同一個快照）；COMMIT 之後才打橋接 ----
    let data, left;
    db.exec('BEGIN');
    try {
      data = { posts: J.rows(db, 'SELECT json FROM posts ORDER BY rowid').map((r) => JSON.parse(r.json)) };
      if (o._betweenReads) o._betweenReads();
      data.staff = J.rows(db, 'SELECT json FROM staff ORDER BY rowid').map((r) => { const x = JSON.parse(r.json); delete x.lineHash; return x; });   // LINE 綁定雜湊不進試算表
      data.reads = J.rows(db, 'SELECT postId, staffId, name, unit, at, sigId, driveSigId FROM reads ORDER BY rowid');
      data.log = J.rows(db, 'SELECT at, action, target, summary FROM log ORDER BY seq');
      left = J.rows(db, TODO_SQL);
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch (y) {} throw e; }
    const skipped = left.filter(isSkipped), rest = left.filter((r) => !isSkipped(r));   // 人工略過優先（缺圖、壞圖寫進 sig-skip 也算 skipped）
    const missing = rest.filter((r) => !hasFile(r)), damaged = rest.filter((r) => hasFile(r) && isDamaged(r));
    res.pending = rest.length - missing.length - damaged.length;
    res.missing = missing.length; res.bad = damaged.length; res.skipped = skipped.length;
    if (missing.length) res.missingIds = missing.slice(0, LIST_MAX).map(label);
    if (res.bad) res.badIds = damaged.slice(0, LIST_MAX).map((r) => label(r) + '（本機檔損毀）');
    if (res.skipped) res.skippedIds = skipped.slice(0, LIST_MAX).map((r) => label(r) + '（' + skip[label(r)] + '）');
    // 還原防呆（#14 S5）：任一份比上次成功送出的少 → 不送（多半是剛從每日快照還原，試算表比本機新）。
    // 確認試算表可以被覆寫後，手動 --force（同時帶 force:true 給 Apps Script，越過 M2 的筆數防呆）。
    // 前提（審查第 3 輪確認）：公告不刪（只下架）、同仁軟刪除、已讀與操作紀錄只增，只有 load()（搬遷／還原）會讓筆數變少。
    // 以後若加硬刪（例如「清除離職同仁」），這裡要改成只比其他幾份，或硬刪時同步下修 lastSent。
    const n = { posts: data.posts.length, staff: data.staff.length, reads: data.reads.length, log: data.log.length };
    const L0 = res.lastSent;
    const shrunk = L0 ? ['posts', 'staff', 'reads', 'log'].filter((k) => L0[k] !== undefined && n[k] < Number(L0[k])) : [];
    if (shrunk.length && !o.force) {
      errs.push('鏡像：本機筆數比上次鏡像少（可能剛還原）——' + shrunk.map((k) => `${k} ${n[k]}＜${L0[k]}`).join('、') + '；確認試算表可被覆寫後執行 node server/mirror.js --force');
    } else {
      try {
        await bridge.call('mirror', o.force ? { data, force: true } : { data }, 300);
        res.counts = n; res.lastSent = n;
        if (o.force) res.forced = true;
      } catch (e) { errs.push('鏡像：' + J.errText(e)); }
    }
  } catch (e) {
    errs.push(J.errText(e));
  } finally {
    try { if (db) db.close(); } catch (e) {}
  }
  // ---- 4. LINE 綁定刷新：與鏡像隔開——自己 try/catch、不寫 errs（讀不到就跳過）；--all 不做、空庫不做 ----
  if (!o.all && dbReady) {
    try { res.line = await refreshLineHash({ dir, bridge, busyMs: o.busyMs }); }
    catch (e) { res.line = { ok: false, error: J.errText(e) }; }
    J.logLine(dir, 'mirror.log', res.line.ok ? `LINE 綁定刷新：更新 ${res.line.updated} 人、已綁定 ${res.line.linked} 人` + (res.line.sourceErrors ? `（${res.line.sourceErrors} 個打卡來源讀不到，那幾店不動）` : '')
      : 'LINE 綁定刷新跳過：' + res.line.error);
  }
  // ---- 3. 附件補齊（M7）：與上面完全隔開——自己 try/catch、不寫 errs、不動 ok／pending／fails（D4）；--all 不做（沿用上一輪的 files）----
  const prevFiles = (prev && prev.files) || null;
  try {
    res.files = o.all || !dbReady ? prevFiles : await fillFiles({ dir, bridge, now: o.now, maxCount: clampInt(o.filesMax, 10, 1, 100000), maxMB: clampInt(o.filesMaxMB, 100, 1, 1000000) }, prevFiles);
  } catch (e) {
    res.files = Object.assign({}, prevFiles || {}, { ok: false, error: '附件補齊：' + J.errText(e) });
  } finally {
    release();
  }
  if (warns.length) res.warnings = warns;
  res.ok = errs.length === 0;
  res.fails = res.ok ? 0 : (Number(prev && prev.fails) || 0) + 1;
  if (!res.ok) res.error = errs.join('；');
  J.writeLast(dir, LAST, res);
  J.logLine(dir, 'mirror.log', (res.ok ? '鏡像完成' : '鏡像失敗') + `：回填 ${res.uploaded} 張` + (res.carried ? `（另補寫上一輪已上傳的 ${res.carried} 張）` : '') + `、待回填 ${res.pending}` +
    (res.counts ? '、' + J.countText(res.counts) : '') + (res.forced ? '（--force）' : '') +
    (res.ok ? '' : '；' + res.error) + (warns.length ? '；⚠ ' + warns.join('；') : ''));
  if (res.failedIds) J.logLine(dir, 'mirror.log', `⚠ Drive 端傳不上去 ${res.failed} 張：` + res.failedIds.join('、') + (res.failed > LIST_MAX ? ' …' : ''));
  if (res.missing) J.logLine(dir, 'mirror.log', `⚠ 本機缺簽名圖 ${res.missing} 筆（無法上傳，需人工判斷）：` + res.missingIds.join('、') + (res.missing > LIST_MAX ? ' …' : ''));
  if (res.bad) J.logLine(dir, 'mirror.log', `⚠ 壞簽名圖 ${res.bad} 筆（本機檔損毀；換好圖檔，或確認放棄後寫進 logs/${SKIP}）：` + res.badIds.join('、') + (res.bad > LIST_MAX ? ' …' : ''));
  if (res.skipped) J.logLine(dir, 'mirror.log', `人工略過 ${res.skipped} 筆（logs/${SKIP}）：` + res.skippedIds.join('、'));
  if (!o.all && res.files) J.logLine(dir, 'mirror.log', filesText(res.files) + (res.files.failedIds ? '；⚠ 這一輪沒補到：' + res.files.failedIds.join('、') : '') + (res.files.error ? '；' + res.files.error : ''));
  return res;
}

// 第 4 步：只更新同仁的 lineHash（一筆寫入交易；交易內重讀同仁，伺服器同時寫入也不會被蓋掉其他欄位）
async function refreshLineHash(o) {
  const L = require('../js/logic.js');
  let got;
  try { got = await o.bridge.call('clock', {}, 90); }
  catch (e) { return { ok: false, error: '讀打卡名單失敗：' + J.errText(e) }; }
  if (!got || !Array.isArray(got.rows) || !Array.isArray(got.sources)) return { ok: false, error: '打卡名單格式不符' };
  const db = J.openDb(o.dir, { busyMs: o.busyMs });
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      const staff = J.rows(db, 'SELECT json FROM staff ORDER BY rowid').map((r) => JSON.parse(r.json));
      const ups = L.lineHashUpdates(staff, got), upd = db.prepare('UPDATE staff SET json = ? WHERE id = ?');
      ups.forEach((u) => { const s = staff.find((x) => x.id === u.id); s.lineHash = u.lineHash; upd.run(JSON.stringify(s), s.id); });
      db.exec('COMMIT');
      return { ok: true, updated: ups.length, linked: staff.filter((s) => s.active && s.lineHash).length, sourceErrors: Array.isArray(got.errors) ? got.errors.length : 0 };
    } catch (e) { try { db.exec('ROLLBACK'); } catch (y) {} throw e; }
  } finally { try { db.close(); } catch (e) {} }
}

// --files／--files-scan：只做第 3 步、不設上限；拿同一把 mirror 鎖（與每小時那輪不重疊）。
// 結果只更新 mirror-last.json 的 files（鏡像欄位 at／ok／pending／fails 原樣保留）；還沒有結果檔（從沒鏡像過）就不寫，只回傳。
// 分批：每批（上限同每小時那輪）拿一次鏡像鎖、做完就放掉，下一批再拿——首次拉檔跑很久時，每小時的鏡像仍能插進來跑，不會長時間停住。
// 第一批拿不到鎖＝另一輪正在跑，回 busy；之後的批次拿不到就等（每 o.waitMs 重試，最多 o.maxWaitMs）。只有第一批會掃 filelist。
async function runFilesOnly(o) {
  const dir = o.dir, waitMs = o.waitMs >= 0 ? o.waitMs : 5000, maxWaitMs = o.maxWaitMs >= 0 ? o.maxWaitMs : 30 * 60e3;
  let files = null, fetched = 0, batches = 0;
  for (;;) {
    let release = J.takeLock(dir, 'mirror');
    if (!release) {
      if (!batches) return { busy: true };
      const t0 = Date.now();
      while (!release && Date.now() - t0 < maxWaitMs) { await new Promise((ok) => setTimeout(ok, waitMs)); release = J.takeLock(dir, 'mirror'); }
      if (!release) { if (files) files.error = (files.error ? files.error + '；' : '') + '等不到鏡像鎖，這次先停（稍後再跑）'; break; }
    }
    try {
      const prev = J.readLast(dir, LAST);
      const base = (prev && prev.files) || files;
      files = await fillFiles({ dir, bridge: o.bridge, scan: batches === 0 && !!o.scan, noScan: batches > 0, now: o.now, touch: release.touch,
        maxCount: clampInt(o.filesMax, 10, 1, 100000), maxMB: clampInt(o.filesMaxMB, 100, 1, 1000000) }, base);
      fetched += files.fetched;
      if (prev) J.writeLast(dir, LAST, Object.assign({}, prev, { files }));
    } finally { release(); }
    batches++;
    if (!files.pending || !files.fetched) break;              // 補完了，或這一批沒有任何進展（剩下的都補不到）
    if (o._betweenBatches) await o._betweenBatches(batches);   // 測試用鉤子：批次之間鎖已放掉（驗每小時那輪插得進來）
  }
  files.fetched = fetched; files.batches = batches;
  J.logLine(dir, 'mirror.log', (o.scan ? '附件掃描補齊（--files-scan）：' : '附件補齊（--files）：') + filesText(files) + `（${batches} 批）` + (files.error ? '；' + files.error : ''));
  return { files };
}

// 結束碼：非 0 讓 launchd 記錄失敗（真正的告警靠守門讀 /health）；--all 只要還有 pending（或算不出來）就不 exit 0
function exitCode(res, all) { return !res.ok || (all && res.pending !== 0) ? 1 : 0; }

async function main() {
  J.loadEnv(path.join(__dirname, '.env'));
  const { makeBridge } = require('./bridge.js');
  const dir = J.dataDir(process.env);
  const all = process.argv.includes('--all'), force = process.argv.includes('--force');
  const filesScan = process.argv.includes('--files-scan'), filesOnly = filesScan || process.argv.includes('--files');
  if (process.argv.includes('--files-verify')) {
    const v = verifyFiles(dir);
    console.log(`附件驗證：檢查 ${v.checked} 個，sha256 不符 ${v.bad.length} 個` + (v.bad.length ? '（不自動刪，請人判斷）：' + v.bad.join('、') : ''));
    process.exit(v.bad.length ? 1 : 0);
  }
  if (filesOnly) {
    const r = await runFilesOnly({ dir, bridge: makeBridge(process.env.BRIDGE_URL, process.env.BRIDGE_KEY), scan: filesScan, filesMax: process.env.FILES_MAX_PER_RUN, filesMaxMB: process.env.FILES_MAX_MB_PER_RUN });
    if (r.busy) { console.log('✗ 另一輪鏡像正在跑（或正在還原），這次已跳過，請等它結束後再執行'); process.exit(1); }
    const x = r.files;
    console.log(`附件補齊${x.ok ? '完成' : '有問題'}｜count=${x.count}｜bytes=${x.bytes}｜pending=${x.pending}｜stale=${x.stale}｜fetched=${x.fetched}｜failed=${x.failed}｜skipped=${x.skipped}` +
      (x.scanned !== undefined ? `｜掃到 ${x.scanned} 個（新建 meta ${x.scanNew}）` : '') + (x.error ? '｜' + x.error : ''));
    if (x.failedIds) console.log('✗ 沒補到（暫時故障，稍後再跑；多次重跑仍失敗請找 MacBook Claude）：' + x.failedIds.join('、'));
    if (x.skippedIds) console.log('人工略過：' + x.skippedIds.join('、'));
    if (x.warnings) console.log('⚠ ' + x.warnings.join('；'));
    process.exit(x.ok && x.pending === 0 ? 0 : 1);
  }
  const res = await runMirror({ dir, bridge: makeBridge(process.env.BRIDGE_URL, process.env.BRIDGE_KEY),
    batch: process.env.SIG_BATCH, maxPerRun: process.env.SIG_MAX_PER_RUN, filesMax: process.env.FILES_MAX_PER_RUN, filesMaxMB: process.env.FILES_MAX_MB_PER_RUN, all, force });
  if (res.busy) {   // 另一輪正在跑：手動執行（--all／--force）要讓人看得出被跳過，以非 0 結束
    if (all || force || process.stdout.isTTY) console.log('✗ 另一輪鏡像正在跑（或正在還原），這次已跳過，請等它結束後再執行');
    process.exit(all || force ? 1 : 0);
  }
  if (all || force || process.stdout.isTTY) {   // 手動執行：把結論印出來（回退步驟看這裡）
    console.log(`鏡像${res.ok ? '完成' : '失敗'}｜待回填 pending=${res.pending}｜本機缺圖 missing=${res.missing}｜壞圖 bad=${res.bad}` + (res.error ? '｜' + res.error : ''));
    if (res.failedIds) console.log(`✗ Drive 端有 ${res.failed} 張傳不上去，稍後再跑；多次重跑仍失敗請找 MacBook Claude：` + res.failedIds.join('、'));
    if (res.missing) console.log('⚠ 本機缺圖：' + res.missingIds.join('、'));
    if (res.bad) console.log('⚠ 壞圖：' + res.badIds.join('、'));
    if (res.skipped) console.log('人工略過：' + res.skippedIds.join('、'));
    if (res.warnings) console.log('⚠ ' + res.warnings.join('；'));
    if (!all) console.log(filesText(res.files) + (res.files && res.files.error ? '｜' + res.files.error : ''));
  }
  process.exit(exitCode(res, all));
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { runMirror, runFilesOnly, refreshLineHash, fillFiles, verifyFiles, SIGS_MAX, localDamaged, exitCode };
