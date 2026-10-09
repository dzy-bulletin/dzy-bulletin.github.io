# 規格：鼎兆元｜電子佈告欄

- 版本：v1 / 2026-09-29
- 對應：requirements.md v1（2026-09-29 Eason 確認）
- 狀態：Eason 已確認（2026-09-29；第六節拍板：1A 遮罩、2 改為連錯 3 次鎖到主管重設、3 網址 dzy-bulletin）

---

## 一、整體架構

沿用現金帳、稽核系統已經驗證過的三層架構，不引入新技術：

```
同仁／管理者的手機瀏覽器（含 LINE 內建瀏覽器）
   │  純靜態頁，無框架、無 build step
   ▼
GitHub Pages   dzy-bulletin.github.io
   │  fetch POST，Content-Type: text/plain（避開 CORS preflight）
   ▼
Apps Script Web App（madesiaosinla，以擁有者身分執行、任何人可呼叫）
   ├── Google 試算表「鼎兆元｜電子佈告欄」── 4 個分頁（公告／同仁／已讀／操作紀錄）
   ├── Google 試算表「鼎兆元｜電子佈告欄｜公開名單」── 名單快照（只有遮罩姓名等公開欄位；發布到網路 CSV，選名字頁直接讀）
   ├── Google Drive 資料夾「鼎兆元｜電子佈告欄附件」
   └── 指令碼屬性 ──────────────────── 通行碼雜湊、簽章金鑰、各種 ID
```

- **repo**：`dzy-bulletin/dzy-bulletin.github.io`，public。GitHub Pages 免費版只能用 public repo，現金帳也是這樣做。
  - repo 裡**不放任何密碼或金鑰**。通行碼只存在指令碼屬性，而且存的是雜湊值。
- **MODE 切換**：`js/config.js` 裡設 `MODE: 'local' | 'cloud'`。網址加 `?mode=local` 就會跑內建的假資料後端（就是現在預覽頁那套）。
  - 本機測試和自動化測試一律用 local 模式，不會碰到正式試算表。
- **頁尾顯示版本號**：現金帳踩過「對方跑的還是舊版 JS」的坑，所以回報問題時先看版本號。
- **沒有排程**：到期下架是讀取時依台北日期判斷，所以沒有「排程沒跑」這個故障點。

## 二、資料存放

### 分頁 1「公告」
| 欄 | 名稱 | 說明 |
|---|---|---|
| A | id | `P-20260929-001`：上架建立日＋當日流水號，後端產生 |
| B | 標題 | 最多 60 字 |
| C | 內容 | 純文字（前端一律當純文字顯示，不解析 HTML） |
| D | 單位 | `mzt,mala,cf` 的子集合，逗號分隔；三個都勾＝「全部」 |
| E | 上架日 | `yyyy-mm-dd` |
| F | 到期日 | `yyyy-mm-dd` 或空白（空白＝不自動下架） |
| G | 置頂 | TRUE／FALSE |
| H | 上架中 | TRUE／FALSE（手動下架＝FALSE） |
| I | 手動下架日 | 按「下架」那天；重新上架時清空 |
| J | 附件 | JSON：`[{"id":"<driveId>","name":"x.pdf","type":"pdf","size":123}]`，最多 5 筆 |
| K | 建立時間 | ISO 格式 |
| L | 最後修改時間 | ISO 格式 |

**狀態判斷**（前後端共用同一段純函式，有單元測試）：
- `上架中=FALSE`：已下架，封存月份＝手動下架日的月份。
- `到期日 < 今天`：已下架，封存月份＝到期日的月份。
- `上架日 > 今天`：排定上架。
- 其餘：上架中。

**沒有刪除公告的功能。**

### 分頁 2「同仁」
| 欄 | 名稱 | 說明 |
|---|---|---|
| A | id | `S-001` 流水號 |
| B | 姓名 | 全名 |
| C | 單位 | `mzt`／`mala`／`cf` |
| D | 密碼雜湊 | `SHA-256(salt + pin)`，**不存明碼** |
| E | salt | 每人隨機一組 |
| F | 密碼版本 | 每次設定或重設 +1；登入憑證綁這個數字 |
| G | 連續錯誤次數 | 登入成功就歸零；**達 3 次＝鎖定，直到主管重設密碼** |
| H | 在職 | TRUE／FALSE。**刪除＝改成 FALSE**，簽名紀錄仍對得回姓名 |
| I | 建立時間 | |
| J | 刪除時間 | |
| K | 來源（打卡系統） | `gf|cf|js:emp_id`（2026-09-29 追加，打卡同步用） |
| L | 門市 | 墨竹亭同仁的門市（2026-09-30 追加） |
| M | LINE 綁定（雜湊） | `lineHash`（2026-10-09 追加）：`SHA-256('dzyb-line:' + LINE userId)` 小寫 hex，空白＝沒綁。來源是打卡系統 roster 的 `line_user_id`，只在 Apps Script 內轉成雜湊，原始 userId 不離開 Apps Script。**任何 API 回應都不帶這一欄**；Mac mini 是正本時，鏡像寫回試算表的這一欄一律空白 |

### 分頁 3「已讀」
| 欄 | 名稱 | 說明 |
|---|---|---|
| A | 公告 id | |
| B | 同仁 id | |
| C | 姓名 | 簽名當下的姓名快照 |
| D | 單位 | 快照 |
| E | 簽名時間 | ISO 格式 |
| F | 簽名檔 id | 簽名圖存成 Drive 檔案（附件資料夾下的「簽名」子資料夾），這格只存檔案 id。前端縮成 360px 寬的 PNG 再送，後端超過 45,000 字就拒收。**2026-09-29 實作時修正**：原規劃把圖直接存進試算表，但每年上萬筆簽名會讓整份表變得很慢，改存 Drive |

- 同一人對同一則只能簽一次，後端會擋重複簽。

### 分頁 4「操作紀錄」
時間｜動作（上架／編輯／下架／重新上架／置頂／取消置頂／新增同仁／刪除同仁／重設密碼／更換通行碼（ADMIN_INIT）／打卡同步）｜對象 id｜摘要。
通行碼只有一組、分不出是誰操作，所以至少把「做了什麼、什麼時候」留下來。

### 指令碼屬性（不進 repo）
`SPREADSHEET_ID`、`FOLDER_ID`（附件）、`SIG_FOLDER_ID`（簽名）、`ADMIN_HASH`、`ADMIN_SALT`、`ADMIN_VER`、`ADMIN_FAIL`、`ADMIN_LOCK`、`ADMIN_INIT`（首次登入後自動刪除）、`TOKEN_SECRET`、`DATA_GEN`（讀取快取世代）、`SNAP_SS_ID`（公開名單試算表）。打卡同步來源 ID 放 `gas/Config.local.js`（不進 git）。

## 三、身分與權限

### 同仁
1. 打開網址 → 呼叫 `roster` 取得名單。名單只回 id、**遮罩後的姓名**、單位、是否已設密碼（見第六節拍板 1）。
2. 點自己的名字：
   - 還沒設密碼 → 設定密碼（`setPin`）。已經設過密碼的人，後端拒絕再用這個動作。
   - 已設密碼 → 輸入密碼登入（`login`）。
3. 登入成功，後端發一張憑證：`staffId.pinVer.HMAC(TOKEN_SECRET, staffId|pinVer)`，存在手機的 localStorage。
   - **不需要另外的工作階段資料表。**
   - 重設密碼時 pinVer +1，舊憑證自動失效（等於把他的所有手機都登出）。
   - 同仁被刪除時，憑證同樣失效。
4. 讀公告、看歷史、簽名，都要帶憑證。**附件的 Drive 連結只回給持有憑證的人。**

### LINE 自動登入（2026-10-09 追加）
- 「鼎兆元打卡」LINE 官方帳號的選單「佈告欄」按鈕開 LIFF（`line.html`，LINE Login 頻道 2011292256；LIFF ID 填在 `js/config.js` 的 `LIFF_ID`，空白時 `line.html` 直接轉首頁）。
- `line.html`：`liff.init` → 沒登入就 `liff.login` → `liff.getIDToken()` → 呼叫 `lineLogin`。成功就照密碼登入一樣把憑證存進手機、轉首頁；一個 LINE 對到多人就列出遮罩姓名讓本人選；對不到人或任何失敗都轉首頁，選名字畫面上方顯示一次「這個 LINE 還沒對到名單，請選你的名字」。就算手機已記住某人也一律重新呼叫（共用手機、換帳號以 LINE 為準）。
- 後端向 LINE 驗證 ID token（`POST https://api.line.me/oauth2/v2.1/verify`，`aud` 必須是本頻道、`exp` 未過期），拿到的 `sub` 算成 `lineHash` 比對在職同仁。
- **LINE 登入不看也不動密碼與連錯次數**：沒設密碼、密碼被鎖住的人都能用 LINE 登入（鎖定保護的是 4 位數密碼被猜；LINE ID token 是另一個獨立證明）。發的憑證與密碼登入同一種，重設密碼（pinVer +1）一樣讓它失效。因此同仁憑證的驗證不再要求「已設密碼」。
- 綁定來源：主管按「打卡同步」時更新；Mac mini 每小時鏡像工作（`server/mirror.js` 第 4 步）也會只刷新 `lineHash`（不新增、不刪除同仁）。打卡離職或解除綁定 → 清空。

### 密碼防猜
- 4 位數只有 1 萬種組合，所以錯誤次數全部**由後端判斷**，前端顯示的次數只是提示。
- **連續錯 3 次就鎖住，直到主管在「設定 → 同仁名單」按「重設密碼」**（Eason 2026-09-29 定案）。中間輸對一次就重新計算。
- 所以一個帳號最多只能被猜 3 次，想暴力破解必須驚動主管。
- 被鎖的人在名單頁點名字時，直接顯示忘記密碼的那段話。管理端名單也標出「🔒 已鎖定」。
- 設定密碼時擋掉 0000～9999 同數字、1234 這類連號。

### 管理者
- 輸入管理通行碼 → `adminLogin` → 發一張 **7 天**有效的管理憑證（2026-09-30 由 12 小時改）。憑證綁 `ADMIN_VER`，變更通行碼後舊憑證全部失效。
- 管理通行碼連錯 5 次，鎖 15 分鐘。
- **通行碼只有 Eason 能設定與更換**（2026-09-29 定案，網頁不提供變更功能、API 也沒有 `changePass`）：在指令碼屬性填 `ADMIN_INIT`。**填入當下起**：所有舊的管理登入立即失效、舊通行碼不再接受，只接受新通行碼；有人用新通行碼登入成功時才轉成雜湊並刪除原文（輸錯不會消化它；鎖定中不比對；更換時新通行碼至少 6 碼），`ADMIN_VER`+1，寫操作紀錄「更換通行碼」。我不會經手正式通行碼。

## 四、附件（依 ② 探的實測結果）
1. 管理者在新增或編輯頁選檔。前端先檢查：副檔名只能是 doc、docx、pdf、xls、xlsx，最多 5 個，單檔 ≤ 20MB。
2. **一次傳一個檔**（`uploadFile`，base64 整包送出）：
   - 前端顯示「上傳中 2/5」，並提醒不要關閉頁面。
   - 逾時設 120 秒。實測 20MB 往返 28 秒，手機網路可能更慢。
3. 剛上傳的檔案：設定為**禁止下載／列印／複製**（`copyRequiresWriterPermission`），但先**不分享**。
4. 按「上架」或「儲存」時，才把這則公告的附件改成「知道連結者可檢視」。分享／撤銷前檢查：檔案必須在附件資料夾內，且 MIME 是 Word／PDF／Excel（擋掉正本試算表、簽名圖、資料夾）。順序是分享 → 寫試算表 → 撤銷移除的附件。
   - 所以上傳後沒有儲存就放棄的檔案，會一直保持私人，外人看不到。
5. 編輯時移除某個附件：**先關分享，再丟垃圾桶**。實測發現丟進垃圾桶後，有連結的人還是看得到。
6. 同仁端用 iframe 嵌入 `drive.google.com/file/d/<id>/preview`。
7. 後台顯示 Drive 已用空間與剩餘空間。這個空間和現金帳等系統共用。

## 五、API 契約
一律 `POST`，body 是 JSON 字串。回傳格式：成功 `{ok:true, data}`，失敗 `{ok:false, code, message}`。

| action | 需要 | 參數 | 回傳 data |
|---|---|---|---|
| `roster` | — | — | `[{id, name(遮罩), unit, store, hasPin, locked}]`（只列在職；Code.js 以 CacheService 快取結果 10 分鐘，世代換了即失效） |
| `setPin` | — | `staffId, pin` | `{token, me, board}`（board 同 `board` 回傳，登入少一次往返） |
| `login` | — | `staffId, pin` | `{token, me, board}`；錯誤時 code＝`BAD_PIN`（附剩餘次數）／`LOCKED`（需主管重設） |
| `lineLogin` | — | `idToken`（LIFF 的 LINE ID token）, `staffId?`（對到多人時本人選的那位） | 對到一人：`{token, me, board}`（同 `login`）；多人且沒帶 staffId：`{choices:[{id, name(遮罩), unit}]}`；錯誤 code＝`LINE_NOT_LINKED`（對不到在職同仁，或 staffId 不在對到的人裡）／`LINE_BAD`（LINE 驗證失敗）／`LINE_DOWN`（連不上 LINE）／`BUSY`（Mac mini 每分鐘超過 30 次）。寫入類動作（上鎖），但不寫任何資料；不記錄 idToken 與 LINE userId |
| `board` | 同仁憑證 | — | `{today, me, posts:[上架中，三個單位全部], myReads:{postId: 簽名時間}}` |
| `history` | 同仁憑證 | — | `{today, posts:[已下架], myReads:{postId: 簽名時間}}` |
| `ack` | 同仁憑證 | `postId, sig` | `{at}`；已經簽過回 code＝`ALREADY` |
| `adminLogin` | — | `pass` | `{atoken, data}`（data 同 `adminData`） |
| `adminData` | 管理憑證 | — | `{today, posts:[每則含 status、readCount、targetCount], staff:[{id,name(全名),unit,store,hasPin,locked}], quota:{limit,usage}\|null}` |
| `receipts` | 管理憑證 | `postId` | `{rows:[{staffId, name, unit, active, inTarget, read, at, sig}]}`（應讀名單＋不在應讀名單但簽過的人；`active`＝同仁是否在職，`inTarget`＝是否屬於公告目前的單位；簽名圖只在展開時才載入） |
| `uploadFile` | 管理憑證 | `name, data(base64)`（類型與 MIME 一律由後端依副檔名判斷） | `{id, name, type, size}` |
| `savePost` | 管理憑證 | `post:{id?, title, body, units, publishOn, expiresOn, pinned, files}`, `reqId`（冪等鍵，綁一份草稿：同 reqId＋同內容指紋＝重送，回傳第一次結果；同 reqId 但內容不同＝改為編輯第一次建立的那則；6 小時內有效） | `{post}` |
| `setPublished` | 管理憑證 | `postId, on` | `{post}` |
| `setPinned` | 管理憑證 | `postId, on` | `{post}` |
| `staffAdd` | 管理憑證 | `name, unit, store`（墨竹亭必填：光復／金山／六張犁；其他單位忽略） | `{staff}` |
| `staffSetStore` | 管理憑證 | `staffId, store`（只限墨竹亭同仁） | — |
| `staffDelete` | 管理憑證 | `staffId` | — |
| `staffResetPin` | 管理憑證 | `staffId` | — |
| `syncClock` | 管理憑證 | — | `{added:[姓名（單位）], adopted, left:[{id,name,unit}], counts:{來源:在職人數}, errors:[]}`（2026-09-29 追加：從小辛辣光復、央廚、墨竹亭金山打卡系統 roster 唯讀同步；只新增，打卡已離職者只列出不刪；同仁表新增「來源」欄 `src`＝`gf|cf|js:emp_id`；2026-10-09 起同時更新 `lineHash`：在職→打卡名單的綁定、離職或沒綁→清空，讀取失敗的那店不動） |

- 所有寫入都用 `LockService` 排隊，避免兩個人同時上架時流水號重複。
- 後端的日期一律用 `Asia/Taipei`。

## 六、已拍板（2026-09-29）
- 1A：名單姓名遮罩中間字（兩字名遮第二字「陳O」；三字「陳O安」；四字以上保留頭尾、中間全遮「歐OO娜」；逐字元規則見 task.md 共用契約 C3）
- 2：連錯 3 次鎖到主管重設（取代「5 次鎖 5 分鐘」與「累計 20 次」）
- 3：網址 `dzy-bulletin.github.io`（`/dzy` 已是集團管理系統）

### 原始選項（留存）

1. **名單上的姓名要不要遮罩？** 同仁選名字那一頁，知道網址的任何人都看得到。
   - **A. 遮住中間字，例如「陳O安」（建議）**：本人認得出自己，外人拿到網址也看不到全名。管理端照樣顯示全名。
   - B. 顯示全名。
2. **累計錯 20 次要不要鎖到主管重設？**
   - **A. 要（建議）**：擋住有人每天慢慢試別人的密碼。
   - B. 不要，只保留「連錯 5 次鎖 5 分鐘」。
3. **網址**：
   - **A. `dzy-bulletin.github.io`（建議）**：跟其他系統同一個網域。
   - B. 你想要別的名稱就告訴我。

## 七、測試方式（④ 驗收用）
- **純函式單元測試**（node）：狀態判斷、封存月份、密碼強度、遮罩姓名、憑證簽發與驗證、附件檢查。
- **端到端測試**（Playwright，local 模式）：同仁端（設密碼 → 登入 → 讀 → 簽名 → 歷史區）、管理端（上架 → 排定 → 下架 → 重新上架 → 置頂 → 回條 → 同仁增刪 → 重設密碼 → 被登出），並監聽頁面錯誤（現金帳踩過「整份 script 語法錯、畫面照常顯示」的坑）。
- **真環境**：用正式後端傳三種檔案，驗證未登入時看不到下載鈕、關分享後連結失效。
- **你的手機**：從 LINE 點連結，走完一次設密碼 → 簽名，再實際傳一個大檔案。

## 八、名單快照與發布規則（2026-09-30 追加；Fable 審查 #4 阻斷 3）
- 快照**只寫在獨立的「公開名單」試算表**（指令碼屬性 `SNAP_SS_ID`），欄位 `id,name(遮罩),unit,store,hasPin(Y/空),locked(Y/空)`。**主試算表絕不發布到網路**（含密碼雜湊與 salt）。
- 同仁表有異動的請求，在結束時（`store.endRequest`）重寫一次快照；失敗只記紀錄，不影響已成功的寫入。
- 發布：公開名單試算表「檔案 → 共用 → 發布到網路 → 整份文件／CSV」，網址填入 `js/config.js` 的 `ROSTER_CSV`。Google 約 5 分鐘更新一次發布內容；前端以本機變化與後端結果補正。
- 驗收：發布網址內容只有上述 6 欄，不含任何姓名全文、雜湊或 salt。
- **復原**：公開名單試算表被刪或打不開 → 執行紀錄會出現「名單快照寫入失敗」；到指令碼屬性刪掉 `SNAP_SS_ID`，下一次同仁異動（例如按打卡同步）會自動重建，重新發布後把新網址填進 `ROSTER_CSV`。發布網址失效時前端會自動改用本機快取與後端名單，只是變慢。

