# Fixture: a non-root app that counts its boots in a file under /data.
FROM node:24-alpine
WORKDIR /app
COPY server.js .
USER node
EXPOSE 3000
CMD ["node", "server.js"]
