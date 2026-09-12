"use strict";
var assert = require("assert");
var M = require("./model.js");

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
    reserveRate: state.reserveRate !== undefined ? state.reserveRate : DEF.reserveRate,
    shares2887Base: state.shares2887Base !== undefined ? state.shares2887Base : DEF.shares2887Base,
    dividendPerShare2887: state.dividendPerShare2887 !== undefined ? state.dividendPerShare2887 : DEF.dividendPerShare2887,
    stockDividendPerShare2887: state.stockDividendPerShare2887 !== undefined ? state.stockDividendPerShare2887 : DEF.stockDividendPerShare2887,
    koUsdAmount: state.koUsdAmount !== undefined ? state.koUsdAmount : DEF.koUsdAmount,
    koPriceUsd: state.koPriceUsd !== undefined ? state.koPriceUsd : DEF.koPriceUsd,
    scenario: state.scenario || DEF.scen[name],
    crash: state.crash || DEF.crash,
    pessimistic: name === "悲觀"
  });
}

// 1. Default integrity
test("DEF constants match reference exactly", function () {
  assert.deepStrictEqual(M.DEF.holdings, { "0050": 300, "006208": 330, "2887": 633, "KO": 590, "SGOV": 330, "備用金": 180 });
  assert.strictEqual(M.DEF.fx, 32.4);
  assert.strictEqual(M.DEF.loanMonthly, 2.8999);
  assert.strictEqual(M.DEF.livingTarget, 120);
  assert.strictEqual(M.DEF.withdrawalRate, 4);
  assert.strictEqual(M.DEF.reserveRate, 1.8);
  assert.strictEqual(M.DEF.shares2887Base, 176000);
  assert.strictEqual(M.DEF.dividendPerShare2887, 1.0);
  assert.strictEqual(M.DEF.stockDividendPerShare2887, 0.1);
  assert.strictEqual(M.DEF.koUsdAmount, 182100);
  assert.strictEqual(M.DEF.koPriceUsd, 91.05);
  assert.deepStrictEqual(M.DEF.scen["樂觀"], { etf: 11, tw: 8, ko: 6, sgov: 3.8, callPricePerShare: 0.9 });
  assert.deepStrictEqual(M.DEF.scen["中性"], { etf: 7, tw: 3, ko: 2, sgov: 3.5, callPricePerShare: 0.6 });
  assert.deepStrictEqual(M.DEF.scen["悲觀"], { etf: 2, tw: -2, ko: -1, sgov: 3.0, callPricePerShare: 0.3 });
  assert.deepStrictEqual(M.DEF.crash, { y1: 3, m1: -28, y2: 7, m2: -20 });
  assert.strictEqual(M.FXk, 10000);
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
    var rows = M.run({
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
      assert.strictEqual(row.etfRet, M.DEF.scen["悲觀"].etf / 100);
    }
  });
  // KO haircut only applies in crash years: verify against a manual replay of yr1-3 KO value.
  var ko = M.DEF.holdings["KO"];
  ko = ko * (1 + M.DEF.scen["悲觀"].ko / 100); // yr1, no crash
  ko = ko * (1 + M.DEF.scen["悲觀"].ko / 100); // yr2, no crash
  ko = ko * (1 + M.DEF.scen["悲觀"].ko / 100); // yr3 growth
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
  var rows = M.run({
    holdings: M.DEF.holdings, fx: M.DEF.fx, loanMonthly: M.DEF.loanMonthly, livingTarget: M.DEF.livingTarget,
    withdrawalRate: M.DEF.withdrawalRate, reserveRate: M.DEF.reserveRate,
    shares2887Base: base, dividendPerShare2887: divRate, stockDividendPerShare2887: rate,
    koUsdAmount: M.DEF.koUsdAmount, koPriceUsd: M.DEF.koPriceUsd,
    scenario: M.DEF.scen["中性"], crash: M.DEF.crash, pessimistic: false
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
  var rows = M.run({
    holdings: Object.assign({}, M.DEF.holdings, { SGOV: 10, "備用金": 500 }),
    fx: M.DEF.fx, loanMonthly: M.DEF.loanMonthly, livingTarget: M.DEF.livingTarget,
    withdrawalRate: M.DEF.withdrawalRate, reserveRate: M.DEF.reserveRate,
    shares2887Base: M.DEF.shares2887Base, dividendPerShare2887: M.DEF.dividendPerShare2887,
    stockDividendPerShare2887: M.DEF.stockDividendPerShare2887,
    koUsdAmount: M.DEF.koUsdAmount, koPriceUsd: M.DEF.koPriceUsd,
    scenario: M.DEF.scen["中性"],
    crash: M.DEF.crash, pessimistic: false
  });
  var loanAnnual = M.DEF.loanMonthly * 12;
  var sgovInt = 10 * (M.DEF.scen["中性"].sgov / 100);
  var deficit = 10 + sgovInt - loanAnnual;
  assert.ok(deficit < 0, "test setup should produce a deficit");
  assert.strictEqual(rows[0].sgov, 0);
  assert.ok(Math.abs(rows[0].res - (500 + deficit + rows[0].resInt)) < 1e-9);
});

// 8. Reserve interest — configurable rate, capped at min(balance,100)
test("備用金 interest capped at min(balance,100) and scales with configurable reserveRate", function () {
  function resIntFor(reserveBalance, reserveRate) {
    var rows = M.run({
      holdings: Object.assign({}, M.DEF.holdings, { "備用金": reserveBalance }),
      fx: M.DEF.fx, loanMonthly: M.DEF.loanMonthly, livingTarget: M.DEF.livingTarget,
      withdrawalRate: M.DEF.withdrawalRate, reserveRate: reserveRate,
      shares2887Base: M.DEF.shares2887Base, dividendPerShare2887: M.DEF.dividendPerShare2887,
      stockDividendPerShare2887: M.DEF.stockDividendPerShare2887,
      koUsdAmount: M.DEF.koUsdAmount, koPriceUsd: M.DEF.koPriceUsd,
      scenario: M.DEF.scen["中性"],
      crash: M.DEF.crash, pessimistic: false
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
  var positiveRows = M.run({
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

// 13. Golden regression (captured from this model's own reference-faithful run, after
// KO covered call moved to shares/contracts x per-share option quote: 182100 USD / 91.05
// USD = 2000 shares -> 20 contracts, x 100 shares/contract x callPricePerShare 0.9/0.6/0.3).
test("golden regression: 中性 yr10 net and avg monthly living", function () {
  var rows = runScenario("中性");
  var avgMonthly = rows.reduce(function (a, x) { return a + x.living; }, 0) / 10 / 12;
  assert.ok(Math.abs(rows[9].net - 2659.574630373271) < 1e-6, "中性 net10=" + rows[9].net);
  assert.ok(Math.abs(avgMonthly - 7.963326189015795) < 1e-6, "中性 avgMonthly=" + avgMonthly);
});

test("golden regression: 悲觀 yr10 net and avg monthly living", function () {
  var rows = runScenario("悲觀");
  var avgMonthly = rows.reduce(function (a, x) { return a + x.living; }, 0) / 10 / 12;
  assert.ok(Math.abs(rows[9].net - 1316.3202873151206) < 1e-6, "悲觀 net10=" + rows[9].net);
  assert.ok(Math.abs(avgMonthly - 6.010014569363573) < 1e-6, "悲觀 avgMonthly=" + avgMonthly);
});

test("golden regression: 樂觀 yr10 net and avg monthly living", function () {
  var rows = runScenario("樂觀");
  var avgMonthly = rows.reduce(function (a, x) { return a + x.living; }, 0) / 10 / 12;
  assert.ok(Math.abs(rows[9].net - 3898.8308566049614) < 1e-6, "樂觀 net10=" + rows[9].net);
  assert.ok(Math.abs(avgMonthly - 10.385997469757934) < 1e-6, "樂觀 avgMonthly=" + avgMonthly);
});

console.log("\n" + passed + " passed, " + failed + " failed");
process.exitCode = failed > 0 ? 1 : 0;
