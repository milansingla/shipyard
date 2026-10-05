# Fixture: starts, prints an error, exits 1. Used to verify FAILED handling.
FROM node:24-alpine
EXPOSE 3000
CMD ["node", "-e", "console.error('fatal: missing DATABASE_URL'); process.exit(1)"]
