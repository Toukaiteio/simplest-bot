import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { botConfigSchema } from "../../types.js";
import type { BotConfig, BotMessage } from "../../types.js";
import type { BotToolRegistration } from "../../tooling.js";
import { createAgentBackgroundPlugin } from "./agent-background-plugin.js";

// ============================================================================
// 后台任务插件测试：唤醒机制、SSRF 防护、受限命令、提醒与取消、容量上限。
// 注意：提醒最小 30 秒，本文件整体耗时约 40 秒。
// ============================================================================

type RecordedWake = { message: BotMessage; appends: string[] };

function createTestConfig(adminUserIds: string[] = []): BotConfig {
  return botConfigSchema.parse({
    oneBot: { url: "ws://127.0.0.1:61111" },
    llm: {
      provider: "custom",
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "test",
      model: "test-model",
    },
    memory: { enabled: false },
    auth: { adminUserIds },
    blacklist: {},
    plugins: { chat: true },
    pluginSettings: {},
  });
}

function makeMessage(userId: string, id: string): BotMessage {
  return {
    id,
    type: "group",
    groupId: "group-bg-test",
    userId,
    text: "trigger",
    raw: {},
  };
}

function makeInput(message: BotMessage) {
  return { mode: "single" as const, message };
}

function findTool(tools: BotToolRegistration[], name: string): BotToolRegistration {
  const tool = tools.find((candidate) => {
    const definition = candidate.definition as unknown as { function?: { name?: string } };
    return definition.function?.name === name;
  });
  if (!tool) throw new Error(`工具未注册：${name}`);
  return tool;
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`等待超时：${label}`);
}

/** 任务 ID 形如 `url_watch-ab12cd34` / `reminder-99887766`。 */
function extractTaskId(result: string): string {
  const match = /ID：([a-z_]+-[0-9a-f]{8})/u.exec(result);
  if (!match) throw new Error(`未能从结果中提取任务 ID：${result}`);
  return match[1];
}

async function testWatchUrlWakesAgentOnMatch(): Promise<void> {
  const config = createTestConfig(["admin"]);
  const plugin = createAgentBackgroundPlugin(config);
  const wakes: RecordedWake[] = [];
  plugin.setWakeHandler(async (message, appends) => {
    wakes.push({ message, appends });
  });
  const tools = plugin.getToolRegistrations();
  const watchUrl = findTool(tools, "watch_url");

  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("页面内容：hello-marker 出现了");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  try {
    // 管理员允许访问本机回环地址（本地测试服务器）。
    const message = makeMessage("admin", "msg-watch-1");
    const result = await watchUrl.execute(
      { url: `http://127.0.0.1:${port}/`, contains_text: "hello-marker", interval_sec: 15, timeout_sec: 60, description: "监控测试页" },
      makeInput(message),
    );
    assert.match(String(result), /后台监控已启动/);

    await waitFor(() => wakes.length >= 1, 10_000, "watch_url 唤醒");
    assert.equal(wakes[0].message.id, "msg-watch-1");
    const directive = wakes[0].appends.join("\n");
    assert.match(directive, /\[后台任务完成通知\]/);
    assert.match(directive, /监控测试页/);
    assert.match(directive, /已完成/);
    assert.match(directive, /hello-marker/);
  } finally {
    server.close();
  }
}

async function testWatchUrlBlocksLocalNetworkForNonAdmin(): Promise<void> {
  const config = createTestConfig(["admin"]);
  const plugin = createAgentBackgroundPlugin(config);
  plugin.setWakeHandler(async () => {});
  const watchUrl = findTool(plugin.getToolRegistrations(), "watch_url");

  // 非管理员监控本机地址必须被 SSRF 防护直接拒绝，不能创建任务。
  await assert.rejects(
    watchUrl.execute(
      { url: "http://127.0.0.1:9/x", status_code: 200, description: "内网探测" },
      makeInput(makeMessage("evil", "msg-watch-2")),
    ),
    /内网|本地|私有/i,
  );
  await assert.rejects(
    watchUrl.execute(
      { url: "http://192.168.1.1/admin", status_code: 200, description: "内网探测" },
      makeInput(makeMessage("evil", "msg-watch-3")),
    ),
    /内网|本地|私有/i,
  );

  // 缺少完成条件也要拒绝。
  await assert.rejects(
    watchUrl.execute(
      { url: "https://example.com/", description: "无条件" },
      makeInput(makeMessage("admin", "msg-watch-4")),
    ),
    /contains_text 或 status_code/,
  );
}

async function testBackgroundCommandRunsInSandboxAndWakes(): Promise<void> {
  const config = createTestConfig();
  const plugin = createAgentBackgroundPlugin(config);
  const wakes: RecordedWake[] = [];
  plugin.setWakeHandler(async (message, appends) => {
    wakes.push({ message, appends });
  });
  const tools = plugin.getToolRegistrations();
  const runCommand = findTool(tools, "run_background_command");

  const message = makeMessage("coder", "msg-cmd-1");
  const result = await runCommand.execute(
    { cmd: "node -v", timeout_sec: 30, description: "查看 node 版本" },
    makeInput(message),
  );
  assert.match(String(result), /后台命令已启动/);

  await waitFor(() => wakes.length >= 1, 30_000, "后台命令唤醒");
  const directive = wakes[0].appends.join("\n");
  assert.match(directive, /已完成/);
  assert.match(directive, /v\d+\.\d+/); // node 版本输出

  // 非白名单程序必须被拒绝（受限 shell 同一套校验）。
  await assert.rejects(
    runCommand.execute(
      { cmd: "cmd /c dir", description: "越权" },
      makeInput(makeMessage("coder", "msg-cmd-2")),
    ),
    /受限 shell|不允许/,
  );
}

async function testReminderFiresOnceAndCancelledReminderDoesNotWake(): Promise<void> {
  const config = createTestConfig();
  const plugin = createAgentBackgroundPlugin(config);
  const wakes: RecordedWake[] = [];
  plugin.setWakeHandler(async (message, appends) => {
    wakes.push({ message, appends });
  });
  const tools = plugin.getToolRegistrations();
  const setReminder = findTool(tools, "set_reminder");
  const stopTask = findTool(tools, "agent_stop_background_task");
  const listTasks = findTool(tools, "agent_list_background_tasks");

  // 保留的提醒（30 秒最小值）。
  const keepResult = await setReminder.execute(
    { after_sec: 30, note: "检查构建产物" },
    makeInput(makeMessage("u1", "msg-rem-1")),
  );
  assert.match(String(keepResult), /提醒已设置/);
  const keepId = extractTaskId(String(keepResult));

  // 被取消的提醒。
  const cancelResult = await setReminder.execute(
    { after_sec: 30, note: "这条会被取消" },
    makeInput(makeMessage("u1", "msg-rem-2")),
  );
  const cancelId = extractTaskId(String(cancelResult));
  await stopTask.execute({ task_id: cancelId }, makeInput(makeMessage("u1", "msg-rem-3")));

  await waitFor(() => wakes.length >= 1, 45_000, "提醒唤醒");
  // 再等一小段，确认被取消的提醒没有额外唤醒。
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  assert.equal(wakes.length, 1, `应恰好唤醒一次，实际 ${wakes.length}`);
  const directive = wakes[0].appends.join("\n");
  assert.match(directive, /检查构建产物/);
  assert.match(directive, new RegExp(keepId));

  const listing = await listTasks.execute({}, makeInput(makeMessage("u1", "msg-rem-4")));
  assert.match(String(listing), /completed/);
  assert.match(String(listing), /cancelled/);
}

async function testPerUserCapacityAndOwnership(): Promise<void> {
  const config = createTestConfig(["boss"]);
  const plugin = createAgentBackgroundPlugin(config);
  plugin.setWakeHandler(async () => {});
  const tools = plugin.getToolRegistrations();
  const setReminder = findTool(tools, "set_reminder");
  const stopTask = findTool(tools, "agent_stop_background_task");

  const created: string[] = [];
  for (let index = 0; index < 4; index += 1) {
    const result = await setReminder.execute(
      { after_sec: 60, note: `占位 ${index}` },
      makeInput(makeMessage("u2", `msg-cap-${index}`)),
    );
    created.push(extractTaskId(String(result)));
  }

  // 第 5 个任务被容量上限拒绝。
  await assert.rejects(
    setReminder.execute(
      { after_sec: 60, note: "超额" },
      makeInput(makeMessage("u2", "msg-cap-5")),
    ),
    /上限/,
  );

  // 其他人不能终止 u2 的任务。
  await assert.rejects(
    stopTask.execute({ task_id: created[0] }, makeInput(makeMessage("u3", "msg-cap-6"))),
    /只能终止自己创建/,
  );
  // 管理员可以终止。
  const adminStop = await stopTask.execute({ task_id: created[0] }, makeInput(makeMessage("boss", "msg-cap-7")));
  assert.match(String(adminStop), /已请求终止/);

  // 清理其余任务，避免测试进程内残留唤醒。
  for (const id of created.slice(1)) {
    await stopTask.execute({ task_id: id }, makeInput(makeMessage("u2", `msg-cap-clean-${id}`)));
  }
}

async function testSleepToolIsBounded(): Promise<void> {
  const config = createTestConfig();
  const plugin = createAgentBackgroundPlugin(config);
  const sleep = findTool(plugin.getToolRegistrations(), "agent_sleep");

  const startedAt = Date.now();
  const result = await sleep.execute({ seconds: 1 }, makeInput(makeMessage("u4", "msg-sleep-1")));
  const elapsed = Date.now() - startedAt;
  assert.match(String(result), /已等待 1 秒/);
  assert.ok(elapsed >= 900 && elapsed < 5_000, `sleep 应约 1 秒，实际 ${elapsed}ms`);

  // 超过上限的等待被截断到 120 秒以内（由描述与钳制保证，这里只验证非法值不会崩）。
  const clamped = await sleep.execute({ seconds: 0 }, makeInput(makeMessage("u4", "msg-sleep-2")));
  assert.match(String(clamped), /已等待 1 秒/);
}

async function main(): Promise<void> {
  await testWatchUrlWakesAgentOnMatch();
  console.log("✓ watch_url 命中后唤醒 Agent（管理员可访问本机测试服务器）");
  await testWatchUrlBlocksLocalNetworkForNonAdmin();
  console.log("✓ 非管理员 watch_url 被内网防护拒绝 & 缺少完成条件被拒绝");
  await testBackgroundCommandRunsInSandboxAndWakes();
  console.log("✓ run_background_command 在受限沙箱执行并唤醒（白名单拒绝生效）");
  await testSleepToolIsBounded();
  console.log("✓ agent_sleep 边界行为");
  await testPerUserCapacityAndOwnership();
  console.log("✓ 单用户容量上限与任务归属/管理员终止");
  await testReminderFiresOnceAndCancelledReminderDoesNotWake();
  console.log("✓ 提醒按时唤醒一次，已取消的提醒不唤醒");
  console.log("全部通过。");
}

await main();
