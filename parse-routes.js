const fs = require("fs");
const s = fs.readFileSync("app.js", "utf8");
const re = /path:"([^"]+)",name:"([^"]+)",component:function\(e\)\{return(?: Promise\.all\(\[([^\]]+)\]\)|i\.e\((\d+)\))\.then\(function\(\)\{var t=\[i\("([^"]+)"\)\]/g;
const out = [];
for (const m of s.matchAll(re)) {
  out.push({ path: m[1], name: m[2], chunks: m[3] || m[4], module: m[5] });
}
console.log(JSON.stringify(out, null, 2));
