# Claude in Chrome MCP — 技術規格

> 資料來源：Claude Code session 中 `claude-in-chrome` MCP server 實際暴露的 tool schema（2026-10-22 擷取），以及本機的 Native Messaging 設定檔。
> 標示「（推測）」的段落是依架構知識推論，未在本機驗證。

---

## 1. 架構總覽

```
Claude（模型）
  │  MCP tool call（mcp__claude-in-chrome__*）
  ▼
Claude Code CLI ── 內建 MCP server「claude-in-chrome」
  │  本機 Unix socket：/tmp/claude-mcp-browser-bridge-<user>/<pid>.sock
  ▼
Native Host 程序：claude --chrome-native-host
  │  stdin/stdout，Chrome Native Messaging（4-byte 長度前綴 + JSON）
  ▼
Chrome 擴充功能 Claude in Chrome（ID: fcoeoabgfenejglbffodgkkbkcdhcgfn）
  │  chrome.debugger（CDP）／chrome.tabs／content script（推測）
  ▼
使用者自己的 Chrome profile 中的分頁（沿用登入狀態與 cookie）
```

### 1.1 Native Messaging 註冊

檔案：`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.anthropic.claude_code_browser_extension.json`

```json
{
  "name": "com.anthropic.claude_code_browser_extension",
  "description": "Claude Code Browser Extension Native Host",
  "path": "~/.claude/chrome/chrome-native-host",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/"]
}
```

`chrome-native-host` 的內容：

```sh
#!/bin/sh
exec ~/.local/bin/claude --chrome-native-host
```

同一個目錄還有 `com.anthropic.claude_browser_extension.json`，指向 `/Applications/Claude.app/Contents/Helpers/chrome-native-host`。這份給 Claude 桌面 App 用。

### 1.2 核心概念

| 概念 | 說明 |
|---|---|
| **MCP Tab Group** | 每個 session 只能操作自己的 Chrome 分頁群組。幾乎每個工具都要帶 `tabId`，而且這個分頁必須在該群組內。 |
| **tabId** | Chrome 的分頁 ID（number），由 `tabs_context_mcp` 或 `tabs_create_mcp` 取得。 |
| **ref** | 元素參考 ID（如 `ref_1`），由 `read_page` / `find` 產生，可給 `computer`、`form_input`、`file_upload`、`upload_image` 使用。 |
| **座標系** | 用截圖上的座標（實測截圖是 1492×812，viewport 是 1512×823），工具會自動換算成 viewport 座標。截圖縮放（`scale`）時，座標仍以全解析度截圖為準。 |
| **權限** | 依網站逐一授權，在擴充功能內設定。導到未授權的網域時，工具會失敗。 |
| **多瀏覽器** | 同一帳號可以連多個 Chrome 實例，用 deviceId 區分。 |

---

## 2. 工具清單

共 22 個工具，依用途分 8 類。

| 類別 | 工具 |
|---|---|
| 瀏覽器連線 | `list_connected_browsers`、`select_browser`、`switch_browser` |
| 分頁管理 | `tabs_context_mcp`、`tabs_create_mcp`、`tabs_close_mcp` |
| 導航／視窗 | `navigate`、`resize_window` |
| 互動（滑鼠鍵盤截圖） | `computer` |
| 頁面讀取 | `read_page`、`find`、`get_page_text` |
| 表單／上傳 | `form_input`、`file_upload`、`upload_image` |
| 除錯 | `javascript_tool`、`read_console_messages`、`read_network_requests` |
| 錄製／批次／捷徑 | `gif_creator`、`browser_batch`、`shortcuts_list`、`shortcuts_execute` |

---

## 3. 工具詳細規格

### 3.1 瀏覽器連線

#### `list_connected_browsers`
列出目前帳號下所有已連線的 Chrome（擴充功能實例）。

- **參數**：無
- **回傳**：每個瀏覽器的 `deviceId`、顯示名稱、OS platform、`isLocal`（OS 與本機相同，只能當弱提示）、`onThisComputer`（已知時才有）、`inUse`（本 session 目前操作的瀏覽器）
- **備註**：只連一台、或已經選過時不需要呼叫。工具回報「多台已連線但未選擇」時，才需要讓使用者挑選。

#### `select_browser`
| 參數 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `deviceId` | string | ✅ | 取自 `list_connected_browsers` |

指定要操作的瀏覽器，不會發送配對請求。

#### `switch_browser`
- **參數**：無
- 對所有裝了擴充功能的 Chrome 發出連線請求，最多等 2 分鐘，讓使用者在要用的那台按「Connect」，按的時候可以替瀏覽器命名。

---

### 3.2 分頁管理

#### `tabs_context_mcp`
取得本 session 的 MCP 分頁群組資訊，回傳群組內所有 tabId。**操作其他工具前至少要先呼叫一次。**

| 參數 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `createIfEmpty` | boolean | | 群組不存在時，開一個新視窗，內含新群組和一個空分頁。群組已存在時沒有作用。 |

#### `tabs_create_mcp`
- **參數**：無
- 在 MCP 群組中新增一個空分頁。自己開的分頁要自己用 `tabs_close_mcp` 關掉。

#### `tabs_close_mcp`
| 參數 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `tabId` | integer | ✅ | 必須在本 session 的群組內 |

關掉群組的最後一個分頁時，Chrome 會自動移除該群組。下次用 `createIfEmpty` 會從頭建立。

---

### 3.3 導航／視窗

#### `navigate`
| 參數 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `url` | string | ✅ | 網址，沒寫協定時預設 `https://`。也可以填 `"back"` / `"forward"` 操作歷史紀錄。 |
| `tabId` | number | | 單獨呼叫且是一般網址時可以省略：系統會自動呼叫 `tabs_context_mcp{createIfEmpty:true}`，導航群組中的第一個分頁，並把分頁清單附在回傳裡。`back`/`forward`、或在 `browser_batch` 內使用時**必填**。 |

#### `resize_window`
| 參數 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `width` | number | ✅ | 視窗寬（px） |
| `height` | number | ✅ | 視窗高（px） |
| `tabId` | number | ✅ | 用來找出所屬視窗 |

常用於 RWD 測試。

---

### 3.4 互動：`computer`

用滑鼠、鍵盤操作頁面，以及截圖。

#### 參數

| 參數 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `action` | enum | ✅ | 見下表 |
| `tabId` | number | ✅ | 目標分頁 |
| `coordinate` | [x, y] | 視 action | 點擊、捲動的位置；`left_click_drag` 的終點；`hover` 的位置 |
| `start_coordinate` | [x, y] | 視 action | `left_click_drag` 的起點 |
| `ref` | string | 視 action | `scroll_to` 必填；點擊類 action 可以用來取代 `coordinate` |
| `text` | string | 視 action | `type` 要輸入的文字；`key` 要按的鍵，以空白分隔多個鍵 |
| `repeat` | number 1–100 | | `key` 重複次數，預設 1 |
| `modifiers` | string | | 點擊時的修飾鍵：`ctrl`/`shift`/`alt`/`cmd`(`meta`)/`win`，可以用 `+` 組合 |
| `scroll_direction` | enum | 視 action | `up`/`down`/`left`/`right` |
| `scroll_amount` | number 1–10 | | 滾輪格數，預設 3 |
| `duration` | number 0–10 | 視 action | `wait` 秒數 |
| `region` | [x0,y0,x1,y1] | 視 action | `zoom` 擷取的區域 |
| `scale` | number 0.1–1 | | 只用於 `screenshot`/`zoom`，回傳圖片的縮放比例，越小越省 token。需要較新版的擴充功能。 |
| `save_to_disk` | boolean | | 只用於 `screenshot`/`zoom`，存檔並回傳路徑，方便附給使用者 |
| `action_summary` | string | 建議 | 一句話描述這個動作的效果。點擊類、拖曳、`key`、`type` 都應該填，內容不能含機密。 |

#### Action 一覽

| action | 必要參數 | 說明 |
|---|---|---|
| `screenshot` | — | 擷取目前 viewport |
| `zoom` | `region` | 擷取指定區域來放大檢視 |
| `left_click` | `coordinate` 或 `ref` | 左鍵點擊 |
| `right_click` | `coordinate` 或 `ref` | 右鍵（開啟 context menu） |
| `double_click` | `coordinate` 或 `ref` | 雙擊 |
| `triple_click` | `coordinate` 或 `ref` | 三擊（選取整行或整段） |
| `left_click_drag` | `start_coordinate`、`coordinate` | 拖曳 |
| `hover` | `coordinate` 或 `ref` | 移動游標但不點擊，用來觸發 tooltip 或下拉選單 |
| `type` | `text` | 輸入文字 |
| `key` | `text` | 按鍵或快捷鍵，例如 `"Enter"`、`"cmd+a"`、`"Backspace Backspace"`。**不支援**頁面縮放快捷鍵（`cmd+=` 等），請改用 `zoom`。 |
| `scroll` | `coordinate`、`scroll_direction` | 在指定位置捲動 |
| `scroll_to` | `ref` | 把元素捲進可視範圍 |
| `wait` | `duration` | 等待，最多 10 秒 |

#### 範例
```json
{"action":"left_click","coordinate":[320,180],"tabId":123,"action_summary":"Opens the Filters menu"}
{"action":"key","text":"cmd+a","tabId":123,"action_summary":"Selects all text in the field"}
{"action":"screenshot","tabId":123,"scale":0.5}
```

---

### 3.5 頁面讀取

#### `read_page`
取得頁面的 accessibility tree，並為元素產生 `ref`。

| 參數 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `tabId` | number | ✅ | |
| `filter` | enum | | `"interactive"`：只回傳按鈕、連結、輸入框；`"all"`（預設）：所有元素，包含看不見的 |
| `depth` | number | | 最大深度，預設 15 |
| `ref_id` | string | | 只讀這個元素及其子樹 |
| `max_chars` | number | | 輸出上限，預設 50000 字元。超過時在行邊界截斷，並註明完整大小。 |

#### `find`
用自然語言找元素，例如「搜尋框」、「登入按鈕」、「含 organic 的商品標題」。

| 參數 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `query` | string | ✅ | 自然語言描述 |
| `tabId` | number | ✅ | |

文件寫最多回傳 20 個符合的元素，每個都附 `ref`，超過時會提示改用更精確的描述。實測最多只顯示 18 筆。

#### `get_page_text`
| 參數 | 型別 | 必填 |
|---|---|---|
| `tabId` | number | ✅ |

擷取純文字，以文章主體優先。適合閱讀文章或部落格這類文字為主的頁面。

---

### 3.6 表單／上傳

#### `form_input`
用 ref 直接設定表單值，不必模擬打字。

| 參數 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `ref` | string | ✅ | 來自 `read_page` |
| `value` | string \| boolean \| number | ✅ | checkbox 用 boolean；select 用 option 的 value 或文字 |
| `tabId` | number | ✅ | |
| `action_summary` | string | 建議 | 效果描述 |

#### `file_upload`
把本機檔案直接塞進 `<input type="file">`。**不要去點上傳按鈕**，那會開出看不到也操作不了的原生檔案選擇器。

| 參數 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `paths` | string[] | ✅ | 絕對路徑，只限使用者已分享給 session 的檔案 |
| `ref` | string | ✅ | file input 的 ref |
| `tabId` | number | ✅ | |

限制：單次呼叫的檔案合計須小於 10 MB。

#### `upload_image`
把 `computer` 剛截的圖上傳到 file input，或拖放到頁面上，例如 Google Docs。

| 參數 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `imageId` | string | ✅ | 截圖 ID，幾分鐘後過期。不接受使用者附加的圖片。 |
| `tabId` | number | ✅ | |
| `ref` | string | 二選一 | 目標元素，可以是隱藏的 file input |
| `coordinate` | [x, y] | 二選一 | 拖放位置 |
| `filename` | string | | 預設 `image.png` |

失敗後不要重用同一個 imageId，要重拍再試，而且最多重試一次。

---

### 3.7 除錯

#### `javascript_tool`
在頁面 context 執行 JS。

| 參數 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `action` | string | ✅ | 固定是 `"javascript_exec"` |
| `text` | string | ✅ | 程式碼。採 REPL 語意：可以直接在最上層寫 `await`，最後一個運算式的值會自動回傳，不需要寫 `return`。 |
| `tabId` | number | ✅ | |

可以存取 DOM、`window` 和頁面變數，也可以呼叫頁面函式。有拋出錯誤時會回傳該錯誤。

```js
await fetch('/api/me').then(r => r.json())
```

#### `read_console_messages`
| 參數 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `tabId` | number | ✅ | |
| `pattern` | string | 強烈建議 | 用 regex 過濾，例如 `"error\|warning"`、`"\\[MyApp\\]"` |
| `onlyErrors` | boolean | | 只回傳 error 和 exception |
| `limit` | number | | 預設 100 |
| `clear` | boolean | | 讀完就清掉，避免下次重複 |

只回傳目前網域的訊息。

#### `read_network_requests`
| 參數 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `tabId` | number | ✅ | |
| `urlPattern` | string | | URL 子字串過濾，例如 `/api/` |
| `limit` | number | | 預設 100 |
| `clear` | boolean | | 讀完就清掉 |

涵蓋 XHR、Fetch、document、image 等請求，包含跨域請求。**頁面導到不同網域時紀錄會自動清除。**

> **實測**：從第一次呼叫這個工具才開始收集。回傳只有 url、method、statusCode，沒有 header 和 body。`clear` 會清掉全部紀錄，不只符合 urlPattern 的那幾筆。

---

### 3.8 錄製／批次／捷徑

#### `gif_creator`
錄下操作過程並匯出成 GIF。

| 參數 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `action` | enum | ✅ | `start_recording` / `stop_recording` / `export` / `clear` |
| `tabId` | number | ✅ | 用來決定作用的分頁群組 |
| `download` | boolean | | 只用於 `export`，應該設 `true`，讓瀏覽器下載 GIF |
| `filename` | string | | 只用於 `export`，預設 `recording-[timestamp].gif` |
| `options` | object | | 只用於 `export`，見下表 |

| options 欄位 | 預設 | 說明 |
|---|---|---|
| `showClickIndicators` | true | 在點擊位置畫橘色圓圈 |
| `showDragPaths` | true | 拖曳時畫紅色箭頭 |
| `showActionLabels` | true | 黑底的動作說明標籤 |
| `showProgressBar` | true | 底部橘色進度條 |
| `showWatermark` | true | Claude logo 浮水印 |
| `quality` | 10 | 1–30，數字越小畫質越好、編碼越慢 |

建議流程：`start_recording` → 立刻 `screenshot`（第一格）→ 操作 → `screenshot`（最後一格）→ `stop_recording` → `export`。

> **實測（見 mcp_tool_verification.md）**：工具說明提到 export 可以用 `coordinate` 拖放到頁面，但 schema 裡沒有這個參數，實際上只能用 `download:true`。錄影上限是 50 格，export 完會自動清空。

#### `browser_batch`
一次 round trip 依序執行多個工具。

| 參數 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `actions` | `{name, input}[]` | ✅ | `name` 是工具短名（如 `computer`、`navigate`），`input` 和單獨呼叫時相同 |

行為：
- **依序**執行，不是平行；遇到第一個錯誤就停。
- 每一項都會各自檢查權限。如果某個動作導到沒有授權的網域，下一項會失敗，批次就此中止。
- 截圖會穿插在結果中回傳。批次裡寫的座標，以**呼叫前**最後一張截圖為準。
- 不能巢狀使用。批次內的 `navigate` 必須帶 `tabId`。

```json
{"actions":[
  {"name":"navigate","input":{"url":"https://example.com","tabId":123}},
  {"name":"computer","input":{"action":"left_click","coordinate":[400,120],"tabId":123,"action_summary":"Focuses the search box"}},
  {"name":"computer","input":{"action":"type","text":"hello","tabId":123,"action_summary":"Types the query"}},
  {"name":"computer","input":{"action":"key","text":"Enter","tabId":123,"action_summary":"Submits the search"}},
  {"name":"computer","input":{"action":"screenshot","tabId":123}}
]}
```

#### `shortcuts_list`
| 參數 | 型別 | 必填 |
|---|---|---|
| `tabId` | number | ✅ |

列出擴充功能中使用者定義的 shortcut／workflow（兩者可以互換）。回傳 command、描述，以及是否為 workflow。

#### `shortcuts_execute`
| 參數 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `tabId` | number | ✅ | |
| `shortcutId` | string | | shortcut ID |
| `command` | string | | command 名稱，不含開頭的 `/` |

在新的 sidepanel 視窗中，以目前分頁執行 shortcut。**呼叫後立即返回，不會等執行完成。**

---

## 4. 典型使用流程

```
tabs_context_mcp(createIfEmpty)  →  tabs_create_mcp
        │
        ▼
navigate(url)
        │
        ▼
screenshot / read_page(filter=interactive) / find("...")
        │   取得座標或 ref
        ▼
computer(left_click / type / key) 或 form_input(ref, value)
        │
        ▼
screenshot 驗證結果 ──（迴圈）
        │
        ▼
read_console_messages / read_network_requests（除錯時）
        │
        ▼
tabs_close_mcp（清理自己開的分頁）
```

## 5. 限制與注意事項

| 項目 | 限制 |
|---|---|
| `wait` | 每次最多 10 秒 |
| `key.repeat` | 1–100 |
| `scroll_amount` | 1–10 |
| `find` | 最多回傳 20 筆 |
| `read_page` | 預設 50000 字元、深度 15 |
| `file_upload` | 單次合計小於 10 MB，只限已分享給 session 的檔案 |
| `upload_image` | 截圖 ID 幾分鐘內過期，不接受使用者附加的圖片 |
| console / network | console 只回傳目前網域；network 在換網域時自動清空 |
| 頁面縮放快捷鍵 | 不支援，改用 `zoom` |
| 原生對話框 | `alert`/`confirm`/`prompt` 會卡住擴充功能，應避免觸發 |
| 原生檔案選擇器 | 看不到也操作不了，改用 `file_upload` |
| 分頁範圍 | 只能操作本 session MCP 群組內的分頁 |
| 網站權限 | 依網站在擴充功能內授權 |
