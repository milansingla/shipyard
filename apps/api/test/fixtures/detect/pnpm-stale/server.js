const http = require("node:http");
const ms = require("ms");

http
  .createServer((_req, res) => res.end(`hello from pnpm (${ms(60000)})`))
  .listen(Number(process.env.PORT ?? 3000), () => console.log("listening"));
