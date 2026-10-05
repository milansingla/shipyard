const http = require("node:http");
const os = require("node:os");

const server = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.statusCode = 204;
    return res.end();
  }
  res.end(os.hostname());
});
server.listen(Number(process.env.PORT ?? 3000), "0.0.0.0");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
