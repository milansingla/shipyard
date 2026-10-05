# Fixture: the app on $PORT, its health endpoint on a separate port (9000).
FROM node:24-alpine
WORKDIR /app
COPY server.js .
USER node
EXPOSE 3000
CMD ["node", "server.js"]
