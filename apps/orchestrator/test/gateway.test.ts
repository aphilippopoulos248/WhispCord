import { describe, expect, it } from "vitest";
import { GatewayError } from "../src/gateway/gateway.js";
import {
  CAT, FakeMcp, GENERAL, GUILD, MEMBER, OTHER_GUILD_CHANNEL, ROLE_ADMIN, ROLE_MOD, makeGateway, requester,
} from "./fakes.js";

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof GatewayError ? e.code : `unexpected: ${(e as Error).message}`;
  }
};

describe("guild lock", () => {
  it("injects the run's guildId into every guild-scoped call", async () => {
    const { gateway, mcp } = makeGateway();
    await gateway.call("create_category", { name: "Gaming" });
    expect(mcp.calls.at(-1)).toEqual({ name: "create_category", args: { name: "Gaming", guildId: GUILD } });
  });

  it("does not add guildId to channel-scoped tools, but still validates the channel", async () => {
    const { gateway, mcp } = makeGateway({ enabledTiers: ["read", "build", "messaging"] });
    await gateway.call("send_message", { channelId: GENERAL, message: "hi" });
    expect(mcp.calls.at(-1)!.args).not.toHaveProperty("guildId");
    expect(await code(gateway.call("send_message", { channelId: OTHER_GUILD_CHANNEL, message: "hi" }))).toBe("foreign_id");
  });

  it("rejects a caller-supplied guildId", async () => {
    const { gateway, mcp } = makeGateway();
    expect(await code(gateway.call("create_category", { name: "x", guildId: "123456789012345678" }))).toBe("foreign_id");
    expect(mcp.calls).toHaveLength(0);
  });

  it("strips guildId from the schemas Claude sees", () => {
    const { gateway } = makeGateway();
    for (const tool of gateway.claudeTools()) {
      expect(Object.keys(tool.input_schema.properties as object)).not.toContain("guildId");
      expect(tool.input_schema.required ?? []).not.toContain("guildId");
    }
  });

  it("rejects IDs from other guilds", async () => {
    const { gateway, mcp } = makeGateway();
    expect(await code(gateway.call("edit_text_channel", { channelId: OTHER_GUILD_CHANNEL, name: "x" }))).toBe("foreign_id");
    expect(await code(gateway.call("create_text_channel", { name: "x", categoryId: GENERAL }))).toBe("foreign_id"); // not a category
    expect(await code(gateway.call("edit_role", { roleId: "300000000000000099", name: "x" }))).toBe("foreign_id");
    expect(mcp.calls).toHaveLength(0);
  });

  it("accepts IDs created earlier in the same run", async () => {
    const { gateway } = makeGateway();
    const cat = await gateway.call("create_category", { name: "Gaming" });
    expect(await code(gateway.call("create_text_channel", { name: "clips", categoryId: cat.createdId! }))).toBe("ok");
  });

  it("validates member IDs with a live membership check", async () => {
    const { gateway } = makeGateway({ enabledTiers: ["read", "build", "moderate"] });
    expect(await code(gateway.call("assign_role", { userId: MEMBER, roleId: ROLE_MOD }))).toBe("ok");
    expect(await code(gateway.call("assign_role", { userId: "400000000000000999", roleId: ROLE_MOD }))).toBe("foreign_id");
  });
});

describe("tool filter", () => {
  it("blocks restricted, unknown and disabled-tier tools", async () => {
    const { gateway } = makeGateway();
    expect(await code(gateway.call("send_private_message", { userId: MEMBER, message: "x" }))).toBe("tool_blocked");
    expect(await code(gateway.call("brand_new_upstream_tool", {}))).toBe("tool_blocked");
    expect(await code(gateway.call("send_message", { channelId: GENERAL, message: "x" }))).toBe("tool_blocked");
    expect(await code(gateway.call("check_member_permissions", { userId: MEMBER }))).toBe("tool_blocked");
  });

  it("never lists blocked tools for Claude", () => {
    const { gateway } = makeGateway({ enabledTiers: ["read", "build", "destructive", "moderate", "messaging", "restricted"] });
    const names = gateway.claudeTools().map((t) => t.name);
    expect(names).not.toContain("send_private_message");
    expect(names).not.toContain("brand_new_upstream_tool");
    expect(names).not.toContain("get_guild_snapshot");
  });

  it("only exposes read tools when asked", () => {
    const { gateway } = makeGateway();
    const names = gateway.claudeTools(["read"]).map((t) => t.name);
    expect(names).toContain("list_channels");
    expect(names).not.toContain("create_category");
  });

  it("rejects unexpected and missing arguments", async () => {
    const { gateway } = makeGateway();
    expect(await code(gateway.call("create_category", { name: "x", sneaky: "1" }))).toBe("bad_args");
    expect(await code(gateway.call("create_category", {}))).toBe("bad_args");
  });
});

describe("destructive actions and limits", () => {
  it("requires typed confirmation for deletions", async () => {
    const { gateway } = makeGateway();
    expect(await code(gateway.call("delete_channel", { channelId: GENERAL }))).toBe("confirmation_required");
    gateway.confirmDestructive();
    expect(await code(gateway.call("delete_channel", { channelId: GENERAL }))).toBe("ok");
  });

  it("in undo mode only deletes objects Whispcord created", async () => {
    const { gateway } = makeGateway({ undoMode: true, enabledTiers: ["read", "build"], knownCreated: [{ type: "channel", id: "600000000000000001" }] });
    expect(await code(gateway.call("delete_channel", { channelId: GENERAL }))).toBe("foreign_id");
    expect(await code(gateway.call("delete_channel", { channelId: "600000000000000001" }))).toBe("ok");
  });

  it("enforces per-run limits", async () => {
    const { gateway } = makeGateway({ limits: { maxToolCalls: 2, maxCreations: 1, maxDeletions: 0 } });
    expect(await code(gateway.call("create_category", { name: "a" }))).toBe("ok");
    expect(await code(gateway.call("create_category", { name: "b" }))).toBe("limit");
    gateway.confirmDestructive();
    expect(await code(gateway.call("delete_channel", { channelId: GENERAL }))).toBe("limit");
    expect(await code(gateway.call("list_channels", {}))).toBe("ok");
    expect(await code(gateway.call("list_channels", {}))).toBe("limit");
  });
});

describe("permission escalation", () => {
  it("never grants Administrator, even for owners", async () => {
    const { gateway } = makeGateway({ requester: requester({ isOwner: true }) });
    expect(await code(gateway.call("create_role", { name: "x", permissions: "8" }))).toBe("escalation");
  });

  it("blocks granting permissions the requester doesn't hold", async () => {
    const { gateway } = makeGateway();
    const banMembers = (1n << 2n).toString();
    expect(await code(gateway.call("create_role", { name: "x", permissions: banMembers }))).toBe("escalation");
    expect(await code(gateway.call("upsert_role_channel_permissions", { channelId: GENERAL, roleId: ROLE_MOD, allowRaw: banMembers }))).toBe("escalation");
    expect(await code(gateway.call("create_role", { name: "x", permissions: "1024" }))).toBe("ok");
  });

  it("blocks editing roles at or above the requester's highest role", async () => {
    const { gateway } = makeGateway();
    expect(await code(gateway.call("edit_role", { roleId: ROLE_ADMIN, name: "x" }))).toBe("escalation");
    expect(await code(gateway.call("edit_role", { roleId: ROLE_MOD, name: "Mods" }))).toBe("ok");
  });

  it("blocks assigning roles that carry Administrator", async () => {
    const { gateway } = makeGateway({ enabledTiers: ["read", "build", "moderate"], requester: requester({ isOwner: true }) });
    expect(await code(gateway.call("assign_role", { userId: MEMBER, roleId: ROLE_ADMIN }))).toBe("escalation");
  });

  it("refuses to start without Manage Server", () => {
    expect(() => makeGateway({ requester: requester({ canManageServer: false }) })).toThrow(GatewayError);
  });

  it("checks role-create permission bits with BigInt precision", async () => {
    const { gateway } = makeGateway({ mcp: new FakeMcp() });
    const moderateMembers = (1n << 40n).toString();
    expect(await code(gateway.call("create_role", { name: "x", permissions: moderateMembers }))).toBe("escalation");
  });

  it("allows categories and channels in the snapshot", async () => {
    const { gateway } = makeGateway();
    expect(await code(gateway.call("create_text_channel", { name: "x", categoryId: CAT }))).toBe("ok");
  });
});
