import { describe, expect, it } from "vitest";
import { codexProblems, contractResult, latestStable, releaseRow, verdict } from "../scripts/upstream/check.mjs";
import baseline from "../scripts/upstream/baseline.json";

// The watch's judgements on controlled inputs: a schema that wouldn't take
// what Agentree sends must be reported, and a lookup that failed must never
// read as "nothing new".

/** The shape `codex app-server generate-json-schema` writes (checked on 0.162), reduced to what Agentree touches. */
function schemas() {
  const string = { type: "string" };
  return {
    request: {
      definitions: {
        RequestId: { anyOf: [string, { format: "int64", type: "integer" }] },
        ClientInfo: {
          type: "object",
          properties: { name: string, title: { type: ["string", "null"] }, version: string },
          required: ["name", "version"],
        },
        InitializeParams: {
          type: "object",
          properties: { clientInfo: { $ref: "#/definitions/ClientInfo" } },
          required: ["clientInfo"],
        },
        ThreadForkParams: {
          type: "object",
          properties: {
            threadId: string,
            lastTurnId: { type: ["string", "null"] },
            excludeTurns: { type: "boolean" },
            path: { type: ["string", "null"] },
          } as Record<string, object>,
          required: ["threadId"],
        },
      },
      oneOf: [
        ["initialize", "InitializeParams"],
        ["thread/fork", "ThreadForkParams"],
      ].map(([method, params]) => ({
        type: "object",
        properties: {
          id: { $ref: "#/definitions/RequestId" },
          method: { enum: [method], type: "string" },
          params: { $ref: `#/definitions/${params}` },
        },
        required: ["id", "method", "params"],
      })),
    },
    notification: {
      oneOf: [{ type: "object", properties: { method: { enum: ["initialized"], type: "string" } }, required: ["method"] }],
    },
    forkResponse: {
      definitions: {
        Path: string,
        Thread: {
          type: "object",
          properties: {
            id: string,
            cwd: { allOf: [{ $ref: "#/definitions/Path" }] },
            turns: { type: "array" },
          } as Record<string, object>,
          required: ["id", "cwd", "turns"],
        },
      },
      type: "object",
      properties: {
        thread: { $ref: "#/definitions/Thread" },
        cwd: { $ref: "#/definitions/Path" },
        model: string,
      } as Record<string, object>,
      required: ["cwd", "model", "thread"],
    },
  };
}
const check = (change: (s: ReturnType<typeof schemas>) => void = () => {}) => {
  const s = schemas();
  change(s);
  return codexProblems(s, baseline.codex);
};
const defs = (s: ReturnType<typeof schemas>) => s.request.definitions;

describe("the Codex contract", () => {
  it("takes the messages Agentree sends", () => {
    expect(check()).toEqual([]);
  });

  it("reports a new required initialize parameter", () => {
    const problems = check((s) => defs(s).InitializeParams.required.push("sessionKey"));
    expect(problems.join()).toMatch(/initialize.*sessionKey/);
  });

  it("reports a new required clientInfo field", () => {
    expect(check((s) => defs(s).ClientInfo.required.push("vendor")).join()).toMatch(/initialize.*vendor/);
  });

  it("reports a parameter whose type changed", () => {
    const problems = check((s) => {
      defs(s).ThreadForkParams.properties.excludeTurns = { type: "string" };
    });
    expect(problems.join()).toMatch(/thread\/fork.*excludeTurns.*string/);
  });

  it("reports a new required fork parameter", () => {
    expect(check((s) => defs(s).ThreadForkParams.required.push("cwd")).join()).toMatch(/thread\/fork.*cwd/);
  });

  it("reports a parameter Codex no longer takes, though generated objects stay open", () => {
    const problems = check((s) => {
      delete defs(s).ThreadForkParams.properties.lastTurnId;
    });
    expect(problems.join()).toMatch(/thread\/fork.*lastTurnId/);
  });

  it("reports a method or notification that left the stable schema", () => {
    expect(check((s) => s.request.oneOf.pop()).join()).toMatch(/no `thread\/fork`/);
    expect(check((s) => s.notification.oneOf.pop()).join()).toMatch(/no `initialized`/);
  });

  it("reports a dropped parameter however the object says it's open", () => {
    for (const open of [true, { type: "string" }]) {
      const problems = check((s) => {
        delete defs(s).ThreadForkParams.properties.lastTurnId;
        Object.assign(defs(s).ThreadForkParams, { additionalProperties: open });
      });
      expect(problems.join()).toMatch(/thread\/fork.*lastTurnId/);
    }
  });

  const res = (s: ReturnType<typeof schemas>) => s.forkResponse;
  const thread = (s: ReturnType<typeof schemas>) => s.forkResponse.definitions.Thread;
  const without = (list: string[], name: string) => list.filter((r) => r !== name);

  it("reports a thread or id the response dropped", () => {
    expect(check((s) => delete res(s).properties.thread).join()).toMatch(/additional properties: `thread`/);
    expect(check((s) => delete thread(s).properties.id).join()).toMatch(/additional properties: `id`/);
  });

  it("reports a thread or id the response no longer promises", () => {
    expect(check((s) => (res(s).required = without(res(s).required, "thread"))).join()).toMatch(/no longer promises `thread`/);
    expect(check((s) => (thread(s).required = without(thread(s).required, "id"))).join()).toMatch(/no longer promises `thread\.id`/);
  });

  it("follows the response's references, not a definition left unused", () => {
    expect(check((s) => (res(s).properties.thread = { type: "string" })).join()).toMatch(/\/thread must be string/);
  });

  it("reports a response field that can be a type the client can't use", () => {
    const allows = (field: string, type: string) => new RegExp(`allows \`${field.replace(".", "\\.")}\` to be ${type}`);
    const id = (s: ReturnType<typeof schemas>, schema: object) => (thread(s).properties.id = schema);

    expect(check((s) => id(s, { type: "integer" })).join()).toMatch(/\/thread\/id must be integer/);
    expect(check((s) => id(s, { type: ["string", "integer"] })).join()).toMatch(allows("thread.id", "integer"));
    expect(check((s) => id(s, { anyOf: [{ type: "string" }, { type: "null" }] })).join()).toMatch(allows("thread.id", "null"));
    expect(check((s) => id(s, {})).join()).toMatch(allows("thread.id", "object"));

    expect(check((s) => (thread(s).type = ["object", "null"] as unknown as string)).join()).toMatch(allows("thread", "null"));
    const nullable = { anyOf: [{ $ref: "#/definitions/Thread" }, { type: "null" }] };
    expect(check((s) => (res(s).properties.thread = nullable)).join()).toMatch(allows("thread", "null"));

    expect(check((s) => (res(s).properties.cwd = { type: ["string", "integer"] })).join()).toMatch(allows("cwd", "integer"));
    expect(check((s) => (s.forkResponse.definitions.Path = { type: "object" })).join()).toMatch(allows("cwd", "object"));
    expect(check((s) => (thread(s).properties.cwd = { type: "boolean" })).join()).toMatch(allows("thread.cwd", "boolean"));
  });

  it("isn't troubled by a cwd that went or became optional, or is null: the client falls back", () => {
    const dropTop = (s: ReturnType<typeof schemas>) => {
      delete res(s).properties.cwd;
      res(s).required = without(res(s).required, "cwd");
    };
    const dropThread = (s: ReturnType<typeof schemas>) => {
      delete thread(s).properties.cwd;
      thread(s).required = without(thread(s).required, "cwd");
    };
    expect(check(dropTop)).toEqual([]);
    expect(check(dropThread)).toEqual([]);
    expect(
      check((s) => {
        dropTop(s);
        dropThread(s);
      }),
    ).toEqual([]);
    expect(check((s) => (res(s).properties.cwd = { type: ["string", "null"] }))).toEqual([]);
  });

  it("sees a type whatever constraints narrow it, so no single value could stand for it", () => {
    const id = (schema: object) => (s: ReturnType<typeof schemas>) => {
      thread(s).properties.id = schema;
    };
    const cases: [(s: ReturnType<typeof schemas>) => void, string][] = [
      [id({ type: ["string", "integer"], minimum: 2 }), "integer"],
      [id({ type: ["string", "number"], multipleOf: 7 }), "number"],
      [id({ type: ["string", "array"], minItems: 1 }), "array"],
      [id({ type: ["string", "array"], items: { type: "string" }, minItems: 2 }), "array"],
      [id({ type: ["string", "object"], required: ["id"] }), "object"],
      [id({ type: ["string", "object"], minProperties: 1 }), "object"],
      [id({ type: ["string", "integer"], not: { const: 1 } }), "integer"],
      [id({ anyOf: [{ type: "string" }, { type: "integer", minimum: 2 }] }), "integer"],
      [id({ oneOf: [{ type: "string" }, { type: "integer", minimum: 2 }, { type: "integer", maximum: 1 }] }), "integer"],
      [
        (s) => {
          Object.assign(res(s).definitions, { Id: { type: ["string", "integer"], minimum: 2 } });
          thread(s).properties.id = { $ref: "#/definitions/Id" };
        },
        "integer",
      ],
    ];
    for (const [change, type] of cases) expect(check(change).join()).toContain(`allows \`thread.id\` to be ${type}`);

    expect(check((s) => (res(s).properties.thread = { anyOf: [{ $ref: "#/definitions/Thread" }, { type: "array", minItems: 1 }] })).join()).toContain("allows `thread` to be array");
    expect(check((s) => (res(s).properties.cwd = { type: ["string", "integer"], minimum: 2 })).join()).toContain("allows `cwd` to be integer");
  });

  it("isn't troubled by a constraint on a type the client can use", () => {
    const id = (schema: object) => (s: ReturnType<typeof schemas>) => {
      thread(s).properties.id = schema;
    };
    expect(check(id({ type: "string", minLength: 1 }))).toEqual([]);
    expect(check(id({ type: "string", format: "uuid" }))).toEqual([]);
    expect(check(id({ oneOf: [{ type: "string", maxLength: 3 }, { type: "string", minLength: 4 }] }))).toEqual([]);
  });

  it("isn't troubled by a wrapper that changes nothing Agentree relies on", () => {
    expect(check((s) => (res(s).properties.thread = { anyOf: [{ $ref: "#/definitions/Thread" }] }))).toEqual([]);
    expect(check((s) => (res(s).properties.thread = { allOf: [{ $ref: "#/definitions/Thread" }] }))).toEqual([]);
  });

  it("isn't troubled by required response fields Agentree doesn't read", () => {
    expect(check((s) => s.forkResponse.required.push("approvalPolicy"))).toEqual([]);
  });

  it("reports schemas it can't find instead of passing", () => {
    expect(codexProblems({ request: null, notification: null, forkResponse: null }, baseline.codex)).toHaveLength(1);
  });
});

describe("a Marketplace extension's latest stable version", () => {
  const version = (v: string, pre: boolean) => ({
    version: v,
    lastUpdated: "2026-10-23T22:04:18Z",
    properties: pre ? [{ key: "Microsoft.VisualStudio.Code.PreRelease", value: "true" }] : [{ key: "Microsoft.VisualStudio.Code.Engine", value: "^1.101.0" }],
  });

  it("passes over a prerelease, however it's numbered", () => {
    const e = { versions: [version("26.51021.22027", true), version("26.1021.22027", false), version("26.1007.21434", false)] };
    expect(latestStable(e)).toEqual({ latest: "26.1021.22027", published: "2026-10-23T22:04:18Z" });
  });

  it("never reports a prerelease as stable", () => {
    expect(latestStable({ versions: [version("26.51021.22027", true)] })).toBeNull();
  });
});

describe("the watch's outcome", () => {
  const info = { reviewed: "1.0.0" };
  const clean = { evidence: "", problems: [], notes: [] };

  it("doesn't pass a failed lookup off as nothing new", async () => {
    const row = await releaseRow("pkg", info, async () => {
      throw new Error("npm registry 503");
    });
    expect(row).toMatchObject({ state: "unknown", error: "npm registry 503" });
    expect(verdict([row], [clean])).toEqual({ attention: true, broken: false, incomplete: true, exitCode: 1 });
  });

  it("keeps a check that couldn't run apart from a break", () => {
    const skipped = { ...clean, unknown: ["npm exec failed"] };
    expect(verdict([], [skipped])).toEqual({ attention: true, broken: false, incomplete: true, exitCode: 1 });
    expect(verdict([], [{ ...clean, problems: ["gone"] }])).toEqual({ attention: true, broken: true, incomplete: false, exitCode: 1 });
  });

  it("runs no contract without a version, and reports that as undetermined", async () => {
    let checked = false;
    const r = await contractResult(
      async () => {
        throw new Error("npm registry 503 for @anthropic-ai/claude-agent-sdk");
      },
      () => {
        checked = true;
        return clean;
      },
    );
    expect(checked).toBe(false);
    expect(r.unknown).toEqual(["npm registry 503 for @anthropic-ai/claude-agent-sdk"]);
    expect(verdict([], [r])).toEqual({ attention: true, broken: false, incomplete: true, exitCode: 1 });
  });

  it("checks a contract at the version it resolved", async () => {
    const r = await contractResult(
      async () => "1.2.3",
      (version: string) => ({ ...clean, evidence: `pkg@${version}` }),
    );
    expect(r.evidence).toBe("pkg@1.2.3");
    expect(verdict([], [r]).exitCode).toBe(0);
  });

  it("asks for attention on new releases without failing the run", async () => {
    const row = await releaseRow("pkg", info, async () => ({ latest: "1.1.0", published: "2026-10-01", since: 1, isNew: true }));
    expect(verdict([row], [clean])).toEqual({ attention: true, broken: false, incomplete: false, exitCode: 0 });
  });

  it("stays quiet when all is current, and for a package nobody has reviewed yet", async () => {
    const current = await releaseRow("pkg", info, async () => ({ latest: "1.0.0", published: "2026-10-01", since: 0, isNew: false }));
    const untracked = await releaseRow("copilot", { reviewed: null }, async () => ({ latest: "1.0.0", published: "2026-10-01", since: null, isNew: false }));
    expect(verdict([current, untracked], [clean])).toEqual({ attention: false, broken: false, incomplete: false, exitCode: 0 });
  });
});
