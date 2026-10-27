(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.CFMHistory = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ===== 歷史推演：真實歷史年報酬（2004–2025，22 年）=====
  // etf：0050 含息總報酬（還原除權息，havocfuture.tw/0050-performance）
  // tw ：2887 含息總報酬，以 companiesmarketcap 的美元計價還原報酬，按 FRED 每年 12 月 USD/TWD 換回新台幣（近似值）
  // ko ：KO 股價淨漲（不含股息，chartrow.com/quote/ko/returns），與情境的「KO淨漲%」定義一致
  // 同一年三檔一起抽，保留它們之間的連動（例如 2008 年三檔同跌）。
  var HIST = [
    { year: 2004, etf: 5.62, tw: 24.1, ko: -18.0 },
    { year: 2005, etf: 10.03, tw: -16.3, ko: -3.2 },
    { year: 2006, etf: 21.12, tw: 7.1, ko: 19.6 },
    { year: 2007, etf: 10.31, tw: -34.3, ko: 27.2 },
    { year: 2008, etf: -43.32, tw: -55.3, ko: -26.2 },
    { year: 2009, etf: 75.00, tw: 117.5, ko: 25.9 },
    { year: 2010, etf: 13.13, tw: 43.2, ko: 15.4 },
    { year: 2011, etf: -15.81, tw: -37.8, ko: 6.4 },
    { year: 2012, etf: 11.92, tw: 19.0, ko: 3.6 },
    { year: 2013, etf: 11.68, tw: 38.6, ko: 14.0 },
    { year: 2014, etf: 16.66, tw: 1.1, ko: 2.2 },
    { year: 2015, etf: -6.28, tw: -7.5, ko: 1.8 },
    { year: 2016, etf: 19.65, tw: 13.9, ko: -3.5 },
    { year: 2017, etf: 18.14, tw: 28.9, ko: 10.7 },
    { year: 2018, etf: -4.94, tw: 0.5, ko: 3.2 },
    { year: 2019, etf: 33.52, tw: 16.8, ko: 16.9 },
    { year: 2020, etf: 31.14, tw: -3.6, ko: -0.9 },
    { year: 2021, etf: 21.92, tw: 54.6, ko: 8.0 },
    { year: 2022, etf: -21.37, tw: -13.0, ko: 7.4 },
    { year: 2023, etf: 27.45, tw: 31.0, ko: -7.4 },
    { year: 2024, etf: 48.64, tw: 1.2, ko: 5.7 },
    { year: 2025, etf: 36.86, tw: 24.2, ko: 12.3 }
  ];
  var KEYS = ["etf", "tw", "ko"];
  var WINDOW = 10;          // 滾動視窗年數
  var MAX_DOWN_STREAK = 3;  // 同一資產最多連續下跌年數

  // 年化報酬%（幾何平均）
  function cagr(pcts) {
    if (!pcts.length) return 0;
    var g = pcts.reduce(function (p, r) { return p * (1 + r / 100); }, 1);
    return (Math.pow(g, 1 / pcts.length) - 1) * 100;
  }

  // 由真實歷史順序算出每個資產「滾動 10 年年化報酬」的最差與最好值，作為合理範圍。
  function computeBounds(hist, win) {
    hist = hist || HIST; win = win || WINDOW;
    var b = {};
    KEYS.forEach(function (k) {
      var lo = Infinity, hi = -Infinity;
      for (var i = 0; i + win <= hist.length; i++) {
        var c = cagr(hist.slice(i, i + win).map(function (h) { return h[k]; }));
        if (c < lo) lo = c;
        if (c > hi) hi = c;
      }
      b[k] = { min: lo, max: hi };
    });
    return b;
  }
  var BOUNDS = computeBounds();

  function summary(hist) {
    hist = hist || HIST;
    var s = {};
    KEYS.forEach(function (k) { s[k] = cagr(hist.map(function (h) { return h[k]; })); });
    return s;
  }

  // 可重現的亂數（mulberry32）：同一個 seed 一定得到同一條路徑，存檔後重開頁面結果不變。
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // 檢查路徑第 i 年（含）為止是否仍合理：連續下跌 ≤ 3 年、以第 i 年結尾的 10 年年化落在歷史最差～最好之間。
  function okAt(path, i, bounds, win, maxDown) {
    for (var ki = 0; ki < KEYS.length; ki++) {
      var k = KEYS[ki];
      var run = 0;
      for (var j = i; j >= 0 && path[j][k] < 0; j--) run++;
      if (run > maxDown) return false;
      if (i + 1 >= win) {
        var c = cagr(path.slice(i - win + 1, i + 1).map(function (h) { return h[k]; }));
        if (c < bounds[k].min - 1e-9 || c > bounds[k].max + 1e-9) return false;
      }
    }
    return true;
  }

  function isReasonable(path, opts) {
    opts = opts || {};
    var bounds = opts.bounds || BOUNDS, win = opts.window || WINDOW, maxDown = opts.maxDownStreak || MAX_DOWN_STREAK;
    for (var i = 0; i < path.length; i++) if (!okAt(path, i, bounds, win, maxDown)) return false;
    return true;
  }

  // 產生一條 years 年的歷史推演路徑：把 22 個歷史年份隨機重排（每輪 22 年各用一次，超過 22 年再開新一輪），
  // 逐年挑選並回溯（backtracking），排除不合理的組合。回傳 [{year, etf, tw, ko}]。
  function generatePath(years, seed, opts) {
    opts = opts || {};
    var hist = opts.hist || HIST;
    var bounds = opts.bounds || BOUNDS, win = opts.window || WINDOW, maxDown = opts.maxDownStreak || MAX_DOWN_STREAK;
    var rand = rng(typeof seed === "number" ? seed : 1);
    var stepLimit = opts.stepLimit || 5000;

    for (var attempt = 1; attempt <= 200; attempt++) {
      var path = [];
      var steps = 0;
      var dfs = function () {
        if (path.length === years) return true;
        if (++steps > stepLimit) return false;
        var cycleStart = Math.floor(path.length / hist.length) * hist.length;
        var used = {};
        for (var u = cycleStart; u < path.length; u++) used[path[u].year] = true;
        var cand = hist.filter(function (h) { return !used[h.year]; });
        for (var i = cand.length - 1; i > 0; i--) {
          var j = Math.floor(rand() * (i + 1));
          var t = cand[i]; cand[i] = cand[j]; cand[j] = t;
        }
        for (var c = 0; c < cand.length; c++) {
          path.push(cand[c]);
          if (okAt(path, path.length - 1, bounds, win, maxDown) && dfs()) return true;
          path.pop();
          if (steps > stepLimit) return false;
        }
        return false;
      };
      if (dfs()) {
        return path.map(function (h) { return { year: h.year, etf: h.etf, tw: h.tw, ko: h.ko }; });
      }
    }
    return null; // 理論上不會發生（真實歷史本身就是一條合理路徑）
  }

  // KO covered call：每月賣出買權，大漲時股票會被履約，賺不到全部漲幅。
  // 以「每年 KO 淨漲最多 cap%」近似（下跌照算），cap 不是數字則不設限。純函式，不改動原路徑。
  function applyKoCap(path, cap) {
    if (!path) return path;
    return path.map(function (h) {
      var o = { year: h.year, etf: h.etf, tw: h.tw, ko: h.ko };
      if (typeof cap === "number" && isFinite(cap)) o.ko = Math.min(h.ko, cap);
      return o;
    });
  }

  function newSeed() {
    return Math.floor(Math.random() * 4294967296) >>> 0;
  }

  return {
    HIST: HIST,
    KEYS: KEYS,
    WINDOW: WINDOW,
    MAX_DOWN_STREAK: MAX_DOWN_STREAK,
    BOUNDS: BOUNDS,
    cagr: cagr,
    computeBounds: computeBounds,
    summary: summary,
    rng: rng,
    isReasonable: isReasonable,
    generatePath: generatePath,
    applyKoCap: applyKoCap,
    newSeed: newSeed
  };
});
