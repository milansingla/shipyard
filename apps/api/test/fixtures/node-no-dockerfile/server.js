const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");

const port = Number(process.env.PORT ?? 3000);

http
  .createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        built: fs.existsSync("built.txt") ? fs.readFileSync("built.txt", "utf8") : null,
        secretInImage: fs.existsSync("secret.txt"),
        user: os.userInfo().username,
        nodeEnv: process.env.NODE_ENV,
        greeting: process.env.GREETING ?? null, // a Shipyard runtime variable
      }),
    );
  })
  .listen(port, () => console.log(`listening on ${port}`));
