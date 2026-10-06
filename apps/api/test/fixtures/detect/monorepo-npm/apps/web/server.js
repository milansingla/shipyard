const http = require("node:http");
const { greet } = require("greet");

// A workspace app that depends on another workspace package (packages/greet).
http
  .createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`${greet("monorepo")}\n`);
  })
  .listen(Number(process.env.PORT) || 3000);
