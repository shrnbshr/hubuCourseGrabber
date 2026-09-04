/**
 * 湖北大学强智教务系统（jsxsd）自动抢课辅助脚本 - 深度适配版
 * 适用系统：强智科技教务管理系统 (URL特征: /jsxsd/...)
 * 页面特征：jQuery DataTables (#dataView) + queryKxkcList()
 * 
 * 使用说明：
 * 1. 登录湖北大学教务系统，进入选课页面（确保能看到包含“查询”按钮和 #dataView 数据表的页面）；
 * 2. 按 F12 打开开发者工具，切换到 Console 面板；
 * 3. 复制并粘贴此脚本全部代码，回车执行；
 * 4. 在右上角控制面板中添加目标课程代码（如 9000111001）或课程名，点击“开始抢课”。
 */

(function () {
  "use strict";

  const __HUBU_GLOBAL__ = window;
  const __HUBU_LOADED_KEY__ = "__HUBU_COURSE_GRABBER_LOADED__";
  const __HUBU_INSTANCE_KEY__ = "__HUBU_COURSE_GRABBER_INSTANCE_ID__";

  // 跨 Frame 检查：只有包含选课表格的 Frame 才能渲染控制台
  const isCourseFrame = Boolean(
    document.getElementById("dataView") ||
    typeof window.queryKxkcList === "function" ||
    document.querySelector("input[onclick*='queryKxkcList']")
  );

  if (!isCourseFrame && window !== window.top) {
    return;
  }

  try {
    if (window.top && window.top.__HUBU_GLOBAL_PANEL_EXISTS__) {
      return;
    }
    if (window.top) {
      window.top.__HUBU_GLOBAL_PANEL_EXISTS__ = true;
    }
  } catch (e) {}

  // 单例保护
  if (__HUBU_GLOBAL__[__HUBU_LOADED_KEY__]) {
    try {
      if (__HUBU_GLOBAL__.hubuGrab && typeof __HUBU_GLOBAL__.hubuGrab.stop === "function") {
        __HUBU_GLOBAL__.hubuGrab.stop();
      }
    } catch (e) {}
    console.warn("[HUBU抢课] 已停止旧实例并加载最新配置。");
  }

  __HUBU_GLOBAL__[__HUBU_LOADED_KEY__] = true;
  __HUBU_GLOBAL__[__HUBU_INSTANCE_KEY__] = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  // ========== 配置项 ==========
  const TARGET_COURSES = []; // [{ code: '9000111001', priority: 1, timeFilter: [], teacherFilter: [] }]
  let CHECK_INTERVAL = 1200; // 轮询检查间隔(毫秒)
  let REFRESH_INTERVAL_TICKS = 3; // 每轮询 3 次触发一次 queryKxkcList() 查询刷新
  let MAX_ATTEMPTS = 6000;
  let MAX_CONSECUTIVE_FAILS = 10;

  // ========== 状态机 ==========
  let isRunning = false;
  let attemptCount = 0;
  let intervalId = null;
  let scheduledTimerId = null;
  let scheduledTargetTime = null;

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
        selecting: false,
        lastCapacity: -1
      });
    }
    return courseStates.get(code);
  }

  // ========== Iframe 穿透查找 ==========
  function getActiveContext() {
    // 递归检索包含 #dataView 表格的 window 和 document
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

    const matched = searchWin(window);
    if (matched) return matched;
    // 兜底返回顶层
    return { win: window, doc: window.document };
  }

  // ========== 行内快捷按钮注入（一键点击加监控） ==========
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
          const exists = TARGET_COURSES.some((c) => c.code === code);
          if (!exists) {
            TARGET_COURSES.push({ code, priority: 1, timeFilter: [], teacherFilter: [] });
            renderCourseList();
            log(`已一键加入监控: ${name || code} (${code})`, "success");
          }
          if (!isRunning) {
            startGrabbing();
          }
        };
        lastCell.appendChild(quickBtn);
      }
    }
  }

  // ========== 触发 DataTables 查询刷新 ==========
  function triggerTableRefresh(ctx) {
    try {
      const { win, doc } = ctx;
      if (typeof win.queryKxkcList === "function") {
        win.queryKxkcList();
        log("🔄 已触发 queryKxkcList() 刷新最新余量", "info");
        setTimeout(injectRowShortcuts, 400);
        return true;
      }

      const queryBtn = doc.querySelector('input[type="button"][value="查询"], button.el-button');
      if (queryBtn) {
        queryBtn.click();
        log("🔄 已点击页面查询按钮刷新", "info");
        return true;
      }
    } catch (e) {
      log(`刷新失败: ${e.message}`, "warning");
    }
    return false;
  }

  // ========== 解析 #dataView 表格课程 ==========
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
      // 排除无数据行 (如 "表中数据为空")
      if (row.classList.contains("dataTables_empty") || row.cells.length < 5) continue;

      const cells = row.cells;
      const rowText = (row.textContent || "").trim();

      // 列索引匹配 (依据实际 DOM 结构):
      // cell[0]: 课程代码 (如 9000111001)
      // cell[1]: 课程名称
      // cell[3]: 学分 (如 2)
      // cell[4]: 教师
      // cell[5]: 上课时间
      // cell[6]: 地点/周次
      // cell[7]: 校区 (如 长江新区校区)
      // cell[8]: 余量 (如 0)
      // cell[9]: 冲突/选课状态说明 (如 "与已选课程...冲突")
      // cell[10]: 课程归属/类别
      // cell[最后]: 操作列 (选课按钮/链接)

      const courseCode = cells[0] ? cells[0].textContent.trim() : "";
      const courseName = cells[1] ? cells[1].textContent.trim() : "";

      let isHit = false;
      if (courseCode === target || courseCode.includes(target)) {
        isHit = true;
      } else if (courseName && courseName.includes(target)) {
        isHit = true;
      } else if (rowText.includes(target)) {
        isHit = true;
      }

      if (!isHit) continue;

      const teacher = cells[4] ? cells[4].textContent.trim() : (cells[2]?.textContent.trim() || "");
      const timeInfo = cells[5] ? cells[5].textContent.trim() : "";
      const capacityText = cells[8] ? cells[8].textContent.trim() : "";
      const statusText = cells[9] ? cells[9].textContent.trim() : "";

      // 余量数值解析
      let remaining = 0;
      const numMatch = capacityText.match(/\d+/);
      if (numMatch) {
        remaining = parseInt(numMatch[0], 10);
      }

      // 是否时间冲突 (cell[9] 直接提示)
      const isConflicted = statusText.includes("冲突");

      // 提取操作列按钮
      const lastCell = cells[cells.length - 1];
      let selectBtn = null;
      let isAlreadySelected = false;

      if (rowText.includes("已选") || rowText.includes("退选") || (lastCell && lastCell.textContent.includes("退选"))) {
        isAlreadySelected = true;
      }

      if (lastCell) {
        // 查找包含选课的按钮或链接
        const candidates = lastCell.querySelectorAll("a, button, input[type='button'], input[type='submit']");
        for (let el of candidates) {
          const t = (el.textContent || el.value || "").trim();
          const onclickStr = el.getAttribute("onclick") || "";
          if (t.includes("选课") || onclickStr.includes("choose") || onclickStr.includes("xk") || onclickStr.includes("setXk")) {
            if (!t.includes("退选")) {
              selectBtn = el;
              break;
            }
          }
        }
        // 若没找到文字，取最后一个单元格中的第一个可点击链接
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

  // ========== 过滤器校验 ==========
  function checkFilters(item, courseConfig) {
    const timeFilters = courseConfig.timeFilter || [];
    const teacherFilters = courseConfig.teacherFilter || [];

    if (timeFilters.length > 0) {
      const match = timeFilters.some((kw) => item.timeInfo.includes(kw));
      if (!match) return { pass: false, reason: `时间不符: ${item.timeInfo}` };
    }

    if (teacherFilters.length > 0) {
      const match = teacherFilters.some((kw) => item.teacher.includes(kw));
      if (!match) return { pass: false, reason: `教师不符: ${item.teacher}` };
    }

    return { pass: true };
  }

  // ========== 拦截并放行确认弹窗 ==========
  function hookDialogs(win) {
    if (!win) return;
    try {
      win.confirm = function (msg) {
        log(`拦截到系统确认: "${msg}"，自动确认`, "info");
        return true;
      };
      const origAlert = win.alert;
      win.alert = function (msg) {
        log(`教务系统提示: "${msg}"`, "warning");
      };
    } catch (e) {}
  }

  // ========== 触发提交选课 ==========
  function executeSelect(teachingClass) {
    const { win, doc, btn, courseCode, courseName, id, row } = teachingClass;
    const state = getCourseState(courseCode);

    if (state.selecting) return;
    state.selecting = true;

    log(`🎯 发现空位 (余量: ${teachingClass.capacity})！发起选课提交 [${courseName}]...`, "warning", courseCode);

    hookDialogs(win);

    try {
      if (btn) {
        btn.click();
      } else {
        // 尝试从单元格或行属性调用 onclick
        const lastCell = row.cells[row.cells.length - 1];
        const clickable = lastCell.querySelector("[onclick]");
        if (clickable) {
          clickable.click();
        } else {
          log("未找到可点击的选课触发元素", "error", courseCode);
          state.selecting = false;
          return;
        }
      }

      // 检查 EasyUI 弹出的确认窗口
      setTimeout(() => {
        try {
          const easyUiBtns = doc.querySelectorAll(".panel.window .l-btn, .panel.window .el-button, .messager-button a");
          for (let b of easyUiBtns) {
            const txt = (b.textContent || "").trim();
            if (txt.includes("确定") || txt.includes("是") || txt.includes("OK")) {
              b.click();
              log("已自动点击 EasyUI 确认对话框", "info", courseCode);
              break;
            }
          }
        } catch (err) {}
      }, 300);

      // 核验结果
      setTimeout(() => {
        try {
          const recheck = scanDataViewTable(courseCode);
          const curr = recheck.find((c) => c.id === id);

          if (curr && curr.isAlreadySelected) {
            state.success = true;
            selectedCourses.add(courseCode);
            activeCourses.delete(courseCode);

            log(`🎊 抢课成功！已选上: ${courseName} (${courseCode})`, "success", courseCode);

            if (__HUBU_GLOBAL__.Notification && Notification.permission === "granted") {
              new Notification("抢课成功！", {
                body: `湖北大学强智教务: ${courseName} 选课成功！`
              });
            }

            if (activeCourses.size === 0) {
              log("🎉 所有监控课程已全部完成！", "success");
              stopGrabbing();
            }
          } else {
            state.fails++;
            log(`选课动作已完成，等待刷新复验 (重试次数: ${state.fails})`, "info", courseCode);
            if (state.fails >= MAX_CONSECUTIVE_FAILS) {
              log(`课程 ${courseCode} 连续失败超限，暂时挂起`, "error", courseCode);
            }
          }
        } catch (err) {
          log(`核验异常: ${err.message}`, "error", courseCode);
        } finally {
          state.selecting = false;
        }
      }, 1500);
    } catch (e) {
      log(`选课触发异常: ${e.message}`, "error", courseCode);
      state.selecting = false;
    }
  }

  // ========== 单门课程轮询逻辑 ==========
  function processCourse(cfg) {
    const { code } = cfg;
    const state = getCourseState(code);

    if (state.success || state.selecting) return;

    state.attempts++;
    const classes = scanDataViewTable(code);

    if (classes.length === 0) {
      if (state.attempts % 6 === 0) {
        log(`未在表格中找到课程 "${code}"，请确认该课程已出现在当前页`, "warning", code);
      }
      return;
    }

    // 校验是否已在已选状态
    const sel = classes.find((c) => c.isAlreadySelected);
    if (sel) {
      state.success = true;
      selectedCourses.add(code);
      activeCourses.delete(code);
      log(`课程此前已选上: ${sel.courseName}`, "success", code);
      return;
    }

    for (let c of classes) {
      // 冲突直接跳过
      if (c.isConflicted) {
        if (state.attempts % 8 === 0) {
          log(`课程与课表时间冲突 (${c.statusText})，跳过该班`, "warning", code);
        }
        continue;
      }

      // 过滤器判断
      const fRes = checkFilters(c, cfg);
      if (!fRes.pass) continue;

      // 名额检测
      if (c.capacity > 0) {
        executeSelect(c);
        return;
      }
    }
  }

  // ========== 主轮询循环 ==========
  function tick() {
    if (!isRunning || activeCourses.size === 0) return;
    attemptCount++;

    if (attemptCount > MAX_ATTEMPTS) {
      log(`已达最大轮询次数 ${MAX_ATTEMPTS}，停止运行`, "warning");
      stopGrabbing();
      return;
    }

    const ctx = getActiveContext();

    // 周期性调用教务系统自带的查询刷新函数
    if (attemptCount % REFRESH_INTERVAL_TICKS === 0) {
      triggerTableRefresh(ctx);
    }

    // 按优先级排序执行
    const sorted = TARGET_COURSES.filter((c) => activeCourses.has(c.code)).sort(
      (a, b) => (a.priority || 999) - (b.priority || 999)
    );

    for (let cfg of sorted) {
      processCourse(cfg);
    }

    updateStatusDisplay();
  }

  // ========== 启停控制 ==========
  function startGrabbing() {
    if (isRunning) {
      log("脚本已在运行中", "warning");
      return;
    }

    if (TARGET_COURSES.length === 0) {
      alert("请先添加至少一门目标课程！");
      return;
    }

    if (__HUBU_GLOBAL__.Notification && Notification.permission === "default") {
      Notification.requestPermission();
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

    log(`🚀 启动抢课！监控 ${activeCourses.size} 门课程，间隔: ${CHECK_INTERVAL}ms`, "success");

    // 启动时立即主动刷新一次表格
    triggerTableRefresh(getActiveContext());

    setTimeout(tick, 500);
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

    log("⏹️ 抢课已停止", "warning");
    updateButtonStates();
    updateStatusDisplay();
  }

  // ========== 定时功能 ==========
  function scheduleStart(dateTimeStr) {
    const target = new Date(dateTimeStr);
    if (isNaN(target.getTime())) {
      alert("时间格式无效！");
      return false;
    }
    if (target <= new Date()) {
      alert("开抢时间必须晚于当前时间！");
      return false;
    }

    scheduledTargetTime = target;
    if (scheduledTimerId) clearInterval(scheduledTimerId);

    const timerBox = document.getElementById("hubu-timer-box");
    if (timerBox) timerBox.style.display = "block";

    log(`⏰ 定时开抢已设定: ${target.toLocaleString()}`, "info");

    scheduledTimerId = setInterval(() => {
      const now = new Date();
      const diff = scheduledTargetTime - now;

      if (diff <= 0) {
        clearInterval(scheduledTimerId);
        scheduledTimerId = null;
        if (timerBox) timerBox.style.display = "none";
        log("⏰ 时间到，自动开始抢课！", "success");
        startGrabbing();
      } else {
        const s = Math.floor(diff / 1000);
        const hh = String(Math.floor(s / 3600)).padStart(2, "0");
        const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
        const ss = String(s % 60).padStart(2, "0");
        const ms = String(Math.floor((diff % 1000) / 100));

        if (timerBox) {
          timerBox.textContent = `⏳ 倒计时: ${hh}:${mm}:${ss}.${ms}`;
        }
      }
    }, 100);

    return true;
  }

  function cancelSchedule() {
    if (scheduledTimerId) {
      clearInterval(scheduledTimerId);
      scheduledTimerId = null;
    }
    scheduledTargetTime = null;
    const timerBox = document.getElementById("hubu-timer-box");
    if (timerBox) timerBox.style.display = "none";
    log("⏰ 已取消定时", "warning");
  }

  // ========== UI 悬浮面板 ==========
  function createUI() {
    if (document.getElementById("hubuCourseGrabberUI")) return;

    const style = document.createElement("style");
    style.textContent = `
      #hubuCourseGrabberUI {
        position: fixed;
        top: 24px;
        right: 24px;
        width: min(420px, calc(100vw - 32px));
        max-height: min(88vh, 760px);
        background: #090d16;
        border: 1px solid #1e293b;
        border-radius: 14px;
        box-shadow: 0 20px 50px rgba(0, 0, 0, 0.6);
        z-index: 9999999;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", sans-serif;
        color: #f1f5f9;
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }
      #hubuCourseGrabberUI * { box-sizing: border-box; }
      .hb-header {
        padding: 12px 16px;
        background: #0f172a;
        border-bottom: 1px solid #1e293b;
        display: flex;
        justify-content: space-between;
        align-items: center;
        cursor: move;
        user-select: none;
      }
      .hb-title {
        font-size: 14px;
        font-weight: 700;
        display: flex;
        align-items: center;
        gap: 8px;
        color: #38bdf8;
      }
      .hb-controls { display: flex; gap: 6px; }
      .hb-ctrl-btn {
        background: #1e293b;
        border: 1px solid #334155;
        color: #94a3b8;
        border-radius: 6px;
        width: 26px;
        height: 26px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        font-size: 13px;
      }
      .hb-ctrl-btn:hover { color: #f8fafc; background: #334155; }
      .hb-body {
        padding: 14px;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .hb-card {
        background: #0f172a;
        border: 1px solid #1e293b;
        border-radius: 10px;
        padding: 12px;
      }
      .hb-card-title {
        font-size: 12px;
        font-weight: 700;
        color: #94a3b8;
        margin-bottom: 8px;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .hb-input {
        width: 100%;
        background: #020617;
        border: 1px solid #334155;
        color: #f8fafc;
        border-radius: 6px;
        padding: 8px 10px;
        font-size: 12px;
        margin-bottom: 6px;
        outline: none;
      }
      .hb-input:focus { border-color: #38bdf8; }
      .hb-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        padding: 8px 12px;
        border-radius: 6px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        border: 1px solid transparent;
        transition: all 0.15s;
      }
      .hb-btn-primary { background: #0284c7; color: white; }
      .hb-btn-primary:hover:not(:disabled) { background: #0369a1; }
      .hb-btn-danger { background: #be123c; color: white; }
      .hb-btn-danger:hover:not(:disabled) { background: #9f1239; }
      .hb-btn-secondary { background: #1e293b; color: #cbd5e1; border-color: #334155; }
      .hb-btn-secondary:hover:not(:disabled) { background: #334155; }
      .hb-btn:disabled { opacity: 0.5; cursor: not-allowed; }
      .hb-btn-block { width: 100%; }
      .hb-course-list {
        max-height: 150px;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .hb-course-item {
        background: #020617;
        border: 1px solid #1e293b;
        padding: 8px 10px;
        border-radius: 6px;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .hb-course-info { font-size: 12px; }
      .hb-tag {
        font-size: 10px;
        padding: 2px 6px;
        border-radius: 4px;
        background: #1e293b;
        color: #38bdf8;
        margin-left: 4px;
      }
      .hb-timer-box {
        background: #1e1b4b;
        border: 1px solid #4338ca;
        color: #a5b4fc;
        padding: 10px;
        border-radius: 6px;
        font-family: monospace;
        font-size: 14px;
        text-align: center;
        font-weight: bold;
        display: none;
      }
      .hb-log-box {
        background: #020617;
        border: 1px solid #1e293b;
        border-radius: 6px;
        padding: 8px;
        max-height: 120px;
        overflow-y: auto;
        font-family: Consolas, monospace;
        font-size: 11px;
        line-height: 1.5;
        color: #94a3b8;
      }
      .hb-log-item { margin-bottom: 2px; word-break: break-all; }
      .hb-minimized { width: 120px !important; }
      .hb-minimized .hb-body, .hb-minimized .hb-title span { display: none !important; }
    `;
    document.head.appendChild(style);

    const container = document.createElement("div");
    container.id = "hubuCourseGrabberUI";
    container.innerHTML = `
      <div class="hb-header" id="hubu-header">
        <div class="hb-title">
          <span>🎓</span>
          <span>HUBU 抢课助手 (DataTables适配版)</span>
        </div>
        <div class="hb-controls">
          <button class="hb-ctrl-btn" id="hb-btn-min" title="最小化">−</button>
          <button class="hb-ctrl-btn" id="hb-btn-close" title="关闭">×</button>
        </div>
      </div>
      <div class="hb-body">
        <!-- 运行状态 -->
        <div class="hb-card">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <div style="font-size: 12px; display: flex; align-items: center; gap: 6px;">
              <span id="hb-status-dot" style="width: 8px; height: 8px; border-radius: 50%; background: #64748b;"></span>
              <span id="hb-status-text">未运行</span>
            </div>
            <div style="font-size: 11px; color: #64748b;" id="hb-stat-count">尝试: 0次</div>
          </div>
        </div>

        <!-- 课程添加 -->
        <div class="hb-card">
          <div class="hb-card-title">📚 添加目标课程</div>
          <input type="text" class="hb-input" id="hb-input-code" placeholder="课程代码或名称 (例: 9000111001)">
          <div style="display: flex; gap: 6px;">
            <input type="number" class="hb-input" id="hb-input-priority" placeholder="优先级" value="1" min="1" style="flex: 1;">
            <input type="number" class="hb-input" id="hb-input-interval" placeholder="轮询间隔(ms)" value="1200" min="600" style="flex: 1.5;">
          </div>
          <input type="text" class="hb-input" id="hb-input-time" placeholder="时间过滤关键词 (例: 星期一,1-2节 逗号隔开)">
          <input type="text" class="hb-input" id="hb-input-teacher" placeholder="教师过滤关键词 (例: 张三,教授)">
          <button class="hb-btn hb-btn-secondary hb-btn-block" id="hb-btn-add">➕ 添加到监控列表</button>
        </div>

        <!-- 目标课程列表 -->
        <div class="hb-card">
          <div class="hb-card-title">📋 监控队列 (<span id="hb-target-count">0</span>)</div>
          <div class="hb-course-list" id="hb-course-list">
            <div style="text-align: center; color: #64748b; font-size: 11px; padding: 10px;">暂无监控课程</div>
          </div>
        </div>

        <!-- 定时开抢 -->
        <div class="hb-card">
          <div class="hb-card-title">⏰ 定时开抢</div>
          <div style="display: flex; gap: 6px;">
            <input type="datetime-local" class="hb-input" id="hb-schedule-input" style="margin-bottom: 0;">
            <button class="hb-btn hb-btn-secondary" id="hb-schedule-btn" style="white-space: nowrap;">设定</button>
          </div>
          <div class="hb-timer-box" id="hubu-timer-box"></div>
        </div>

        <!-- 控制按钮 -->
        <div style="display: flex; gap: 8px;">
          <button class="hb-btn hb-btn-primary" id="hb-start-btn" style="flex: 1;">🚀 开始抢课</button>
          <button class="hb-btn hb-btn-danger" id="hb-stop-btn" style="flex: 1;" disabled>⏹️ 停止</button>
        </div>
        <button class="hb-btn hb-btn-secondary hb-btn-block" id="hb-debug-btn">🔍 扫描当前 #dataView 表格</button>

        <!-- 实时日志 -->
        <div class="hb-card">
          <div class="hb-card-title">📝 运行日志</div>
          <div class="hb-log-box" id="hubu-log-box"></div>
        </div>
      </div>
    `;

    document.body.appendChild(container);
    bindUIEvents(container);
  }

  function addUILog(type, message) {
    const box = document.getElementById("hubu-log-box");
    if (!box) return;

    const div = document.createElement("div");
    div.className = "hb-log-item";

    const colors = {
      success: "#4ade80",
      warning: "#facc15",
      error: "#f87171",
      info: "#94a3b8"
    };
    div.style.color = colors[type] || colors.info;
    div.textContent = message;

    box.appendChild(div);
    box.scrollTop = box.scrollHeight;

    while (box.children.length > 80) {
      box.removeChild(box.firstChild);
    }
  }

  function updateButtonStates() {
    const startBtn = document.getElementById("hb-start-btn");
    const stopBtn = document.getElementById("hb-stop-btn");
    if (startBtn) startBtn.disabled = isRunning;
    if (stopBtn) stopBtn.disabled = !isRunning;
  }

  function updateStatusDisplay() {
    const dot = document.getElementById("hb-status-dot");
    const txt = document.getElementById("hb-status-text");
    const count = document.getElementById("hb-stat-count");

    if (dot && txt) {
      if (isRunning) {
        dot.style.background = "#4ade80";
        txt.textContent = "正在抢课中...";
        txt.style.color = "#4ade80";
      } else {
        dot.style.background = "#64748b";
        txt.textContent = "未运行";
        txt.style.color = "#94a3b8";
      }
    }
    if (count) {
      count.textContent = `尝试: ${attemptCount}次`;
    }
  }

  function renderCourseList() {
    const list = document.getElementById("hb-course-list");
    const count = document.getElementById("hb-target-count");
    if (!list) return;

    count.textContent = TARGET_COURSES.length;

    if (TARGET_COURSES.length === 0) {
      list.innerHTML = '<div style="text-align: center; color: #64748b; font-size: 11px; padding: 10px;">暂无监控课程</div>';
      return;
    }

    list.innerHTML = TARGET_COURSES.map((item, idx) => {
      let filterDesc = [];
      if (item.timeFilter?.length) filterDesc.push(`时间:${item.timeFilter.join("/")}`);
      if (item.teacherFilter?.length) filterDesc.push(`教师:${item.teacherFilter.join("/")}`);

      return `
        <div class="hb-course-item">
          <div class="hb-course-info">
            <span style="font-weight: 600;">${item.code}</span>
            <span class="hb-tag">优先级 ${item.priority}</span>
            ${filterDesc.length ? `<div style="font-size: 10px; color: #64748b; margin-top: 2px;">${filterDesc.join(" | ")}</div>` : ""}
          </div>
          <button class="hb-ctrl-btn" onclick="window.hubuGrab.removeCourse(${idx})" title="移除" style="color: #f87171;">×</button>
        </div>
      `;
    }).join("");
  }

  function bindUIEvents(container) {
    const header = container.querySelector("#hubu-header") || container.querySelector(".hb-header");
    if (header) {
      let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
      header.onmousedown = function (e) {
        e.preventDefault();
        pos3 = e.clientX;
        pos4 = e.clientY;
        document.onmouseup = () => {
          document.onmouseup = null;
          document.onmousemove = null;
        };
        document.onmousemove = (ev) => {
          ev.preventDefault();
          pos1 = pos3 - ev.clientX;
          pos2 = pos4 - ev.clientY;
          pos3 = ev.clientX;
          pos4 = ev.clientY;
          container.style.top = `${container.offsetTop - pos2}px`;
          container.style.left = `${container.offsetLeft - pos1}px`;
          container.style.right = "auto";
        };
      };
    }

    const minBtn = container.querySelector("#hb-btn-min");
    if (minBtn) minBtn.onclick = () => container.classList.toggle("hb-minimized");

    const closeBtn = container.querySelector("#hb-btn-close");
    if (closeBtn) closeBtn.onclick = () => (container.style.display = "none");

    const addBtn = container.querySelector("#hb-btn-add");
    if (addBtn) {
      addBtn.onclick = () => {
        const codeInput = container.querySelector("#hb-input-code");
        const priorityInput = container.querySelector("#hb-input-priority");
        const intervalInput = container.querySelector("#hb-input-interval");
        const timeInput = container.querySelector("#hb-input-time");
        const teacherInput = container.querySelector("#hb-input-teacher");

        const code = (codeInput?.value || "").trim();
        if (!code) {
          alert("请输入课程代码！");
          return;
        }

        const priority = parseInt(priorityInput?.value, 10) || 1;
        const intervalVal = parseInt(intervalInput?.value, 10);
        if (intervalVal && intervalVal >= 500) {
          CHECK_INTERVAL = intervalVal;
        }

        const timeFilters = (timeInput?.value || "").split(/[,，;；]/).map((s) => s.trim()).filter(Boolean);
        const teacherFilters = (teacherInput?.value || "").split(/[,，;；]/).map((s) => s.trim()).filter(Boolean);

        TARGET_COURSES.push({
          code,
          priority,
          timeFilter: timeFilters,
          teacherFilter: teacherFilters
        });

        if (codeInput) codeInput.value = "";
        if (timeInput) timeInput.value = "";
        if (teacherInput) teacherInput.value = "";

        renderCourseList();
        log(`已添加监控: ${code} (优先级: ${priority})`, "success");
      };
    }

    const startBtn = container.querySelector("#hb-start-btn");
    if (startBtn) startBtn.onclick = startGrabbing;

    const stopBtn = container.querySelector("#hb-stop-btn");
    if (stopBtn) stopBtn.onclick = stopGrabbing;

    const debugBtn = container.querySelector("#hb-debug-btn");
    if (debugBtn) debugBtn.onclick = () => window.hubuGrab.debug();

    const schedBtn = container.querySelector("#hb-schedule-btn");
    if (schedBtn) {
      schedBtn.onclick = () => {
        if (scheduledTimerId) {
          cancelSchedule();
          schedBtn.textContent = "设定";
          return;
        }

        const input = container.querySelector("#hb-schedule-input");
        if (!input?.value) {
          alert("请选择开抢时间！");
          return;
        }

        if (scheduleStart(input.value)) {
          schedBtn.textContent = "取消";
        }
      };
    }

    // 循环扫描并向新加载的表格行追加“⚡ 抢这门”按钮
    setInterval(injectRowShortcuts, 1500);
  }

  // ========== 全局接口 ==========
  __HUBU_GLOBAL__.hubuGrab = {
    start: startGrabbing,
    stop: stopGrabbing,
    schedule: scheduleStart,
    cancelSchedule,
    addCourse: function (code, priority = 1, timeFilter = [], teacherFilter = []) {
      TARGET_COURSES.push({ code, priority, timeFilter, teacherFilter });
      renderCourseList();
      log(`已添加课程: ${code}`, "success");
    },
    removeCourse: function (index) {
      if (index >= 0 && index < TARGET_COURSES.length) {
        const removed = TARGET_COURSES.splice(index, 1);
        renderCourseList();
        log(`已移除课程: ${removed[0].code}`, "warning");
      }
    },
    showUI: function () {
      const ui = document.getElementById("hubuCourseGrabberUI");
      if (ui) ui.style.display = "flex";
      else createUI();
    },
    debug: function (targetKeyword = "") {
      log("=== 正在扫描当前页面 #dataView 数据表 ===", "info");
      const ctx = getActiveContext();
      const { doc } = ctx;
      const table = doc.getElementById("dataView");

      if (!table) {
        log("❌ 未在当前上下文找到 #dataView 表格，请确认是否处于选课结果页面！", "error");
        return;
      }

      const rows = table.querySelectorAll("tbody tr");
      log(`✅ 成功定位 #dataView 表格，当前展示行数: ${rows.length}`, "success");

      if (targetKeyword) {
        const matched = scanDataViewTable(targetKeyword);
        log(`针对关键词 "${targetKeyword}" 匹配到 ${matched.length} 门课程`, "info");
        console.table(matched.map((m) => ({
          课程代码: m.courseCode,
          课程名称: m.courseName,
          余量: m.capacity,
          时间冲突: m.isConflicted ? "是" : "否",
          状态说明: m.statusText,
          已有选课按钮: !!m.btn
        })));
      } else {
        const allParsed = [];
        for (let r of rows) {
          if (r.cells.length >= 8) {
            allParsed.push({
              代码: r.cells[0]?.textContent.trim(),
              名称: r.cells[1]?.textContent.trim(),
              余量: r.cells[8]?.textContent.trim(),
              冲突状态: r.cells[9]?.textContent.trim()
            });
          }
        }
        console.table(allParsed.slice(0, 15));
        log("提示: 可传入关键词测试精确匹配，如 hubuGrab.debug('9000111001')", "info");
      }
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", createUI);
  } else {
    createUI();
  }

  log("脚本初始化完成！已深度适配 DataTables 与 queryKxkcList()", "success");
})();
