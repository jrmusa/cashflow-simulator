(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.CFMModel = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var FXk = 10000;
  var FACE_VALUE_2887 = 10; // 台股每股面額，配股換算股數的基準

  var DEF = {
    holdings: { "0050": 300, "006208": 330, "2887": 633, "KO": 590, "SGOV": 330, "備用金": 180 },
    fx: 32.4,
    loanMonthly: 2.8999,
    livingTarget: 120,
    withdrawalRate: 4,
    reserveRate: 1.8,
    shares2887Base: 176000,
    dividendPerShare2887: 1.0,
    stockDividendPerShare2887: 0.1,
    koUsdAmount: 182100, // KO 總投入金額(美元)：用來自動換算股數/口數
    koPriceUsd: 91.05,   // KO 每股市價(美元)：股數 = 總投入金額 / 每股市價
    scen: {
      "樂觀": { etf: 11, tw: 8, ko: 6, sgov: 3.8, callPricePerShare: 0.9 },
      "中性": { etf: 7, tw: 3, ko: 2, sgov: 3.5, callPricePerShare: 0.6 },
      "悲觀": { etf: 2, tw: -2, ko: -1, sgov: 3.0, callPricePerShare: 0.3 }
    },
    crash: { y1: 3, m1: -28, y2: 7, m2: -20 }
  };

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

  // Applies one year of monthly-compounding growth with a beginning-of-month withdrawal:
  // each month the withdrawal is deducted first, then only the remaining balance earns
  // that month's return — so withdrawn cash never shares in that month's growth (or loss).
  // annualReturn/annualWithdrawalRate are decimals (e.g. 0.07, 0.04), not percentages.
  function monthlyWithdrawalBalance(startBalance, annualReturn, annualWithdrawalRate) {
    var monthlyRate = Math.pow(1 + annualReturn, 1 / 12) - 1;
    var monthlyWithdrawal = (startBalance * annualWithdrawalRate) / 12;
    if (Math.abs(monthlyRate) < 1e-12) {
      // No growth/decay this year: 12 equal withdrawals just subtract linearly.
      return startBalance - monthlyWithdrawal * 12;
    }
    // Closed-form annuity-due future value: B12 = P(1+r) - W(1+i)*[((1+i)^12-1)/i],
    // substituting (1+i)^12-1 = annualReturn (exact, by construction of i) to avoid
    // a second, separately-rounded call to Math.pow.
    return startBalance * (1 + annualReturn) - monthlyWithdrawal * (1 + monthlyRate) * (annualReturn / monthlyRate);
  }

  // Runs a single 10-year projection for one scenario.
  // params: { holdings, fx, loanMonthly, livingTarget, shares2887, scenario, crash, pessimistic }
  // - holdings: {"0050","006208","2887","KO","SGOV","備用金"} pool values (萬)
  // - livingTarget: ANNUAL target (萬)
  // - koUsdAmount/koPriceUsd: KO USD position size + USD market price -> shares -> contracts
  // - scenario: {etf,tw,ko,sgov,callPricePerShare} percentages / USD-per-share option quote
  //   (options are always quoted per share; one contract = 100 shares, so a quote of 0.9
  //   means a $90 premium per contract per month)
  // - crash: {y1,m1,y2,m2} only applied when pessimistic is true
  function run(params) {
    var holdings = params.holdings;
    var fx = params.fx;
    var loanMonthly = params.loanMonthly;
    var livingTarget = params.livingTarget;
    var withdrawalRate = params.withdrawalRate;
    var reserveRate = params.reserveRate;
    var shares2887Base = params.shares2887Base;
    var dividendPerShare2887 = params.dividendPerShare2887;
    var stockDividendPerShare2887 = params.stockDividendPerShare2887;
    var s = params.scenario;
    var crashCfg = params.crash;
    var pessimistic = params.pessimistic;
    var koPos = koPosition(params.koUsdAmount, params.koPriceUsd);

    var v = Object.assign({}, holdings);
    var loanAnnual = loanMonthly * 12;
    var loanTotal = loanAnnual * 10;
    var loanPaid = 0;
    var shares2887 = shares2887Base; // running total (base + accumulated whole stock-dividend shares)

    var crash = {};
    if (pessimistic) {
      crash[crashCfg.y1] = crashCfg.m1 / 100;
      crash[crashCfg.y2] = crashCfg.m2 / 100;
    }

    var rows = [];
    for (var yr = 1; yr <= 10; yr++) {
      var etfRet = s.etf / 100;
      if (crash[yr] !== undefined) etfRet = crash[yr];
      var wr = withdrawalRate / 100;

      // 提領為每月月初先扣款、剩餘部位才賺當月報酬（annuity-due），而非年底才領一次，
      // 因此全年提領總額 etfWd 仍是 etfVal*wr，但期末餘額改用月複利公式逐月推算。
      var etfVal = v["0050"] + v["006208"];
      var etfWd = etfVal * wr;
      ["0050", "006208"].forEach(function (k) {
        v[k] = monthlyWithdrawalBalance(v[k], etfRet, wr);
      });

      // 配息與配股都以「當年最新總股數」（原始股數＋歷年累積配股）計算，會逐年成長。
      // 配股：股票股利金額(元) = 目前總股數 × 配股(元/股)；股數 = 股票股利金額 / 面額(10元)。
      // 未滿 1 股的零股改發等值現金（以面額折算），併入當年現金股利，不計入不可售的累積股數。
      var stockDividendValueYuan = shares2887 * stockDividendPerShare2887;
      var newSharesFloat = stockDividendValueYuan / FACE_VALUE_2887;
      var newSharesWhole = Math.floor(newSharesFloat);
      var cashInLieuYuan = (newSharesFloat - newSharesWhole) * FACE_VALUE_2887;

      var div2887 = (shares2887 * dividendPerShare2887 + cashInLieuYuan) / FXk;
      shares2887 += newSharesWhole;
      var shares2887Total = shares2887;
      v["2887"] = v["2887"] * (1 + s.tw / 100);

      var callInc = (koPos.contracts * 100 * s.callPricePerShare * 12 * fx) / FXk;
      v["KO"] = v["KO"] * (1 + s.ko / 100);
      if (crash[yr] !== undefined) v["KO"] *= 1 + crash[yr] * 0.6;

      var sgovInt = v["SGOV"] * (s.sgov / 100);
      v["SGOV"] = v["SGOV"] + sgovInt - loanAnnual;
      if (v["SGOV"] < 0) {
        v["備用金"] += v["SGOV"];
        v["SGOV"] = 0;
      }
      loanPaid += loanAnnual;

      var resRate = reserveRate / 100;
      var resInt = Math.min(v["備用金"], 100) * resRate;
      v["備用金"] += resInt;

      var living = etfWd + div2887 + callInc + resInt;
      var usedRes = 0;
      var gap = livingTarget - living;
      if (gap > 0 && etfRet < -0.05) {
        usedRes = Math.min(gap, v["備用金"]);
        v["備用金"] -= usedRes;
        living += usedRes;
      }

      var assets = Object.values(v).reduce(function (a, b) { return a + b; }, 0);
      var net = assets - (loanTotal - loanPaid);

      rows.push({
        yr: yr, etfRet: etfRet, wr: wr, living: living,
        etf: v["0050"] + v["006208"], ko: v["KO"], s2887: v["2887"],
        sgov: v["SGOV"], res: v["備用金"], assets: assets, net: net,
        call: callInc, etfWd: etfWd, div2887: div2887, resInt: resInt, resRate: resRate,
        usedRes: usedRes, loanPay: loanAnnual, shares2887Total: shares2887Total,
        koShares: koPos.shares, koContracts: koPos.contracts
      });
    }
    return rows;
  }

  return {
    FXk: FXk,
    DEF: DEF,
    clampNumber: clampNumber,
    sanitizeNumber: sanitizeNumber,
    deepClone: deepClone,
    monthlyWithdrawalBalance: monthlyWithdrawalBalance,
    koPosition: koPosition,
    run: run
  };
});
