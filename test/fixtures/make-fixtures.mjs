// Generates the synthetic transcript fixtures under test/fixtures/.
//
// Every record shape here was copied from real transcripts (Claude Code
// 2.1.310 VS Code extension, codex-cli 0.162 VS Code extension) with the
// content replaced — no user data is committed. Re-run after changing it:
//
//   node test/fixtures/make-fixtures.mjs
//
// The output is committed, so a format regression shows up as a test failure
// rather than depending on whatever happens to be in the developer's home dir.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const jsonl = (recs) => recs.map((r) => JSON.stringify(r)).join("\n") + "\n";
const write = (rel, recs, { zst = false } = {}) => {
  const file = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = Buffer.from(jsonl(recs));
  fs.writeFileSync(file, zst ? zlib.zstdCompressSync(body) : body);
};
const ts = (min) => new Date(Date.UTC(2026, 9, 1, 10, min)).toISOString();

// ------------------------------------------------------------------ Claude
//
// c--work-demo holds:
//   P  a session with three prompts and a rewind branch after prompt 2;
//   F  the VS Code extension's "Fork conversation" of P after prompt 2
//      (fresh uuids, same message/prompt ids, custom-title "(fork)");
//   S  an unrelated session with the SAME opening prompt but its own replies
//      (must never merge with P).
// The other project dirs below each hold one branch pattern the review of
// the modernization found mishandled.

const CLAUDE = "claude/2.1/projects/c--work-demo";
const P = "11111111-1111-4111-8111-111111111111";
const F = "22222222-2222-4222-8222-222222222222";
const S = "33333333-3333-4333-8333-333333333333";
const CWD = "C:\\work\\demo";
const common = (sessionId) => ({
  isSidechain: false,
  cwd: CWD,
  sessionId,
  version: "2.1.310",
  entrypoint: "claude-vscode",
});
const user = (sessionId, uuid, parentUuid, min, promptId, content) => ({
  parentUuid,
  ...common(sessionId),
  promptId,
  type: "user",
  message: { role: "user", content },
  uuid,
  timestamp: ts(min),
});
const asst = (sessionId, uuid, parentUuid, min, id, content) => ({
  parentUuid,
  ...common(sessionId),
  type: "assistant",
  message: {
    id,
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 100 },
  },
  requestId: `req_${id}`,
  uuid,
  timestamp: ts(min),
});
const text = (t) => ({ type: "text", text: t });
const IDE = "<ide_opened_file>The user opened the file c:\\work\\demo\\README.md in the IDE. This may or may not be related to the current task.</ide_opened_file>";

const parent = [
  user(P, "p-u1", null, 0, "prompt-1", [text(IDE), text("Explain the build")]),
  asst(P, "p-a1a", "p-u1", 1, "msg_1", [{ type: "thinking", thinking: "Look at package.json." }]),
  asst(P, "p-a1b", "p-a1a", 1, "msg_1", [text("The build uses esbuild.")]),
  // Request-capture bookkeeping that carries message content but is NOT a turn.
  { type: "api-request-blob", uuid: "p-blob", parentUuid: "p-a1b", message: { role: "user", content: [text("NOT A TURN")] }, timestamp: ts(1) },
  user(P, "p-u2", "p-a1b", 2, "prompt-2", "Now add tests"),
  asst(P, "p-a2", "p-u2", 3, "msg_2", [text("Added vitest.")]),
  user(P, "p-u3", "p-a2", 4, "prompt-3", "Ship it"),
  asst(P, "p-a3", "p-u3", 5, "msg_3", [text("Shipped.")]),
  // Rewind: a second child of p-a2, inside the same transcript.
  user(P, "p-u3b", "p-a2", 6, "prompt-4", "Actually, wait"),
  asst(P, "p-a3b", "p-u3b", 7, "msg_4", [text("Waiting.")]),
  { type: "ai-title", aiTitle: "Build walkthrough", sessionId: P },
  { type: "last-prompt", leafUuid: "p-a3b", lastPrompt: "Actually, wait", sessionId: P },
];
write(`${CLAUDE}/${P}.jsonl`, parent);

const fork = [
  user(F, "f-u1", null, 0, "prompt-1", [text(IDE), text("Explain the build")]),
  asst(F, "f-a1a", "f-u1", 1, "msg_1", [{ type: "thinking", thinking: "Look at package.json." }]),
  asst(F, "f-a1b", "f-a1a", 1, "msg_1", [text("The build uses esbuild.")]),
  user(F, "f-u2", "f-a1b", 2, "prompt-2", "Now add tests"),
  // The extension re-stamps the LAST copied record with the fork time.
  asst(F, "f-a2", "f-u2", 30, "msg_2", [text("Added vitest.")]),
  { type: "custom-title", sessionId: F, customTitle: "Build walkthrough (fork)" },
  user(F, "f-u3", "f-a2", 31, "prompt-5", "Try rollup instead"),
  asst(F, "f-a3", "f-u3", 32, "msg_5", [text("Switched to rollup.")]),
];
write(`${CLAUDE}/${F}.jsonl`, fork);

write(`${CLAUDE}/${S}.jsonl`, [
  user(S, "s-u1", null, 40, "prompt-9", "Explain the build"),
  asst(S, "s-a1", "s-u1", 41, "msg_9", [text("A different answer.")]),
]);

const title = (sessionId, t) => ({ type: "custom-title", sessionId, customTitle: t });
const CL = "claude/2.1/projects";

// c--work-lineage, two families.
//
// Rewind-after-fork: P1 → F1 (native fork after p1-a2, own turn), G1 (native
// fork of F1 after F1's own reply), and THEN F1 rewinds to after its first
// reply. G1's newest chain now shares more with P1 than with F1; its parent
// must still be F1, and F1's own reply must be drawn once.
const P1 = "41111111-1111-4111-8111-111111111111";
const F1 = "42222222-2222-4222-8222-222222222222";
const G1 = "43333333-3333-4333-8333-333333333333";
const base1 = (sid, px) => [
  user(sid, `${px}-u1`, null, 0, "lp-1", "Plan the release"),
  asst(sid, `${px}-a1`, `${px}-u1`, 1, "msg_l1", [text("Three steps.")]),
  user(sid, `${px}-u2`, `${px}-a1`, 2, "lp-2", "Detail step one"),
  asst(sid, `${px}-a2`, `${px}-u2`, 3, "msg_l2", [text("Step one is tagging.")]),
];
write(`${CL}/c--work-lineage/${P1}.jsonl`, [
  ...base1(P1, "p1"),
  user(P1, "p1-u3", "p1-a2", 4, "lp-3", "Then step two"),
  asst(P1, "p1-a3", "p1-u3", 5, "msg_l3", [text("Step two is the changelog.")]),
  title(P1, "Release plan"),
]);
write(`${CL}/c--work-lineage/${F1}.jsonl`, [
  ...base1(F1, "f1"),
  title(F1, "Release plan (fork)"),
  user(F1, "f1-u3", "f1-a2", 10, "lf-3", "Skip to rollback"),
  asst(F1, "f1-a3", "f1-u3", 11, "msg_f3", [text("Rollback is a revert.")]),
  // The rewind, written after G1 was forked from f1-a3.
  user(F1, "f1-u4", "f1-a1", 20, "lf-4", "Start over with a hotfix"),
  asst(F1, "f1-a4", "f1-u4", 21, "msg_f4", [text("Hotfix first, then release.")]),
]);
write(`${CL}/c--work-lineage/${G1}.jsonl`, [
  ...base1(G1, "g1"),
  user(G1, "g1-u3", "g1-a2", 10, "lf-3", "Skip to rollback"),
  asst(G1, "g1-a3", "g1-u3", 15, "msg_f3", [text("Rollback is a revert.")]),
  title(G1, "Release plan (fork) (fork)"),
  user(G1, "g1-u4", "g1-a3", 16, "lg-4", "Script the revert"),
  asst(G1, "g1-a4", "g1-u4", 17, "msg_g4", [text("Here is the script.")]),
]);

// Renamed explicit descendant: the parent's own title happens to carry
// "(fork)", and its Agentree-written child (explicit forkedFrom) was renamed.
// Title order alone puts the child first; it must not become the parent of
// its own parent (a cycle that used to duplicate the prefix).
const P2 = "44444444-4444-4444-8444-444444444444";
const F2 = "45555555-5555-4555-8555-555555555555";
const base2 = (sid, px, extra = {}) => [
  { ...user(sid, `${px}-u1`, null, 30, "rp-1", "Draft the email"), ...extra },
  { ...asst(sid, `${px}-a1`, `${px}-u1`, 31, "msg_r1", [text("Dear team,")]), ...extra },
];
write(`${CL}/c--work-lineage/${P2}.jsonl`, [
  ...base2(P2, "p2"),
  user(P2, "p2-u2", "p2-a1", 32, "rp-2", "Make it shorter"),
  asst(P2, "p2-a2", "p2-u2", 33, "msg_r2", [text("Team,")]),
  title(P2, "Email (fork)"),
]);
write(`${CL}/c--work-lineage/${F2}.jsonl`, [
  ...base2(F2, "f2", { forkedFrom: { sessionId: P2, messageUuid: "p2-a1" } }),
  title(F2, "Renamed child"),
  user(F2, "f2-u2", "f2-a1", 40, "rf-2", "Make it formal"),
  asst(F2, "f2-a2", "f2-u2", 41, "msg_rf2", [text("Dear colleagues,")]),
]);

// c--work-regen: the parent regenerated its first answer; a native fork taken
// on the regenerated branch copies THAT answer, not the first one in the file.
const QP = "46666666-6666-4666-8666-666666666666";
const QF = "47777777-7777-4777-8777-777777777777";
write(`${CL}/c--work-regen/${QP}.jsonl`, [
  user(QP, "qp-u1", null, 0, "qp-1", "Name the project"),
  asst(QP, "qp-a1", "qp-u1", 1, "msg_q1", [text("Call it Atlas.")]),
  asst(QP, "qp-a1b", "qp-u1", 2, "msg_q1b", [text("Call it Beacon.")]),
  user(QP, "qp-u2", "qp-a1b", 3, "qp-2", "Why Beacon?"),
  asst(QP, "qp-a2", "qp-u2", 4, "msg_q2", [text("It guides.")]),
]);
write(`${CL}/c--work-regen/${QF}.jsonl`, [
  user(QF, "qf-u1", null, 0, "qp-1", "Name the project"),
  asst(QF, "qf-a1b", "qf-u1", 2, "msg_q1b", [text("Call it Beacon.")]),
  user(QF, "qf-u2", "qf-a1b", 3, "qp-2", "Why Beacon?"),
  asst(QF, "qf-a2", "qf-u2", 9, "msg_q2", [text("It guides.")]),
  title(QF, "Naming (fork)"),
  user(QF, "qf-u3", "qf-a2", 10, "qf-3", "Pick a logo"),
  asst(QF, "qf-a3", "qf-u3", 11, "msg_qf3", [text("A lighthouse.")]),
]);

// c--work-compact: a compacted session and the extension's native fork of a
// post-compact turn. The extension copies the LOGICAL chain (pre-compact
// history included), keeps the boundary's parentUuid null, and leaves its
// logicalParentUuid pointing at the parent's uuid (read from forkSession,
// 2.1.310) — so in the copy that reference is stale.
const KP = "48888888-8888-4888-8888-888888888888";
const KN = "49999999-9999-4999-8999-999999999999";
const boundary = (sid, uuid, logical, min) => ({
  parentUuid: null,
  logicalParentUuid: logical,
  ...common(sid),
  type: "system",
  subtype: "compact_boundary",
  content: "Conversation compacted",
  compactMetadata: { trigger: "manual", preTokens: 90000 },
  uuid,
  timestamp: ts(min),
});
const compactBase = (sid, px, last) => [
  user(sid, `${px}-u1`, null, 0, "kp-1", "Audit the module"),
  asst(sid, `${px}-a1`, `${px}-u1`, 1, "msg_k1", [text("Found four issues.")]),
  boundary(sid, `${px}-cb`, "kp-a1", 2),
  {
    ...user(sid, `${px}-u2`, `${px}-cb`, 3, undefined, "This session is being continued from a previous conversation. Summary: four issues."),
    isCompactSummary: true,
  },
  asst(sid, `${px}-a2`, `${px}-u2`, last, "msg_k2", [text("Continuing with issue one.")]),
];
write(`${CL}/c--work-compact/${KP}.jsonl`, [
  ...compactBase(KP, "kp", 4),
  user(KP, "kp-u3", "kp-a2", 5, "kp-3", "Fix issue two"),
  asst(KP, "kp-a3", "kp-u3", 6, "msg_k3", [text("Issue two fixed.")]),
]);
write(`${CL}/c--work-compact/${KN}.jsonl`, [
  ...compactBase(KN, "kn", 20),
  title(KN, "Audit (fork)"),
  user(KN, "kn-u3", "kn-a2", 21, "kn-3", "Fix issue three instead"),
  asst(KN, "kn-a3", "kn-u3", 22, "msg_kn3", [text("Issue three fixed.")]),
]);

// c--work-noprompt: an older transcript whose second prompt has no promptId.
// A fork ending ON that prompt re-stamps it, so its timestamp is no identity.
const NP = "4aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
write(`${CL}/c--work-noprompt/${NP}.jsonl`, [
  user(NP, "np-u1", null, 0, "np-1", "First question"),
  asst(NP, "np-a1", "np-u1", 1, "msg_n1", [text("First answer.")]),
  user(NP, "np-u2", "np-a1", 2, undefined, "Second question"),
  asst(NP, "np-a2", "np-u2", 3, "msg_n2", [text("Second answer.")]),
]);

// c--work-broken: a readable file with no parseable line is a failure, not
// an empty session.
fs.mkdirSync(path.join(ROOT, CL, "c--work-broken"), { recursive: true });
fs.writeFileSync(
  path.join(ROOT, CL, "c--work-broken", "4bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl"),
  "{not json\nnor is this\n",
);

// c--work-attach: a prompt, a tools-only reply (no node), then a mid-turn
// message the user typed (a real queued_command attachment), then the reply.
// The prompt and the attachment fold into one drawn node; forking it must not
// fall back to the prompt's anchor and silently drop the message it shows.
const AT = "4ccccccc-cccc-4ccc-8ccc-cccccccccccc";
write(`${CL}/c--work-attach/${AT}.jsonl`, [
  user(AT, "at-u1", null, 0, "at-1", "Run the migration"),
  asst(AT, "at-a1", "at-u1", 1, "msg_at1", [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "migrate" } }]),
  { ...user(AT, "at-r1", "at-a1", 2, "at-1", [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }]) },
  {
    parentUuid: "at-r1",
    ...common(AT),
    promptId: "at-1",
    type: "attachment",
    attachment: { type: "queued_command", prompt: "also back up first", commandMode: "prompt", origin: { kind: "human" } },
    uuid: "at-q1",
    timestamp: ts(3),
  },
  asst(AT, "at-a2", "at-q1", 4, "msg_at2", [text("Backed up, then migrated.")]),
]);

// c--work-preamble: two prompts with no promptId that share a long opening
// and differ only at the end, in a native fork pair. They are different
// prompts; neither may stand in for the other.
const PA = "4ddddddd-dddd-4ddd-8ddd-dddddddddddd";
const PB = "4eeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const PREAMBLE =
  "Context: we are building the order service, it must stay backwards compatible with v1 clients, and ";
const pre = (sid, px, min) => [
  user(sid, `${px}-u1`, null, min, "pa-1", "Design the cache layer"),
  asst(sid, `${px}-a1`, `${px}-u1`, min + 1, "msg_pa1", [text("Two options.")]),
];
write(`${CL}/c--work-preamble/${PA}.jsonl`, [
  ...pre(PA, "pa", 0),
  user(PA, "pa-u2", "pa-a1", 2, undefined, `${PREAMBLE}use SQLite`),
  asst(PA, "pa-a2", "pa-u2", 3, "msg_sql", [text("SQLite answer.")]),
]);
write(`${CL}/c--work-preamble/${PB}.jsonl`, [
  ...pre(PB, "pb", 0),
  title(PB, "Cache (fork)"),
  user(PB, "pb-u2", "pb-a1", 10, undefined, `${PREAMBLE}use Redis`),
  asst(PB, "pb-a2", "pb-u2", 11, "msg_redis", [text("Redis answer.")]),
]);

// rename-src/c--work-rename: P3 → F3 (native fork, "Root (fork)") → G3
// (native fork of F3's own reply, then RENAMED). Outside projects/ on purpose:
// the test copies them in one at a time, so their creation order is the true
// one — which a title-only rename must not overturn.
const P3 = "4fffffff-ffff-4fff-8fff-ffffffffffff";
const F3 = "50000000-0000-4000-8000-000000000001";
const G3 = "50000000-0000-4000-8000-000000000002";
const RN = "claude/2.1/rename-src/c--work-rename";
const base3 = (sid, px) => [
  user(sid, `${px}-u1`, null, 0, "rn-1", "Outline the talk"),
  asst(sid, `${px}-a1`, `${px}-u1`, 1, "msg_rn1", [text("Intro, body, close.")]),
];
write(`${RN}/${P3}.jsonl`, [
  ...base3(P3, "p3"),
  user(P3, "p3-u2", "p3-a1", 2, "rn-2", "Expand the intro"),
  asst(P3, "p3-a2", "p3-u2", 3, "msg_rn2", [text("Open with a story.")]),
  title(P3, "Root"),
]);
write(`${RN}/${F3}.jsonl`, [
  ...base3(F3, "f3"),
  title(F3, "Root (fork)"),
  user(F3, "f3-u2", "f3-a1", 10, "rnf-2", "Expand the close"),
  asst(F3, "f3-a2", "f3-u2", 11, "msg_rnf2", [text("End with a question.")]),
]);
write(`${RN}/${G3}.jsonl`, [
  ...base3(G3, "g3"),
  user(G3, "g3-u2", "g3-a1", 10, "rnf-2", "Expand the close"),
  asst(G3, "g3-a2", "g3-u2", 20, "msg_rnf2", [text("End with a question.")]),
  title(G3, "Renamed grandchild"),
  user(G3, "g3-u3", "g3-a2", 21, "rng-3", "Which question?"),
  asst(G3, "g3-a3", "g3-u3", 22, "msg_rng3", [text("Ask what they'll try first.")]),
]);

// c--work-toolloop: the last prose is early, then a long tool loop (tool_use
// replies and tool_result records, no new text), then a mode change written
// much later. Activity is the newest tool record; the mode change is only a
// file change.
const TL = "50000000-0000-4000-8000-000000000003";
const toolCall = (sid, uuid, parent, min, id, n) =>
  asst(sid, uuid, parent, min, id, [{ type: "tool_use", id: `tu_${n}`, name: "Bash", input: { command: `step ${n}` } }]);
const toolResult = (sid, uuid, parent, min, n) =>
  user(sid, uuid, parent, min, "tl-1", [{ type: "tool_result", tool_use_id: `tu_${n}`, content: "ok" }]);
write(`${CL}/c--work-toolloop/${TL}.jsonl`, [
  user(TL, "tl-u1", null, 0, "tl-1", "Run the long job"),
  asst(TL, "tl-a1", "tl-u1", 1, "msg_tl1", [text("Starting.")]),
  toolCall(TL, "tl-a2", "tl-a1", 5, "msg_tl2", 2),
  toolResult(TL, "tl-r2", "tl-a2", 6, 2),
  toolCall(TL, "tl-a3", "tl-r2", 8, "msg_tl3", 3),
  toolResult(TL, "tl-r3", "tl-a3", 9, 3),
  { type: "permission-mode", permissionMode: "acceptEdits", sessionId: TL, timestamp: ts(300) },
]);

// c--work-new: a session filed in the new directory's project folder whose
// records start in the old one (a moved repo), record the new one in three
// spellings (trailing separator, lower-case drive, Git Bash), and end after
// the agent `cd`'d into a subfolder — the cwd is the shell's. It belongs to
// the new directory: not the old one, not the subfolder. A bookkeeping
// record with the old cwd at the end must not move it back.
const MV = "50000000-0000-4000-8000-000000000004";
const at = (rec, cwd) => ({ ...rec, cwd });
write(`${CL}/c--work-new/${MV}.jsonl`, [
  at(user(MV, "mv-u1", null, 0, "mv-1", "Start here"), "C:\\work\\old"),
  at(asst(MV, "mv-a1", "mv-u1", 1, "msg_mv1", [text("Started.")]), "C:\\work\\old"),
  at(user(MV, "mv-u2", "mv-a1", 2, "mv-2", "Moved the repo"), "c:\\work\\new\\"),
  at(asst(MV, "mv-a2", "mv-u2", 3, "msg_mv2", [text("Noted.")]), "C:\\work\\new"),
  at(user(MV, "mv-u3", "mv-a2", 4, "mv-3", "From Git Bash now"), "/c/work/new"),
  at(asst(MV, "mv-a3", "mv-u3", 5, "msg_mv3", [text("Still here.")]), "/c/work/new"),
  at(user(MV, "mv-u4", "mv-a3", 6, "mv-4", "Build the app"), "C:\\work\\new\\src"),
  at(asst(MV, "mv-a4", "mv-u4", 7, "msg_mv4", [text("Built in src.")]), "C:\\work\\new\\src"),
  { type: "file-history-snapshot", messageId: "mv-a4", snapshot: {}, cwd: "C:\\work\\old" },
]);

// c--work-cd: no folder name to go by (it encodes no recorded cwd), and the
// agent cd'd into a subfolder and back up past the start. The session stays
// where it began.
const CD = "50000000-0000-4000-8000-000000000008";
write(`${CL}/c--work-cd/${CD}.jsonl`, [
  at(user(CD, "cd-u1", null, 0, "cd-1", "Look around"), "C:\\repo"),
  at(asst(CD, "cd-a1", "cd-u1", 1, "msg_cd1", [text("In the repo.")]), "C:\\repo\\pkg\\a"),
  at(user(CD, "cd-u2", "cd-a1", 2, "cd-2", "Go up"), "C:\\"),
  at(asst(CD, "cd-a2", "cd-u2", 3, "msg_cd2", [text("At the drive root.")]), "C:\\"),
]);

// One session id in several project folders (a moved repo).
//
// c--work-moved-a-old holds the copy left behind; c--work-moved-b-new the
// same transcript (same uuids) grown on after the move, in the new cwd.
// c--work-moved-c-third holds a native fork of it, taken in a third folder.
// The old folder sorts FIRST, so a lookup that takes the first hit opens
// the stale prefix.
const MO = "50000000-0000-4000-8000-000000000005";
const MF = "50000000-0000-4000-8000-000000000006";
const movedPrefix = [
  at(user(MO, "mo-u1", null, 0, "mo-1", "Rename the package"), "C:\\work\\atlas"),
  at(asst(MO, "mo-a1", "mo-u1", 1, "msg_mo1", [text("Renamed to articulation.")]), "C:\\work\\atlas"),
  { type: "custom-title", sessionId: MO, customTitle: "Package rename" },
];
write(`${CL}/c--work-moved-a-old/${MO}.jsonl`, movedPrefix);
write(`${CL}/c--work-moved-b-new/${MO}.jsonl`, [
  ...movedPrefix,
  at(user(MO, "mo-u2", "mo-a1", 10, "mo-2", "Now update the imports"), "C:\\work\\articulation"),
  at(asst(MO, "mo-a2", "mo-u2", 11, "msg_mo2", [text("Imports updated.")]), "C:\\work\\articulation"),
]);
write(`${CL}/c--work-moved-c-third/${MF}.jsonl`, [
  at(user(MF, "mf-u1", null, 0, "mo-1", "Rename the package"), "C:\\work\\third"),
  at(asst(MF, "mf-a1", "mf-u1", 1, "msg_mo1", [text("Renamed to articulation.")]), "C:\\work\\third"),
  at(user(MF, "mf-u2", "mf-a1", 10, "mo-2", "Now update the imports"), "C:\\work\\third"),
  at(asst(MF, "mf-a2", "mf-u2", 20, "msg_mo2", [text("Imports updated.")]), "C:\\work\\third"),
  title(MF, "Package rename (fork)"),
  at(user(MF, "mf-u3", "mf-a2", 21, "mf-3", "Publish it"), "C:\\work\\third"),
  at(asst(MF, "mf-a3", "mf-u3", 22, "msg_mf3", [text("Published.")]), "C:\\work\\third"),
]);

// c--work-split-a / -b: two copies of ONE session that share a prefix and
// then each grew their own continuation. Neither contains the other, so both
// are real history.
const SP = "50000000-0000-4000-8000-000000000007";
const splitPrefix = [
  user(SP, "sp-u1", null, 0, "sp-1", "Plan the migration"),
  asst(SP, "sp-a1", "sp-u1", 1, "msg_sp1", [text("Two phases.")]),
];
write(`${CL}/c--work-split-a/${SP}.jsonl`, [
  ...splitPrefix,
  user(SP, "sa-u2", "sp-a1", 2, "sa-2", "Phase one first"),
  asst(SP, "sa-a2", "sa-u2", 3, "msg_sa2", [text("Phase one done.")]),
]);
write(`${CL}/c--work-split-b/${SP}.jsonl`, [
  ...splitPrefix,
  user(SP, "sb-u2", "sp-a1", 5, "sb-2", "Phase two first"),
  asst(SP, "sb-a2", "sb-u2", 6, "msg_sb2", [text("Phase two done.")]),
]);

// c--work-indent: a native fork pair whose prompts after the shared reply
// have no promptId and differ ONLY in indentation — which changes what the
// code means. They are two prompts, each with its own reply.
const WP = "50000000-0000-4000-8000-000000000009";
const WF = "50000000-0000-4000-8000-00000000000a";
const GUARD_OUT = "Change it:\n\n```python\nif ready:\n    send()\ncancel()\n```";
const GUARD_IN = "Change it:\n\n```python\nif ready:\n    send()\n    cancel()\n```";
const wiBase = (sid, px) => [
  user(sid, `${px}-u1`, null, 0, "wi-1", "Write the guard"),
  asst(sid, `${px}-a1`, `${px}-u1`, 1, "msg_wi1", [text("Here is the guard.")]),
];
write(`${CL}/c--work-indent/${WP}.jsonl`, [
  ...wiBase(WP, "wp"),
  user(WP, "wp-u2", "wp-a1", 2, undefined, GUARD_OUT),
  asst(WP, "wp-a2", "wp-u2", 3, "msg_wi_out", [text("Unconditional cancel.")]),
  title(WP, "Guard"),
]);
write(`${CL}/c--work-indent/${WF}.jsonl`, [
  ...wiBase(WF, "wf"),
  title(WF, "Guard (fork)"),
  user(WF, "wf-u2", "wf-a1", 10, undefined, GUARD_IN),
  asst(WF, "wf-a2", "wf-u2", 11, "msg_wi_in", [text("Conditional cancel.")]),
]);

// c--work-endpoint: quiet forks (no turn of their own) whose endpoint falls
// inside what the parent alone draws as one merged node.
//   EP  prompt → reply "First prose." + a tool call → tool result → reply
//       "Later prose." (one agent loop: drawn as one assistant node);
//   EF  the extension's fork after "First prose." — it never had "Later prose.";
//   UP  two user records in a row (drawn as one user node), then a reply;
//   UF  an Agentree fork after the FIRST of them (explicit lineage: it copied
//       no reply, so no message id links it).
// EP's prompt is multi-line WITH a promptId: its identity changed when
// digests stopped folding whitespace, so annotations saved before must
// still be found.
const EP = "50000000-0000-4000-8000-00000000000b";
const EF = "50000000-0000-4000-8000-00000000000c";
const UP = "50000000-0000-4000-8000-00000000000d";
const UF = "50000000-0000-4000-8000-00000000000e";
const epBase = (sid, px, last) => [
  user(sid, `${px}-u1`, null, 0, "ep-1", "Summarise the log\n\n  - errors only"),
  asst(sid, `${px}-a1`, `${px}-u1`, last, "msg_ep1", [text("First prose."), { type: "tool_use", id: "tu_ep", name: "Read", input: { path: "log" } }]),
];
write(`${CL}/c--work-endpoint/${EP}.jsonl`, [
  ...epBase(EP, "ep", 1),
  user(EP, "ep-r1", "ep-a1", 2, "ep-1", [{ type: "tool_result", tool_use_id: "tu_ep", content: "ok" }]),
  asst(EP, "ep-a2", "ep-r1", 3, "msg_ep2", [text("Later prose.")]),
  title(EP, "Log summary"),
]);
write(`${CL}/c--work-endpoint/${EF}.jsonl`, [...epBase(EF, "ef", 20), title(EF, "Log summary (fork)")]);
write(`${CL}/c--work-endpoint/${UP}.jsonl`, [
  user(UP, "up-u1", null, 0, "up-1", "First ask"),
  user(UP, "up-u2", "up-u1", 1, "up-2", "Second ask"),
  asst(UP, "up-a1", "up-u2", 2, "msg_up1", [text("Both answered.")]),
  title(UP, "Asks"),
]);
write(`${CL}/c--work-endpoint/${UF}.jsonl`, [
  { ...user(UF, "uf-u1", null, 30, "up-1", "First ask"), forkedFrom: { sessionId: UP, messageUuid: "up-u1" } },
  title(UF, "Asks (fork)"),
]);

// growth-src/c--work-growth: a session and a native fork of it, copied into
// projects/ one at a time by the test — so an annotation can be made while
// the session stands alone, before the fork exists.
const GP = "50000000-0000-4000-8000-00000000000f";
const GF = "50000000-0000-4000-8000-000000000010";
const gBase = (sid, px) => [
  user(sid, `${px}-u1`, null, 0, "gr-1", "Pick a database"),
  asst(sid, `${px}-a1`, `${px}-u1`, 1, "msg_gr1", [text("Postgres.")]),
];
write(`claude/2.1/growth-src/c--work-growth/${GP}.jsonl`, [
  ...gBase(GP, "gp"),
  user(GP, "gp-u2", "gp-a1", 2, "gr-2", "Why?"),
  asst(GP, "gp-a2", "gp-u2", 3, "msg_gr2", [text("Transactions.")]),
]);
write(`claude/2.1/growth-src/c--work-growth/${GF}.jsonl`, [
  ...gBase(GF, "gf"),
  title(GF, "Database (fork)"),
  user(GF, "gf-u2", "gf-a1", 10, "grf-2", "What about SQLite?"),
  asst(GF, "gf-a2", "gf-u2", 11, "msg_grf2", [text("Fine for one writer.")]),
]);

// copies-src: sessions stored in two project folders whose NEWER-written copy
// holds metadata the other doesn't, copied in by the test with set mtimes.
//   RN  the old folder's copy is the larger one (prefix + continuation,
//       titled "Older name"); the new folder's copy holds only the prefix
//       and a rename. Every uuid of the new copy is in the old one.
//   DV  two copies that diverged; the newer one was renamed BEFORE its
//       first record the other doesn't have.
const RNS = "50000000-0000-4000-8000-000000000011";
const DV = "50000000-0000-4000-8000-000000000012";
const rnPrefix = [
  user(RNS, "rn-u1", null, 0, "rns-1", "Tidy the README"),
  asst(RNS, "rn-a1", "rn-u1", 1, "msg_rns1", [text("Tidied.")]),
];
write(`claude/2.1/copies-src/c--work-rn-old/${RNS}.jsonl`, [
  ...rnPrefix,
  title(RNS, "Older name"),
  user(RNS, "rn-u2", "rn-a1", 2, "rns-2", "And the changelog"),
  asst(RNS, "rn-a2", "rn-u2", 3, "msg_rns2", [text("Done too.")]),
]);
write(`claude/2.1/copies-src/c--work-rn-new/${RNS}.jsonl`, [...rnPrefix, title(RNS, "Renamed in copy")]);
const dvPrefix = [
  user(DV, "dv-u1", null, 0, "dv-1", "Draft the plan"),
  asst(DV, "dv-a1", "dv-u1", 1, "msg_dv1", [text("Drafted.")]),
];
write(`claude/2.1/copies-src/c--work-dv-a/${DV}.jsonl`, [
  ...dvPrefix,
  user(DV, "dva-u2", "dv-a1", 2, "dva-2", "Shorter"),
  asst(DV, "dva-a2", "dva-u2", 3, "msg_dva2", [text("Shortened.")]),
]);
write(`claude/2.1/copies-src/c--work-dv-b/${DV}.jsonl`, [
  ...dvPrefix,
  title(DV, "Named before diverging"),
  user(DV, "dvb-u2", "dv-a1", 5, "dvb-2", "Longer"),
  asst(DV, "dvb-a2", "dvb-u2", 6, "msg_dvb2", [text("Lengthened.")]),
]);

// split-src/c--work-split-family: a family held together by one member.
//   SP4  a prompt and its answer "Use a queue.";
//   SB4  a native fork of it that regenerated the answer: it holds the copied
//        "Use a queue." AND, on another branch, "Use a cron job.";
//   SF4  a fork of SB4's regenerated branch: it shares "Use a cron job." with
//        SB4, but holds no copy of anything only SP4 has.
// Deleting SB4 leaves SP4 and SF4 with no shared evidence: two families.
const SP4 = "50000000-0000-4000-8000-000000000013";
const SB4 = "50000000-0000-4000-8000-000000000014";
const SF4 = "50000000-0000-4000-8000-000000000015";
const SPL = "claude/2.1/split-src/c--work-split-family";
write(`${SPL}/${SP4}.jsonl`, [
  user(SP4, "sp4-u1", null, 0, "sp4-1", "Schedule the report"),
  asst(SP4, "sp4-a1", "sp4-u1", 1, "msg_sp4a", [text("Use a queue.")]),
  title(SP4, "Report"),
]);
write(`${SPL}/${SB4}.jsonl`, [
  user(SB4, "sb4-u1", null, 0, "sp4-1", "Schedule the report"),
  asst(SB4, "sb4-a1", "sb4-u1", 1, "msg_sp4a", [text("Use a queue.")]),
  asst(SB4, "sb4-a1b", "sb4-u1", 5, "msg_sb4r", [text("Use a cron job.")]),
  title(SB4, "Report (fork)"),
]);
write(`${SPL}/${SF4}.jsonl`, [
  user(SF4, "sf4-u1", null, 0, "sp4-1", "Schedule the report"),
  asst(SF4, "sf4-a1b", "sf4-u1", 5, "msg_sb4r", [text("Use a cron job.")]),
  title(SF4, "Report (fork) (fork)"),
  user(SF4, "sf4-u2", "sf4-a1b", 10, "sf4-2", "Nightly"),
  asst(SF4, "sf4-a2", "sf4-u2", 11, "msg_sf4", [text("Cron at 2am.")]),
]);

// ------------------------------------------------------------------ Codex
//
// CODEX_HOME holding one family of paginated pages:
//   T1   root thread: turns A, B (plain .jsonl)
//   T1_E prompt-edit page of T1, cut before B: turn B' (.jsonl.zst)
//   T3   archived thread forked from T1 after A: turn C
//   T2   live thread forked from T3 after C: turn D with a steering message
// plus a guardian-review thread (hidden), a page whose base is gone, a
// session_index naming T1, a copied-prefix fork in the item vocabulary, a
// turn only a fork still holds, an unparseable page, and a legacy
// (pre-paginated) rollout with a copy-prefix fork.

const CODEX = "codex/0.162/home";
const T1 = "01900000-0000-7000-8000-000000000001";
const T1_E = "01900000-0000-7000-8000-0000000000e1";
const T2 = "01900000-0000-7000-8000-000000000002";
const T3 = "01900000-0000-7000-8000-000000000003";
const G = "01900000-0000-7000-8000-000000000009";
const T4 = "01900000-0000-7000-8000-000000000004";
const turn = (n) => `01900000-0000-7000-8000-0000000a${String(n).padStart(4, "0")}`;
const CX_CWD = "C:\\work\\codex-demo";

const meta = (id, extra = {}) => ({
  timestamp: ts(0),
  type: "session_meta",
  payload: {
    session_id: id,
    id,
    timestamp: ts(0),
    cwd: CX_CWD,
    originator: "codex_vscode",
    cli_version: "0.162.1",
    source: "vscode",
    thread_source: "user",
    model_provider: "openai",
    history_mode: "paginated",
    base_instructions: { text: "x".repeat(2000) },
    ...extra,
  },
});

/** One turn's records, starting at ordinal `o`. Returns [records, nextOrdinal]. */
function cxTurn(thread, tid, o, min, prompt, replies, { steer, ide, earlyUsage } = {}) {
  const r = [];
  const at = (rec) => r.push({ timestamp: ts(min), ordinal: o++, ...rec });
  const item = (item) => at({ type: "event_msg", payload: { type: "item_completed", thread_id: thread, turn_id: tid, item } });
  at({ type: "event_msg", payload: { type: "task_started", turn_id: tid, root_turn_id: tid, turn_attribution: { turn_id: tid, turn_trigger: "composer" } } });
  at({ type: "turn_context", payload: { model: "gpt-6.1-sol" } });
  item({
    type: "UserMessage",
    id: "item-1",
    content: [{ type: "text", text: ide ? `# Context from my IDE setup:\n\n## Open tabs:\n- notes.md: notes.md\n\n## My request:\n${prompt}` : prompt, text_elements: [] }],
  });
  item({ type: "Reasoning", id: "rs_1", summary_text: ["Thinking it over."], raw_content: [] });
  if (earlyUsage) {
    // A tool-only response reports its usage before any prose exists.
    at({ type: "token_usage_record", payload: { thread_id: thread, turn_id: tid, usage: { input_tokens: 500, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 5 } } });
  }
  item({ type: "AgentMessage", id: "item-2", content: [{ type: "Text", text: replies[0] }], phase: "commentary" });
  item({ type: "CommandExecution", id: "exec-1", command: ["pwsh", "-c", "ls"], status: "completed" });
  if (steer) {
    item({ type: "UserMessage", id: "item-3", content: [{ type: "text", text: steer, text_elements: [] }] });
  }
  item({ type: "AgentMessage", id: "item-4", content: [{ type: "Text", text: replies[1] }], phase: "final_answer" });
  at({ type: "token_usage_record", payload: { thread_id: thread, turn_id: tid, usage: { input_tokens: 1000, cached_input_tokens: 800, cache_write_input_tokens: 0, output_tokens: 50 } } });
  at({ type: "event_msg", payload: { type: "task_complete", turn_id: tid } });
  return [r, o];
}

let o = 1;
let a, b, c, d, e;
[a, o] = cxTurn(T1, turn(1), o, 1, "What is X?", ["Looking.", "X is Y."], { ide: true });
const cutAfterA = o; // ordinal where turn B starts
[b, o] = cxTurn(T1, turn(2), o, 2, "Explain more", ["Reading.", "More detail."]);
write(`${CODEX}/sessions/2026/10/01/rollout-2026-10-01T10-00-00-${T1}.jsonl`, [meta(T1), ...a, ...b]);

let oe = o;
[e, oe] = cxTurn(T1, turn(3), oe, 3, "Explain differently", ["Rethinking.", "Different detail."]);
write(
  `${CODEX}/sessions/2026/10/01/rollout-2026-10-01T10-05-00-${T1}_${T1_E}.jsonl.zst`,
  [meta(T1, { history_base: { thread_id: T1, end_ordinal_exclusive: cutAfterA } }), ...e],
  { zst: true },
);

let o3 = cutAfterA;
[c, o3] = cxTurn(T3, turn(4), o3, 4, "Fork question", ["Forking.", "Fork answer."]);
write(`${CODEX}/archived_sessions/rollout-2026-10-01T10-10-00-${T3}.jsonl`, [
  meta(T3, { forked_from_id: T1, forked_from_ordinal_exclusive: cutAfterA, history_base: { thread_id: T1, end_ordinal_exclusive: cutAfterA } }),
  ...c,
]);

let o2 = o3;
[d, o2] = cxTurn(T2, turn(5), o2, 5, "Grandchild", ["On it.", "Grandchild answer."], { steer: "also this" });
write(`${CODEX}/sessions/2026/10/02/rollout-2026-10-02T09-00-00-${T2}.jsonl`, [
  meta(T2, { forked_from_id: T3, forked_from_ordinal_exclusive: o3, history_base: { thread_id: T3, end_ordinal_exclusive: o3 } }),
  ...d,
]);

const [g] = cxTurn(G, turn(9), 1, 6, "Review this command", ["Reviewing.", "Approved."]);
write(`${CODEX}/sessions/2026/10/02/rollout-2026-10-02T09-30-00-${G}.jsonl`, [
  meta(G, { thread_source: "guardian_review", source: { subagent: { other: "guardian" } } }),
  ...g,
]);

const [t4] = cxTurn(T4, turn(6), 50, 7, "Orphaned continuation", ["Hm.", "Base is gone."]);
write(`${CODEX}/sessions/2026/10/03/rollout-2026-10-03T09-00-00-${T4}.jsonl`, [
  meta(T4, { history_base: { thread_id: "01900000-0000-7000-8000-00000000dead", end_ordinal_exclusive: 50 } }),
  ...t4,
]);

fs.writeFileSync(
  path.join(ROOT, CODEX, "session_index.jsonl"),
  jsonl([
    { id: T1, thread_name: "Old name", updated_at: ts(1) },
    { id: T1, thread_name: "X investigation", updated_at: ts(2) },
  ]),
);

// Copied-prefix fork in the ITEM vocabulary (codex 0.153–0.162): T6 has
// forked_from_id T5 and NO history_base, and carries T5's first turn verbatim
// — same turn id, same item ids — before its own.
const T5 = "01900000-0000-7000-8000-000000000005";
const T6 = "01900000-0000-7000-8000-000000000006";
let o5 = 1, p1, p2, own6;
[p1, o5] = cxTurn(T5, turn(7), o5, 10, "Copy me", ["Copying.", "Copied answer."]);
const cutT5 = o5;
[p2, o5] = cxTurn(T5, turn(8), o5, 11, "Parent goes on", ["Going.", "Parent answer."], { earlyUsage: true });
write(`${CODEX}/sessions/2026/10/04/rollout-2026-10-04T10-00-00-${T5}.jsonl`, [meta(T5), ...p1, ...p2]);
[own6] = cxTurn(T6, turn(10), cutT5, 12, "Copy goes elsewhere", ["Elsewhere.", "Copy answer."]);
write(`${CODEX}/sessions/2026/10/04/rollout-2026-10-04T10-30-00-${T6}.jsonl`, [
  meta(T6, { forked_from_id: T5, forked_from_ordinal_exclusive: cutT5 }),
  ...p1,
  ...own6,
]);

// A turn only a FORK still holds: T8 has X1, X2; T9 forks it after X2 (by
// reference); then a prompt edit in T8 replaces X2. Forking at X2 must go
// through T9.
const T8 = "01900000-0000-7000-8000-000000000008";
const T8_E = "01900000-0000-7000-8000-0000000000e8";
const T9 = "01900000-0000-7000-8000-00000000000a";
let o8 = 1, x1, x2, x3, x2e;
[x1, o8] = cxTurn(T8, turn(11), o8, 20, "X one", ["One.", "X1 answer."]);
const beforeX2 = o8;
[x2, o8] = cxTurn(T8, turn(12), o8, 21, "X two", ["Two.", "X2 answer."]);
write(`${CODEX}/sessions/2026/10/05/rollout-2026-10-05T10-00-00-${T8}.jsonl`, [meta(T8), ...x1, ...x2]);
[x3] = cxTurn(T9, turn(13), o8, 22, "X three in fork", ["Three.", "X3 answer."]);
write(`${CODEX}/sessions/2026/10/05/rollout-2026-10-05T10-10-00-${T9}.jsonl`, [
  meta(T9, { forked_from_id: T8, forked_from_ordinal_exclusive: o8, history_base: { thread_id: T8, end_ordinal_exclusive: o8 } }),
  ...x3,
]);
[x2e] = cxTurn(T8, turn(14), o8 + 100, 23, "X two, edited", ["Two again.", "X2 edited answer."]);
write(`${CODEX}/sessions/2026/10/05/rollout-2026-10-05T10-20-00-${T8}_${T8_E}.jsonl`, [
  meta(T8, { history_base: { thread_id: T8, end_ordinal_exclusive: beforeX2 } }),
  ...x2e,
]);

// A page whose turn records use an item vocabulary nobody taught the parser:
// it must count as a failure, not as a quietly empty session.
const T7 = "01900000-0000-7000-8000-000000000007";
write(`${CODEX}/sessions/2026/10/06/rollout-2026-10-06T10-00-00-${T7}.jsonl`, [
  meta(T7),
  { timestamp: ts(30), ordinal: 1, type: "event_msg", payload: { type: "item_completed", turn_id: turn(15), item: { type: "UserMessageV2", id: "item-1", parts: [{ text: "hello" }] } } },
]);

// An aborted prompt (no reply at all), then the replacement turn. The two
// user messages are adjacent and belong to DIFFERENT turns; folding them
// into one node would make "fork after this" cut before the replacement.
const T11 = "01900000-0000-7000-8000-00000000000b";
{
  let o = 1;
  const r = [];
  const at = (min, rec) => r.push({ timestamp: ts(min), ordinal: o++, ...rec });
  const tid = turn(16);
  at(40, { type: "event_msg", payload: { type: "task_started", turn_id: tid } });
  at(40, { type: "event_msg", payload: { type: "item_completed", thread_id: T11, turn_id: tid, item: { type: "UserMessage", id: "item-1", content: [{ type: "text", text: "Cancelled prompt", text_elements: [] }] } } });
  at(40, { type: "event_msg", payload: { type: "turn_aborted", turn_id: tid, reason: "interrupted" } });
  const [rest] = cxTurn(T11, turn(17), o, 41, "Replacement prompt", ["Working.", "Replacement answer."]);
  write(`${CODEX}/sessions/2026/10/07/rollout-2026-10-07T10-00-00-${T11}.jsonl`, [meta(T11), ...r, ...rest]);
}

// A thread the extension merely LOADED hours after its last turn: settings,
// usage, task and response_item records, no item. It is not recent activity.
const T12 = "01900000-0000-7000-8000-00000000000c";
{
  const [t12, o12] = cxTurn(T12, turn(18), 1, 50, "Old question", ["Checking.", "Old answer."]);
  let o = o12;
  const late = (rec) => ({ timestamp: ts(400), ordinal: o++, ...rec });
  write(`${CODEX}/sessions/2026/10/08/rollout-2026-10-08T10-00-00-${T12}.jsonl`, [
    meta(T12),
    ...t12,
    late({ type: "event_msg", payload: { type: "thread_settings_applied", turn_id: turn(19) } }),
    late({ type: "event_msg", payload: { type: "task_started", turn_id: turn(19) } }),
    late({ type: "response_item", payload: { type: "message", role: "developer", content: [] } }),
    late({ type: "event_msg", payload: { type: "token_count", info: null } }),
    late({ type: "token_usage_record", payload: { turn_id: turn(19), usage: { input_tokens: 9, output_tokens: 1 } } }),
    late({ type: "event_msg", payload: { type: "task_complete", turn_id: turn(19) } }),
  ]);
  // A fork of it nobody has spoken in: created at 11:10, then reloaded much
  // later (a settings record, nothing else). It must not float the family up.
  const T14 = "01900000-0000-7000-8000-00000000000e";
  write(`${CODEX}/sessions/2026/10/08/rollout-2026-10-08T11-10-00-${T14}.jsonl`, [
    { ...meta(T14, { forked_from_id: T12, history_base: { thread_id: T12, end_ordinal_exclusive: o12 } }), timestamp: ts(70) },
    { timestamp: ts(70), ordinal: o12 + 100, type: "event_msg", payload: { type: "thread_settings_applied" } },
    { timestamp: ts(500), ordinal: o12 + 101, type: "event_msg", payload: { type: "thread_settings_applied" } },
  ]);
}

// A thread the user archived, with no live fork: hidden from the list unless
// the settings ask for archived conversations.
const T13 = "01900000-0000-7000-8000-00000000000d";
{
  const [t13] = cxTurn(T13, turn(20), 1, 60, "Archived question", ["Looking.", "Archived answer."]);
  write(`${CODEX}/archived_sessions/rollout-2026-10-09T10-00-00-${T13}.jsonl`, [meta(T13), ...t13]);
}

// Legacy (pre-paginated) rollout and a copy-prefix fork of it.
const L = "01800000-0000-7000-8000-000000000001";
const L2 = "01800000-0000-7000-8000-000000000002";
const legacyMeta = (id, extra = {}) => ({ timestamp: ts(0), type: "session_meta", payload: { id, cwd: CX_CWD, cli_version: "0.145.0", ...extra } });
const ev = (type, message, min) => ({ timestamp: ts(min), type: "event_msg", payload: { type, message } });
const legacyPrefix = [ev("user_message", "Legacy hello", 1), ev("agent_message", "Legacy hi.", 2)];
write(`${CODEX}/sessions/2026/07/01/rollout-2026-07-01T10-00-00-${L}.jsonl`, [
  legacyMeta(L),
  ...legacyPrefix,
  ev("user_message", "Legacy parent continues", 3),
  ev("agent_message", "Parent reply.", 4),
]);
write(`${CODEX}/sessions/2026/07/01/rollout-2026-07-01T11-00-00-${L2}.jsonl`, [
  legacyMeta(L2, { forked_from_id: L }),
  ...legacyPrefix,
  ev("user_message", "Legacy fork continues", 5),
  ev("agent_message", "Fork reply.", 6),
]);

// Observed shape (VS Code, 0.164 alpha): a legacy-mode rollout whose prose is
// legacy events, plus ONE completed item — an Extension call. The item must
// not switch the page to the item vocabulary and lose every message.
const LX = "01800000-0000-7000-8000-000000000003";
write(`${CODEX}/sessions/2026/07/02/rollout-2026-07-02T10-00-00-${LX}.jsonl`, [
  legacyMeta(LX, { cli_version: "0.164.0-alpha.11.1", source: "vscode", originator: "codex_vscode", history_mode: "legacy" }),
  ev("user_message", "Mixed question", 1),
  {
    timestamp: ts(2),
    type: "event_msg",
    payload: { type: "item_completed", turn_id: turn(30), item: { type: "Extension", id: "ext-1", kind: "open_file" } },
  },
  ev("agent_message", "Mixed answer.", 3),
  ev("user_message", "Mixed follow-up", 4),
  ev("agent_message", "Mixed second answer.", 5),
]);

console.log("fixtures written under", ROOT);
