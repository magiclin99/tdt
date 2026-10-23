# TDT — Talk Driven Testing

用嘴 QA  
下載後，在本專案目錄開啟 Claude Code，說要測什麼，AI 就會在 **專用 Chrome** 裡操作。

## 初次設定

```bash
# 在你的 Terminal 介面中下載本專案
> git clone https://github.com/magiclin99/tdt.git

# 進到本專案目錄並啟動 Claude Code
# 會跳出兩個提示：**信任這個資料夾**、**啟用這個專案的 MCP server**，都要同意。
> cd tdt
> claude

# 在 Claude Code 中，讓 AI 自動安裝所需工具
cloude> /tdt-doctor
```

## 使用

在這個目錄開 `claude`，說要測什麼就好：

> /tdt 照 XXX 文件 測試 某某網站 

## 出問題時

輸入 `/tdt-doctor`，AI 會檢查並修好環境（Node.js、Chrome、MCP 連線…）。

## 功能比較表

tdt 跟兩套現成的 MCP（Playwright MCP、Chrome DevTools MCP）一起用，三套接同一個 Chrome。tdt 只補那兩套沒有或做得比較差的部分，其他交給它們。

| 功能 | tdt | Playwright MCP | Chrome DevTools MCP |
|---|---|---|---|
| 一次送多個動作 | ✅ | ❌ | ❌ |
| 只讀頁面純文字 | ✅ | ❌ | ❌ |
| 只列出可操作的元素 | ✅ | ❌ | ❌ |
| 截指定範圍放大 | ✅ | ⚠️ 只能截單一元素 | ⚠️ 只能截單一元素 |
| 三擊 | ✅ | ⚠️ 只有座標版 | ❌ |
| 點擊時按著 Shift、Cmd 等 | ✅ | ✅ | ❌ |
| 連按多個鍵、重複按 | ✅ | ⚠️ 一次一個鍵 | ⚠️ 不能重複 |
| 在指定位置用滾輪捲動 | ✅ | ⚠️ 要另外開功能 | ❌ |
| 處理 alert / confirm 對話框 | ✅ | ✅ | ✅ |
| 斷言、把操作錄成 Playwright 測試程式碼 | ➖ 交給 Playwright MCP | ✅ | ❌ |
| mock API、cookie 和 storage | ➖ 交給 Playwright MCP | ✅ | ❌ |
| console、network（含 header 和 body） | ➖ 交給 Chrome DevTools MCP | ✅ | ✅ |
| 效能、Lighthouse、CSS、調整視窗大小 | ➖ 交給 Chrome DevTools MCP | ⚠️ 部分 | ✅ |

✅ 有　⚠️ 部分　❌ 沒有　➖ 不自己做
