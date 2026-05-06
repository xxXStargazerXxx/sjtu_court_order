const DEFAULT_VENUE_ID = "9096787a-bc53-430a-9405-57dc46bc9e83";
const TARGET_VENUE_ID = process.env.TARGET_VENUE_ID || DEFAULT_VENUE_ID;
const DEBUG_URL = "http://127.0.0.1:9222";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function requestJson(path, init) {
  const res = await fetch(`${DEBUG_URL}${path}`, init);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
  return res.json();
}

async function getTab() {
  const tabs = await requestJson("/json/list");
  const tab =
    tabs.find((t) => (t.url || "").includes("/apointmentDetails/") && (t.url || "").includes(TARGET_VENUE_ID)) ||
    tabs.find((t) => (t.url || "").includes("sports.sjtu.edu.cn/pc/"));
  if (!tab) throw new Error("没有找到已打开的体育场馆预约页面。");
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

async function evaluate(cdp, expression, timeout = 120000) {
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

const submitExpression = `
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const app = document.querySelector("#apointmentDetails")?.__vue__;
  if (!app) return { ok: false, reason: "没有找到预约详情组件" };
  if (!app.buyLists || app.buyLists.length !== 2) {
    return { ok: false, reason: "当前页面不是两个时段的选中状态，请先运行准备脚本", selected: app.buyLists || [] };
  }
  const summary = {
    activeType: app.isactiveName,
    date: app.timeData?.isdate,
    selected: app.buyLists.map((x) => ({
      scheduleTime: x.scheduleTime,
      subSitename: x.subSitename,
      venuePrice: x.venuePrice,
    })),
    total: app.allSun,
  };
  app.btnClick();
  for (let i = 0; i < 200; i++) {
    if (app.dialogVisible) break;
    await sleep(10);
  }
  if (!app.dialogVisible) {
    return { ok: false, reason: "没有出现提交条款弹窗，可能页面提示了欠费或其他限制", summary };
  }
  app.ischecked = true;
  app.agreeTerms();
  for (let i = 0; i < 1600; i++) {
    const orderId = sessionStorage.getItem("newOrderDetailsId");
    const verifyVisible = app.$refs?.verify?.clickShow;
    if (orderId) return { ok: true, message: "已创建预约订单", orderId, url: location.href, summary };
    if (verifyVisible) return { ok: false, needsCaptcha: true, reason: "提交触发了滑块验证，需要你在页面手动完成验证", summary };
    if (location.href.includes("orderDetails")) return { ok: true, message: "已跳转到订单详情", url: location.href, summary };
    await sleep(50);
  }
  return { ok: false, reason: "提交后未检测到成功跳转或验证码，请查看页面提示", url: location.href, summary };
})()
`;

async function main() {
  const tab = await getTab();
  const cdp = new Cdp(tab.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send("Runtime.enable");
  const result = await evaluate(cdp, submitExpression);
  console.log(JSON.stringify(result, null, 2));
  cdp.ws.close();
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
