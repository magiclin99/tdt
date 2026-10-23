# TDT — Talk Driven Testing

用講的做網頁測試。在這個目錄開 Claude Code，說要測什麼，AI 就會在 **QA 專用 Chrome** 裡操作，回報「案例 / 預期 / 實際」的證據表格。

```
Claude Code ─┬─ tdt（自建：看、點、填、讀頁面、對話框、批次）──┐
             ├─ playwright（斷言、錄成測試程式碼、mock、storage）─┼─ CDP ─► QA 專用 Chrome（:9222，獨立 profile）
             └─ chrome-devtools（console、network、效能、視窗大小）─┘
```

## QA 使用方式

### 第一次

```bash
git clone https://github.com/magiclin99/tdt.git && cd tdt
(cd tdt-mcp && npm install && npm run build)
claude
```

第一次開 `claude` 時會出現兩個提示，**都要同意**：
1. **信任這個資料夾**。沒同意的話，`.claude/settings.json` 不會生效，每個工具都會跳出授權詢問，重疊的工具也不會被擋掉。
2. **啟用這個專案的三個 MCP server**（tdt、playwright、chrome-devtools）。

這是 Claude Code 的安全機制，必須由使用者本人同意一次。

接著在 Claude Code 裡輸入：

> /tdt 開瀏覽器

QA 專用 Chrome 會自動開起來（profile 在 `~/.tdt/chrome-profile`）。**在這個視窗手動登入一次測試帳號**，之後登入狀態會一直保留。

### 指定 Chrome profile

QA Chrome 裡可以建好幾個 Chrome 人物 profile（例如「QA」「Admin」），每個有自己的登入狀態。在指令裡講 profile 名稱就好：

> /tdt 用 QA profile 測 dev 的 Timeline

AI 會用 `node scripts/qa-chrome.mjs QA` 把 QA Chrome 切到那個 profile。也可以自己執行；不帶參數會列出所有 profile。

### 出問題時

在 Claude Code 裡輸入 `/tdt-doctor`。AI 會逐項檢查：Node.js、tdt 有沒有 build、Chrome、企業政策、CDP port、profile 鎖定、MCP 連線、資料夾信任，最後做一次實際操作確認。能安全修的會直接修（例如 build、清掉鎖定檔），其他的會說明原因和做法。

（Claude Code 有一個內建的 `/doctor`，是檢查 Claude Code 本身用的，跟這個不一樣。）

### 每次測試

在這個目錄開 `claude`，說要測什麼就好：

> /tdt 照 cases/02-archive.md 在 stage 跑回歸

> /tdt 測 stage 的搜尋頁，輸入特殊字元不能出錯，順便看 console 有沒有錯誤

> /tdt 把剛剛的登入流程錄成 Playwright 測試

測試案例放在 `cases/`，格式見 `.claude/skills/tdt/SKILL.md`。可以先用 `cases/00-testbench-smoke.md` 試跑。

## 設定（環境變數）

| 變數 | 預設 | 說明 |
|---|---|---|
| `TDT_ALLOWED_ORIGINS` | （不限制） | 允許的網址，用逗號分隔，可用 `*`，例如 `https://*.stage.example.com,http://localhost:*`。白名單外的網址會被 tdt 擋下，頁面內自己跳轉過去也會被導回 about:blank |
| `TDT_CHROME_ARGS` | `--window-size=1600,1000` | 自動開 Chrome 時額外帶的參數 |
| `TDT_CDP_URL` | `http://127.0.0.1:9222` | QA Chrome 的 CDP 位址。改這個的話，`.mcp.json` 裡另外兩個 server 的位址也要一起改 |
| `TDT_PROFILE_DIR` | `~/.tdt/chrome-profile` | QA Chrome 的 profile 目錄 |
| `TDT_CHROME_PATH` | 依作業系統的預設路徑 | Chrome 執行檔位置 |
| `TDT_AUTO_LAUNCH` | `1` | 設成 `0` 就不自動開 Chrome |
| `TDT_UPLOAD_ROOTS` | 專案目錄 | `file_upload` 只能上傳這些目錄底下的檔案，用逗號分隔 |
| `TDT_OUTPUT_DIR` | `./tdt-output` | 截圖存檔的位置 |

## 檔案

| 路徑 | 內容 |
|---|---|
| `scripts/qa-chrome.mjs` | 用指定的 Chrome profile 開 QA Chrome（見「指定 Chrome profile」） |
| `tdt-mcp/` | 自建的 MCP server（TypeScript，用 Playwright 的 `connectOverCDP` 連 Chrome） |
| `tdt-mcp/test/verify.mjs` | 自建 MCP 的 73 個端對端驗證案例 |
| `tdt-mcp/test/verify-trio.mjs` | 三個 server 共用同一個 Chrome 的 18 個整合驗證案例 |
| `.mcp.json` | 註冊三個 MCP server |
| `.claude/settings.json` | 自動啟用 server、預先允許工具，並擋掉重疊的工具 |
| `.claude/skills/tdt/SKILL.md` | 給 AI 的分工規則、流程和回報格式 |
| `.claude/skills/tdt-doctor/SKILL.md` | 環境診斷與自動修復（`/tdt-doctor`） |
| `cases/` | 測試案例和已知問題 |
| `testbench/` | 驗證用的本機測試頁 |
| `evals/` | agent 評測：10 個 QA 任務交給全新的 Claude Code session 執行，對照預埋 bug 的答案卷評分（見 `evals/README.md`） |
| `mcp_tech_spec.md`、`mcp_tool_verification.md`、`mcp_comparison.md` | 前期研究：Claude in Chrome 的規格、實測結果，以及跟現成 MCP 的比對 |

## 開發與驗證

```bash
cd testbench && python3 -m http.server 8765 --bind 127.0.0.1   # 另開一個 shell
cd tdt-mcp && npm run build
node test/verify.mjs         # 結果寫到 test/last-run.md
node test/verify-trio.mjs    # 結果寫到 test/last-run-trio.md
```

驗證腳本會用獨立的 port（9333、9335）和暫存 profile 自己開 Chrome，不會動到 QA 正在用的 Chrome。

## tdt 的工具

工具介面沿用 Claude in Chrome 的設計，因為這套介面最適合 AI 操作。只在現成 MCP 做不到、或做得比較差的地方才自己實作。

| 工具 | 為什麼自己做 |
|---|---|
| `computer` | 截圖加座標操作的完整一套：點擊（左鍵、右鍵、雙擊、三擊）可按修飾鍵、hover、拖曳、type、key（多鍵、repeat）、捲動、zoom 截指定區域、wait。截圖像素就是點擊座標 |
| `read_page` / `get_page_text` | 可以只列互動元素、ref 跨呼叫保持穩定（Haiku subagent 找到的 ref 能直接用）、可以只讀純文字 |
| `form_input` / `file_upload` | 用 read_page 的 ref 操作。ref 只在 tdt 裡有效，所以這兩個也要自己做 |
| `handle_dialog` | 對話框只能由 tdt 自己的連線接手，否則會被自動按掉 |
| `browser_batch` | 現成的 MCP 都沒有，可以一次送多個動作，省掉來回 |
| `tabs_*` / `navigate` | 基礎建設。bfcache 下的上一頁／下一頁也正常 |

沒做的部分（多台瀏覽器切換、shortcuts、GIF、console、network、resize、自然語言 find）交給 Playwright 或 DevTools，或改用 Haiku subagent。

## 已知限制

- **手機裝置模擬**：由 CDT `emulate` 的 viewport 參數設定時，tdt 的截圖和座標會對不上（多個 CDP client 共用的限制）。響應式測試請用 CDT 的 `resize_page`。
- **iframe**：`read_page` 不會進到 iframe 裡面，iframe 內的元素要用截圖加座標操作。
- **網域白名單不是安全邊界**：tdt 擋得住自己的 navigate，也會把頁面內的跳轉導回去，但 Playwright 和 DevTools 的 navigate 工具是靠權限設定擋掉的。
