# 打卡回覆帶出未簽公告 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 同仁 LINE 打卡成功後，機器人回覆卡片列出還沒簽的公告（最多 3 則）＋「去佈告欄簽名」按鈕。

**Architecture:** 佈告欄 Mac mini 每 5 分鐘算好 `{lineHash: {n, titles}}` 推給光復打卡 Apps Script；機器人回覆「打卡」時只讀自己 CacheService 裡的這包，不即時連 mini。

**Tech Stack:** Node（佈告欄 server，node:sqlite 唯讀）、Google Apps Script（光復 LineHub.gs）、LINE Flex。

**Spec:** `docs/punch-remind.md`（本 repo）

## Global Constraints
- 對人鍵：`sha256hex('dzyb-line:' + LINE userId)`（`js/logic.js LINE_HASH_PREFIX`）。
- 要提醒＝`L.status(p,td).state==='on'` && `L.canSee(s.unit,p,s.seeAll===true)` && `L.mustSign(s.unit,p)` && reads 無 (p.id,s.id)；同仁 `active` 且 lineHash 是 64 位 hex。排序 `L.sortBoard`。
- 標題最多 3 則、每則 30 字（超過截斷加「…」）；n＝全部未簽則數。
- 推送：POST text/plain `{action:'line_hub_bulletin_put', key, at, v:1, map}`；整包 > 90000 bytes 改成每人只留第 1 則標題並 `trimmed:true`。
- 機器人端：Script Property `BULLETIN_PUSH_KEY`；CacheService `lhb:v1`（map JSON）＋`lhb:at`，TTL 21600；`at` 超過 30 分鐘不提醒；任何例外不提醒、不影響回覆。
- 按鈕 `https://liff.line.me/2011292256-iTZEbOWG`，文字「去佈告欄簽名」。`lineHubPunchText_` 不改；失敗卡片不帶。
- 兩個 repo 都是 public：不寫真名、不寫 Funnel 網址、不寫金鑰。

## Review Focus
1. 公告標題含 emoji／換行／超長：截斷不切壞代理字元、換行換成空白 → 測 `pendingByLine` 截斷。
2. 同一個 lineHash 對到兩位在職同仁：合併、標題去重 → 測 `pendingByLine`。
3. CacheService 裡是壞 JSON 或 `at` 不是日期：不提醒、回覆照常 → 測 `lineHubBulletinFor_`。
4. 推送的 map 不是物件／值不合格（n 非數字、titles 非陣列）：機器人拒收 bad_input，不寫快取 → 測 handler。
5. 簽完的公告（reads 有列但沒簽名圖）不再提醒；看不到的別品牌公告不提醒 → 測 `pendingByLine`。

---

### Task 1: 佈告欄算名單＋推送工作

**Files:**
- Create: `server/punch-remind-push.js`
- Modify: `server/sign-remind.js`（exports 多 `loadData`）
- Test: `test/punch-remind.test.js`

**Interfaces:**
- Produces: `pendingByLine(data:{posts,staff,reads}, td:'YYYY-MM-DD') → {[hash]:{n:number,titles:string[]}}`；`buildPayload(map, atIso, key) → {payload, bytes, trimmed}`；`runPush({dir, url, key, dryRun, retryMs, now}) → {at, ok, people, posts, bytes, trimmed, error?}`；常數 `TITLE_MAX=30, LIST_MAX=3, MAX_BYTES=90000`；檔名 `punch-remind-last.json`／`punch-remind.log`；env `PUNCH_REMIND_URL`、`PUNCH_REMIND_KEY`。
- 送出沿用 `J.postHelperRetry`（回 ok:false＝拒收不重試）。`takeLock(dir,'punch-remind',4*60e3)` 防重疊。

- [ ] Step 1: 寫測試（照 `test/remind.test.js` 形狀，假 HTTP 伺服器）：單位×seeAll×mustSign×已讀／未讀×狀態 on/plan/off×無 lineHash；3 則上限、n 計全部、30 字截斷（含 emoji）、換行→空白、同 hash 合併去重；90KB 裁切 `trimmed`；`--dry-run` 不送不寫 last；未設 env 印「尚未啟用」exit 0；拒收寫 ok:false；last.json 不含姓名或標題。
- [ ] Step 2: `node test/punch-remind.test.js` → FAIL（模組不存在）
- [ ] Step 3: 實作 `server/punch-remind-push.js`
- [ ] Step 4: 測試全過；`node test/remind.test.js` 仍過
- [ ] Step 5: commit

### Task 2: 健康燈、launchd、部署手冊

**Files:**
- Modify: `server/index.js`（health 多 `punchRemind: job('punch-remind-last.json', j => ({at, ok, people}))`）、`server/health-rules.js`（ok===false 或 at 超過 30 分鐘 → 黃「打卡公告提醒送出失敗／停了」；null 不影響）
- Create: `server/launchd/com.dzy.bulletin.punchremind.plist`（StartInterval 300，佔位字串同 remind）
- Modify: `server/DEPLOY.md`（新增「打卡公告提醒（選用）」一節：.env 兩鍵、dry-run、裝 plist、回退）
- Test: 既有 health 測試所在檔（`test/jobs.test.js` 或 `server.test.js`，以實際放 judgeHealth 測試的那支為準）加 3 案例

- [ ] Step 1: 加測試（失敗→黃、過期→黃、null→不影響）→ FAIL
- [ ] Step 2: 實作 → 全部 test/*.test.js 過
- [ ] Step 3: `plutil -lint` plist；commit

### Task 3: 打卡機器人收資料＋卡片段落（mala-clock-in worktree）

**Files:**
- Modify: `apps-script/LineHub.gs`
- Test: `tests/line-hub-bulletin.test.js`

**Interfaces:**
- Produces: `lineHubSha256Hex_(s:string) → string`；`handleLineHubBulletinPut_(b) → {ok:true,people}|{ok:false,error:'unauthorized'|'bad_input'|'too_big'}`（LINE_HUB_HANDLERS 註冊 `line_hub_bulletin_put`）；`lineHubBulletinFor_(userId) → {n,titles}|null`；webhook「打卡」`r.ok` 時 `r.bulletin = lineHubBulletinFor_(userId)`；`lineHubPunchCard_` 依 `r.bulletin` 加段落＋按鈕。常數 `LINE_HUB_BULLETIN_LIFF`、`LINE_HUB_BULLETIN_STALE_MS=1800000`、`LINE_HUB_BULLETIN_MAX=90000`。
- 金鑰比對：沒設或長度 < 32 → unauthorized。

- [ ] Step 1: 寫測試（vm 載 Liff.gs＋LineHub.gs，假 CacheService／PropertiesService／Utilities.computeDigest 用 node crypto 回帶號 byte）：雜湊＝node `sha256('dzyb-line:'+uid)`；金鑰錯／沒設；bad_input；too_big；寫入後 `lineHubBulletinFor_` 取得；at 過期→null；壞 JSON→null；卡片有「📢 還沒簽的公告」、3 則、n>3「還有 N 則」、按鈕 uri；bulletin null 卡片與現在逐字相同；失敗卡片不帶。
- [ ] Step 2: `node tests/line-hub-bulletin.test.js` → FAIL
- [ ] Step 3: 實作
- [ ] Step 4: `node tests/run-all.js` 全過
- [ ] Step 5: commit

### Task 4: 串接實測、PR、上線腳本

- [ ] Step 1: 本機串接：佈告欄測試資料 → `runPush` 打一支用 vm 跑 LineHub handler 的假 /exec → 用 webhook 假事件（同一個 userId）產卡片，內容含標題（scratchpad 腳本，不進 repo）。
- [ ] Step 2: 兩個 repo 各開 PR（不寫真名、不寫網址金鑰）。
- [ ] Step 3: 上線腳本（scratchpad）：光復三方比對只換 LineHub.js → push/version/redeploy → 錯金鑰探針 `line_hub_bulletin_put` 回 unauthorized＝新版。給 Eason 的 mini 步驟：產金鑰、兩邊貼、dry-run、裝 plist。
