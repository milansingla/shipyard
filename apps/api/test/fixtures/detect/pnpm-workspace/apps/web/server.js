const http = require("node:http");
const fs = require("node:fs");
const { greeting } = require("@fixture/ui");

const built = fs.readFileSync("built.txt", "utf8");
http
  .createServer((_req, res) => res.end(`${greeting("web")} (${built}, node ${process.versions.node.split(".")[0]})`))
  .listen(Number(process.env.PORT ?? 3000), () => console.log("listening"));
