const DeploymentService =
    require("./src/deployment/DeploymentService");

const deploymentService =
    new DeploymentService();

async function main() {
    const args = process.argv.slice(2);

    const command = args[0];

    try {
        // ==============================
        // DEPLOY
        // ==============================

        if (command === "deploy") {
            const repoUrl = args[1];

            if (!repoUrl) {
                throw new Error(
                    "Usage: node index.js deploy <repo-url>"
                );
            }

            const deployment =
                await deploymentService.deploy(
                    repoUrl
                );

            console.log("\nDeployment result:");
            console.log(
                JSON.stringify(
                    deployment,
                    null,
                    2
                )
            );

            return;
        }

        // ==============================
        // LOGS
        // ==============================

        if (command === "logs") {
            const containerName = args[1];

            if (!containerName) {
                throw new Error(
                    "Usage: node index.js logs <container-name>"
                );
            }

            const logs =
                await deploymentService.getLogs(
                    containerName
                );

            console.log(logs);

            return;
        }

        // ==============================
        // STOP
        // ==============================

        if (command === "stop") {
            const containerName = args[1];

            if (!containerName) {
                throw new Error(
                    "Usage: node index.js stop <container-name>"
                );
            }

            const result =
                await deploymentService.stop(
                    containerName
                );

            console.log(result);

            return;
        }

        // ==============================
        // RESTART
        // ==============================

        if (command === "restart") {
            const containerName = args[1];

            if (!containerName) {
                throw new Error(
                    "Usage: node index.js restart <container-name>"
                );
            }

            const result =
                await deploymentService.restart(
                    containerName
                );

            console.log(result);

            return;
        }

        // ==============================
        // HELP
        // ==============================

        console.log(`
Shipyard V0.1

Commands:

Deploy:
  node index.js deploy <repo-url>

Logs:
  node index.js logs <container-name>

Stop:
  node index.js stop <container-name>

Restart:
  node index.js restart <container-name>
        `);

    } catch (error) {
        console.error("\nShipyard error:");
        console.error(error.message);

        process.exitCode = 1;
    }
}

main();