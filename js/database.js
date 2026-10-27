(function () {
  "use strict";

  // ===== 資料庫分頁：記錄「第 1 年樂觀結果」、讀檔、重置，以 File System Access API 存成 JSON 檔 =====
  // 瀏覽器不支援 File System Access API（Safari、Firefox）時：存檔改為下載 JSON、讀檔改用檔案選擇器。
  var R = CFMRecords;
  var LS_KEY = "cfm-db";            // 本機備份：重開頁面仍能看到表格
  var IDB_NAME = "cfm-db", IDB_STORE = "handles", IDB_KEY = "file";
  var FS_SUPPORTED = typeof window.showSaveFilePicker === "function" && typeof window.showOpenFilePicker === "function";
  var FILE_TYPES = [{ description: "JSON 檔", accept: { "application/json": [".json"] } }];

  var records = [];
  var fileHandle = null;
  var fileName = "";
  var dbChart = null;

  // ---------- 本機備份 ----------
  function loadLocal() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      var parsed = JSON.parse(raw);
      records = R.parse(JSON.stringify(parsed.data || { records: [] })).records;
      fileName = parsed.fileName || "";
    } catch (e) { records = []; }
  }
  function saveLocal() {
    try { localStorage.setItem(LS_KEY, JSON.stringify({ fileName: fileName, data: R.toFileObject(records) })); } catch (e) {}
  }

  // ---------- 檔案代號（FileSystemFileHandle）存在 IndexedDB，重開頁面仍可寫回同一個檔 ----------
  function idb(mode, fn) {
    return new Promise(function (resolve) {
      if (!window.indexedDB) return resolve(null);
      var req;
      try { req = indexedDB.open(IDB_NAME, 1); } catch (e) { return resolve(null); }
      req.onupgradeneeded = function () { req.result.createObjectStore(IDB_STORE); };
      req.onerror = function () { resolve(null); };
      req.onsuccess = function () {
        try {
          var tx = req.result.transaction(IDB_STORE, mode);
          var r = fn(tx.objectStore(IDB_STORE));
          tx.oncomplete = function () { resolve(r && "result" in r ? r.result : null); };
          tx.onerror = function () { resolve(null); };
        } catch (e) { resolve(null); }
      };
    });
  }
  function storeHandle(h) { return idb("readwrite", function (s) { return h ? s.put(h, IDB_KEY) : s.delete(IDB_KEY); }); }
  function restoreHandle() { return idb("readonly", function (s) { return s.get(IDB_KEY); }); }

  function ensurePermission(handle) {
    if (!handle.queryPermission) return Promise.resolve(true);
    var opts = { mode: "readwrite" };
    return handle.queryPermission(opts).then(function (p) {
      if (p === "granted") return true;
      return handle.requestPermission(opts).then(function (p2) { return p2 === "granted"; });
    });
  }

  // 寫入目前連結的檔案；尚未連結時請使用者選擇存檔位置。回傳 {ok, msg}。
  function writeFile(forcePick) {
    var text = R.serialize(records);
    if (!FS_SUPPORTED) {
      var blob = new Blob([text], { type: "application/json" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = fileName || "現金流資料庫.json";
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      return Promise.resolve({ ok: true, msg: "此瀏覽器不支援直接寫檔，已下載 JSON 檔" });
    }
    var getHandle = (!fileHandle || forcePick)
      ? window.showSaveFilePicker({ suggestedName: fileName || "現金流資料庫.json", types: FILE_TYPES })
      : Promise.resolve(fileHandle);
    return getHandle.then(function (h) {
      return ensurePermission(h).then(function (ok) {
        if (!ok) throw new Error("沒有寫入權限");
        return h.createWritable();
      }).then(function (w) {
        return w.write(text).then(function () { return w.close(); });
      }).then(function () {
        fileHandle = h;
        fileName = h.name;
        storeHandle(h);
        saveLocal();
        renderStatus();
        return { ok: true, msg: "已寫入 " + h.name };
      });
    }).catch(function (e) {
      if (e && e.name === "AbortError") return { ok: false, msg: "已取消選擇檔案，資料只暫存在本機瀏覽器" };
      return { ok: false, msg: "寫檔失敗：" + (e && e.message ? e.message : "未知錯誤") + "（資料已暫存在本機瀏覽器）" };
    });
  }

  // ---------- iOS 風格對話框 ----------
  // opts: {title, message, input:{value, placeholder, inputMode}, list:[{value,label}], buttons:[{label, value, role}]}
  // 回傳 Promise<{value, input, checked}>；role: "cancel" | "destructive" | "primary"
  function dialog(opts) {
    return new Promise(function (resolve) {
      var overlay = document.createElement("div");
      overlay.className = "ios-dialog-overlay";
      var box = document.createElement("div");
      box.className = "ios-dialog";
      box.setAttribute("role", "dialog");
      box.setAttribute("aria-modal", "true");

      var body = document.createElement("div");
      body.className = "ios-dialog__body";
      var h = document.createElement("h3");
      h.className = "ios-dialog__title";
      h.textContent = opts.title;
      body.appendChild(h);
      if (opts.message) {
        var m = document.createElement("p");
        m.className = "ios-dialog__message";
        m.textContent = opts.message;
        body.appendChild(m);
      }
      var input = null;
      if (opts.input) {
        input = document.createElement("input");
        input.className = "ios-dialog__input";
        input.type = "text";
        input.inputMode = opts.input.inputMode || "numeric";
        input.value = opts.input.value || "";
        input.placeholder = opts.input.placeholder || "";
        body.appendChild(input);
      }
      var checks = [];
      if (opts.list) {
        var listEl = document.createElement("div");
        listEl.className = "ios-dialog__list";
        opts.list.forEach(function (it) {
          var lab = document.createElement("label");
          lab.className = "ios-dialog__check";
          var cb = document.createElement("input");
          cb.type = "checkbox";
          cb.value = it.value;
          var span = document.createElement("span");
          span.textContent = it.label;
          lab.appendChild(span);
          lab.appendChild(cb);
          listEl.appendChild(lab);
          checks.push(cb);
        });
        body.appendChild(listEl);
      }
      box.appendChild(body);

      var btns = document.createElement("div");
      btns.className = "ios-dialog__buttons" + (opts.buttons.length > 2 ? " is-stacked" : "");
      function close(value) {
        overlay.classList.add("is-closing");
        document.removeEventListener("keydown", onKey);
        setTimeout(function () { overlay.remove(); }, 180);
        resolve({
          value: value,
          input: input ? input.value : null,
          checked: checks.filter(function (c) { return c.checked; }).map(function (c) { return Number(c.value); })
        });
      }
      var primary = null, cancelVal = null;
      opts.buttons.forEach(function (b) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "ios-dialog__btn" + (b.role ? " is-" + b.role : "");
        btn.textContent = b.label;
        btn.addEventListener("click", function () { close(b.value); });
        btns.appendChild(btn);
        if (b.role === "primary" || b.role === "destructive") primary = primary || b.value;
        if (b.role === "cancel") cancelVal = b.value;
      });
      box.appendChild(btns);
      function onKey(e) {
        if (e.key === "Escape") close(cancelVal);
        if (e.key === "Enter" && input && document.activeElement === input && primary !== null) close(primary);
      }
      document.addEventListener("keydown", onKey);
      overlay.addEventListener("click", function (e) { if (e.target === overlay) close(cancelVal); });

      overlay.appendChild(box);
      document.body.appendChild(overlay);
      if (input) setTimeout(function () { input.focus(); input.select(); }, 50);
    });
  }

  function alertDialog(title, message) {
    return dialog({ title: title, message: message, buttons: [{ label: "好", value: true, role: "primary" }] });
  }

  var toastTimer = null;
  function toast(msg, isError) {
    var el = document.getElementById("cfmToast");
    if (!el) {
      el = document.createElement("div");
      el.id = "cfmToast";
      el.className = "ios-toast";
      el.setAttribute("role", "status");
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.toggle("is-error", !!isError);
    el.classList.remove("is-visible");
    void el.offsetWidth;
    el.classList.add("is-visible");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove("is-visible"); }, 2600);
  }

  // ---------- 記錄（結果頁按鈕）----------
  function askYear(defaultValue, hint) {
    return dialog({
      title: "記錄第 1 年樂觀結果",
      message: (hint ? hint + "\n" : "") + "請輸入要儲存的年份（西元，例如 " + new Date().getFullYear() + "）。",
      input: { value: String(defaultValue), placeholder: "西元年份" },
      buttons: [{ label: "取消", value: false, role: "cancel" }, { label: "儲存", value: true, role: "primary" }]
    }).then(function (r) {
      if (!r.value) return null;
      var y = R.parseYear(r.input);
      if (y === null) return askYear(r.input, "⚠️ 年份需為 " + R.MIN_YEAR + "–" + R.MAX_YEAR + " 之間的 4 位數字。");
      return y;
    });
  }

  function recordCurrent() {
    var results = window.CFMApp && window.CFMApp.getResults();
    var rows = results && results["樂觀"];
    if (!rows || !rows.length) { alertDialog("沒有結果", "請先完成計算再記錄。"); return; }
    var row = rows[0];
    var defaultYear = new Date().getFullYear();
    askYear(defaultYear).then(function (year) {
      if (year === null) return null;
      if (!R.hasYear(records, year)) return year;
      return dialog({
        title: year + " 年已有資料",
        message: "資料庫中已經有 " + year + " 年的記錄，是否以目前的結果覆蓋？",
        buttons: [{ label: "取消", value: false, role: "cancel" }, { label: "覆蓋", value: true, role: "destructive" }]
      }).then(function (r) { return r.value ? year : null; });
    }).then(function (year) {
      if (year === null) return;
      var existed = R.hasYear(records, year);
      records = R.upsert(records, R.snapshot(row, year));
      saveLocal();
      renderDb();
      return writeFile(false).then(function (res) {
        toast((existed ? "已覆蓋 " : "已記錄 ") + year + " 年・" + res.msg, !res.ok);
      });
    });
  }

  // ---------- 讀檔 ----------
  function applyLoaded(text, handle, name) {
    var parsed;
    try { parsed = R.parse(text); } catch (e) { alertDialog("無法讀取", e.message); return; }
    records = parsed.records;
    fileHandle = handle || null;
    fileName = name || "";
    storeHandle(fileHandle);
    saveLocal();
    renderDb();
    toast("已讀取 " + (name || "檔案") + "：" + records.length + " 筆" + (parsed.skipped ? "（略過 " + parsed.skipped + " 筆格式錯誤）" : ""));
  }

  function loadFile() {
    if (FS_SUPPORTED) {
      window.showOpenFilePicker({ types: FILE_TYPES, multiple: false }).then(function (hs) {
        var h = hs[0];
        return h.getFile().then(function (f) { return f.text(); }).then(function (t) { applyLoaded(t, h, h.name); });
      }).catch(function (e) {
        if (!e || e.name !== "AbortError") alertDialog("無法讀取", (e && e.message) || "未知錯誤");
      });
      return;
    }
    var input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.addEventListener("change", function () {
      var f = input.files && input.files[0];
      if (!f) return;
      f.text().then(function (t) { applyLoaded(t, null, f.name); });
    });
    input.click();
  }

  // ---------- 重置資料 ----------
  function resetData() {
    if (!records.length) { alertDialog("沒有資料", "資料庫目前是空的。"); return; }
    dialog({
      title: "重置資料",
      message: "要刪除特定年份，還是完全清除所有資料？",
      buttons: [
        { label: "刪除特定年份", value: "some", role: "primary" },
        { label: "完全清除", value: "all", role: "destructive" },
        { label: "取消", value: null, role: "cancel" }
      ]
    }).then(function (r) {
      if (r.value === "some") {
        return dialog({
          title: "刪除特定年份",
          message: "勾選要刪除的年份：",
          list: records.map(function (rec) { return { value: rec.year, label: rec.year + " 年（淨值 " + Math.round(rec.values.net).toLocaleString() + " 萬）" }; }),
          buttons: [{ label: "取消", value: false, role: "cancel" }, { label: "刪除", value: true, role: "destructive" }]
        }).then(function (r2) {
          if (!r2.value) return;
          if (!r2.checked.length) { toast("沒有勾選任何年份", true); return; }
          records = R.removeYears(records, r2.checked);
          return commitChange("已刪除 " + r2.checked.join("、") + " 年");
        });
      }
      if (r.value === "all") {
        return dialog({
          title: "完全清除",
          message: "確定要清除全部 " + records.length + " 筆資料嗎？" + (fileName ? "連結的檔案 " + fileName + " 也會一併清空。" : "") + "此動作無法復原。",
          buttons: [{ label: "取消", value: false, role: "cancel" }, { label: "全部清除", value: true, role: "destructive" }]
        }).then(function (r3) {
          if (!r3.value) return;
          records = [];
          return commitChange("已清除全部資料");
        });
      }
    });
  }

  // 刪除後：更新畫面與本機備份；若已連結檔案（或瀏覽器不支援直接寫檔）則同步寫回檔案。
  function commitChange(msg) {
    saveLocal();
    renderDb();
    if (!fileHandle) { toast(msg); return; }
    return writeFile(false).then(function (res) { toast(msg + "・" + res.msg, !res.ok); });
  }

  // ---------- 畫面 ----------
  function renderStatus() {
    var el = document.getElementById("dbStatus");
    if (!el) return;
    var support = FS_SUPPORTED ? "" : "（此瀏覽器不支援直接寫檔，記錄時會下載 JSON 檔；建議使用 Chrome 或 Edge）";
    el.textContent = (fileName ? "連結檔案：" + fileName : "尚未連結檔案：第一次記錄時會請你選擇存檔位置") + "・共 " + records.length + " 筆" + support;
  }

  function fmt(v, d) {
    return d === 0 ? Math.round(v).toLocaleString() : v.toFixed(d);
  }

  function renderTable() {
    var wrap = document.getElementById("dbTable");
    if (!wrap) return;
    wrap.innerHTML = "";
    if (!records.length) {
      var empty = document.createElement("div");
      empty.className = "db-empty";
      empty.innerHTML = "<div class=\"db-empty__icon\" aria-hidden=\"true\">🗂️</div><p>尚無記錄</p><p class=\"small\">到「結果」頁按「記錄」，把當下第 1 年的樂觀結果存成一列。</p>";
      wrap.appendChild(empty);
      return;
    }
    var cash = R.FIELDS.filter(function (f) { return f.group === "cash"; });
    var asset = R.FIELDS.filter(function (f) { return f.group === "asset"; });
    var html = "<tr><th rowspan=\"2\" class=\"db-sticky\">年份</th><th class=\"db-group\" colspan=\"" + cash.length + "\">各投資池對應現金流（萬/年）</th><th class=\"db-group\" colspan=\"" + asset.length + "\">資產與淨值（萬）</th><th rowspan=\"2\">儲存時間</th></tr><tr>";
    cash.concat(asset).forEach(function (f) { html += "<th>" + f.label + "</th>"; });
    html += "</tr>";
    records.forEach(function (rec, i) {
      html += "<tr class=\"db-row\" style=\"animation-delay:" + Math.min(i * 40, 400) + "ms\"><td class=\"db-sticky\"><strong>" + rec.year + "</strong></td>";
      cash.concat(asset).forEach(function (f) {
        var v = rec.values[f.key];
        var cls = (f.key === "shortfall" && v > 0.05) || (f.key === "usedRes" && v > 0) ? " class=\"neg\"" : "";
        html += "<td" + cls + ">" + (f.key === "net" || f.key === "living" ? "<strong>" + fmt(v, f.decimals) + "</strong>" : fmt(v, f.decimals)) + "</td>";
      });
      var t = rec.savedAt ? new Date(rec.savedAt) : null;
      html += "<td class=\"small\">" + (t && !isNaN(t) ? t.toLocaleString("zh-TW", { hour12: false }) : "—") + "</td></tr>";
    });
    var scroll = document.createElement("div");
    scroll.className = "table-scroll";
    var table = document.createElement("table");
    table.className = "db-table";
    table.innerHTML = html;
    scroll.appendChild(table);
    wrap.appendChild(scroll);
  }

  function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

  function renderChart() {
    var wrap = document.getElementById("dbChartWrap");
    var canvas = document.getElementById("dbChart");
    if (!wrap || !canvas || typeof Chart === "undefined") return;
    wrap.style.display = records.length ? "" : "none";
    if (dbChart) { dbChart.destroy(); dbChart = null; }
    if (!records.length) return;
    var color = "#34C759";
    var sub = css("--ios-label-secondary"), grid = css("--ios-separator"), label = css("--ios-label");
    var ctx = canvas.getContext("2d");
    var grad = ctx.createLinearGradient(0, 0, 0, canvas.clientHeight || 300);
    grad.addColorStop(0, "rgba(52, 199, 89, 0.28)");
    grad.addColorStop(1, "rgba(52, 199, 89, 0)");
    dbChart = new Chart(canvas, {
      type: "line",
      data: {
        labels: records.map(function (r) { return r.year + "年"; }),
        datasets: [{
          label: "淨值（第 1 年樂觀）",
          data: records.map(function (r) { return Math.round(r.values.net); }),
          borderColor: color, backgroundColor: grad, pointBackgroundColor: color,
          pointRadius: 4, pointHoverRadius: 6, tension: 0.3, fill: true
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 700, easing: "easeOutQuart" },
        plugins: {
          title: { display: true, text: "淨值走勢（萬元）", color: label, font: { size: 13, weight: "600" } },
          legend: { display: false },
          tooltip: { callbacks: { label: function (c) { return "淨值 " + c.parsed.y.toLocaleString() + " 萬"; } } }
        },
        scales: {
          x: { ticks: { color: sub }, grid: { color: grid } },
          y: { ticks: { color: sub, callback: function (v) { return v.toLocaleString(); } }, grid: { color: grid } }
        }
      }
    });
  }

  function renderDb() {
    renderStatus();
    renderTable();
    renderChart();
  }

  function init() {
    loadLocal();
    renderDb();
    var rec = document.getElementById("btn-record");
    if (rec) rec.addEventListener("click", recordCurrent);
    var ld = document.getElementById("btn-db-load");
    if (ld) ld.addEventListener("click", loadFile);
    var rs = document.getElementById("btn-db-reset");
    if (rs) rs.addEventListener("click", resetData);
    document.addEventListener("cfm-theme", renderChart);
    document.addEventListener("cfm-tab", function (e) { if (e.detail === "database") renderChart(); });
    // 重開頁面：取回上次連結的檔案代號（寫入時才會再次要求權限）
    if (FS_SUPPORTED) {
      restoreHandle().then(function (h) {
        if (h && h.kind === "file") { fileHandle = h; fileName = h.name; renderStatus(); }
      });
    }
  }

  window.CFMDatabase = { _dialog: dialog, _records: function () { return records; } };
  init();
})();
