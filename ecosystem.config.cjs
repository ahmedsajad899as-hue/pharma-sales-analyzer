module.exports = {
  apps: [
    {
      name: 'pharma-backend',
      script: 'server/index.js',
      cwd: 'D:\\my code\\marketing\\pharma-sales-analyzer',
      interpreter: 'node',
      watch: ['server'],
      watch_delay: 800,
      ignore_watch: ['uploads', 'node_modules', 'prisma/*.db', 'prisma/*.db-journal'],
      env: {
        NODE_ENV: 'development',
        PORT: 8080,
      },
    },
    {
      name: 'pharma-frontend',
      script: 'node_modules/vite/bin/vite.js',
      args: '--port 5175',
      cwd: 'D:\\my code\\marketing\\pharma-sales-analyzer',
      interpreter: 'node',
      // Vite handles its own HMR — PM2 watch disabled intentionally
      watch: false,
      env: {
        NODE_ENV: 'development',
      },
    },
  ],
};
