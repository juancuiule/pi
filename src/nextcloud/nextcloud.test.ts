import type { FauxResponseStep } from "@earendil-works/pi-ai";
// The Nextcloud connector over a fake Nextcloud: connecting (an app password, a regular password exchanged for one,
// Login Flow v2), disconnecting (revoked at Nextcloud), and the `nextcloud` extension through fauxAgents — tools
// signed as the conversation's owner, reads running under `ask` while writes wait for approval, and the prompt
// section saying whether the person connected.
import type { AgentEvent } from "@earendil-works/pi-durable";
import { Effect, Ref, Scope, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { Agents } from "../agents/agents.ts";
import { Connectors } from "../connectors/connectors.ts";
import {
  callTool,
  echoToolResult,
  fauxAgents,
  offered,
  offeredIn,
  openSeat,
} from "../testing/faux.ts";
import { fakeNextcloud } from "../testing/nextcloud.ts";
import { alice, bob } from "../testing/users.ts";
import { nextcloudConnector } from "./nextcloud.ts";

const setup = (responses: FauxResponseStep[]) => {
  const nc = fakeNextcloud([
    { login: "alice", password: "alice-pw", displayName: "Alice A." },
    { login: "bob", password: "bob-pw" },
  ]);
  const connector = nextcloudConnector({ url: nc.url, fetch: nc.fetch });
  const { layer } = fauxAgents(responses, {
    connectors: Connectors.temporary([connector]),
  });
  return { nc, layer };
};

const run = <A, E>(
  layer: ReturnType<typeof setup>["layer"],
  effect: Effect.Effect<A, E, Agents | Connectors | Scope.Scope>
) => Effect.runPromise(Effect.scoped(effect).pipe(Effect.provide(layer)));

const waitUntil = (check: Effect.Effect<boolean, unknown>, timeoutMs = 8000) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < timeoutMs / 10; attempt += 1) {
      if (yield* check) {
        return;
      }
      yield* Effect.sleep("10 millis");
    }
    return yield* Effect.die(new Error("timed out waiting"));
  });

const pendingKey = (ref: Ref.Ref<AgentEvent[]>) =>
  Ref.get(ref).pipe(
    Effect.map((all) => {
      const update = all.find(
        (event) =>
          event.type === "tool_execution_update" &&
          typeof event.details === "object" &&
          event.details !== null &&
          (event.details as { approval?: string }).approval === "pending"
      );
      return update?.type === "tool_execution_update"
        ? (update.details as { approvalKey?: string }).approvalKey
        : undefined;
    })
  );

describe("connecting Nextcloud", () => {
  it("keeps an app password as given and lists the account, never the secret", async () => {
    const { nc, layer } = setup([]);
    const appPassword = nc.appPassword("alice");
    const listed = await run(
      layer,
      Effect.gen(function* () {
        const connectors = yield* Connectors;
        yield* connectors.connect(alice.id, "nextcloud", {
          login: "alice",
          password: appPassword,
        });
        return yield* connectors.list(alice.id);
      })
    );
    expect(listed[0]?.connection?.account).toStrictEqual({
      id: "alice",
      login: "alice",
      displayName: "Alice A.",
    });
    expect(JSON.stringify(listed)).not.toContain(appPassword);
    // An app password is not exchanged again: Nextcloud refuses getapppassword for one.
    expect(nc.user("alice").appPasswords.size).toBe(1);
  });

  it("exchanges a regular password for an app password and never stores the password", async () => {
    const { nc, layer } = setup([]);
    await run(
      layer,
      Effect.gen(function* () {
        const connectors = yield* Connectors;
        yield* connectors.connect(alice.id, "nextcloud", {
          login: "alice",
          password: "alice-pw",
        });
      })
    );
    expect(nc.user("alice").appPasswords.size).toBe(1);
  });

  it("refuses wrong credentials and unknown connectors", async () => {
    const { layer } = setup([]);
    const [wrong, unknown] = await run(
      layer,
      Effect.gen(function* () {
        const connectors = yield* Connectors;
        const refused = yield* Effect.flip(
          connectors.connect(alice.id, "nextcloud", {
            login: "alice",
            password: "nope",
          })
        );
        const missing = yield* Effect.flip(
          connectors.connect(alice.id, "slack", {
            login: "a",
            password: "b",
          })
        );
        return [refused, missing] as const;
      })
    );
    expect(wrong._tag).toBe("ConnectorRefused");
    expect(wrong._tag === "ConnectorRefused" && wrong.message).toContain(
      "refused"
    );
    expect(unknown._tag).toBe("ConnectorNotFound");
  });

  it("connects through Login Flow v2 once the person grants access", async () => {
    const { nc, layer } = setup([]);
    const outcome = await run(
      layer,
      Effect.gen(function* () {
        const connectors = yield* Connectors;
        const started = yield* connectors.startLogin(alice.id, "nextcloud");
        const before = yield* connectors.pollLogin(alice.id, "nextcloud");
        nc.grant("alice");
        const after = yield* connectors.pollLogin(alice.id, "nextcloud");
        const again = yield* Effect.flip(
          connectors.pollLogin(alice.id, "nextcloud")
        );
        return { started, before, after, again };
      })
    );
    expect(outcome.started.loginUrl).toContain("/login/v2/flow/");
    expect(outcome.before.status).toBe("pending");
    expect(
      outcome.after.status === "connected" &&
        outcome.after.connector.connection?.account.login
    ).toBe("alice");
    // The flow is finished: polling again is refused instead of reconnecting.
    expect(outcome.again._tag).toBe("ConnectorRefused");
  });

  it("revokes the app password at Nextcloud on disconnect", async () => {
    const { nc, layer } = setup([]);
    const listed = await run(
      layer,
      Effect.gen(function* () {
        const connectors = yield* Connectors;
        yield* connectors.connect(alice.id, "nextcloud", {
          login: "alice",
          password: "alice-pw",
        });
        yield* connectors.disconnect(alice.id, "nextcloud");
        // Idempotent.
        yield* connectors.disconnect(alice.id, "nextcloud");
        return yield* connectors.list(alice.id);
      })
    );
    expect(listed[0]?.connection).toBeUndefined();
    expect(nc.user("alice").appPasswords.size).toBe(0);
  });
});

describe("the nextcloud extension", () => {
  it("signs every call as the conversation's owner", async () => {
    const { nc, layer } = setup([
      callTool("nextcloud_files_list", { path: "/" }),
      echoToolResult,
      callTool("nextcloud_files_list", { path: "/" }),
      echoToolResult,
    ]);
    nc.user("alice").files.set("Notes.md", "# hi");
    nc.user("bob").files.set("Bob.md", "secret");
    const [own, other] = await run(
      layer,
      Effect.gen(function* () {
        const connectors = yield* Connectors;
        yield* connectors.connect(alice.id, "nextcloud", {
          login: "alice",
          password: "alice-pw",
        });
        const mine = yield* openSeat();
        const first = yield* mine.ask("list my files");
        // Bob never connected: his conversation cannot reach anyone's Nextcloud.
        const agents = yield* Agents;
        const id = yield* agents.create({
          owner: bob.id,
          prompt: "",
          title: "",
          level: "none",
          createdAt: Date.now(),
        });
        const his = yield* agents.open(id);
        const second = yield* his.ask("list my files");
        return [first, second] as const;
      })
    );
    const dav = nc.requests.filter((r) => r.path.startsWith("/remote.php"));
    expect({
      ownNotes: own.includes("/Notes.md"),
      ownSeesBob: own.includes("Bob.md"),
      otherFailed: other.includes("error:"),
      otherToldToConnect: other.includes("Settings → Connections"),
      davRequests: dav.length > 0,
      allSignedAsAlice: dav.every((r) => r.as === "alice"),
    }).toStrictEqual({
      ownNotes: true,
      ownSeesBob: false,
      otherFailed: true,
      otherToldToConnect: true,
      davRequests: true,
      allSignedAsAlice: true,
    });
  });

  it("runs reads under ask, and holds writes until the person approves", async () => {
    const { nc, layer } = setup([
      callTool("nextcloud_files_read", { path: "/Notes.md" }),
      callTool("nextcloud_files_write", {
        path: "/Summary.md",
        content: "done",
      }),
      echoToolResult,
    ]);
    nc.user("alice").files.set("Notes.md", "# notes");
    await run(
      layer,
      Effect.gen(function* () {
        const connectors = yield* Connectors;
        yield* connectors.connect(alice.id, "nextcloud", {
          login: "alice",
          password: "alice-pw",
        });
        const agents = yield* Agents;
        const conversation = yield* openSeat({ approvals: "ask" });
        const ref = yield* Ref.make<AgentEvent[]>([]);
        const events = yield* agents.events(conversation.id);
        const scope = yield* Scope.Scope;
        yield* Stream.runForEach(events, (event) =>
          Ref.update(ref, (all) => [...all, event])
        ).pipe(Effect.forkIn(scope));
        yield* conversation.send("summarize my notes");
        yield* waitUntil(
          conversation.pendingApprovals.pipe(Effect.map((n) => n === 1))
        );
        // The read ran without a decision; the write has not run yet.
        expect(
          nc.requests.some(
            (r) => r.method === "GET" && r.path.endsWith("/Notes.md")
          )
        ).toBeTruthy();
        expect(nc.user("alice").files.has("Summary.md")).toBeFalsy();
        yield* waitUntil(
          pendingKey(ref).pipe(Effect.map((key) => key !== undefined))
        );
        const key = yield* pendingKey(ref);
        yield* conversation.decide(key as string, "approve");
        yield* waitUntil(
          Ref.get(ref).pipe(
            Effect.map((all) => all.some((event) => event.type === "run_end"))
          )
        );
      })
    );
    expect(nc.user("alice").files.get("Summary.md")).toBe("done");
  });

  it("creates and lists events, and finds contacts", async () => {
    const { nc, layer } = setup([
      callTool("nextcloud_event_create", {
        calendar: "personal",
        summary: "Dentist",
        start: "2026-11-05T10:00:00-03:00",
        end: "2026-11-05T11:00:00-03:00",
      }),
      callTool("nextcloud_events_list", {
        from: "2026-11-01",
        to: "2026-11-30",
      }),
      echoToolResult,
      callTool("nextcloud_contact_create", {
        name: "Ada Lovelace",
        emails: ["ada@example.com"],
      }),
      callTool("nextcloud_contacts_search", { query: "ada" }),
      echoToolResult,
    ]);
    const [events, contacts] = await run(
      layer,
      Effect.gen(function* () {
        const connectors = yield* Connectors;
        yield* connectors.connect(alice.id, "nextcloud", {
          login: "alice",
          password: "alice-pw",
        });
        const seat = yield* openSeat();
        return [
          yield* seat.ask("book the dentist"),
          yield* seat.ask("add Ada"),
        ] as const;
      })
    );
    expect(events).toContain("Dentist");
    expect(events).toContain("2026-11-05T13:00:00Z");
    expect(nc.user("alice").events.size).toBe(1);
    expect(contacts).toContain("Ada Lovelace");
    expect(contacts).toContain("ada@example.com");
  });

  it("tells the model whether the person connected, and offers the tools at every Level", async () => {
    const { layer } = setup([offered, offered]);
    const [before, after] = await run(
      layer,
      Effect.gen(function* () {
        const seat = yield* openSeat();
        const first = offeredIn(yield* seat.ask("what can you do?"));
        const connectors = yield* Connectors;
        yield* connectors.connect(alice.id, "nextcloud", {
          login: "alice",
          password: "alice-pw",
        });
        const second = offeredIn(yield* seat.ask("and now?"));
        return [first, second] as const;
      })
    );
    expect(before.tools).toContain("nextcloud_files_list");
    expect(before.tools).toContain("nextcloud_share_create");
    expect(before.system).toContain("has not connected");
    expect(after.system).toContain("signed in as Alice A. (alice)");
  });
});
