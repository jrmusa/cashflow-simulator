(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.CFMWithdrawal = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // 提領邏輯（獨立模組）：適用於 0050+006208、2887、KO 三個提領池。
  // 每月月初先扣款、剩餘部位才賺當月報酬（annuity-due），全年提領額 = 年初市值 × 提領%，
  // 不隨當年漲跌調整。

  // 提領設定預設值（%）。三個池各自獨立設定；推演年數與全域無關，亦放在此處管理。
  var WITHDRAWAL_DEF = {
    // 舊版「固定提領率」（保留給 withdrawalMode:"fixed" 的對照／回歸測試；介面已改為目標提領率）
    withdrawalRate: 4,        // 0050 + 006208
    withdrawalRate2887: 4,    // 2887
    withdrawalRateKo: 4,      // KO
    inflation: 2,             // 通膨率%：月生活費目標逐年成長
    years: 30                 // 推演年數
  };
  var MAX_YEARS = 50;

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

  // 套用一年的「提領＋報酬」，回傳：
  // - end：期末餘額（不會低於 0；30 年長期推演時若提領池被領完，後續每月只領得到剩下的餘額）
  // - withdrawn：全年實際提領金額
  // - ratio：期末剩餘股數 ÷ 若完全不提領的股數。價格漲跌對有無提領一視同仁，
  //   因此剩餘股數比例 = 有提領餘額 ÷ 無提領餘額（供 2887 股數、KO 口數隨提領縮減使用）。
  function applyWithdrawal(startBalance, annualReturn, annualWithdrawalRate) {
    if (!(annualWithdrawalRate > 0) || !(startBalance > 0)) {
      return { end: startBalance * (1 + annualReturn), withdrawn: 0, ratio: 1 };
    }
    var closed = monthlyWithdrawalBalance(startBalance, annualReturn, annualWithdrawalRate);
    var end, withdrawn;
    if (closed >= 0) {
      end = closed;
      withdrawn = startBalance * annualWithdrawalRate;
    } else {
      // 池子在年內被領完：逐月模擬，每月最多只能領走現有餘額。
      var monthlyRate = Math.pow(1 + annualReturn, 1 / 12) - 1;
      var planned = (startBalance * annualWithdrawalRate) / 12;
      var bal = startBalance;
      withdrawn = 0;
      for (var m = 0; m < 12; m++) {
        var take = Math.min(planned, bal);
        bal -= take;
        withdrawn += take;
        bal *= 1 + monthlyRate;
      }
      end = bal;
    }
    var noWithdrawEnd = startBalance * (1 + annualReturn);
    var ratio = noWithdrawEnd > 0 ? Math.min(1, Math.max(0, end / noWithdrawEnd)) : 0;
    return { end: end, withdrawn: withdrawn, ratio: ratio };
  }

  // 目標提領率：找出「最小」的統一提領率 r（小數，0~1），使 livingAt(r) >= target。
  // livingAt(r) 為該年度在提領率 r 下的生活費合計（單調遞增為主，但 2887 股數 / KO 口數取整數會
  // 造成微小的向下跳階，因此先以細網格由小到大掃描找出第一個達標區間，再於區間內二分逼近，
  // 保證回傳值達標（livingAt(hi) >= target）且不會多領。
  // - 不提領就已達標 → 0
  // - 100% 仍無法達標 → 1（上限）
  var SCAN_STEPS = 2000;
  function solveTargetRate(livingAt, target) {
    if (livingAt(0) >= target) return 0;
    var lo = 0, hi = -1;
    for (var i = 1; i <= SCAN_STEPS; i++) {
      var r = i / SCAN_STEPS;
      if (livingAt(r) >= target) { hi = r; lo = (i - 1) / SCAN_STEPS; break; }
    }
    if (hi < 0) return 1;
    for (var k = 0; k < 50; k++) {
      var mid = (lo + hi) / 2;
      if (livingAt(mid) >= target) hi = mid; else lo = mid;
    }
    return hi;
  }

  return {
    solveTargetRate: solveTargetRate,
    WITHDRAWAL_DEF: WITHDRAWAL_DEF,
    MAX_YEARS: MAX_YEARS,
    monthlyWithdrawalBalance: monthlyWithdrawalBalance,
    applyWithdrawal: applyWithdrawal
  };
});
