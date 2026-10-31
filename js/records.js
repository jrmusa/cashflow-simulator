(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.CFMRecords = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ===== 資料庫：每年記錄一次「第 1 年樂觀情境」的現金流與資產淨值 =====
  // 檔案格式：{ app, version, records: [{ year, savedAt, scenario, values: {...} }] }，依年份由小到大排序。
  var APP = "現金流製造機";
  var VERSION = 1;
  var MIN_YEAR = 1900, MAX_YEAR = 2200;

  // 欄位定義：key 對應 model.run() 的列欄位；group 決定表格分組；scale/fmt 控制顯示。
  var FIELDS = [
    { key: "targetMonthly", label: "月生活費目標", group: "cash", decimals: 2 },
    { key: "wd2887", label: "2887 提領", group: "cash", decimals: 1 },
    { key: "vtWd", label: "VT 提領", group: "cash", decimals: 1 },
    { key: "etfWd", label: "0050+006208 提領", group: "cash", decimals: 1 },
    { key: "koWd", label: "KO 提領", group: "cash", decimals: 1 },
    { key: "div2887", label: "2887 現金股利", group: "cash", decimals: 1 },
    { key: "call", label: "KO Covered Call", group: "cash", decimals: 1 },
    { key: "usdInt", label: "美元定存利息", group: "cash", decimals: 1 },
    { key: "resInt", label: "備用金利息", group: "cash", decimals: 1 },
    { key: "usedRes", label: "備用金補缺口", group: "cash", decimals: 1 },
    { key: "usedUsd", label: "美元定存本金補缺", group: "cash", decimals: 1 },
    { key: "living", label: "生活費合計", group: "cash", decimals: 1 },
    { key: "shortfall", label: "未達標缺口", group: "cash", decimals: 1 },
    { key: "loanPay", label: "SGOV→還貸", group: "cash", decimals: 1 },
    { key: "etf", label: "ETF 值", group: "asset", decimals: 0 },
    { key: "vt", label: "VT 值", group: "asset", decimals: 0 },
    { key: "ko", label: "KO 值", group: "asset", decimals: 0 },
    { key: "koContracts", label: "KO 口數", group: "asset", decimals: 0 },
    { key: "s2887", label: "2887 值", group: "asset", decimals: 0 },
    { key: "shares2887Total", label: "2887 總股數", group: "asset", decimals: 0 },
    { key: "sgov", label: "SGOV", group: "asset", decimals: 0 },
    { key: "usd", label: "美元定存", group: "asset", decimals: 0 },
    { key: "res", label: "備用金", group: "asset", decimals: 0 },
    { key: "assets", label: "總資產", group: "asset", decimals: 0 },
    { key: "net", label: "淨值", group: "asset", decimals: 0 }
  ];

  function isValidYear(y) {
    return typeof y === "number" && isFinite(y) && Math.floor(y) === y && y >= MIN_YEAR && y <= MAX_YEAR;
  }

  // 使用者輸入的年份字串 → 整數年份；不合法回傳 null。
  function parseYear(raw) {
    if (raw === null || raw === undefined) return null;
    var s = String(raw).trim();
    if (!/^\d{4}$/.test(s)) return null;
    var y = parseInt(s, 10);
    return isValidYear(y) ? y : null;
  }

  // 由 model.run() 的第 1 年列建立一筆記錄（只保留 FIELDS 中的欄位，避免存入不相關資料）。
  function snapshot(row, year, savedAt) {
    if (!row) throw new Error("沒有可記錄的結果");
    if (!isValidYear(year)) throw new Error("年份不合法");
    var values = {};
    FIELDS.forEach(function (f) {
      var v = f.key === "targetMonthly" ? row.target / 12 : row[f.key];
      values[f.key] = typeof v === "number" && isFinite(v) ? v : 0;
    });
    return { year: year, savedAt: savedAt || new Date().toISOString(), scenario: "樂觀", values: values };
  }

  function sortRecords(list) {
    return list.slice().sort(function (a, b) { return a.year - b.year; });
  }

  function hasYear(list, year) {
    return list.some(function (r) { return r.year === year; });
  }

  // 新增或覆蓋（同年份）一筆記錄，回傳新的排序後陣列；不改動原陣列。
  function upsert(list, record) {
    var out = list.filter(function (r) { return r.year !== record.year; });
    out.push(record);
    return sortRecords(out);
  }

  function removeYears(list, years) {
    var set = {};
    (years || []).forEach(function (y) { set[y] = true; });
    return list.filter(function (r) { return !set[r.year]; });
  }

  function toFileObject(list) {
    return { app: APP, version: VERSION, records: sortRecords(list) };
  }

  function serialize(list) {
    return JSON.stringify(toFileObject(list), null, 2);
  }

  // 解析使用者選的 JSON：接受本程式格式或直接是記錄陣列；年份重複時以後出現者為準。
  // 不合法的列會被略過並計入 skipped；整份格式錯誤則丟出錯誤。
  function parse(text) {
    var data;
    try { data = JSON.parse(text); } catch (e) { throw new Error("不是有效的 JSON 檔"); }
    var arr = Array.isArray(data) ? data : (data && Array.isArray(data.records) ? data.records : null);
    if (!arr) throw new Error("找不到記錄資料（需要 records 陣列）");
    var out = [], skipped = 0;
    arr.forEach(function (r) {
      var year = r && typeof r.year === "string" ? parseYear(r.year) : r && r.year;
      if (!r || !isValidYear(year) || !r.values || typeof r.values !== "object") { skipped++; return; }
      var values = {};
      FIELDS.forEach(function (f) {
        var v = typeof r.values[f.key] === "string" ? parseFloat(r.values[f.key]) : r.values[f.key];
        values[f.key] = typeof v === "number" && isFinite(v) ? v : 0;
      });
      out = upsert(out, { year: year, savedAt: typeof r.savedAt === "string" ? r.savedAt : "", scenario: r.scenario || "樂觀", values: values });
    });
    return { records: out, skipped: skipped };
  }

  return {
    APP: APP,
    VERSION: VERSION,
    FIELDS: FIELDS,
    MIN_YEAR: MIN_YEAR,
    MAX_YEAR: MAX_YEAR,
    isValidYear: isValidYear,
    parseYear: parseYear,
    snapshot: snapshot,
    sortRecords: sortRecords,
    hasYear: hasYear,
    upsert: upsert,
    removeYears: removeYears,
    toFileObject: toFileObject,
    serialize: serialize,
    parse: parse
  };
});
