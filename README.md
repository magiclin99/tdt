# TDT — Talk Driven Testing

用講的做網頁測試。在這個目錄開 Claude Code，說要測什麼，AI 就會在 **QA 專用 Chrome** 裡操作，回報「案例 / 預期 / 實際」的表格。

## 安裝（第一次）

```bash
git clone https://github.com/magiclin99/tdt.git && cd tdt
(cd tdt-mcp && npm install && npm run build)
claude
```

1. 開 `claude` 時會跳出兩個提示：**信任這個資料夾**、**啟用這個專案的 MCP server**，都要同意。
2. 在 Claude Code 輸入 `/tdt 開瀏覽器`，QA 專用 Chrome 會自動開起來。
3. 在這個 Chrome 手動登入一次測試帳號，之後會一直保持登入。

## 使用

在這個目錄開 `claude`，說要測什麼就好：

> /tdt 照 cases/02-archive.md 在 stage 跑回歸

> /tdt 測 stage 的搜尋頁，輸入特殊字元不能出錯，順便看 console 有沒有錯誤

> /tdt 用 QA profile 測 dev 的 Timeline

> /tdt 把剛剛的登入流程錄成 Playwright 測試

測試案例放在 `cases/`，可以先用 `cases/00-testbench-smoke.md` 試跑。

## 出問題時

輸入 `/tdt-doctor`，AI 會檢查並修好環境（Node.js、Chrome、MCP 連線…），修不了的會告訴你怎麼做。
