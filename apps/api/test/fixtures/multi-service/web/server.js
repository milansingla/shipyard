// Public service: calls the private api service by its name on the project network.
require("node:http")
  .createServer(async (_req, res) => {
    res.setHeader("content-type", "application/json");
    try {
      const api = await (await fetch("http://api:4000/")).json();
      res.end(JSON.stringify({ from: "web", api }));
    } catch (error) {
      res.statusCode = 502;
      res.end(JSON.stringify({ from: "web", error: String(error) }));
    }
  })
  .listen(Number(process.env.PORT), "0.0.0.0");
