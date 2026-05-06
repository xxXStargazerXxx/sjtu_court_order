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
    expression: `(() => {
      const app = document.querySelector("#apointmentDetails")?.__vue__;
      return {
        url: location.href,
        title: document.title,
        messages: [...document.querySelectorAll(".el-message, .el-message__content, .el-notification, .el-dialog")]
          .map((x) => x.innerText).filter(Boolean),
        app: app ? {
          dialogVisible: app.dialogVisible,
          disabled: app.disabled,
          arrearsTipsShow: app.arrearsTipsShow,
          verifyVisible: app.$refs?.verify?.clickShow,
          orderId: sessionStorage.getItem("newOrderDetailsId"),
          selected: app.buyLists,
          total: app.allSun,
        } : null
      };
    })()`,
  });
  console.log(JSON.stringify(result.result.value, null, 2));
  cdp.ws.close();
})().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
