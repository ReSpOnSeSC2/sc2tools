module.exports = {
  apps : [
    {
      name: "sc2-overlay-server",
      script: "./index.js",
      cwd: "C:\\SC2TOOLS\\reveal-sc2-opponent-main\\stream-overlay-backend\\", 
      watch: false,
      env: {
        NODE_ENV: "production",
      }
    },
    {
      name: "sc2-api-poller",
      script: "powershell.exe",
      args: "-ExecutionPolicy bypass -NoProfile -File ./Reveal-Sc2Opponent.ps1",
      cwd: "C:\\SC2TOOLS\\reveal-sc2-opponent-main\\",
      watch: false,
      autorestart: true
    }
  ]
};