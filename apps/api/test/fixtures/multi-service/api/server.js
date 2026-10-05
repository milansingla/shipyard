// Private service: only reachable inside the project network, as http://api:4000.
require("node:http")
  .createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ from: "api" }));
  })
  .listen(Number(process.env.PORT), "0.0.0.0");
