// A local fake x402 API for the E2E test: the fakeX402Api test double from
// foxpay/testing behind a Node HTTP server on api.localhost. No chain, no money.
import { createServer } from "node:http";
import { fakeX402Api } from "../dist/testing.js";

export async function startX402Api({ payTo, price, body }) {
  let api;
  const server = createServer(async (req, res) => {
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([, v]) => typeof v === "string"));
    const answer = await api.handle(new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers }));
    res.writeHead(answer.status, Object.fromEntries(answer.headers));
    res.end(await answer.text());
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  api = fakeX402Api({ host: `api.localhost:${port}`, protocol: "http:", payTo, price, body });
  return { api, url: `http://api.localhost:${port}`, port, close: () => new Promise((resolve) => server.close(resolve)) };
}
