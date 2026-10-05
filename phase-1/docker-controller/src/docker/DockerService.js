const Docker = require("dockerode");
const tar = require("tar-fs");

class DockerService {
    constructor() {
        this.docker = new Docker();
    }

    async buildImage(buildContextPath, imageName) {
        const buildContext = tar.pack(buildContextPath);

        console.log("Building Docker image...");
        console.log("Image:", imageName);

        const stream = await this.docker.buildImage(
            buildContext,
            {
                t: imageName
            }
        );

        return new Promise((resolve, reject) => {
            this.docker.modem.followProgress(
                stream,

                (error, result) => {
                    if (error) {
                        reject(error);
                        return;
                    }

                    resolve(result);
                },

                (event) => {
                    if (event.stream) {
                        process.stdout.write(event.stream);
                    }

                    if (event.error) {
                        process.stderr.write(
                            event.error + "\n"
                        );
                    }
                }
            );
        });
    }

    async createContainer(
        imageName,
        containerName,
        containerPort
    ) {
        const container =
            await this.docker.createContainer({
                Image: imageName,

                name: containerName,

                ExposedPorts: {
                    [`${containerPort}/tcp`]: {}
                },

                Env: [
                    `PORT=${containerPort}`
                ],

                HostConfig: {
                    PortBindings: {
                        [`${containerPort}/tcp`]: [
                            {
                                HostPort: ""
                            }
                        ]
                    }
                }
            });

        return container;
    }

    async startContainer(container) {
        await container.start();
    }

    async getContainerPort(
        container,
        containerPort
    ) {
        const info = await container.inspect();

        const port =
            info.NetworkSettings.Ports[
                `${containerPort}/tcp`
            ];

        if (!port || port.length === 0) {
            throw new Error(
                "Docker did not assign a host port."
            );
        }

        return port[0].HostPort;
    }

    async getContainerStatus(container) {
        const info = await container.inspect();

        return info.State.Running;
    }

    async getLogs(container) {
        const logs = await container.logs({
            stdout: true,
            stderr: true,
            timestamps: true
        });

        return logs.toString();
    }

    async stopContainer(container) {
        const isRunning =
            await this.getContainerStatus(container);

        if (!isRunning) {
            return;
        }

        await container.stop();
    }

    async restartContainer(container) {
        await container.restart();
    }

    async getContainer(containerName) {
        return this.docker.getContainer(
            containerName
        );
    }
}

module.exports = DockerService;