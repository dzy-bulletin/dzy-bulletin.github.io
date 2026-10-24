# 回退手冊：Mac mini → Apps Script（#10）

本手冊用在兩種情況：

- 切換後出問題，要退回 Google Apps Script（GAS）。
- 觀察日結束後的**回退演練**（#10 步驟 10，必做）。演練時照著「回退」做完第 1～6 步，再做〈附錄 A：再切回 Mac mini〉。

> **角色**
> - **Eason**：GAS 指令碼屬性、LINE 公告、手機與主管瀏覽器實測。
> - **Mac mini 的 Claude**：只在 Mac mini 上跑指令。
> - **MacBook 的 Claude**：改前端、push、clasp。
>
> **Claude 絕不經手 `BRIDGE_KEY`**：不印出、不貼、不寫檔。GAS 指令碼屬性只有 Eason 能改。

## 先分清楚是哪一種

> **v0.8.0 起（公告依品牌可見）**：回退前 Apps Script 必須已部署 0.8.0（0.7.9 的規則是所有人看三區）；回退期間總監級以上只看自己單位。詳 `docs/brand-visibility.md`。


| 狀況 | 走哪條 | 丟失 |
|---|---|---|
| Mac mini **還活著**（伺服器、網路都在） | 第 1 → 2 → 3 → 4 → 5 → 6 步，順序固定、不可調換 | 0 筆（前提是第 1 步先做；missing／bad 那幾張簽名圖例外，見第 2 步） |
| Mac mini **死了**（開不了機、連不到） | 〈Mac mini 死了的回退〉 | 上一次鏡像成功之後的資料 |

**鐵則**

1. **先** `PRIMARY=gas`（第 4 步），**再**改前端網址（第 5 步）。
   - `PRIMARY=gas` 同時封死 Mac mini 的鏡像：GAS 在 `PRIMARY≠mini` 時一律對 `mirror` 回 `AUTH`（#7）。
2. Mac mini 活著時，**第 1 步 `READONLY` 一定最先做**。
   - 不做的話，從第 4 步到第 5 步生效之間（Pages 快取約 10 分鐘），Mac mini 仍會收簽名，這段會丟。
3. **第 5 步生效之後，絕對不可以再跑 `mirror.js`，也不可以再設 `PRIMARY=mini`。**
   - 這時同仁已經在往 GAS 寫資料，而 `mirror` 是整份覆寫四個分頁，會把這些新資料全部蓋掉。
   - 第 5 步之後發現任何鏡像相關的問題，一律照第 6 步〈失敗怎麼辦〉處理。
4. 關 launchd 的 job 一律用 **`disable` 再 `bootout`**，恢復用 **`enable` 再 `bootstrap`**。
   - 只做 `bootout` 撐不過重開機：`~/Library/LaunchAgents/` 的 plist 重開機後會自動載入。
   - `disable` 會記在 launchd 的覆寫表裡，重開機也不會自動跑起來。

下面的指令都在 **Mac mini、repo 根目錄**執行。**每一段指令前都要先貼下面這段**：Claude 每次 Bash 呼叫都是新的 shell，上一次設的變數和函式都不在了。

```sh
cd ~/dzy-bulletin
export PATH="$HOME/.local/node/bin:$PATH"; command -v node   # Mac mini 沒把 Node 放進 PATH（DEPLOY.md〈交接給 M5〉）；export PATH 讓子程序（build.sh、restore.js）也吃得到。這行要印出 …/.local/node/bin/node，印別的（例如 Homebrew 的 /opt/homebrew/bin/node）就停下來查
export DATA_DIR="$(sed -n 's/^DATA_DIR=//p' server/.env | tr -d "\"'")"; DATA_DIR="${DATA_DIR:-$HOME/dzy-bulletin-data}"; DATA_DIR="${DATA_DIR/#\~/$HOME}"
U="gui/$(id -u)"
counts() { node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]+'/bulletin.db',{readOnly:true});console.log(['posts','staff','reads','log'].map(t=>t+' '+d.prepare('SELECT COUNT(*) n FROM '+t).get().n).join('  '))" "$DATA_DIR"; }
job_off() { launchctl disable "$U/$1"; launchctl bootout "$U/$1" 2>/dev/null; launchctl print "$U/$1" >/dev/null 2>&1 && echo "✗ $1 還在跑" || echo "✓ $1 已停、已 disable"; }
job_on()  { launchctl enable "$U/$1"; launchctl bootstrap "$U" "$HOME/Library/LaunchAgents/$1.plist" && echo "✓ $1 已 enable＋載入"; }
```

---

## 1. 停掉每小時鏡像、建立 READONLY（凍結 Mac mini）

**負責人**：Mac mini 的 Claude

順序與 DEPLOY.md〈交接給 M5〉的回退說明相同：**先停每小時鏡像，再建 READONLY**。第 2 步的 `--all` 是手動跑的，不需要 launchd；launchd 那一輪如果剛好拿著工作鎖，`--all` 會直接跳過並印 `pending=null`，容易誤讀成完成。

```sh
job_off com.dzy.bulletin.mirror
touch "$DATA_DIR/READONLY"
counts | tee /tmp/dzyb-rollback-counts.txt
```

- 停鏡像用 `disable`，重開機也不會回來：之後若要「再切回」，`PRIMARY=mini` 設下去的那一刻，每小時鏡像若搶先把舊的 Mac mini 庫推上去，會蓋掉 GAS 回退期間的新資料。附錄 A 會再打開。
- **附件備份 `$DATA_DIR/files/`（M7）原地保留、不刪、不搬**：回退不需要它（附件本來就在雲端硬碟），而主管移除超過 30 天的附件只剩這一份。第 2 步的 `--all` 不碰它。回退期間每小時鏡像停著，附件不會自動補；要補可以手動跑 `node server/mirror.js --files`（只讀 Drive，`fileget`／`filelist` 不受 `PRIMARY` 限制，不會寫試算表、不違反鐵則 3）。

**驗證**
- `curl -s -X POST http://127.0.0.1:8793/ -H 'Content-Type: text/plain' --data '{"action":"ack"}'` 要回 `"code":"MOVED"`。凍結檢查在驗 token 之前，所以不帶 token 也會回 MOVED。
- `curl -s -X POST http://127.0.0.1:8793/ -H 'Content-Type: text/plain' --data '{"action":"roster"}'` 要回 `"ok":true`，代表讀取照常。
- 1 分鐘後再跑一次 `counts`，`log` 數字要與剛剛相同。這代表 a0 之後 Mac mini 操作紀錄 0 筆新增，也是驗收項目之一。

**失敗怎麼辦**
- `touch` 失敗（權限、磁碟滿）：**不要往下做**。
  - 先 `df -h "$DATA_DIR"`，排除問題後重做。
  - 真的做不到，就改走「Mac mini 死了」那條，並接受丟失。
- ack 沒回 MOVED：`READONLY` 可能建錯資料夾。
  - 看 `$DATA_DIR/logs/server.log` 最近一行「啟動…資料 …」寫的路徑。
  - 在那個路徑底下再 `touch` 一次。

## 2. 手動鏡像＋簽名回填，直到印出 pending=0

**負責人**：Mac mini 的 Claude

```sh
node server/mirror.js --all; echo "exit=$?"
node -e "const j=require(process.argv[1]+'/logs/mirror-last.json');console.log({ok:j.ok,pending:j.pending,missing:j.missing,bad:j.bad,skipped:j.skipped,running:!!j.running,busy:!!j.busy,missingIds:j.missingIds||[],badIds:j.badIds||[],skippedIds:j.skippedIds||[],error:j.error||''})" "$DATA_DIR"
```

`--all` 不設每輪上限，會重複掃描：把本機有圖、但還沒上 Drive 的簽名批次上傳（每批 ≤20 張），然後整份鏡像回試算表。

**判準**（M3 定稿語意）：**`--all` 印出 `pending=0` 而且 `exit=0`，這一輪是在 READONLY 建立之後才開始的，就算完成。** 只要 `pending≠0`，`--all` 就是 `exit=1`，不算完成。

```sh
node -e "const fs=require('fs'),d=process.argv[1];if(!fs.existsSync(d+'/READONLY')){console.log('❌ 沒有 READONLY 檔：先回第 1 步');process.exit(1)}if(!fs.existsSync(d+'/logs/mirror-last.json')){console.log('❌ 還沒有鏡像結果：先跑 --all');process.exit(1)}const j=JSON.parse(fs.readFileSync(d+'/logs/mirror-last.json','utf8')),r=fs.statSync(d+'/READONLY').mtimeMs;console.log((j.ok&&j.pending===0&&!j.running&&!j.busy&&Date.parse(j.at)>r)?'✅ 最後一次鏡像成功、在 READONLY 之後開始':'❌ 還不算完成', {ok:j.ok,pending:j.pending,running:!!j.running,busy:!!j.busy,at:j.at,readonly:new Date(r).toISOString()})" "$DATA_DIR"
```

- `at` 是那一輪**開始**的時間。這一輪在 READONLY 之後才開始，讀到的就一定包含凍結後的全部資料（READONLY 之後 Mac mini 不再有寫入）。
- `mirror-last.json` 的幾個欄位：
  - `running: true`＝`--all` 還在跑（它每一輪會更新 `at` 當心跳），等它結束再看，**不算完成**。
  - `busy: true`＝這次撞到另一輪正在跑、被跳過（手動執行時 exit 1），等 `logs/mirror.lock` 消失再跑一次。
  - `pending`＝本機有圖、驗過、還沒回填、沒被人工略過，是 mirror.js 還能處理的部分。**必須是 0**。
    - `pending≠0` 而且印出「Drive 端有 N 張傳不上去，稍後再跑」：這是 Drive 端暫時故障，等幾分鐘再跑 `--all`；多次重跑仍失敗就停下來找 MacBook 的 Claude。
  - `missing`＝已讀有 `sigId`，但本機找不到圖檔。
  - `bad`＝本機圖檔損毀（0 byte、檔頭或結尾不對）。
  - `skipped`＝寫在 `logs/sig-skip.json`、由人判斷過要略過的。
- **missing／bad 不是 0 時**（程式會列出是哪幾筆，`missingIds`／`badIds`）：
  1. **列出來**：Mac mini 的 Claude 把清單交給 Eason。這幾張在 Drive 上沒有備份，回退後在 GAS **看不到簽名圖**；已讀紀錄本身（誰、哪則、時間）照樣會鏡像過去。
     - missing 通常是 `sigs/` 裡的檔被刪或搬走。先 `ls "$DATA_DIR/sigs" | wc -l` 看看；能找回原檔放回去，就再跑一次 `--all`，不必略過。
  2. **Eason 決定是否略過**：決定接受的，才由 Mac mini 的 Claude 手動建立或編輯 `$DATA_DIR/logs/sig-skip.json`，一筆一行，格式是
     ```json
     { "P-20261001-001/S-013": "本機圖檔遺失，Eason 10/02 同意略過" }
     ```
     - 這個檔**只由人手動建立**，程式只讀不寫。
     - 格式錯（不是合法 JSON）時整份不生效，這一輪 `ok:false` 並寫原因；修好再跑。
     - 鍵對不到任何已讀（打錯字）會列在警告裡。
     - 要恢復（不略過了）就刪掉那一行。
  3. **再跑 `--all`**：略過的那幾筆改算 `skipped`，要看到 `pending=0`、`exit=0`。
  4. 回退完成後，Eason 在 LINE 告知那幾位同仁「簽名圖遺失，已讀紀錄仍在」。
- **不要手改 `logs/sig-state.json`**：那是程式自用的檔案（記「已上傳、還沒寫進庫」的 Drive id），手改或刪掉會讓圖重傳、在 Drive 留下孤兒檔。

**失敗怎麼辦**（看 `error`）
- `鏡像：BRIDGE …`（連不到 Google、逾時）：等 1～2 分鐘再跑，Apps Script 偶爾會排隊。
  - 連續 3 次失敗：先確認 `curl -sI https://script.google.com` 通不通。
  - 網路正常卻一直失敗：停在這裡回報，**不要跳到第 4 步**，否則 Mac mini 期間的資料會丟。
- 印出「已跳過」／`busy: true`：另一輪鏡像還拿著鎖。等它結束（`logs/mirror.lock` 消失）再跑。
- `mirror` 回 AUTH：代表有人已經把 GAS 的 `PRIMARY` 改成 `gas`。
  - **第 5 步已經做了**：**禁止**改回 mini（鐵則 3），改照第 6 步〈失敗怎麼辦〉處理。
  - **第 5 步還沒做**（前端仍指向 Mac mini）：照下面的順序，**先改回 mini 凍結 GAS、再確認、通過才跑 `--all`**。
    1. **Eason 先把 `PRIMARY` 改回 `mini`**：GAS 從這一刻起對寫入一律回 MOVED，Eason 接下來看到的試算表就是最終狀態，沒有「看完到改回之間又有人寫進去」的空窗。
       - 這一步本身是安全的：每小時鏡像在第 1 步已經 disable，改回 mini **不會觸發任何鏡像**；真正覆寫試算表的只有第 3 項的 `--all`，而它要等確認通過才跑。
    2. **確認 GAS 在 `PRIMARY=gas` 那段時間沒有收到新寫入**：
       - Mac mini 的 Claude 印出最後一次鏡像成功的時間：
         ```sh
         grep '鏡像完成' "$DATA_DIR/logs/mirror.log" | tail -1 | cut -d' ' -f1
         ```
         - 印出的是 **UTC** 的 ISO 時間（例如 `2026-10-02T07:00:03.120Z`），**不是台北時間**，不要自己加 8 小時。試算表裡的時間也是同一種 UTC 格式，直接比字串就好。
         - **印出空白就停**（`mirror.log` 被搬走，或從來沒有一輪鏡像成功）：沒有基準可以比，找 MacBook 的 Claude，不要跑 `--all`。
       - Eason 看主試算表：
         - 「已讀」分頁的「簽名時間」欄（E 欄，`gas/Store.js` 的 `at`）：整欄排序或篩選「大於上面那個時間」，不要只看最後幾列。
         - 「操作紀錄」分頁的「時間」欄（A 欄）：同樣篩選「大於上面那個時間」。
       - 兩邊**都沒有**任何一列晚於那個時間，才算通過。
       - 有任何一列比較晚：**不要跑 `--all`**（它會把那幾列蓋掉），維持現狀（`PRIMARY=mini`、Mac mini READONLY，全員暫時不能簽、資料不會丟），停下來找 MacBook 的 Claude。
         - 誤擋的一種情況：上一輪鏡像在 GAS 端其實已經寫進去，只是回應逾時，Mac mini 記成失敗。這時試算表裡晚於「鏡像完成」的列其實是 Mac mini 自己的資料。判讀方式：Mac mini 的 Claude 查那幾列在不在 Mac mini 的庫裡（例如 `SELECT postId,staffId,at FROM reads WHERE at > '<那個時間>'`，操作紀錄查 `log` 表同樣條件），**每一列都對得上**才是這種情況，由 MacBook 的 Claude 判斷後才可以跑 `--all`。
       - 為什麼一定要看「已讀」：同仁簽名（`ack`）、設密碼、登入**都不寫操作紀錄**（`log()` 只在主管動作呼叫）。`PRIMARY=gas` 那段時間最可能發生的，正是還開著舊頁面的同仁簽名，這只會出現在「已讀」分頁；只看操作紀錄一定漏掉。
       - **看不出來的一種改動：「同仁」分頁的原地修改**。同仁設密碼（`Service.js` 的 `setPin`）和登入失敗計數（`login`）都呼叫 `saveStaff`，是**直接改同一列**，不新增列、不寫操作紀錄，也沒有時間欄，無法可靠確認。接受這個結果：回退期間在 GAS 設過密碼或登入失敗的同仁，這些改動會被 `--all` 用 Mac mini 那一列蓋掉。
         - 影響：在 GAS 新設密碼的人，改回 Mac mini 後會被要求重新設密碼（Mac mini 那一列沒有密碼），或要用 Mac mini 上原本的密碼登入；GAS 發給他的登入憑證也會失效，要重新登入一次。登入失敗次數回到 Mac mini 的值，不影響使用。
         - 處理：Eason 在 LINE 說明「搬家這段時間如果有設過密碼，請重新設一次」；有人被鎖住或忘記密碼，主管在設定頁用「重設密碼」處理。簽名紀錄不受影響。
       - 為什麼不能靠 GAS 的防呆：b998db9 只在「送出的筆數比現有少」時才拒絕。Mac mini 還沒鏡像的筆數大於等於 GAS 新寫入的筆數時不會被拒絕，GAS 那幾筆會被直接蓋掉，之後的判準和 3-2 列數也都會照樣通過，沒有任何一步會發現。所以這道人工確認是唯一的關卡。
    3. 確認通過後才跑 `--all`。成功與否**以 Mac mini 這邊為準**：上面那段判準印出 ✅（`ok:true`、`pending=0`、`at` 晚於 READONLY 建立時間）。
    4. 如果被 GAS 拒絕（`BAD_REQ`，例如「操作紀錄筆數比現有少」）：代表第 2 項漏看了新寫入。**不可以**想辦法硬蓋過去，照下一項 BAD_REQ 處理。
    - 為什麼不用「試算表列數＝`counts`」判斷：試算表只到**上一次鏡像成功**為止，Mac mini 的 `counts` 是最新的，只要回退前有人簽名，兩邊本來就不相等（誤擋）；反過來，Mac mini 有 k 筆還沒鏡像、GAS 剛好又被寫進 k 筆時，列數會巧合相等（誤放）。
- `mirror` 被拒絕（`BAD_REQ`，例如「筆數比現有少」「少一半以上」「全空」）：GAS 的防呆擋下了這次覆寫。mirror.js 沒有可以傳下去的 `--force`，重跑也一樣。
  - **停下來回報，不進第 3 步**：把 `error` 原文、第 1 步 `counts`、試算表四個分頁的列數貼給 MacBook 的 Claude 判斷（例如試算表被人手動加了列，或 Mac mini 庫不對）。Mac mini 維持 READONLY，資料不會丟。
  - 如果討論後決定**不回退了**（前端仍指向 Mac mini、GAS 仍是 `PRIMARY=mini`），要把 Mac mini 恢復成可寫，否則全員不能簽名會一直拖下去：
    ```sh
    rm "$DATA_DIR/READONLY"
    job_on com.dzy.bulletin.mirror
    ```
    確認：`curl -s -X POST http://127.0.0.1:8793/ -H 'Content-Type: text/plain' --data '{"action":"ack"}'` 回的不再是 MOVED（沒帶 token 會回 AUTH，這是對的）；Eason 在 LINE 說明可以簽名了。

## 3. 硬關卡：確認簽名檔 id 都是 Drive id、每小時鏡像已停

**負責人**：Mac mini 的 Claude 查資料庫，Eason 看試算表。

**兩項都通過才可以進第 4 步，不准跳過。** 第 4 步之後就不能再鏡像（鐵則 3），這裡沒過就往下走，Mac mini 期間的簽名在 GAS 會永遠看不到。

**3-1　資料庫（Mac mini 的 Claude）**：還沒拿到 Drive id 的簽名，筆數必須剛好等於第 2 步最後一次 `--all` 列出的 missing＋bad＋skipped。

```sh
node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]+'/bulletin.db',{readOnly:true});const r=d.prepare(\"SELECT postId,staffId FROM reads WHERE sigId<>'' AND driveSigId=''\").all();console.log('沒有 Drive id 的簽名：'+r.length+' 筆');r.slice(0,50).forEach(x=>console.log('  '+x.postId+'/'+x.staffId))" "$DATA_DIR"
```

- 筆數＝missing＋bad＋skipped，而且清單與 `missingIds`／`badIds`／`skippedIds` 相同：通過。（正常情況 missing、bad 都已由 Eason 決定寫進 sig-skip，只剩 skipped。）
- 筆數比較多：回第 2 步。

**3-2　試算表（Eason）**：打開主試算表，確認三件事。
- 四個分頁「公告」「同仁」「已讀」「操作紀錄」的列數（扣掉表頭）＝第 1 步 `counts` 的四個數字。這裡可以比列數，是因為第 2 步的判準已確認最後一次鏡像成功、而且在 READONLY 之後（之後 Mac mini 不再有寫入），試算表應與 Mac mini 完全相同；第 2 步判準還沒 ✅ 就不要拿列數判斷（理由見第 2 步 AUTH 那一項）。
- 「已讀」分頁最後 10 列（Mac mini 期間簽的）的「簽名檔 id」欄，全部是 **Drive id**（一串英數、沒有副檔名）。
  - 不可以是 `P-…_S-….png` 這種本機檔名。
  - 只有 3-1 清單裡的那幾筆可以是空白。
- 沒有 `…__鏡像中` 或 `…__上一輪` 分頁。

**3-3　每小時鏡像確實已停（Mac mini 的 Claude）**：`launchctl print gui/$(id -u)/com.dzy.bulletin.mirror` 要回「找不到」（第 1 步已 disable＋bootout）。還在就 `job_off com.dzy.bulletin.mirror`。

**失敗怎麼辦**
- 列數對不上，或「簽名檔 id」有本機檔名：回第 2 步再跑一次 `--all`。
  - 鏡像是「先寫暫存分頁、筆數核對過才換名」，重跑是安全的。
  - 還是不對：停下來找 MacBook 的 Claude，**不要進第 4 步**。
- 看到 `__鏡像中`／`__上一輪` 分頁殘留：再跑一次 `--all`，GAS 的 `mirror` 開頭會自動執行 `mirrorHeal_`。**不要手動刪、也不要手動改名正式分頁**。

## 4. 設定 PRIMARY=gas

**負責人**：**Eason 親手操作**

Apps Script 編輯器 →「專案設定」→「指令碼屬性」：
- 把 `PRIMARY` 改成 `gas`（或直接刪掉這個屬性，未設定就等於 `gas`）。
- 確認 `EXPORT_ONCE` 不存在，有的話刪掉。

**驗證**（Mac mini 的 Claude）
- `launchctl print gui/$(id -u)/com.dzy.bulletin.mirror` 應該回「找不到」，代表每小時鏡像確實已停。
- **不要**為了驗證 `AUTH` 而再跑 `mirror.js`。第 3 步之後 Mac mini 就不再鏡像（鐵則 3 從第 5 步起禁止；第 4 步本身也不需要），這一步只看屬性。

**失敗怎麼辦**
- 屬性存不進去：重新整理 Apps Script 頁面再改。
- **改成功之前不要動前端網址**。如果 GAS 仍是 `PRIMARY=mini`，前端改回去後寫入全部回 MOVED，畫面會停在「搬家中」。

## 5. 前端改回 GAS 網址、ROSTER_CSV 視情況恢復、進位版本

**負責人**：MacBook 的 Claude（Eason 核准 push）

要改的行，與 [`CUTOVER.md`](CUTOVER.md)〈5. 前端切到 Mac mini〉相反：

| 檔案 | 行 | 改成 |
|---|---|---|
| `js/config.js` | `VERSION: '…'` | 進位（例如 `0.6.0` → `0.6.1`） |
| `js/config.js` | `GAS_URL: '…'` | 原本的 Apps Script 網址。完整網址見 CUTOVER 0-6 的記錄，或 `git log -p -S "script.google.com" -- js/config.js` |
| `js/config.js` | `ROSTER_CSV: '…'` | 切換前有值就恢復原值；切換前本來就是空白（2026-09-30 是空白）就保持空白 |
| `gas/Code.js` | `var VERSION_ = '…'` | 與 `js/config.js` 同一個號碼（`tools/build.sh` 會檢查兩邊一致） |

```sh
bash tools/build.sh                 # 同步 index.html 的 ?v= 快取版本號，並跑全部測試
git add js/config.js gas/Code.js index.html && git commit -m "回退：前端改回 Apps Script（#10）" && git push
```

**驗證**：檢查頁面實際載入的是哪一份 `config.js`，不要自己加 `?v=` 繞過快取。

```sh
V=$(curl -s https://dzy-bulletin.github.io/ | grep -o 'js/config.js?v=[0-9.]*' | head -1); echo "index.html 引用：$V"
curl -s "https://dzy-bulletin.github.io/$V" | grep -E "VERSION|GAS_URL"
```

- `index.html` 引用的 `?v=` 要是新版本號。
- 那份 `config.js` 要是新版本號＋`script.google.com`。
- Pages 通常 1～10 分鐘內生效。還沒生效就每分鐘重看一次。

**失敗怎麼辦**
- build.sh 不綠：先 `git diff`，確認只改了上表那幾行。版本號兩邊不一致會直接報「前後端版本號不一致」。
- Pages 一直沒更新：GitHub → Actions 重跑 pages build。這段期間 Mac mini 仍是 READONLY，同仁只是暫時不能簽，資料不會丟。
- 網址貼錯：重做本步，版本號再進位一次。

## 6. 驗證

**負責人**：Eason 實測，Mac mini 的 Claude 查資料

- [ ] 手機重新整理佈告欄，簽一筆，成功。這筆寫進 GAS：「已讀」多一列、「操作紀錄」多一列。
- [ ] 打開一則**舊公告**的回條（最好是 Mac mini 期間有人簽的），簽名圖看得到，含 Mac mini 期間簽的。例外（本來就看不到，不算失敗）：
  - 第 2 步 missing／bad／skipped 清單裡的那幾筆。
  - 切換時 migrate「簽名圖」列為讀不到的那幾筆（CUTOVER 第 3 步記在 #10 的清單）：它們在 Mac mini 上 `sigId` 是空白，不會出現在 missing／bad 清單，但 GAS 上一樣讀不到。
- [ ] 主管不重新登入就能開設定頁（secret 兩邊相同，舊的 atoken 仍有效）。
  - 例外：Mac mini 期間若用 `ADMIN_INIT.txt` 換過通行碼，GAS 不知道新通行碼，主管要用舊通行碼登入。
- [ ] Mac mini：`counts` 與第 1 步相同，代表 Mac mini 沒再收到任何寫入。
- [ ] Eason 在 LINE 群發回退公告，文案見 [`CUTOVER.md`](CUTOVER.md)〈1. LINE 公告〉的第三則。

**失敗怎麼辦**（鐵則 3：這時**禁止**再跑 `mirror.js`、禁止再設 `PRIMARY=mini`）

**狀況一：Mac mini 期間簽的某幾筆簽名圖看不到**（而且不在 missing／bad／skipped 清單裡）

- 目前**沒有**「只補試算表簽名檔 id 那一欄」的工具（`mirror` 只能整份覆寫）。**停下來找 MacBook 的 Claude。**
- 在那之前：Mac mini **維持 READONLY、鏡像維持 disable**，什麼都不要刪。
- Mac mini 的 Claude 先保存證據，放進 `$DATA_DIR/evidence-<時間>/`：
  1. 受影響的清單：在 GAS 回條看不到圖的 `postId/staffId`（Eason 提供截圖）。
  2. 那幾筆在 Mac mini 資料庫的列：`SELECT postId,staffId,at,sigId,driveSigId FROM reads WHERE …`，輸出存成文字檔。
  3. 對應的圖檔 `$DATA_DIR/sigs/<sigId>`，各複製一份。
  4. `logs/mirror-last.json`、`logs/mirror.log`、`logs/sig-state.json`、`logs/sig-skip.json`（有的話），各複製一份（只複製，不要改）。
  5. 資料庫快照：用 `node -e` 開唯讀連線，執行 `VACUUM INTO '<evidence 資料夾>/bulletin.db'`。
  6. 試算表那幾列「簽名檔 id」欄的截圖（Eason 提供）。
- 可能的補法由 MacBook 的 Claude 評估後再做，**本手冊不授權**：
  - 用 `sigs` 橋接的 `put`（不受 PRIMARY 限制）只上傳那幾張圖、拿到 Drive id，再由 Eason 在試算表**只改那幾格**「簽名檔 id」。
- 請同仁重簽行不通：GAS 已經有那筆已讀，會回「你已經簽過」。

**狀況二：手機寫入回 MOVED**

- 可能是 GAS 屬性沒改成功：回第 4 步。
- 也可能是手機還在用舊的 config.js：等 10 分鐘再重新整理。

---

## Mac mini 死了的回退

1. **先處理鏡像換名做到一半的情況**（**Eason** 在瀏覽器操作；`clasp run` 做不到，因為專案沒開 Execution API）。
   - 為什麼：Mac mini 若剛好死在鏡像換名那幾秒，正式分頁可能已經被改名或不見；Mac mini 死了，就不會有下一輪幫忙修。
   - 做法：
     1. 打開主試算表，看底下的分頁有沒有名稱結尾是 `__上一輪` 或 `__鏡像中` 的。都沒有就跳到第 2 步。
     2. 有的話：打開 Apps Script 編輯器（script.google.com 的「鼎兆元｜電子佈告欄」專案）。
     3. 左邊檔案清單點 `Store.gs`。
     4. 上方工具列的函式下拉選單選 `mirrorHeal`，按「執行」。
     5. 第一次執行會跳出「需要授權」視窗：選自己的帳號 →「允許」。
     6. 下方「執行紀錄」會出現一行「鏡像修復：clean」「鏡像修復：forward」或「鏡像修復：restore」，三種都是正常結果。截圖給 MacBook 的 Claude。
     7. 如果印的是「鏡像進行中，稍後再試」（結果 `busy`）：代表有一輪鏡像還拿著鎖（例如 Mac mini 死前送出的最後一輪還在 Google 那邊跑完）。等 1 分鐘再按一次「執行」，直到出現上面三種之一。
   - 執行完回試算表檢查分頁名稱：四個正式分頁「公告」「同仁」「已讀」「操作紀錄」都在，沒有 `__上一輪`。只剩 `__鏡像中` 無妨。
2. **Eason**：GAS `PRIMARY=gas`（第 4 步）。
3. **MacBook 的 Claude**：前端改回（第 5 步）。
4. 驗證：做第 6 步的前兩項。
5. **Eason** 在 LINE 公告：「〈上一次鏡像時間〉之後簽過名的同仁，請再簽一次。」
   - 上一次鏡像時間：以守門、指揮台最後一次讀到的 `mirror.at` 為準。讀不到時，才用試算表「操作紀錄」最後一列的時間代替：那一列是最後一筆被鏡像過去的操作，比實際鏡像時間**早**，拿它當分界會多請一些人重簽，但不會漏人。
   - 這些人在 GAS 上沒有已讀紀錄，所以可以重簽。
   - 另一種丟失：鏡像時簽名圖還沒回填上 Drive 的那幾筆（當時的 pending），GAS 上**有已讀、沒有圖**，同仁也不能重簽（會回「你已經簽過」）。Mac mini 修好後，這些圖還在它的 `sigs/` 裡。附錄 A 的 `--force` 會把資料庫換成 GAS 的版本，之後就沒有任何一筆資料指向那些圖。所以**做附錄 A 之前**，先由 Mac mini 的 Claude 把 `sigs/` 整個複製一份到 `$DATA_DIR/evidence-<時間>/`，再找 MacBook 的 Claude 評估怎麼補（同第 6 步狀況一）。
6. **Mac mini 修好開機後**：伺服器（`RunAtLoad`＋`KeepAlive`）和每小時鏡像會自己跑起來。Mac mini 的 Claude 要**第一時間**執行：
   ```sh
   touch "$DATA_DIR/READONLY"
   job_off com.dzy.bulletin.mirror
   job_off com.dzy.bulletin
   ```
   - 就算每小時鏡像搶先跑了一次，也會被 `PRIMARY=gas` 擋成 `AUTH`，不會覆寫。但之後要再切回時就危險了，所以一樣要 disable。
   - 之後要不要再切回，照附錄 A 做。伺服器在附錄 A 第 1 步再打開。

---

## 附錄 A：再切回 Mac mini（演練的後半段，#10 步驟 10d）

前提：回退已完成，GAS 是正本；Mac mini 有 `READONLY`，每小時鏡像已 disable（第 1 步，或死機回退的第 6 步）。

1. **Mac mini 的 Claude**：確認每小時鏡像沒在跑。
   - `launchctl print gui/$(id -u)/com.dzy.bulletin.mirror` 要回「找不到」。
   - 查到還在（例如重開機前只做了 bootout），立刻執行 `job_off com.dzy.bulletin.mirror`，確認停了才往下。
   - 伺服器若在死機回退時被 disable 了，現在執行 `job_on com.dzy.bulletin`。READONLY 還在，不會收寫入。
2. **Eason**：發 LINE 公告說明搬家時段（CUTOVER〈1. LINE 公告〉第一則），然後在 GAS 指令碼屬性設 `PRIMARY=mini`、`EXPORT_ONCE=1`。
3. **Mac mini 的 Claude**：
   ```sh
   node server/migrate.js --dry-run            # 呼叫 export（用掉 EXPORT_ONCE）並存檔，印筆數與預估時間；會提醒目標已有資料
   node server/migrate.js --from <上一步印出的檔> --force
   ```
   - `--force` 會先用 `VACUUM INTO` 把現有庫備份成 `bulletin.db.before-migrate-<時間>`，再整份換成 GAS 的資料。
   - 伺服器不用停：READONLY 期間伺服器不寫入，而且 migrate 是在原檔上做一筆交易。
   - 要六項全 ✅。`sigs/` 裡原有的圖不會被刪。
4. **Mac mini 的 Claude**：確認回退期間在 GAS 簽的那一筆（第 6 步第一項）已經在 Mac mini 上，例如 `counts` 的 reads 比第 1 步多 1。接著：
   ```sh
   rm "$DATA_DIR/READONLY"
   job_on com.dzy.bulletin.mirror    # RunAtLoad：載入即跑一輪
   ```
   跑完後 `logs/mirror-last.json` 要是 `ok:true`。
   再跑一次附件掃描（M7，#18 D6）：回退期間主管在 GAS 上傳或移除的附件，Mac mini 本機沒有，要從雲端硬碟（含垃圾桶）補回來：
   ```sh
   node server/mirror.js --files-scan; echo "exit=$?"   # 印出 count／pending；pending≠0 就再跑 node server/mirror.js --files 到 pending=0
   ```
5. **MacBook 的 Claude**：前端改回 Mac mini 網址、進位版本，做法同 [`CUTOVER.md`](CUTOVER.md)〈5. 前端切到 Mac mini〉。
6. **Eason**：手機簽一筆；打開回退期間那筆的回條，簽名圖看得到。
7. **Mac mini 的 Claude**：刪掉匯出檔 `rm <匯出檔>`（內含密碼雜湊與登入金鑰）。
   - 確認 `ls "$(dirname "$DATA_DIR")"/dzy-bulletin-export-*.json` 沒有殘留。
   - `bulletin.db.before-migrate-*` 也含密碼雜湊，觀察幾天沒問題後也要刪。

**注意**：Mac mini 期間若換過管理通行碼（`ADMIN_INIT.txt`），再切回之後會變回 GAS 上的舊通行碼，因為搬過來的是 GAS 的雜湊。要改就再放一次 `ADMIN_INIT.txt`。

**失敗處理**
- migrate 有 ❌：
  - 不要 `rm READONLY`、不要改前端。
  - 請 Eason 設回 `PRIMARY=gas`。GAS 資料完全沒動（export 是唯讀的），前端仍指向 GAS，等於什麼都沒發生。
  - 查明原因後，用同一個匯出檔加 `--from … --force` 重跑。
  - 要把 Mac mini 退回 migrate 之前的狀態，用備份檔：`node server/restore.js <bulletin.db.before-migrate-…>`。
    - restore 會檢查 lsof、拿 mirror 和 daily 兩把鎖。
    - 加 `--launchd` 時會 bootout／bootstrap 三個 job，但**不會 enable**。所以 disable 中的 job 要先 `launchctl enable`（鏡像除外，等確定再切回才開）；或不加 `--launchd`，自己手動停、起。
- export 回 AUTH：通常是 `EXPORT_ONCE` 被上一次 dry-run 用掉了。
  - 手上有那次存下的檔，就用 `--from`。
  - 沒有，就請 Eason 重設 `EXPORT_ONCE=1`。

## 驗收對照（#10 步驟 10）

- [ ] 第 1 步之後 Mac mini 操作紀錄 0 筆新增（第 1、6 步的 `counts`）。
- [ ] 第 2 步 `--all` 印出 `pending=0`、`exit=0`；missing／bad 不是 0 時，清單已由 Eason 判斷、決定略過的已寫進 `sig-skip.json`。
- [ ] 第 3 步硬關卡兩項都通過。
- [ ] 回退後在 GAS 簽的那一筆，再切回後在 Mac mini 上；兩邊的簽名圖都看得到，含 Mac mini 期間簽的。
- [ ] 本檔進 repo。
