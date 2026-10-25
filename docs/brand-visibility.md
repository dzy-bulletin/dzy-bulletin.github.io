# 公告依品牌可見（v0.8.0，2026-10-25 Eason 拍板）

取代 2026-09-29「所有人三個分頁都看得到」。Eason 原話：「公告專區自己只看得到自己品牌的公告，看不到別的品牌公告」。

## 規則（Eason 2026-10-25 逐題確認）

| 同仁 | 看得到的分頁 | 要簽（不變） |
|---|---|---|
| 墨竹亭門市（`mzt`） | 墨竹亭 | 含墨竹亭的公告 |
| 小辛辣門市（`mala`） | 小辛辣 | 含小辛辣的公告 |
| 央廚（`cf`） | 央廚 | 含央廚的公告 |
| 總部墨竹亭（`hq-mzt`，墨竹亭品牌辦公室） | 墨竹亭 | 含墨竹亭的公告 |
| 總部小辛辣（`hq-mala`，小辛辣品牌辦公室） | 小辛辣 | 含小辛辣的公告 |
| 總部鼎兆元（`hq-dzy`，各部門同仁） | 墨竹亭（Eason：「目前總部的部門同仁都只為墨竹亭服務」） | 只簽「全部」 |
| **總監級以上**（任何單位，`seeAll`） | 三個分頁 | 依自己單位（同上） |
| 公告管理（主管後台） | 全部（不受影響） | — |

- **總監級以上**＝管理系統職稱代碼 `hm` 總監、`odir` 品牌辦公室總監、`rdd` 廚藝總監、`ceo` 執行長、`gm` 總經理、`chair` 董事長（正本 `server/staff-dzy.js SEE_ALL_TITLES`）。
- **「全部」公告**（上架時三單位全選）：每個人都看得到，出現在自己的分頁。
- 公告**任一顯示單位**在同仁看得到的分頁內就看得到（例：上架選「墨竹亭＋央廚」→ 墨竹亭門市與央廚都看得到，小辛辣看不到）。
- 只看得到一個分頁的人：品牌分頁列不顯示（畫面直接是那一區的公告）。
- 兼任部門（`extra_depts`）、一悟燒肉：先不處理，看主單位（Eason 選）。

## 擋在哪裡
- **後端擋**：`board`、`history` 只回 `canSee` 為真的公告；`ack` 對看不到的公告回「這則公告不需要你簽名」。前端只是跟著顯示分頁。附件連結只在公告內容裡，看不到公告就拿不到連結。
- 規則純函式 `js/logic.js`：`viewTabs(unit, seeAll)`、`canSee(unit, p, seeAll)`；`Service.js` 一律傳 `s.unit, !!s.seeAll`。

## 「總監級以上」怎麼來
- 管理系統 `svcDirectory` 每筆多回 `title`（職稱代碼；dzy `bulletin-dir-title` 分支）。
- Mac mini 每小時 `staff-dzy.js` 同步：該筆**有 `title` 欄位**時（去空白、轉小寫），職稱在 `SEE_ALL_TITLES` → 同仁資料 `seeAll: true`，否則刪掉 `seeAll`；**沒有 `title` 欄位**（管理系統還是舊版）→ 不動；離職 → 清掉。
- 人工認領（`runClaim`／`clearCredentials`）與退回打卡名單（`runRollback`）都會清掉 `seeAll`（#45-2）：認領不繼承前一位的總監可見；退回後沒有同步會收回，所以一律不給。
- 不算總監級：`osv` 區督導、`bd` 品牌總監（已停用）、`sv`（已停用）。
- 手動新增、沒連到管理系統的同仁：沒有 `seeAll` → 依單位。
- `me()`（登入、board 回應）多回 `seeAll`，前端用它算分頁。

## 已知限制
- 職稱改了要等下一輪**成功的**每小時同步才生效（升總監最多一小時；那輪同步若整輪拒寫，例如名單有歧義，降職收回也會跟著延後）。
- 回退到 Google（Apps Script）期間：試算表沒有 `seeAll` 欄 → 總監級以上暫時只看自己單位的分頁。
- 0.8.0 以前已看過的別品牌公告：附件連結不會因此失效；手機上舊的公告快取在下一次載入時就換成新規則。

## 部署順序（四步，#45-1）
1. **管理系統後端**（dzy 分支 `bulletin-dir-title` 合併 main → `sync-gas.sh dzy-platform --i-know` → minikit push → Mac mini 拉新版、重啟平台）：`svcDirectory` 多回 `title`。舊佈告欄不認得這欄，無影響。
2. **佈告欄 Mac mini 伺服器**（照 `server/DEPLOY.md` 附錄 B 更新到 main）：後端開始擋；下一輪每小時同步給總監 `seeAll`。
3. **佈告欄 Apps Script（回退備援）**：在這台 MacBook 的 `~/dzy-bulletin` `clasp push -f`＋`clasp deploy -i <既有部署 ID>`（0.8.0）。**沒推之前不得回退到 Google**：GAS 仍是 0.7.9 時規則是「所有人看三區」。
4. **前端**（push main → GitHub Pages）：分頁只剩自己品牌、一區時藏分頁列。
- 2 在 1 之前：總監在管理系統更新前只看得到自己單位（不洩漏，只是看太少）。4 在 2 之前：前端只顯示自己品牌分頁，但舊後端仍回全部公告（舊行為），不會壞。

## 測試
- `test/logic.test.js` C15 區：每種單位 × seeAll 的 viewTabs／canSee。
- `test/service.test.js`（或對應的服務層測試）：board／history 過濾、ack 擋看不到的公告。
- `test/staffdzy.test.js`：title → seeAll（設、清、欄位缺席不動）。
- e2e：`e2e/judge.py`、`e2e/run.py` 三次；真瀏覽器看門市與總監兩種人。
