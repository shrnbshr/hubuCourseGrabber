// ==UserScript==
// @name         湖北大学强智教务自动抢课助手 (HUBU Course Grabber)
// @namespace    https://github.com/shrnbshr/hubuCourseGrabber
// @version      1.2.0
// @description  专为湖北大学强智教务系统定制，针对 xsxk_index 和 DataTables 深度优化，支持一键点选抢课、自动查询刷新与弹窗放行
// @author       HUBU
// @homepageURL  https://github.com/shrnbshr/hubuCourseGrabber
// @supportURL   https://github.com/shrnbshr/hubuCourseGrabber/issues
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
  const STORAGE_KEY_TARGETS = "__HUBU_GRABBER_TARGET_COURSES__";
  const STORAGE_KEY_RUNNING = "__HUBU_GRABBER_IS_RUNNING__";

  // ========== 1. 严格业务模块过滤：非选课页面（成绩/学籍/课表等）绝对静默退出 ==========
  function isCoursePageContext() {
    try {
      const curUrl = window.location.href || "";
      if (curUrl.includes("/jsxsd/xsxk/")) return true;
      if (window.top && window.top.location && window.top.location.href.includes("/jsxsd/xsxk/")) return true;
      if (window.parent && window.parent.location && window.parent.location.href.includes("/jsxsd/xsxk/")) return true;
    } catch (e) {
      if ((window.location.href || "").includes("/jsxsd/xsxk/")) return true;
    }

    // 页面选课专属特征兜底检测
    try {
      const pageText = document.body ? (document.body.innerText || "") : "";
      if (pageText.includes("安全退出选课") || pageText.includes("公选课选课")) {
        return true;
      }
    } catch (e) {}

    return false;
  }

  if (!isCoursePageContext()) {
    return;
  }

  // ========== 2. 严格 Frame 过滤：只有真正承载选课操作的 Frame 才运行，作息时间表等直接退出 ==========
  const isCourseFrame = Boolean(
    document.getElementById("dataView") ||
    typeof window.queryKxkcList === "function" ||
    document.querySelector("input[onclick*='queryKxkcList']")
  );

  if (!isCourseFrame) {
    return;
  }

  // 停止旧实例
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
  let TARGET_COURSES = [];
  let CHECK_INTERVAL = 1200;
  let REFRESH_INTERVAL_TICKS = 3;
  let MAX_ATTEMPTS = 6000;
  let MAX_CONSECUTIVE_FAILS = 10;

  // ========== 状态机 ==========
  let isRunning = false;
  let attemptCount = 0;
  let intervalId = null;
  let lastAlertMsg = "";

  const courseStates = new Map();
  const selectedCourseIds = new Set();
  const activeCourseIds = new Set();

  function saveState() {
    try {
      sessionStorage.setItem(STORAGE_KEY_TARGETS, JSON.stringify(TARGET_COURSES));
      sessionStorage.setItem(STORAGE_KEY_RUNNING, isRunning ? "1" : "0");
    } catch (e) {}
  }

  function restoreState() {
    try {
      const savedTargets = sessionStorage.getItem(STORAGE_KEY_TARGETS);
      const savedRunning = sessionStorage.getItem(STORAGE_KEY_RUNNING);
      if (savedTargets) {
        const parsed = JSON.parse(savedTargets);
        if (Array.isArray(parsed) && parsed.length > 0) {
          TARGET_COURSES = parsed;
          renderCourseList();
          log(`已从会话恢复 ${TARGET_COURSES.length} 门监控课程`, "info");
        }
      }
      if (savedRunning === "1" && TARGET_COURSES.length > 0 && !isRunning) {
        log("检测到之前正在抢课，自动恢复抢课任务...", "success");
        setTimeout(startGrabbing, 600);
      }
    } catch (e) {}
  }

  function log(message, type = "info", tagText = null) {
    const timeStr = new Date().toLocaleTimeString();
    const tag = tagText ? `[${tagText}] ` : "";
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

  function getCourseState(id) {
    if (!courseStates.has(id)) {
      courseStates.set(id, {
        attempts: 0,
        fails: 0,
        success: false,
        selecting: false
      });
    }
    return courseStates.get(id);
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

      const cells = row.cells;
      const lastCell = cells[cells.length - 1];
      if (!lastCell) continue;

      const info = extractClassInfoFromRow(row);
      if (!info || !info.id) continue;

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
        addCourseAndStart(info);
      };
      lastCell.appendChild(quickBtn);
    }
  }

  // ========== 提取教学班信息 ==========
  function extractClassInfoFromRow(row) {
    const cells = row.cells;
    if (!cells || cells.length < 8) return null;

    const lastCell = cells[cells.length - 1];
    const rowHtml = row.innerHTML || "";
    const lastCellHtml = lastCell ? lastCell.innerHTML : "";

    let jx0404id = "";
    let xsxkArgs = null;

    const funMatch = (lastCellHtml || rowHtml).match(/xsxkFun\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)/);
    if (funMatch) {
      jx0404id = funMatch[1];
      xsxkArgs = [funMatch[1], funMatch[2], funMatch[3]];
    }

    if (!jx0404id && lastCell) {
      const divWithId = lastCell.querySelector("div[id^='div_']");
      if (divWithId && divWithId.id) {
        jx0404id = divWithId.id.replace(/^div_/, "").trim();
      }
    }

    let courseName = "";
    let courseCode = "";

    const nameLink = row.querySelector("a[href*='openkcjj']");
    if (nameLink) {
      courseName = (nameLink.textContent || "").trim();
    }

    for (let i = 0; i < Math.min(cells.length, 3); i++) {
      const txt = (cells[i]?.textContent || "").trim();
      if (!courseCode && /^\d{6,14}$/.test(txt)) {
        courseCode = txt;
      } else if (!courseName && txt && !/^\d+$/.test(txt)) {
        courseName = txt;
      }
    }

    if (!courseCode) courseCode = cells[0]?.textContent.trim() || "";
    if (!courseName) courseName = cells[1]?.textContent.trim() || courseCode;

    const teacher = cells[4]?.textContent.trim() || "";
    const timeInfo = cells[5]?.textContent.trim() || "";

    if (!jx0404id) {
      jx0404id = `${courseCode}_${teacher}_${timeInfo}`.replace(/\s+/g, "_");
    }

    let remaining = 0;
    const candidateCols = [8, 7, 9];
    for (let colIdx of candidateCols) {
      if (cells[colIdx]) {
        const m = cells[colIdx].textContent.trim().match(/^\d+$/);
        if (m) {
          remaining = parseInt(m[0], 10);
          break;
        }
      }
    }

    const statusText = cells[9]?.textContent.trim() || "";
    const rowFullText = row.textContent || "";
    const isConflicted = statusText.includes("冲突") || (rowFullText.includes("冲突") && !rowFullText.includes("无冲突"));

    const isAlreadySelected =
      lastCellHtml.includes("已选") ||
      lastCellHtml.includes("退选") ||
      lastCellHtml.includes("xstkFun");

    let selectBtn = null;
    if (lastCell) {
      selectBtn = lastCell.querySelector("a[href*='xsxkFun']") ||
                  lastCell.querySelector("a:not(.hb-quick-btn)") ||
                  lastCell.querySelector("button, input[type='button']");
    }

    return {
      id: jx0404id,
      courseCode,
      courseName,
      teacher,
      timeInfo,
      capacity: remaining,
      isConflicted,
      statusText,
      isAlreadySelected,
      selectBtn,
      xsxkArgs,
      row
    };
  }

  function addCourseAndStart(info) {
    const exists = TARGET_COURSES.some((c) => c.id === info.id);
    if (!exists) {
      TARGET_COURSES.push({
        id: info.id,
        code: info.courseCode,
        name: info.courseName,
        teacher: info.teacher,
        timeInfo: info.timeInfo,
        priority: 1
      });
      saveState();
      renderCourseList();
      log(`已添加监控: ${info.courseName} (${info.teacher} ${info.timeInfo})`, "success");
    }
    if (!isRunning) {
      startGrabbing();
    }
  }

  // ========== 扫描并提取选课行 ==========
  function scanDataViewTable(targetIdOrCode) {
    const target = String(targetIdOrCode).trim();
    if (!target) return [];

    const ctx = getActiveContext();
    const { doc, win } = ctx;
    const table = doc.getElementById("dataView");
    if (!table) return [];

    const rows = table.querySelectorAll("tbody tr");
    const matched = [];

    for (let row of rows) {
      if (row.classList.contains("dataTables_empty") || row.cells.length < 5) continue;

      const info = extractClassInfoFromRow(row);
      if (!info) continue;

      info.win = win;
      info.doc = doc;

      if (info.id === target || info.courseCode === target || info.courseName.includes(target)) {
        matched.push(info);
      }
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
    const { win, doc, id, courseName, courseCode, selectBtn, xsxkArgs, row } = teachingClass;
    const state = getCourseState(id);

    if (state.selecting) return;
    state.selecting = true;
    lastAlertMsg = "";

    log(`🎯 发现空位(余量:${teachingClass.capacity})！发起选课 [${courseName}]...`, "warning", courseCode);
    hookDialogs(win);

    let executed = false;

    if (xsxkArgs && xsxkArgs.length >= 3) {
      const [jx0404id, token, extra] = xsxkArgs;
      try {
        if (typeof win.xsxkFun === "function") {
          win.xsxkFun(jx0404id, token, extra);
          executed = true;
        } else {
          const script = doc.createElement("script");
          script.textContent = `if (typeof xsxkFun === 'function') { xsxkFun("${jx0404id}", "${token}", "${extra}"); }`;
          (doc.head || doc.body || doc.documentElement).appendChild(script);
          script.remove();
          executed = true;
        }
      } catch (err) {}
    }

    if (!executed) {
      try {
        if (selectBtn) {
          selectBtn.click();
        } else if (row) {
          const lastCell = row.cells[row.cells.length - 1];
          const clickable = lastCell.querySelector("[onclick]:not(.hb-quick-btn)");
          if (clickable) clickable.click();
        }
      } catch (e) {}
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
          state.success = true;
          selectedCourseIds.add(id);
          activeCourseIds.delete(id);
          log(`🎊 恭喜！成功选上课程: ${courseName}！`, "success", courseCode);

          if (activeCourseIds.size === 0) {
            log("🎉 监控课程已全部抢到！", "success");
            stopGrabbing();
          }
        } else if (msg) {
          state.fails++;
          log(`选课未成功: ${msg}`, "warning", courseCode);
        } else {
          const recheck = scanDataViewTable(id);
          const curr = recheck.find((c) => c.id === id);
          if (curr && curr.isAlreadySelected) {
            state.success = true;
            selectedCourseIds.add(id);
            activeCourseIds.delete(id);
            log(`🎊 恭喜！成功选上课程: ${courseName}！`, "success", courseCode);

            if (activeCourseIds.size === 0) {
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
        saveState();
      }
    }, 1500);
  }

  // ========== 轮询逻辑 ==========
  function tick() {
    if (!isRunning || activeCourseIds.size === 0) return;
    attemptCount++;

    const ctx = getActiveContext();

    if (attemptCount % REFRESH_INTERVAL_TICKS === 0) {
      triggerTableRefresh(ctx);
      setTimeout(injectRowShortcuts, 500);
      return;
    }

    const sorted = TARGET_COURSES.filter((c) => activeCourseIds.has(c.id)).sort(
      (a, b) => (a.priority || 999) - (b.priority || 999)
    );

    for (let cfg of sorted) {
      const state = getCourseState(cfg.id);
      if (state.success || state.selecting) continue;

      const classes = scanDataViewTable(cfg.id);
      if (classes.length === 0) continue;

      const sel = classes.find((c) => c.isAlreadySelected);
      if (sel) {
        state.success = true;
        selectedCourseIds.add(cfg.id);
        activeCourseIds.delete(cfg.id);
        log(`已选上: ${sel.courseName}`, "success", cfg.code);
        saveState();
        continue;
      }

      for (let c of classes) {
        if (c.isConflicted) {
          if (attemptCount % 8 === 0) {
            log(`[${c.courseName}] 提示时间冲突(${c.statusText || "冲突"})，暂无法选课`, "warning", cfg.code);
          }
          continue;
        }
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
    activeCourseIds.clear();

    for (let c of TARGET_COURSES) {
      activeCourseIds.add(c.id);
      const s = getCourseState(c.id);
      s.fails = 0;
      s.selecting = false;
    }

    saveState();
    log(`🚀 开始抢课！监控中: ${activeCourseIds.size} 门教学班`, "success");
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
    saveState();
    log("⏹️ 已停止抢课", "warning");
    updateButtonStates();
    updateStatusDisplay();
  }

  // ========== UI 悬浮面板 ==========
  function createUI() {
    if (document.getElementById("hubuCourseGrabberUI")) return;

    // 全屏跨 Frame 检查：已有存活面板则不重复生成
    try {
      if (window.top && window.top.__HUBU_ACTIVE_PANEL__ && window.top.__HUBU_ACTIVE_PANEL__.isConnected) {
        return;
      }
    } catch (e) {}

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
        width: 330px !important;
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
      .hb-list { max-height: 140px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; }
      .hb-item { background: #020617; padding: 6px 8px; border-radius: 4px; display: flex; justify-content: space-between; align-items: center; font-size: 11px; border: 1px solid #1e293b; }
      .hb-item-info { overflow: hidden; }
      .hb-item-title { font-weight: bold; color: #f8fafc; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .hb-item-sub { color: #64748b; font-size: 10px; margin-top: 2px; }
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

    try {
      if (window.top) {
        window.top.__HUBU_ACTIVE_PANEL__ = ui;
      }
    } catch (e) {}

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

    renderCourseList();
    updateButtonStates();
    updateStatusDisplay();

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
        <div class="hb-item-info">
          <div class="hb-item-title">${item.name} (${item.code})</div>
          <div class="hb-item-sub">👨‍🏫 ${item.teacher || "无教师"} | ⏰ ${item.timeInfo || "无时间"}</div>
        </div>
        <span onclick="window.hubuGrab.removeCourse(${idx})" style="color:#f87171;cursor:pointer;padding:0 6px;font-size:16px;font-weight:bold;">×</span>
      </div>
    `).join("");
  }

  __HUBU_GLOBAL__.hubuGrab = {
    start: startGrabbing,
    stop: stopGrabbing,
    removeCourse: (idx) => {
      TARGET_COURSES.splice(idx, 1);
      saveState();
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

  // 确保界面渲染并恢复状态
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      createUI();
      restoreState();
    });
  } else {
    createUI();
    restoreState();
  }

  console.log("%c[HUBU抢课] 脚本已成功载入！", "color: #38bdf8; font-weight: bold; font-size: 14px;");
})();
