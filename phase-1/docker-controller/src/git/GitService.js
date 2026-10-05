const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

class GitService {
    async cloneRepository(repoUrl) {
        const deploymentId = Date.now();

        const repoPath = path.resolve(
            __dirname,
            "../../tmp",
            `repo-${deploymentId}`
        );

        await fs.promises.mkdir(
            path.dirname(repoPath),
            { recursive: true }
        );

        console.log("Cloning repository...");
        console.log("Repository:", repoUrl);
        console.log("Destination:", repoPath);

        await this.runGit([
            "clone",
            "--depth",
            "1",
            repoUrl,
            repoPath
        ]);

        console.log("Repository cloned!");

        return repoPath;
    }

    async runGit(args) {
        return new Promise((resolve, reject) => {
            const git = spawn("git", args);

            let stderr = "";

            git.stderr.on("data", (data) => {
                stderr += data.toString();
            });

            git.on("error", (error) => {
                reject(error);
            });

            git.on("close", (code) => {
                if (code !== 0) {
                    reject(
                        new Error(
                            stderr.trim() ||
                            `Git exited with code ${code}`
                        )
                    );

                    return;
                }

                resolve();
            });
        });
    }
}

module.exports = GitService;