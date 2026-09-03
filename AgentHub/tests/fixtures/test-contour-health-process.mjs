import { createServer } from "node:http";
import process from "node:process";

const identity = JSON.parse(String(process.argv[2] ?? "{}"));
if (!identity.contourId || !identity.releaseId || !identity.model || !identity.runtimeNonce
    || typeof process.send !== "function") {
  throw new Error("complete Test Contour identity and IPC are required");
}

const server = createServer((request, response) => {
  if (request.url !== "/health") {
    response.writeHead(404).end();
    return;
  }
  const address = server.address();
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({
    ok: true,
    live: true,
    ready: true,
    status: "ready",
    testContourRuntime: {
      ...identity,
      expectedPort: address.port,
      actualPort: address.port,
      pid: process.pid,
    },
  }));
});

server.listen(0, "127.0.0.1", () => {
  process.send({ type: "ready", port: server.address().port, pid: process.pid });
});

const close = () => server.close(() => process.exit(0));
process.once("SIGINT", close);
process.once("SIGTERM", close);
