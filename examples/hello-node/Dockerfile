FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
COPY server.js ./

# Don't run as root inside the container.
USER node

EXPOSE 3000
CMD ["node", "server.js"]
