// Minimal app for testing Shipyard deployments. No dependencies, so it builds fast.
const http = require("node:http");

// Shipyard passes the port it expects via $PORT. Listen on 0.0.0.0, not localhost:
// inside a container, "localhost" is unreachable from the outside.
const PORT = Number(process.env.PORT) || 3000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end("Hello from Shipyard 🚢\n");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
