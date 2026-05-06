const fs = require("fs");
const s = fs.readFileSync("chunk6-apointmentDetails.js", "utf8");
for (const needle of process.argv.slice(2)) {
  const idx = s.indexOf(needle);
  console.log(`\n===== ${needle} @ ${idx} =====`);
  console.log(s.slice(Math.max(0, idx - 2200), Math.min(s.length, idx + 2400)));
}
