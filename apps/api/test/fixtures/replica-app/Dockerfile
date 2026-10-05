# Fixture: answers with its container's hostname, so tests can see which replica served them.
FROM node:24-alpine
WORKDIR /app
COPY server.js .
USER node
EXPOSE 3000
CMD ["node", "server.js"]
