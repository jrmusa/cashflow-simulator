# Code Base
- Only use pure html, css and javascript to build an interactive web app
- Animated style would be my preference

# Coding Style
- Each logic should be tested before publish

# Format
- Only use Chinese to display content
- Use `IOS design style` to design any component

# 專案理解（2026-10-27 整理，供下次參閱）

## 用途
退休現金流模擬器「現金流製造機」：輸入持股配置與月生活費目標，逐年推演 30 年（可調 1–50）在「樂觀 / 中性」兩情境下的提領、被動收入、缺口與淨值。單位：金額多為「萬（新台幣）」，`FXk = 10000`。
Repo：`jrmusa/cashflow-simulator`（private，branch main）。

## 檔案結構
- `index.html`：4 個分頁（投資配置 / 提領設定 / 情境假設 / 結果）＋底部 tab bar；Chart.js 4.4.1 由 cdnjs 載入；依序載入 `withdrawal.js → history.js → model.js → app.js → records.js → database.js`；第 5 個分頁「資料庫」。
- `js/withdrawal.js`（UMD，全域 `CFMWithdrawal`）：純提領數學。`applyWithdrawal(start, annualReturn, annualRate)` 月初提領（annuity-due）封閉解，回傳 `{end, withdrawn, ratio}`（ratio = 剩餘股數比例）；`solveTargetRate(livingAt, target)` 由生活費目標反推提領率（0 → 達標則 0；掃描 i/2000 再二分；到不了回傳 1）；`WITHDRAWAL_DEF`、`MAX_YEARS = 50`。
- `js/model.js`（UMD，全域 `CFMModel`）：`DEF` 預設值、`run(params)` 逐年推演、`value2887(shares, price)`、`valueKo(usd, fx)`、`deepClone`。
- `js/app.js`：UI（iOS 風格 stepper 輸入、分頁切換 `switchTab`、圓餅圖/折線圖、結果卡片與兩張表）、localStorage（key `cfm`，含舊資料遷移 `loadState`）、主題切換、Finnhub 抓 KO 即時股價。按「重新計算」會存檔、計算並自動跳到結果頁。
- `js/history.js`（UMD，全域 `CFMHistory`）：「歷史推演」情境。`HIST` = 2004–2025 真實年報酬（etf=0050 含息、tw=2887 含息〔companiesmarketcap 美元還原報酬按 FRED 12 月匯率換回台幣，近似〕、ko=KO 股價淨漲〔chartrow〕）；`generatePath(years, seed)` 以 mulberry32 亂數把歷史年份隨機重排（每 22 年一輪不重複、三檔同年一起抽），逐年回溯排除不合理組合：任何滾動 10 年年化須介於真實歷史最差～最好 10 年之間（`BOUNDS`），同一檔最多連續跌 3 年。純拒絕抽樣接受率≈0，所以用回溯。app 端 `S.histSeed` 存 localStorage，「重新隨機配置」按鈕換 seed；SGOV/權利金沿用中性；KO 每年淨漲上限 `S.koCapHist`（DEF 8%，近似 covered call 被履約，`applyKoCap` 只砍漲幅、下跌照算，2004–2025 套用後年化約 1.5%），在情境假設頁可調；model rows 多了 `twRet/koRet/histYear`。
- `js/records.js`（UMD，全域 `CFMRecords`）：資料庫純邏輯。`FIELDS`（25 個欄位，cash/asset 兩組；含 VT 提領、美元定存利息、美元定存本金補缺、VT 值、美元定存；舊記錄缺欄位時讀入為 0）、`snapshot(row, year)`（樂觀第 1 年列 → `{year, savedAt, scenario, values}`，targetMonthly = target/12）、`upsert`（同年份覆蓋、依年份排序）、`removeYears`、`parseYear`（4 位數 1900–2200）、`serialize`/`parse`（檔案格式 `{app, version:1, records}`，也接受純陣列，壞列略過）。
- `js/database.js`：資料庫 UI。結果頁「記錄」鈕 → iOS 風格對話框輸入年份 → 重複則問是否覆蓋 → File System Access API 寫 JSON（首次 showSaveFilePicker，handle 存 IndexedDB `cfm-db`；不支援的瀏覽器如 Safari 改為下載檔案、讀檔用 input file）。本機另存 localStorage `cfm-db` 讓重開頁面仍看得到表格。資料庫頁：狀態列、讀檔（取代目前資料並改連結該檔）、重置（刪除特定年份勾選清單／完全清除，已連結檔案會同步寫回）、表格（每年一列）與淨值趨勢圖。app.js 提供 `window.CFMApp.getResults()`，並發出 `cfm-tab`／`cfm-theme` 事件讓圖表在顯示/換主題時重畫。
- `js/model.test.js`：自製 node 測試框架（`test()`、`runScenario()` 預設為舊 fixed 模式 10 年、`runTarget()` 為 target 模式 30 年）；執行 `node js/model.test.js`，目前 79 項全過。測試的 `runScenario()` 預設用 `LEGACY_HOLDINGS`（新增 VT / 美元定存之前的配置、KO 80000 USD）以維持 golden 值；新標的用 `runDef()` 以 `M.DEF` 測。結果摘要必須放在檔案最後。
- `css/styles.css`：iOS 風格、深淺色主題、`.cards` 兩欄（≤420px 一欄）。
- `Reference/`：`assumptions-check.md`（預設值與網路資料查證）、`withdrawal-strategy.md`（提領策略蒙地卡羅比較）、`withdrawal-montecarlo.js`（可重跑的模擬腳本）、`ref.html`（舊版三情境原型，僅參考）。

## 預設配置（DEF）
0050 300、006208 330、2887 750.64（= 176,000 股 × 42.65）、VT 200、KO ≈200（= 62,363 USD × 匯率 32.07）、SGOV 330、美元定存 96.21（= 30,000 USD × 匯率，年利率 4% 固定）、備用金 180（萬）；總資產約 2,387 萬。
月生活費目標 10 萬（`livingTarget` 以「年」存 120）、通膨 2%、30 年、SGOV 還貸每月 2.8999 萬共 10 年、備用金利率 1.8%（只計前 100 萬）。
2887：每年現金股利 1.0 元/股、股票股利 0.1 元/股（面額 10 元，零股折現金）。
情境：樂觀 {etf 11, tw 8, vt 9, ko 3, sgov 3.65, callPricePerShare 0.8}；中性 {etf 7, tw 3, vt 6, ko 2, sgov 3.0, callPricePerShare 0.6}。`tw` = 2887 含股利總報酬，`ko` = KO 淨漲，KO 另有每月每股 covered call 權利金（USD）。悲觀情境與股災設定已移除（引擎內 crash 機制僅供測試）。

## run() 每年流程（target 模式）
1. 當年目標 = livingTarget × (1+通膨)^(yr−1)。
2. SGOV：加利息、扣還貸（貸款年限內）；不足由備用金扣。備用金利息 `min(餘額,100)×利率` 全數撥入生活費（不複利）。
3. 提領瀑布（預設 `order = ["2887","vt","etf","ko","res"]`，沒有部位的池會被跳過）：依序對各池用 `solveTargetRate` 求提領率，前一池到 100% 仍不足才動下一池；備用金（res）是最後手段，由年底「缺口 = 目標 − 生活費」補足。生活費 = ETF 提領 + 2887 提領 + KO 提領 + 2887 現金股利 + KO covered call + 備用金利息 + 美元定存利息；備用金補完缺口後，仍不足才動用美元定存本金（`usedUsd`，最後手段）。VT 為提領池（`vtWd`、`wrVt`，歷史推演的 VT 報酬沿用中性情境固定值）；美元定存利息 = 市值 × `usdDepositRate`，本金不複利。
4. 2887：提領後股數同比例減少，股利以提領後股數計；市值成長 = 總報酬 − 現金股利（配股留在部位）。
5. KO：股數 = USD ÷ 股價；口數 = floor(剩餘股數/100)；call 收入 = 口數×100×權利金×12×匯率/FXk。
6. 列欄位：yr, target, wr(ETF), wr2887, wrKo, etfWd, wd2887, koWd, div2887, call, resInt, usedRes, living, shortfall, loanPay, etf, s2887, ko, sgov, res, assets, net, shares2887Total, koShares, koContracts…
- 熊市規則 `params.bearRule = {drawdown, refill}`（僅 target 模式；app 由 `S.bearDrawdown`（DEF 20，0=關閉）傳入，refill 固定 true）：追蹤 ETF 報酬指數 `etfIdx`（不受提領影響）與高點；年初距高點跌 ≥ drawdown% → 當年 order 把 "res" 移到最前（備用金優先），用掉的累計在 `bearUsed`；指數創新高那年年初從 0050/006208 等比例賣出補回 `min(bearUsed, 原始備用金−目前, ETF)`。rows 多 `bear/drawdown/refill`。固定報酬情境永遠不觸發。歷史推演 200 條路徑（中性、KO 上限 8%）：月 8 萬成功率 88%→92.5%、月 10 萬 61.5%→67%。
- 進階參數（UI 未使用）：`order`（陣列、`"prorata"` 或每年回傳陣列的函式）、`capMult`（每池先只領到「年報酬×倍數」再換下一池）、`pathReturns`（每年 {etf,tw,ko} 報酬%，供蒙地卡羅）。`withdrawalMode:"fixed"` 為舊版固定提領率，只用於回歸測試（golden 值）。

## 已做過的分析結論
- 提領順序：「報酬低者先賣」最佳 → 2887 → 0050+006208 → KO → 備用金。固定報酬與 1,000 條隨機路徑（波動假設 ETF 20%、2887 25%、KO 18%）下，都優於三池同比例、再平衡、Guyton-Klinger、每池上限等動態策略。若 2887 報酬調到與 ETF 相同，各策略幾乎打平。
- 加入波動後成功率遠低於固定報酬推算（中性月 7 萬約 48%）；月生活費額度是影響最大的變數。
- 2887 移到 0050/006208：在 2887 報酬 < ETF 的假設下小幅改善（中性月 7 萬成功率 47% → 54%），若報酬相同則打平。移到 KO 的好結果來自權利金固定、未限制上漲空間的模型假設，不可靠。

## 工作注意事項
- 使用者偏好：純 HTML/CSS/JS、動畫、iOS 設計風格、介面只用中文、任何邏輯上線前要有測試。
- 修改後至少跑 `node js/model.test.js` 與 `node --check js/app.js`。
- 不要主動 commit/push，等使用者要求。commit 時作者用 `-c user.name="drakewu" -c user.email="jrmusa@wuguoquandeMac-mini.local"`。
- Cowork 遠端 VM 不能刪檔：git 會留下 `.git/*.lock`，需改名為 `.git/stale-*`（不要動 `.git/refs` 底下）。VM 沒有 GitHub 憑證，push 要請使用者在自己的終端機執行。
- 試算用的暫存腳本放在 VM 的 `~/mc/`，不要寫進專案。
