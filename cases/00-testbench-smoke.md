# TDT 冒煙測試（testbench）

環境：`http://127.0.0.1:8765/`，要先在 `testbench/` 目錄執行 `python3 -m http.server 8765 --bind 127.0.0.1`
前提：無需登入。右側黑色的 EVENT LOG 會記錄每個事件，用來判定結果。

| ID | 步驟 | 預期 |
|---|---|---|
| SMOKE-01 | 點「Left Button」 | EVENT LOG 出現 `left_click btnL mods=none` |
| SMOKE-02 | 按住 Shift 點「Modifier Button」 | 出現 `click btnMod mods=shift` |
| SMOKE-03 | 在 Name field 輸入「Hello 你好」 | 欄位值為 `Hello 你好` |
| SMOKE-04 | Color select 選 Blue、勾選 Agree checkbox | 出現 `change sel=b`、`change cb=true` |
| SMOKE-05 | 點「Confirm dialog」，先取消 | 出現 `confirm result=false` |
| SMOKE-06 | 再點一次「Confirm dialog」，這次按確定 | 出現 `confirm result=true` |
| SMOKE-07 | 點「Emit console」，到 DevTools 查 console | 看到 `[APP] error message`，附上 stack |
| SMOKE-08 | 點「Fetch data」，到 DevTools 查 network | `data.json?from=btn` 200、`missing-endpoint` 404，附上 data.json 的回應 body |
| SMOKE-09 | 用 Playwright 斷言頁面有 `PINEAPPLE-42` | 斷言通過 |
| SMOKE-10 | 錄製 SMOKE-01、SMOKE-03 的操作 | 產出包含 `getByRole('button', { name: 'Left Button' })` 的 Playwright 程式碼 |
| SMOKE-11 | 用 DevTools 把視窗改成 800×600，截圖 | 截圖約 800 寬，點「Left Button」仍然點得中 |
