# Claude in Chrome MCP — 實測驗證報告

- 日期：2026-10-22
- 環境：macOS、Chrome「Browser 1」（deviceId `6beb63a9-…`）、viewport 1512×823、DPR 2
- 測試頁：`testbench/index.html`，用 `python3 -m http.server 8765 --bind 127.0.0.1` 在本機提供。頁面右側有 event log，把每個 DOM 事件寫出來，作為判定依據。
- 錄影：`~/Downloads/mcp_tool_verification.gif`（50 格，9 MB）
- 對照規格：[mcp_tech_spec.md](mcp_tech_spec.md)

重跑方式：`cd testbench && python3 -m http.server 8765 --bind 127.0.0.1`，再請 Claude 照本報告逐項執行。

---

## 總結

| 工具 | 結果 | 備註 |
|---|---|---|
| list_connected_browsers | ✅ | |
| select_browser | ✅ | 不存在的 deviceId 會回明確錯誤 |
| switch_browser | ⚠️ 部分 | 只連了一台，所以立即回「沒有其他瀏覽器可以切換」，沒有進到等待 Connect 的流程 |
| tabs_context_mcp | ✅ | |
| tabs_create_mcp | ✅ | |
| tabs_close_mcp | ✅ | 群組外的 tabId 會被拒絕；關掉最後一個分頁時群組會自動移除 |
| navigate | ✅ | |
| resize_window | ❌ 與預期不符 | 回傳成功，但視窗尺寸沒有改變 |
| computer（13 種 action） | ✅ | Mac 上 ctrl+click 會變成右鍵，見下方 |
| read_page | ✅ | |
| find | ✅ | 實際最多只顯示 18 筆，不是文件寫的 20 筆 |
| get_page_text | ✅ | |
| form_input | ✅ | |
| file_upload | ✅ | |
| upload_image | ✅ | |
| javascript_tool | ✅ | |
| read_console_messages | ✅ | |
| read_network_requests | ✅ | |
| gif_creator | ⚠️ 與文件不符 | `export` 不能用 coordinate，只能 download |
| browser_batch | ✅ | |
| shortcuts_list | ✅ | 帳號沒有任何 shortcut，回空陣列 |
| shortcuts_execute | ⚠️ 部分 | 沒有 shortcut 可以跑，只驗證了「找不到」的錯誤路徑 |

---

## 詳細結果

### 瀏覽器連線

| 呼叫 | 實際結果 |
|---|---|
| `list_connected_browsers()` | `[{"deviceId":"6beb63a9-…","name":"Browser 1","osPlatform":"macOS","connectedAt":…,"isLocal":true,"inUse":true}]`。這次沒有回 `onThisComputer` 欄位，文件說「已知時才有」，符合。 |
| `select_browser(正確 deviceId)` | `Selected browser "Browser 1".` |
| `select_browser("0000…")` | 錯誤：`No connected browser has deviceId …` |
| `switch_browser()` | `No other browsers available to switch to.` 立即返回，沒有等 2 分鐘。 |

### 分頁管理

| 呼叫 | 實際結果 |
|---|---|
| `tabs_context_mcp()`（沒有群組時） | 回提示文字，要求使用 `createIfEmpty: true`，**不會**自動建立群組 |
| `tabs_context_mcp(createIfEmpty:true)` | 開新視窗和群組，內含一個 `chrome://newtab/` 分頁，並回傳 `tabGroupId` |
| `tabs_create_mcp()` | `Created new tab. Tab ID: …` |
| `tabs_close_mcp(群組內)` | `Closed tab …. 1 tab(s) remain.` |
| `tabs_close_mcp(999)` | 錯誤：`Tab 999 is not in Claude's tab group…` |
| 關掉最後一個分頁 | `Group is now empty (auto-removed).` |
| 對已關閉的 tabId 呼叫 `computer` | 錯誤：`Couldn't determine which page this action targets.` |

### navigate

| 參數 | 結果 |
|---|---|
| `url:"http://127.0.0.1:8765/data.json"` | ✅ |
| `url:"back"` / `"forward"` | ✅ 用 `location.href` 確認確實回到上一頁、再前進 |
| `url:"example.com"`（沒寫協定） | ✅ 變成 `https://example.com/` |
| 不帶 `tabId`（單獨呼叫） | ✅ 自動執行 tabs_context，導航群組中的第一個分頁，並在回傳附上 tab context |

### resize_window ❌

`resize_window(800, 600)` 回傳 `Successfully resized window … to 800x600`，但前後的 `outerWidth/outerHeight` 都是 1512×823，截圖也沒有變化。
同時發現 outer 尺寸等於 inner 尺寸（1512×823），螢幕可用高度是 944，所以這個視窗可能處於某種無法調整大小的狀態，例如全螢幕。**結論：工具回報成功不代表視窗真的變了，需要用 JS 檢查 `innerWidth` 確認。**

### computer

| action | 參數組合 | event log 的實際結果 |
|---|---|---|
| left_click | `coordinate` | `left_click btnL mods=none` ✅ |
| left_click | `ref` | `left_click btnL mods=none` ✅ |
| left_click | `modifiers:"shift"` | `mods=shift` ✅ |
| left_click | `modifiers:"cmd+alt"` | `mods=alt+meta` ✅ |
| left_click | `modifiers:"ctrl+shift"` | ⚠️ **沒有觸發 click**。在 macOS 上 ctrl+click 等於右鍵，所以觸發的是 contextmenu，這是 OS 行為，不是工具 bug。 |
| right_click | `coordinate` | `right_click btnR`（contextmenu）✅ |
| double_click | | `double_click btnD` ✅ |
| triple_click | | 整段文字被選取 ✅ |
| hover | `coordinate` | `hover enter`，CSS `:hover` 的 tooltip 有出現 ✅ |
| left_click_drag | `start_coordinate` → `coordinate` | 有 mousedown 和 mouseup，`onDropTarget=true` ✅（只有 mouse 事件，未測 HTML5 DnD） |
| type | 中英混合加數字 `"Hello 你好 123"` | 每個字元各觸發一次 input 事件，中文正常 ✅ |
| key | `"cmd+a"` 接 `"Backspace"` | 全選後刪除 ✅ |
| key | `"Backspace"`、`repeat:3` | `abcdef` 變成 `abc` ✅ |
| key | `"ArrowLeft ArrowLeft x"`（空白分隔多鍵） | 變成 `axbc` ✅ |
| key | 在 body 上按 `"shift+a"`、`"Escape"` | keydown 帶有正確的修飾鍵 ✅ |
| key | `"cmd+="` | 被拒絕：`page zoom keyboard shortcuts are not supported`，符合文件 ✅ |
| scroll | `down`，預設 3 格 | scrollY 0 → 300（**1 格等於 100px**）✅ |
| scroll | `down`、`scroll_amount:10` | scrollY 300 → 1300 ✅ |
| scroll | `up`、`scroll_amount:5` | scrollY 1300 → 800 ✅ |
| scroll | `right`，在可水平捲動的容器上 | `scrollLeft=200` ✅ |
| scroll_to | `ref` | 元素被捲進畫面（top=753，viewport 高 823）✅ |
| wait | `duration` 1、0.5 | ✅ |
| screenshot | 不帶 scale | 1492×812 jpeg ✅ |
| screenshot | `scale:0.5` / `0.3` / `0.4` | 746×406 等，回傳中註明 `coordinate frame: 1492x812` ✅ |
| zoom | `region`，有帶和不帶 `scale` | ✅ |

**座標系驗證**：拖曳時要求的終點是 (100, 530)，頁面實際收到 (101, 537)。這等於截圖座標 1492×812 換算到 viewport 1512×823 的比例（×1.0134）。**所以座標應該用截圖上的座標，工具會自動換算成 viewport 座標。**

**其他觀察**：
- `scroll` 執行完會自動附一張截圖，不用另外呼叫 `screenshot`。
- 沒有測 `save_to_disk`。

### read_page / find / get_page_text

| 呼叫 | 結果 |
|---|---|
| `read_page(filter:"interactive")` | 14 個互動元素。`display:none` 的 file input **不在**清單中。 |
| `read_page()`，也就是 all | 包含隱藏元素：隱藏的 file input、`display:none` 的 tooltip 都出現 ✅ |
| `read_page(ref_id:"ref_16")` | 只回傳 article 這棵子樹 ✅ |
| `read_page(depth:2)` | 這個頁面結構很扁平，結果跟 all 幾乎一樣，限制深度的效果不明顯 |
| `read_page(max_chars:300)` | 截斷並提示 `truncated at 300 of 1463 characters` ✅ |
| `find("orange BOTTOM SECTION banner")` | 找到 1 筆，並說明 a11y tree 沒有顏色資訊 ✅ |
| `find("hidden file input")` | 找得到 `display:none` 的 input ✅ |
| `find("every element on the page")` | `Found 38 … (showing first 18)`。**實際上限是 18，不是 20。** |
| `get_page_text()` | `Source element: <article>`，只回傳 article 的內容，其他區塊被忽略 ✅ |

**ref 的生命週期**：導航之後 ref 會重新編號，舊的 ref 失效。

### form_input

| 目標 | value | 結果 |
|---|---|---|
| textarea | `"multi\nline note"` | 換行保留，有觸發 change ✅ |
| checkbox | `true` | `cb=true` ✅ |
| select | `"Green"`（option 文字） | `sel=g` ✅ |
| select | `"b"`（option value） | `sel=b` ✅ |
| number | `7`（number 型別） | `num=7` ✅ |

每次呼叫都會回傳前一個值，例如 `(previous: "r")`。

### file_upload / upload_image

| 呼叫 | 結果 |
|---|---|
| `file_upload`：2 個 scratchpad 內的檔案，傳到可見的 input | `sample.txt(13), data.json(28)` ✅ |
| `file_upload`：專案內的檔案，傳到 `display:none` 的 input | `mcp_tech_spec.md(16553)` ✅ |
| `file_upload`：`/etc/hosts` | 被拒絕：`only files this session is allowed to read can be uploaded… /add-dir` ✅ |
| `upload_image`：`ref` 指向隱藏的 input，`filename:"bench_shot.png"` | 檔名正確，62912 bytes ✅ |
| `upload_image`：`coordinate` 拖放到 drop zone | 觸發 drop 事件，檔名是預設的 `image.png` ✅ |

⚠️ `upload_image` 檔名是 `.png`，但 **MIME 是 `image/jpeg`**，因為截圖本身是 jpeg。如果伺服器會檢查 MIME，要注意這點。

### javascript_tool

| 程式碼 | 回傳 |
|---|---|
| `window.benchData.answer * 2` | `84` ✅ 可以讀頁面變數 |
| `await fetch('/data.json').then(r=>r.json())` | `{"ok":true,"user":"tester"}` ✅ 最上層可以直接 await |
| `document.querySelector('h1')` | `{}`。**DOM 節點會被序列化成空物件**，要取值請明確寫出屬性。 |
| `const x=1; let y=2; x+y` | `3` ✅ |
| `undefined` | `undefined` |
| `throw new Error(...)` | 回傳錯誤：`JavaScript execution error: Error: boom from bench at <anonymous>:1:8` |

### read_console_messages

| 參數 | 結果 |
|---|---|
| `pattern:"\\[APP\\]"` | log、warning、error 三筆，附時間和 `檔案:行:欄` ✅ |
| `onlyErrors:true` | 只有 error 那一筆 ✅ |
| `pattern:"BENCH", limit:3` | `Found 50 (showing first 3 of 50)` ✅ |
| `clear:true` 之後再讀 | `No console messages found` ✅ |

⚠️ **何時開始收集**：頁面載入時印出的 `loaded` 沒有被收到，最早的一筆是第一次操作工具之後才出現的。另外，網路 404 時瀏覽器自己印的 `Failed to load resource` **不會**被收進來。

### read_network_requests

| 參數 | 結果 |
|---|---|
| 第一次呼叫，之前已經發過 fetch | `No network requests found`。**從第一次呼叫這個工具才開始收集。** |
| 再發一次 fetch 後不帶參數讀取 | 3 筆：data.json 200、missing-endpoint 404、`data:` 200 |
| `urlPattern:"data.json"` | 1 筆 ✅ |
| `urlPattern` 搭配 `clear:true` 之後再讀 | 空。⚠️ **clear 會清掉全部紀錄，不只符合 pattern 的那幾筆。** |

回傳只有 `url / method / statusCode`，**沒有 header、body 和耗時**。

### gif_creator

| 呼叫 | 結果 |
|---|---|
| `start_recording` | `max 50 frames. Previous frames cleared.` |
| `stop_recording` | `Captured 50 frames.`，畫面在 50 格時就滿了 |
| `export` 搭配 `coordinate` | ❌ `coordinate parameter is required for export action (or set download: true …)`。**schema 裡根本沒有 coordinate 參數，所以拖放到頁面這條路用不了。** |
| `export`，`download:true`、`filename`、`options:{quality:20, showWatermark:false}` | ✅ 檔案落在 `~/Downloads`，9 MB，1568×812。**export 完就會自動清空錄影。** |
| `clear`，在 export 之後 | `No frames to clear`，符合自動清空的行為 |

### browser_batch

- 依序執行，每一項結果都標成 `[tool:action]` ✅
- 執行中某一項失敗時，例如 JS throw，前面已經完成的輸出會保留，並註明 `(5 completed, 0 remaining)`。
- ⚠️ **有些錯誤在執行前就會先檢查**：一個 batch 裡第 3 項是 `/etc/hosts` 上傳，結果整個 batch 只回了錯誤，前兩項也沒有執行，重送後才成功。
- 可以混用不同工具：navigate、computer、javascript_tool、form_input、read_page、find、file_upload、upload_image、read_console_messages、read_network_requests、get_page_text、resize_window 都在 batch 裡跑過。

### shortcuts

| 呼叫 | 結果 |
|---|---|
| `shortcuts_list` | `{"message":"No shortcuts found","shortcuts":[]}` |
| `shortcuts_execute(command:"nonexistent-test")` | `Shortcut not found. No shortcut with command "/nonexistent-test".` |

---

## 需要修正 mcp_tech_spec.md 的地方

1. `gif_creator`：export 只能用 `download:true`，coordinate 拖放在目前的 schema 上不可用。export 完會自動清空錄影，錄影上限是 50 格。
2. `find`：實際最多顯示 18 筆。
3. `read_console_messages` / `read_network_requests`：從第一次呼叫或工具接上分頁之後才開始收集。network 的 `clear` 會清掉全部紀錄。回傳欄位只有 url、method、status。
4. 座標系：使用截圖上的座標，工具會自動換算成 viewport 座標。
5. `scroll`：1 格等於 100px，執行後會自動附截圖。
6. `javascript_tool`：DOM 節點會回傳 `{}`。
7. `resize_window`：回傳成功不代表視窗真的改變了。
8. `browser_batch`：部分參數錯誤在執行前就會擋下，整批都不會執行。
9. `upload_image`：MIME 是 image/jpeg，跟檔名的副檔名無關。
10. macOS 上 `modifiers` 帶 `ctrl` 的左鍵點擊會變成右鍵。
