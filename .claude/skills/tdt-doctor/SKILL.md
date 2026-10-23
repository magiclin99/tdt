---
name: tdt-doctor
description: 診斷並修復 TDT 的執行環境：Node.js、tdt build、Chrome、9222 port、Chrome 企業政策、profile 鎖定、MCP server 連線、資料夾信任，最後做一次實際操作確認。當 QA 說「tdt 不能用」「/tdt 沒反應」「MCP 連不上」「Chrome 開不起來」「幫我檢查環境」，或執行 /tdt 時發現 mcp__tdt__* 工具不存在、連線失敗時使用。
---

# TDT Doctor

逐項檢查 TDT 能不能用，**能安全修的直接修，其他的講清楚原因和做法**，最後用一張表回報。用 QA 下指令的語言回報。

## 修正權限

| 類型 | 例子 | 做法 |
|---|---|---|
| **直接修** | `npm install`、`npm run build`、清掉沒人在用的 Chrome profile 鎖定檔、關掉並重開 **TDT 自己的** Chrome（用的是 `<PROFILE>`） | 告訴 QA 你要做什麼，然後執行 |
| **先問再做** | 安裝 Node.js 或 Chrome（`brew install` 這類）、關掉**不是 TDT 的**程式、修改 `.mcp.json` 或 settings、刪掉整個 profile（會清掉登入狀態） | 說明原因和影響，等 QA 同意 |
| **絕對不做** | 修改 `~/.claude.json`、替 QA 按「信任資料夾」或「同意 MCP server」、關掉 Chrome 企業政策、用 sudo | 只說明 QA 或 IT 要怎麼處理 |

## 檢查順序

照順序做。前一項失敗時，後面受影響的項目標成「略過（因為 #N）」，不要硬跑。

**先讀設定**：從 `.mcp.json` 的 `mcpServers.tdt.env` 讀出 `TDT_CDP_URL`（預設 `http://127.0.0.1:9222`）和 `TDT_PROFILE_DIR`（預設 `~/.tdt/chrome-profile`）。下面寫 `<PORT>` 和 `<PROFILE>` 的地方，都換成實際讀到的值。
指令以 macOS / Linux 為主。Windows 的對應做法寫在每一項裡。

### 1. 工作目錄

確認目前目錄有 `.mcp.json` 和 `tdt-mcp/`，表示 Claude Code 是在 TDT 的專案根目錄開的。

- ❌ 不是的話：Claude Code 只讀當前目錄的 `.mcp.json`。請 QA 先 `cd` 到 repo 根目錄，再重新開 `claude`。這一項沒過，後面全部略過。

### 2. Node.js

```bash
node --version; npx --version
```

- 需要 **Node 18 以上**，而且 `node` 和 `npx` 都要有。
- ❌ 沒有或版本太舊：**先問再裝**。
  - macOS 有 Homebrew：`brew install node`
  - Windows：`winget install OpenJS.NodeJS.LTS`
  - 其他情況：請 QA 從 https://nodejs.org 下載 LTS 版安裝
- 裝好之後，**要請 QA 完全關掉 Claude Code 再重開**。MCP server 是 Claude Code 啟動時用當時的 PATH 開起來的。
- ⚠️ 已知誤導：沒有 node 時，Claude Code 會把 tdt 的錯誤顯示成 `Executable not found in $PATH: "stdio"`。實際缺的是 `node`，不是設定寫錯。

### 3. tdt build

```bash
ls tdt-mcp/node_modules/.package-lock.json tdt-mcp/dist/index.js
find tdt-mcp/src -newer tdt-mcp/dist/index.js -name '*.ts'
```

- 缺 `node_modules` 或 `dist`，或 `src` 比 `dist` 新：**直接修**，執行 `cd tdt-mcp && npm install && npm run build`。
- 失敗的話：
  - 看錯誤訊息。常見原因是公司 proxy 擋 npm，可以看 `npm config get registry`、`npm config get proxy`。
  - 把原因回報給 QA，不要自己改 npm 設定。
- 修完要提醒 QA：已經在執行中的 tdt 不會自動換新版，要用 `/mcp` 重新連線，或重開 Claude Code。

### 4. Chrome

- macOS：`"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --version`
- Linux：`google-chrome --version`
- Windows：`(Get-Item "$env:ProgramFiles\Google\Chrome\Application\chrome.exe").VersionInfo.ProductVersion`
- 有設定 `TDT_CHROME_PATH` 的話，改用它指的路徑。
- ❌ 找不到：
  - 先問 QA 是不是裝在別的位置。是的話，請 QA 設定 `TDT_CHROME_PATH` 環境變數，再重開 Claude Code。
  - 沒裝的話，**先問再裝**：macOS 用 `brew install --cask google-chrome`，或請 QA 從 https://www.google.com/chrome 安裝。

### 5. Chrome 企業政策

如果 IT 用政策禁止遠端除錯，TDT 開得出 Chrome 但連不上。

- macOS：`defaults read /Library/Managed\ Preferences/com.google.Chrome RemoteDebuggingAllowed 2>/dev/null; defaults read com.google.Chrome RemoteDebuggingAllowed 2>/dev/null`
- Linux：`grep -rs RemoteDebuggingAllowed /etc/opt/chrome/policies/`
- Windows：`reg query HKLM\SOFTWARE\Policies\Google\Chrome /v RemoteDebuggingAllowed`
- 值是 `0` 或 `false`：❌ **不能自己繞過**。請 QA 找 IT，對這台電腦開放 `RemoteDebuggingAllowed`。後面跟 Chrome 有關的項目全部略過。
- 也可以請 QA 在任一個 Chrome 打開 `chrome://policy` 確認。

### 6. CDP port（`<PORT>`）

```bash
curl -s --max-time 2 http://127.0.0.1:<PORT>/json/version
lsof -nP -iTCP:<PORT> -sTCP:LISTEN      # Windows: netstat -ano | findstr :<PORT>
ps -o pid,command -p <PID>             # Windows: tasklist /FI "PID eq <PID>"
```

- **沒人用**：✅ 正常。tdt 第一次被呼叫時會自己開 Chrome。
- **被 TDT 的 Chrome 占用**（指令裡有 `--user-data-dir=<PROFILE>`）：✅ 正常。
- **被其他程式占用**：❌ 回報程式名稱和 PID，然後讓 QA 選：
  1. 關掉那個程式（**先問**）。
  2. 改用其他 port：`TDT_CDP_URL` 和 `.mcp.json` 裡 playwright 的 `--cdp-endpoint`、chrome-devtools 的 `--browserUrl` 要一起改（**先問**）。
- **TDT 的 Chrome 在跑，但 `/json/version` 沒回應**：Chrome 卡住了，可以**直接**關掉這個 PID，讓 tdt 下次重開。

### 7. profile 鎖定

Chrome 當掉後，可能會留下鎖定檔，導致下次打不開。

```bash
ls -la <PROFILE>/SingletonLock 2>/dev/null
ps -axo pid,command | grep -- '--user-data-dir=<PROFILE>' | grep -v grep
```

- 有 `SingletonLock`，但**沒有任何 Chrome 在用這個 profile**：**直接**刪掉 `SingletonLock`、`SingletonSocket`、`SingletonCookie`。
- 有 Chrome 在用：正常，不要動。

### 8. MCP server 和資料夾信任

先看你自己的工具清單裡有沒有 `mcp__tdt__tabs_context_mcp`（必要時用 ToolSearch 查）。playwright、chrome-devtools 也一樣檢查。

```bash
claude mcp list
```

| 看到的狀態 | 原因 | 處理 |
|---|---|---|
| 工具清單裡**有** mcp__tdt__* | 已連線 | ✅ |
| `Pending approval` | QA 還沒同意專案的 MCP server | 請 QA 重開 `claude`，在提示中**全部同意**。不能替 QA 同意 |
| `Failed` / `✘` | 啟動失敗 | 回頭看 #2、#3 的結果。都正常的話，請 QA 輸入 `/mcp`，選該 server 重新連線 |
| 工具都在，但每個工具都跳出授權詢問 | 資料夾沒有被信任，`.claude/settings.json` 沒生效 | 請 QA 重開 `claude`，在「信任這個資料夾」的提示中同意 |

信任狀態可以唯讀確認：`~/.claude.json` 裡 `projects["<目前路徑>"].hasTrustDialogAccepted`。**只能讀，不能改。**

### 9. playwright 和 chrome-devtools 套件

```bash
npx -y @playwright/mcp@0.0.83 --help >/dev/null && echo pw-ok
npx -y chrome-devtools-mcp@1.12.0 --help >/dev/null && echo cdt-ok
```

版本要跟 `.mcp.json` 裡寫的一致。失敗通常是網路或 proxy 擋了 npm，回報錯誤訊息即可，不要自己改 npm 設定。

### 10. 實際操作確認

只在 #8 確認 MCP 工具都在時才做：

1. `mcp__tdt__tabs_context_mcp(createIfEmpty: true)`：Chrome 沒開的話會自動開。
2. `mcp__tdt__navigate(url: "about:blank")`，接著 `mcp__tdt__computer(action: "screenshot", scale: 0.3)`。
3. `mcp__playwright__browser_tabs(action: "list")`：要看得到 tdt 的分頁。
4. `mcp__chrome-devtools__list_pages`：要看得到同一個分頁。
5. `mcp__tdt__tabs_close_mcp` 關掉剛剛開的分頁。

每一步都成功才算 ✅。哪一步失敗，就把錯誤訊息填進報告。

## 回報格式

| # | 檢查項目 | 狀態 | 說明／已做的處理 |
|---|---|---|---|
| 1 | 工作目錄 | ✅ | /Users/qa/tdt |
| 3 | tdt build | 🔧 已修復 | dist 不存在，已執行 npm install && npm run build |
| 6 | CDP port 9222 | ❌ | 被 PID 4321（python3 -m http.server 9222）占用，等你決定要關掉它還是改 port |

狀態用：✅ 正常、🔧 已修復、❌ 需要處理、⏭️ 略過（寫明因為哪一項）。

表格之後寫：
- **QA 接下來要做的事**：照順序列出，例如「1. 完全關掉 Claude Code 再重開 2. 在提示中同意三個 MCP server」。
- 修過任何東西、需要重開 Claude Code 或重新連 MCP 的話，**明確說出來**。
- 全部 ✅ 的話，說「TDT 可以用了」，並給一個試用指令，例如 `/tdt 打開 https://example.com 看看頁面上有什麼`。
