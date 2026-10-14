// A local fake x402 API for the E2E test: the fakeX402Api test double from
// foxpay/testing behind a Node HTTP server on api.localhost. No chain, no money.
// With remote: true (Ichabod), it is on a create-foxkit tunnel instead: the
// 402 resource URL is the public https URL with the mount path, so it names
// the host the extension calls.
import { createServer } from "node:http";
import { tunnel } from "create-foxkit/e2e";
import { fakeX402Api } from "../dist/testing.js";

export async function startX402Api({ payTo, price, body, remote = false }) {
  let api;
  const server = createServer(async (req, res) => {
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([, v]) => typeof v === "string"));
    const answer = await api.handle(new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers }));
    res.writeHead(answer.status, Object.fromEntries(answer.headers));
    res.end(await answer.text());
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const stopServer = () => new Promise((resolve) => server.close(resolve));
  if (!remote) {
    api = fakeX402Api({ host: `api.localhost:${port}`, protocol: "http:", payTo, price, body });
    return { api, url: `http://api.localhost:${port}`, host: "api.localhost", local: `http://127.0.0.1:${port}`, close: stopServer };
  }
  const opened = await tunnel(port).catch(async (error) => {
    await stopServer();
    throw error;
  });
  const pub = new URL(opened.url);
  api = fakeX402Api({ host: `${pub.host}${pub.pathname}`, protocol: "https:", payTo, price, body });
  return {
    api,
    url: opened.url,
    host: pub.hostname,
    local: `http://127.0.0.1:${port}`,
    close: async () => {
      await opened.close();
      await stopServer();
    },
  };
}
