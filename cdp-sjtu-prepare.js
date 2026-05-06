const DEFAULT_VENUE_ID = "9096787a-bc53-430a-9405-57dc46bc9e83";
const TARGET_VENUE_ID = process.env.TARGET_VENUE_ID || DEFAULT_VENUE_ID;
const TARGET_URL =
  process.env.TARGET_URL ||
  `https://sports.sjtu.edu.cn/pc/#/apointmentDetails/1/${TARGET_VENUE_ID}/%25E5%2585%25A8%25E9%2583%25A8/0`;
const DEBUG_URL = process.env.DEBUG_URL || "http://127.0.0.1:9222";

const CONFIG = {
  // Defaults for the daily badminton flow:
  // Huo Yingdong Sports Center -> badminton -> last available day -> 20:00-22:00.
  targetDate: process.env.TARGET_DATE || "",
  targetDateMode: process.env.TARGET_DATE_MODE || (process.env.TARGET_DATE ? "exact" : "last"),
  targetType:
    process.env.TARGET_TYPE ||
    (process.env.TARGET_TYPE_CODE === "gym"
      ? "\u5065\u8eab"
      : process.env.TARGET_TYPE_CODE === "badminton"
        ? "\u7fbd\u6bdb"
        : "\u7fbd\u6bdb"),
  targetField: process.env.TARGET_FIELD || "",
  timeRows: (process.env.TIME_ROWS || "13,14")
    .split(",")
    .map((x) => Number(x.trim()))
    .filter((x) => Number.isFinite(x)),
  forceRefresh: process.env.FORCE_REFRESH !== "0",
  reloadPageBeforePrepare: process.env.RELOAD_PAGE_BEFORE_PREPARE === "1",
  pageReloadWaitMs: Number(process.env.PAGE_RELOAD_WAIT_MS || 3500),
  autoClickLogin: process.env.AUTO_CLICK_LOGIN !== "0",
  retrySeconds: Number(process.env.RETRY_SECONDS || 0),
  retryIntervalMs: Number(process.env.RETRY_INTERVAL_MS || 1200),
  postRefreshWaitMs: Number(process.env.POST_REFRESH_WAIT_MS || 900),
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function requestJson(path, init) {
  const res = await fetch(`${DEBUG_URL}${path}`, init);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
  return res.json();
}

async function getTab() {
  const tabs = await requestJson("/json/list");
  let tab = tabs.find(
    (t) => (t.url || "").includes("/apointmentDetails/") && (t.url || "").includes(TARGET_VENUE_ID)
  );
  if (!tab) tab = tabs.find((t) => (t.url || "").includes("sports.sjtu.edu.cn/pc/"));
  if (!tab) tab = tabs.find((t) => isAuthUrl(t.url));
  if (!tab) {
    tab = await requestJson(`/json/new?${encodeURIComponent(TARGET_URL)}`, { method: "PUT" });
  }
  return tab;
}

function isAuthUrl(url) {
  const value = String(url || "").toLowerCase();
  if (value.includes("sports.sjtu.edu.cn")) return false;
  return value.includes("jaccount.sjtu.edu.cn") || value.includes("captcha");
}

function isSportsOauthReturn(url) {
  const value = String(url || "").toLowerCase();
  return value.includes("sports.sjtu.edu.cn") && value.includes("oauth2login");
}

function isSportsUrl(url) {
  return String(url || "").toLowerCase().includes("sports.sjtu.edu.cn");
}

function buildSchoolLoginUrl(url = TARGET_URL) {
  let origin = "https://sports.sjtu.edu.cn";
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "sports.sjtu.edu.cn") origin = parsed.origin;
  } catch {}
  return `https://jaccount.sjtu.edu.cn/oauth2/authorize?response_type=code&client_id=mB5nKHqC00MusWAgnqSF&redirect_uri=${origin}/oauth2Login`;
}

class Cdp {
  constructor(wsUrl) {
    this.nextId = 1;
    this.pending = new Map();
    this.ws = new WebSocket(wsUrl);
    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (!msg.id) return;
      const waiter = this.pending.get(msg.id);
      if (!waiter) return;
      this.pending.delete(msg.id);
      msg.error ? waiter.reject(new Error(JSON.stringify(msg.error))) : waiter.resolve(msg.result);
    };
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}

async function evaluate(cdp, expression, timeout = 30000) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Runtime exception");
  }
  return result.result.value;
}

function buildDateReadinessExpression(config) {
  return `
(async () => {
  const config = ${JSON.stringify(config)};
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function vm() {
    return document.querySelector("#apointmentDetails")?.__vue__;
  }

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function formatDate(date) {
    return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
  }

  function addDays(date, days) {
    const next = new Date(date);
    next.setDate(next.getDate() + days);
    return next;
  }

  for (let i = 0; i < 60; i++) {
    const app = vm();
    if (app && app.tabList?.length && app.weekList?.length) break;
    await sleep(500);
  }

  const app = vm();
  if (!app) {
    return { ready: false, shouldReload: true, reason: "appointment component not found", url: location.href };
  }

  const tab = (app.tabList || []).find((x) => String(x.name || "").includes(config.targetType));
  if (!tab) {
    return {
      ready: false,
      shouldReload: true,
      reason: "target activity type not found",
      targetType: config.targetType,
      tabList: app.tabList || [],
    };
  }

  if (String(app.isactiveId) !== String(tab.id)) {
    app.activeName = tab.id;
    app.handleClick({ name: tab.id, label: tab.name });
    await sleep(1800);
  }

  const dates = (app.weekList || []).map((x) => x?.isdate).filter(Boolean);
  let expectedDate = config.targetDate || "";
  let expectedDays = null;
  if (config.targetDateMode === "last") {
    const now = new Date();
    const onAndOff = String(app.onAndOff ?? sessionStorage.getItem("onAndOff") ?? "");
    expectedDays = onAndOff === "0"
      ? (now.getHours() >= 12 ? 8 : 7)
      : (now.getHours() >= 12 ? 4 : 3);
    expectedDate = formatDate(addDays(now, expectedDays - 1));
  }

  const hasExpectedDate = expectedDate ? dates.includes(expectedDate) : dates.length > 0;
  return {
    ready: true,
    shouldReload: !hasExpectedDate,
    reason: hasExpectedDate ? "date list already contains target date" : "target date missing from current date list",
    expectedDate,
    expectedDays,
    firstDate: dates[0] || "",
    lastDate: dates[dates.length - 1] || "",
    dateCount: dates.length,
    dates,
  };
})()
`;
}

function buildLoginStateExpression() {
  return `
(() => {
  const token = sessionStorage.getItem("token");
  const app = document.querySelector("#apointmentDetails")?.__vue__;
  const loginText = [...document.querySelectorAll(".el-dialog, .el-message, .el-message__content")]
    .map((x) => x.innerText || "")
    .filter(Boolean)
    .join("\\n");
  return {
    url: location.href,
    tokenPresent: !!token,
    tokenLength: token ? token.length : 0,
    hasAppointmentApp: !!app,
    hasLoginPrompt: /登录|统一身份认证|jAccount|账号|密码/.test(loginText),
  };
})()
`;
}

function buildAutoLoginClickExpression(config) {
  return `
(() => {
  const config = ${JSON.stringify(config)};
  if (!config.autoClickLogin) {
    return { clicked: false, reason: "auto login click disabled" };
  }

  const now = Date.now();
  if (window.__sjtuLastAutoLoginClickAt && now - window.__sjtuLastAutoLoginClickAt < 3000) {
    return { clicked: false, reason: "cooldown" };
  }

  function findVueMethod(methodName) {
    const root = document.querySelector("#app")?.__vue__;
    const seen = new Set();
    const stack = root ? [root] : [];
    while (stack.length) {
      const component = stack.shift();
      if (!component || seen.has(component)) continue;
      seen.add(component);
      if (typeof component[methodName] === "function") return component;
      if (Array.isArray(component.$children)) stack.push(...component.$children);
    }
    return null;
  }

  if (location.hostname === "sports.sjtu.edu.cn" && !sessionStorage.getItem("token")) {
    const target = "https://jaccount.sjtu.edu.cn/oauth2/authorize?response_type=code&client_id=mB5nKHqC00MusWAgnqSF&redirect_uri=" + location.origin + "/oauth2Login";
    window.__sjtuLastAutoLoginClickAt = now;
    location.href = target;
    return {
      clicked: true,
      via: "direct.oauth",
      target,
      url: location.href,
    };
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  }

  function textOf(element) {
    return (element.innerText || element.textContent || "").replace(/\\s+/g, "");
  }

  const patterns = [
    /校内人员登录/,
    /校内人员/,
    /校内登录/,
    /统一身份认证登录/,
    /统一身份认证/,
    /jAccount登录/i,
    /JAccount登录/i,
    /jAccount/i,
  ];

  const elements = [...document.querySelectorAll("button,a,[role='button'],.el-button,div,span,li")];
  for (const element of elements) {
    if (!isVisible(element)) continue;
    const text = textOf(element);
    if (!text || !patterns.some((pattern) => pattern.test(text))) continue;

    const clickable =
      element.closest("button,a,[role='button'],.el-button") ||
      element.closest("[onclick]") ||
      element;

    window.__sjtuLastAutoLoginClickAt = now;
    clickable.click();
    return {
      clicked: true,
      text,
      tagName: clickable.tagName,
      className: clickable.className || "",
      url: location.href,
    };
  }

  return { clicked: false, reason: "login entry not found", url: location.href };
})()
`;
}

function buildPrepareExpression(config) {
  return `
(async () => {
  const config = ${JSON.stringify(config)};
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const unavailable = new Set([-1, -2, -3]);

  function vm() {
    return document.querySelector("#apointmentDetails")?.__vue__;
  }

  for (let i = 0; i < 600; i++) {
    const app = vm();
    if (app && app.tabList?.length && app.weekList?.length) break;
    await sleep(1000);
  }

  const app = vm();
  if (!app) {
    return { ok: false, reason: "appointment component not found", url: location.href };
  }

  const tab = (app.tabList || []).find((x) => String(x.name || "").includes(config.targetType));
  if (!tab) {
    return { ok: false, reason: "target activity type not found", targetType: config.targetType, tabList: app.tabList };
  }

  if (String(app.isactiveId) !== String(tab.id)) {
    app.activeName = tab.id;
    app.handleClick({ name: tab.id, label: tab.name });
    await sleep(1800);
  }

  let day;
  if (config.targetDateMode === "last") {
    day = (app.weekList || [])[app.weekList.length - 1];
  } else {
    day = (app.weekList || []).find((x) => x.isdate === config.targetDate);
  }

  if (!day) {
    return {
      ok: false,
      reason: "target date not available",
      targetDate: config.targetDate,
      targetDateMode: config.targetDateMode,
      weekList: app.weekList,
    };
  }

  if (app.timeData?.isdate !== day.isdate) {
    app.weekName = day.isdate;
    app.weekClick({ name: day.isdate });
    await sleep(1800);
  }

  const resetSelection = () => {
    for (let col = 0; col < (app.seatArray || []).length; col++) {
      for (let row = 0; row < (app.seatArray[col] || []).length; row++) {
        if (Number(app.seatArray[col][row]?.status) === 1) {
          app.seatArray[col][row].status = 0;
        }
      }
    }
    app.buyLists = [];
    app.allSun = 0;
  };

  const waitForSeats = async () => {
    for (let i = 0; i < 30; i++) {
      if (app.topSite?.length && app.seatArray?.length) return true;
      await sleep(300);
    }
    return false;
  };

  const refreshSeats = async () => {
    resetSelection();
    app.seatArray = [];
    app.getFied();
    await sleep(config.postRefreshWaitMs);
    await waitForSeats();
  };

  const attemptSelect = async (attemptNo) => {
    if (config.forceRefresh || attemptNo > 0) {
      await refreshSeats();
    } else {
      await waitForSeats();
    }

    const rowInfo = (col) => config.timeRows.map((row) => ({
      row,
      time: app.period(row),
      status: app.seatArray?.[col]?.[row]?.status,
      raw: app.seatArray?.[col]?.[row],
    }));

    const hasClickableRows = (col) => config.timeRows.every((row) => {
      const status = Number(app.seatArray?.[col]?.[row]?.status);
      return status === 0 || status === 1;
    });

    const selectedMatches = (col) => {
      const field = app.topSite?.[col];
      if (!field) return false;
      const wantedTimes = new Set(config.timeRows.map((row) => app.period(row)));
      const selected = app.buyLists || [];
      return (
        selected.length === config.timeRows.length &&
        selected.every((x) => x.subSiteId === field.fieldId && wantedTimes.has(x.scheduleTime))
      );
    };

    const candidates = [];
    if (config.targetField) {
      const preferred = (app.topSite || []).findIndex((x) =>
        String(x.name || "").includes(config.targetField)
      );
      if (preferred >= 0) candidates.push(preferred);
    }
    for (let col = 0; col < (app.topSite || []).length; col++) {
      if (!candidates.includes(col)) candidates.push(col);
    }

    const attempts = [];
    let index = -1;
    for (const col of candidates) {
      const field = app.topSite?.[col];
      const cells = rowInfo(col);
      if (!field || !hasClickableRows(col)) {
        attempts.push({ field, cells, selected: [], skipped: true });
        continue;
      }

      resetSelection();
      for (const row of config.timeRows) {
        app.handleChooseSeat(col, row);
      }
      await sleep(0);

      attempts.push({
        field,
        cells,
        selected: app.buyLists || [],
        selectedCount: (app.buyLists || []).length,
      });

      if (selectedMatches(col)) {
        index = col;
        break;
      }
    }

    const field = app.topSite?.[index];
    if (!field) {
      resetSelection();
      return {
        ok: false,
        reason: "no field could actually select all target rows",
        activeType: app.isactiveName,
        date: app.timeData?.isdate,
        attemptNo,
        attempts,
      };
    }

    return {
      ok: true,
      message: "target slots selected; order not submitted",
      activeType: app.isactiveName,
      date: app.timeData?.isdate,
      field,
      selected: app.buyLists,
      total: app.allSun,
      attemptNo,
    };
  };

  const retryDeadline = Date.now() + Math.max(0, config.retrySeconds) * 1000;
  let attemptNo = 0;
  let lastResult;
  do {
    lastResult = await attemptSelect(attemptNo);
    if (lastResult.ok) return lastResult;
    attemptNo += 1;
    if (Date.now() >= retryDeadline) break;
    const jitter = Math.floor(Math.random() * 250);
    await sleep(config.retryIntervalMs + jitter);
  } while (true);

  return lastResult;
})()
`;
}

async function main() {
  try {
    await requestJson("/json/version");
  } catch {
    console.error("Cannot connect to Edge debug port 9222. Run launch-edge-sjtu.ps1 first.");
    process.exit(1);
  }

  const tab = await getTab();
  const cdp = new Cdp(tab.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");

  console.log("Waiting for login if needed. Complete SJTU login/captcha manually in Edge.");
  console.log("Config:", JSON.stringify(CONFIG));

  const deadline = Date.now() + 10 * 60 * 1000;
  let reloadedBeforePrepare = false;
  let oauthReturnSeenAt = 0;
  let result;
  while (Date.now() < deadline) {
    try {
      const currentUrl = await evaluate(cdp, "location.href", 5000);
      if (isAuthUrl(currentUrl)) {
        const autoLoginClick = await evaluate(cdp, buildAutoLoginClickExpression(CONFIG), 5000);
        if (autoLoginClick.clicked) {
          console.log("Auto-clicked login entry:", JSON.stringify(autoLoginClick));
        }
        await sleep(1500);
        continue;
      }

      if (
        isSportsUrl(currentUrl) &&
        !isSportsOauthReturn(currentUrl) &&
        (!currentUrl.includes("/apointmentDetails/") || !currentUrl.includes(TARGET_VENUE_ID))
      ) {
        console.log("On sports site but not target appointment page; navigating to target:", currentUrl);
        await cdp.send("Page.navigate", { url: TARGET_URL });
        await sleep(1000);
        continue;
      }

      if (isSportsUrl(currentUrl)) {
        const loginState = await evaluate(cdp, buildLoginStateExpression(), 5000);
        if (!loginState.tokenPresent && !loginState.hasAppointmentApp) {
          if (isSportsOauthReturn(currentUrl)) {
            if (!oauthReturnSeenAt) oauthReturnSeenAt = Date.now();
            const waitedMs = Date.now() - oauthReturnSeenAt;
            console.log("Waiting for sports OAuth callback to set login token:", JSON.stringify({ ...loginState, waitedMs }));
            if (waitedMs > 15000) {
              console.log("OAuth callback did not set token in time; navigating back to target page.");
              await cdp.send("Page.navigate", { url: TARGET_URL });
              await sleep(1500);
              continue;
            }
            await sleep(1500);
            continue;
          }
          oauthReturnSeenAt = 0;
          console.log("Waiting for sports site login token:", JSON.stringify(loginState));
          const autoLoginClick = await evaluate(cdp, buildAutoLoginClickExpression(CONFIG), 5000);
          if (autoLoginClick.clicked) {
            console.log("Auto-clicked login entry:", JSON.stringify(autoLoginClick));
          } else if (autoLoginClick.reason !== "cooldown") {
            const loginUrl = buildSchoolLoginUrl(currentUrl);
            console.log("Navigating directly to school login:", loginUrl);
            await cdp.send("Page.navigate", { url: loginUrl });
          }
          await sleep(1500);
          continue;
        }
        oauthReturnSeenAt = 0;
      }

      if (CONFIG.reloadPageBeforePrepare && !reloadedBeforePrepare) {
        reloadedBeforePrepare = true;
        const dateReadiness = await evaluate(cdp, buildDateReadinessExpression(CONFIG), 45000);
        console.log("Date list check:", JSON.stringify(dateReadiness));
        if (dateReadiness.shouldReload) {
          console.log("Reloading appointment page before preparing because the target date is missing.");
          await cdp.send("Page.reload", { ignoreCache: true });
          await sleep(CONFIG.pageReloadWaitMs);
        } else {
          console.log("Skipping page reload because the target date is already present.");
        }
        continue;
      }
      result = await evaluate(cdp, buildPrepareExpression(CONFIG), Math.min(650000, deadline - Date.now()));
      break;
    } catch (err) {
      const msg = String(err.message || err);
      if (!msg.includes("Execution context was destroyed")) throw err;
      await sleep(1500);
    }
  }

  if (!result) throw new Error("Timed out while waiting for login/page load.");
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 2;
  cdp.ws.close();
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
