// PM2 process definition for running the Snapdrop WebSocket server on CloudPanel.
// Used by deploy/cloudpanel/config.yml.example's after_commands via:
//   pm2 start <deploy_directory>/current/ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'snapdrop-server',
      cwd: __dirname + '/server',
      script: 'index.js',
      env: {
        NODE_ENV: 'production',
        PORT: 3000
      }
    }
  ]
};
