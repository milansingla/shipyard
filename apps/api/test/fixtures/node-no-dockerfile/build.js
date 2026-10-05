// Runs during `npm run build` inside the image: proves the build step executed.
// BUILD_LABEL is a Shipyard build variable: it must be visible here, at build time.
const label = process.env.BUILD_LABEL ? ` (${process.env.BUILD_LABEL})` : "";
require("node:fs").writeFileSync("built.txt", `built during docker build${label}`);
