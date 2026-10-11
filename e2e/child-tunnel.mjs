// A tunnel on its own origin, for the E2E test on Ichabod. create-foxkit
// tunnel() opens one quick tunnel per process, so every mount in a process
// shares one origin. The shop must have an origin of its own: the extension
// finds the checkout tab by its host, and the merchant host must not be the
// API host or the frame host. So a child process opens the shop's tunnel.
// Run as a script: node e2e/child-tunnel.mjs <port>. It prints the URL and
// stays alive until it gets SIGTERM.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tunnel } from "create-foxkit/e2e";

const self = fileURLToPath(import.meta.url);

if (process.argv[1] === self) {
  const opened = await tunnel(Number(process.argv[2]));
  console.log(opened.url);
  setInterval(() => {}, 1 << 30);
}

/** A public URL for http://127.0.0.1:<port> on an origin that no other server in this run uses. */
export function childTunnel(port) {
  const child = spawn(process.execPath, [self, String(port)], { stdio: ["ignore", "pipe", "inherit"] });
  const kill = () => child.kill("SIGTERM");
  process.once("exit", kill);
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const close = async () => {
    process.off("exit", kill);
    if (child.exitCode === null && child.signalCode === null) kill();
    await exited;
  };
  return new Promise((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
      const url = /https:\/\/\S+/.exec(out)?.[0];
      if (url) resolve({ url, close });
    });
    exited.then((code) => reject(new Error(`The tunnel process for port ${port} exited (${code}) before it printed a URL.`)));
  });
}
