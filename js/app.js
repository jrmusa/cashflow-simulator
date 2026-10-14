(function () {
  "use strict";

  var STORAGE_KEY = "cfm";
  var THEME_KEY = "cfm-theme";
  var SCEN_COLORS = { "樂觀": "#34C759", "中性": "#8E8E93" };
  var HOLDING_COLORS = ["#0A84FF", "#34C759", "#FF9F0A", "#FF375F", "#BF5AF2", "#8E8E93"];

  // KO 每股市價即時報價（Finnhub 免費額度）。Key 綁定固定網域使用，屬公開唯讀報價 API。
  var FINNHUB_TOKEN = "daifkl1r01qr9o8h2jdgdaifkl1r01qr9o8h2je0";
  var FINNHUB_SYMBOL = "KO";

  function roundTo(v, decimals) {
    if (typeof decimals !== "number") return v;
    var factor = Math.pow(10, decimals);
    return Math.round(v * factor) / factor;
  }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function loadTheme() {
    try {
      var t = localStorage.getItem(THEME_KEY);
      if (t === "light" || t === "dark") return t;
    } catch (e) {}
    return "light";
  }
  function saveTheme(theme) {
    try { localStorage.setItem(THEME_KEY, theme); } catch (e) {}
  }
  // Applied synchronously, before any rendering, so the page never flashes the wrong theme.
  document.documentElement.setAttribute("data-theme", loadTheme());

  function loadState() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        // Guard against a stale localStorage shape from before the 2887
        // dividend/stock-dividend split — fall back to fresh defaults instead
        // of running with undefined fields.
        if (parsed && typeof parsed.withdrawalRate === "number" && typeof parsed.reserveRate === "number") {
          // Migrate state saved before KO covered call became shares/contracts-based
          // (總投入金額 ÷ 每股市價 → 股數 → 口數 × 每口報價 × 100股), so older
          // localStorage doesn't end up with undefined koUsdAmount/koPriceUsd/callPricePerShare.
          if (typeof parsed.koUsdAmount !== "number") parsed.koUsdAmount = CFMModel.DEF.koUsdAmount;
          if (typeof parsed.koPriceUsd !== "number") parsed.koPriceUsd = CFMModel.DEF.koPriceUsd;
          Object.keys(CFMModel.DEF.scen).forEach(function (name) {
            var scenario = parsed.scen && parsed.scen[name];
            if (scenario && typeof scenario.callPricePerShare !== "number") {
              scenario.callPricePerShare = CFMModel.DEF.scen[name].callPricePerShare;
              delete scenario.call;
              delete scenario.callPerContract;
            }
          });
          // 提領設定獨立後新增的欄位（通膨率、推演年數、貸款年限）：舊資料補預設值。
          ["inflation", "years", "loanYears"].forEach(function (k) {
            if (typeof parsed[k] !== "number") parsed[k] = CFMModel.DEF[k];
          });
          // 悲觀情境與股災設定已移除：清掉舊 localStorage 內的殘留資料。
          if (parsed.scen) delete parsed.scen["悲觀"];
          delete parsed.crash;
          // holdings.KO used to be a manually-entered market value; it's now always derived
          // from 總投入金額(USD) × 匯率, so stale/manual values are recomputed on load.
          parsed.holdings = parsed.holdings || {};
          parsed.holdings["KO"] = (parsed.koUsdAmount * parsed.fx) / CFMModel.FXk;
          return parsed;
        }
      }
    } catch (e) {}
    return CFMModel.deepClone(CFMModel.DEF);
  }

  function saveState() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(S)); } catch (e) {}
  }

  var S = loadState();
  var recalcTimer = null;
  function scheduleRecalc() {
    saveState();
    if (recalcTimer) clearTimeout(recalcTimer);
    recalcTimer = setTimeout(calc, 200);
  }

  // ===== Stepper input component =====
  // cfg: {id,label,value,min,max,step,decimals,onChange,formatDisplay,hideLabel,compactWidth}
  function createStepperInput(cfg) {
    var current = cfg.value;

    var control = document.createElement("div");
    control.className = "stepper-field__control";

    var minusBtn = document.createElement("button");
    minusBtn.type = "button";
    minusBtn.className = "stepper-btn stepper-btn--minus";
    minusBtn.setAttribute("aria-label", "減少");
    minusBtn.textContent = "−";

    var input = document.createElement("input");
    input.type = "text";
    input.inputMode = "decimal";
    input.className = "stepper-field__input";
    input.id = "input-" + cfg.id;
    if (cfg.compactWidth) input.classList.add("scen-input");

    var plusBtn = document.createElement("button");
    plusBtn.type = "button";
    plusBtn.className = "stepper-btn stepper-btn--plus";
    plusBtn.setAttribute("aria-label", "增加");
    plusBtn.textContent = "＋";

    control.appendChild(minusBtn);
    control.appendChild(input);
    control.appendChild(plusBtn);

    var el = control;
    if (!cfg.hideLabel) {
      var wrapper = document.createElement("div");
      wrapper.className = "stepper-field";
      wrapper.dataset.id = cfg.id;
      var label = document.createElement("label");
      label.className = "stepper-field__label";
      label.setAttribute("for", input.id);
      label.textContent = cfg.label;
      wrapper.appendChild(label);
      wrapper.appendChild(control);
      el = wrapper;
    }

    function display(v) {
      return cfg.formatDisplay ? cfg.formatDisplay(v) : String(v);
    }
    function refreshButtons() {
      minusBtn.disabled = typeof cfg.min === "number" && current <= cfg.min;
      plusBtn.disabled = typeof cfg.max === "number" && current >= cfg.max;
    }
    function setValue(v, opts) {
      current = v;
      input.value = display(current);
      refreshButtons();
      if (!(opts && opts.silent) && cfg.onChange) cfg.onChange(current);
    }

    input.value = display(current);
    refreshButtons();

    minusBtn.addEventListener("click", function () {
      var next = CFMModel.clampNumber(roundTo(current - cfg.step, cfg.decimals), cfg.min, cfg.max);
      setValue(next);
    });
    plusBtn.addEventListener("click", function () {
      var next = CFMModel.clampNumber(roundTo(current + cfg.step, cfg.decimals), cfg.min, cfg.max);
      setValue(next);
    });
    function commit() {
      var raw = input.value.replace(/,/g, "");
      var next = CFMModel.sanitizeNumber(raw, current, { min: cfg.min, max: cfg.max, decimals: cfg.decimals });
      setValue(next);
    }
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") input.blur();
    });

    return { el: el, setValue: setValue, getValue: function () { return current; } };
  }

  // ===== Input builders (grouped by cash-flow role) =====
  function buildEtfInputs() {
    var container = document.getElementById("etfInputs");
    container.innerHTML = "";
    ["0050", "006208"].forEach(function (key) {
      var field = createStepperInput({
        id: "h_" + key, label: key, value: S.holdings[key],
        min: 0, step: 10, decimals: 0,
        onChange: function (v) { S.holdings[key] = v; scheduleRecalc(); }
      });
      container.appendChild(field.el);
    });
  }

  // ===== 提領設定（獨立分頁）：月生活費目標、通膨率、推演年數 =====
  function buildWithdrawalInputs() {
    var container = document.getElementById("withdrawalInputs");
    container.innerHTML = "";
    container.appendChild(createStepperInput({
      id: "g_lt", label: "月生活費目標(萬)", value: roundTo(S.livingTarget / 12, 1), min: 0, step: 1, decimals: 1,
      onChange: function (v) { S.livingTarget = v * 12; scheduleRecalc(); }
    }).el);
    container.appendChild(createStepperInput({
      id: "g_infl", label: "通膨率%", value: S.inflation, min: 0, max: 30, step: 0.5, decimals: 1,
      onChange: function (v) { S.inflation = v; scheduleRecalc(); }
    }).el);
  }

  function buildHorizonInputs() {
    var container = document.getElementById("horizonInputs");
    container.innerHTML = "";
    container.appendChild(createStepperInput({
      id: "g_years", label: "推演年數", value: S.years, min: 1, max: CFMWithdrawal.MAX_YEARS, step: 1, decimals: 0,
      onChange: function (v) { S.years = v; scheduleRecalc(); }
    }).el);
  }

  function build2887Inputs() {
    var container = document.getElementById("s2887Inputs");
    container.innerHTML = "";
    var configs = [
      { id: "h_2887", label: "市值(萬)", value: S.holdings["2887"], min: 0, step: 10, decimals: 0,
        onChange: function (v) { S.holdings["2887"] = v; scheduleRecalc(); } },
      { id: "s2887_base", label: "原始股數", value: S.shares2887Base, min: 0, step: 1000, decimals: 0,
        formatDisplay: function (v) { return v.toLocaleString(); },
        onChange: function (v) { S.shares2887Base = v; scheduleRecalc(); } },
      { id: "s2887_div", label: "平均年配息(元/股)", value: S.dividendPerShare2887, min: 0, step: 0.1, decimals: 2,
        onChange: function (v) { S.dividendPerShare2887 = v; scheduleRecalc(); } },
      { id: "s2887_grant", label: "平均年配股(元)", value: S.stockDividendPerShare2887, min: 0, step: 0.1, decimals: 2,
        onChange: function (v) { S.stockDividendPerShare2887 = v; scheduleRecalc(); } }
    ];
    configs.forEach(function (cfg) {
      container.appendChild(createStepperInput(cfg).el);
    });
  }

  // holdings["KO"] is no longer entered directly — it's the TWD-萬 market value used for
  // pie-chart / net-worth compounding, derived from the USD position so there's one source
  // of truth: 總投入金額(USD) × 匯率.
  function syncKoHoldingValue() {
    S.holdings["KO"] = (S.koUsdAmount * S.fx) / CFMModel.FXk;
  }

  var koInfoEl = null;
  function updateKoInfo() {
    if (!koInfoEl) return;
    var pos = CFMModel.koPosition(S.koUsdAmount, S.koPriceUsd);
    koInfoEl.textContent = "自動計算：約 " + Math.round(pos.shares).toLocaleString() + " 股 → " +
      pos.contracts + " 口（股數 = 總投入金額 ÷ 每股市價；口數 = 股數 ÷ 100，無條件捨去）";
  }

  // ===== KO 每股市價：即時報價（Finnhub），失敗時沿用上次成功值/預設值 =====
  var koPriceValueEl = null, koPriceMetaEl = null, koRefreshBtnEl = null;

  function formatClockTime(date) {
    var pad = function (n) { return n < 10 ? "0" + n : String(n); };
    return pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds());
  }

  function setKoPriceUiState(state) {
    if (!koPriceValueEl) return;
    if (state.status === "loading") {
      koPriceValueEl.textContent = "擷取中…";
      koPriceValueEl.classList.remove("is-error");
      koPriceMetaEl.textContent = "正在向 Finnhub 取得即時報價";
      koRefreshBtnEl.classList.add("is-loading");
      koRefreshBtnEl.disabled = true;
    } else if (state.status === "ok") {
      koPriceValueEl.textContent = "US$ " + state.price.toFixed(2);
      koPriceValueEl.classList.remove("is-error");
      koPriceMetaEl.textContent = "即時報價・更新於 " + formatClockTime(state.time);
      koRefreshBtnEl.classList.remove("is-loading");
      koRefreshBtnEl.disabled = false;
    } else if (state.status === "error") {
      koPriceValueEl.textContent = "US$ " + S.koPriceUsd.toFixed(2);
      koPriceValueEl.classList.add("is-error");
      koPriceMetaEl.textContent = "取得失敗，暫用上次數值（" + state.reason + "，點擊重試）";
      koRefreshBtnEl.classList.remove("is-loading");
      koRefreshBtnEl.disabled = false;
    }
  }

  function fetchKoPrice() {
    setKoPriceUiState({ status: "loading" });
    fetch("https://finnhub.io/api/v1/quote?symbol=" + FINNHUB_SYMBOL + "&token=" + FINNHUB_TOKEN)
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        // Finnhub 回傳 c=0 代表查無報價（symbol 錯誤或非交易時段的極端情況）
        if (typeof data.c !== "number" || data.c <= 0) throw new Error("無報價資料");
        S.koPriceUsd = data.c;
        syncKoHoldingValue();
        updateKoInfo();
        setKoPriceUiState({ status: "ok", price: data.c, time: new Date() });
        scheduleRecalc();
      })
      .catch(function (err) {
        setKoPriceUiState({ status: "error", reason: err.message || "網路錯誤" });
      });
  }

  function buildKoInputs() {
    var container = document.getElementById("koInputs");
    container.innerHTML = "";

    var priceRow = document.createElement("div");
    priceRow.className = "stepper-field ko-price-field";
    var labelCol = document.createElement("div");
    labelCol.className = "ko-price-field__label-col";
    var labelEl = document.createElement("span");
    labelEl.className = "stepper-field__label";
    labelEl.textContent = "每股市價";
    var metaEl = document.createElement("span");
    metaEl.className = "ko-price-field__meta small";
    labelCol.appendChild(labelEl);
    labelCol.appendChild(metaEl);

    var valueCol = document.createElement("div");
    valueCol.className = "ko-price-field__value-col";
    var valueEl = document.createElement("span");
    valueEl.className = "ko-price-field__value";
    var refreshBtn = document.createElement("button");
    refreshBtn.type = "button";
    refreshBtn.className = "ko-refresh-btn";
    refreshBtn.setAttribute("aria-label", "重新整理股價");
    refreshBtn.textContent = "⟳";
    refreshBtn.addEventListener("click", fetchKoPrice);
    valueCol.appendChild(valueEl);
    valueCol.appendChild(refreshBtn);

    priceRow.appendChild(labelCol);
    priceRow.appendChild(valueCol);
    container.appendChild(priceRow);

    koPriceValueEl = valueEl;
    koPriceMetaEl = metaEl;
    koRefreshBtnEl = refreshBtn;
    valueEl.textContent = "US$ " + S.koPriceUsd.toFixed(2);
    metaEl.textContent = "尚未取得即時報價";

    var usdField = createStepperInput({
      id: "h_KO_usdAmount", label: "總投入金額", value: S.koUsdAmount,
      min: 0, step: 1000, decimals: 0,
      formatDisplay: function (v) { return v.toLocaleString(); },
      onChange: function (v) { S.koUsdAmount = v; syncKoHoldingValue(); updateKoInfo(); scheduleRecalc(); }
    });
    container.appendChild(usdField.el);

    var info = document.createElement("p");
    info.className = "small ko-info";
    koInfoEl = info;
    container.appendChild(info);
    syncKoHoldingValue();
    updateKoInfo();
    fetchKoPrice();
  }

  function buildSgovInputs() {
    var container = document.getElementById("sgovInputs");
    container.innerHTML = "";
    var configs = [
      { id: "h_SGOV", label: "市值(萬)", value: S.holdings["SGOV"], min: 0, step: 10, decimals: 0,
        onChange: function (v) { S.holdings["SGOV"] = v; scheduleRecalc(); } },
      { id: "g_lm", label: "貸款月付(萬)", value: S.loanMonthly, min: 0, step: 0.1, decimals: 4,
        onChange: function (v) { S.loanMonthly = v; scheduleRecalc(); } },
      { id: "g_ly", label: "貸款年限(年)", value: S.loanYears, min: 0, max: CFMWithdrawal.MAX_YEARS, step: 1, decimals: 0,
        onChange: function (v) { S.loanYears = v; scheduleRecalc(); } }
    ];
    configs.forEach(function (cfg) {
      container.appendChild(createStepperInput(cfg).el);
    });
  }

  function buildReserveInputs() {
    var container = document.getElementById("reserveInputs");
    container.innerHTML = "";
    var configs = [
      { id: "h_reserve", label: "備用金(萬)", value: S.holdings["備用金"], min: 0, step: 10, decimals: 0,
        onChange: function (v) { S.holdings["備用金"] = v; scheduleRecalc(); } },
      { id: "g_rr", label: "利率%", value: S.reserveRate, min: 0, max: 100, step: 0.1, decimals: 2,
        onChange: function (v) { S.reserveRate = v; scheduleRecalc(); } }
    ];
    configs.forEach(function (cfg) {
      container.appendChild(createStepperInput(cfg).el);
    });
  }

  function buildGlobalInputs() {
    var container = document.getElementById("globalInputs");
    container.innerHTML = "";
    var configs = [
      { id: "g_fx", label: "匯率 USD/TWD", value: S.fx, min: 0.01, step: 0.1, decimals: 2,
        onChange: function (v) { S.fx = v; syncKoHoldingValue(); updateKoInfo(); scheduleRecalc(); } }
    ];
    configs.forEach(function (cfg) {
      container.appendChild(createStepperInput(cfg).el);
    });
  }

  function buildScenarioTable() {
    var table = document.getElementById("scenTable");
    var oldRows = table.querySelectorAll("tr.r");
    oldRows.forEach(function (r) { r.remove(); });

    var configs = [
      { key: "etf", min: -100, max: 100, step: 0.5, decimals: 1 },
      { key: "tw", min: -100, max: 100, step: 0.5, decimals: 1 },
      { key: "ko", min: -100, max: 100, step: 0.5, decimals: 1 },
      { key: "sgov", min: 0, max: 100, step: 0.1, decimals: 1 },
      { key: "callPricePerShare", min: 0, max: null, step: 0.1, decimals: 2 }
    ];

    Object.keys(S.scen).forEach(function (name) {
      var scenario = S.scen[name];
      var tr = document.createElement("tr");
      tr.className = "r";
      var nameTd = document.createElement("td");
      nameTd.textContent = name;
      tr.appendChild(nameTd);
      configs.forEach(function (cfg) {
        var td = document.createElement("td");
        var field = createStepperInput({
          id: "s_" + name + "_" + cfg.key,
          value: scenario[cfg.key],
          min: cfg.min, max: cfg.max, step: cfg.step, decimals: cfg.decimals,
          hideLabel: true, compactWidth: true,
          onChange: (function (key) {
            return function (v) { scenario[key] = v; scheduleRecalc(); };
          })(cfg.key)
        });
        td.appendChild(field.el);
        tr.appendChild(td);
      });
      table.appendChild(tr);
    });
  }

  function buildAllInputs() {
    buildEtfInputs();
    buildWithdrawalInputs();
    buildHorizonInputs();
    build2887Inputs();
    buildKoInputs();
    buildSgovInputs();
    buildReserveInputs();
    buildGlobalInputs();
    buildScenarioTable();
  }

  // ===== Tab navigation =====
  function initTabs() {
    var tabBar = document.getElementById("tabBar");
    var buttons = Array.prototype.slice.call(tabBar.querySelectorAll(".tab-bar__item"));
    var panels = Array.prototype.slice.call(document.querySelectorAll(".tab-panel"));
    buttons.forEach(function (btn) {
      btn.addEventListener("click", function () {
        var target = btn.getAttribute("data-tab");
        buttons.forEach(function (b) {
          var active = b === btn;
          b.classList.toggle("is-active", active);
          b.setAttribute("aria-selected", active ? "true" : "false");
        });
        panels.forEach(function (p) {
          p.classList.toggle("is-active", p.getAttribute("data-tab") === target);
        });
      });
    });
  }

  // ===== Number count-up animation =====
  function animateNumber(el, from, to, duration, decimals) {
    var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    function format(v) {
      return decimals === 0 ? Math.round(v).toLocaleString() : v.toFixed(decimals);
    }
    if (reduceMotion || !duration) {
      el.textContent = format(to);
      return;
    }
    var start = null;
    function step(ts) {
      if (!start) start = ts;
      var progress = Math.min((ts - start) / duration, 1);
      var eased = 1 - Math.pow(1 - progress, 3);
      el.textContent = format(from + (to - from) * eased);
      if (progress < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  // ===== Charts =====
  var pieChart, lineChart;

  function drawPie() {
    var labelColor = cssVar("--ios-label");
    var subLabelColor = cssVar("--ios-label-secondary");
    var elevatedBg = cssVar("--ios-bg-elevated");

    var labels = Object.keys(S.holdings);
    var vals = labels.map(function (k) { return S.holdings[k]; });
    var total = vals.reduce(function (a, b) { return a + b; }, 0);
    var ctx = document.getElementById("pie");
    if (pieChart) pieChart.destroy();
    pieChart = new Chart(ctx, {
      type: "doughnut",
      data: {
        labels: labels.map(function (k, i) {
          var pct = total ? (vals[i] / total * 100).toFixed(1) : "0.0";
          return k + " " + pct + "%";
        }),
        datasets: [{ data: vals, backgroundColor: HOLDING_COLORS, borderColor: elevatedBg, borderWidth: 2, hoverOffset: 6 }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 600, easing: "easeOutQuart" },
        plugins: {
          legend: { position: "right", labels: { font: { size: 11 }, color: subLabelColor } },
          title: { display: true, text: "總投入 " + total.toLocaleString() + " 萬", color: labelColor, font: { size: 13, weight: "600" } },
          tooltip: {
            callbacks: {
              label: function (c) { return c.label.split(" ")[0] + ": " + c.parsed.toLocaleString() + " 萬"; }
            }
          }
        }
      }
    });
  }

  function drawLineChart(results) {
    var labelColor = cssVar("--ios-label");
    var subLabelColor = cssVar("--ios-label-secondary");
    var gridColor = cssVar("--ios-separator");

    var labels = [];
    for (var i = 1; i <= S.years; i++) labels.push("第" + i + "年");
    var datasets = Object.keys(results).map(function (name) {
      var color = SCEN_COLORS[name];
      return {
        label: name,
        data: results[name].map(function (x) { return Math.round(x.net); }),
        borderColor: color,
        backgroundColor: color,
        tension: 0.3,
        pointRadius: 3,
        pointBackgroundColor: color,
        fill: false
      };
    });
    var ctx = document.getElementById("chart");
    if (lineChart) lineChart.destroy();
    lineChart = new Chart(ctx, {
      type: "line",
      data: { labels: labels, datasets: datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 600, easing: "easeOutQuart" },
        plugins: {
          title: { display: true, text: "淨值走勢（萬元）", color: labelColor, font: { size: 13, weight: "600" } },
          legend: { labels: { color: subLabelColor } }
        },
        scales: {
          x: { ticks: { color: subLabelColor }, grid: { color: gridColor } },
          y: { ticks: { color: subLabelColor, callback: function (v) { return v.toLocaleString(); } }, grid: { color: gridColor } }
        }
      }
    });
  }

  // ===== Result cards =====
  function renderCards(results) {
    var container = document.getElementById("cards");
    container.innerHTML = "";
    Object.keys(results).forEach(function (name, idx) {
      var rows = results[name];
      var avgMonthly = rows.reduce(function (a, x) { return a + x.living; }, 0) / rows.length / 12;
      var endNet = rows[rows.length - 1].net;
      var color = SCEN_COLORS[name];

      var card = document.createElement("div");
      card.className = "card";
      card.style.animationDelay = (idx * 70) + "ms";

      var h3 = document.createElement("h3");
      h3.style.color = color;
      h3.textContent = name;
      card.appendChild(h3);

      var bigLiving = document.createElement("div");
      bigLiving.className = "big count-up";
      var livingTarget = document.createElement("span");
      livingTarget.textContent = "0.0";
      var livingSub = document.createElement("span");
      livingSub.className = "sub";
      livingSub.textContent = " 萬/月";
      bigLiving.appendChild(livingTarget);
      bigLiving.appendChild(livingSub);
      card.appendChild(bigLiving);

      var subLiving = document.createElement("div");
      subLiving.className = "sub";
      subLiving.textContent = "平均生活費（" + rows.length + " 年）";
      card.appendChild(subLiving);

      var bigNet = document.createElement("div");
      bigNet.className = "big count-up";
      bigNet.style.fontSize = "1.15em";
      bigNet.style.marginTop = "6px";
      var netTarget = document.createElement("span");
      netTarget.textContent = "0";
      bigNet.appendChild(netTarget);
      card.appendChild(bigNet);

      var subNet = document.createElement("div");
      subNet.className = "sub";
      subNet.textContent = "第 " + rows.length + " 年期末淨值(萬)";
      card.appendChild(subNet);

      container.appendChild(card);

      animateNumber(livingTarget, 0, avgMonthly, 500, 1);
      animateNumber(netTarget, 0, endNet, 500, 0);
    });
  }

  // ===== Detail tables =====
  function renderTables(results) {
    var container = document.getElementById("tables");
    container.innerHTML = "";
    Object.keys(results).forEach(function (name) {
      var rows = results[name];
      var color = SCEN_COLORS[name];

      var block = document.createElement("div");
      block.className = "scenario-block";

      var h3 = document.createElement("h3");
      h3.style.color = color;
      h3.textContent = name + "情境";
      block.appendChild(h3);

      var p1 = document.createElement("p");
      p1.className = "small";
      p1.style.margin = ".6em 0 .2em";
      p1.textContent = "各投資池對應現金流（萬/年）";
      block.appendChild(p1);

      var tot = { shortfall: 0, etfWd: 0, wd2887: 0, div2887: 0, call: 0, resInt: 0, usedRes: 0, living: 0, loanPay: 0 };
      var rowsHtml = "<tr><th>年</th><th>月生活費<br>目標</th><th>目標<br>提領率</th><th>0050+006208<br>提領</th><th>2887<br>提領</th><th>2887<br>現金股利</th><th>KO<br>Covered Call</th><th>備用金<br>利息</th><th>備用金<br>補缺口</th><th>生活費<br>合計</th><th>未達標<br>缺口</th><th>SGOV→<br>還貸</th></tr>";
      rows.forEach(function (x) {
        var rc = x.etfRet < 0 ? ' class="neg"' : '';
        var uc = x.usedRes > 0 ? ' class="neg"' : '';
        rowsHtml += "<tr><td" + rc + ">" + x.yr + "</td><td>" + (x.target / 12).toFixed(2) + "</td><td" + (x.wr >= 1 ? ' class="neg"' : '') + "><strong>" + (x.wr * 100).toFixed(2) + "%</strong></td><td>" + x.etfWd.toFixed(1) + "</td><td>" + x.wd2887.toFixed(1) + "</td><td>" + x.div2887.toFixed(1) + "</td>" +
          "<td>" + x.call.toFixed(1) + "</td><td>" + x.resInt.toFixed(1) + "</td><td" + uc + ">" + x.usedRes.toFixed(1) + "</td>" +
          "<td><strong>" + x.living.toFixed(1) + "</strong></td><td" + (x.shortfall > 0.05 ? ' class="neg"' : '') + ">" + x.shortfall.toFixed(1) + "</td><td>" + x.loanPay.toFixed(1) + "</td></tr>";
        tot.etfWd += x.etfWd; tot.wd2887 += x.wd2887; tot.div2887 += x.div2887; tot.call += x.call; tot.resInt += x.resInt;
        tot.usedRes += x.usedRes; tot.shortfall += x.shortfall; tot.living += x.living; tot.loanPay += x.loanPay;
      });
      rowsHtml += "<tr><th>" + rows.length + "年合計</th><th>—</th><th>—</th><th>" + tot.etfWd.toFixed(0) + "</th><th>" + tot.wd2887.toFixed(0) + "</th><th>" + tot.div2887.toFixed(0) + "</th>" +
        "<th>" + tot.call.toFixed(0) + "</th><th>" + tot.resInt.toFixed(0) + "</th><th>" + tot.usedRes.toFixed(0) + "</th>" +
        "<th>" + tot.living.toFixed(0) + "</th><th>" + tot.shortfall.toFixed(0) + "</th><th>" + tot.loanPay.toFixed(0) + "</th></tr>";

      var scroll1 = document.createElement("div");
      scroll1.className = "table-scroll";
      var table1 = document.createElement("table");
      table1.innerHTML = rowsHtml;
      scroll1.appendChild(table1);
      block.appendChild(scroll1);

      var p2 = document.createElement("p");
      p2.className = "small";
      p2.style.margin = ".6em 0 .2em";
      p2.textContent = "資產與淨值推演（萬）";
      block.appendChild(p2);

      var rows2Html = "<tr><th>年</th><th>ETF報酬</th><th>ETF值</th><th>KO值</th><th>KO<br>口數</th><th>2887值</th><th>2887<br>總股數</th><th>SGOV</th><th>備用金</th><th>備用金<br>利率%</th><th>總資產</th><th>淨值</th></tr>";
      rows.forEach(function (x) {
        var rc = x.etfRet < 0 ? ' class="neg"' : '';
        rows2Html += "<tr><td>" + x.yr + "</td><td" + rc + ">" + (x.etfRet * 100).toFixed(0) + "%</td>" +
          "<td>" + x.etf.toFixed(0) + "</td><td>" + x.ko.toFixed(0) + "</td><td>" + x.koContracts + "</td><td>" + x.s2887.toFixed(0) + "</td>" +
          "<td>" + x.shares2887Total.toLocaleString() + "</td>" +
          "<td>" + x.sgov.toFixed(0) + "</td><td>" + x.res.toFixed(0) + "</td>" +
          "<td>" + (x.resRate * 100).toFixed(2) + "%</td>" +
          "<td>" + x.assets.toFixed(0) + "</td>" +
          "<td><strong>" + x.net.toFixed(0) + "</strong></td></tr>";
      });

      var scroll2 = document.createElement("div");
      scroll2.className = "table-scroll";
      var table2 = document.createElement("table");
      table2.innerHTML = rows2Html;
      scroll2.appendChild(table2);
      block.appendChild(scroll2);

      container.appendChild(block);
    });
  }

  // ===== Orchestration =====
  function runAll() {
    var results = {};
    Object.keys(S.scen).forEach(function (name) {
      results[name] = CFMModel.run({
        holdings: S.holdings,
        fx: S.fx,
        loanMonthly: S.loanMonthly,
        livingTarget: S.livingTarget,
        withdrawalMode: "target",
        inflation: S.inflation,
        years: S.years,
        loanYears: S.loanYears,
        reserveRate: S.reserveRate,
        shares2887Base: S.shares2887Base,
        dividendPerShare2887: S.dividendPerShare2887,
        stockDividendPerShare2887: S.stockDividendPerShare2887,
        koUsdAmount: S.koUsdAmount,
        koPriceUsd: S.koPriceUsd,
        scenario: S.scen[name],
        pessimistic: false
      });
    });
    return results;
  }

  var lastResults = null;
  function calc() {
    drawPie();
    var results = runAll();
    lastResults = results;
    renderCards(results);
    drawLineChart(results);
    renderTables(results);
  }

  function resetDefaults() {
    S = CFMModel.deepClone(CFMModel.DEF);
    saveState();
    buildAllInputs();
    calc();
  }

  // ===== Theme toggle (light/dark) =====
  function buildThemeToggle() {
    var container = document.getElementById("themeToggle");
    if (!container) return;
    var buttons = Array.prototype.slice.call(container.querySelectorAll(".theme-toggle__option"));

    function reflect(theme) {
      buttons.forEach(function (btn) {
        var active = btn.getAttribute("data-theme-value") === theme;
        btn.classList.toggle("is-active", active);
        btn.setAttribute("aria-pressed", active ? "true" : "false");
      });
    }

    reflect(document.documentElement.getAttribute("data-theme"));

    buttons.forEach(function (btn) {
      btn.addEventListener("click", function () {
        var theme = btn.getAttribute("data-theme-value");
        if (document.documentElement.getAttribute("data-theme") === theme) return;
        document.documentElement.setAttribute("data-theme", theme);
        saveTheme(theme);
        reflect(theme);
        // Re-render charts only — cards/tables don't depend on theme colors,
        // so skip re-animating their count-up numbers on a pure theme switch.
        drawPie();
        if (lastResults) drawLineChart(lastResults);
      });
    });
  }

  function init() {
    initTabs();
    buildThemeToggle();
    buildAllInputs();
    calc();

    document.getElementById("btn-recalc").addEventListener("click", function () {
      if (recalcTimer) clearTimeout(recalcTimer);
      saveState();
      calc();
    });
    document.getElementById("btn-reset").addEventListener("click", resetDefaults);
  }

  init();
})();
