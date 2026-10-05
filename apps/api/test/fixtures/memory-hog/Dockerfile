# Fixture: allocates (and touches) 512 MB at startup — far beyond a 64 MB limit.
FROM node:24-alpine
USER node
CMD ["node", "-e", "const chunks = []; for (let i = 0; i < 32; i++) chunks.push(Buffer.alloc(16 * 1024 * 1024, 1)); require('node:http').createServer((q, r) => r.end('ok')).listen(process.env.PORT)"]
