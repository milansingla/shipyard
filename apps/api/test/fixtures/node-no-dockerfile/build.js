// Runs during `npm run build` inside the image: proves the build step executed.
require("node:fs").writeFileSync("built.txt", "built during docker build");
