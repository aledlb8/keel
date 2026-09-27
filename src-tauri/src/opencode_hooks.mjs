// Loaded by OpenCode in its own runtime. Inert outside a Keel-owned shell.
export async function KeelStatus({ client } = {}) {
  const { KEEL_HOOK_PORT: port, KEEL_HOOK_TOKEN: token } = process.env;
  if (!port || !token || !client) return {};
  const roots = new Map();
  let queue = Promise.resolve();
  async function publish(event) {
    const p = event.properties ?? {};
    const info = p.info;
    const id = p.sessionID ?? info?.sessionID ?? (event.type.startsWith("session.") ? info?.id : null);
    if (!id) return;
    let root = roots.get(id);
    if (event.type === "session.created" || event.type === "session.updated") {
      root = !info?.parentID;
      roots.set(id, root);
    }
    if (root === undefined) {
      try {
        const response = await client.session.get({ path: { id } });
        if (!response.data?.id) return;
        root = !response.data.parentID;
        roots.set(id, root);
      } catch { return; }
    }
    if (roots.size > 256) roots.delete(roots.keys().next().value);
    if (!root) return;
    let name;
    switch (event.type) {
      case "session.created": name = "SessionStart"; break;
      case "session.status":
        if (p.status?.type === "idle") name = "Stop";
        else if (p.status?.type === "busy") name = "UserPromptSubmit";
        else if (p.status?.type === "retry") name = "PostToolUse";
        else return;
        break;
      case "session.error": name = "SessionError"; break;
      case "permission.asked": case "question.asked": name = "PermissionRequest"; break;
      case "permission.replied": case "question.replied": case "question.rejected":
        name = "PostToolUse"; break;
      default: return;
    }
    await fetch(`http://127.0.0.1:${port}/${token}/opencode`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: id, hook_event_name: name, sender_pid: process.pid }),
      signal: AbortSignal.timeout(2000),
    }).catch(() => {});
  }
  return {
    event: ({ event }) => {
      // Ignore token/message deltas before allocating work. Serialize lifecycle
      // events so a slow SDK lookup cannot deliver Busy after its matching Idle.
      if (!event || !["session.created", "session.updated", "session.status", "session.error",
        "permission.asked", "permission.replied", "question.asked", "question.replied",
        "question.rejected"].includes(event.type)) return;
      queue = queue.then(() => publish(event)).catch(() => {});
      return queue;
    },
  };
}

// Current module loader; the named factory also supports earlier CLI releases.
export default { id: "keel-status", server: KeelStatus };
