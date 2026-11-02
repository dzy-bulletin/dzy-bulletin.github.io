/* 鼎兆元｜電子佈告欄 — /health 燈號判定（#8「監看判定」寫死在這裡；給 #10 的守門與 /health 的 level 共用同一份規則）
 * 輸入：/health 的 { mirror:{ at, ok, sigPending, fails }, backup:{ at, ok }, files:{ pending, stale }, remind:{ ok }, announce:{ ok }, disk:{ freeMB } }；輸出 { level, why }。
 *   紅：mirror.at 距今 > 6 小時（或從沒跑過）、backup.at 距今 > 26 小時（或從沒跑過）
 *   黃：mirror.at 距今 > 3 小時、mirror 連續失敗 ≥ 2 次、backup.ok=false、diskFreeMB < 5000、mirror.sigPending > 200、
 *       backup.sharedWith > 0（備份資料夾有共用者；備份含密碼雜湊與 TOKEN_SECRET，必須僅 owner——M2 建議、M3 採用）、
 *       backup.sharedWith = -1（讀不到權限＝沒驗證到「僅 owner」）、mirror.missing > 0（本機缺簽名圖）、mirror.bad > 0（壞簽名圖）、
 *       任一時間戳比現在晚 5 分鐘以上（系統時鐘被往回調，不然會一直綠燈；#14 建議 6）、
 *       files.stale > 0（M7 #18 D5：有附件待補超過 24 小時；pending > 0 但 stale = 0 是正常排隊，不轉燈）
 *       remind.ok=false（#26 光復未簽提醒最後一次送出失敗；remind 為 null＝沒裝或沒啟用、ok=true＝成功，都不影響燈號）
 *       announce.ok=false（#28 新公告通知最後一輪有失敗；announce 為 null＝沒啟用、ok=null＝第一輪還沒跑完，都不影響燈號）、
 *       announce.gaveup > 0（有公告連續失敗被放棄；持續黃燈直到 `node server/announce.js --retry` 清掉，#29 S1）
 *       punchRemind.ok=false（打卡公告提醒最後一次送出失敗）、punchRemind.at（最後一次執行，失敗另由 ok=false 亮燈）距今 > 30 分鐘（每 5 分鐘一輪的工作停了，機器人那邊 30 分鐘後就不再提醒）；
 *       punchRemind 為 null＝沒裝或沒啟用，不影響燈號
 *   結果檔存在但讀不到（at 為 null）→ 紅「結果檔讀不到」，與「從沒跑過」分開寫。
 *   mirror.notMigrated（空庫、尚未搬遷，mirror.js 在本機拒絕）→ 黃「尚未搬遷」，蓋掉「鏡像連續失敗」與「超過 3 小時」兩個黃燈；
 *   **鏡像超過 6 小時沒跑的紅燈照判**（空庫時每輪照樣更新 at，at 變舊＝launchd 的 mirror 死了）。快照、磁碟、附件等其他規則照常。
 *   「/health 打不通或非 200 → 紅」由守門自己判（打不通就拿不到這份）。
 * why 只放固定短句（不帶任何錯誤原文）。純函式，無副作用。 */
'use strict';

const H = 3600e3;
const RULES = { punchRemindStaleMin: 30, mirrorYellowH: 3, mirrorRedH: 6, backupRedH: 26, mirrorFailYellow: 2, diskYellowMB: 5000, pendingYellow: 200, futureMin: 5 };

function judgeHealth(h, nowMs) {
  const now = nowMs || Date.now(), red = [], yellow = [];
  const age = (at) => { const t = Date.parse(at || ''); return isNaN(t) ? Infinity : (now - t) / H; };
  const m = h && h.mirror, b = h && h.backup, freeMB = h && h.disk ? h.disk.freeMB : null;
  const ma = age(m && m.at), ba = age(b && b.at);
  const nm = !!(m && m.notMigrated);                         // 空庫時 mirror.js 每小時照樣更新 at，所以 at 變舊＝mirror 死了，與搬遷無關 → 6 小時紅燈照判
  if (nm) yellow.push('尚未搬遷');
  if (ma > RULES.mirrorRedH) red.push(!m ? '沒有鏡像紀錄' : m.at ? '鏡像超過 6 小時沒跑' : '鏡像結果檔讀不到');
  else if (ma > RULES.mirrorYellowH && !nm) yellow.push('鏡像超過 3 小時沒跑');
  if (ba > RULES.backupRedH) red.push(!b ? '沒有快照紀錄' : b.at ? '快照超過 26 小時沒跑' : '快照結果檔讀不到');
  if (ma < -RULES.futureMin / 60 || ba < -RULES.futureMin / 60) yellow.push('時間戳異常（比現在還晚）');
  if (!nm && m && Number(m.fails) >= RULES.mirrorFailYellow) yellow.push('鏡像連續失敗');
  if (b && b.ok === false) yellow.push('快照失敗');
  if (typeof freeMB === 'number' && freeMB < RULES.diskYellowMB) yellow.push('磁碟剩餘不足 5GB');
  if (m && Number(m.sigPending) > RULES.pendingYellow) yellow.push('待回填簽名超過 200 張');
  if (m && Number(m.missing) > 0) yellow.push('本機缺簽名圖');
  if (m && Number(m.bad) > 0) yellow.push('有壞簽名圖');
  if (b && Number(b.sharedWith) > 0) yellow.push('備份資料夾有共用者');
  if (b && b.sharedWith === -1) yellow.push('備份資料夾權限讀不到');
  if (h && h.files && Number(h.files.stale) > 0) yellow.push('有附件超過 24 小時沒補齊');
  if (h && h.remind && h.remind.ok === false) yellow.push('未簽提醒送出失敗');
  if (h && h.announce && h.announce.ok === false) yellow.push('新公告通知失敗');
  if (h && h.announce && Number(h.announce.gaveup) > 0) yellow.push('有新公告通知已放棄');
  const pr = h && h.punchRemind;
  if (pr && pr.ok === false) yellow.push('打卡公告提醒送出失敗');
  else if (pr && age(pr.at) * 60 > RULES.punchRemindStaleMin) yellow.push('打卡公告提醒超過 30 分鐘沒跑');
  return { level: red.length ? 'red' : yellow.length ? 'yellow' : 'green', why: red.concat(yellow) };
}

module.exports = { judgeHealth, RULES };
