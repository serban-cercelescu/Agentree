#!/usr/bin/env node
// A stand-in for `codex app-server`: newline JSON-RPC on stdio, enough of the
// protocol to drive Agentree's client. FAKE_CODEX_MODE picks the behaviour:
//   ok     answer initialize and thread/fork (echoing the fork params back)
//   env    answer thread/fork with the CODEX_HOME it was started with as cwd
//   error  answer thread/fork with a JSON-RPC error
//   exit   exit right after initialize, with requests outstanding
//   hang   never answer thread/fork
const mode = process.env.FAKE_CODEX_MODE ?? "ok";
if (process.argv[2] !== "app-server") process.exit(2);
let buf = "";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (m.method === "initialize") {
      send({ id: m.id, result: { userAgent: "fake" } });
      if (mode === "exit") setTimeout(() => process.exit(3), 20);
    } else if (m.method === "thread/fork") {
      if (mode === "error") send({ id: m.id, error: { code: -32600, message: "fork refused" } });
      else if (mode === "ok") send({ id: m.id, result: { thread: { id: "fake-thread", cwd: JSON.stringify(m.params) } } });
      else if (mode === "env") send({ id: m.id, result: { thread: { id: "fake-thread", cwd: process.env.CODEX_HOME ?? "(unset)" } } });
    }
  }
});
