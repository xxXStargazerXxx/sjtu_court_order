const DEBUG_URL = process.env.DEBUG_URL || "http://127.0.0.1:9222";
const { spawn } = require("node:child_process");
const LOGIN_URL =
  "https://sports.sjtu.edu.cn/pc/#/apointmentDetails/1/9096787a-bc53-430a-9405-57dc46bc9e83/%25E5%2585%25A8%25E9%2583%25A8/0";

const CONFIG = {
  intervalSeconds: Number(process.env.MONITOR_INTERVAL_SECONDS || 90),
  requestDelayMs: Number(process.env.MONITOR_REQUEST_DELAY_MS || 1500),
  autoClickLogin: process.env.MONITOR_AUTO_CLICK_LOGIN !== "0",
  popup: process.env.MONITOR_POPUP !== "0",
  testPopup: process.env.MONITOR_TEST_POPUP === "1",
  onlyAvailable: process.env.MONITOR_ONLY_AVAILABLE !== "0",
  // Empty means all day. Example: "13,14" means 20:00-22:00 only.
  timeRows: (process.env.MONITOR_TIME_ROWS || "")
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x !== "")
    .map((x) => Number(x))
    .filter((x) => Number.isFinite(x)),
  venues: [
    {
      name: "Huo Yingdong Badminton",
      id: "9096787a-bc53-430a-9405-57dc46bc9e83",
      typeName: "\u7fbd\u6bdb\u7403",
    },
    {
      name: "Huo Yingdong Main Hall",
      id: "9096787a-bc53-430a-9405-57dc46bc9e83",
      typeName: "\u7fbd\u6bdb\u7403\uff08\u4e3b\u9986\uff09",
    },
    {
      name: "Air Film Badminton",
      id: "3b10ff47-7e83-4c21-816c-5edc257168c1",
      typeName: "\u7fbd\u6bdb\u7403",
    },
  ],
};

const seenSlots = new Set();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function requestJson(path, init) {
  const res = await fetch(`${DEBUG_URL}${path}`, init);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
  return res.json();
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

function buildSchoolLoginUrl(url = LOGIN_URL) {
  let origin = "https://sports.sjtu.edu.cn";
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "sports.sjtu.edu.cn") origin = parsed.origin;
  } catch {}
  return `https://jaccount.sjtu.edu.cn/oauth2/authorize?response_type=code&client_id=mB5nKHqC00MusWAgnqSF&redirect_uri=${origin}/oauth2Login`;
}

async function getTab() {
  const tabs = await requestJson("/json/list");
  let tab = tabs.find((t) => (t.url || "").includes("/apointmentDetails/"));
  if (!tab) tab = tabs.find((t) => (t.url || "").includes("sports.sjtu.edu.cn/pc/"));
  if (!tab) tab = tabs.find((t) => isAuthUrl(t.url));
  if (!tab) tab = await requestJson(`/json/new?${encodeURIComponent(LOGIN_URL)}`, { method: "PUT" });
  return tab;
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
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Runtime exception");
  return result.result.value;
}

function buildScanExpression(config) {
  return `
(async () => {
  const config = ${JSON.stringify(config)};
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
  const todayStr = yyyy + "-" + mm + "-" + dd;

  const period = (row) => {
    const start = row + 7;
    const end = start + 1;
    return String(start).padStart(2, "0") + ":00-" + String(end).padStart(2, "0") + ":00";
  };

  const postJson = async (url, data) => {
    const res = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json;charset=utf-8" },
      body: JSON.stringify(data),
    });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("non-json response from " + url + "; login may be required; status=" + res.status);
    }
  };

  const postForm = async (url, data) => {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(data)) body.set(key, value);
    const res = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
      body,
    });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("non-json response from " + url + "; login may be required; status=" + res.status);
    }
  };

  const results = [];
  for (const venue of config.venues) {
    if (results.length > 0) await new Promise((resolve) => setTimeout(resolve, config.requestDelayMs));
    const venueResp = await postForm("/manage/venue/queryVenueById", { id: venue.id });
    const venueData = venueResp.data || {};
    const targetType = venue.typeName
      ? (venueData.motionTypes || []).find((x) => String(x.name || "") === String(venue.typeName))
      : (venueData.motionTypes || []).find((x) => String(x.name || "").includes("\u7fbd\u6bdb"));
    if (!targetType) {
      results.push({
        venue: venue.name,
        venueName: venueData.venueName,
        typeName: venue.typeName || "\u7fbd\u6bdb",
        ok: false,
        reason: "badminton type not found",
        motionTypes: venueData.motionTypes || [],
      });
      continue;
    }

    const daysResp = await postJson("/manage/fieldDetail/queryFieldReserveSituationIsFull", {
      id: venue.id,
      feildType: targetType.id,
      date: todayStr,
    });
    const days = daysResp.data || [];
    const venueResult = {
      venue: venue.name,
      venueName: venueData.venueName,
      typeName: targetType.name,
      ok: true,
      available: [],
      scannedDays: days.length,
      scannedDates: days.map((day) => day.date),
    };

    for (const day of days) {
      await new Promise((resolve) => setTimeout(resolve, config.requestDelayMs));
      const fieldResp = await postJson("/manage/fieldDetail/queryFieldSituation", {
        fieldType: targetType.id,
        date: day.date,
        venueId: venueData.venueId,
        dateId: day.dateId,
      });
      if (fieldResp.code !== 0 || !Array.isArray(fieldResp.data)) {
        venueResult.available.push({
          date: day.date,
          error: fieldResp.msg || "query failed",
        });
        continue;
      }

      for (const field of fieldResp.data) {
        const prices = field.priceList || [];
        const rows = config.timeRows.length ? config.timeRows : prices.map((_, index) => index);
        for (const row of rows) {
          const cell = prices[row];
          if (!cell) continue;
          const status = Number(cell.status);
          if (status === 0) {
            venueResult.available.push({
              date: day.date,
              time: period(row),
              fieldName: field.fieldName,
              fieldId: field.fieldId,
              price: cell.price,
              count: cell.count,
            });
          }
        }
      }
    }
    results.push(venueResult);
  }

  return {
    ok: true,
    checkedAt: new Date().toLocaleString(),
    timeRows: config.timeRows,
    results,
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

function printScan(scan) {
  const lines = [];
  lines.push(`[${scan.checkedAt}] badminton availability`);
  for (const venue of scan.results || []) {
    if (!venue.ok) {
      lines.push(`- ${venue.venue}${venue.typeName ? ` / ${venue.typeName}` : ""}: ${venue.reason}`);
      continue;
    }
    const available = venue.available || [];
    const realSlots = available.filter((x) => !x.error);
    const scannedDates = venue.scannedDates || [];

    lines.push("");
    lines.push(`== ${venue.venueName || venue.venue}${venue.typeName ? ` / ${venue.typeName}` : ""} ==`);
    lines.push(`Available: ${realSlots.length} slot(s); scanned days: ${venue.scannedDays || 0}`);
    if (scannedDates.length) {
      lines.push(`Scanned: ${scannedDates.map(formatDateWithWeekday).join(", ")}`);
    }

    const byDate = groupBy(realSlots, (slot) => slot.date);
    const sortedDates = [...byDate.keys()].sort();
    for (const date of sortedDates) {
      lines.push("");
      lines.push(`  ${formatDateWithWeekday(date)}`);
      const slots = byDate.get(date).sort((a, b) =>
        String(a.time).localeCompare(String(b.time)) ||
        String(a.fieldName).localeCompare(String(b.fieldName), "zh-Hans-CN")
      );
      for (const slot of slots) {
        lines.push(`    ${slot.time.padEnd(11)} ${slot.fieldName}  price=${slot.price ?? ""}`);
      }
    }

    const errors = available.filter((x) => x.error);
    if (errors.length) {
      lines.push("");
      lines.push("  Errors:");
      for (const error of errors) {
        lines.push(`    ${formatDateWithWeekday(error.date)}: ${error.error}`);
      }
    }
  }
  console.log(lines.join("\n"));

  const hasAvailable = (scan.results || []).some((x) => (x.available || []).some((slot) => !slot.error));
  if (hasAvailable) process.stdout.write("\x07");
}

function groupBy(items, getKey) {
  const map = new Map();
  for (const item of items) {
    const key = getKey(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

function formatDateWithWeekday(date) {
  if (!date) return "";
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const parsed = new Date(`${date}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return date;
  return `${date} (${weekdays[parsed.getDay()]})`;
}

function getRealSlots(scan) {
  const slots = [];
  for (const venue of scan.results || []) {
    for (const slot of venue.available || []) {
      if (slot.error) continue;
      slots.push({
        venueName: venue.venueName || venue.venue,
        typeName: venue.typeName || "",
        date: slot.date,
        time: slot.time,
        fieldName: slot.fieldName,
        fieldId: slot.fieldId,
        price: slot.price,
      });
    }
  }
  return slots;
}

function slotKey(slot) {
  return [slot.venueName, slot.typeName, slot.date, slot.time, slot.fieldId || slot.fieldName].join("|");
}

function showPopup(title, message) {
  const payload = Buffer.from(JSON.stringify({ title, message }), "utf8").toString("base64");
  const command = `
$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))
$data = $json | ConvertFrom-Json
try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  [System.Media.SystemSounds]::Exclamation.Play()

  $form = New-Object System.Windows.Forms.Form
  $form.Text = $data.title
  $form.Width = 620
  $form.Height = 360
  $form.StartPosition = "CenterScreen"
  $form.TopMost = $true
  $form.ShowInTaskbar = $true

  $text = New-Object System.Windows.Forms.TextBox
  $text.Multiline = $true
  $text.ReadOnly = $true
  $text.ScrollBars = "Vertical"
  $text.Dock = "Fill"
  $text.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 10)
  $text.Text = $data.message

  $button = New-Object System.Windows.Forms.Button
  $button.Text = "OK"
  $button.Dock = "Bottom"
  $button.Height = 40
  $button.Add_Click({ $form.Close() })

  $form.Controls.Add($text)
  $form.Controls.Add($button)
  $form.Add_Shown({
    $form.Activate()
    $form.TopMost = $true
    $form.BringToFront()
  })
  [void]$form.ShowDialog()
} catch {
  $shell = New-Object -ComObject WScript.Shell
  $shell.Popup($data.message, 0, $data.title, 0x40) | Out-Null
}
`;
  const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
    detached: true,
    windowsHide: false,
    stdio: "ignore",
  });
  child.unref();
}

function notifyNewSlots(scan) {
  const slots = getRealSlots(scan);
  const fresh = [];
  for (const slot of slots) {
    const key = slotKey(slot);
    if (!seenSlots.has(key)) fresh.push(slot);
    seenSlots.add(key);
  }

  if (!fresh.length || !CONFIG.popup) return;

  const lines = fresh.slice(0, 12).map((slot) =>
    `${slot.venueName}${slot.typeName ? ` / ${slot.typeName}` : ""} ${formatDateWithWeekday(slot.date)} ${slot.time} ${slot.fieldName} price=${slot.price ?? ""}`
  );
  if (fresh.length > 12) lines.push(`... ${fresh.length - 12} more`);
  showPopup("New badminton slot found", lines.join("\n"));
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

  console.log("Badminton monitor started. Complete SJTU login/captcha in Edge if prompted.");
  console.log("Config:", JSON.stringify(CONFIG));
  console.log("Press Ctrl+C to stop.");
  if (CONFIG.popup && CONFIG.testPopup) {
    showPopup("Badminton monitor test", "Popup test. If you can see this, foreground notification is working.");
  }

  let oauthReturnSeenAt = 0;
  while (true) {
    try {
      console.log(`[${new Date().toLocaleString()}] starting scan...`);
      const currentUrl = await evaluate(cdp, "location.href", 5000);
      if (isAuthUrl(currentUrl)) {
        console.log(`[${new Date().toLocaleString()}] waiting for SJTU login/captcha...`);
        const autoLoginClick = await evaluate(cdp, buildAutoLoginClickExpression(CONFIG), 5000);
        if (autoLoginClick.clicked) {
          console.log(`[${new Date().toLocaleString()}] auto-clicked login entry: ${JSON.stringify(autoLoginClick)}`);
        }
        await sleep(3000);
        continue;
      }
      if (!isSportsUrl(currentUrl)) {
        console.log(`[${new Date().toLocaleString()}] opening SJTU sports page...`);
        await cdp.send("Page.navigate", { url: LOGIN_URL });
        await sleep(3000);
        continue;
      }
      const token = await evaluate(cdp, 'sessionStorage.getItem("token") || ""', 5000);
      if (!token) {
        if (isSportsOauthReturn(currentUrl)) {
          if (!oauthReturnSeenAt) oauthReturnSeenAt = Date.now();
          const waitedMs = Date.now() - oauthReturnSeenAt;
          console.log(`[${new Date().toLocaleString()}] waiting for sports OAuth callback to set login token... waited=${waitedMs}ms`);
          if (waitedMs > 15000) {
            console.log(`[${new Date().toLocaleString()}] OAuth callback did not set token in time; opening sports page...`);
            await cdp.send("Page.navigate", { url: LOGIN_URL });
            await sleep(3000);
            continue;
          }
          await sleep(3000);
          continue;
        }
        oauthReturnSeenAt = 0;
        console.log(`[${new Date().toLocaleString()}] no platform login token; trying auto login and waiting...`);
        const autoLoginClick = await evaluate(cdp, buildAutoLoginClickExpression(CONFIG), 5000);
        if (autoLoginClick.clicked) {
          console.log(`[${new Date().toLocaleString()}] auto-clicked login entry: ${JSON.stringify(autoLoginClick)}`);
        } else if (autoLoginClick.reason !== "cooldown") {
          const loginUrl = buildSchoolLoginUrl(currentUrl);
          console.log(`[${new Date().toLocaleString()}] navigating directly to school login: ${loginUrl}`);
          await cdp.send("Page.navigate", { url: loginUrl });
        }
        await sleep(5000);
        continue;
      }
      oauthReturnSeenAt = 0;
      const scan = await evaluate(cdp, buildScanExpression(CONFIG), 90000);
      printScan(scan);
      notifyNewSlots(scan);
    } catch (err) {
      const message = String(err.message || err);
      if (message.includes("Execution context was destroyed")) {
        console.log(`[${new Date().toLocaleString()}] page is navigating; retrying shortly...`);
        await sleep(5000);
        continue;
      }
      if (message.includes("non-json response")) {
        console.log(`[${new Date().toLocaleString()}] platform returned a login/html page; please complete login in Edge.`);
        const autoLoginClick = await evaluate(cdp, buildAutoLoginClickExpression(CONFIG), 5000);
        if (autoLoginClick.clicked) {
          console.log(`[${new Date().toLocaleString()}] auto-clicked login entry: ${JSON.stringify(autoLoginClick)}`);
        }
        await cdp.send("Page.navigate", { url: LOGIN_URL });
        await sleep(5000);
        continue;
      }
      console.error(`[${new Date().toLocaleString()}] monitor error: ${message}`);
    }
    const waitSeconds = Math.max(15, CONFIG.intervalSeconds);
    console.log(`[${new Date().toLocaleString()}] next scan in ${waitSeconds}s. Press Ctrl+C to stop.`);
    await sleep(waitSeconds * 1000);
  }
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
