"use strict";
// dsh-review ssh-sidebar auth proxy: tailscale-ip:3082 -> dsh web 127.0.0.1:3080,
// injects the signed same-origin cookie (dsh keeps the secret across restarts).
const { startAuthProxy } = require("/home/xi/.dsh-review-tools/dsh-auth-proxy.js");
startAuthProxy({
  listenHost: "100.85.98.34",
  listenPort: 3082,
  targetHost: "127.0.0.1",
  targetPort: 3080,
  log: (m) => console.log(m),
});
