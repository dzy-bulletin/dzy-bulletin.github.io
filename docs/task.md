# 任務清單：鼎兆元｜電子佈告欄

- 版本：v1 / 2026-09-29
- 每個任務的程式碼控制在 100–200 行；每個任務都寫明輸入、輸出和可以打勾的驗收條件。

## 共用契約（逐字元格式；平行任務都照這裡，不准自創）

| # | 名稱 | 格式 | 範例 |
|---|---|---|---|
| C1 | 單位代號 | `mzt`／`mala`／`cf`；顯示名依序是 墨竹亭／小辛辣／央廚；陣列一律依這個順序排 | `["mzt","cf"]` |
| C2 | 日期 | `YYYY-MM-DD`，台北時區；「今天」一律用 `Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei'})` | `2026-09-29` |
| C3 | 姓名遮罩 `maskName(n)` | 先去掉頭尾空白，再依長度（以字元數算，`[...n].length`）處理：1 字→原樣；2 字→第 1 字＋`O`；3 字以上→首字＋`O`×(長度−2)＋末字。遮罩字元是大寫英文字母 `O` | `陳`→`陳`；`陳安`→`陳O`；`陳小安`→`陳O安`；`歐陽娜娜`→`歐OO娜` |
| C4 | 公告 id | `P-` + 建立日期去掉連字號 + `-` + 當日三位流水號 | `P-20260929-001` |
| C5 | 同仁 id | `S-` + 三位流水號（超過 999 就自然變四位） | `S-007` |
| C6 | 同仁憑證 | `staffId + "." + pinVer + "." + base64url(HMAC_SHA256(secret, staffId + "\|" + pinVer))`，base64url 去掉 `=` | `S-007.2.q9Xk…` |
| C7 | 管理憑證 | `"A." + adminVer + "." + expMs + "." + base64url(HMAC_SHA256(secret, "A\|" + adminVer + "\|" + expMs))` | `A.1.1759200000000.Zr…` |
| C8 | 密碼雜湊 | `hex(SHA256(salt + pin))`；salt 是 16 bytes 隨機值的 hex | — |
| C9 | 弱密碼 | 不是 `^\d{4}$` → 無效；四碼相同（`^(\d)\1{3}$`）或是 `0123456789`／`9876543210` 的子字串 → 太弱 | `1234`、`8765`、`0000` 都擋 |
| C10 | 狀態 `status(p, today)` | 回傳 `{state:'on'\|'plan'\|'off', offDate, month}`；規則見 spec 第二節；`month` 是 `YYYY-MM` | — |
| C11 | 附件物件 | `{id, name, type:'pdf'\|'docx'\|'xlsx', size}`；`.doc` 的 type 算 `docx`，`.xls` 的 type 算 `xlsx` | — |
| C12 | API 回傳 | 成功 `{ok:true,data}`；失敗 `{ok:false,code,message}`。code 只能用：`BAD_REQ` `AUTH` `BAD_PIN` `LOCKED` `WEAK_PIN` `HAS_PIN` `ALREADY` `NOT_FOUND` `TOO_BIG` `BAD_TYPE` `ADMIN_LOCKED` `SERVER`（前端另有 `NET`＝網路逾時；`checkFiles` 的 `TOO_MANY` 是前端內部碼，不作為 API code） | — |
| C13 | localStorage 鍵 | 前綴一律用 `dzyb_`（同一個 github.io 網域的其他系統共用 localStorage，不准沒有前綴）：`dzyb_token`、`dzyb_atoken`、`dzyb_mock_db` | — |
| C15 | 同仁所屬（2026-09-29 Eason 追加總部） | 名單單位 `mzt` `mala` `cf` `hq-dzy`（總部鼎兆元）`hq-mzt`（總部墨竹亭）`hq-mala`（總部小辛辣）；公告單位仍只有前三個。**看得到**（2026-10-25 v0.8.0 Eason 改，詳 `docs/brand-visibility.md`）：只看自己品牌——門市／央廚＝自己單位、`hq-mzt`→墨竹亭、`hq-mala`→小辛辣、`hq-dzy`→墨竹亭；同仁 `seeAll: true`（管理系統職稱總監級以上，每小時同步）三個分頁都看；後端 board／history／ack 擋。（2026-09-29～10-24 曾是所有人三分頁都能看。）**要簽**：門市＝公告含自己單位；`hq-mzt`／`hq-mala`＝含該品牌；`hq-dzy`＝只簽三單位全選（「全部」）的公告。函式：`viewTabs(unit, seeAll)` `canSee(unit, p, seeAll)` `mustSign` `homeTab` | 總部墨竹亭只看得到墨竹亭；只需簽含墨竹亭的公告 |
| C16 | 門市 | `STORES = { mzt: ['光復','金山','六張犁'] }`；同仁 `store` 欄；只有墨竹亭分門市；名單快照（獨立的公開名單試算表）欄位 `id,name,unit,store,hasPin,locked`（name 已遮罩、hasPin／locked 為 Y 或空白） | — |
| C14 | 連錯鎖定 | 同仁連錯 3 次 → 鎖到主管重設；管理通行碼連錯 5 次 → 鎖 15 分鐘 | — |

## Phase 1

### T1 `js/logic.js`＋`test/logic.test.js`
- **輸入**：C1、C2、C3、C9、C10、C11。
- **輸出**：`UNITS`、`today()`、`addDays`、`status`、`sortBoard`（置頂優先，其次上架日新到舊）、`maskName`、`pinProblem(pin)`（回傳 null 或錯誤碼）、`fileType(name)`、`checkFiles(list)`（副檔名、數量 ≤5、單檔 ≤20MB）。
- **驗收**：
  - [ ] node 測試全部通過，至少 30 項，涵蓋 C3 的 4 個範例、C9 的邊界、狀態判斷四種情況與跨月。
  - [ ] 同一份檔案用瀏覽器 `<script>` 載入不會報錯。

### T2 `gas/Auth.js` 的核心邏輯＋`test/auth.test.js`
- **輸入**：C6、C7、C8、C14。
- **輸出**：`newSalt`、`hashPin`、`makeStaffToken`、`verifyStaffToken(secret, token, staffRow)`、`makeAdminToken`、`verifyAdminToken`、`staffLogin(row, pin)`（驗證＋回傳新的連錯次數與 `BAD_PIN`／`LOCKED`）、`adminLogin(state, pass, nowMs)`。（2026-09-29 階段關 r1 後修訂：原寫 `applyLoginResult(row, ok)`，改為驗證與計數同一函式，避免呼叫端漏寫回）
  - 加密函式從外部注入：GAS 版用 `Utilities`，node 版用 `crypto`。
- **驗收**：
  - [ ] 竄改憑證任一字元 → 驗證失敗。
  - [ ] pinVer +1 → 舊憑證失效。
  - [ ] 過期的管理憑證會被拒絕。
  - [ ] 連錯 3 次會鎖住；錯兩次後輸對一次，錯誤次數歸零。

### T3 `js/mock.js` 本機假後端
- **輸入**：spec 第五節 API 契約全部 17 個 action。
- **輸出**：`DZYB_MOCK.call(action, payload)` → Promise（node 測試用 `DZYB_MOCK.callSync`），回傳格式照 C12。資料放 `dzyb_mock_db`，預設假資料沿用預覽頁（含測試員甲／乙／丙）。內部直接呼叫 `gas/Service.js`，與正式後端共用同一份商業邏輯。
- **驗收**：
  - [ ] node 腳本逐一呼叫 17 個 action，回傳格式都正確。
  - [ ] 不帶憑證呼叫 board → `AUTH`。
  - [ ] 連錯 3 次 → `LOCKED`。

### T4 `index.html`＋`css/app.css`＋`js/config.js`＋`js/api.js`＋`js/staff.js`（名單與密碼流程）
- **輸出**：名單頁顯示遮罩姓名；可以設密碼、登入；鎖定的人點名字直接看到忘記密碼的說明；「不是我」登出。
- **驗收**：
  - [ ] local 模式走完「設密碼 → 登入 → 登出 → 再登入」。
  - [ ] 頁尾顯示版本號。
  - [ ] 沒有任何頁面錯誤（pageerror）。

### T5 `js/staff.js`（公告、歷史、內容頁、附件檢視）＋`js/sign.js`
- **輸出**：公告與歷史兩個分頁、單位切換、紅點、內容頁、iframe 附件檢視、手寫簽名 → `ack`。
- **驗收**：
  - [ ] 未讀紅點只出現在自己的單位。
  - [ ] 沒簽名就按確認會被擋。
  - [ ] 簽完紅點消失，內容頁顯示簽名圖。
  - [ ] 歷史區依月份分組正確。

### T6 `js/admin.js`（登入、公告管理列表、回條）
- **驗收**：
  - [ ] 通行碼錯誤有提示。
  - [ ] 三種分類的數量正確。
  - [ ] 下架、重新上架、置頂之後，同仁端立刻反映。
  - [ ] 回條展開時顯示簽名圖。

### T7 `js/admin.js`（公告表單、上傳進度、同仁名單、通行碼、空間）
- **驗收**：
  - [ ] 附件超過 5 個或超過 20MB 會被擋，並顯示原因。
  - [ ] 上傳時顯示「上傳中 n/總數」。
  - [ ] 重設密碼後，該同仁被登出。
  - [ ] 名單上會標出「已鎖定」。

## Phase 2

### T8 `gas/Store.js`＋`gas/Code.js`（路由、同仁與公告相關 action）
- **驗收**：
  - [ ] 17 個 action 都照契約回應。
  - [ ] 寫入動作（`Service.WRITE_ACTIONS`）都在 `LockService.getScriptLock()` 內執行（`gas/Code.js` doPost）。
  - [ ] `roster` 只回遮罩姓名，絕不回雜湊值或 salt。

### T9 `gas/Files.js`＋`setup()`
- **輸出**：
  - 上傳時設定 `copyRequiresWriterPermission`，但先不分享；儲存公告時才分享。
  - 移除附件時先關分享、再丟垃圾桶。
  - `quota` 回報空間用量。
  - `setup()` 建立試算表、4 個分頁、附件資料夾與隨機金鑰。
- **驗收**：
  - [ ] 真環境上傳三種檔案。
  - [ ] 未分享前，連結打不開。
  - [ ] 分享後，未登入 Google 也能看，而且沒有下載鈕。
  - [ ] 移除附件後，連結打不開。

### T10 部署
- clasp create（madesiaosinla）→ push → deploy。
- **Eason 要做**：在編輯器跑 `setup()`、在指令碼屬性填 `ADMIN_INIT`。
- 建 GitHub repo，開啟 Pages。
- **驗收**：
  - [ ] `dzy-bulletin.github.io` 打開正常，而且預設是 cloud 模式。
  - [ ] 用 `?mode=local` 還能切到假資料。

## Phase 3

### T11 Playwright 端到端測試（local）
- **驗收**：
  - [ ] 同仁端與管理端兩條完整流程全部通過。
  - [ ] 過程中 pageerror 是 0 次。

### T12 真環境與 Eason 手機實測
- **驗收**：
  - [ ] Eason 從 LINE 點連結：記得身分、看得到附件、可以簽名。
  - [ ] 用手機傳一個大檔案，記下實際花了幾秒。
  - [ ] 正式名單匯入完成（由 Eason 提供，或自己在設定頁輸入）。

### T13 ⑤ 落地清單八項
- 登錄資源清單、建立 skill、登錄路由、寫一則記憶、進版控、清理 spike。
- 本系統沒有排程，所以監看與故障追蹤兩項標「不適用＋原因」。
