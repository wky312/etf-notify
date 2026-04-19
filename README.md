# etf-notify

透過 LINE Bot 做兩件事：

1. **復華 ETF 申贖試算**：在 LINE 群組裡 @ 機器人並輸入 ETF 代號 + 基數，自動回覆當日 NAV 換算的金額。
2. **復華基金/ETF 警訊監控**：每個工作日自動抓 Google Sheet 配置的基金清單、計算價格警訊（單日漲跌、20D/60D/252D 跌幅階梯、20D 反彈）與 TD9 Sequential 訊號，觸發時推播到 LINE。

部署在 **Vercel**（cron + 函式）+ **Upstash Redis**（警訊狀態），LINE Bot 互動與排程各用一條路徑。

- Live：<https://etf-notify.vercel.app>
- 設計文件：[`docs/superpowers/specs/2026-04-18-fund-alert-design.md`](docs/superpowers/specs/2026-04-18-fund-alert-design.md)
- 實作計畫：[`docs/superpowers/plans/2026-04-18-fund-alert.md`](docs/superpowers/plans/2026-04-18-fund-alert.md)

---

## 架構

```
                       ┌────────────────────────┐
LINE 使用者 / 群組 ─────┤ api/line-webhook       │  HMAC 驗簽 + 指令分派
                       └────────────────────────┘
                                  │
                    ┌─────────────┼────────────────┐
                    ▼             ▼                ▼
            ETF 申贖試算     /status 指令     其他（help）
            (lib/calculate)   (所有 enabled        │
                               基金當下狀態)       │
                                                   │
Vercel Cron (週一~五 22:00 TPE)                    │
0 14 * * 1-5 UTC → POST /api/fund-alert            │
                                  │                │
                                  ▼                │
                  ┌───────────────────────────┐    │
                  │ lib/fund-alert-runner     │    │
                  │  1. 讀 Google Sheet CSV   │    │
                  │  2. 抓復華 /api/fundNav   │    │
                  │  3. 算 drawdown + TD9     │    │
                  │  4. 比對上次 state        │    │
                  │  5. 推 LINE 合併訊息      │    │
                  └───────────────────────────┘
                        │            │
              抓資料    │            │   讀寫 state
                        ▼            ▼
            復華 fhtrust.com.tw   Upstash Redis
            (Referer/UA 防爬)    (fund-alert:{id})
```

## Repo 結構

```
etf-notify/
├── api/                      ← Vercel serverless functions
│   ├── fund-alert.js         ← POST/GET, scheduled via vercel.json
│   ├── line-webhook.js       ← LINE Bot webhook
│   └── auto-notify.js        ← Pushover + OCR 通知（選用）
├── netlify/functions/        ← Netlify 版本（fallback，cron 已關）
│   ├── fund-alert.js
│   ├── line-webhook.js
│   └── auto-notify.js
├── lib/                      ← 跨平台共用邏輯
│   ├── fund-alert-runner.js  ← fund-alert 主流程
│   ├── line-webhook-handler.js ← LINE webhook 主流程
│   ├── sheet-reader.js       ← Google Sheet CSV → FundConfig[]
│   ├── fuhwa-api.js          ← 復華 NAV API（分 chunk 抓 + 防爬 header）
│   ├── state-store.js        ← Upstash REST 讀寫 state
│   ├── alert-engine.js       ← 合成所有 indicator + 去抖動
│   ├── message-formatter.js  ← LINE 文字排版
│   ├── line-push.js          ← LINE Messaging API 推播
│   ├── indicators/
│   │   ├── drawdown.js       ← 窗口高/低 + 階梯
│   │   └── td9.js            ← TD9 Sequential
│   ├── fetch-nav.js          ← ETF PCF（auto-notify 用）
│   ├── calculate.js          ← ETF 申贖金額
│   └── etf-config.js         ← ETF 代號對照表
├── tests/                    ← node:test 單元測試
│   ├── *.test.js
│   └── indicators/*.test.js
├── scripts/
│   └── preview-fund-alert.js ← 本地預覽訊息格式（不動 state）
├── docs/superpowers/
│   ├── specs/…               ← 設計規格
│   └── plans/…               ← 實作計畫
├── vercel.json               ← cron + function 設定
├── netlify.toml              ← Netlify 設定（cron 已關）
└── package.json
```

## 環境變數

在 Vercel project settings 或 `vercel env` 設定。複製同名 env 到本地 `.env` 就能跑 preview script。

| 變數 | 用途 | 必要 |
|---|---|---|
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Bot 推播/回覆 | ✅ |
| `LINE_CHANNEL_SECRET` | LINE 簽名驗證 | ✅ |
| `LINE_USER_ID` | 警訊推播對象 | ✅ |
| `FUND_ALERT_SHEET_CSV_URL` | Google Sheet 發布的 CSV URL | ✅ |
| `UPSTASH_REDIS_REST_URL` | Upstash Redis REST endpoint | ✅ |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis REST token | ✅ |
| `PUSHOVER_API_TOKEN` / `PUSHOVER_USER_KEY` | auto-notify 用 | 選用 |
| `GEMINI_API_KEY` | auto-notify 的 OCR | 選用 |

## Google Sheet 設定

1. 新增試算表，第一列固定以下欄位：

   | fund_id | display_name | enabled | daily_threshold | drawdown_tiers | rebound_threshold | clients |

2. 填入基金，例如：

   ```
   03     高成長       TRUE  3  "5,10,20,30"  10
   ETF23  00991A      TRUE  3  "5,10,20,30"  10
   77     物聯網       TRUE  3  "5,10,20,30"  10
   ```

   - `fund_id`：復華頁面 URL 尾碼（基金 `03`、ETF `ETF23`）
   - `enabled`：空白或非 `TRUE` = 不監控（明確 opt-in）
   - 門檻欄位空白會套預設值：`daily_threshold=3`、`drawdown_tiers=[5,10,20,30]`、`rebound_threshold=10`
   - `clients`：Phase 2 客戶 LINE user ID，Phase 1 全部空白

3. 檔案 → **分享** → **發布到網路** → 選分頁 + 格式 **CSV** → 複製 URL 設為 `FUND_ALERT_SHEET_CSV_URL`

## 警訊邏輯摘要

詳見 [design spec §5](docs/superpowers/specs/2026-04-18-fund-alert-design.md)。

- **跌幅警訊（階梯去抖動）**：20D / 60D / 252D 三個窗口平行，跨到更高檔位才通知。反彈到離高點 <2% 時重置檔位。
- **反彈警訊**：只對 20D 窗口跑，跨過 `rebound_threshold` 且 `lastTier=0` 時發一次。
- **單日漲跌**：`|today-yesterday|/yesterday ≥ daily_threshold` 就發。
- **TD9 Sequential**：Buy/Sell setup 計數 0–9；達 9 記 `completeDate`；計數 ≥6 被反轉才發 reset 事件。訊息會區分「今日完成 ← NEW」vs「延續中」。
- **打包**：每檔一天最多一則訊息，各項 alerts 合併；首列顯示 `NAV: 值 (YYYY/MM/DD)`。

## 開發

```bash
npm install
npm test                          # 54 個單元測試
node scripts/preview-fund-alert.js  # 真資料跑一次、推 LINE（讀 .env）
```

## 部署

```bash
# 設環境變數（首次）
printf 'value' | vercel env add VAR_NAME production

# 手動部署
vercel deploy --prod

# 或透過 git push（若開啟 git integration）
git push origin main
```

**注意**：Vercel 的 cron 由 `vercel.json` 的 `crons` 欄位宣告，每次 deploy 都會讀取。Netlify 仍保留 code 當 fallback，但 `netlify.toml` 已移除 `[functions.fund-alert]` 的 `schedule`。

## 排程

`0 14 * * 1-5` UTC = 週一到週五 **22:00 台灣時間**。

選這個時段因為復華 NAV 通常傍晚（17:30–19:00 TPE）才更新，22:00 跑可確保當日資料已到位。

## 狀態儲存

Upstash Redis key pattern: `fund-alert:{fundId}`。

每個 key 的 value 是 JSON 序列化的 state（`{ lastCheckedDate, drawdown, rebound, td9 }`）。

用 Redis 而不是 Netlify Blobs 的理由：跨平台（Vercel / Netlify / GitHub Actions / local 都能讀寫）、免費額度充足（30k 指令/月，實際用量每月 <200）。

## LINE 指令

在 LINE 1-on-1 或群組（群組需 @ 機器人）傳：

| 指令 | 回應 |
|---|---|
| `?` / `help` / 空訊息 | 使用說明 |
| `/status` | 所有 enabled 基金當下的 drawdown + TD9 狀態快照 |
| `00991A -28, 00986D -17`（ETF 代號+基數）| 當日 NAV 換算金額 |
| `-28 -17`（只填數字，依預設順序）| 同上 |

## Roadmap

- **Phase 1（已完成）**：自用警訊（這個 README 描述的範圍）
- **Phase 1.5**：TD Countdown 13、Dashboard UI
- **Phase 2**：依 Google Sheet 的 `clients` 欄位，把警訊直接推給持有該基金的客戶 LINE
