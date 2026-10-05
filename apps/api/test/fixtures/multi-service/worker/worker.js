// Worker: no port, just keeps running.
setInterval(() => console.log("tick"), 1000);
process.on("SIGTERM", () => process.exit(0));
