(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.CFMModel = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var W = (typeof module === "object" && module.exports) ? require("./withdrawal.js") : CFMWithdrawal;

  var FXk = 10000;
  var FACE_VALUE_2887 = 10; // 台股每股面額，配股換算股數的基準

  // 預設值依 2026-10 公開資料校準（詳見 Reference/assumptions-check.md）：
  // 2887 與 KO 的市值皆由「股數/金額 × 價格」推得，不再手填，避免市值與股數、股價互相矛盾。
  var DEF = {
    holdings: { "0050": 300, "006208": 330, "2887": 750.64, "KO": 256.56, "SGOV": 330, "備用金": 180 },
    fx: 32.07,                // 央行 2026/10/14 銀行間收盤 32.073
    price2887: 42.65,         // 2887 每股市價(元)：市值 = 原始股數 × 每股市價 ÷ 10000
    // 注意：holdings 的 2887 / KO 為上述推導值（176000 × 42.65 ÷ 10000；80000 × 32.07 ÷ 10000）
    loanMonthly: 2.8999,
    livingTarget: 120,
    withdrawalRate: W.WITHDRAWAL_DEF.withdrawalRate,         // 0050 + 006208 提領%
    withdrawalRate2887: W.WITHDRAWAL_DEF.withdrawalRate2887, // 2887 提領%
    withdrawalRateKo: W.WITHDRAWAL_DEF.withdrawalRateKo,     // KO 提領%
    inflation: W.WITHDRAWAL_DEF.inflation,                   // 通膨率%：生活費目標逐年成長
    years: W.WITHDRAWAL_DEF.years,                           // 推演年數
    loanYears: 10,                                           // 貸款年限（超過後不再還貸）
    reserveRate: 1.8,
    shares2887Base: 176000,
    dividendPerShare2887: 1.0,
    stockDividendPerShare2887: 0.1,
    koUsdAmount: 80000,  // KO 總投入金額(美元)：用來自動換算股數/口數
    koPriceUsd: 91.05,   // KO 每股市價(美元)：股數 = 總投入金額 / 每股市價
    scen: {
      "樂觀": { etf: 11, tw: 8, ko: 3, sgov: 3.65, callPricePerShare: 0.8 },
      "中性": { etf: 7, tw: 3, ko: 2, sgov: 3.0, callPricePerShare: 0.6 }
    }
  };

  // 2887 市值(萬) = 股數 × 每股市價(元) ÷ 10000；KO 市值(萬) = 美元金額 × 匯率 ÷ 10000。
  function value2887(shares, priceTwd) { return (shares * priceTwd) / FXk; }
  function valueKo(usdAmount, fx) { return (usdAmount * fx) / FXk; }

  function clampNumber(value, min, max) {
    var result = value;
    if (typeof min === "number") result = Math.max(min, result);
    if (typeof max === "number") result = Math.min(max, result);
    return result;
  }

  // Sanitizes a raw (possibly typed) value against the last known-good value.
  // Empty/non-numeric input reverts to previousValidValue rather than 0, so a
  // user mid-edit never gets silently reset to a misleading number.
  function sanitizeNumber(raw, previousValidValue, opts) {
    opts = opts || {};
    if (raw === "" || raw === null || raw === undefined) return previousValidValue;
    var n = typeof raw === "number" ? raw : parseFloat(raw);
    if (!isFinite(n) || isNaN(n)) return previousValidValue;
    var result = n;
    if (typeof opts.decimals === "number") {
      var factor = Math.pow(10, opts.decimals);
      result = Math.round(result * factor) / factor;
    }
    result = clampNumber(result, opts.min, opts.max);
    return result;
  }

  function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  // KO covered call 部位：股數 = 美元金額 / 美元市價；口數 = 股數 / 100 無條件捨去
  // （每口(1 contract) = 100 股，不足 100 股的零股無法賣出該口）。
  function koPosition(usdAmount, priceUsd) {
    var shares = priceUsd > 0 ? usdAmount / priceUsd : 0;
    var contracts = Math.floor(shares / 100);
    return { shares: shares, contracts: contracts };
  }

  // Runs a single N-year (params.years, default 30) projection for one scenario.
  // params: { holdings, fx, loanMonthly, livingTarget, shares2887, scenario, crash, pessimistic }
  // - holdings: {"0050","006208","2887","KO","SGOV","備用金"} pool values (萬)
  // - livingTarget: ANNUAL target (萬)
  // - koUsdAmount/koPriceUsd: KO USD position size + USD market price -> shares -> contracts
  // - scenario: {etf,tw,ko,sgov,callPricePerShare} percentages / USD-per-share option quote
  //   (options are always quoted per share; one contract = 100 shares, so a quote of 0.9
  //   means a $90 premium per contract per month)
  // - crash: {y1,m1,y2,m2} only applied when pessimistic is true（產品已移除悲觀情境與股災設定，
  //   此為保留的壓力測試機制，僅供測試使用；crash 可省略）
  function run(params) {
    var holdings = params.holdings;
    var fx = params.fx;
    var loanMonthly = params.loanMonthly;
    var livingTarget = params.livingTarget;
    var withdrawalRate = params.withdrawalRate;
    var withdrawalRate2887 = params.withdrawalRate2887 || 0;
    var withdrawalRateKo = params.withdrawalRateKo || 0;
    var years = typeof params.years === "number" ? params.years : W.WITHDRAWAL_DEF.years;
    var loanYears = typeof params.loanYears === "number" ? params.loanYears : 10;
    var reserveRate = params.reserveRate;
    var shares2887Base = params.shares2887Base;
    var dividendPerShare2887 = params.dividendPerShare2887;
    var stockDividendPerShare2887 = params.stockDividendPerShare2887;
    var s = params.scenario;
    var crashCfg = params.crash || {};
    var pessimistic = params.pessimistic;
    var koPos = koPosition(params.koUsdAmount, params.koPriceUsd);

    var v = Object.assign({}, holdings);
    var loanAnnual = loanMonthly * 12;
    var loanTotal = loanAnnual * loanYears;
    var loanPaid = 0;
    var koShares = koPos.shares;     // 隨提領逐年縮減
    var shares2887 = shares2887Base; // running total (base + accumulated whole stock-dividend shares)

    var crash = {};
    if (pessimistic && crashCfg.y1 !== undefined) {
      crash[crashCfg.y1] = crashCfg.m1 / 100;
      crash[crashCfg.y2] = crashCfg.m2 / 100;
    }

    var inflation = typeof params.inflation === "number" ? params.inflation : 0;
    // 提領模式：預設 "target"（目標提領率，由生活費目標反推）；"fixed" 為舊版固定提領率。
    var mode = params.withdrawalMode || "target";

    var rows = [];
    for (var yr = 1; yr <= years; yr++) {
      var etfRet = s.etf / 100;
      if (crash[yr] !== undefined) etfRet = crash[yr];
      // 該年度生活費目標（年，萬）：第 1 年為設定值，之後每年乘上 (1 + 通膨率)。
      var yearTarget = livingTarget * Math.pow(1 + inflation / 100, yr - 1);

      // 先處理與提領無關的 SGOV 還貸與備用金利息（不受提領率影響）。
      var sgovInt = v["SGOV"] * (s.sgov / 100);
      var loanPayYr = yr <= loanYears ? loanAnnual : 0;
      v["SGOV"] = v["SGOV"] + sgovInt - loanPayYr;
      if (v["SGOV"] < 0) {
        v["備用金"] += v["SGOV"];
        v["SGOV"] = 0;
      }
      loanPaid += loanPayYr;

      var resRate = reserveRate / 100;
      // 備用金利息全數撥入生活費（不再滾回本金），因此餘額只會因 SGOV 還貸缺口與股災補缺口而減少。
      var resInt = Math.min(v["備用金"], 100) * resRate;

      // 模擬三個提領池一年（純函式，不改動 v / shares）：rates = {etf, s2887, ko}（小數）。
      // 提領邏輯集中在 withdrawal.js：每月月初先扣款、剩餘部位才賺當月報酬（annuity-due），
      // 全年提領額 = 年初市值 × 提領率。
      function simulate(rates) {
        var etfRes = {};
        var etfWdSum = 0;
        ["0050", "006208"].forEach(function (k) {
          var res = W.applyWithdrawal(v[k], etfRet, rates.etf);
          etfRes[k] = res.end;
          etfWdSum += res.withdrawn;
        });

        // 2887 提領：賣出的股數同步從總股數扣除（取整數），之後的現金股利與配股都以提領後的股數計算。
        var r2887 = W.applyWithdrawal(v["2887"], s.tw / 100, rates.s2887);
        var sh = shares2887;
        if (rates.s2887 > 0) sh = Math.floor(sh * r2887.ratio);
        // 配息與配股都以「當年最新總股數」（原始股數＋歷年累積配股）計算，會逐年成長。
        // 配股：股票股利金額(元) = 目前總股數 × 配股(元/股)；股數 = 股票股利金額 / 面額(10元)。
        // 未滿 1 股的零股改發等值現金（以面額折算），併入當年現金股利，不計入不可售的累積股數。
        var newSharesFloat = (sh * stockDividendPerShare2887) / FACE_VALUE_2887;
        var newSharesWhole = Math.floor(newSharesFloat);
        var cashInLieuYuan = (newSharesFloat - newSharesWhole) * FACE_VALUE_2887;
        var div = (sh * dividendPerShare2887 + cashInLieuYuan) / FXk;

        // 情境的 2887 年報酬% 為「含股利」總報酬：現金股利已經算在報酬裡，且會撥入生活費（離開部位），
        // 因此市值只保留「總報酬 − 現金股利」；配股為股票股利，價值留在部位內，不另外扣除。
        // （舊版 fixed 模式維持原本把整個報酬都留在市值的算法，僅供回歸測試。）
        var s2887End = mode === "fixed" ? r2887.end : Math.max(0, r2887.end - div);

        // KO 提領：賣出的股數同步縮減，口數 = 剩餘股數 ÷ 100 無條件捨去，covered call 收入隨之減少。
        var rKo = W.applyWithdrawal(v["KO"], s.ko / 100, rates.ko);
        var ks = koShares;
        if (rates.ko > 0) ks = ks * rKo.ratio;
        var contracts = rates.ko > 0 ? Math.floor(ks / 100) : koPos.contracts;
        var call = (contracts * 100 * s.callPricePerShare * 12 * fx) / FXk;
        var koEnd = rKo.end;
        if (crash[yr] !== undefined) koEnd *= 1 + crash[yr] * 0.6;

        return {
          etfRes: etfRes, etfWd: etfWdSum,
          s2887End: s2887End, wd2887: r2887.withdrawn, shares: sh + newSharesWhole, div: div,
          koEnd: koEnd, koWd: rKo.withdrawn, koShares: ks, contracts: contracts, call: call,
          living: etfWdSum + r2887.withdrawn + rKo.withdrawn + div + call + resInt
        };
      }

      var rates;
      if (mode === "fixed") {
        rates = { etf: withdrawalRate / 100, s2887: withdrawalRate2887 / 100, ko: withdrawalRateKo / 100 };
      } else {
        var r = W.solveTargetRate(function (x) {
          return simulate({ etf: x, s2887: x, ko: 0 }).living;
        }, yearTarget);
        // 0050+006208 與 2887 統一套用同一個目標提領率；KO 不提領（留倉成長、只貢獻 covered call 收入）。
        rates = { etf: r, s2887: r, ko: 0 };
      }
      var sim = simulate(rates);
      var wr = rates.etf;

      v["0050"] = sim.etfRes["0050"];
      v["006208"] = sim.etfRes["006208"];
      v["2887"] = sim.s2887End;
      shares2887 = sim.shares;
      v["KO"] = sim.koEnd;
      koShares = sim.koShares;
      var etfWd = sim.etfWd, wd2887 = sim.wd2887, koWd = sim.koWd;
      var div2887 = sim.div, callInc = sim.call, koContracts = sim.contracts;
      var shares2887Total = shares2887;

      var living = sim.living;
      var usedRes = 0;
      var gap = yearTarget - living;
      // 目標提領率模式：只要提領（含 100% 上限或提領池已領完）加其他收入仍達不到該年生活費目標，
      // 就動用備用金補缺口（不限股災年）；舊版固定提領率模式維持「僅股災年（ETF 跌 >5%）」才補。
      if (gap > 0 && (mode !== "fixed" || etfRet < -0.05)) {
        usedRes = Math.min(gap, v["備用金"]);
        v["備用金"] -= usedRes;
        living += usedRes;
      }

      var assets = Object.values(v).reduce(function (a, b) { return a + b; }, 0);
      var net = assets - (loanTotal - loanPaid);

      rows.push({
        yr: yr, etfRet: etfRet, wr: wr, living: living, target: yearTarget,
        etf: v["0050"] + v["006208"], ko: v["KO"], s2887: v["2887"],
        sgov: v["SGOV"], res: v["備用金"], assets: assets, net: net,
        call: callInc, etfWd: etfWd, div2887: div2887, resInt: resInt, resRate: resRate,
        usedRes: usedRes, shortfall: Math.max(0, yearTarget - living), loanPay: loanPayYr, wd2887: wd2887, koWd: koWd, shares2887Total: shares2887Total,
        koShares: koShares, koContracts: koContracts
      });
    }
    return rows;
  }

  return {
    FXk: FXk,
    DEF: DEF,
    value2887: value2887,
    valueKo: valueKo,
    clampNumber: clampNumber,
    sanitizeNumber: sanitizeNumber,
    deepClone: deepClone,
    monthlyWithdrawalBalance: W.monthlyWithdrawalBalance,
    applyWithdrawal: W.applyWithdrawal,
    koPosition: koPosition,
    run: run
  };
});
