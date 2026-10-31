// A stand-in backend worker for test/backend-client.test.ts: answers every
// call with its first argument after a short delay, and dies (an uncaught
// throw — the worker then emits "error" and, later, "exit") when asked to.
const { parentPort } = require("node:worker_threads");

parentPort.on("message", (m) => {
  if (m.args[0] === "crash") {
    setImmediate(() => {
      throw new Error("worker crashed");
    });
    return;
  }
  setTimeout(() => parentPort.postMessage({ id: m.id, ok: true, value: m.args[0] }), 100);
});
