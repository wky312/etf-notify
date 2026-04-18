# 復華基金 / ETF 警訊系統 — 設計規格

**日期**：2026-04-18
**作者**：KunYang（需求） + Claude（設計）
**狀態**：Design — 待 writing-plans 產出實作計畫

---

## 1. 目的

監控一組復華基金 / ETF 的每日 NAV，當價格出現顯著波動（單日漲跌、相對近日高點的回檔、相對近日低點的反彈）或技術動能訊號（TD9 Sequential）時，透過 LINE 推播警訊給使用者，協助判斷客戶投資組合的加減碼時機。

**Phase 1（本次範圍）**：自用警訊。使用者收到通知後自行決定如何聯絡客戶。

**Phase 2（未來）**：直接群發給客戶，使用者收到的警訊同步發送給對應的持有人。資料結構需預留 `clients` 欄位以支援此擴展。

---

## 2. 非目標（Out of Scope）

- 不做投資組合損益追蹤（不是 portfolio dashboard）
- 不做即時行情（復華基金 NAV 本來就一天一筆）
- 不做自動下單
- Phase 1 不做 LINE Flex Message 卡片（用純文字訊息即可）
- Phase 1 不做 TD Countdown 13（Phase 1.5 再加）
- 不做 web dashboard（LINE Bot 的 `/status` 指令已夠查看狀態）

---

## 3. 資料來源

### 3.1 配置清單：Google Sheet（發布 CSV）

| 欄位 | 說明 | 範例 | 空白處理 |
|---|---|---|---|
| `fund_id` | 復華 URL 末段的資產代號，基金 ETF 通吃 | `03`、`ETF23` | 不可空白 |
| `display_name` | 訊息中顯示的名稱 | `高成長` | 不可空白 |
| `enabled` | 是否納入監控 | `TRUE` / `FALSE` | 空白 = `FALSE`（明確 opt-in） |
| `daily_threshold` | 單日漲跌幅警訊門檻（%） | `3` | 空白 = 預設 `3` |
| `drawdown_tiers` | 跌幅階梯，逗號分隔（%） | `5,10,20,30` | 空白 = 預設 `5,10,20,30` |
| `rebound_threshold` | 反彈警訊門檻（%，僅對 20D 窗口） | `10` | 空白 = 預設 `10` |
| `clients` | LINE user ID 清單，逗號分隔（Phase 2 用） | 空白 | Phase 1 全部空白 |

**CSV URL**：
```
https://docs.google.com/spreadsheets/d/e/2PACX-1vR8zfB4ZxJ8FI0FJkyXgN-ha1aHU9NbqtmtkIdhbI_zW-2MFXhCcGNYfOFWTuK8XmecjaZPcGXs7cnY/pub?output=csv
```

（環境變數 `FUND_ALERT_SHEET_CSV_URL` 儲存，避免硬編碼。）

### 3.2 NAV 歷史：復華 API

```
GET https://www.fhtrust.com.tw/api/fundNav?fundID={id}&sDate=YYYY/MM/DD&eDate=YYYY/MM/DD

Headers（實測必要，否則 F5 BIG-IP 會擋）:
  User-Agent: Mozilla/5.0 ...（正常瀏覽器 UA）
  Referer:    https://www.fhtrust.com.tw/funds/funds_detail/{id}   # 基金
              https://www.fhtrust.com.tw/ETF/etf_detail/{id}       # ETF
```

- **基金和 ETF 共用同一 endpoint**（`fundID` 參數接受 `03`、`ETF23` 等格式）
- `result[]` 陣列，每筆 `pnav` 為 NAV（字串），`navDate` 為日期（`YYYY/MM/DD`）
- **實測 2 年窗口 API 會截斷回傳（JSON 尾端不完整）**；需**分成兩個 1 年 chunk** 取得 ~252 交易日資料後合併去重
- 實作需要：UA header、每檔專屬 Referer、chunk 之間的 small delay（例 500ms）避免 bot rate limit

---

## 4. 架構

### 4.1 部署位置

擴充既有的 `etf-notify` repo（不開新專案）。理由：
- LINE Bot webhook 已經接好，Netlify 部署流程已經跑
- ETF 申贖通知和本次警訊本質上都是「每日 NAV → 推 LINE」，資料源不同而已
- Phase 2 推客戶也是同一套 LINE channel

### 4.2 檔案結構

```
etf-notify/
├── netlify/functions/
│   ├── line-webhook.js        [既有] LINE Bot，新增 /status 指令查詢當前狀態
│   ├── auto-notify.js         [既有] 保留 ETF 申贖通知不動
│   └── fund-alert.js          [新增] 警訊 scheduled function
├── netlify/functions/lib/
│   ├── sheet-reader.js        [新增] 讀 Google Sheet CSV，解析 thresholds
│   ├── fuhwa-api.js           [新增] 呼叫 /api/fundNav，parse pnav
│   ├── indicators/
│   │   ├── drawdown.js        [新增] 窗口高低點計算 + 階梯判定
│   │   └── td9.js             [新增] TD9 Sequential 計數器
│   ├── alert-engine.js        [新增] 整合所有 indicator 結果成訊息
│   └── state-store.js         [新增] Netlify Blobs 讀寫去抖動狀態
├── netlify.toml               [修改] 新增 scheduled function 設定
└── docs/superpowers/specs/
    └── 2026-04-18-fund-alert-design.md   [本文件]
```

### 4.3 執行時機

```
Netlify Scheduled Function
cron: "0 14 * * 1-5"       # UTC；= 台灣時間週一到週五 22:00
```

復華 NAV 通常 17:30–19:00（台灣時間）更新。22:00 跑確保資料已到位。

### 4.4 資料流

```
Netlify Schedule
  → fund-alert.js
      ├─ sheet-reader       → Google Sheet CSV → 啟用清單 + 門檻
      │
      └─ 對每檔 enabled 基金：
          ├─ fuhwa-api       → 過去 ~280 個交易日 NAV
          ├─ indicators/drawdown → 計算當前跌/漲幅相對 20D/60D/252D
          ├─ indicators/td9  → 更新 buy/sell setup count
          ├─ state-store.get → 拿上次檔位 + TD9 狀態
          ├─ 判斷是否需要發 alert（跨新檔位 / TD9 事件）
          ├─ state-store.put → 更新狀態
          └─ 收集本檔 alert entry
      │
      ├─ alert-engine        → 合成一則訊息（總覽 + 各檔明細）
      └─ LINE push API       → 送出到 LINE_USER_ID
```

---

## 5. 警訊邏輯

### 5.1 跌幅警訊（階梯去抖動）

**窗口**：20D、60D、252D 交易日，三個窗口**平行計算**。

**每個 (fund_id, window, "drawdown") 組合維護一個狀態：**
```json
{
  "last_tier": 10,
  "last_alert_date": "2026-04-10",
  "last_window_high": 15.23,
  "last_window_high_date": "2026-03-15"
}
```

**每日判定流程：**

1. 取窗口內最高 NAV `window_high`
2. 算當前跌幅 `dd = (window_high - today_nav) / window_high * 100`
3. 在 `drawdown_tiers`（例 `[5,10,20,30]`）中找最大的 `tier ≤ dd`，稱為 `current_tier`
4. 比對 `last_tier`：
   - `current_tier > last_tier` → **發警訊**，更新 `last_tier = current_tier`
   - 否則 → 不發
5. **重置條件**：若 `dd < 2%`（反彈到接近高點）→ 將 `last_tier` 歸零

### 5.2 反彈警訊

**窗口**：**僅 20D**（語意上反彈偏短期）

**每個 (fund_id, "rebound") 組合維護狀態：**
```json
{
  "last_tier": 10,
  "last_alert_date": "2026-04-05"
}
```

**判定：** 與跌幅對稱。取 20D 窗口內最低 NAV `window_low`，算反彈幅度 `rb = (today_nav - window_low) / window_low * 100`。觸發 `rebound_threshold`（預設 10）且超過上次檔位就發。回跌到離低點 2% 內重置。

### 5.3 單日漲跌幅

無狀態、無階梯。單純 `abs((today - yesterday) / yesterday * 100) ≥ daily_threshold` 就發，顯示數字本身即可。

### 5.4 TD9 Sequential（簡化版）

**每檔基金維護：**
```json
{
  "buy_setup_count": 6,
  "sell_setup_count": 0,
  "buy_complete_date": null,
  "sell_complete_date": "2026-04-15",
  "last_event_date": "2026-04-18"
}
```

**每日更新規則：**
- `today_close < close_4_days_ago`：
  - 若 `sell_setup_count ≥ 6` → 推送 sell_reset 事件
  - `sell_setup_count = 0`，`sell_complete_date = null`
  - 若 `buy_setup_count < 9` → `buy_setup_count += 1`
  - 若 `buy_setup_count` 本日達到 9 → 推送 buy_complete 事件，記錄 `buy_complete_date = today`
- `today_close > close_4_days_ago`：對稱處理
- 相等 → 兩邊維持不變（不歸零、不遞增）
- **達到 9 後 count 凍結在 9**，不再遞增，直到反轉才歸零

**通知時機（3 種事件）：**

| 事件 | 條件 | 訊息 |
|---|---|---|
| **完成** | `count` 達 9 當天 | `TD9: Buy Setup 9 完成於 YYYY/MM/DD ← NEW` |
| **完成延續** | `count == 9`，但 `complete_date` 不是今日 | `TD9: Buy Setup 9 完成於 YYYY/MM/DD（延續中）` |
| **進行中** | `6 ≤ count < 9` | `TD9: Buy Setup N/9 進行中` |
| **重置** | `count` 從 `≥6` 掉回 0 | `TD9: Buy Setup 在第 N 天被反轉重置` |

**Perfected 判定**：buy setup 9 完成時，若第 8 或第 9 bar 的 low 低於第 6 或第 7 bar 的 low，為 perfected；反之 imperfect。sell setup 對稱。（簡化版 Phase 1 可先不標記 perfected；若需要後續補上。）

### 5.5 警訊合併

每檔基金一天最多**一個 entry**，entry 內可能同時包含跌幅 / 反彈 / 單日 / TD9 多個小節。最後 `alert-engine` 把有 entry 的所有基金拼成一則 LINE 訊息推出。

---

## 6. 訊息格式（Phase 1 純文字）

**實際範例（由 `scripts/preview-fund-alert.js` 產出、已在 2026-04-18 推測過）：**

```
📊 2026/04/17 警訊摘要（5 檔監控中，3 檔觸發）

━━━━━━━━━━
高成長（03）
NAV: 352.74 (2026/04/17)
⚠️ 跌幅
• 20D: -7.2% [觸發 5%]（高點 2026/03/15）← NEW
• 60D: -12.8% [觸發 10%]（高點 2026/02/14）← NEW
📈 TD9: Buy Setup 6/9 進行中
💬 單日: -1.1%

━━━━━━━━━━
00991A（ETF23）
NAV: 14.64 (2026/04/17)
📉 TD9: Sell Setup 在第 7 天被反轉重置

━━━━━━━━━━
物聯網（77）
NAV: 70.73 (2026/04/16)
📈 反彈
• 20D: +32.5% [觸發 10%]（低點 2026/03/31）← NEW
📉 TD9: Sell Setup 9 完成於 2026/04/15（延續中）
```

**排版規則：**

- **開頭總覽**：`📊 YYYY/MM/DD 警訊摘要（N 檔監控中，M 檔觸發）`
- **每檔用 `━━━━━━━━━━` 分隔**
- **每個 entry 第二行固定顯示 NAV**：`NAV: {value} ({YYYY/MM/DD})`
- **順序**：跌幅警訊 → 反彈警訊 → TD9 → 單日變動
- **日期一律用 `YYYY/MM/DD` 格式**（台灣閱讀習慣，不用 ISO `YYYY-MM-DD`）
- **窗口警訊附高/低點日期**：
  - 跌幅：`• 20D: -7.2% [觸發 5%]（高點 2026/03/15）← NEW`
  - 反彈：`• 20D: +32.5% [觸發 10%]（低點 2026/03/31）← NEW`
- **TD9 事件顯示**：
  - **完成（今日）**：`📈 TD9: Buy Setup 9 完成於 YYYY/MM/DD ← NEW`
  - **完成（延續）**：`📈 TD9: Buy Setup 9 完成於 YYYY/MM/DD（延續中）`—— `← NEW` 前留一個半形空格；`（延續中）` 緊貼日期
  - **進行中**：`📈 TD9: Buy Setup N/9 進行中`（僅 `6 ≤ N < 9` 時顯示）
  - **重置**：`📉 TD9: Buy Setup 在第 N 天被反轉重置`（`N ≥ 6` 才顯示）
- **`← NEW` 顯示規則**：
  - 跌幅：當前 tier > 上次通知的 tier
  - 反彈：首次跨過 rebound_threshold（上次 `last_tier=0`）
  - TD9 完成：事件日期 == 今日
  - TD9 重置：永遠僅在重置當日發
  - 單日變動：不標 `← NEW`（本來就是當日事件）
- **無任何警訊的日子 → 不推訊息**（避免雜訊）

---

## 7. 錯誤處理

| 失敗情境 | 處理 |
|---|---|
| Google Sheet 讀取失敗 | **中止流程**，推一則「⚠️ 警訊系統今日無法讀取 Sheet」。不使用快取的舊 config（可能早已過期） |
| 某檔 NAV API 失敗 | 其他基金照常處理，末尾附：「⚠️ 未成功取得：03, ETF23」 |
| 當日 NAV 尚未更新（最新日期 ≠ 今日） | 跳過該檔。連續 2 個工作日抓不到當日資料 → 末尾附「⚠️ XX NAV 延遲」 |
| Netlify Blobs 失敗 | 警訊照常推，但去抖動失效（同一訊號可能重發）。**不阻斷通知流程**（可用性優先於去重） |
| LINE push 失敗 | 寫 Netlify Function log，不 retry（避免洗版） |

**原則：「警訊寧可少發、不可誤發」**—資料源異常時寧可跳過該檔，也不用髒資料推通知。

---

## 8. 去抖動狀態（Netlify Blobs Schema）

Blob key：`fund-alert-state/{fund_id}.json`

```json
{
  "fund_id": "03",
  "last_checked_date": "2026-04-18",
  "drawdown": {
    "20D": { "last_tier": 5, "last_alert_date": "2026-04-15" },
    "60D": { "last_tier": 10, "last_alert_date": "2026-04-18" },
    "252D": { "last_tier": 0, "last_alert_date": null }
  },
  "rebound": {
    "20D": { "last_tier": 0, "last_alert_date": null }
  },
  "td9": {
    "buy_setup_count": 6,
    "sell_setup_count": 0,
    "buy_complete_date": null,
    "sell_complete_date": null,
    "last_event_date": "2026-04-12",
    "last_event_type": "buy_setup_progress"
  }
}
```

---

## 9. LINE Bot 互動（既有 webhook 擴充）

新增一個指令：

- **`/status`**：即時查詢所有 enabled 基金當前狀態，回覆摘要：
  ```
  📊 2026-04-18 狀態

  高成長（03）
    20D: +1.2% | 60D: -8.5% | 252D: -11.0%
    TD9: Buy Setup 6/9

  物聯網（77）
    20D: -2.1% | 60D: -3.4% | 252D: +5.2%
    TD9: 無

  ...
  ```

未來可再加 `/pause 03`、`/resume 03` 等（Phase 1 先不做，用 Sheet 改 `enabled` 就好）。

---

## 10. 實作風險 / 待驗證

| 項目 | 風險 | Mitigation |
|---|---|---|
| Netlify Blobs 免費額度 | 不預期會爆（5 檔 × 1KB），先觀察 | 若超量，改存 JSON 到 GitHub repo |
| 復華 API 改版 | 會影響所有功能 | 錯誤處理機制保證不誤發，並透過 LINE 推警告；未來可加 fallback |
| Google Sheet CSV URL 失效 | 使用者誤改「發布到網路」設定 | Sheet 讀取失敗時立即告警 |
| 252D 窗口初期資料不足 | 新基金 / 新 ETF | 資料不足時跳過該窗口，不當錯誤 |

---

## 11. Phase 2 / 1.5 待辦（備忘）

- **Phase 1.5**：TD Countdown 13、Dashboard UI（若需要）
- **Phase 2**：`clients` 欄位啟用、依據持有人過濾推播、升級 Flex Message 卡片、LINE 官方帳號訊息配額管理

---

## 12. 決策記錄

| 決策 | 選項 | 選擇 | 理由 |
|---|---|---|---|
| 通知對象 | 自用 / 直推客戶 / 兩階段 | 兩階段（先自用） | 先驗證警訊品質再擴客戶 |
| 通知管道 | LINE / Telegram | LINE | 使用者日常打開；Telegram 不常看 |
| 窗口定義 | 52 週 / 20·60·252D / 不對稱 | 20·60·252D 平行 | 52 週太嚴會沒訊號 |
| 多窗口觸發打包 | 合併 / 逐條 / 只發最嚴重 | 合併成一則 | 省 LINE 額度 + 資訊完整 |
| TD9 範圍 | Phase 1 / 1.5 | Phase 1 | 自用不需要跟客戶解釋 |
| TD9 顯示門檻 | ≥5 / ≥6 | ≥6 | 1–5 失敗率高，不具參考性 |
| 資產類型路由 | 前綴判別 / 欄位標記 / 自動 | 無需路由 | 復華 API 通吃基金 ETF |
| 狀態儲存 | Netlify Blobs / GitHub / Supabase | Netlify Blobs | 同平台、零設定 |
| Sheet `enabled` 空白處理 | 預設 TRUE / 預設 FALSE | FALSE | 明確 opt-in 比較安全 |
| 執行時間 | 20:00 / 22:00 / 多次 | 22:00 週一五 | 確保 NAV 已更新 |
