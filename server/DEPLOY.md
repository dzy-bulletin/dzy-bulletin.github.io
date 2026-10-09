# 鼎兆元｜電子佈告欄 — Mac mini 部署手冊（M4，#9）

給 **Mac mini 上的 Claude** 從頭照做。做完＝伺服器在 Mac mini 常駐、停電重開不碰鍵盤自己恢復、**不在 tailnet 的**手機用 4G 經 Tailscale Funnel 打得到 `/health`。
本手冊**只部署、不搬資料**：前端 `js/config.js` 仍指向 Apps Script，同仁完全不受影響；資料搬遷與切換是下一張 M5（#10）。

定案（#9【定案 r2】）：**不開 FileVault＋自動登入＋LaunchAgent＋Tailscale 官方 App**。

---

## ⛔ 最前面：`.env` 禁令（違反任一條＝部署失敗，要請 Eason 換金鑰）

`server/.env` 裝著 `BRIDGE_KEY`——整套系統的萬能鑰匙（能匯出全部同仁密碼雜湊與登入金鑰）。Mac mini 的 Claude：

1. **不** `cat`／`less`／`head`／`tail`／`open`／`echo`／`Read` 這個檔，也不用任何工具「看一下內容」。
2. **不** 執行會把環境變數全印出來的指令：`env`、`printenv`、`set`、`export -p`、`launchctl getenv BRIDGE_KEY`、`ps eww`。
3. **不** 把 `.env` 的內容或片段貼進對話、issue、留言、commit、檔案。
4. **不** 自己產生、也不經手 `BRIDGE_KEY`：由 Eason 在**他自己開的「終端機」App 視窗**裡產生並貼入（不是在 Claude 的對話框裡用 `!` 執行）。
5. 要確認格式，只准用「回傳數字」的指令，例如 `grep -c '^BRIDGE_KEY=.\{32,\}$' "$HOME/dzy-bulletin/server/.env"`（回 `1` 即可）。
6. `.env` 不進 git（`.gitignore` 已列 `server/.env*`），權限 `600`。
7. 技術保險：第 3 步 A10 會請 Eason 在這台 Claude Code 的設定加上 `Read` 禁止規則。**不要**用「試讀一次看會不會被擋」來驗證規則——規則若沒生效，金鑰就進對話了。

同一原則適用 `DATA_DIR/ADMIN_INIT.txt`（管理通行碼明文）：**本手冊不建立、不讀取這個檔**。管理通行碼在 M5 搬遷時連同雜湊一起帶過來。

---

## 手冊約定

- 所有路徑都從 `$HOME` 推導，手冊裡沒有任何人的帳號名稱。
- `TS`＝Tailscale CLI：有官方 App 就用 App 裡的，沒有（附錄 A 的 Homebrew `tailscaled`）就用 `command -v tailscale` 找到的路徑。
- **A10 生效之後，Claude 連 `grep -c … .env`、`ls -l .env` 這種只回數字或權限的 Bash 指令也會被擋**。所以凡是指令裡提到 `server/.env` 的檢查（第 3 步、第 9 步、故障排除 D），一律由 Claude 把指令列給 Eason，請他在自己的「終端機」App 執行後**回報數字**；Claude 不要試著自己跑。
- `<...>` 是佔位：網址、金鑰、試算表 ID 一律不寫進本手冊、issue、commit。**Funnel 網址是部署時產生的，只在對話裡交給 Eason**（他轉給負責 M5 的人填 `js/config.js`），不寫進 #9 留言。
- **每段指令前都要先貼這段**（Claude 的每次 Bash 呼叫是新的 shell，變數不會留著）。`export PATH` 讓子程序（`bash tools/build.sh`、`restore.js` 呼叫的程式等）也用 `~/.local/node` 的 Node 24，不會撿到 PATH 上別的 node；用 shell 函式包 node 做不到這點，因為函式不會傳給子程序：

```sh
export PATH="$HOME/.local/node/bin:$PATH"; REPO="$HOME/dzy-bulletin"; DATA="$HOME/dzy-bulletin-data"; NODE="$HOME/.local/node/bin/node"; TS=$( [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ] && echo /Applications/Tailscale.app/Contents/MacOS/Tailscale || command -v tailscale ); U="gui/$(id -u)"; PORT=8793
```

- Eason 要親手做的事只有**兩批**，都集中成一張清單：**第 3 步（部署前）**、**第 8 步（現場驗證）**。Claude 做到那裡就**停下來**，把那一批整段貼給 Eason，等他說「做完了」再跑驗證。其他步驟都是 Claude 自己做，不需要 sudo。
- 背景程序一律寫成「單一指令加 `&`、下一行 `echo $! > pid 檔`」，**不要**寫成 `cd … && 指令 &`（bash 會把整串丟進子 shell，`$!` 變成子 shell 的 PID，kill 之後 node 還活著）。只關自己記下的那個 PID。
- 等伺服器起來一律用 `curl --retry … --retry-connrefused`，不用 `sleep`。
- **驗收要用的數據一律落檔，不靠對話記憶**：寫進 `$HOME/dzy-bulletin-data/logs/deploy-evidence.txt`（環境、第 5 步重起秒數、第 6 步 `/health`、第 7 步 tailnet 外驗證結果）。這個檔**不可含金鑰、網址、tailnet 名稱**；回報時從這個檔讀。
- **中途要關掉 Claude 或重開機時**（第 3 步 A10、第 8 步 V5／V6），請 Eason 回來後在**同一個資料夾**打 `claude --continue` 接回原本的對話（或進去後打 `/resume` 選它），再說「繼續照 server/DEPLOY.md 第 N 步」。接回後 Claude 先 `cat "$HOME/dzy-bulletin-data/logs/deploy-evidence.txt"` 確認做到哪裡。

---

## 第 0 步：查現況並回報（只讀、不改任何東西）

（照 Eason 那段話，repo 應該已經 clone 在 `~/dzy-bulletin`；第一次跑 git 跳出的「安裝命令列開發者工具」對話框 Eason 應已按過安裝。）

```sh
export PATH="$HOME/.local/node/bin:$PATH"; REPO="$HOME/dzy-bulletin"; DATA="$HOME/dzy-bulletin-data"; NODE="$HOME/.local/node/bin/node"; TS=$( [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ] && echo /Applications/Tailscale.app/Contents/MacOS/Tailscale || command -v tailscale ); U="gui/$(id -u)"; PORT=8793
echo "== 使用者"; whoami; echo "HOME=$HOME uid=$(id -u) shell=$SHELL"
echo "== FileVault"; fdesetup status
echo "== 自動登入"; defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser 2>/dev/null || echo "（未設定自動登入）"
echo "== 晶片"; uname -m
echo "== macOS"; sw_vers
echo "== 時區"; date; readlink /etc/localtime
echo "== 電源"; pmset -g | grep -E '^ *(autorestart|sleep|disksleep) '
echo "== 自動更新"; defaults read /Library/Preferences/com.apple.SoftwareUpdate AutomaticallyInstallMacOSUpdates 2>/dev/null || echo "（未明確設定＝依系統預設，通常是開）"
echo "== Tailscale"; ls -d /Applications/Tailscale.app 2>/dev/null && "$TS" version | head -1 || echo "（沒有官方 App）"; command -v tailscale tailscaled 2>/dev/null; (command -v brew >/dev/null && brew list --formula 2>/dev/null | grep -x tailscale) || true
echo "== Node"; command -v node && node -v; ls -l "$HOME/.local/node" 2>/dev/null; "$NODE" -v 2>/dev/null || echo "（~/.local/node 尚未安裝）"
echo "== git"; git --version 2>&1 | head -1
echo "== repo"; git -C "$REPO" log --oneline -1 2>/dev/null && git -C "$REPO" branch --show-current || echo "（尚未 clone）"
echo "== 埠 $PORT"; lsof -nP -iTCP:$PORT -sTCP:LISTEN || echo "（沒有人在聽，正常）"
echo "== 既有 job"; ls ~/Library/LaunchAgents/com.dzy.bulletin* 2>/dev/null || echo "（無）"
echo "== 既有資料"; ls -d "$DATA" 2>/dev/null || echo "（無）"
echo "== Claude 設定"; ls -l ~/.claude/settings.json 2>/dev/null || echo "（沒有 ~/.claude/settings.json）"
echo "== 磁碟"; df -h "$HOME" | tail -1
```

判讀與回報（把下表填好貼給 Eason，**然後停下來等他確認**）：

| 項目 | 期望 | 不符時 |
|---|---|---|
| FileVault | `FileVault is Off.` | 若為 On：**停**。問 Eason 要關（系統設定 → 隱私權與安全性 → FileVault → 關閉，需數小時解密）還是改走附錄 A |
| 自動登入 | 顯示部署帳號名稱 | 列入第 3 步 A4 |
| 晶片 | `arm64`（Apple Silicon）或 `x86_64`（Intel） | 第 1 步依此選 Node 檔 |
| macOS | 記下版本 | 系統設定的選單名稱依版本略有不同，照意思找 |
| 時區 | `date` 顯示 `CST`，`/etc/localtime` 指到 `Asia/Taipei` | 列入 A2 |
| 電源 | `autorestart 1`、`sleep 0`、`disksleep 0` | 列入 A1 |
| 自動更新 | `0` | 列入 A3 |
| Tailscale | 只有官方 App（`/Applications/Tailscale.app`） | 沒裝→A7；**若同時有 Homebrew `tailscale`／`tailscaled`：停**，請 Eason 決定移除（兩個版本會搶同一台機器的身分） |
| Node | `~/.local/node` 為 v24.x | 第 1 步安裝；系統裡另有 Homebrew `node` 沒關係，但本服務**不用它** |
| git／repo | 印出版本號；repo 在 `mini/m4`（或已合併後的 `main`），且 `server/DEPLOY.md` 存在 | 尚未 clone 由第 2 步處理 |
| 埠 8793 | 沒人在聽 | 查是誰（`lsof` 會列出程序），請 Eason 決定 |
| 既有 job／`$DATA` | 無 | 有的話**停**，不要覆蓋，回報給 Eason |

**前提（請 Eason 口頭確認）**：Apps Script 已部署 M2 橋接版 @27，指令碼屬性 `PRIMARY` 目前是 `gas`（或未設）。

---

## 第 1 步：Node（固定主版本 24，Claude 做，不用 sudo）

不要用 Homebrew 的 `node`（它會自己升大版；`node:sqlite` 還在演進，升大版要先在 MacBook 跑過契約測試）。用官方 tar.gz 解到 `~/.local`，再用 `~/.local/node` 這個捷徑指過去——之後 24.x 小版升級只換捷徑，launchd 設定不用改。
下載放在 `~/.local/src`（**不要**用「下載」資料夾：它受 macOS 權限保護，背景存取會跳對話框或 `Operation not permitted`）。

```sh
export PATH="$HOME/.local/node/bin:$PATH"; REPO="$HOME/dzy-bulletin"; DATA="$HOME/dzy-bulletin-data"; NODE="$HOME/.local/node/bin/node"; TS=$( [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ] && echo /Applications/Tailscale.app/Contents/MacOS/Tailscale || command -v tailscale ); U="gui/$(id -u)"; PORT=8793
case "$(uname -m)" in arm64) ARCH=arm64;; x86_64) ARCH=x64;; *) echo "未知晶片"; exit 1;; esac
NODE_DIST="<Node 官方發行站的 latest-v24.x 目錄（Node.js 官網 → 下載 → 預先編譯的二進位檔；不含結尾斜線）>"
mkdir -p "$HOME/.local/src" && cd "$HOME/.local/src" \
 && curl -fsSLO "$NODE_DIST/SHASUMS256.txt" \
 && F=$(grep -o "node-v24\.[0-9.]*-darwin-$ARCH\.tar\.gz" SHASUMS256.txt | head -1) && echo "檔名：$F" \
 && curl -fsSLO "$NODE_DIST/$F" \
 && grep " $F\$" SHASUMS256.txt | shasum -a 256 -c - \
 && tar -xzf "$F" -C "$HOME/.local" \
 && ln -sfn "$HOME/.local/${F%.tar.gz}" "$HOME/.local/node" \
 && "$NODE" -v && "$NODE" -e "require('node:sqlite'); console.log('node:sqlite OK')" \
 && command -v node                                          # 期望 …/.local/node/bin/node（共用段的 export PATH 生效）
```

- 期望最後印出 `…: OK`（SHA256 相符）、`v24.x.y`、`node:sqlite OK`。任一環失敗，後面都不會執行；刪掉 `~/.local/src` 裡的檔重來。
- `NODE_DIST` 由 Mac mini 的 Claude 自己填上官方網址（本手冊不寫網址）；**只能是 Node.js 官方網站**，不要用鏡像站。
- launchd 設定裡是絕對路徑，不靠 `PATH`；不改 shell 設定檔。手動執行時靠每段開頭的 `export PATH=…`（或直接寫 `"$HOME/.local/node/bin/node"`）。

---

## 第 2 步：程式、資料夾與 `.env` 骨架（Claude 做）

**位置固定在 `$HOME/dzy-bulletin`**，不要放在「桌面」「文件」「下載」底下——macOS 會擋背景程式讀那幾個資料夾（log 會出現 `Operation not permitted`）。

```sh
export PATH="$HOME/.local/node/bin:$PATH"; REPO="$HOME/dzy-bulletin"; DATA="$HOME/dzy-bulletin-data"; NODE="$HOME/.local/node/bin/node"; TS=$( [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ] && echo /Applications/Tailscale.app/Contents/MacOS/Tailscale || command -v tailscale ); U="gui/$(id -u)"; PORT=8793
BRANCH="mini/m4"                                            # M1～M4 已合併到 main 時改成 main（以 Eason 那段話為準）
if [ -d "$REPO/.git" ]; then git -C "$REPO" fetch -q origin && git -C "$REPO" checkout -q "$BRANCH" && git -C "$REPO" pull -q --ff-only; else git clone -q -b "$BRANCH" "<repo 網址>" "$REPO"; fi
git -C "$REPO" log --oneline -1
mkdir -p "$DATA/logs" "$DATA/files" && chmod 700 "$DATA"    # logs 一定要先建：launchd 開不了 log 檔就不會啟動；files/＝公告附件的本機備份（M7，程式也會自己建）
{ echo "== M4 部署證據（不含金鑰、網址）"; echo "環境：macOS $(sw_vers -productVersion)／$(uname -m)／Node $("$NODE" -v 2>/dev/null)／repo $(git -C "$REPO" branch --show-current) $(git -C "$REPO" rev-parse --short HEAD)／建立 $(date '+%F %T %Z')"; } >> "$DATA/logs/deploy-evidence.txt"
git -C "$REPO" check-ignore -q server/.env && echo "server/.env 已被 git 忽略" || echo "✗ .gitignore 沒有 server/.env，停下來回報"
```

建 `.env` 骨架（不含金鑰；`BRIDGE_URL` 從 `js/config.js` 取目前的 Apps Script 網址，直接寫進檔案、不印出來）：

```sh
REPO="$HOME/dzy-bulletin"; DATA="$HOME/dzy-bulletin-data"
test -e "$REPO/server/.env" && { echo "✗ .env 已存在，不要覆蓋，回報 Eason"; exit 1; }
( umask 077
  printf 'PORT=8793\nDATA_DIR=%s\n' "$DATA" > "$REPO/server/.env"
  printf 'BRIDGE_URL=%s\n' "$(sed -n "s/^ *GAS_URL: '\([^']*\)'.*/\1/p" "$REPO/js/config.js")" >> "$REPO/server/.env" )
chmod 600 "$REPO/server/.env"
grep -c '^BRIDGE_URL=https://.*/exec$' "$REPO/server/.env"   # 期望 1
```

- `ALLOW_ORIGIN` 不寫：程式預設就是正式前端網域（見 `server/index.js` 的 `config()`）；只有改網域時才加。
- **不得**有 `E2E`（那是測試模式，會打開無金鑰清空資料的入口）。`BACKUP_PASS` 已取消（#8）。
- `BRIDGE_KEY` 在第 3 步由 Eason 貼入。

---

## 第 3 步：【Eason 第一批｜部署前】一次做完

**前置條件**：第 0 步的回報 Eason 已確認；第 1 步（Node）與第 2 步（`.env` 骨架）Claude 已做完且都通過。
Claude 把下面 A1～A10 整段貼給 Eason。Eason 在 Mac mini 前面、**用他自己開的「終端機」App**（不是 Claude 對話框）做完，說「做完了」後 Claude 跑本節最後的「驗證」。
（輸入 sudo 密碼時畫面**不會出現任何字**，照打再按 Enter 就好。）

**A1　電源（sudo）**：停電恢復後自動開機、永不睡眠。
```sh
sudo pmset -a autorestart 1 sleep 0 disksleep 0
```

**A2　時區**：每日快照排在台北 03:30，時區錯了就錯班。
```sh
sudo systemsetup -settimezone Asia/Taipei
```
若這行回 `Error:-99` 或要求「完整磁碟取用權限」，**就改走圖形介面**：系統設定 → 一般 → 日期與時間 → 關掉「自動設定時區」→ 最接近的城市選「台北」；同時確認「自動設定日期與時間」是**開著**的。

**A3　關閉 macOS 自動安裝更新**：系統設定 → 一般 → 軟體更新 → 「自動更新」旁的 ⓘ → 關掉「安裝 macOS 更新」（「下載新的更新」可留著）。否則半夜自己重開、卡在更新畫面。之後由 Eason 挑時間手動更新，更新後照第 8 步 V5 再驗一次。（走附錄 A、FileVault 開著時的後果更嚴重，見附錄 A 第 8 點。）

**A4　自動登入**：系統設定 → 使用者與群組 → 「自動以此身分登入」→ 選部署帳號（會要求輸入該帳號密碼）。
⚠ 這個選項是灰的＝FileVault 開著，回第 0 步處理。

**A5　永遠不開 FileVault**：確認系統設定 → 隱私權與安全性 → FileVault 為「關閉」。以後也不要打開；真的要開，照附錄 A 改走 LaunchDaemon。

**A6　螢幕保護後立即要求密碼**（自動登入的補償措施）：系統設定 → 鎖定畫面 → 「螢幕保護程式啟動或顯示器關閉後要求密碼」→「立即」；並設定一個螢幕保護程式啟動時間（例如 5 分鐘）。Mac mini 放在有門禁的位置。

**A7　Tailscale 官方 App**：從 Tailscale 官網下載 macOS 版（Standalone 版優先，App Store 版也可以）→ 安裝 → 打開 → 允許系統延伸功能與 VPN 設定（跳出的對話框按「允許」，必要時到隱私權與安全性按「允許」）→ 用 Eason 的 Tailscale 帳號登入 → 在 App 的設定勾「登入時啟動」（Launch at login）。

**A8　Tailscale 管理後台**（`<Tailscale 管理後台>`，用 Eason 帳號）——這裡**先把 Funnel 相關的同意全部做完**，Claude 第 7 步開 Funnel 時就不會卡住等同意：
- Machines → 這台 Mac mini → ⋯ → **Disable key expiry**（個人版預設 180 天過期，到期＝整站斷線）。截圖（遮掉網址與 tailnet 名稱）留著貼 #9。
- DNS → 確認 **MagicDNS** 已啟用、**HTTPS Certificates** 已啟用（Funnel 需要）。
- Access controls（存取控制）→ 確認有允許這台機器使用 Funnel 的 `funnel` 節點屬性（後台的 Funnel 設定頁可一鍵加入；個人版預設政策通常已含）。

**A9　BRIDGE_KEY（一律產生新的一把；Eason 自產、親手貼兩處；Claude 不經手）**
現在 Apps Script 還是 `PRIMARY=gas`、橋接沒有人在用，換新金鑰沒有代價；M2 時設過的那把不確定經過哪些機器，**不要沿用**。
⚠ 實測踩過的坑（#9）：舊版分三步（先 `pbcopy`、貼到 Apps Script、再從剪貼簿寫進 `.env`），但 Eason 從 Claude 對話**複製第 3 步指令的那一刻，剪貼簿裡的金鑰就被蓋掉了**。所以改成下面「一行做完」：金鑰產生後同時寫進 `.env` 與放進剪貼簿，之後才去貼。
1. 在 **Eason 自己開的「終端機」App**（不是 Claude App 內的終端機面板、也不是 Claude 對話框）貼上這一行、按 Enter。金鑰只存在 shell 變數裡，**畫面上不會出現**；指令只印一個數字（`1`＝寫進 `.env` 成功）：
   ```sh
   K=$(openssl rand -hex 32); sed -i '' '/^BRIDGE_KEY=/d' "$HOME/dzy-bulletin/server/.env"; printf 'BRIDGE_KEY=%s\n' "$K" >> "$HOME/dzy-bulletin/server/.env"; printf '%s' "$K" | pbcopy; unset K; grep -c '^BRIDGE_KEY=[0-9a-f]\{64\}$' "$HOME/dzy-bulletin/server/.env"
   ```
2. **這之間不要再從對話複製任何東西**。直接在 Mac mini 的瀏覽器打開 Apps Script → 專案設定 → 指令碼屬性 → `BRIDGE_KEY`：有就把值**整個換掉**、沒有就新增，⌘V 貼上 → 儲存。
3. 回終端機 App 清空剪貼簿（這時從對話複製這行已經沒關係，金鑰已貼好）：
   ```sh
   pbcopy < /dev/null
   ```
4. 若有開 Spotlight 的剪貼簿紀錄或第三方剪貼簿工具，把紀錄裡那一筆刪掉。
5. 不要把金鑰貼進 Claude 的對話框、LINE、issue、任何檔案。第 1 步印的不是 `1`：整行重跑一次（會先刪掉舊的金鑰行），再重做第 2～3 步。

**A10　Claude Code 的 `.env` 禁止讀取規則**（技術保險，文字禁令之外再加一道）。在終端機 App 執行（會把規則合併進 `~/.claude/settings.json`，已有的設定不動）：
```sh
python3 - <<'EOF'
import json, os
p = os.path.expanduser('~/.claude/settings.json'); os.makedirs(os.path.dirname(p), exist_ok=True)
d = json.load(open(p)) if os.path.exists(p) else {}
deny = d.setdefault('permissions', {}).setdefault('deny', [])
for r in ["Read(~/dzy-bulletin/server/.env)", "Read(~/dzy-bulletin/server/.env*)",
          "Edit(~/dzy-bulletin/server/.env)", "Read(~/dzy-bulletin-data/ADMIN_INIT.txt)",
          "Read(~/dzy-bulletin-export-*)"]:
    if r not in deny: deny.append(r)
json.dump(d, open(p, 'w'), ensure_ascii=False, indent=2); print('OK')
EOF
```
（M5 搬遷時會用到的匯出檔 `~/dzy-bulletin-export-*.json` 也含全部密碼雜湊，一併擋。）
加進去的 JSON 長這樣（供對照）：
```json
{ "permissions": { "deny": [
  "Read(~/dzy-bulletin/server/.env)",
  "Read(~/dzy-bulletin/server/.env*)",
  "Edit(~/dzy-bulletin/server/.env)",
  "Read(~/dzy-bulletin-data/ADMIN_INIT.txt)",
  "Read(~/dzy-bulletin-export-*)"
] } }
```
做完後把 Claude 關掉（確保新規則生效），在**同一個資料夾**打 `claude --continue` 接回原本的對話，跟它說「繼續照 server/DEPLOY.md 第 3 步的驗證」。這條規則擋的是 Claude 的讀檔工具；`cat` 之類的指令仍靠上面的文字禁令。

**驗證（Claude 在 Eason 說做完之後跑；全部只印設定值或數字）：**
```sh
REPO="$HOME/dzy-bulletin"; TS=$( [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ] && echo /Applications/Tailscale.app/Contents/MacOS/Tailscale || command -v tailscale )
pmset -g | grep -E '^ *(autorestart|sleep|disksleep) '     # 期望 autorestart 1、sleep 0、disksleep 0
date; readlink /etc/localtime                               # 期望 CST、…/Asia/Taipei
defaults read /Library/Preferences/com.apple.SoftwareUpdate AutomaticallyInstallMacOSUpdates   # 期望 0（附錄 A 且 Eason 選擇保留自動更新時是 1，照實記）
defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser                          # 期望＝部署帳號（whoami）；附錄 A 不適用
fdesetup status                                             # 期望 FileVault is Off.（附錄 A 是 On）
"$TS" status | head -3                                      # 期望第一行是這台機器、不是 Logged out
git -C "$REPO" status --porcelain | wc -l                   # 期望 0（repo 沒被改、.env 被 git 忽略）
python3 -c "import json,os; d=json.load(open(os.path.expanduser('~/.claude/settings.json'))); print(sum('dzy-bulletin/server/.env' in r for r in d['permissions']['deny']))"   # 期望 ≥ 2
```

**`.env` 的檢查交給 Eason**（A10 生效後 Claude 跑不了）。Claude 把下面這段貼給 Eason，請他在自己的終端機 App 執行、**只回報印出的三個數字與權限那一欄**（指令不會印出金鑰）：
```sh
E="$HOME/dzy-bulletin/server/.env"; ls -l "$E" | cut -c1-10; grep -c '^BRIDGE_KEY=[0-9a-f]\{64\}$' "$E"; grep -c '^E2E' "$E"; git -C "$HOME/dzy-bulletin" status --porcelain | grep -c '\.env'
```
期望依序：`-rw-------`、`1`（0＝沒寫進去或帶了怪字元，重做 A9）、`0`、`0`。Claude 把 Eason 回報的數字寫進證據檔（註明「Eason 在終端機執行」）。
A6 螢幕鎖定、A8 key expiry／Funnel 同意無法用指令驗證：請 Eason 目視確認並回覆「A6、A8 已確認」。

---

## 第 4 步：前景試跑（還不交給 launchd）

用正式設定起一次，確認 Node、`.env`、資料夾都對。**只關自己起的那個 PID**。

```sh
REPO="$HOME/dzy-bulletin"; DATA="$HOME/dzy-bulletin-data"; NODE="$HOME/.local/node/bin/node"; PORT=8793
DATA_DIR="$DATA" "$NODE" "$REPO/server/index.js" > "$DATA/logs/manual-run.log" 2>&1 &
echo $! > "$DATA/logs/manual-run.pid"
curl -sf --retry 20 --retry-delay 1 --retry-connrefused "http://127.0.0.1:$PORT/health"; echo
```

（`index.js` 用自己的位置找檔案與 `.env`，不需要先 `cd`。）
期望：`"ok":true`、`"e2e":false`、`"bridge":"configured"`；`level` 此時是 `red`（還沒有鏡像與快照紀錄，第 6 步後會好）。再驗：

```sh
DATA="$HOME/dzy-bulletin-data"; PORT=8793
lsof -nP -iTCP:$PORT -sTCP:LISTEN                                                         # 期望只有一行 127.0.0.1:8793
[ "$(lsof -t -iTCP:$PORT -sTCP:LISTEN)" = "$(cat "$DATA/logs/manual-run.pid")" ] && echo "聽 8793 的就是剛起的 node" || echo "✗ PID 不符，停下來回報"
curl -s -o /dev/null -w '%{http_code}\n' -X POST "http://127.0.0.1:$PORT/__seed" -d '{}'  # 期望 404（正式模式沒有測試入口）
curl -s -X POST "http://127.0.0.1:$PORT/" -H 'Content-Type: text/plain' -d '{"action":"roster"}' | head -c 120; echo   # 期望 {"ok":true,"data":[]}（還沒搬資料，名單是空的）
```

關掉前景那一個（只關自己的 PID），並確認 8793 已釋放：

```sh
DATA="$HOME/dzy-bulletin-data"; kill "$(cat "$DATA/logs/manual-run.pid")" && rm "$DATA/logs/manual-run.pid"
lsof -nP -iTCP:8793 -sTCP:LISTEN || echo "8793 已釋放"          # 期望「8793 已釋放」；還看得到就隔幾秒再跑這一行，仍在就停下來回報
```

第一次啟動會在 `$DATA` 建 `bulletin.db`（空庫＋一把新的登入金鑰）。M5 搬遷會用 Apps Script 匯出的資料整份換掉，所以沒關係。

---

## 第 5 步：安裝三個 LaunchAgent

三個 job（全部在 `~/Library/LaunchAgents/`，不需 sudo）：

| Label | 做什麼 | 排程 |
|---|---|---|
| `com.dzy.bulletin` | 伺服器本體 | 登入即啟動、`KeepAlive`、當掉 10 秒內重起（`ThrottleInterval 10`） |
| `com.dzy.bulletin.mirror` | 鏡像回試算表＋簽名圖回填 Drive | 載入（含重開機）時馬上跑一輪（`RunAtLoad`），之後每小時（`StartInterval 3600`） |
| `com.dzy.bulletin.daily` | DB 快照上傳雲端 | 每天 03:30（台北） |

替換範本裡的 `__NODE__`／`__REPO__`／`__DATA_DIR__`，檢查後載入：

```sh
REPO="$HOME/dzy-bulletin"; DATA="$HOME/dzy-bulletin-data"; NODE="$HOME/.local/node/bin/node"; U="gui/$(id -u)"
lsof -nP -iTCP:8793 -sTCP:LISTEN && { echo "✗ 8793 還有人在聽（第 4 步沒關乾淨？），先處理再載入"; exit 1; }
mkdir -p "$HOME/Library/LaunchAgents"
for j in com.dzy.bulletin com.dzy.bulletin.mirror com.dzy.bulletin.daily; do   # 只裝這三個；選用的 com.dzy.bulletin.remind 見「未簽提醒（選用）」那一節
  sed -e "s#__NODE__#$NODE#g" -e "s#__REPO__#$REPO#g" -e "s#__DATA_DIR__#$DATA#g" "$REPO/server/launchd/$j.plist" > "$HOME/Library/LaunchAgents/$j.plist"
done
cd "$HOME/Library/LaunchAgents"
plutil -lint com.dzy.bulletin.plist com.dzy.bulletin.mirror.plist com.dzy.bulletin.daily.plist   # 三個都要 OK
grep -c '__[A-Z_]*__' com.dzy.bulletin.plist com.dzy.bulletin.mirror.plist com.dzy.bulletin.daily.plist   # 三個都要 0
grep -l '<key>BRIDGE_' com.dzy.bulletin*.plist || echo "plist 不含金鑰（正確）"   # 只比對設定鍵；範本註解裡提到 BRIDGE_KEY 字樣不算
for j in com.dzy.bulletin com.dzy.bulletin.mirror com.dzy.bulletin.daily; do launchctl bootstrap "$U" "$HOME/Library/LaunchAgents/$j.plist" && echo "載入 $j"; done
curl -sf --retry 20 --retry-delay 1 --retry-connrefused http://127.0.0.1:8793/health; echo
```

驗證：

```sh
U="gui/$(id -u)"
for j in com.dzy.bulletin com.dzy.bulletin.mirror com.dzy.bulletin.daily; do echo "== $j"; launchctl print "$U/$j" | grep -E '^\s*(state|pid|last exit code|run interval) ='; done
LP=$(launchctl print "$U/com.dzy.bulletin" | awk '$1=="pid"{print $3}'); SP=$(lsof -t -iTCP:8793 -sTCP:LISTEN)
[ -n "$LP" ] && [ "$LP" = "$SP" ] && echo "聽 8793 的就是 launchd 的 node（PID $LP）" || echo "✗ launchd PID=$LP、聽 8793 的 PID=$SP，不一致：停下來看故障排除 A"
```

期望：三個都印得出來（＝已載入）；`com.dzy.bulletin` 是 `state = running` 且有 `pid`，而且那個 PID 就是聽 8793 的程序；daily 是 `not running`（等 03:30）；mirror 在載入當下已自己跑了一輪（`RunAtLoad`），此時多半已跑完、顯示 `not running` 與 `last exit code = 1`（M4 階段被擋是預期，見第 6 步）。
如果 macOS 右上角跳出「已加入背景項目」通知，是正常的；**不要**在系統設定 → 一般 → 登入項目 裡把 `node` 關掉。

**殺掉會自己重起**（驗收項目：10 秒內）：

```sh
U="gui/$(id -u)"
P1=$(launchctl print "$U/com.dzy.bulletin" | awk '$1=="pid"{print $3}'); echo "原 PID $P1"
T0=$(date +%s); kill "$P1"
curl -sf --retry 30 --retry-delay 1 --retry-connrefused -o /dev/null http://127.0.0.1:8793/health && SEC=$(( $(date +%s) - T0 )) && echo "已恢復，約 $SEC 秒"
P2=$(launchctl print "$U/com.dzy.bulletin" | awk '$1=="pid"{print $3}'); echo "新 PID $P2"   # 要和原 PID 不同；秒數 ≤ 10
echo "第 5 步 殺掉 node 後重起：${SEC:-失敗} 秒（原 PID $P1 → 新 PID $P2）／$(date '+%F %T')" >> "$HOME/dzy-bulletin-data/logs/deploy-evidence.txt"
```

---

## 第 6 步：快照手動跑一次＋確認鏡像載入那一輪的結果

- **mirror 不用再手動跑**：第 5 步 `bootstrap` 時它已經因 `RunAtLoad` 由 launchd 跑過一輪；這裡只**確認那一輪的結果**（M4 階段它本來就該被擋，不會是 `ok:true`）。**不要**再 `kickstart` mirror——M4 階段每跑一次都被擋、失敗次數 +1，到 2 次 `/health` 就轉黃。
- daily 用 `kickstart` 走 launchd 跑（順便驗證 plist 本身能跑）。**不要和第 5 步的 `bootstrap` 寫在同一行、也不要緊接著跑**：實測（#9）併在同一行時，daily、mirror（`RunAtLoad`）與伺服器的雲端空間查詢在同一秒打 Apps Script，其中一個回「回應不是 JSON」。確認第 5 步載入**至少 10 秒**之後，再單獨執行：

```sh
U="gui/$(id -u)"
launchctl kickstart "$U/com.dzy.bulletin.daily"             # 附錄 A（system domain）要 root：改由 Eason 執行 sudo launchctl kickstart system/com.dzy.bulletin.daily
```

等一兩分鐘（Apps Script 可能要排隊）後查（這兩個結果檔與 log 不含金鑰，可以印）：

```sh
DATA="$HOME/dzy-bulletin-data"
cat "$DATA/logs/backup-last.json"; echo; tail -3 "$DATA/logs/daily.log"
cat "$DATA/logs/mirror-last.json"; echo; tail -3 "$DATA/logs/mirror.log"
curl -s http://127.0.0.1:8793/health; echo
```

判讀沒問題後（下表第一、二列），把這一刻的 `/health` 存進證據檔（`/health` 不含秘密與網址）：

```sh
DATA="$HOME/dzy-bulletin-data"
echo "第 6 步 /health（$(date '+%F %T')）：$(curl -s http://127.0.0.1:8793/health)" >> "$DATA/logs/deploy-evidence.txt"
```

判讀——**M4 階段 Apps Script 還是 `PRIMARY=gas`，所以兩個結果不一樣是對的**。下表的字串是 `*-last.json` 的 `error` 欄位實際會出現的原文：

| 看到什麼 | 意思 | 怎麼做 |
|---|---|---|
| `backup-last.json`：`"ok":true`、`"sharedWith":0`；`daily.log` 有「備份完成」 | 橋接網址與金鑰都對，快照已上傳到雲端「鼎兆元｜電子佈告欄備份」資料夾 | 正常（第 8 步 V1 請 Eason 看一眼雲端硬碟）。這個資料夾**不要分享給任何人**（備份含密碼雜湊與登入金鑰）；有共用者時 `sharedWith` 大於 0、`/health` 亮黃燈 |
| `mirror-last.json`：`"ok":false`、`"notMigrated":true`，`"error":"資料庫是空的（尚未搬遷），拒絕鏡像以免蓋掉試算表"` | **目前版本（M5 之後）的正確結果**：Mac mini 還是空庫，mirror.js 在本機就拒絕、不打 Apps Script；結果檔每輪照樣更新 `at`，`/health` 最多黃「尚未搬遷」、不會轉紅 | 正常。真正的 `ok:true` 在 M5 設 `PRIMARY=mini`、搬完資料之後 |
| `mirror-last.json`：`"ok":false`，`"error":"鏡像：BRIDGE mirror: AUTH 目前不接受這個橋接動作"` | 舊版（M4 定稿）的正確結果：金鑰正確、橋接打得通，Apps Script 在 `PRIMARY=gas` 時擋下鏡像 | 正常 |
| `"error"` 以 **`鏡像：BAD_REQ`** 開頭的任何一種——例如 `鏡像：BAD_REQ 鏡像資料全空，拒絕覆寫`、`鏡像：BAD_REQ 鏡像的公告筆數（0）比現有（N）少一半以上，拒絕覆寫（確認無誤請帶 force）`、`鏡像：BAD_REQ 鏡像資料缺 …` | **危險訊號**：Apps Script 只有在 `PRIMARY=mini` 時才會檢查鏡像內容，所以 M4 階段看到任何 `BAD_REQ` 都代表現在是 `PRIMARY=mini`——正式站的寫入正在回 MOVED，**同仁此刻簽不了名**（Apps Script 的防呆擋下了空庫，試算表沒被清空） | **立刻停下所有步驟**，告訴 Eason：「請馬上到 Apps Script 指令碼屬性把 `PRIMARY` 改回 `gas`」。改完後 `launchctl kickstart gui/$(id -u)/com.dzy.bulletin.mirror` 跑一次確認，應變回上一列。救回後失敗次數會累計到 2、`/health` 轉 `yellow`（鏡像連續失敗）——**不要為了拿綠燈一直重跑**；證據檔照實寫「yellow（PRIMARY 誤設已救回）」，回報第 6 步那一項也照填 |
| `"error":"鏡像：BRIDGE mirror: AUTH 橋接金鑰錯誤"`（daily 則是 `BRIDGE backup: AUTH 橋接金鑰錯誤`） | 兩邊金鑰不一致 | 故障排除 D |
| 其他（`BRIDGE_TIMEOUT`、`回應不是 JSON`、`未設定 Google 橋接`…） | 見故障排除 D | — |
| `mirror-last.json` 的 `missing`／`bad` 大於 0 | 本機缺簽名圖／本機圖檔損毀（M4 空庫不會出現；M5 之後才可能） | `/health` 會黃；清單在 `missingIds`／`badIds` 與 `mirror.log`。回報 Eason，不要自己刪資料；確認放棄的那幾張才由人寫進 `sig-skip.json`（故障排除 E） |
| `skipped` 大於 0（有 `skippedIds`） | 這幾張寫在人工略過清單 `logs/sig-skip.json`，人已判斷過 | 正常，不轉黃；回報時列出筆數 |
| `"busy":true` | 另一輪鏡像（或還原）正拿著工作鎖，這次沒跑 | 等它結束再看；手動 `--all` 撞到時會印「已跳過」並以 1 結束 |
| `"running":true` | `--all` 還在跑（每輪更新 `at` 當心跳），這是跑到一半的狀態 | 等它結束，看最後的 `pending` 與結束碼 |
| `error` 含 `logs/sig-skip.json 格式錯誤` | 人工略過清單寫錯，**整份不生效**（這一輪照常上傳、不略過任何一張）、`ok:false` | 照故障排除 E 的格式改正 |
| `error` 含 `logs/sig-state.json 損毀，已改名保留為 …` | 程式自用的狀態檔壞了，已改名保留、這一輪不上傳 | 回報 Eason／MacBook Claude 核對，不要手改 |

此時 `/health` 應為 `"level":"green"`（鏡像失敗次數 1，未達黃燈門檻 2）——已用上面那段存進證據檔，回報時從證據檔貼。

**附件備份（M7，#18）：部署當天必跑一次 `--files-scan`**。雲端硬碟垃圾桶 30 天後自動永久刪除，主管已移除的附件只有這 30 天能救回；`--files-scan` 會列出附件資料夾（含垃圾桶）並把位元組拉到 `$DATA/files/`。它只讀 Drive（`fileget`／`filelist` 不受 `PRIMARY` 限制），M4 階段也能跑：

```sh
export PATH="$HOME/.local/node/bin:$PATH"; REPO="$HOME/dzy-bulletin"; DATA="$HOME/dzy-bulletin-data"
node "$REPO/server/mirror.js" --files-scan; echo "exit=$?"     # 印出「附件補齊完成｜count=N｜bytes=…｜pending=0｜…」且 exit=0 才算完成
echo "第 6 步 附件備份（$(date '+%F %T')）：$(node "$REPO/server/mirror.js" --files-verify | tail -1)" >> "$DATA/logs/deploy-evidence.txt"
```

- 附件多時會跑很久（幾百個、上 GB 可能超過一小時），這是正常的。它分批做、每批做完就放掉鏡像鎖，每小時那輪照樣插得進來；但兩者輪流時鏡像會慢一些，`/health` 短暫出現「鏡像超過 3 小時沒跑」黃燈屬預期。
- `pending` 不是 0（exit=1）：多半是量大或 Apps Script 排隊，隔幾分鐘再跑 `node "$REPO/server/mirror.js" --files`（不設上限、補到 `pending=0` 才 exit 0）。一直補不到的那幾個會列在「沒補到」後面，見故障排除 F。
- 還沒鏡像過（`mirror-last.json` 不存在）時結果只印在畫面、不寫檔；之後每小時那輪（搬資料之後）會接手。
- **附件資料夾「鼎兆元｜電子佈告欄附件」不要手動放任何檔**：Mac mini 只備份附件資料夾直屬的 Word／PDF／Excel，手動放的檔可能被當成附件備份下來（照片、Google 文件不會）。
**已知且預期**：之後每小時（以及每次重開機載入時）的鏡像都會被擋，`/health` 為 `yellow`（`why` 為「尚未搬遷」；舊版是「鏡像連續失敗」），直到 M5 切換。M5 之前守門還沒接上，不會告警。

---

## 第 7 步：Tailscale Funnel（443 → 127.0.0.1:8793）

```sh
TS=$( [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ] && echo /Applications/Tailscale.app/Contents/MacOS/Tailscale || command -v tailscale )
"$TS" status | head -3
"$TS" funnel status                                          # 期望：目前沒有任何設定（No serve config）
"$TS" funnel --bg 8793; echo "結束碼 $?"
```

- 如果 Funnel 或 HTTPS 還沒在後台同意，最後一行會**印出一個同意連結，然後一直等**：把連結交給 Eason，請他到 Tailscale 後台同意；**指令會一直等到同意完成才自己結束（結束碼 0），這是正常行為**，不要中止它（舊版用 `perl alarm` 包逾時，實測對 tailscale CLI 無效，已刪掉）。HTTPS 憑證與 `funnel` 屬性可以在這個同意連結一次開好。
- 附錄 A 的 Homebrew `tailscaled` 以 root 執行：A7 已做 `tailscale up --operator=<部署帳號>` 的話這一步不用 sudo；回「Access denied」之類的權限錯誤＝operator 沒設，請 Eason 補做附錄 A 第 6 點。
- 其他非 0 結束碼（例如 HTTPS 憑證沒開、存取控制沒有 `funnel` 屬性時 CLI 會直接報錯退出）：**停**，把輸出原文交給 Eason（先遮掉網址與 tailnet 名稱），照 A8 補做後再跑一次。
- 成功後：

```sh
TS=$( [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ] && echo /Applications/Tailscale.app/Contents/MacOS/Tailscale || command -v tailscale )
"$TS" funnel status
```

期望**只有一條**對外設定：找以 `https://` 開頭、後面有 `(Funnel on)` 的那一行（上面可能有一行 `# Funnel on:` 之類的註解），底下是 `|-- / proxy http://127.0.0.1:8793`。有別的條目（其他埠、其他路徑）就 `"$TS" funnel reset` 後重做。

記下 Funnel 網址（上面那行的 `https://…ts.net`）。**一律用 `https://`**：打 `http://` 會被 302 轉址到 https，前端 `js/config.js` 與守門要填 https 的網址。**只在對話裡交給 Eason**，不寫進任何檔案、commit、#9 留言。

**從 tailnet 外面驗證**（Claude 自己做得到）：這台機器本身在 tailnet 裡，直接打 Funnel 網址可能走 tailnet 內部、不經 Funnel。改成向公開 DNS（`1.1.1.1`）查這個名稱、再強迫 curl 連那個公開 IP——這條路一定經過 Tailscale 的公開 Funnel 入口：

```sh
H="<Funnel 主機名，也就是網址 https:// 後面、結尾 .ts.net 為止>"
IP=$(dig +short "$H" @1.1.1.1 | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -1)
case "$IP" in
  "")    echo "✗ 公開 DNS 還沒生效（查不到 IPv4）";;
  100.*) echo "✗ 拿到 tailnet 內部位址 $IP，不是公開入口";;
  *)     echo "公開 IP：$IP"; curl -s --max-time 20 --resolve "$H:443:$IP" "https://$H/health"; echo;;   # 期望 {"ok":true,…}
esac
```

- 第一次開 Funnel 時，公開 DNS 最多可能要**約 10 分鐘**才查得到、首張 HTTPS 憑證也要幾十秒。`IP` 是空的或 TLS 錯誤就隔幾分鐘再跑，**10 分鐘內都不算失敗**。
- **退路**：這條路是 Mac mini 自己連到公開入口、再經 tailnet 繞回自己（hairpin），實機上不一定通。如果 **10 分鐘後仍不通**，但 `funnel status` 正確、本機 `/health` 通，就**不要**叫 Eason 重做後台設定：記一筆「繞回驗證不適用」，照樣進第 8 步，由 V3（手機關掉 Tailscale、用 4G）做最後判斷——**V3 通就算通過**；V3 也不通才照故障排除 B 查。
- 結果寫進證據檔（二選一）：

```sh
echo "第 7 步 tailnet 外驗證：通過（$(date '+%F %T')）" >> "$HOME/dzy-bulletin-data/logs/deploy-evidence.txt"
echo "第 7 步 tailnet 外驗證：繞回驗證不適用（10 分鐘後仍不通；funnel status 正確、本機通），交給 V3 判斷（$(date '+%F %T')）" >> "$HOME/dzy-bulletin-data/logs/deploy-evidence.txt"
```

手機驗證併入第 8 步那一批。

---

## 第 8 步：【Eason 第二批｜現場驗證】一次做完

**前置條件**：第 4～7 步都通過（第 7 步「從 tailnet 外面驗證」已回 `{"ok":true…}`，或已記「繞回驗證不適用」交給 V3 判斷）。

交給 Eason 之前，Claude 先把 V2 要看的本機網頁打開（模擬「後端打不通」；正式前端要到 M5 才指向 Funnel，而且 `?api=` 只在 localhost 生效）：

```sh
REPO="$HOME/dzy-bulletin"
python3 -m http.server 8792 --bind 127.0.0.1 -d "$REPO" > /dev/null 2>&1 &
echo $! > /tmp/dzyb-static.pid
curl -s --retry 10 --retry-delay 1 --retry-connrefused -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8792/   # 期望 200
open "http://localhost:8792/?mode=cloud&api=http://127.0.0.1:9"
```

（`127.0.0.1:9` 故意是沒有人在聽的埠。）然後 Claude 告訴 Eason：「V5、V6 會重開機，對話會中斷；全部做完後請在同一個資料夾打 `claude --continue` 接回這個對話，說『繼續照 server/DEPLOY.md 第 8 步的驗證』，並告訴我 V1～V7 各自通過沒有」，再把下表整段貼給他。

**手機的準備（所有手機驗證都要）**：手機**關掉 Wi-Fi、用 4G**，而且**打開 Tailscale App 按中斷連線（或整個登出）**——手機若連在 tailnet 裡，`*.ts.net` 會走 tailnet 內部，Funnel 沒開也打得通，驗收就不準。也可以改用一支從沒裝過 Tailscale 的手機。

| # | Eason 做什麼 | 通過的樣子 |
|---|---|---|
| V1 | 打開 Google 雲端硬碟的「鼎兆元｜電子佈告欄備份」資料夾 | 有一個今天的 `bulletin-….db.gz`；資料夾「共用」裡**只有你自己** |
| V2 | 看 Mac mini 螢幕上剛打開的瀏覽器分頁 | 頁首「鼎兆元｜電子佈告欄」，中間「請選擇你是誰」視窗裡有紅字「連不上伺服器，請確認網路」和「重試」按鈕——**不是一片白** |
| V3 | 手機（已中斷 Tailscale、4G）打 `<Funnel 網址>/health` | 看到 `{"ok":true,…}` |
| V4 | Mac mini 選單列的 Tailscale 圖示 → **Disconnect**；手機再打一次 → 再按 **Connect**；手機再打一次。（附錄 A 的 Homebrew 版沒有選單列圖示：在終端機 App 執行 `tailscale down`，手機打一次，再 `tailscale up`，手機再打一次） | 中斷時手機**打不開**（逾時或無法連線）；連回後又看到 `{"ok":true,…}`（可能要等幾十秒） |
| V5 | 蘋果選單 → 重新啟動（取消勾選「再次登入時重新打開視窗」）→ **放手，不碰鍵盤滑鼠** → 等 3 分鐘 → 手機打 `/health`。**附錄 A（FileVault 開著）**：重開後會停在 FileVault 解鎖畫面，輸入部署帳號的密碼解鎖，**解鎖後不必做任何事，等 3 分鐘**，手機打 `/health` | 3 分鐘內看到 `{"ok":true,…}` |
| V6 | 直接拔掉 Mac mini 電源線，等 10 秒再插回（模擬停電）→ 不碰鍵盤滑鼠 → 3 分鐘後手機打 `/health`。附錄 A：同 V5，解鎖後不必做任何事、等 3 分鐘 | 同上 |
| V7 | 目視：系統設定 → 鎖定畫面，「要求密碼」為「立即」 | 是 |

**V3～V6 任一步 3 分鐘後打不到，照這個順序查**（Eason 可以直接看螢幕；能進桌面的話在同一個資料夾打 `claude --continue`，說「照 server/DEPLOY.md 第 8 步的診斷表查」，由 Claude 跑右欄指令）：

| 順序 | 看什麼 | 判讀 |
|---|---|---|
| 1 | 拔電後 Mac mini 有沒有自己開機（電源燈、螢幕）；Claude：`pmset -g \| grep autorestart` | 沒開機或不是 `1` → A1 沒生效，重做 A1 |
| 2 | 螢幕停在哪裡 | **登入畫面** → A4 自動登入沒生效，或 FileVault 被打開了（`fdesetup status`）；**更新畫面／設定助理** → A3，等它跑完再重測 |
| 3 | 已進桌面：Claude 跑 `launchctl print gui/$(id -u)/com.dzy.bulletin \| grep -E 'state\|pid\|last exit'` 與 `curl -s http://127.0.0.1:8793/health` | 沒載入或本機 `/health` 不通 → 故障排除 A |
| 4 | 本機通：選單列 Tailscale 圖示是不是已連線；Claude：`"$TS" status \| head -3` | 未連線／Logged out → A7 的「登入時啟動」沒勾，或要重新登入；故障排除 B |
| 5 | Tailscale 已連線：Claude：`"$TS" funnel status` | 設定不見了 → 重做第 7 步（`--bg` 的設定照理重開後還在，這一步正好在實機證明）；還在 → 用第 7 步「從 tailnet 外面驗證」判斷是 Funnel 還是手機那端的問題 |

Eason 做完、用 `claude --continue` 接回後，Claude 先把 Eason 說的 V1～V7 結果寫進證據檔（例如 `echo "第 8 步 V1～V7：V1 通過、V2 通過…（Eason 口述，$(date "+%F %T")）" >> "$HOME/dzy-bulletin-data/logs/deploy-evidence.txt"`），再跑：

```sh
U="gui/$(id -u)"; DATA="$HOME/dzy-bulletin-data"; TS=$( [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ] && echo /Applications/Tailscale.app/Contents/MacOS/Tailscale || command -v tailscale )   # 附錄 A：U 換成 system
uptime                                                      # 開機時間應是剛剛
fdesetup status                                             # FileVault is Off.
for j in com.dzy.bulletin com.dzy.bulletin.mirror com.dzy.bulletin.daily; do launchctl print "$U/$j" >/dev/null 2>&1 && echo "$j 已載入" || echo "✗ $j 沒載入"; done
"$TS" funnel status
curl -s http://127.0.0.1:8793/health; echo
tail -3 "$DATA/logs/server.log"                             # 應看到重開後的一行「佈告欄伺服器 … 啟動」
lsof -nP -iTCP:8792 -sTCP:LISTEN || echo "V2 的本機網頁伺服器已隨重開機結束"
```

V2 的本機網頁伺服器會隨重開機結束；若 Eason 沒做 V5／V6 就回來，Claude 自己關掉它（只關自己的 PID）：`kill "$(cat /tmp/dzyb-static.pid)" && rm /tmp/dzyb-static.pid`。

---

## 第 9 步：收尾檢查

Claude 跑（不碰 `.env`）：

```sh
REPO="$HOME/dzy-bulletin"
git -C "$REPO" grep -l "guo""eason" -- server/ | wc -l     # 期望 0（手冊與程式不寫死任何人的帳號；用 git grep 只搜進版控的檔、不會碰到 .env；字串拆兩半免得這行自己被搜到）
git -C "$REPO" status --porcelain                           # 期望空白（.env 不在裡面、也沒有改到 repo）
```

**`.env` 權限與 #10 金鑰外洩檢查交給 Eason**（A10 生效後 Claude 跑不了）。Claude 把下面這段貼給 Eason，請他在自己的終端機 App 執行、**只回報印出的權限欄與數字**（指令只拿金鑰前 8 碼去比對 Claude 的對話紀錄與伺服器 log，不印金鑰）：

```sh
REPO="$HOME/dzy-bulletin"; DATA="$HOME/dzy-bulletin-data"; E="$REPO/server/.env"
ls -l "$E" | cut -c1-10                                     # 期望 -rw-------
if [ "$(grep -c '^BRIDGE_KEY=[0-9a-f]\{64\}$' "$E")" = 1 ]; then   # 沒有剛好一行金鑰就不比對（否則搜尋字串是空的，每個檔都會算命中）
  grep -rl "$(sed -n 's/^BRIDGE_KEY=//p' "$E" | tr -d "\"'" | cut -c1-8)" ~/.claude/projects/ "$DATA/logs" 2>/dev/null | wc -l   # 期望 0
else echo "✗ .env 的金鑰行不是剛好一行，先回第 3 步 A9"; fi
```

- 回 `0` → 沒有外洩，回報「0 命中（Eason 在終端機執行）」。
- 回非 0 → 8 碼在很大的對話紀錄裡有機會碰巧撞到，請 Eason 再用 12 碼複查一次（同樣只回數字）：

```sh
E="$HOME/dzy-bulletin/server/.env"; DATA="$HOME/dzy-bulletin-data"
[ "$(grep -c '^BRIDGE_KEY=[0-9a-f]\{64\}$' "$E")" = 1 ] && grep -rl "$(sed -n 's/^BRIDGE_KEY=//p' "$E" | tr -d "\"'" | cut -c1-12)" ~/.claude/projects/ "$DATA/logs" 2>/dev/null | wc -l
```

  仍非 0 → **不要**打開命中的檔案看，由 Eason 重做 A9（Apps Script 屬性＋`.env` 兩處），再重起伺服器（主線：Claude 執行 `launchctl kickstart -k gui/$(id -u)/com.dzy.bulletin`；附錄 A：照附錄 A 第 9 點「沒有 sudo 時的重啟」），再跑一次檢查。12 碼為 0 → 視為碰巧，回報「8 碼 N 命中、12 碼 0 命中」。

---

## 驗收清單與回報格式

在 #9 留言：把下面整段存成暫存檔、逐項打勾填好，用 `gh issue comment 9 -R dzy-bulletin/dzy-bulletin.github.io --body-file <暫存檔>` 送出（這台的 `gh` 沒登入就把整段交給 Eason 貼）。**不貼任何網址、金鑰、tailnet 名稱**；`/health` 回應可以整段貼（它不含網址與秘密）。

```markdown
## M4 部署回報（Mac mini）

環境：<證據檔的「環境」那一行>／Tailscale <版本>（官方 App）

（以下數據一律從 `$HOME/dzy-bulletin-data/logs/deploy-evidence.txt` 讀，不憑對話記憶；可把整個證據檔貼在最後的 details 裡。）

- [ ] 照 DEPLOY.md 完成，過程沒有回 MacBook 問（卡住的地方：<無／列出>）
- [ ] 第 9 步的帳號名稱 grep 為 0；`.env` 權限 `-rw-------`、`git status` 看不到；Claude 設定有 `.env` 的 Read 禁止規則
- [ ] `lsof -nP -iTCP:8793 -sTCP:LISTEN` 只有 `127.0.0.1:8793`，且 PID＝launchd 的 pid
- [ ] 正式模式 `POST /__seed` 回 404
- [ ] `tailscale funnel status` 只有一條 443 → `http://127.0.0.1:8793`；tailnet 外驗證：<通過／繞回驗證不適用，由 V3 判定>（見證據檔）
- [ ] Tailscale 後台 key expiry 已停用（截圖已遮網址，附在下面）
- [ ] 重開機不碰鍵盤，3 分鐘內手機（已中斷 Tailscale、4G）打 `/health` 200
- [ ] 拔電 10 秒再插，不碰鍵盤，3 分鐘內手機（同上）打 `/health` 200
- [ ] `fdesetup status` 為 Off；自動登入＝部署帳號；螢幕保護後立即要求密碼（Eason 目視）
- [ ] `date` 顯示 CST（台北）；`pmset` autorestart 1／sleep 0／disksleep 0；自動安裝 macOS 更新＝0
- [ ] 第 6 步當時的狀態（見證據檔）：`e2e` false、`bridge` configured、`level` green（若第 6 步救回過 PRIMARY 誤設則照實填 yellow）。之後每小時／每次重開機的鏡像都被擋，現在轉 yellow「鏡像連續失敗」是 M5 前的預期狀態
- [ ] `launchctl print` 三個 job 都已載入；殺掉 node 後 <證據檔第 5 步的秒數> 秒內（≤ 10）自動重起（PID 已換）
- [ ] daily 手動跑一次 `ok:true`、`sharedWith` 為 0（雲端備份資料夾有新檔、沒有分享給任何人）；mirror 載入時自動跑的那一輪為預期的 `鏡像：BRIDGE mirror: AUTH 目前不接受這個橋接動作`
- [ ] Tailscale 中斷時手機打不到、連回後打得到；本機模擬後端打不通時前端顯示錯誤文字、不白屏
- [ ] #10 金鑰 grep 檢查：0 命中

<details><summary>證據檔與目前的 /health</summary>

（貼 `cat "$HOME/dzy-bulletin-data/logs/deploy-evidence.txt"`，以及現在 `curl -s http://127.0.0.1:8793/health` 的輸出）
</details>
```

Funnel 網址：**在對話裡**交給 Eason，不寫在上面。

---

## 交接給 M5（重要，負責切換的人必讀）

Mac mini 上的位置（M5 的指令照這裡寫；這台的 shell 設定檔沒把 Node 放進 `PATH`，所以**每段指令前都要先貼**下面那段的 `export PATH=…` 並用 `command -v node` 確認指到 `~/.local/node/bin`——不要用 shell 函式包 node，函式不會傳給子程序）：

| 東西 | 位置 |
|---|---|
| Node | `$HOME/.local/node/bin/node`（捷徑，指向 `~/.local/node-v24.x.y-darwin-<晶片>`） |
| repo | `$HOME/dzy-bulletin` |
| 資料夾（DATA_DIR） | `$HOME/dzy-bulletin-data`（`bulletin.db`、`sigs/`、`files/`（M7 附件備份，永久保留、不要刪）、`backups/`、`logs/`；回退用的 `READONLY` 檔也放這裡） |
| 設定 | `$HOME/dzy-bulletin/server/.env`（程式自己讀，不用 `source`、不用 export） |
| launchd | `~/Library/LaunchAgents/com.dzy.bulletin{,.mirror,.daily}.plist`，domain `gui/$(id -u)` |

1. **設 `PRIMARY=mini` 之前，先停掉鏡像 job**。原因：一旦 `PRIMARY=mini`，Apps Script 就接受鏡像；每小時的鏡像若剛好在「設了 `PRIMARY=mini`」到「`migrate.js` 完成」之間跑，會嘗試把 Mac mini 的空庫寫進正式試算表（全空的會被 Apps Script 擋下，但只有一兩筆測試資料時擋不住）。完整順序（`migrate.js` 在 M5 的 PR 才進 repo）：

```sh
export PATH="$HOME/.local/node/bin:$PATH"; REPO="$HOME/dzy-bulletin"; DATA="$HOME/dzy-bulletin-data"; U="gui/$(id -u)"   # 每段指令前都要先貼這段
command -v node                                             # 必須是 …/.local/node/bin/node，否則停下來
launchctl disable "$U/com.dzy.bulletin.mirror"; launchctl bootout "$U/com.dzy.bulletin.mirror"   # ① 先停鏡像（disable 撐得過重開機，bootout 才真的停），再請 Eason 設 PRIMARY=mini、EXPORT_ONCE=1
node "$REPO/server/migrate.js" --dry-run                    # ② 呼叫 export（一次性）並立刻存成本機匯出檔，印筆數與簽名圖預估時間；最後一行是匯出檔路徑
node "$REPO/server/migrate.js" --from "<②印出的匯出檔>"      # ③ 正式搬遷：export 已在 ② 用掉（再呼叫會回 AUTH），一律 --from；六項全 ✅ 才往下
launchctl enable "$U/com.dzy.bulletin.mirror"; launchctl bootstrap "$U" "$HOME/Library/LaunchAgents/com.dzy.bulletin.mirror.plist"   # ④ 解除停用並載回鏡像（RunAtLoad：載入即跑一輪）
cat "$DATA/logs/mirror-last.json"; echo                     # ⑤ 等一兩分鐘後看，應為 "ok":true、pending／missing／bad 為 0
```

   **匯出檔**（②存下的 JSON，權限 600）含全部同仁密碼雜湊、登入簽章金鑰與管理通行碼雜湊，比照 `.env` 禁令：Claude 不打開、不印出、不貼進對話；搬遷確認無誤後由 Eason 決定刪除。完整切換步驟與失敗處理以 M5 的 `server/CUTOVER.md` 為準，回退以 `server/ROLLBACK.md` 為準。
   回退時的手動鏡像，順序不可調換（#10）：① `launchctl disable "$U/com.dzy.bulletin.mirror"; launchctl bootout "$U/com.dzy.bulletin.mirror"`（否則 launchd 那一輪拿著工作鎖時，`--all` 會直接跳過並印 `pending=null`，容易誤讀）→ ② `touch "$DATA/READONLY"` → ③ `node "$REPO/server/mirror.js" --all`，完成條件是印出 `pending=0` 且結束碼 0（`echo $?`）；只要 `pending≠0`（或撞到另一輪「已跳過」）就以 1 結束，照印出的原因處理後重跑 → ④ **這之後**才請 Eason 把 `PRIMARY` 改回 `gas`（Apps Script 只在 `PRIMARY=mini` 時接受鏡像，先改就鏡像不上去了）。
2. Funnel 網址由 Eason 交給負責改 `js/config.js` 的人。
3. 管理通行碼：搬遷後沿用 Apps Script 的雜湊，不需要 `ADMIN_INIT.txt`。

---

## 故障排除

以下指令的變數沿用「手冊約定」那一行。

**A. launchd 起不來（`launchctl print` 沒有 pid、`/health` 打不通）**
- 看 log（不含金鑰）：`tail -30 "$HOME/dzy-bulletin-data/logs/server.err.log"`、`launchctl print gui/$(id -u)/com.dzy.bulletin | grep -E 'last exit code|state'`。
- `bootstrap` 回 `Bootstrap failed: 5: Input/output error`：通常是已經載入過了。先 `launchctl bootout gui/$(id -u)/<label>` 再 bootstrap。
- `last exit code = 78` 或完全沒有 log 檔：`$DATA/logs` 不存在或路徑錯 → `mkdir -p "$HOME/dzy-bulletin-data/logs"`，再檢查 plist 裡的路徑（`plutil -p ~/Library/LaunchAgents/com.dzy.bulletin.plist`）。
- log 出現 `Operation not permitted`：repo 或資料夾放在桌面／文件／下載底下 → 搬到 `$HOME` 底下，重做第 5 步的替換。
- log 反覆出現 `EADDRINUSE`、或第 5 步「PID 不一致」：8793 被別的程序占住（常見是第 4 步前景試跑沒關乾淨），`/health` 其實是那個程序在回。`lsof -nP -iTCP:8793 -sTCP:LISTEN` 看是誰；**是自己第 4 步起的**（`manual-run.pid` 或它的子程序）才 kill，不是就停下來回報 Eason。
- 系統設定 → 一般 → 登入項目（背景項目）裡 `node` 被關掉 → 打開，再 `launchctl kickstart -k gui/$(id -u)/com.dzy.bulletin`。
- 改了 plist：`launchctl bootout` 再 `bootstrap`（`kickstart` 不會重讀 plist）。改了 `.env`：`launchctl kickstart -k gui/$(id -u)/com.dzy.bulletin`（伺服器只在啟動時讀 `.env`）。

**B. Funnel 打不通**
- `"$TS" status` 顯示 Logged out 或 Stopped → 打開 Tailscale App 重新連線（需要時請 Eason 登入）。
- `"$TS" up` 失敗（例如要求補齊一堆旗標）→ 不要硬湊旗標，改從選單列 Tailscale 圖示按「Connect」。
- `"$TS" funnel status` 沒有設定 → 重做第 7 步；有多條 → `"$TS" funnel reset` 後重做。
- 本機 `curl http://127.0.0.1:8793/health` 就不通 → 是伺服器問題，看 A。
- 剛開 Funnel 時 TLS 錯誤或公開 DNS 查不到 → 憑證與 DNS 還在生效，等 10 分鐘內再試。
- 第 7 步「從 tailnet 外面驗證」通、手機不通 → 手機那端的問題（手機 Tailscale 沒中斷、4G 訊號、瀏覽器快取）。
- 分辨「A8 沒做」和「只是繞回不通」：
  - **A8 沒做**的樣子：`funnel --bg` 印出同意連結、逾時（142）或報錯退出；`funnel status` 沒有 `(Funnel on)`；公開 DNS 一直查不到 IPv4；**而且 V3 手機也打不到**。→ 請 Eason 補做 A8（Funnel 同意、MagicDNS、HTTPS Certificates），再重做第 7 步。
  - **只是繞回不通**的樣子：`funnel status` 有 `(Funnel on)` 且指到 `http://127.0.0.1:8793`、公開 DNS 查得到非 100.x 的 IPv4，但 Mac mini 自己 `curl --resolve` 逾時或連不上；**V3 手機 4G（已中斷 Tailscale）打得到**。→ 不是故障，記「繞回驗證不適用」，以 V3 為準，不要叫 Eason 重做後台。
- 幾個月後突然全斷 → 多半是 key expiry 沒停用（A8），請 Eason 在後台重新驗證並停用過期。

**C. Node 版本不符**
- `server.err.log` 出現「需要 Node 24 以上」：plist 的 `__NODE__` 指錯 → `"$HOME/.local/node/bin/node" -v`、`plutil -p ~/Library/LaunchAgents/com.dzy.bulletin.plist | grep node`。
- `server.err.log` 出現 `ExperimentalWarning: SQLite is an experimental feature…`：Node 24 的正常提示，**無害**，不用處理。
- 小版升級（仍是 24.x）：重做第 1 步下載新的 24.x，`ln -sfn` 換捷徑，然後 `launchctl kickstart -k gui/$(id -u)/com.dzy.bulletin`。
- **不要自行升到 25 以上**：要先在 MacBook 跑過 `./tools/build.sh` 全過，由 Eason 決定。

**D. BRIDGE 錯誤**（看 `$HOME/dzy-bulletin-data/logs/mirror-last.json`／`backup-last.json` 的 `error`、`server.err.log`；這些都不含金鑰。`.env` 完整路徑是 `$HOME/dzy-bulletin/server/.env`）
- `/health` 的 `bridge` 是 `missing` → `.env` 缺 `BRIDGE_URL` 或 `BRIDGE_KEY` 行（A10 生效後這兩個計數請 Eason 在終端機 App 執行、回報數字）：`grep -c '^BRIDGE_URL=' "$HOME/dzy-bulletin/server/.env"`、`grep -c '^BRIDGE_KEY=[0-9a-f]\{64\}$' "$HOME/dzy-bulletin/server/.env"`，補好後 `kickstart -k`。
- `…未設定 Google 橋接（BRIDGE_URL／BRIDGE_KEY）` → 同上（背景工作也讀同一個 `.env`）。
- `…AUTH 橋接金鑰錯誤` → 兩邊金鑰不一致或 Apps Script 的那把短於 32 字元。請 Eason 重做 A9（那一行會先刪掉 `.env` 裡舊的金鑰行，Claude 不經手），做完 `kickstart -k` 伺服器、再 `kickstart` daily 驗證。
- `…AUTH 目前不接受這個橋接動作` → 金鑰是對的；是 `mirror`／`export` 在 `PRIMARY=gas` 時被擋。M4 階段 mirror 出現這個是**正常**的。
- `鏡像：BAD_REQ` 開頭的任何錯誤（`鏡像資料全空，拒絕覆寫`、`鏡像的…筆數（…）比現有（…）少一半以上，拒絕覆寫…`、`鏡像資料缺 …`）→ M4 階段一律代表 Apps Script 被設成了 `PRIMARY=mini`，同仁此刻簽不了名。**立刻停下**，請 Eason 把 `PRIMARY` 改回 `gas`（見第 6 步判讀表）。
- `…回應不是 JSON` → `BRIDGE_URL` 不是 Apps Script 網頁應用程式的 `/exec` 網址，或該部署的存取權不是「任何人」。
- `BRIDGE_TIMEOUT …`／`連線 Google 逾時`、`Google 雲端暫時連不上` → Apps Script 排隊或 Google 暫時故障；下一輪會自己重跑，連續多次再回報。
- `/health` 黃燈、`why` 有「備份資料夾有共用者」→ 雲端硬碟「鼎兆元｜電子佈告欄備份」資料夾被分享了。請 Eason 在雲端硬碟對該資料夾 → 共用 → 移除所有共用者（也不要開「知道連結的人」），隔天快照後 `sharedWith` 回到 0 就轉綠；急的話 `launchctl kickstart gui/$(id -u)/com.dzy.bulletin.daily` 立刻重跑一次。
- `/health` 黃燈、`why` 有「本機缺簽名圖」或「有壞簽名圖」→ 見第 6 步判讀表與故障排除 E（M4 空庫不會出現）。
- `/health` 黃燈、`why` 有「備份資料夾權限讀不到」（`sharedWith` 為 -1）→ Apps Script 這次讀不到資料夾權限，沒驗證到「僅 owner」。通常下一次快照就恢復；連續兩天都是 -1 再回報。


**E. 簽名回填（M5 搬資料之後才會遇到；M4 空庫不會出現）**
- `mirror-last.json` 的欄位：`pending`（本機有圖、驗過、還沒回填）、`missing`（本機找不到圖）、`bad`（本機圖檔損毀：0 位元組、PNG／JPEG 開頭或結尾不對）、`skipped`（人工略過）、`failed`（這一輪 Drive 端傳不上去的張數，屬暫時故障、留在 pending 下一輪重試）、`busy`／`running`（見第 6 步判讀表）。`missing`、`bad` 會讓 `/health` 黃；`skipped` 不會。
- **人工略過清單 `$DATA/logs/sig-skip.json`**：只能由人手動建立（Eason 決定、或經他同意由 Claude 代寫），程式**只讀不寫**。格式是一個 JSON 物件，鍵是「公告id/同仁id」，值是**非空的原因字串**，例如：

```json
{ "P-20260920-001/S-013": "2026-10-01 Drive 一直拒收，Eason 同意略過" }
```

  寫錯格式（不是物件、值不是非空字串、JSON 壞掉）時**整份不生效**：這一輪照常上傳、不略過任何一張，並記 `ok:false`（`error` 含「sig-skip.json 格式錯誤」）。鍵打錯字（對不到任何已讀）會列在警告裡。寫完可用 `python3 -m json.tool "$HOME/dzy-bulletin-data/logs/sig-skip.json" >/dev/null && echo 格式OK` 先驗。
- **不要改 `$DATA/logs/sig-state.json`**：那是程式自用的（記「已上傳、還沒寫進庫」的 Drive id），手改或刪掉會讓那些圖重傳成孤兒檔。它壞掉時程式會自己改名成 `.corrupt-*` 保留並 `ok:false`，交給人核對。
- 回退前的 `mirror.js --all`：`pending≠0` 就以 1 結束；一整輪沒有進展會印「Drive 端有 N 張傳不上去，稍後再跑」並列出是哪幾張——隔一陣子再跑；多次重跑仍失敗，而且確定要放棄的，才寫進 `sig-skip.json`。

**F. 附件備份（M7，#18）**
- 位置：`$DATA/files/<fileId>`（位元組）＋`<fileId>.json`（meta：原檔名、md5、sha256、何時存、`removedAt`＝主管何時移除）。**只當備份**：同仁看附件照樣走雲端硬碟線上預覽、不能下載；這個資料夾不對外提供。
- **永久保留、不要刪**：主管移除附件時，雲端硬碟那份丟垃圾桶、30 天後自動永久刪除，**之後 Mac mini 這份是唯一一份**（Eason 2026-09-30 選 B 接受的已知風險；要更保險可另接外接碟做 Time Machine）。
- 每小時鏡像的第 3 步自動補（每輪最多 10 個檔或 100MB，可用 `.env` 的 `FILES_MAX_PER_RUN`／`FILES_MAX_MB_PER_RUN` 調）；每天第一輪另外掃一次附件資料夾。結果在 `mirror-last.json` 的 `files`：`count`（已備份個數）、`bytes`、`pending`（待補）、`stale`（待補超過 24 小時）、`failed`（這一輪沒補到，暫時故障、下一輪再試）、`skipped`（人工略過）、`lastScanAt`、`failedIds`（清單＋原因）。第 3 步的失敗**不會**讓鏡像 `ok:false`，只有 `stale > 0` 時 `/health` 黃「有附件超過 24 小時沒補齊」。
- 一直補不到：原因寫在 `failedIds` 括號裡。「Drive 上找不到」多半是移除超過 30 天、已被永久刪除，救不回來——經 Eason 同意後寫進 **`$DATA/logs/file-skip.json`**（格式同 `sig-skip.json`，鍵是 fileId）：

```json
{ "1AbCdEfGh...": "2026-10-05 Drive 已永久刪除，Eason 同意放棄" }
```

  寫錯格式時整份不生效（這一輪不略過任何一個）、`files.ok:false`。程式永遠不自己判定放棄。
- 補不到的檔不會卡住新附件：從沒試過的先補、試過失敗的依上次嘗試時間輪流；「Drive 上找不到」的不算每輪 10 個的名額，已知找不到的每輪只再試 2 個（meta 的 `lastTryAt`／`lastDead`）。
- **預期行為、不處理**：主管上傳後在儲存公告前就失敗的附件（例如上傳等待中通行碼剛更換），Drive 那份會被撤到垃圾桶、上傳當下本機也不存；但隔天的 `filelist` 會列到垃圾桶裡的它，照樣備份下來（`source:filelist`、有 `removedAt`）。只多佔一點空間，沒有安全問題。
- `node "$REPO/server/mirror.js" --files-verify`：重算每個附件的 sha256 與 meta 比對，不符的列出來、**不自動刪**，回報 Eason。

---

## 未簽提醒（選用，#26）

做什麼：每天 18:00 `server/sign-remind.js` 唯讀查資料庫，找出**小辛辣光復店**同仁（`staff.src` 以 `gf:` 開頭、在職）有公告**上架滿 3 天**（台北日期差 ≥ 3，例：10/1 上架 → 10/4 起）還沒簽的，
依公告分組寫成一則文字，經**光復小幫手**（訂貨小幫手 @954wknja）的文字候補入口（`enqueue_text`，label 固定 `佈告欄未簽提醒`）排進光復群組，群組有人說話時用免費 reply 帶出，不吃月額度。
每天提醒到簽完為止；沒有人要提醒就不打小幫手；同一天重跑由小幫手判重（`queued` 回 0），不會重複提醒。只寫全名，不 @ 人。小幫手 GAS **不用改**。
結果在 `$DATA/logs/remind-last.json`（`at`、`ok`、`people`、`posts`、`queued`、`error`）與 `$DATA/logs/remind.log`。失敗（連線失敗已重試 1 次）只影響這則提醒，佈告欄服務不受影響。

**1. `.env` 兩個鍵（Eason 親手貼，Claude 不經手、不印出）**：在 Mac mini 用文字編輯器打開 `~/dzy-bulletin/server/.env`，最後加兩行後存檔：

```
REMIND_ENQUEUE_URL=<光復小幫手 Apps Script 的 /exec 網址（與其他系統投遞候補用的同一個）>
REMIND_ENQUEUE_TOKEN=<小幫手的 ENQUEUE_TOKEN>
```

Claude 只用這行確認兩個鍵都在（只印數量、不印值）：`grep -c '^REMIND_ENQUEUE_\(URL\|TOKEN\)=.' "$REPO/server/.env"`（期望 `2`）。
沒設定時 job 只印「未設定 REMIND_ENQUEUE_URL／TOKEN，尚未啟用」並 exit 0，所以**可以先裝 plist、之後再貼鍵**。`.env` 只在每次執行時讀，貼完不用重啟任何東西。

**2. `--dry-run` 驗證（Claude，不用 sudo；不送出、不需要先貼鍵）**：

```sh
export PATH="$HOME/.local/node/bin:$PATH"; REPO="$HOME/dzy-bulletin"; DATA="$HOME/dzy-bulletin-data"
DATA_DIR="$DATA" node "$REPO/server/sign-remind.js" --dry-run
```

印出的就是今天 18:00 會送的訊息（沒有人要提醒時印「沒有人需要提醒，不會送出」）。請 Eason 對照佈告欄後台各公告的回條確認名單。
最後若有「⚠ 以下光復同仁不在打卡同步名單，不會被提醒」一行：那些是小辛辣、在職、但沒有打卡來源（`gf:`）的同仁（手動建的、刪除後又手動加回的；美村／南昌的人也會列在這裡，因為小辛辣沒有門市欄位）。光復的人列在這行就不會被提醒，請 Eason 決定要不要處理（同一行每天也寫進 `remind.log`）。

**3a. 安裝 plist（一般路線：LaunchAgent，不用 sudo）**：

```sh
REPO="$HOME/dzy-bulletin"; DATA="$HOME/dzy-bulletin-data"; NODE="$HOME/.local/node/bin/node"; U="gui/$(id -u)"; J=com.dzy.bulletin.remind
sed -e "s#__NODE__#$NODE#g" -e "s#__REPO__#$REPO#g" -e "s#__DATA_DIR__#$DATA#g" "$REPO/server/launchd/$J.plist" > "$HOME/Library/LaunchAgents/$J.plist"
plutil -lint "$HOME/Library/LaunchAgents/$J.plist" && grep -c '__[A-Z_]*__' "$HOME/Library/LaunchAgents/$J.plist"   # 要 OK、0
launchctl bootstrap "$U" "$HOME/Library/LaunchAgents/$J.plist" && launchctl print "$U/$J" | grep -E '^\s*state ='
```

**3b. 安裝 plist（附錄 A 路線：LaunchDaemon，Mac mini 現行用這條）**：
- Claude（不用 sudo）：照附錄 A 第 2 點產生 plist——上面 3a 的 `sed` 改輸出到 `~/.local/src/launchdaemons/com.dzy.bulletin.remind.plist`，並在 `<dict>` 第一層加 `<key>UserName</key><string>部署帳號（whoami 的結果）</string>`；`plutil -lint` OK、佔位字串 0、不含金鑰。
- Eason（sudo，在他自己的終端機 App）：
  ```sh
  S="$HOME/.local/src/launchdaemons"; J=com.dzy.bulletin.remind
  sudo cp "$S/$J.plist" /Library/LaunchDaemons/ && sudo chown root:wheel /Library/LaunchDaemons/$J.plist && sudo chmod 644 /Library/LaunchDaemons/$J.plist
  sudo launchctl bootstrap system /Library/LaunchDaemons/$J.plist
  ```
- Claude 驗證：`launchctl print system/com.dzy.bulletin.remind | grep -E '^\s*state ='`（讀不到請 Eason 加 sudo）。

**4. 正式跑一次（貼好鍵之後）**：一般路線 `launchctl kickstart "$U/com.dzy.bulletin.remind"`；附錄 A 路線請 Eason `sudo launchctl kickstart system/com.dzy.bulletin.remind`（或 Claude 直接 `DATA_DIR="$DATA" node "$REPO/server/sign-remind.js"`，效果相同）。
接著 `cat "$DATA/logs/remind-last.json"`：`ok:true`、`queued≥1`（今天已送過則為 0）；小幫手的候補分頁會多一列 `TXT:佈告欄未簽提醒`，光復群組有人說話後帶出。
`/health` 會帶出 `remind: { at, ok, people }`（沒裝或沒啟用＝`null`）；最後一次 `ok:false` 時燈號轉黃、原因「未簽提醒送出失敗」，下一次成功就恢復。`ok:false` 時看 `error`：`小幫手拒收：bad token` → 請 Eason 重貼 `REMIND_ENQUEUE_TOKEN`；`連不上小幫手`／`逾時`／`不是 JSON` → 網址錯或 Google 暫時不通，隔天會自動再試。

**停用**：一般路線 `launchctl bootout "$U/com.dzy.bulletin.remind"; rm -f ~/Library/LaunchAgents/com.dzy.bulletin.remind.plist`；附錄 A 路線請 Eason `sudo launchctl bootout system/com.dzy.bulletin.remind; sudo rm -f /Library/LaunchDaemons/com.dzy.bulletin.remind.plist`。或只把 `.env` 兩行刪掉（job 照跑、印「尚未啟用」）。

## 新公告上架通知（#28，沿用未簽提醒的 .env）

做什麼：主管上架的公告若是**小辛辣光復同仁要簽的**（單位含小辛辣或「全部」），伺服器就經**光復小幫手**（訂貨小幫手 @954wknja）的 `push_text` 入口**直接 push** 到光復群組（吃小幫手每月額度）。額度快滿、被 429、或當天已 push 滿 5 則時，小幫手改走候補：群組有人說話才帶出，到隔天 06:00 沒人說話就作廢，作廢會經通知匣告知 Eason。訊息：

```
📢 佈告欄新公告
《公告標題》
請到 https://dzy-bulletin.github.io 閱讀並簽名
```

- **不另裝 launchd job**：計時器在伺服器程序裡（`server/announce.js`），伺服器啟動時先跑一次，之後**每 1 小時**一次。所以主管上架後最慢約 1 小時群組收到；排定未來上架的，到上架日後的第一輪才推。
- **沿用未簽提醒那兩個鍵**（`REMIND_ENQUEUE_URL`、`REMIND_ENQUEUE_TOKEN`，見上一節第 1 步），同一個小幫手、同一組 token，不用新增任何金鑰。沒設這兩個鍵 → 伺服器啟動時印一行「新公告通知：未設定 REMIND_ENQUEUE_URL／TOKEN，不啟動」，其他照常。
- **部署順序：先部署小幫手含 `push_text` 的版本、確認後，再更新佈告欄伺服器。** 舊版小幫手不認得 `push_text`，會回 `{ok:true}`（沒有 `mode`、也沒有 `action:'push_text'` 回聲）；伺服器只把「`ok:true`＋`mode` 是 push／fallback／dup＋帶 `action:'push_text'`」當成推出，所以舊版的回應會記成失敗（log：「小幫手回應不符」），不會誤記成已推；但 3 次失敗後就會放棄，要用下面的 `--retry-all` 補回來。
- 小幫手端限制用途：label 必須 `佈告欄新公告:` 開頭；內容必須**整段**是上面的三行格式（標題不可換行、不可含 `http`、`://`、`www.`），不超過 400 字；每天最多 push 5 則，超過改走候補。伺服器送出前會先清理標題（換行改空白、網址字樣改成全形字），所以實際送出的訊息一定符合格式。
- 每則公告只推一次（判重在佈告欄 SQLite kv `announced`，小幫手端也以 label `佈告欄新公告:<公告ID>` 永久判重）：編輯公告不重推、下架後重新上架也不重推。
- **第一次啟用不補推舊公告**：kv 沒有 `announced` 時，把現有公告（排定未來上架的除外）全部標成已通知。
- 失敗（連不上、逾時、不是 JSON、小幫手回 `ok:false`、回應不符）：那一則不標記，下一輪（1 小時後）重試；同一則**失敗 3 次**就停止重試，記在 `announce.log`。距離上次失敗不到 50 分鐘的失敗不累加（伺服器重啟、崩潰重起不會幾分鐘內就放棄），所以實際約 2～3 小時。
- 結果在 `$DATA/logs/announce-last.json`（`at`、`ok`、`pending`、`sent`、`failed`、`gaveUp`）與 `$DATA/logs/announce.log`（有動作才寫）；`/health` 帶出 `announce: { at, ok, pending, gaveup }`（沒啟用＝`null`；剛啟動、第一輪還沒跑完＝四欄 `null`）。最後一輪 `ok:false` 時燈號轉黃、原因「新公告通知失敗」，下一輪成功就恢復；`gaveup`（已放棄的則數）大於 0 時**一直黃燈**、原因「有新公告通知已放棄」，直到用下面的指令清掉。

**放棄後補推**（伺服器開著也可以跑，不用重啟）：
```bash
cd "$REPO" && DATA_DIR="$DATA" node server/announce.js --retry <公告ID>   # 只補這一則（公告 ID 看 announce.log 的「停止重試」那行）
cd "$REPO" && DATA_DIR="$DATA" node server/announce.js --retry-all        # 所有放棄的、失敗中的都清掉
cd "$REPO" && DATA_DIR="$DATA" node server/announce.js --skip <公告ID>    # 確認不推：標成已通知（例如已自己在群組講過），只清黃燈、不會推
```
`--retry` 清掉後 `/health` 的 `gaveup` 立刻歸零，下一輪（1 小時內）重新推；小幫手若其實已推出過會回 dup，不會重推。`--skip` 之後這則永遠不推，`gaveup` 也立刻歸零。三個指令都不會動已成功通知的公告，伺服器開著時跑也安全（讀寫都在同一筆 SQLite 交易裡）。
退回候補後作廢的公告不能用 `--retry` 補推（記成 fallback＝已交給小幫手）；作廢會經通知匣告知，要補就請主管在群組貼一次。

**啟用／更新**：照附錄 B 更新程式到 main 後**重啟伺服器**（附錄 A 路線沒 sudo 時用 kill 讓 KeepAlive 重起）就生效——伺服器的 `.env` 只在啟動時讀，之後若才貼或換那兩個鍵，也要再重啟一次。

**驗證（不要上架測試公告）**：
1. 重啟後 `curl -s http://127.0.0.1:8793/health`：要有 `announce` 欄位，且 `ok` 不是 `false`（剛啟動幾秒內可能三欄都是 `null`，稍等再查一次）。`announce` 是 `null` → 兩個鍵沒讀到，對照上一節第 1 步的 `grep -c`。
2. 伺服器 log 要有首次啟用那一行：`grep '首次啟用：已將' "$DATA/logs/server.log" "$DATA/logs/announce.log"`（例：「首次啟用：已將 12 則現有公告標記為已通知」；只會出現一次，之後重啟不會再印）。
3. 等下一則正式公告上架（單位含小辛辣或「全部」），**1 小時內**光復群組會收到通知；`announce.log` 會有「已通知 <公告ID>（push）」。

`ok:false` 時看 `announce.log`：`小幫手拒收：bad token` → `REMIND_ENQUEUE_TOKEN` 錯（未簽提醒也會一起壞）；`小幫手回應不是 JSON` → 小幫手還沒部署 `push_text` 版、或網址錯；`連不上`／`逾時` → Google 暫時不通，下一輪自動重試。

**停用**：把 `.env` 那兩行刪掉後重啟伺服器（未簽提醒也會一起停）。

---

## 附錄 A：如果 FileVault 已經開了（或 Eason 不接受自動登入）→ 改走 (B) LaunchDaemon

FileVault 開著就不能自動登入，LaunchAgent 在停電重開後不會啟動。改成 LaunchDaemon（`system` domain，開機即跑、**不需登入任何帳號**）。#9 實機就是走這條（2026-09-30）。

**先講清楚代價**：這條路線在**停電或重開機後一定要有人到現場**，在 FileVault 解鎖畫面輸入密碼解鎖磁碟。流程是：開機 → 有人輸入部署帳號的密碼解鎖（macOS 預設解鎖就等於直接登入這個帳號）→ LaunchDaemon（伺服器、mirror、daily）與 `tailscaled` 自己啟動 → 3 分鐘內恢復服務，解鎖後不必再做任何事。沒人到場之前整站斷線。LaunchDaemon 的好處是：就算之後有人登出或切換帳號，服務也不會停。

**哪些要 sudo（交給 Eason 在他自己的終端機 App 執行）**：`system` domain 的 `launchctl bootstrap`／`bootout`／`kickstart`、`launchctl print system/…`（部分欄位）、複製到 `/Library/LaunchDaemons/`、`brew services` 啟動 `tailscaled`。Claude 沒有 sudo，把指令整段列給 Eason，等他說做完再驗證。

1. **移除 LaunchAgent**（Claude，不用 sudo；沒裝過就略過）：
   `for j in com.dzy.bulletin com.dzy.bulletin.mirror com.dzy.bulletin.daily; do launchctl bootout gui/$(id -u)/$j 2>/dev/null; rm -f ~/Library/LaunchAgents/$j.plist; done`
2. **產生 plist**（Claude，不用 sudo）：用第 5 步同樣的 `sed` 替換，但輸出到 `~/.local/src/launchdaemons/`，並在每個 plist 的 `<dict>` 第一層加 `<key>UserName</key><string>部署帳號（whoami 的結果）</string>`（以該使用者身分執行，資料夾權限不變）。一樣要 `plutil -lint` 全 OK、佔位字串 0、不含金鑰。
3. **安裝與載入（Eason，sudo）**：
   ```sh
   S="$HOME/.local/src/launchdaemons"
   for j in com.dzy.bulletin com.dzy.bulletin.mirror com.dzy.bulletin.daily; do sudo cp "$S/$j.plist" /Library/LaunchDaemons/ && sudo chown root:wheel /Library/LaunchDaemons/$j.plist && sudo chmod 644 /Library/LaunchDaemons/$j.plist; done
   for j in com.dzy.bulletin com.dzy.bulletin.mirror com.dzy.bulletin.daily; do sudo launchctl bootstrap system /Library/LaunchDaemons/$j.plist; done
   ```
   **daily 的第 6 步 kickstart 不要接在這一行後面**：至少隔 10 秒再單獨請 Eason 執行 `sudo launchctl kickstart system/com.dzy.bulletin.daily`（見第 6 步的原因）。
4. **驗證（Claude）**：`launchctl print system/com.dzy.bulletin | grep -E 'state|pid'`（讀不到就請 Eason 加 sudo 跑）；「聽 8793 的 PID＝launchd 的 pid」與第 5 步同一套比對，只把 `gui/$(id -u)` 換成 `system`。
5. **殺掉會自己重起**（Claude，不用 sudo：伺服器以部署帳號身分執行，自己的程序可以 kill）：第 5 步那段照跑，把 `"$U/com.dzy.bulletin"` 換成 `system/com.dzy.bulletin`；看不到 pid 時改用 `lsof -t -iTCP:8793 -sTCP:LISTEN` 取 PID。
6. **Tailscale 改用 Homebrew 的 `tailscaled`**（官方 App 要登入帳號才會跑，這條路線不能用）：
   - 先移除官方 App（有的話），再由 Eason：`brew install tailscale` → `sudo brew services start tailscale`（以 root 常駐、開機即跑、不需登入）。
   - 登入時**一定要帶 operator**，第 7 步 Claude 才能不用 sudo 操作 Funnel：`sudo tailscale up --operator=$(whoami)`（在部署帳號的終端機執行，`$(whoami)` 就是部署帳號）。之後重做 A8。
   - CLI 路徑用 `command -v tailscale`（手冊的 `TS` 變數已自動處理）；這個版本**沒有選單列圖示**，V4 改用 `tailscale down`／`tailscale up`。
7. **V5／V6 改照 FileVault 流程驗**：重開（或拔電再插）→ 在解鎖畫面輸入部署帳號的密碼 → **解鎖後不必做任何事，等 3 分鐘** → 手機（已中斷 Tailscale、4G）打 `/health`。（macOS 預設解鎖時會直接登入部署帳號，所以這個測試驗的是「有人解鎖之後不用再動手就恢復」。）
8. **A3（關閉自動安裝 macOS 更新）強烈建議關閉**；不關的話，半夜自動更新重開會停在 FileVault 解鎖畫面，要等隔天有人到場輸入密碼才恢復（Eason 2026-09-30 選擇保留，接受此風險）。
9. **之後的重啟與還原**：
   - 重啟伺服器（例如改了 `.env`、更新程式）：有 sudo 就請 Eason `sudo launchctl kickstart -k system/com.dzy.bulletin`。**沒有 sudo 時**，Claude 直接 kill 伺服器的 PID，由 `KeepAlive` 在 10 秒內重起，並確認 PID 已換：
     ```sh
     P1=$(lsof -t -iTCP:8793 -sTCP:LISTEN); echo "原 PID $P1"; kill "$P1"
     curl -sf --retry 30 --retry-delay 1 --retry-connrefused -o /dev/null http://127.0.0.1:8793/health && P2=$(lsof -t -iTCP:8793 -sTCP:LISTEN) && echo "新 PID $P2"
     [ -n "$P2" ] && [ "$P1" != "$P2" ] && echo "✓ 已由 KeepAlive 重起（PID 已換）" || echo "✗ PID 沒換或沒起來，停下來回報"
     ```
   - 改了 plist：由 Eason `sudo launchctl bootout system/<label>` 再 `sudo launchctl bootstrap system /Library/LaunchDaemons/<label>.plist`（`kickstart` 不會重讀 plist）。
   - `restore.js --launchd` 只支援 LaunchAgent；還原時不加 `--launchd`，由 Eason 手動 `sudo launchctl bootout system/…`（三個）→ Claude 跑 `restore.js` → Eason `sudo launchctl bootstrap system /Library/LaunchDaemons/…`（伺服器與 daily；mirror 照 restore 印出的提示再決定）。
   - 手冊其他地方寫 `gui/$(id -u)/…` 的，這條路線一律換成 `system/…` 並加 sudo（交給 Eason）；伺服器重啟可用上面的 kill 做法取代。

---

## 附錄 B：之後更新程式（已部署或部署到一半的機器）

適用：Mac mini 已照舊版手冊部署（或做到一半），要更新到新版。`mini/m4` 在合併進 `main` 之前可能被 rebase（改寫歷史），這時單純 `git pull` 會失敗（無法快轉）；下面的寫法兩種情況都能處理。**M1～M4 合併後**要改跟 `main`：先 `git -C "$REPO" fetch -q origin && git -C "$REPO" checkout -q main`，再照下面做。**部署做到一半時**：先照下面更新程式，再用新版手冊從原本做到的那一步繼續（證據檔保留，不用重做前面的步驟）。

```sh
export PATH="$HOME/.local/node/bin:$PATH"; REPO="$HOME/dzy-bulletin"; DATA="$HOME/dzy-bulletin-data"; NODE="$HOME/.local/node/bin/node"; U="gui/$(id -u)"   # 每段指令前都要先貼這段
OLD=$(git -C "$REPO" rev-parse --short HEAD)
[ -z "$(git -C "$REPO" status --porcelain)" ] || { echo "✗ repo 有本機改動，停下來回報（不要自己丟掉）"; exit 1; }
git -C "$REPO" fetch -q origin && BR=$(git -C "$REPO" branch --show-current) && echo "分支 $BR"
git -C "$REPO" merge --ff-only -q "origin/$BR" 2>/dev/null || git -C "$REPO" reset -q --keep "origin/$BR"   # 合併前的分支可能被 rebase 過、無法快轉：改用 reset --keep 對齊遠端（.env 被 git 忽略，不受影響）
NEW=$(git -C "$REPO" rev-parse --short HEAD); [ "$NEW" = "$(git -C "$REPO" rev-parse --short "origin/$BR")" ] && echo "$OLD → $NEW"
git -C "$REPO" diff --stat "$OLD" "$NEW" -- server/launchd/com.dzy.bulletin.plist server/launchd/com.dzy.bulletin.mirror.plist server/launchd/com.dzy.bulletin.daily.plist .gitignore   # 三個常駐 job 的範本有沒有改（OLD 被 rebase 掉時仍可比對，git 會保留在 reflog）；選用的 remind 不算，見下方
git -C "$REPO" diff --stat "$OLD" "$NEW" -- server/launchd/com.dzy.bulletin.remind.plist   # 選用的未簽提醒範本（#26）：只在「已裝 remind」時才看這行
ls -l "$REPO/server/.env"                                                    # 期望仍在、-rw-------
git -C "$REPO" status --porcelain                                            # 期望空白（.env 仍被忽略）
echo "更新程式：$OLD → $NEW（$(date '+%F %T')）" >> "$DATA/logs/deploy-evidence.txt"
```

**重啟三個 job**：
- 三個常駐範本 **沒有改動**（上面第一行 diff 是空的）：
  - 伺服器常駐，要重啟才會載入新程式：`launchctl kickstart -k "$U/com.dzy.bulletin"`，再 `curl -sf --retry 20 --retry-delay 1 --retry-connrefused http://127.0.0.1:8793/health; echo` 確認。
  - mirror、daily 每次排程都是新開一個程序，**下一輪自動用新程式**，不用重啟。確認沒有正在跑的舊程序：`launchctl print "$U/com.dzy.bulletin.mirror" | grep -E '^\s*state ='`（`running` 就等它結束）。
  - M4 階段**不要**為了測試去 `kickstart` mirror（每跑一次都被擋、失敗次數 +1）；daily 可以 `launchctl kickstart "$U/com.dzy.bulletin.daily"` 驗一次。
- 三個常駐範本 **有改動**：三個都重做第 5 步的替換、`plutil -lint`，再逐一 `launchctl bootout "$U/<label>"` → `launchctl bootstrap "$U" ~/Library/LaunchAgents/<label>.plist`。注意 mirror 的 `RunAtLoad`：bootstrap 時會馬上跑一輪，M4 階段那一輪被擋、`/health` 可能因此轉黃，屬預期。
- 兩種情況最後都跑第 5 步的驗證（PID 相符）與 `curl -s http://127.0.0.1:8793/health`。
- 上面「有改動／沒有改動」只看第一行 diff（三個常駐 job 的範本）；新增或修改 `com.dzy.bulletin.remind.plist` **不算**常駐 job 有變，不要因此重啟伺服器。
- **未簽提醒（`com.dzy.bulletin.remind`）是選用的，更新時沿用原本的安裝狀態**：原本沒裝就不用裝（要啟用另照「未簽提醒（選用）」一節）；原本有裝、而第二行 diff 有內容，才照該節第 3a／3b 步重新產生、`bootout` 再 `bootstrap`；沒改動就不用動（每天新開程序，下一輪自動用新程式）。
- **附錄 A（LaunchDaemon，`system` domain）**：
  - 三個常駐範本沒有改動：伺服器用附錄 A 第 9 點的「kill PID、由 KeepAlive 重起」（不用 sudo，印出新舊 PID 確認已換）；有 sudo 時也可請 Eason `sudo launchctl kickstart -k system/com.dzy.bulletin`。mirror、daily 同樣下一輪自動用新程式；確認沒在跑用 `launchctl print system/com.dzy.bulletin.mirror | grep -E '^\s*state ='`（讀不到請 Eason 加 sudo）。daily 要驗一次就請 Eason `sudo launchctl kickstart system/com.dzy.bulletin.daily`。
  - 三個常駐範本有改動：Claude 照附錄 A 第 2 點重新產生 plist（含 `UserName`），再由 Eason 照附錄 A 第 3 點逐一 `sudo launchctl bootout system/<label>` → `sudo cp`／`chown`／`chmod` → `sudo launchctl bootstrap system /Library/LaunchDaemons/<label>.plist`；daily 的 kickstart 另外隔 10 秒以上再跑。

**`sig-state.json` 的相容性**（從 M3 定稿前的版本升上來時）：舊版會在 `$DATA/logs/sig-state.json` 寫 `{ "fails": {…}, "unsaved": {…} }`（fails 是舊的「連續失敗 3 次判壞圖」計數）。新版只讀 `unsaved`（鍵的格式相同，照常沿用），**忽略 `fails`**，下一次寫檔時自然去掉；壞圖改由本機檢查圖檔判定。所以**什麼都不用做，也不要刪這個檔**（刪掉會讓 `unsaved` 裡已上傳的圖重傳成孤兒檔）。M4 階段資料庫是空的，這個檔通常根本不存在。
舊版「把某張從 `sig-state.json` 刪掉就會重試」的做法已經作廢，改用故障排除 E 的 `sig-skip.json`（只用來略過，不用來重試）。

**LINE 自動登入（2026-10-09，v0.7.0）**：
- 順序：**先部署 GAS、再更新 Mac mini**。新 GAS 的橋接 `clock` 會多回每人的 `lineHash`（打卡 roster 的 `line_user_id` 在 Apps Script 內就轉成雜湊）；Mac mini 先更新也不會壞，只是 `lineHash` 一直是空的、LINE 登入全部「對不到人」退回選名字。
- `server/.env` **選用**兩個鍵（不設就用預設，不用改 `.env`）：`LINE_CHANNEL_ID`（LINE Login 頻道 ID，預設 `2011292256`）、`LINE_LOGIN_PER_MIN`（有 `X-Forwarded-For` 時每個來源 IP 每分鐘最多幾次要打 LINE 驗證的 `lineLogin`，預設 10）、`LINE_LOGIN_GLOBAL_PER_MIN`（全體每分鐘上限，預設 120），超過回 BUSY。改了要重啟伺服器。
- **部署時驗一次限流分桶看的標頭（#32-8）**：伺服器以 `X-Forwarded-For` 的**最後一段**分桶，沒有這個標頭就只套全體上限。重啟後，請 Mac mini 的 Claude 暫時在 `handle()` 的 lineLogin 路徑印出 `req.headers['x-forwarded-for']`（不要印 body），或用 `tailscale funnel` 的請求紀錄確認；再從**外部網路**（手機關 Tailscale）執行
  `curl -s -H 'X-Forwarded-For: 1.2.3.4' -H 'Content-Type: text/plain' --data '{"action":"lineLogin","idToken":""}' <Funnel 網址>`
  看伺服器收到的標頭：若是 `1.2.3.4, <你的真實 IP>`（Funnel 把真實 IP 附加在最後）＝分桶有效；若只有 `1.2.3.4`（Funnel 原樣轉送客戶端的值）或完全沒有＝每 IP 分桶等於沒作用、只剩全體上限，把結果記進 `deploy-evidence.txt` 並回報 MacBook 的 Claude。驗完把暫時加的印出拿掉。（這個請求本身回 `BAD_REQ`，不會打 LINE、也不算進限流。）
- 伺服器要能連 `https://api.line.me`（驗 ID token，逾時 8 秒）；連不上時同仁看到「LINE 驗證暫時連不上」並退回選名字，不影響其他功能。
- 更新後**重啟伺服器**（照上面），`lineLogin` 才會生效；`lineHash` **在下一輪每小時 mirror 時自動填上**（`mirror.log` 會有一行「LINE 綁定刷新：更新 N 人、已綁定 M 人」，`mirror-last.json` 的 `line`）。不想等就請主管在設定頁按一次「打卡同步」（同樣會填）。讀打卡名單失敗只記一行、跳過，不影響鏡像燈號。解綁／改綁的同仁 pinVer 會 +1（所有已登入手機要重登，密碼不變）。
- 鏡像寫回試算表的「LINE 綁定（雜湊）」欄一律空白（試算表不存）；回退到 GAS 後，主管按一次「打卡同步」就會重新填。
- GAS 端的 `lineLogin`（只在回退到 GAS 時用到）要呼叫 `UrlFetchApp`，需要 `https://www.googleapis.com/auth/script.external_request` 權限；`gas/appsscript.json` **刻意還沒加**（加了之後 Eason 要在編輯器重新授權一次，授權前整個 Web App 與橋接都會失敗）。沒加的期間 GAS 的 `lineLogin` 回 SERVER、前端退回選名字＋密碼。

---

## 附錄 C：M7 附件備份上線（已部署的機器，#18）

順序固定：**先部署 GAS、再更新 Mac mini**（舊 Mac mini 打新 GAS 沒事；新 Mac mini 打舊 GAS 時第 3 步拿到「未知的橋接動作」→ 暫時故障、留 pending，不會壞）。**要在 2026-10-29 前做完**：系統 9/29 上線，垃圾桶 30 天，超過就救不回 9/29 當天被移除的附件。

1. **MacBook 的 Claude**：GAS 新增 `fileget`／`filelist` 兩個橋接動作 → `clasp push` 後 `clasp deploy -i <正式部署 ID>`（新版號 @28 以後，照 CUTOVER 0-1 的 git hash 方式確認部署的是這個 commit）；`doGet` 回的 `v` 應為 `0.5.6`。
2. **Mac mini 的 Claude**：照附錄 B 更新程式、重啟伺服器（`server/launchd/` 沒改動，mirror 下一輪自動用新程式）。
3. **Mac mini 的 Claude：當天必跑一次** `node "$REPO/server/mirror.js" --files-scan`，印出 `count`／`pending`；`pending≠0` 再跑 `--files` 到 `pending=0`（見第 6 步那段與故障排除 F）。結論寫進證據檔。
4. 隔一小時看 `curl -s http://127.0.0.1:8793/health`：`files.pending=0`、`files.stale=0`。
5. 找一個真的接近 20MB 的附件確認分段跑通：`mirror.log` 有補到它、`$DATA/files/<它的 id>.json` 的 `size` 約 20MB、`--files-verify` 全部相符。
6. 回報 #18：`--files-scan` 那行原文、`/health` 的 `files`、20MB 那一筆的結果。
