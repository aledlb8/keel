import assert from "node:assert/strict";
import { beforeEach, it } from "node:test";
import { mockIPC } from "@tauri-apps/api/mocks";
import { useKeel } from "../state/store.ts";
import type { VpnSnapshot } from "./backend.ts";

const state = useKeel.getState;
const idle: VpnSnapshot = {
  phase: "idle", connectInstalled: true, openvpnPath: "openvpn.exe",
  profiles: [], profileId: "test", profileName: "Test VPN", adapter: null,
  tunnelIp: null, ifIndex: null, proxyPort: null, isolated: true, error: null,
};
const connected: VpnSnapshot = { ...idle, phase: "connected", proxyPort: 12345 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  Object.assign(globalThis, { window: {} });
  useKeel.setState(useKeel.getInitialState());
});

it("coalesces duplicate VPN connects and keeps startup gated until settled", async () => {
  const pending = deferred<VpnSnapshot>();
  let calls = 0;
  mockIPC(() => { calls++; return pending.promise; });
  const request = state().connectVpn("test");
  await state().connectVpn("test");
  assert.equal(calls, 1);
  assert.equal(state().vpn.spawnAllowed, false);
  pending.resolve(connected);
  await request;
  assert.equal(state().vpn.phase, "connected");
  assert.equal(state().vpn.spawnAllowed, true);
});

it("settles a failed connection and releases waiting terminals", async () => {
  mockIPC(() => Promise.reject("VPN service timed out"));
  await state().connectVpn("test");
  assert.equal(state().vpn.phase, "error");
  assert.equal(state().vpn.error, "VPN service timed out");
  assert.equal(state().vpn.spawnAllowed, true);
});

it("holds new terminals during a manual connect without restarting existing panes", async () => {
  const pending = deferred<VpnSnapshot>();
  mockIPC(() => pending.promise);
  useKeel.setState({ vpn: { ...state().vpn, spawnAllowed: true, phase: "idle" }, generations: { running: 2 } });
  const request = state().connectVpn("test");
  assert.equal(state().vpn.spawnAllowed, false);
  assert.deepEqual(state().generations, { running: 2 });
  pending.resolve(connected);
  await request;
  assert.equal(state().vpn.spawnAllowed, true);
  assert.deepEqual(state().generations, { running: 2 });
});

it("discovery cannot hide an active VPN connection attempt", async () => {
  const pending = deferred<VpnSnapshot>();
  mockIPC((cmd) => cmd === "vpn_connect" ? pending.promise : idle);
  const request = state().connectVpn("test");
  await state().refreshVpn();
  assert.equal(state().vpn.phase, "connecting");
  assert.equal(state().vpn.spawnAllowed, false);
  pending.resolve(connected);
  await request;
});

it("late discovery cannot overwrite the completed connection", async () => {
  const pending = deferred<VpnSnapshot>();
  mockIPC((cmd) => cmd === "vpn_snapshot" ? pending.promise : connected);
  const discovery = state().refreshVpn();
  await state().connectVpn("test");
  pending.resolve(idle);
  await discovery;
  assert.equal(state().vpn.phase, "connected");
  assert.equal(state().vpn.proxyPort, 12345);
});

it("late discovery cannot put a failed attempt back into connecting", async () => {
  const connection = deferred<VpnSnapshot>();
  const discoveryResult = deferred<VpnSnapshot>();
  mockIPC((cmd) => cmd === "vpn_connect" ? connection.promise : discoveryResult.promise);
  const request = state().connectVpn("test");
  const discovery = state().refreshVpn();
  connection.reject("OpenVPN stopped");
  await request;
  discoveryResult.resolve({ ...idle, phase: "connecting" });
  await discovery;
  assert.equal(state().vpn.phase, "error");
  assert.equal(state().vpn.error, "OpenVPN stopped");
});

it("does not auto-connect from a leftover autoConnect default", async () => {
  let connectCalls = 0;
  mockIPC((cmd) => {
    if (cmd === "vpn_connect") {
      connectCalls += 1;
      return connected;
    }
    if (cmd === "detect_agents") return [];
    if (cmd === "state_load") {
      return {
        version: 5,
        projects: [],
        workspaces: [],
        sidebar: [],
        activeProjectId: null,
        accounts: [],
        vpn: { autoConnect: true, profileId: "test" },
      };
    }
    return idle;
  });
  await state().init();
  assert.equal(state().vpn.autoConnect, false);
  assert.equal(state().vpn.spawnAllowed, true);
  assert.equal(state().vpn.phase, "idle");
  assert.equal(connectCalls, 0);
});

it("connects on launch only when connectOnLaunch was opted in", async () => {
  const pending = deferred<VpnSnapshot>();
  let connectCalls = 0;
  mockIPC((cmd) => {
    if (cmd === "vpn_connect") {
      connectCalls += 1;
      return pending.promise;
    }
    if (cmd === "detect_agents") return [];
    if (cmd === "state_load") {
      return {
        version: 5,
        projects: [],
        workspaces: [],
        sidebar: [],
        activeProjectId: null,
        accounts: [],
        vpn: { autoConnect: true, connectOnLaunch: true, profileId: "test" },
      };
    }
    return idle;
  });
  const started = state().init();
  await started;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(state().vpn.autoConnect, true);
  assert.equal(state().vpn.spawnAllowed, false);
  assert.equal(state().vpn.phase, "connecting");
  assert.equal(connectCalls, 1);
  pending.resolve(connected);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(state().vpn.phase, "connected");
  assert.equal(state().vpn.spawnAllowed, true);
});

for (const removal of ["pane", "deck", "project"] as const) {
  it(`closing a waiting ${removal} settles restoration`, () => {
    mockIPC(() => undefined);
    const id = `waiting-${removal}`;
    useKeel.setState({
      restoreStatus: "restoring", restoreLeft: 1, restorePanes: { [id]: true },
      projects: [{
        id: "project", name: "Test", path: "C:/test", collapsed: false,
        activeDeckId: "deck", decks: [{
          id: "deck", name: "Deck", focused: id, zoomed: null,
          tree: { kind: "pane", id },
          panes: { [id]: {
            id, title: "Terminal", agentId: null, accountId: null, cwd: null,
            resumeAgent: false, sessionId: null, sessionReady: false,
          } },
        }],
      }],
    });
    if (removal === "pane") state().closePane("project", id);
    else if (removal === "deck") state().removeDeck("project", "deck");
    else state().removeProject("project");
    assert.equal(state().restoreLeft, 0);
    assert.equal(state().restoreStatus, "idle");
    assert.deepEqual(state().exited, {});
  });
}
