const fs = require("fs");
const path = require("path");

const DockerService = require("../docker/DockerService");
const GitService = require("../git/GitService");

class DeploymentService {
    constructor() {
        this.dockerService = new DockerService();
        this.gitService = new GitService();
    }

    async deploy(repoUrl) {
        const deploymentId = Date.now();

        const imageName =
            `shipyard-app-${deploymentId}`;

        const containerName =
            `shipyard-app-${deploymentId}`;

        console.log("\n================================");
        console.log("SHIPYARD DEPLOYMENT");
        console.log("================================");

        console.log(
            "Deployment ID:",
            deploymentId
        );

        // --------------------------------
        // 1. Clone repository
        // --------------------------------

        const repoPath =
            await this.gitService.cloneRepository(
                repoUrl
            );

        // --------------------------------
        // 2. Detect Dockerfile
        // --------------------------------

        const dockerfilePath =
            path.join(
                repoPath,
                "Dockerfile"
            );

        const dockerfileExists =
            await this.fileExists(
                dockerfilePath
            );

        if (!dockerfileExists) {
            throw new Error(
                "Dockerfile not found in repository."
            );
        }

        console.log(
            "Dockerfile detected!"
        );

        // --------------------------------
        // 3. Detect application port
        // --------------------------------

        const containerPort =
            await this.detectPort(
                dockerfilePath
            );

        console.log(
            "Application port:",
            containerPort
        );

        // --------------------------------
        // 4. Build Docker image
        // --------------------------------

        await this.dockerService.buildImage(
            repoPath,
            imageName
        );

        console.log(
            "Docker image built!"
        );

        // --------------------------------
        // 5. Create container
        // --------------------------------

        console.log(
            "Creating container..."
        );

        const container =
            await this.dockerService.createContainer(
                imageName,
                containerName,
                containerPort
            );

        console.log(
            "Container created:",
            container.id
        );

        // --------------------------------
        // 6. Start container
        // --------------------------------

        console.log(
            "Starting container..."
        );

        await this.dockerService.startContainer(
            container
        );

        console.log(
            "Container started!"
        );

        // --------------------------------
        // 7. Get host port
        // --------------------------------

        const hostPort =
            await this.dockerService.getContainerPort(
                container,
                containerPort
            );

        // --------------------------------
        // 8. Check status
        // --------------------------------

        const isRunning =
            await this.dockerService.getContainerStatus(
                container
            );

        const deployment = {
            deploymentId,
            repoUrl,
            imageName,
            containerId: container.id,
            containerName,
            containerPort,
            hostPort,
            url:
                `http://localhost:${hostPort}`,
            status:
                isRunning
                    ? "RUNNING"
                    : "STOPPED"
        };

        console.log("\n================================");
        console.log("DEPLOYMENT SUCCESSFUL");
        console.log("================================");

        console.log(
            "URL:",
            deployment.url
        );

        console.log(
            "Status:",
            deployment.status
        );

        return deployment;
    }

    async getLogs(containerName) {
        const container =
            await this.dockerService.getContainer(
                containerName
            );

        return this.dockerService.getLogs(
            container
        );
    }

    async stop(containerName) {
        const container =
            await this.dockerService.getContainer(
                containerName
            );

        await this.dockerService.stopContainer(
            container
        );

        return {
            containerName,
            status: "STOPPED"
        };
    }

    async restart(containerName) {
        const container =
            await this.dockerService.getContainer(
                containerName
            );

        await this.dockerService.restartContainer(
            container
        );

        const isRunning =
            await this.dockerService.getContainerStatus(
                container
            );

        return {
            containerName,
            status:
                isRunning
                    ? "RUNNING"
                    : "STOPPED"
        };
    }

    async fileExists(filePath) {
        try {
            await fs.promises.access(
                filePath,
                fs.constants.F_OK
            );

            return true;
        } catch {
            return false;
        }
    }

    async detectPort(dockerfilePath) {
        const dockerfile =
            await fs.promises.readFile(
                dockerfilePath,
                "utf8"
            );

        const match =
            dockerfile.match(
                /^\s*EXPOSE\s+(\d+)/im
            );

        if (match) {
            return Number(match[1]);
        }

        // Default for our V0.1 Node deployment.
        return 3000;
    }
}

module.exports = DeploymentService;