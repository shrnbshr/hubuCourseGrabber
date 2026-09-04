// ==UserScript==
// @name         湖北大学强智教务自动抢课助手 (HUBU Course Grabber)
// @namespace    https://github.com/hubu-course-grabber
// @version      3.2.0
// @description  专为湖北大学强智教务系统定制，针对 xsxk_index 和 DataTables 深度优化，支持一键点选抢课、自动查询刷新与弹窗放行
// @author       HUBU
// @match        *://jwxt.hubu.edu.cn/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/* eslint-env browser, es6 */

(function () {
  "use strict";

  const __HUBU_GLOBAL__ = window;
  const __HUBU_LOADED_KEY__ = "__HUBU_COURSE_GRABBER_LOADED__";
  const __HUBU_INSTANCE_KEY__ = "__HUBU_COURSE_GRABBER_INSTANCE_ID__";

  // ========== 核心防重：只有选课表格所在的 Frame 才弹窗，课表/导航 Frame 自动静默 ==========
  const isCourseFrame = Boolean(
    document.getElementById("dataView") ||
    typeof window.queryKxkcList === "function" ||
    document.querySelector("input[onclick*='queryKxkcList']")
  );

  // 如果当前 Frame 没有选课相关元素（如底部的作息时间表 Frame），直接退出，绝不弹多余面板
  if (!isCourseFrame) {
    return;
  }

  // 跨 Frame 单例锁：保证全屏仅此一个面板
  try {
    if (window.top && window.top.__HUBU_GLOBAL_PANEL_EXISTS__) {
      return;
    }
    if (window.top) {
      window.top.__HUBU_GLOBAL_PANEL_EXISTS__ = true;
    }
  } catch (e) {}

  if (__HUBU_GLOBAL__[__HUBU_LOADED_KEY__]) {
    try {
      if (__HUBU_GLOBAL__.hubuGrab && typeof __HUBU_GLOBAL__.hubuGrab.stop === "function") {
        __HUBU_GLOBAL__.hubuGrab.stop();
      }
    } catch (e) {}
  }

  __HUBU_GLOBAL__[__HUBU_LOADED_KEY__] = true;
  __HUBU_GLOBAL__[__HUBU_INSTANCE_KEY__] = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  // ========== 配置 ==========
  const TARGET_COURSES = [];
  let CHECK_INTERVAL = 1200;
  let REFRESH_INTERVAL_TICKS = 3;
  let MAX_ATTEMPTS = 6000;
  let MAX_CONSECUTIVE_FAILS = 10;

  // ========== 状态机 ==========
  let isRunning = false;
  let attemptCount = 0;
  let intervalId = null;
  let scheduledTimerId = null;
  let scheduledTargetTime = null;
  let lastAlertMsg = "";

  const courseStates = new Map();
  const selectedCourses = new Set();
  const activeCourses = new Set();

  function log(message, type = "info", courseCode = null) {
    const timeStr = new Date().toLocaleTimeString();
    const tag = courseCode ? `[${courseCode}] ` : "";
    const fullMsg = `[${timeStr}] ${tag}${message}`;

    const styles = {
      info: "color: #38bdf8;",
      success: "color: #4ade80; font-weight: bold;",
      warning: "color: #facc15; font-weight: bold;",
      error: "color: #f87171; font-weight: bold;"
    };
    console.log(`%c[HUBU选课] ${fullMsg}`, styles[type] || styles.info);

    if (typeof addUILog === "function") {
      addUILog(type, `${tag}${message}`);
    }
  }

  function getCourseState(code) {
    if (!courseStates.has(code)) {
      courseStates.set(code, {
        attempts: 0,
        fails: 0,
        success: false,
        selecting: false
      });
    }
    return courseStates.get(code);
  }

  // ========== 上下文检索 ==========
  function getActiveContext() {
    function searchWin(win, depth = 0) {
      if (!win || depth > 6) return null;
      try {
        if (win.document && win.document.getElementById("dataView")) {
          return { win, doc: win.document };
        }
      } catch (e) {}

      try {
        const frames = win.frames;
        for (let i = 0; i < frames.length; i++) {
          const res = searchWin(frames[i], depth + 1);
          if (res) return res;
        }
      } catch (e) {}

      try {
        const iframes = win.document.querySelectorAll("iframe, frame");
        for (let el of iframes) {
          if (el.contentWindow) {
            const res = searchWin(el.contentWindow, depth + 1);
            if (res) return res;
          }
        }
      } catch (e) {}

      return null;
    }

    return searchWin(window) || { win: window, doc: window.document };
  }

  // ========== 表格静默刷新 ==========
  function triggerTableRefresh(ctx) {
    try {
      const { win, doc } = ctx;
      if (typeof win.queryKxkcList === "function") {
        win.queryKxkcList();
        log("🔄 自动查询最新余量中...", "info");
        return true;
      }
      const queryBtn = doc.querySelector('input[type="button"][value="查询"], button.el-button');
      if (queryBtn) {
        queryBtn.click();
        log("🔄 点击查询按钮拉取新数据...", "info");
        return true;
      }
    } catch (e) {}
    return false;
  }

  // ========== 行内快捷按钮注入（一键抢课） ==========
  function injectRowShortcuts() {
    const ctx = getActiveContext();
    const table = ctx.doc.getElementById("dataView");
    if (!table) return;

    const rows = table.querySelectorAll("tbody tr");
    for (let row of rows) {
      if (row.classList.contains("dataTables_empty") || row.cells.length < 8) continue;
      if (row.querySelector(".hb-quick-btn")) continue;

      const code = row.cells[0]?.textContent.trim();
      const name = row.cells[1]?.textContent.trim();
      const lastCell = row.cells[row.cells.length - 1];

      if (lastCell && code) {
        const quickBtn = ctx.doc.createElement("button");
        quickBtn.className = "hb-quick-btn";
        quickBtn.textContent = "⚡ 抢这门";
        quickBtn.style.cssText = `
          margin-left: 6px;
          background: #0284c7;
          color: white;
          border: none;
          border-radius: 4px;
          padding: 2px 6px;
          font-size: 11px;
          cursor: pointer;
          font-weight: bold;
        `;
        quickBtn.onclick = function (e) {
          e.preventDefault();
          e.stopPropagation();
          addCourseAndStart(code, name);
        };
        lastCell.appendChild(quickBtn);
      }
    }
  }

  function addCourseAndStart(code, name) {
    const exists = TARGET_COURSES.some((c) => c.code === code);
    if (!exists) {
      TARGET_COURSES.push({ code, priority: 1, timeFilter: [], teacherFilter: [] });
      renderCourseList();
      log(`已一键添加监控: ${name || code} (${code})`, "success");
    }
    if (!isRunning) {
      startGrabbing();
    }
  }

  // ========== 扫描并提取选课行 ==========
  function scanDataViewTable(courseCodeOrName) {
    const target = String(courseCodeOrName).trim();
    if (!target) return [];

    const ctx = getActiveContext();
    const { doc, win } = ctx;
    const table = doc.getElementById("dataView");
    if (!table) return [];

    const rows = table.querySelectorAll("tbody tr");
    const matched = [];

    for (let row of rows) {
      if (row.classList.contains("dataTables_empty") || row.cells.length < 5) continue;

      const cells = row.cells;
      const rowText = (row.textContent || "").trim();

      const courseCode = cells[0] ? cells[0].textContent.trim() : "";
      const courseName = cells[1] ? cells[1].textContent.trim() : "";

      let isHit = false;
      if (courseCode === target || courseCode.includes(target)) isHit = true;
      else if (courseName && courseName.includes(target)) isHit = true;
      else if (rowText.includes(target)) isHit = true;

      if (!isHit) continue;

      const teacher = cells[4] ? cells[4].textContent.trim() : "";
      const timeInfo = cells[5] ? cells[5].textContent.trim() : "";
      const capacityText = cells[8] ? cells[8].textContent.trim() : "";
      const statusText = cells[9] ? cells[9].textContent.trim() : "";

      let remaining = 0;
      const numMatch = capacityText.match(/\d+/);
      if (numMatch) remaining = parseInt(numMatch[0], 10);

      const isConflicted = statusText.includes("冲突");

      const lastCell = cells[cells.length - 1];
      let selectBtn = null;
      let isAlreadySelected = false;

      const lastCellText = lastCell ? lastCell.textContent.trim() : "";
      if (lastCellText.includes("已选") || lastCellText.includes("退选")) {
        isAlreadySelected = true;
      }

      if (lastCell) {
        const candidates = lastCell.querySelectorAll("a, button, input[type='button'], input[type='submit']");
        for (let el of candidates) {
          if (el.classList.contains("hb-quick-btn")) continue;
          const t = (el.textContent || el.value || "").trim();
          const onclickStr = el.getAttribute("onclick") || "";
          if (t.includes("选课") || onclickStr.includes("choose") || onclickStr.includes("xk") || onclickStr.includes("setXk")) {
            if (!t.includes("退选")) {
              selectBtn = el;
              break;
            }
          }
        }
        if (!selectBtn && candidates.length > 0 && !isAlreadySelected) {
          selectBtn = candidates[0];
        }
      }

      matched.push({
        row,
        doc,
        win,
        btn: selectBtn,
        courseCode: courseCode || target,
        courseName: courseName || target,
        teacher,
        timeInfo,
        capacity: remaining,
        isConflicted,
        statusText,
        isAlreadySelected,
        id: `${courseCode}_${teacher}_${timeInfo}`
      });
    }

    return matched;
  }

  // ========== 弹窗放行 ==========
  function hookDialogs(win) {
    if (!win) return;
    try {
      win.confirm = function () { return true; };
      win.alert = function (msg) {
        lastAlertMsg = String(msg);
        log(`系统提示: "${msg}"`, "warning");
      };
    } catch (e) {}
  }

  // ========== 触发选课 ==========
  function executeSelect(teachingClass) {
    const { win, doc, btn, courseCode, courseName, id, row } = teachingClass;
    const state = getCourseState(courseCode);

    if (state.selecting) return;
    state.selecting = true;
    lastAlertMsg = "";

    log(`🎯 发现空位！正在发起选课 [${courseName}]...`, "warning", courseCode);
    hookDialogs(win);

    try {
      if (btn) {
        btn.click();
      } else {
        const lastCell = row.cells[row.cells.length - 1];
        const clickable = lastCell.querySelector("[onclick]:not(.hb-quick-btn)");
        if (clickable) clickable.click();
      }

      setTimeout(() => {
        try {
          const easyUiBtns = doc.querySelectorAll(".panel.window .l-btn, .panel.window .el-button, .messager-button a");
          for (let b of easyUiBtns) {
            const txt = (b.textContent || "").trim();
            if (txt.includes("确定") || txt.includes("是") || txt.includes("OK")) {
              b.click();
              break;
            }
          }
        } catch (err) {}
      }, 300);

      setTimeout(() => {
        try {
          const msg = lastAlertMsg;
          lastAlertMsg = "";

          if (msg.includes("成功")) {
            // 教务系统明确返回"成功"
            state.success = true;
            selectedCourses.add(courseCode);
            activeCourses.delete(courseCode);

            log(`🎊 恭喜！成功选上课程: ${courseName} (${courseCode})！`, "success", courseCode);

            if (activeCourses.size === 0) {
              log("🎉 监控课程已全部抢到！", "success");
              stopGrabbing();
            }
          } else if (msg) {
            // 教务系统弹窗了但不含"成功"，视为失败
            state.fails++;
            log(`选课未成功: ${msg}`, "warning", courseCode);
          } else {
            // 没有捕获到弹窗，兜底用表格重扫
            const recheck = scanDataViewTable(courseCode);
            const curr = recheck.find((c) => c.id === id);
            if (curr && curr.isAlreadySelected) {
              state.success = true;
              selectedCourses.add(courseCode);
              activeCourses.delete(courseCode);
              log(`🎊 恭喜！成功选上课程: ${courseName} (${courseCode})！`, "success", courseCode);

              if (activeCourses.size === 0) {
                log("🎉 监控课程已全部抢到！", "success");
                stopGrabbing();
              }
            } else {
              state.fails++;
              log(`等待下一轮刷新验证 (已尝试 ${state.fails} 次)`, "info", courseCode);
            }
          }
        } catch (err) {
        } finally {
          state.selecting = false;
        }
      }, 1500);
    } catch (e) {
      state.selecting = false;
    }
  }

  // ========== 轮询逻辑 ==========
  function tick() {
    if (!isRunning || activeCourses.size === 0) return;
    attemptCount++;

    const ctx = getActiveContext();

    if (attemptCount % REFRESH_INTERVAL_TICKS === 0) {
      triggerTableRefresh(ctx);
      setTimeout(injectRowShortcuts, 500);
    }

    const sorted = TARGET_COURSES.filter((c) => activeCourses.has(c.code)).sort(
      (a, b) => (a.priority || 999) - (b.priority || 999)
    );

    for (let cfg of sorted) {
      const state = getCourseState(cfg.code);
      if (state.success || state.selecting) continue;

      const classes = scanDataViewTable(cfg.code);
      if (classes.length === 0) continue;

      const sel = classes.find((c) => c.isAlreadySelected);
      if (sel) {
        state.success = true;
        selectedCourses.add(cfg.code);
        activeCourses.delete(cfg.code);
        log(`已选上: ${sel.courseName}`, "success", cfg.code);
        continue;
      }

      for (let c of classes) {
        if (c.isConflicted) continue;
        if (c.capacity > 0) {
          executeSelect(c);
          return;
        }
      }
    }

    updateStatusDisplay();
  }

  function startGrabbing() {
    if (isRunning) return;
    if (TARGET_COURSES.length === 0) {
      alert("请先添加目标课程或点击表格右侧的【⚡ 抢这门】！");
      return;
    }

    isRunning = true;
    attemptCount = 0;
    activeCourses.clear();

    for (let c of TARGET_COURSES) {
      activeCourses.add(c.code);
      const s = getCourseState(c.code);
      s.fails = 0;
      s.selecting = false;
    }

    log(`🚀 开始抢课！监控中: ${activeCourses.size} 门课程`, "success");
    triggerTableRefresh(getActiveContext());
    setTimeout(tick, 400);
    intervalId = setInterval(tick, CHECK_INTERVAL);

    updateButtonStates();
  }

  function stopGrabbing() {
    if (!isRunning) return;
    isRunning = false;
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
    log("⏹️ 已停止抢课", "warning");
    updateButtonStates();
    updateStatusDisplay();
  }

  // ========== UI 悬浮面板 ==========
  function createUI() {
    // 若已存在旧实例则先移除重新挂载
    const oldUI = document.getElementById("hubuCourseGrabberUI");
    if (oldUI) {
      oldUI.remove();
    }

    const style = document.createElement("style");
    style.textContent = `
      #hubuCourseGrabberUI {
        position: fixed !important;
        top: 20px;
        right: 20px;
        width: 320px !important;
        background: #090d16 !important;
        border: 2px solid #38bdf8 !important;
        border-radius: 12px !important;
        box-shadow: 0 16px 40px rgba(0,0,0,0.7) !important;
        z-index: 2147483647 !important;
        font-family: -apple-system, BlinkMacSystemFont, "Microsoft YaHei", sans-serif !important;
        color: #f1f5f9 !important;
        display: flex;
        flex-direction: column !important;
        overflow: hidden !important;
        visibility: visible !important;
        opacity: 1 !important;
      }
      #hubuCourseGrabberUI * { box-sizing: border-box !important; }
      .hb-head {
        padding: 10px 14px;
        background: #0f172a;
        display: flex;
        justify-content: space-between;
        align-items: center;
        border-bottom: 1px solid #1e293b;
        cursor: move;
        user-select: none;
      }
      .hb-head-title { font-size: 13px; font-weight: bold; color: #38bdf8; display: flex; align-items: center; gap: 6px; }
      .hb-panel-body { padding: 12px; display: flex; flex-direction: column; gap: 8px; }
      .hb-btn { padding: 8px 12px; border-radius: 6px; font-size: 12px; font-weight: bold; cursor: pointer; border: none; }
      .hb-btn-primary { background: #0284c7; color: white; width: 100%; }
      .hb-btn-primary:hover:not(:disabled) { background: #0369a1; }
      .hb-btn-danger { background: #be123c; color: white; width: 100%; }
      .hb-btn:disabled { opacity: 0.5; cursor: not-allowed; }
      .hb-tips { font-size: 11px; color: #94a3b8; line-height: 1.4; background: #020617; padding: 8px; border-radius: 6px; border: 1px solid #1e293b; }
      .hb-list { max-height: 120px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; }
      .hb-item { background: #020617; padding: 6px 8px; border-radius: 4px; display: flex; justify-content: space-between; font-size: 11px; border: 1px solid #1e293b; }
      .hb-log { font-family: monospace; font-size: 10px; color: #94a3b8; max-height: 80px; overflow-y: auto; }
    `;
    (document.head || document.documentElement).appendChild(style);

    const ui = document.createElement("div");
    ui.id = "hubuCourseGrabberUI";
    ui.innerHTML = `
      <div class="hb-head" id="hb-drag-head">
        <div class="hb-head-title">🎓 HUBU 抢课助手</div>
        <div style="display: flex; gap: 4px;">
          <button id="hb-btn-close" style="background:transparent;border:none;color:#94a3b8;cursor:pointer;font-size:14px;">×</button>
        </div>
      </div>
      <div class="hb-panel-body">
        <div class="hb-tips">
          💡 <b>极简用法：</b> 浏览下方表格，找到目标课程直接点击该行最右侧的 <b>【⚡ 抢这门】</b> 按钮即可一键开抢！
        </div>

        <div style="display:flex;justify-content:space-between;align-items:center;font-size:11px;">
          <span>状态: <b id="hb-status-text" style="color:#64748b;">未运行</b></span>
          <span id="hb-stat-count" style="color:#64748b;">尝试: 0次</span>
        </div>

        <div class="hb-list" id="hb-course-list">
          <div style="text-align:center;color:#475569;font-size:11px;padding:6px;">未添加课程 (点击表格里的⚡抢这门)</div>
        </div>

        <div style="display:flex;gap:6px;">
          <button class="hb-btn hb-btn-primary" id="hb-start-btn">🚀 开始自动抢课</button>
          <button class="hb-btn hb-btn-danger" id="hb-stop-btn" disabled>⏹️ 停止</button>
        </div>

        <div class="hb-log" id="hb-log-box"></div>
      </div>
    `;

    const targetParent = document.body || document.documentElement;
    if (!targetParent) {
      setTimeout(createUI, 300);
      return;
    }
    targetParent.appendChild(ui);

    // 绑定拖拽
    const head = ui.querySelector("#hb-drag-head");
    if (head) {
      let p1 = 0, p2 = 0, p3 = 0, p4 = 0;
      head.onmousedown = (e) => {
        e.preventDefault();
        p3 = e.clientX;
        p4 = e.clientY;
        document.onmouseup = () => { document.onmouseup = null; document.onmousemove = null; };
        document.onmousemove = (ev) => {
          ev.preventDefault();
          p1 = p3 - ev.clientX;
          p2 = p4 - ev.clientY;
          p3 = ev.clientX;
          p4 = ev.clientY;
          ui.style.top = `${ui.offsetTop - p2}px`;
          ui.style.left = `${ui.offsetLeft - p1}px`;
          ui.style.right = "auto";
        };
      };
    }

    const closeBtn = ui.querySelector("#hb-btn-close");
    if (closeBtn) closeBtn.onclick = () => { ui.style.display = "none"; };

    const startBtn = ui.querySelector("#hb-start-btn");
    if (startBtn) startBtn.onclick = startGrabbing;

    const stopBtn = ui.querySelector("#hb-stop-btn");
    if (stopBtn) stopBtn.onclick = stopGrabbing;

    // 定期注入按钮
    setInterval(injectRowShortcuts, 1500);
  }

  function addUILog(type, message) {
    const box = document.getElementById("hb-log-box");
    if (!box) return;
    const item = document.createElement("div");
    item.textContent = message;
    box.appendChild(item);
    box.scrollTop = box.scrollHeight;
    while (box.children.length > 30) box.removeChild(box.firstChild);
  }

  function updateButtonStates() {
    const startBtn = document.getElementById("hb-start-btn");
    const stopBtn = document.getElementById("hb-stop-btn");
    if (startBtn) startBtn.disabled = isRunning;
    if (stopBtn) stopBtn.disabled = !isRunning;
  }

  function updateStatusDisplay() {
    const txt = document.getElementById("hb-status-text");
    const cnt = document.getElementById("hb-stat-count");
    if (txt) {
      txt.textContent = isRunning ? "正在自动抢课中..." : "未运行";
      txt.style.color = isRunning ? "#4ade80" : "#64748b";
    }
    if (cnt) cnt.textContent = `尝试: ${attemptCount}次`;
  }

  function renderCourseList() {
    const list = document.getElementById("hb-course-list");
    if (!list) return;
    if (TARGET_COURSES.length === 0) {
      list.innerHTML = '<div style="text-align:center;color:#475569;font-size:11px;padding:6px;">未添加课程 (点击表格里的⚡抢这门)</div>';
      return;
    }
    list.innerHTML = TARGET_COURSES.map((item, idx) => `
      <div class="hb-item">
        <span><b>${item.code}</b></span>
        <span onclick="window.hubuGrab.removeCourse(${idx})" style="color:#f87171;cursor:pointer;padding:0 4px;">×</span>
      </div>
    `).join("");
  }

  __HUBU_GLOBAL__.hubuGrab = {
    start: startGrabbing,
    stop: stopGrabbing,
    removeCourse: (idx) => {
      TARGET_COURSES.splice(idx, 1);
      renderCourseList();
    },
    showUI: () => {
      const u = document.getElementById("hubuCourseGrabberUI");
      if (u) {
        u.style.display = "flex";
      } else {
        createUI();
      }
    }
  };

  // 确保界面立即渲染
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", createUI);
  } else {
    createUI();
  }

  console.log("%c[HUBU抢课] 脚本已成功载入！", "color: #38bdf8; font-weight: bold; font-size: 14px;");
})();
