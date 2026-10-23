# 瀏覽器 MCP Server 工具比對

以 Claude in Chrome（簡稱 CiC）為基準，比對兩個現成方案：

| 代號 | 專案 | 工具數 | 來源 |
|---|---|---|---|
| CiC | Claude in Chrome（Claude Code 內建） | 22 | 實測，見 mcp_tool_verification.md |
| PW | [Playwright MCP](https://github.com/microsoft/playwright-mcp)（`@playwright/mcp`） | 24 個核心工具 + 1 個分頁工具，加上 `--caps` 可開的 47 個，共 72 | README |
| CDT | [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp)（Google） | 59，大部分預設開啟，部分需要 flag | docs/tool-reference.md |

> PW 和 CDT 的資料是 2026-10-22 讀官方文件整理的，**還沒有實測**。圖例：✅ 有　⚠️ 部分或有替代做法　❌ 沒有

---

## 1. 逐項比對 CiC 的功能

### 瀏覽器與分頁

| CiC 功能 | PW | CDT |
|---|---|---|
| list / select / switch browser（多台瀏覽器） | ❌，連單一瀏覽器（`--cdp-endpoint` 或 `--extension`） | ❌，連單一瀏覽器（`--browserUrl` 或 `--autoConnect`） |
| tabs_context / create / close | ✅ `browser_tabs`（list/new/close/select） | ✅ `list_pages` / `new_page` / `select_page` / `close_page` |
| navigate url | ✅ `browser_navigate` | ✅ `navigate_page` |
| navigate back | ✅ `browser_navigate_back` | ✅ `navigate_page type=back` |
| navigate forward | ❌ | ✅ `navigate_page type=forward`，還可以 reload |
| resize_window | ✅ `browser_resize` | ✅ `resize_page`，另有 `emulate viewport` |

### 互動（對應 CiC 的 `computer`）

| CiC action | PW | CDT |
|---|---|---|
| screenshot | ✅ `browser_take_screenshot`（fullPage、單一元素、scale） | ✅ `take_screenshot`（fullPage、單一元素、quality） |
| zoom（截指定區域） | ⚠️ 只能截單一元素，不能指定矩形範圍 | ⚠️ 只能截單一元素 |
| 用 ref 點擊 | ✅ `browser_click` | ✅ `click` |
| 用座標點擊 | ✅ `browser_mouse_click_xy`（需 `--caps=vision`） | ⚠️ `click_at`（需 `--experimentalVision`） |
| right_click | ✅ `button=right` | ❌ |
| double_click | ✅ `doubleClick` | ✅ `dblClick` |
| triple_click | ⚠️ 只有座標版可以：`mouse_click_xy clickCount=3` | ❌ |
| 點擊加修飾鍵 | ✅ `modifiers` | ❌ |
| hover | ✅ 元素版，另有座標版 `mouse_move_xy` | ✅ 元素版 |
| drag | ✅ 元素對元素，另有座標版 `mouse_drag_xy` | ⚠️ 只能元素對元素 |
| type | ✅ `browser_type`（可設 slowly、submit） | ✅ `type_text`（打進目前焦點）、`fill` |
| key（多個鍵、repeat） | ⚠️ `browser_press_key` 一次只能按一個鍵 | ⚠️ `press_key` 支援組合鍵，但沒有 repeat |
| scroll（指定座標和方向） | ⚠️ `browser_mouse_wheel`（需 vision） | ❌，只能用 JS 捲動 |
| scroll_to(ref) | ⚠️ 沒有獨立工具，對元素操作時會自動捲進畫面 | ⚠️ 同 PW |
| wait 秒數 | ✅ `browser_wait_for time`，也能等文字出現或消失 | ⚠️ `wait_for` 只能等文字出現 |

### 讀取頁面

| CiC | PW | CDT |
|---|---|---|
| read_page（a11y tree 加 ref） | ✅ `browser_snapshot`（depth、target） | ✅ `take_snapshot`（uid） |
| read_page `filter=interactive` | ❌ | ❌ |
| find（自然語言描述） | ⚠️ `browser_find` 只支援文字或 regex，不能用自然語言描述 | ❌ |
| get_page_text（只取文章主體的純文字） | ❌，要用 snapshot 或 evaluate | ❌，同左 |

### 表單與上傳

| CiC | PW | CDT |
|---|---|---|
| form_input | ✅ `browser_fill_form` / `browser_select_option` | ✅ `fill` / `fill_form` |
| file_upload | ✅ `browser_file_upload`，要先點開檔案選擇器，工具再回應它 | ✅ `upload_file(uid)` |
| upload_image（截圖拖放到頁面） | ✅ `browser_drop`（可以是檔案或 MIME 資料） | ❌ |

### 除錯

| CiC | PW | CDT |
|---|---|---|
| javascript_tool | ✅ `browser_evaluate`，另有會在 server 端執行程式碼的 `browser_run_code_unsafe` | ✅ `evaluate_script`，也能在 service worker 裡執行 |
| console（regex 過濾、只看 error） | ⚠️ `browser_console_messages` 可依 level 過濾，不能用 regex | ⚠️ `list_console_messages` 可依類型過濾、附 stack trace，不能用 regex |
| network 列表 | ✅ `browser_network_requests` | ✅ `list_network_requests` |
| network 單筆的 header 和 body | ✅ `browser_network_request` | ✅ `get_network_request` |

PW 和 CDT 都能看單筆請求的 header 和 body，這點比 CiC 強，CiC 只回傳 url、method、status。

### 錄製、批次、捷徑

| CiC | PW | CDT |
|---|---|---|
| gif_creator | ⚠️ 不能出 GIF，改用影片（`start_video`）和 trace，需 `--caps=devtools` | ⚠️ 不能出 GIF，改用 `screencast_start/stop` 錄影片 |
| browser_batch | ❌ | ❌ |
| shortcuts_list / execute | ❌ | ❌ |

---

## 2. 現成方案多出來、對 QA 有用的功能

| 功能 | PW | CDT | CiC |
|---|---|---|---|
| **處理 alert / confirm / prompt** | ✅ `browser_handle_dialog` | ✅ `handle_dialog` | ❌，遇到會整個卡住 |
| **把 AI 的操作轉成 Playwright 程式碼** | ✅ `start_recording` / `stop_recording`，產生可以放進回歸測試的程式碼 | ❌ | ❌ |
| **斷言** | ✅ `verify_element_visible` / `verify_text_visible` / `verify_value` / `verify_list_visible`，產生 locator（`--caps=testing`） | ❌ | ❌ |
| 攔截並 mock API | ✅ `browser_route`（`--caps=network`） | ❌ | ❌ |
| 模擬離線、網路限速 | ✅ 可切 offline | ✅ `emulate networkConditions`、CPU 降速 | ❌ |
| Cookie、localStorage、sessionStorage | ✅ 17 個工具，可以把登入狀態存檔再還原（`--caps=storage`） | ❌ | ❌ |
| 模擬裝置、深色模式、UA、地理位置 | ⚠️ `emulate_media` | ✅ `emulate` | ❌ |
| 效能 trace 和分析建議 | ⚠️ 只有 trace | ✅ `performance_*` | ❌ |
| Lighthouse 稽核 | ❌ | ✅ `lighthouse_audit` | ❌ |
| 查元素套用的 CSS | ❌ | ✅ `get_css_styles` | ❌ |
| 記憶體分析（heap snapshot） | ❌ | ✅ 14 個工具 | ❌ |
| 存成 PDF | ✅ `--caps=pdf` | ❌ | ❌ |

---

## 3. 安全控管

| 控管項目 | PW | CDT |
|---|---|---|
| 網域白名單 | `--allowed-origins` / `--blocked-origins`，**文件明說這不是安全邊界，也不檢查 redirect** | `--allowedUrlPattern`（需 Chrome 149+）、`--blockedUrlPattern` |
| 關閉 JS 執行 | ❌ | ✅ `--javascriptEvaluation=false` |
| 限制可存取的檔案目錄 | ⚠️ 用 `--output-dir` | ✅ `--filesystemRoot` |
| 遮蔽敏感 header | ❌ | ✅ `--redactNetworkHeaders` |
| 每次都用乾淨的 profile | ✅ `--isolated` | ✅ `--isolated` |

---

## 4. 缺口總結：兩個都沒有的 CiC 功能

| 缺口 | 影響 | 自己補的難度 |
|---|---|---|
| **browser_batch** | 每個動作都要多一次 round trip，比較慢，也多花 token | 中 |
| **get_page_text** | 讀長文章時只能拿整棵 snapshot，比較耗 token | 低，Readability 加 evaluate 就能做 |
| **自然語言 find** | 改讓模型自己讀 snapshot 找元素 | 中，而且要多花一次模型呼叫 |
| **read_page 只看互動元素** | snapshot 比較大 | 低 |
| **截指定矩形區域** | 看小字、小圖示比較不方便 | 低，CDP 的 `clip` 參數就能做 |
| **GIF** | 只能錄影片 | 低 |
| **多台瀏覽器切換** | QA 情境用不到 | 不需要 |
| **shortcuts** | QA 情境用不到 | 不需要 |
