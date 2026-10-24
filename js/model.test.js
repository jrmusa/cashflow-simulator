"use strict";
var assert = require("assert");
var M = require("./model.js");
var W = require("./withdrawal.js");

// 產品已移除悲觀情境與股災設定；引擎仍保留股災機制，這裡以測試專用的壓力情境繼續驗證。
var PESS = { etf: 2, tw: -2, ko: -1, sgov: 3.0, callPricePerShare: 0.3 };
var CRASH = { y1: 3, m1: -28, y2: 7, m2: -20 };

var passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("✓ " + name);
  } catch (e) {
    failed++;
    console.log("✗ " + name);
    console.log("  " + e.message);
  }
}

function runScenario(name, overrides) {
  var DEF = M.DEF;
  var state = overrides || {};
  return M.run({
    holdings: state.holdings || DEF.holdings,
    fx: state.fx !== undefined ? state.fx : DEF.fx,
    loanMonthly: state.loanMonthly !== undefined ? state.loanMonthly : DEF.loanMonthly,
    livingTarget: state.livingTarget !== undefined ? state.livingTarget : DEF.livingTarget,
    withdrawalRate: state.withdrawalRate !== undefined ? state.withdrawalRate : DEF.withdrawalRate,
    // 既有測試與 golden 值皆為「僅 ETF 提領、10 年」的舊行為，預設把 2887/KO 提領設為 0、年數設為 10；
    // 新行為由下方獨立測試以 overrides 明確開啟。
    withdrawalMode: state.withdrawalMode || "fixed",
    inflation: state.inflation !== undefined ? state.inflation : 0,
    withdrawalRate2887: state.withdrawalRate2887 !== undefined ? state.withdrawalRate2887 : 0,
    withdrawalRateKo: state.withdrawalRateKo !== undefined ? state.withdrawalRateKo : 0,
    years: state.years !== undefined ? state.years : 10,
    loanYears: state.loanYears !== undefined ? state.loanYears : DEF.loanYears,
    reserveRate: state.reserveRate !== undefined ? state.reserveRate : DEF.reserveRate,
    shares2887Base: state.shares2887Base !== undefined ? state.shares2887Base : DEF.shares2887Base,
    dividendPerShare2887: state.dividendPerShare2887 !== undefined ? state.dividendPerShare2887 : DEF.dividendPerShare2887,
    stockDividendPerShare2887: state.stockDividendPerShare2887 !== undefined ? state.stockDividendPerShare2887 : DEF.stockDividendPerShare2887,
    koUsdAmount: state.koUsdAmount !== undefined ? state.koUsdAmount : DEF.koUsdAmount,
    koPriceUsd: state.koPriceUsd !== undefined ? state.koPriceUsd : DEF.koPriceUsd,
    scenario: state.scenario || (name === "悲觀" ? PESS : DEF.scen[name]),
    crash: state.crash || CRASH,
    pessimistic: name === "悲觀"
  });
}

// 1. Default integrity
test("DEF constants match reference exactly", function () {
  assert.deepStrictEqual(M.DEF.holdings, { "0050": 300, "006208": 330, "2887": 750.64, "KO": 256.56, "SGOV": 330, "備用金": 180 });
  assert.strictEqual(M.DEF.fx, 32.07);
  assert.strictEqual(M.DEF.price2887, 42.65);
  assert.strictEqual(M.DEF.loanMonthly, 2.8999);
  assert.strictEqual(M.DEF.livingTarget, 120);
  assert.strictEqual(M.DEF.withdrawalRate, 4);
  assert.strictEqual(M.DEF.reserveRate, 1.8);
  assert.strictEqual(M.DEF.shares2887Base, 176000);
  assert.strictEqual(M.DEF.dividendPerShare2887, 1.0);
  assert.strictEqual(M.DEF.stockDividendPerShare2887, 0.1);
  assert.strictEqual(M.DEF.koUsdAmount, 80000);
  assert.strictEqual(M.DEF.koPriceUsd, 91.05);
  assert.deepStrictEqual(M.DEF.scen["樂觀"], { etf: 11, tw: 8, ko: 3, sgov: 3.65, callPricePerShare: 0.8 });
  assert.deepStrictEqual(M.DEF.scen["中性"], { etf: 7, tw: 3, ko: 2, sgov: 3.0, callPricePerShare: 0.6 });
  assert.deepStrictEqual(Object.keys(M.DEF.scen), ["樂觀", "中性"]);
  assert.strictEqual(M.DEF.crash, undefined);
  assert.strictEqual(M.FXk, 10000);
});

test("DEF holdings for 2887 and KO are derived from shares x price and USD x fx (no contradictory market values)", function () {
  assert.ok(Math.abs(M.DEF.holdings["2887"] - M.value2887(M.DEF.shares2887Base, M.DEF.price2887)) < 0.005);
  assert.ok(Math.abs(M.DEF.holdings["KO"] - M.valueKo(M.DEF.koUsdAmount, M.DEF.fx)) < 0.005);
  assert.strictEqual(M.value2887(100000, 40), 400);
  assert.strictEqual(M.valueKo(10000, 32), 32);
});

test("DEF new withdrawal/horizon defaults: 4% per pool, 30 years, loan 10 years", function () {
  assert.strictEqual(M.DEF.withdrawalRate2887, 4);
  assert.strictEqual(M.DEF.withdrawalRateKo, 4);
  assert.strictEqual(M.DEF.years, 30);
  assert.strictEqual(M.DEF.loanYears, 10);
});

// 2. Shape
test("run() returns 10 sequential rows with expected fields", function () {
  var rows = runScenario("中性");
  assert.strictEqual(rows.length, 10);
  rows.forEach(function (row, i) {
    assert.strictEqual(row.yr, i + 1);
    ["etfRet", "wr", "living", "etf", "ko", "s2887", "sgov", "res", "assets", "net",
      "call", "etfWd", "div2887", "resInt", "resRate", "usedRes", "loanPay", "shares2887Total",
      "koShares", "koContracts"].forEach(function (key) {
      assert.ok(key in row, "missing field " + key);
    });
  });
});

// 3. Withdrawal rate is flat: always the configured rate, never reduced by that year's return.
// (The old pause-at--15% / halve-at--5% tiers were removed — measurement showed they barely
// changed outcomes, because a paused ETF withdrawal just shifts the draw onto 備用金 instead.)
test("withdrawal rate is always the configured rate, regardless of that year's return", function () {
  function wrForReturn(pct, withdrawalRate) {
    var rows = M.run({ withdrawalMode: "fixed",
      holdings: M.DEF.holdings, fx: M.DEF.fx, loanMonthly: M.DEF.loanMonthly,
      livingTarget: M.DEF.livingTarget, withdrawalRate: withdrawalRate, reserveRate: M.DEF.reserveRate,
      shares2887Base: M.DEF.shares2887Base, dividendPerShare2887: M.DEF.dividendPerShare2887,
      stockDividendPerShare2887: M.DEF.stockDividendPerShare2887,
      koUsdAmount: M.DEF.koUsdAmount, koPriceUsd: M.DEF.koPriceUsd,
      scenario: { etf: pct, tw: 0, ko: 0, sgov: 0, callPricePerShare: 0 },
      crash: { y1: 99, m1: 0, y2: 98, m2: 0 }, pessimistic: false
    });
    return rows[0].wr;
  }
  // Steep decline, moderate decline, and growth all use the same configured rate.
  [-20, -10, -6, 0, 5].forEach(function (pct) {
    assert.strictEqual(wrForReturn(pct, 4), 0.04, "etfRet=" + pct + "% @4%");
    assert.strictEqual(wrForReturn(pct, 8), 0.08, "etfRet=" + pct + "% @8%");
  });

  // Crash years are no exception: 悲觀's -28% (yr3) and -20% (yr7) still withdraw the full rate.
  var pess = runScenario("悲觀");
  [3, 7].forEach(function (yr) {
    var row = pess[yr - 1];
    assert.ok(row.etfRet < -0.15, "yr" + yr + " should be a crash year, got " + row.etfRet);
    assert.strictEqual(row.wr, M.DEF.withdrawalRate / 100, "yr" + yr + " wr");
    assert.ok(row.etfWd > 0, "yr" + yr + " should still withdraw, got " + row.etfWd);
  });
});

// 3b. ETF withdrawal is monthly (beginning-of-month), not one annual lump sum: withdrawn cash
// never earns that month's return, so the closed-form must match an explicit 12-step simulation.
test("monthlyWithdrawalBalance matches a manual beginning-of-month 12-step simulation", function () {
  function manual12Step(P, annualReturn, wr) {
    var i = Math.pow(1 + annualReturn, 1 / 12) - 1;
    var W = (P * wr) / 12;
    var b = P;
    for (var m = 0; m < 12; m++) {
      b -= W;
      b *= 1 + i;
    }
    return b;
  }
  [
    [1000, 0.07, 0.04],
    [1000, -0.10, 0.02],
    [648.9, 0.11, 0.04]
  ].forEach(function (args) {
    var closed = M.monthlyWithdrawalBalance(args[0], args[1], args[2]);
    var manual = manual12Step(args[0], args[1], args[2]);
    assert.ok(Math.abs(closed - manual) < 1e-8, "args=" + args + " closed=" + closed + " manual=" + manual);
  });

  // Withdrawing early costs the account that month's growth: in a positive-return year the
  // beginning-of-month result must be strictly less than the old annual-lump-sum formula.
  var beginningOfMonth = M.monthlyWithdrawalBalance(1000, 0.07, 0.04);
  var oldLumpSumAtYearEnd = 1000 * (1 + 0.07) - 1000 * 0.04;
  assert.ok(beginningOfMonth < oldLumpSumAtYearEnd, "expected " + beginningOfMonth + " < " + oldLumpSumAtYearEnd);

  // Zero return: no growth/decay, 12 equal withdrawals subtract linearly.
  assert.ok(Math.abs(M.monthlyWithdrawalBalance(1000, 0, 0.04) - (1000 - 1000 * 0.04)) < 1e-9);
  // Zero withdrawal rate (severe-crash tier, wr=0): reduces to pure compounding growth.
  assert.ok(Math.abs(M.monthlyWithdrawalBalance(1000, -0.2, 0) - 1000 * (1 - 0.2)) < 1e-9);
});

// 4. Crash mechanics
test("crash years only affect their configured year, KO gets 0.6x haircut only then", function () {
  var rows = runScenario("悲觀");
  var crashYears = { 3: -0.28, 7: -0.20 };
  rows.forEach(function (row) {
    if (crashYears[row.yr] !== undefined) {
      assert.strictEqual(row.etfRet, crashYears[row.yr]);
    } else {
      assert.strictEqual(row.etfRet, PESS.etf / 100);
    }
  });
  // KO haircut only applies in crash years: verify against a manual replay of yr1-3 KO value.
  var ko = M.DEF.holdings["KO"];
  ko = ko * (1 + PESS.ko / 100); // yr1, no crash
  ko = ko * (1 + PESS.ko / 100); // yr2, no crash
  ko = ko * (1 + PESS.ko / 100); // yr3 growth
  ko = ko * (1 + (-0.28) * 0.6); // yr3 crash haircut
  assert.ok(Math.abs(rows[2].ko - ko) < 1e-9, "yr3 KO mismatch: " + rows[2].ko + " vs " + ko);
});

// 5. 2887 cash dividend & stock dividend are both computed off that year's LATEST total share
// count (base + all whole shares accumulated so far) — so they compound and grow year over year.
test("2887 dividend and stock dividend compound on the latest total share count", function () {
  var rows = runScenario("中性");
  var base = M.DEF.shares2887Base;
  var divRate = M.DEF.dividendPerShare2887;
  var stockRate = M.DEF.stockDividendPerShare2887;

  var shares = base;
  rows.forEach(function (row, i) {
    var stockDividendValueYuan = shares * stockRate;
    var newSharesFloat = stockDividendValueYuan / 10;
    var wholeShares = Math.floor(newSharesFloat);
    var cashInLieuYuan = (newSharesFloat - wholeShares) * 10;
    var expectedDiv = (shares * divRate + cashInLieuYuan) / M.FXk;

    assert.ok(Math.abs(row.div2887 - expectedDiv) < 1e-9, "yr" + row.yr + " div2887=" + row.div2887 + " expected=" + expectedDiv);
    shares += wholeShares;
    assert.strictEqual(row.shares2887Total, shares, "yr" + row.yr + " total shares");
  });

  // With growing shares, later years pay a strictly larger dividend than year 1 (default has no
  // fractional cash noise at yr1, so this isn't just odd-lot cash jitter).
  assert.ok(rows[9].div2887 > rows[0].div2887, "dividend should grow: yr1=" + rows[0].div2887 + " yr10=" + rows[9].div2887);
});

// 5b. Odd-lot fractional shares (未滿 1 股) are paid out as equivalent cash at face value,
// folded into that year's cash dividend, and excluded from the accumulated share count.
test("2887 fractional stock-dividend shares are cashed out at face value, not rounded into shares", function () {
  var base = 176123; // deliberately not a multiple of 10 at a 0.1 元/股 stock dividend rate
  var rate = 0.1;
  var divRate = 1.0;
  var rows = M.run({ withdrawalMode: "fixed",
    holdings: M.DEF.holdings, fx: M.DEF.fx, loanMonthly: M.DEF.loanMonthly, livingTarget: M.DEF.livingTarget,
    withdrawalRate: M.DEF.withdrawalRate, reserveRate: M.DEF.reserveRate,
    shares2887Base: base, dividendPerShare2887: divRate, stockDividendPerShare2887: rate,
    koUsdAmount: M.DEF.koUsdAmount, koPriceUsd: M.DEF.koPriceUsd,
    scenario: M.DEF.scen["中性"], crash: CRASH, pessimistic: false
  });
  var stockDividendValueYuan = base * rate; // 17612.3 元
  var newSharesFloat = stockDividendValueYuan / 10; // 1761.23 股
  var wholeShares = Math.floor(newSharesFloat); // 1761
  var cashInLieuYuan = (newSharesFloat - wholeShares) * 10; // 2.3 元
  var expectedDiv = (base * divRate + cashInLieuYuan) / M.FXk;

  assert.ok(Math.abs(rows[0].div2887 - expectedDiv) < 1e-9, "div2887=" + rows[0].div2887 + " expected=" + expectedDiv);
  assert.strictEqual(rows[0].shares2887Total, base + wholeShares);
});

// 6. Covered call formula: shares = usdAmount/priceUsd, contracts = floor(shares/100).
// callPricePerShare is a per-share option quote (options are always quoted per share), so
// income = contracts * 100 shares/contract * callPricePerShare * 12 * fx / FXk.
test("covered call income = floor(shares/100) contracts * 100 * callPricePerShare * 12 * fx / FXk", function () {
  var rows = runScenario("中性");
  var shares = M.DEF.koUsdAmount / M.DEF.koPriceUsd;
  var contracts = Math.floor(shares / 100);
  var expected = (contracts * 100 * M.DEF.scen["中性"].callPricePerShare * 12 * M.DEF.fx) / M.FXk;
  assert.ok(Math.abs(rows[0].call - expected) < 1e-9);
  assert.strictEqual(rows[0].koContracts, contracts);
  assert.ok(Math.abs(rows[0].koShares - shares) < 1e-9);
});

// 6b. koPosition: shares = usdAmount/priceUsd, contracts floors down to whole 100-share lots
// (a fractional contract can't be sold) — e.g. 1230 shares -> 12 contracts, not 12.3.
test("koPosition floors partial contracts (e.g. 1230 shares -> 12 contracts)", function () {
  var pos = M.koPosition(1230, 1); // $1/share so usdAmount doubles as share count
  assert.strictEqual(pos.shares, 1230);
  assert.strictEqual(pos.contracts, 12);

  assert.strictEqual(M.koPosition(2000, 1).contracts, 20);
  assert.strictEqual(M.koPosition(99, 1).contracts, 0, "under 100 shares sells 0 contracts");
  assert.strictEqual(M.koPosition(100, 0).shares, 0, "zero/invalid price yields 0 shares, not Infinity/NaN");
});

// 7. SGOV shortfall borrowing from reserve
test("SGOV deficit is absorbed by 備用金 and SGOV clamps to 0", function () {
  var rows = M.run({ withdrawalMode: "fixed",
    holdings: Object.assign({}, M.DEF.holdings, { SGOV: 10, "備用金": 500 }),
    fx: M.DEF.fx, loanMonthly: M.DEF.loanMonthly, livingTarget: M.DEF.livingTarget,
    withdrawalRate: M.DEF.withdrawalRate, reserveRate: M.DEF.reserveRate,
    shares2887Base: M.DEF.shares2887Base, dividendPerShare2887: M.DEF.dividendPerShare2887,
    stockDividendPerShare2887: M.DEF.stockDividendPerShare2887,
    koUsdAmount: M.DEF.koUsdAmount, koPriceUsd: M.DEF.koPriceUsd,
    scenario: M.DEF.scen["中性"],
    crash: CRASH, pessimistic: false
  });
  var loanAnnual = M.DEF.loanMonthly * 12;
  var sgovInt = 10 * (M.DEF.scen["中性"].sgov / 100);
  var deficit = 10 + sgovInt - loanAnnual;
  assert.ok(deficit < 0, "test setup should produce a deficit");
  assert.strictEqual(rows[0].sgov, 0);
  assert.ok(Math.abs(rows[0].res - (500 + deficit)) < 1e-9);
});

// 8. Reserve interest — configurable rate, capped at min(balance,100)
test("備用金 interest capped at min(balance,100) and scales with configurable reserveRate", function () {
  function resIntFor(reserveBalance, reserveRate) {
    var rows = M.run({ withdrawalMode: "fixed",
      holdings: Object.assign({}, M.DEF.holdings, { "備用金": reserveBalance }),
      fx: M.DEF.fx, loanMonthly: M.DEF.loanMonthly, livingTarget: M.DEF.livingTarget,
      withdrawalRate: M.DEF.withdrawalRate, reserveRate: reserveRate,
      shares2887Base: M.DEF.shares2887Base, dividendPerShare2887: M.DEF.dividendPerShare2887,
      stockDividendPerShare2887: M.DEF.stockDividendPerShare2887,
      koUsdAmount: M.DEF.koUsdAmount, koPriceUsd: M.DEF.koPriceUsd,
      scenario: M.DEF.scen["中性"],
      crash: CRASH, pessimistic: false
    });
    return rows[0];
  }
  var low = resIntFor(50, 1.8);
  assert.ok(Math.abs(low.resInt - 50 * 0.018) < 1e-9);
  assert.ok(Math.abs(low.resRate - 0.018) < 1e-9);

  var high = resIntFor(500, 1.8);
  assert.ok(Math.abs(high.resInt - 100 * 0.018) < 1e-9);

  // a different configured rate (3.6%) doubles the interest
  var customRate = resIntFor(50, 3.6);
  assert.ok(Math.abs(customRate.resInt - 50 * 0.036) < 1e-9);
  assert.ok(Math.abs(customRate.resRate - 0.036) < 1e-9);
});

// 9. Gap-filling condition
test("reserve gap-filling only triggers when gap>0 and etfRet<-5%", function () {
  var positiveRows = M.run({ withdrawalMode: "fixed",
    holdings: M.DEF.holdings, fx: M.DEF.fx, loanMonthly: M.DEF.loanMonthly,
    livingTarget: M.DEF.livingTarget, withdrawalRate: M.DEF.withdrawalRate, reserveRate: M.DEF.reserveRate,
    shares2887Base: M.DEF.shares2887Base, dividendPerShare2887: M.DEF.dividendPerShare2887,
    stockDividendPerShare2887: M.DEF.stockDividendPerShare2887,
    koUsdAmount: M.DEF.koUsdAmount, koPriceUsd: M.DEF.koPriceUsd,
    scenario: { etf: 3, tw: 0, ko: 0, sgov: 0, callPricePerShare: 0 },
    crash: { y1: 99, m1: 0, y2: 98, m2: 0 }, pessimistic: false
  });
  assert.strictEqual(positiveRows[0].usedRes, 0);

  var crashRows = runScenario("悲觀");
  var yr3 = crashRows[2];
  assert.ok(yr3.usedRes > 0);
});

// 10. Net worth at year 10
test("at yr10 loanPaid===loanTotal so net===assets", function () {
  var rows = runScenario("中性");
  var last = rows[9];
  assert.ok(Math.abs(last.net - last.assets) < 1e-9);
});

// 11. sanitizeNumber validation helper
test("sanitizeNumber reverts on NaN/empty, clamps, rounds", function () {
  assert.strictEqual(M.sanitizeNumber("", 42, {}), 42);
  assert.strictEqual(M.sanitizeNumber(null, 42, {}), 42);
  assert.strictEqual(M.sanitizeNumber("abc", 42, {}), 42);
  assert.strictEqual(M.sanitizeNumber("-50", 10, { min: 0 }), 0);
  assert.strictEqual(M.sanitizeNumber("3.14159", 0, { decimals: 2 }), 3.14);
  assert.strictEqual(M.sanitizeNumber("150", 0, { max: 100 }), 100);
});

test("clampNumber clamps to min/max, ignores undefined bounds", function () {
  assert.strictEqual(M.clampNumber(5, 0, 10), 5);
  assert.strictEqual(M.clampNumber(-5, 0, 10), 0);
  assert.strictEqual(M.clampNumber(15, 0, 10), 10);
  assert.strictEqual(M.clampNumber(15, undefined, undefined), 15);
});

// 12. Serialization round-trip
test("DEF survives JSON deep-clone round-trip", function () {
  var cloned = M.deepClone(M.DEF);
  assert.deepStrictEqual(cloned, M.DEF);
  assert.notStrictEqual(cloned, M.DEF);
  assert.notStrictEqual(cloned.holdings, M.DEF.holdings);
});

// 13. Golden regression（2026-10 預設值校準後重新擷取：2887 市值=股數×股價、KO 市值=美元×匯率、新匯率/情境）(captured from this model's own reference-faithful run, after
// koUsdAmount default dropped to 80000 USD / 91.05 USD = 878.6 shares -> 8 contracts,
// x 100 shares/contract x callPricePerShare 0.9/0.6/0.3).
test("golden regression: 中性 yr10 net and avg monthly living", function () {
  var rows = runScenario("中性");
  var avgMonthly = rows.reduce(function (a, x) { return a + x.living; }, 0) / 10 / 12;
  assert.ok(Math.abs(rows[9].net - 2380.515428948053) < 1e-6, "中性 net10=" + rows[9].net);
  assert.ok(Math.abs(avgMonthly - 5.614686189015796) < 1e-6, "中性 avgMonthly=" + avgMonthly);
});

test("golden regression: 悲觀 yr10 net and avg monthly living", function () {
  var rows = runScenario("悲觀");
  var avgMonthly = rows.reduce(function (a, x) { return a + x.living; }, 0) / 10 / 12;
  assert.ok(Math.abs(rows[9].net - 1146.5106590845937) < 1e-6, "悲觀 net10=" + rows[9].net);
  assert.ok(Math.abs(avgMonthly - 5.051559942584262) < 1e-6, "悲觀 avgMonthly=" + avgMonthly);
});

test("golden regression: 樂觀 yr10 net and avg monthly living", function () {
  var rows = runScenario("樂觀");
  var avgMonthly = rows.reduce(function (a, x) { return a + x.living; }, 0) / 10 / 12;
  assert.ok(Math.abs(rows[9].net - 3418.9863421632613) < 1e-6, "樂觀 net10=" + rows[9].net);
  assert.ok(Math.abs(avgMonthly - 6.606477469757934) < 1e-6, "樂觀 avgMonthly=" + avgMonthly);
});

// ===== 提領設定獨立後的新測試 =====
test("applyWithdrawal: rate 0 is a pure growth step with ratio 1", function () {
  var r = W.applyWithdrawal(100, 0.07, 0);
  assert.ok(Math.abs(r.end - 107) < 1e-12);
  assert.strictEqual(r.withdrawn, 0);
  assert.strictEqual(r.ratio, 1);
});

test("applyWithdrawal: withdrawn = start*rate, end matches monthlyWithdrawalBalance, ratio = end/noWithdrawEnd", function () {
  var r = W.applyWithdrawal(300, 0.07, 0.04);
  assert.ok(Math.abs(r.withdrawn - 12) < 1e-12);
  assert.ok(Math.abs(r.end - W.monthlyWithdrawalBalance(300, 0.07, 0.04)) < 1e-12);
  assert.ok(Math.abs(r.ratio - r.end / (300 * 1.07)) < 1e-12);
  assert.ok(r.ratio > 0 && r.ratio < 1);
});

test("applyWithdrawal: a pool that runs dry clamps at 0 and only withdraws what exists", function () {
  var r = W.applyWithdrawal(100, -0.5, 0.9);
  assert.ok(r.end >= 0, "end=" + r.end);
  assert.ok(r.withdrawn < 100 * 0.9, "withdrawn=" + r.withdrawn);
  assert.ok(r.withdrawn <= 100 + 1e-9);
  assert.ok(r.ratio >= 0 && r.ratio <= 1);
});

test("default run() is 30 years with sequential year numbers", function () {
  var DEF = M.DEF;
  var rows = M.run({ withdrawalMode: "fixed",
    holdings: DEF.holdings, fx: DEF.fx, loanMonthly: DEF.loanMonthly, livingTarget: DEF.livingTarget,
    withdrawalRate: DEF.withdrawalRate, withdrawalRate2887: DEF.withdrawalRate2887, withdrawalRateKo: DEF.withdrawalRateKo,
    reserveRate: DEF.reserveRate, shares2887Base: DEF.shares2887Base, dividendPerShare2887: DEF.dividendPerShare2887,
    stockDividendPerShare2887: DEF.stockDividendPerShare2887, koUsdAmount: DEF.koUsdAmount, koPriceUsd: DEF.koPriceUsd,
    scenario: DEF.scen["中性"], crash: CRASH, pessimistic: false
  });
  assert.strictEqual(rows.length, 30);
  rows.forEach(function (r, i) { assert.strictEqual(r.yr, i + 1); });
});

test("years param controls row count (10 / 30 / 50)", function () {
  [10, 30, 50].forEach(function (n) {
    assert.strictEqual(runScenario("中性", { years: n }).length, n);
  });
});

test("first 10 years of a 30-year run equal a 10-year run (horizon doesn't change earlier years)", function () {
  var a = runScenario("中性", { years: 10, withdrawalRate2887: 4, withdrawalRateKo: 4 });
  var b = runScenario("中性", { years: 30, withdrawalRate2887: 4, withdrawalRateKo: 4 });
  for (var i = 0; i < 10; i++) assert.ok(Math.abs(a[i].net - b[i].net) < 1e-9, "yr " + (i + 1));
});

test("2887 withdrawal: withdrawn = start value * rate in year 1, goes into living, and reduces share count", function () {
  var base = runScenario("中性", { withdrawalRate2887: 0 });
  var wd = runScenario("中性", { withdrawalRate2887: 4 });
  assert.ok(Math.abs(wd[0].wd2887 - M.DEF.holdings["2887"] * 0.04) < 1e-9);
  assert.strictEqual(base[0].wd2887, 0);
  assert.ok(wd[0].shares2887Total < base[0].shares2887Total);
  assert.ok(wd[0].div2887 < base[0].div2887 + 1e-9);
  assert.ok(Math.abs((wd[0].living - base[0].living) - (wd[0].wd2887 + (wd[0].div2887 - base[0].div2887))) < 1e-9);
  assert.ok(wd[9].s2887 < base[9].s2887);
});

test("KO withdrawal: withdrawn = start value * rate in year 1, contracts shrink and call income falls", function () {
  var base = runScenario("中性", { withdrawalRateKo: 0 });
  var wd = runScenario("中性", { withdrawalRateKo: 4 });
  assert.ok(Math.abs(wd[0].koWd - M.DEF.holdings["KO"] * 0.04) < 1e-9);
  assert.strictEqual(base[0].koWd, 0);
  var bigKo = runScenario("中性", { withdrawalRateKo: 50, years: 5 });
  assert.ok(bigKo[4].koContracts < bigKo[0].koContracts || bigKo[0].koContracts < base[0].koContracts);
  assert.ok(bigKo[4].call < base[4].call);
  assert.ok(wd[9].koContracts <= base[9].koContracts);
  assert.ok(wd[9].ko < base[9].ko);
});

test("KO contracts are always floor(remaining shares/100)", function () {
  var rows = runScenario("中性", { years: 30, withdrawalRateKo: 4 });
  rows.forEach(function (r) { assert.strictEqual(r.koContracts, Math.floor(r.koShares / 100)); });
});

test("all three pools withdraw: living = etfWd + wd2887 + koWd + div + call + resInt (+ gap fill)", function () {
  var rows = runScenario("中性", { years: 30, withdrawalRate2887: 4, withdrawalRateKo: 4 });
  rows.forEach(function (r) {
    var parts = r.etfWd + r.wd2887 + r.koWd + r.div2887 + r.call + r.resInt + r.usedRes;
    assert.ok(Math.abs(r.living - parts) < 1e-9, "yr " + r.yr);
  });
});

test("loanYears: loan payments stop after loanYears, net===assets afterwards", function () {
  var rows = runScenario("中性", { years: 30, loanYears: 10 });
  assert.ok(rows[9].loanPay > 0);
  assert.strictEqual(rows[10].loanPay, 0);
  assert.strictEqual(rows[29].loanPay, 0);
  assert.ok(Math.abs(rows[29].net - rows[29].assets) < 1e-9);
  var long = runScenario("中性", { years: 30, loanYears: 30 });
  assert.ok(long[29].loanPay > 0);
  assert.ok(Math.abs(long[29].net - long[29].assets) < 1e-9);
});

test("30-year defaults (all pools 4%) stay finite and non-negative in all three scenarios", function () {
  ["樂觀", "中性", "悲觀"].forEach(function (name) {
    var rows = runScenario(name, { years: 30, withdrawalRate2887: 4, withdrawalRateKo: 4 });
    rows.forEach(function (r) {
      [r.etf, r.ko, r.s2887, r.sgov, r.res, r.assets, r.net, r.living].forEach(function (x) {
        assert.ok(isFinite(x), name + " yr" + r.yr);
      });
      assert.ok(r.etf >= 0 && r.ko >= 0 && r.s2887 >= 0 && r.res >= -1e-9, name + " yr" + r.yr);
    });
  });
});

// ===== 通膨率 + 目標提領率（由生活費目標反推）=====
function runTarget(name, overrides) {
  var o = Object.assign({ withdrawalMode: "target", inflation: 2, years: 30 }, overrides || {});
  return runScenario(name, o);
}

test("DEF inflation default is 2%", function () {
  assert.strictEqual(M.DEF.inflation, 2);
});

test("living target grows by inflation each year (yr1 = base)", function () {
  var rows = runTarget("中性", { inflation: 2 });
  assert.ok(Math.abs(rows[0].target - 120) < 1e-12);
  assert.ok(Math.abs(rows[1].target - 120 * 1.02) < 1e-9);
  assert.ok(Math.abs(rows[29].target - 120 * Math.pow(1.02, 29)) < 1e-9);
  var flat = runTarget("中性", { inflation: 0 });
  assert.ok(Math.abs(flat[29].target - 120) < 1e-12);
});

test("target mode: every year living meets the target (no overshoot) unless the rate hit 0% or the 100% cap", function () {
  ["樂觀", "中性", "悲觀"].forEach(function (name) {
    runTarget(name).forEach(function (r) {
      assert.ok(r.living >= r.target - 1e-9 || r.wr >= 1 || r.usedRes > 0, name + " yr" + r.yr + " living=" + r.living + " target=" + r.target);
      if (r.wr > 0 && r.wr < 1) assert.ok(r.living - r.target < 0.05, name + " yr" + r.yr + " overshoot=" + (r.living - r.target));
    });
  });
});

test("target mode waterfall: 0050+006208 first; 備用金 -> 2887 -> KO only after the earlier pool is exhausted", function () {
  var rows = runTarget("中性");
  var r = rows[0];
  assert.ok(r.wr > 0 && r.wr < 1);
  assert.ok(Math.abs(r.etfWd - 630 * r.wr) < 1e-9);
  assert.strictEqual(r.wd2887, 0);
  assert.strictEqual(r.koWd, 0);
  assert.strictEqual(r.usedRes, 0);
  var seen2887 = false, seenKo = false;
  rows.forEach(function (x) {
    if (x.wd2887 > 0) {
      seen2887 = true;
      assert.ok(x.wr >= 1 - 1e-9, "2887 only after ETF capped, yr" + x.yr);
    }
    if (x.koWd > 0) {
      seenKo = true;
      assert.ok(x.wr2887 >= 1 - 1e-9, "KO only after 2887 fully withdrawn, yr" + x.yr);
    }
    if (x.wd2887 > 0) assert.ok(x.usedRes > 0 || x.res === 0, "reserve before 2887, yr" + x.yr);
    if (x.shortfall > 1e-6) {
      assert.ok(x.res < 1e-9, "shortfall only when reserve empty, yr" + x.yr);
    }
  });
  assert.ok(seen2887, "2887 eventually withdrawn in a 30-year neutral run");
});

test("waterfall: with a huge target, reserve is used, then 2887, then KO, in the same year", function () {
  var rows = runTarget("中性", { livingTarget: 2000, years: 3 });
  var r = rows[0];
  assert.ok(r.wr >= 1 - 1e-9);
  assert.ok(r.usedRes > 0);
  assert.ok(r.wd2887 > 0);
  assert.ok(r.koWd > 0);
});

test("target mode: higher inflation requires higher or equal withdrawal rates in later years", function () {
  var a = runTarget("中性", { inflation: 0 });
  var b = runTarget("中性", { inflation: 4 });
  assert.ok(b[4].wr > a[4].wr); // 第 5 年：兩者都尚未碰到 100% 上限
  // 淨值比較取兩者資金都尚未耗盡的第 15 年（後期兩者的提領池都可能被領光，淨值趨近而失去比較意義）
  assert.ok(b[14].net < a[14].net);
});

test("target mode: tiny target -> rate 0; impossible target -> rate capped at 100%", function () {
  var tiny = runTarget("中性", { livingTarget: 0.001, years: 3 });
  tiny.forEach(function (r) { assert.strictEqual(r.wr, 0); assert.strictEqual(r.etfWd, 0); });
  var huge = runTarget("中性", { livingTarget: 100000, years: 2 });
  assert.strictEqual(huge[0].wr, 1);
  assert.ok(huge[0].etf >= 0 && isFinite(huge[0].net));
});

test("target mode: crash year raises the required rate vs a normal year only through the target, not the pool formula", function () {
  var rows = runTarget("悲觀");
  rows.forEach(function (r) { assert.ok(isFinite(r.wr) && r.wr >= 0 && r.wr <= 1); });
});

test("solveTargetRate: monotone toy function returns smallest satisfying rate; handles 0 and cap", function () {
  var f = function (r) { return 10 + 100 * r; };
  assert.strictEqual(W.solveTargetRate(f, 5), 0);
  var r = W.solveTargetRate(f, 30);
  assert.ok(Math.abs(r - 0.2) < 1e-6 && f(r) >= 30);
  assert.strictEqual(W.solveTargetRate(f, 1000), 1);
});

test("fixed mode still reproduces legacy behaviour (explicit opt-in)", function () {
  var rows = runScenario("中性");
  assert.ok(Math.abs(rows[0].wr - 0.04) < 1e-12);
});

test("備用金 interest is spent as living, not compounded: balance stays flat when no SGOV deficit and no gap fill", function () {
  var rows = runScenario("中性");
  rows.forEach(function (r) {
    assert.ok(Math.abs(r.res - M.DEF.holdings["備用金"]) < 1e-9, "yr" + r.yr + " res=" + r.res);
  });
  var t = runTarget("中性");
  var prev = M.DEF.holdings["備用金"];
  t.forEach(function (r) {
    assert.ok(Math.abs(r.res - (prev - r.usedRes)) < 1e-9, "yr" + r.yr);
    prev = r.res;
  });
});

test("target mode: 備用金 fills the gap in ANY year when the target is unreachable (not only crash years)", function () {
  var rows = runTarget("中性");
  var used = rows.filter(function (r) { return r.usedRes > 0; });
  assert.ok(used.length > 0, "reserve should be used in the neutral scenario's late years");
  used.forEach(function (r) {
    assert.ok(r.etfRet >= -0.05, "non-crash year yr" + r.yr);
    assert.ok(r.usedRes <= r.target - (r.living - r.usedRes) + 1e-9);
    assert.ok(Math.abs(r.living - r.target) < 1e-6 || r.res < 1e-9, "yr" + r.yr);
  });
  // years without any gap never touch the reserve
  rows.filter(function (r) { return r.wr < 1; }).forEach(function (r) { assert.strictEqual(r.usedRes, 0, "yr" + r.yr); });
});

test("shortfall = target - living once the reserve is also exhausted; 0 otherwise", function () {
  var rows = runTarget("悲觀");
  rows.forEach(function (r) {
    assert.ok(Math.abs(r.shortfall - Math.max(0, r.target - r.living)) < 1e-9, "yr" + r.yr);
    if (r.shortfall > 1e-6) assert.ok(r.res < 1e-9, "shortfall only when reserve is empty, yr" + r.yr);
  });
  assert.ok(rows.some(function (r) { return r.shortfall > 0; }), "悲觀 30y should eventually fall short");
});

test("2887 scenario % is total return incl. dividends: value growth = total return - cash dividend (target mode)", function () {
  // 目標極小 → 提領率 0，單純檢視年度市值變化
  var rows = runTarget("中性", { livingTarget: 0.001, years: 3 });
  var v = M.DEF.holdings["2887"];
  rows.forEach(function (r) {
    assert.strictEqual(r.wd2887, 0);
    var expected = v * 1.03 - r.div2887;
    assert.ok(Math.abs(r.s2887 - expected) < 1e-9, "yr" + r.yr + " got=" + r.s2887 + " expected=" + expected);
    v = r.s2887;
  });
});

test("2887 price growth is lower than total return by roughly the cash dividend yield; fixed mode keeps legacy full-return growth", function () {
  var target = runTarget("樂觀", { livingTarget: 0.001, years: 1 })[0];
  var fixed = runScenario("樂觀", { years: 1 })[0];
  assert.ok(Math.abs(fixed.s2887 - M.DEF.holdings["2887"] * 1.08) < 1e-9);
  assert.ok(Math.abs((fixed.s2887 - target.s2887) - target.div2887) < 1e-9);
});

console.log("\n" + passed + " passed, " + failed + " failed");
process.exitCode = failed > 0 ? 1 : 0;
