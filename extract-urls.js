const fs = require("fs");
const s = fs.readFileSync("chunk6-apointmentDetails.js", "utf8");
const pats = [
  /url:"([^"]+)"/g,
  /\$ajax\.post\("([^"]+)"/g,
  /\$ajax\.get\("([^"]+)"/g,
];
const urls = new Set();
for (const re of pats) {
  for (const m of s.matchAll(re)) urls.add(m[1]);
}
console.log([...urls].sort().join("\n"));
