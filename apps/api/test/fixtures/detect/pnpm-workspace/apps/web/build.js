// Proves the build ran inside the image, after the workspace install.
require("node:fs").writeFileSync("built.txt", `built with ${process.env.npm_config_user_agent?.split(" ")[0] ?? "unknown"}`);
