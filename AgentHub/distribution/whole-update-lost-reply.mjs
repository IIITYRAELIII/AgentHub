import assert from "node:assert/strict";
import { Socket } from "node:net";
import { pathToFileURL } from "node:url";
const [entry, request, continuation] = process.argv.slice(2);
const { resumePackageBootstrap } = await import(pathToFileURL(entry));
const emit = Socket.prototype.emit;
let dropped = false;
Socket.prototype.emit = function (name, ...args) {
  if (!dropped && name === "data" && String(args[0]).includes('"ackRequired":true')) {
    dropped = true;
    // Actual response bytes arrived from the authenticated owner. Lose them
    // before the client consumes/ACKs them; do not substitute a service result.
    this.destroy(); return true;
  }
  return emit.call(this, name, ...args);
};
try {
  await assert.rejects(resumePackageBootstrap(request, continuation), error =>
    error.desktopControlRequestMayHaveReachedServer === true && error.code === "ECONNRESET");
  assert.equal(dropped, true); console.log(JSON.stringify({ dropped: true, outcome: "unknown-to-caller", replayed: false }));
} finally { Socket.prototype.emit = emit; }
