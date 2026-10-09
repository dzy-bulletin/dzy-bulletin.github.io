/* 鼎兆元｜電子佈告欄 — Google 橋接（Mac mini 伺服器 → 既有 Apps Script）
 * 附件（Drive，保住禁止下載）、打卡名單、搬遷匯出、每日鏡像與備份，這些需要 Google 的動作交給 Apps Script 代辦。
 * 全部 async（Node 內建 fetch）：橋接打的是會排隊 1.7～72 秒的 Apps Script，絕不能卡住事件迴圈（#6 審查發現 1）。
 * Service.js 是同步的，所以由 index.js 在進 Service 之前或之後 await 這裡，再用每請求的墊片把結果交給 Service。
 * fetch 跟隨 Apps Script 的 302 時 POST 會轉成 GET，與原本 curl -L 行為相同（Apps Script 就是這樣回結果），不是 bug。 */
'use strict';

// 橋接錯誤：網路錯誤、逾時、AUTH（金鑰設錯）與其他非業務錯誤一律對應成伺服器自己的錯誤碼（BRIDGE／BRIDGE_TIMEOUT）與固定中文句子，
// 原文只進 stderr——金鑰設錯時 Apps Script 回 AUTH，原樣回傳會讓前端把主管登出、重登又被登出（#12 審查 S3）。
// 業務錯誤（gas/Files.js 自己寫的 BAD_REQ／BAD_TYPE／TOO_BIG，固定中文、不含路徑）照原 code／message 回，與 GAS 版一致（第 2 輪應修-2）。
const BUSINESS = ['BAD_REQ', 'BAD_TYPE', 'TOO_BIG'];
function businessErr(code, message) { const e = new Error(String(message || '').slice(0, 200)); e.code = code; e.business = true; return e; }
const BRIDGE_MSG = { BRIDGE: 'Google 雲端暫時連不上，請稍後再試', BRIDGE_TIMEOUT: '連線 Google 逾時，請稍後再試' };
function bridgeErr(code, detail) { const e = new Error(BRIDGE_MSG[code]); e.code = code; e.detail = detail || ''; return e; }

function makeBridge(url, key) {
  // 回應不是 JSON 時自動重試一次（2026-09-30 切換當天實測）：madesiaosinla 帳號的 Apps Script 排隊 20～56 秒，
  // 等超過約 30 秒時 Google 偶爾回雲端硬碟的「找不到網頁」404 頁，而不是結果（約兩成）。金鑰錯會回 JSON 的 AUTH，不會走到這裡。
  // 逾時不重試（已經等滿 timeoutSec，再等一輪前端早就放棄）；export 不重試（EXPORT_ONCE 只能用一次，GAS 可能已執行並刪掉它）。
  // upload／sigs put 若第一次其實已在 GAS 完成、只是回應丟了，重試會多一個沒被公告引用的檔（不分享、不公開），可接受。
  async function call(op, payload, timeoutSec) {
    try { return await once(op, payload, timeoutSec); }
    catch (e) {
      if (!e.notJson || op === 'export') throw e;
      console.error('bridge ' + op + ': 回應不是 JSON，重試一次');
      return once(op, payload, timeoutSec);
    }
  }
  async function once(op, payload, timeoutSec) {
    if (!url || !key) throw bridgeErr('BRIDGE', '未設定 Google 橋接（BRIDGE_URL／BRIDGE_KEY）');
    const body = JSON.stringify(Object.assign({ action: 'bridge', key, op }, payload || {}));
    let text;
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body,
        redirect: 'follow', signal: AbortSignal.timeout((timeoutSec || 60) * 1000) });
      text = await res.text();
    } catch (e) {
      const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
      throw bridgeErr(timeout ? 'BRIDGE_TIMEOUT' : 'BRIDGE', op + ': ' + (e && e.message));
    }
    let j;
    try { j = JSON.parse(text); } catch (e) { const be = bridgeErr('BRIDGE', op + ': 回應不是 JSON'); be.notJson = true; throw be; }
    if (!j.ok) {
      if (BUSINESS.indexOf(j.code) >= 0 && j.message) throw businessErr(j.code, j.message);
      throw bridgeErr('BRIDGE', op + ': ' + (j.code || '') + ' ' + (j.message || ''));
    }
    return j.data;
  }
  return {
    kind: 'real',
    call,
    files: {
      upload: (name, mime, b64) => call('upload', { name, mime, data: b64 }, 180),
      share: async (ids) => { await call('share', { ids }, 90); },
      revoke: async (ids) => { try { await call('revoke', { ids }, 90); } catch (e) { console.error('revoke: ' + (e.detail || e.message)); } },
      quota: () => call('quota', {}, 30),
      // M7（#18）附件備份：分段讀位元組（每段 ≤ 8MB、逾時 120 秒）、列出附件資料夾（含垃圾桶）。mirror.js 直接用 call(op) 打同樣的 op
      get: (id, off, len) => call('fileget', { id, off, len }, 120),
      list: (pageToken) => call('filelist', { pageToken: pageToken || '' }, 120)
    },
    clockSrc: { read: () => call('clock', {}, 90) }
  };
}

// 測試用：不連 Google 的假橋接（附件存在記憶體）。delayMs＞0 時每個橋接動作都延遲（阻塞測試用）；calls() 回傳各動作呼叫次數；
// failAll＝每個動作都丟出帶 code:'AUTH' 的錯誤（模擬 Apps Script 回「橋接金鑰錯誤」，驗 index.js 不會原樣回傳）。
function makeFakeBridge(delayMs, failAll) {
  const blobs = {}, trash = {}, names = {}; let seq = 0; let clock = { rows: [], errors: [], sources: ['gf', 'cf', 'js'], counts: {} };
  const calls = { upload: 0, share: 0, revoke: 0, quota: 0, clock: 0, fileget: 0, filelist: 0 };
  const typeOf = (n) => ({ pdf: 'pdf', doc: 'docx', docx: 'docx', xls: 'xlsx', xlsx: 'xlsx' })[String(n).split('.').pop().toLowerCase()] || null;
  const wait = () => (delayMs > 0 ? new Promise((ok) => setTimeout(ok, delayMs)) : Promise.resolve());
  const op = (name, fn) => async (...a) => {
    calls[name]++; await wait();
    if (failAll) { const e = new Error('橋接金鑰錯誤'); e.code = 'AUTH'; throw e; }
    return fn(...a);
  };
  return {
    kind: 'fake',
    // M7：fileget／filelist 用 blobs（上架中）＋trash（revoke 丟進垃圾桶的，仍讀得到，比照 Drive 30 天內）
    call: async (name, p) => {
      if (name !== 'fileget' && name !== 'filelist') throw new Error('fake');
      return op(name, () => {
        const all = Object.assign({}, trash, blobs), meta = (id) => {
          const m = /^data:([^;]+);base64,(.*)$/.exec(all[id]), buf = Buffer.from(m[2], 'base64');
          return { buf, file: { id, name: names[id] || id, mime: m[1], size: buf.length,
            md5: require('crypto').createHash('md5').update(buf).digest('hex'), trashed: !blobs[id] } };
        };
        if (name === 'filelist') return { files: Object.keys(all).map((id) => meta(id).file), nextPageToken: '' };
        if (!all[p.id]) return { file: null };
        const { buf, file } = meta(p.id), off = Number(p.off) || 0, len = Number(p.len) || 0, end = Math.min(buf.length, off + len);
        return { file, off, data: buf.subarray(off, end).toString('base64'), eof: end >= buf.length };
      })();
    },
    files: {
      upload: op('upload', (name, mime, b64) => { const id = 'F-' + (++seq); blobs[id] = 'data:' + mime + ';base64,' + b64; names[id] = name; return { id, name, type: typeOf(name), size: Buffer.from(b64, 'base64').length }; }),   // size 與 Drive 一樣回實際位元組數（M7 驗 meta.size）
      share: op('share', (ids) => { if (ids.indexOf('F-GONE') >= 0) { const e = new Error('找不到附件檔案'); e.code = 'BAD_REQ'; e.business = true; throw e; } }),   // F-GONE＝模擬 Drive 上已刪除的附件
      revoke: op('revoke', (ids) => ids.forEach((i) => { if (blobs[i]) trash[i] = blobs[i]; delete blobs[i]; })),   // 丟垃圾桶：blobOf 看不到、fileget 仍讀得到
      quota: op('quota', () => ({ limit: 16106127360, usage: 7935000000 }))
    },
    // 比照 Apps Script：帶入資料的 lineUid（模擬打卡系統的 line_user_id）只交出 lineHash
    clockSrc: { read: op('clock', () => { const c = JSON.parse(JSON.stringify(clock)); c.rows.forEach((r) => {
      r.lineHash = r.lineUid ? require('crypto').createHash('sha256').update('dzyb-line:' + r.lineUid, 'utf8').digest('hex') : (r.lineHash || ''); delete r.lineUid; }); return c; }) },
    getClock: () => JSON.parse(JSON.stringify(clock)),
    setClock: (rows) => {
      const n = (src) => rows.filter((r) => r.src === src && r.active).length;
      clock = { rows, errors: [], sources: ['gf', 'cf', 'js'], counts: { '小辛辣光復店': n('gf'), '央廚': n('cf'), '墨竹亭金山店': n('js') } };
    },
    blobOf: (id) => blobs[id] || null,
    calls: () => Object.assign({}, calls)
  };
}

module.exports = { makeBridge, makeFakeBridge, BRIDGE_MSG };
