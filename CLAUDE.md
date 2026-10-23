# TDT 開發須知

TDT（Talk Driven Testing）讓 QA 在 Claude Code 裡用講的做網頁測試：AI 透過三個 MCP server 操作同一個 QA 專用 Chrome，回報「案例 / 預期 / 實際」的證據表格。

`README.md` 是給 QA 看的，只放安裝和使用方式，越精簡越好。架構、實作細節、開發流程寫在這裡。

這個 repo 是**工具**。QA 的測試案例和已知問題是他們自己的文件，不放進 repo。skill 不規定 QA 怎麼放、怎麼寫這些文件，也不做假設；QA 需要什麼，會自己告訴 AI。

## 架構

```
Claude Code ─┬─ tdt（自建：看、點、填、讀頁面、對話框、批次）──┐
             ├─ playwright（斷言、錄成測試程式碼、mock、storage）─┼─ CDP ─► QA 專用 Chrome（:9222，獨立 profile）
             └─ chrome-devtools（console、network、效能、視窗大小）─┘
```

- 三個 server 都在 `.mcp.json` 註冊，連同一個 CDP 位址。
- `.claude/settings.json` 自動啟用這三個 server、預先允許工具，並用 `deny` 擋掉 playwright / chrome-devtools 跟 tdt 重疊的工具（navigate、click、截圖等），讓 AI 只用 tdt 做這些事。資料夾沒被信任時這個檔案不會生效。
- AI 的分工規則、流程和回報格式在 `.claude/skills/tdt/SKILL.md`；環境診斷與修復在 `.claude/skills/tdt-doctor/SKILL.md`。

## 檔案

| 路徑 | 內容 |
|---|---|
| `tdt-mcp/` | 自建的 MCP server（TypeScript，用 Playwright 的 `connectOverCDP` 連 Chrome） |
| `tdt-mcp/src/browser.ts` | CDP 連線、自動開 Chrome、TDT 自己的 tab 管理、網域白名單、對話框 |
| `tdt-mcp/src/tools.ts` | 工具實作（computer、截圖、鍵盤…） |
| `tdt-mcp/src/page-scripts.ts` | 注入頁面的 script（read_page 的 ref、表單操作） |
| `tdt-mcp/test/verify.mjs` | 自建 MCP 的 73 個端對端驗證案例 |
| `tdt-mcp/test/verify-trio.mjs` | 三個 server 共用同一個 Chrome 的 18 個整合驗證案例 |
| `scripts/qa-chrome.mjs` | 用指定的 Chrome profile 開 QA Chrome；不帶參數列出所有 profile |
| `testbench/` | 驗證用的本機測試頁；`smoke.md` 是 tdt 自己的冒煙測試案例 |
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

## 環境變數

| 變數 | 預設 | 說明 |
|---|---|---|
| `TDT_ALLOWED_ORIGINS` | （不限制） | 允許的網址，用逗號分隔，可用 `*`，例如 `https://*.stage.example.com,http://localhost:*`。白名單外的網址會被 tdt 擋下，頁面內自己跳轉過去也會被導回 about:blank |
| `TDT_CHROME_ARGS` | `--window-size=1600,1000` | 自動開 Chrome 時額外帶的參數 |
| `TDT_CDP_URL` | `http://127.0.0.1:9222` | QA Chrome 的 CDP 位址。改這個的話，`.mcp.json` 裡另外兩個 server 的位址也要一起改 |
| `TDT_PROFILE_DIR` | `~/.tdt/chrome-profile` | QA Chrome 的 profile 目錄 |
| `TDT_CHROME_PATH` | 依作業系統的預設路徑 | Chrome 執行檔位置 |
| `TDT_AUTO_LAUNCH` | `1` | 設成 `0` 就不自動開 Chrome |
| `TDT_UPLOAD_ROOTS` | 專案目錄 | `file_upload` 只能上傳這些目錄底下的檔案，用逗號分隔 |
| `TDT_OUTPUT_DIR` | `./tdt-output` | 截圖存檔的位置（只有 `save_to_disk: true` 才存；平常截圖只回傳給 AI，不落地） |

## 已知限制

- **手機裝置模擬**：由 CDT `emulate` 的 viewport 參數設定時，tdt 的截圖和座標會對不上（多個 CDP client 共用的限制）。響應式測試請用 CDT 的 `resize_page`。
- **iframe**：`read_page` 不會進到 iframe 裡面，iframe 內的元素要用截圖加座標操作。
- **網域白名單不是安全邊界**：tdt 擋得住自己的 navigate，也會把頁面內的跳轉導回去，但 Playwright 和 DevTools 的 navigate 工具是靠 `.claude/settings.json` 的權限設定擋掉的。
