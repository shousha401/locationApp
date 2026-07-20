// PM2 process config. Deploy with:
//   pm2 start ecosystem.config.js
//   pm2 save
//   pm2-startup install   (one-time, to survive reboots)
//
// max_memory_restart is higher than valueTool's because this app holds the full
// inventory snapshot (~250k rows) in RAM.
module.exports = {
  apps: [{
    name: 'locationApp',
    script: './server.js',
    // fork + a single instance on purpose: sessions AND the inventory snapshot live
    // in this process's memory. Under cluster with >1 instance each worker would hold
    // its own snapshot and its own session table, so logins would randomly "expire"
    // as requests landed on different workers.
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    error_file: './logs/error.log',
    out_file: './logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    env: {
      NODE_ENV: 'production',
    },
  }],
};
