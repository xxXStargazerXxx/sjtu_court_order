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
  const cdp = new Cdp(tab.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send("Runtime.enable");
  const result = await cdp.send("Runtime.evaluate", {
    awaitPromise: true,
    returnByValue: true,
    timeout: 120000,
    expression: `(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const app = document.querySelector("#apointmentDetails")?.__vue__;
      if (!app) return { ok: false, reason: "没有找到组件" };
      window.__sjtuSubmitLogs = [];
      if (!window.__sjtuSubmitInterceptorInstalled) {
        app.$ajax.interceptors.response.use((res) => {
          if (String(res.config?.url || "").includes("/venue/personal/ConfirmOrder")) {
            window.__sjtuSubmitLogs.push({ type: "response", url: res.config.url, data: res.data });
          }
          return res;
        }, (err) => {
          window.__sjtuSubmitLogs.push({
            type: "error",
            url: err.config?.url,
            message: err.message,
            data: err.response?.data,
            status: err.response?.status
          });
          return Promise.reject(err);
        });
        window.__sjtuSubmitInterceptorInstalled = true;
      }
      app.ischecked = true;
      app.disabled = false;
      app.agreeTerms();
      for (let i = 0; i < 1200; i++) {
        const orderId = sessionStorage.getItem("newOrderDetailsId");
        if (orderId || window.__sjtuSubmitLogs.length || app.$refs?.verify?.clickShow) break;
        await sleep(50);
      }
      return {
        logs: window.__sjtuSubmitLogs,
        orderId: sessionStorage.getItem("newOrderDetailsId"),
        verifyVisible: app.$refs?.verify?.clickShow,
        disabled: app.disabled,
        url: location.href,
      };
    })()`,
  });
  console.log(JSON.stringify(result.result.value, null, 2));
  cdp.ws.close();
})().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
