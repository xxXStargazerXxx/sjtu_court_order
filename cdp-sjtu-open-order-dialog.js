const DEFAULT_VENUE_ID = "9096787a-bc53-430a-9405-57dc46bc9e83";
const TARGET_VENUE_ID = process.env.TARGET_VENUE_ID || DEFAULT_VENUE_ID;
const DEBUG_URL = "http://127.0.0.1:9222";

async function requestJson(path) {
  const res = await fetch(`${DEBUG_URL}${path}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
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

(async () => {
  const tabs = await requestJson("/json/list");
  const tab =
    tabs.find((t) => (t.url || "").includes("/apointmentDetails/") && (t.url || "").includes(TARGET_VENUE_ID)) ||
    tabs.find((t) => (t.url || "").includes("sports.sjtu.edu.cn/pc/"));
  if (!tab) throw new Error("没有找到体育场馆页面。");
  const cdp = new Cdp(tab.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send("Runtime.enable");
  const result = await cdp.send("Runtime.evaluate", {
    awaitPromise: true,
    returnByValue: true,
    timeout: 30000,
    expression: `(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const app = document.querySelector("#apointmentDetails")?.__vue__;
      if (!app) return { ok: false, reason: "没有找到预约详情组件" };
      if (!app.buyLists || app.buyLists.length < 1) return { ok: false, reason: "还没有选中时段" };
      app.btnClick();
      for (let i = 0; i < 200; i++) {
        if (app.dialogVisible) break;
        await sleep(10);
      }
      return {
        ok: !!app.dialogVisible,
        dialogVisible: app.dialogVisible,
        selected: app.buyLists.map((x) => ({ scheduleTime: x.scheduleTime, subSitename: x.subSitename, venuePrice: x.venuePrice })),
        total: app.allSun,
      };
    })()`,
  });
  console.log(JSON.stringify(result.result.value, null, 2));
  cdp.ws.close();
})().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
