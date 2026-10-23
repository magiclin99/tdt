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
