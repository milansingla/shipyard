const fs = require("node:fs");
const http = require("node:http");

// Fails to start if /data isn't writable by this (non-root) user.
const file = "/data/boots.txt";
fs.appendFileSync(file, "boot\n");
const boots = fs.readFileSync(file, "utf8").trim().split("\n").length;

http
  .createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ boots, uid: process.getuid() }));
  })
  .listen(Number(process.env.PORT ?? 3000), "0.0.0.0");

process.on("SIGTERM", () => process.exit(0));
