const http = require("node:http");

// The app itself: 200 on every path.
http.createServer((_req, res) => res.end("app\n")).listen(Number(process.env.PORT ?? 3000), "0.0.0.0");

// Admin port: only /healthz succeeds.
http
  .createServer((req, res) => {
    res.statusCode = req.url === "/healthz" ? 204 : 404;
    res.end();
  })
  .listen(9000, "0.0.0.0");

process.on("SIGTERM", () => process.exit(0));
