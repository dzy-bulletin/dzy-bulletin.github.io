# 打卡回覆帶出未簽公告（2026-11-02 規格 v1）

Eason 2026-11-02 拍板（確認單 1B 2A 3A 4A 5A）。同仁在 LINE 打卡成功後，鼎兆元打卡機器人的回覆卡片多一段「還沒簽的公告」，附「去佈告欄簽名」按鈕。用 LINE 免費回覆（reply），不推播、不扣額度。

## 為什麼要做
- 公告發了同仁不一定會開佈告欄。目前只有小辛辣光復有催簽（每天 18:00 群組未簽提醒，`server/sign-remind.js`），其他 7 個單位沒有任何提醒管道。
- 每位同仁每天一定會打卡，打卡回覆是最穩定、免費、只有本人看得到的接觸點。

## 規則（Eason 定的）
| 題 | 決定 |
|---|---|
| 1 多久提醒 | **每次 LINE 打卡成功都提醒，簽完才停**（上下班卡都算） |
| 2 上架多久開始 | **上架當天就提醒**（狀態 on 就算，不等天數） |
| 3 寫什麼 | **列公告標題，最多 3 則，其餘寫「還有 N 則」**，附「去佈告欄簽名」按鈕（LINE 自動登入） |
| 4 範圍 | **有 LINE 打卡、而且在佈告欄名單裡的 6 個單位一起開**：小辛辣新竹光復、墨竹亭新竹金山／新竹光復／台北六張犁、鼎兆元總部、中央廚房。墨竹亭台中美村、內湖瑞光的同仁還不在佈告欄名單，**先不接**（Eason 2026-11-02），之後接進佈告欄就自動有提醒、不用改這個功能 |
| 5 光復群組 18:00 未簽提醒 | **先保留**，上線兩週後看簽名速度再決定（`sign-remind.js` 不動） |

## 「哪些公告算這個人要提醒的」
與佈告欄現有判斷完全一致，不另訂規則：
- 公告 `L.status(p, today).state === 'on'`（已上架、未到期、未手動下架）。
- `L.canSee(staff.unit, p, staff.seeAll === true)`（v0.8.0 品牌可見規則；看不到的公告絕不提醒）。
- `L.mustSign(staff.unit, p)`（要簽的才提醒；不用簽的公告佈告欄不記「看過」，無法判斷）。
- reads 沒有 (postId, staffId) 那一列（有沒有簽名圖都算已讀，同 sign-remind）。
- 同仁 `active` 且有 `lineHash`。沒綁 LINE 的人不會出現。
- 排序沿用 `L.sortBoard`（同佈告欄畫面順序）。

## 不做的事（non-goals）
- 不推播、不用候補額度、不 @ 人、不發群組。
- 不改打卡本身：不擋打卡、不延後打卡畫面的結果。
- 不在打卡畫面（clock-line.html）顯示，只在機器人回覆卡片。
- 舊專屬連結（clock.html）打卡的人不提醒。
- 小辛辣台中美村、員林南昌、一悟燒肉不在打卡系統裡，不提醒。
- 不動 18:00 群組提醒。

## 失敗就安靜（anti-goals）
以下任何一個發生都算失敗，即使功能「能用」：
- 打卡回覆變慢到明顯感覺、或因為這個功能整張回覆沒送出（回覆權杖逾時）。
- 提醒了看不到的別品牌公告、或提醒已經簽過的公告超過一輪更新時間。
- 卡片或任何紀錄外流公告標題以外的資料（姓名、單位、簽名）。

## 做法（Claude 的決定，Eason 未逐條確認）
**資料由 Mac mini 先算好、定時送到機器人那邊放著；機器人回覆時只讀自己手上的資料，不即時去問佈告欄。**
理由：機器人跑在光復打卡的 Apps Script，`UrlFetchApp` 不能設逾時；回覆當下去問 Mac mini，mini 掛掉或 Funnel 卡住時整張打卡回覆可能等到回覆權杖失效、什麼都沒回。先送過去就沒有這個風險，回覆也不會多等。代價是同仁簽完後，最多要等一輪更新（5 分鐘）提醒才消失。

### 佈告欄端（Mac mini，~/dzy-bulletin，本 repo）
- 新工作 `server/punch-remind-push.js`，launchd `com.dzy.bulletin.punchremind` 每 5 分鐘跑一次（形狀照 `sign-remind.js`：唯讀開 SQLite、純函式算名單、`--dry-run` 只印人數不送）。
- 純函式 `pendingByLine(data, today)` → `{ <lineHash>: { n, titles:[最多 3 則標題] } }`，只放 n ≥ 1 的人。
- 送出：POST 光復打卡 Apps Script `/exec`，body `{ action:'line_hub_bulletin_put', key, at:<ISO>, v:1, map }`，text/plain，跟隨 302。重試 1 次。
- 環境變數（server/.env，Eason 親手貼）：`PUNCH_REMIND_URL`（光復打卡 /exec）、`PUNCH_REMIND_KEY`（與光復 Script Property 同一把，≥32 字元隨機）。沒設＝印「尚未啟用」、exit 0。
- 結果寫 `logs/punch-remind-last.json`＝`{ at, ok, people, posts, bytes, error }`（只數字，不寫姓名、不寫標題），一行進 `logs/punch-remind.log`。`/health` 帶 `punchRemind` 區塊：最後成功超過 30 分鐘＝黃燈（同 remind 的做法）。
- 標題超過 30 字截斷加「…」。整包超過 90KB（約 600 人×3 則才會到）就只送每人 n 與前 1 則標題，並在 last.json 記 `trimmed:true`。

### 打卡機器人端（光復打卡 Apps Script，~/mala-clock-in apps-script/LineHub.gs，另一個 repo）
- 新 action `line_hub_bulletin_put`：驗 `key` ＝ Script Property `BULLETIN_PUSH_KEY`（沒設＝一律 unauthorized）；`map` 存 CacheService（key `lhb:v1`，TTL 21600 秒；超過 90KB 拒收回 too_big），另存 `lhb:at`。回 `{ ok, people }`。
- 掛在 webhook「打卡」那段：`r && r.ok` 時，算 `sha256Hex('dzyb-line:' + userId)`（與佈告欄 `auth.lineHash` 同一個前綴與算法），查 `lhb:v1`；`lhb:at` 超過 30 分鐘＝資料太舊，不提醒。查到就 `r.bulletin = { n, titles }`。任何例外吞掉、不提醒，絕不影響回覆。
- `lineHubPunchCard_`：greeting 之前（漏打卡之後）加一段：分隔線、標題「📢 還沒簽的公告」、逐行列標題（最多 3）、n > 3 時加一行「還有 N 則」；卡片底加按鈕「去佈告欄簽名」→ `https://liff.line.me/2011292256-iTZEbOWG`（佈告欄 LIFF，用打卡綁定的 LINE 自動登入）。`lineHubPunchText_` **不加**（Claude 決定，2026-11-02 審查）：它只給 `line_quick_clock` 回打卡畫面的 `text`，webhook 回覆不用它；加了等於把標題送進打卡畫面，違反「只在機器人回覆」。
- 公告標題是主管打的自由文字：放進 Flex 前過既有的 `lineHubTxt_`（Flex 不收空字串、長度限制）。
- 打卡失敗的卡片不帶公告。

### 卡片長相
```
✅ 下班打卡成功 21:32
地點：墨竹亭 新竹金山
──
📢 還沒簽的公告
・11 月排班與休假注意事項
・冬季食材保存調整
──
辛苦了，回家路上小心！
[去佈告欄簽名]
```

## 上線順序
1. 光復打卡 Apps Script 先上 `line_hub_bulletin_put`＋卡片段落（還沒有資料時什麼都不顯示＝對同仁零影響）。設 Script Property `BULLETIN_PUSH_KEY`。
2. 佈告欄 Mac mini：合併本分支、填 `.env` 兩個值、裝 launchd、`--dry-run` 看人數、再正式跑一次。
3. 自己綁 LINE 的帳號在有未簽公告時打一次卡，看卡片；簽完等 5 分鐘再打一次，提醒要消失。
回退：mini `launchctl bootout` 那支工作（30 分鐘後機器人自動不提醒）；或刪光復 `BULLETIN_PUSH_KEY`（立即拒收）。

## 測試
- 佈告欄：`test/punch-remind.test.js`：每種單位 × seeAll × mustSign × 已讀／未讀 × 狀態（on／plan／off）× 沒 lineHash；排序、3 則上限、標題截斷、90KB 裁切；`--dry-run` 不送、不寫 last。
- 打卡：`tests/line-hub-bulletin.test.js`：金鑰錯／沒設、太大拒收、`at` 過期不提醒、lineHash 算法與佈告欄一致（同一個 userId 兩邊算出同一串）、卡片段落與按鈕、n > 3 的「還有 N 則」、快取讀壞不影響打卡回覆。
- e2e：佈告欄 mock 送一包 → 打卡 mock webhook 回覆內容含標題。

## 對人方式（2026-11-02 查證）
- 佈告欄 `staff.lineHash`＝`sha256('dzyb-line:' + 打卡名冊 line_user_id)`（`gas/Code.js lineHashOf_`，前綴 `js/logic.js LINE_HASH_PREFIX`，沒有被改過）。
- 機器人 webhook 的 `ev.source.userId` 與打卡名冊 `line_user_id` 是同一串：現行「打卡」回覆就是用 webhook userId 去對名冊（`lineHubMine_`），正式環境運作中。所以機器人端用同一個前綴算雜湊即可對上，不需要改用 emp_id／src。
- ⚠ 佈告欄目前只同步 6 個打卡來源（gf 小辛辣光復、cf 央廚、js 墨竹亭金山、mgf 墨竹亭光復、hq 總部、lzl 六張犁；`gas/Config.local.js CLOCK_SOURCES_`、`server/staff-dzy.js STORE_OF_SRC`／`UNIT_OF_DZY`）。**墨竹亭台中美村（mzt-mc）、內湖瑞光（mzt-rg）的同仁不在佈告欄名單裡**，連佈告欄都登不進去，所以也收不到提醒。Eason 2026-11-02 決定先不接（見下節）。

## 美村、瑞光（Eason 2026-11-02：先不接）
- 這次不把墨竹亭台中美村、內湖瑞光接進佈告欄。這兩家同仁打卡時查不到資料＝不提醒，屬預期，不是壞掉。
- 之後要接：改佈告欄同仁同步（`CLOCK_SOURCES_`、`STORE_OF_SRC`、`UNIT_OF_DZY`），本功能不用改。

## 已知限制
- 簽完後最多 5 分鐘內打卡仍會被提醒一次。
- Mac mini 停機超過 30 分鐘：提醒自動停，不會提醒過期內容；恢復後下一輪就回來。
- 同仁在佈告欄改綁 LINE 後，要等佈告欄每小時同步拿到新 lineHash 才會提醒。
- CacheService 是盡力保存，Google 偶爾會提早清掉；清掉＝那 5 分鐘內不提醒。

## 誰做哪一半（Claude 決定）
- 兩邊都由同一個對話實作：佈告欄在本分支 `punch-remind`；打卡機器人在 mala-clock-in 另開 worktree 分支（不動別人正在用的主資料夾）。
- 光復打卡 Apps Script 的部署（clasp push／version／redeploy）照打卡系統既有做法：三方比對後只換 LineHub.js；auto mode 會擋，寫成腳本由 Eason 執行。
- 同一個 lineHash 對到多筆在職同仁（理論上同步已擋 dupHash）：合併成一份、標題去重。

## 留給實作者決定
- launchd plist 細節、log 輪替方式（照 sign-remind 現有做法）。
- 卡片段落的字級、間距（照 `lineHubPunchCard_` 現有 blocks）。
