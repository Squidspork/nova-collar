import { shellHint } from "./platform.js";
import { basename } from "node:path";
import { chatTarget, isLocalModel, loadConfig, normalizeModel, readMemory } from "./config.js";
import { formatIntuition, readIntuition } from "./intuition.js";
import { readTerminal } from "./term-bridge.js";
import { compactResult, executeTool, plainToolDef, realToolName, toolDefs, toolImage, wantsRemoteComputer, windowToolDefs } from "./tools.js";
import { describeTool } from "./describe.js";
import { inferPack, packFor, packToolNames } from "./packs.js";
import { layaAuditTrained, layaGoalTrained, layaLoopTrained, readLaya } from "./laya.js";
import { afterStop, briefArgs, changedSince, gaveUpEarly, LOOP_CONTINUES, loopContinueNote, loopFromLaya, loopTrace, shouldStopLoop, toolSig } from "./laya-loop.js";
import { acceptRestate, answerFromAsk, auditFromLaya, auditNudge, auditTrace, claimLine, dodgesResult, earlierAnswer, evidenceDraft, failureGoal, GOAL_STEP_SYSTEM, goalFromLaya, goalHalt, goalNudge, goalStepFromText, goalStepTrace, goalTrace, planAudit, plainResult, settleAudit, settleGoalStep, toolNote, toPlain, unprovenAnswer } from "./goal.js";
import { steerFromLaya, watchJailbreak } from "./laya-steer.js";
import { HASH_ROUNDS, lanesFrom, pathBetween, planDone, shortModel, smallModel } from "./split.js";
import { onlineAsk, pinPublicHost, plainTurn, rewriteAsk, servesAsk, skipNote, toolsForAsk, tunnelTurn, wantedTools } from "./serve.js";
import { getWorkdir } from "./workdir.js";
import { cleanText, fence, redactSecrets, safePack } from "./safe.js";
import { applyToolDelta, finishToolCalls, requiredFields, unfinishedArgs } from "./tool-calls.js";
import { pushThink, streamPiece, thoughtLoop } from "./reason.js";
import { admitsUnknown, createGround, FACT_LAW, factAsk } from "./ground.js";
import { censorPass, codeAsk, createHarness, expectFromAsk, extractAsks, inventedPrint, readJobSpec, wrongWriteBlame } from "./harness.js";
import { runHnlTool, searchArgs } from "./hnl.js";
import { operatorDoctrine, playbookOf } from "./playbooks.js";
import { formatPackLessons, lessonsFor } from "./pack.js";
import { packBrief } from "./tasks.js";

export function teammatePrompt(bot, { local = false } = {}) {
  const name = cleanText(bot?.name || "Teammate", 32, { singleLine: true }) || "Teammate";
  const title = cleanText(bot?.title, 80, { singleLine: true });
  const book = playbookOf(bot?.playbook);
  const job = [
    `You are ${name}${title ? `, ${title}` : ""}, a specialist operator inside Nova Collar. Work on the operator's behalf.`,
    ...operatorDoctrine({ local, pack: bot?.pack || book?.pack || "", ask: bot?.ask || book?.ask || "" }),
    fence("Job", bot?.role || book?.role || "Do the work you are given. Keep this role stable."),
    fence("Voice", bot?.voice || book?.voice || "first line is the answer. Then short bullets.", 240),
    fence("How you work", book?.how || "One read, then act. Come back with evidence.", 400),
  ];
  const taught = formatPackLessons(lessonsFor(bot?.pack || book?.pack || "", bot?.id));
  if (taught) job.push(taught);
  const sense = formatIntuition(readIntuition(), { short: true });
  if (sense) job.push(sense);
  return job.join("\n");
}

function moodForTool(name) {
  if (name === "generate_image") return "paint";
  if (name === "bash" || name === "write_file" || name === "host_run" || name === "term_send" || name === "set_workdir" || name === "computer_pi" || name === "computer_exec" || name.startsWith("docker_")) return "code";
  if (name === "subagent" || name === "web_search" || name === "extract" || name === "scrape" || name === "docs_search" || name.startsWith("memory_")) return "search";
  if (name.startsWith("mac_") || name.startsWith("computer_") || name === "desk") return "desk";
  return "tool";
}

function systemPrompt(memory, { local = false, bot = null, role = "" } = {}) {
  if (role === "term") {
    return [
      "You are Nova Collar on the console. The window keeps this same chat. You are the duty officer: short, exact, a little dry.",
      "Call this computer this system. First line is the result. Then at most four facts. No tables.",
      "This machine: host_disk, host_listen_ports, host_facts, host_processes, host_service_status, host_file_read, host_file_write, host_run, and the net tools.",
      "computer_* is a different machine. Use it only when the operator asked for the remote computer.",
      "Code on this machine: host_file_write and host_run. Wait for the harness. First line PASS or FAIL.",
      "Do not borrow the window's voice. No warmth, no plans, no tables.",
      FACT_LAW,
      memory.rules.trim().slice(0, 200),
    ].filter(Boolean).join("\n");
  }
  if (role === "phone") {
    return [
      "You are Nova Collar on the paired iPhone. Thin client of the house.",
      loadConfig().hnlSearch
        ? "Tools: web_search, extract, scrape, docs_search, memory_*, generate_image, and the HNL computer (computer_*)."
        : "Search is bring-your-own. Do not call web_search, extract, scrape, or docs_search. Tools: memory_*, generate_image, and the HNL computer (computer_*).",
      "The HNL computer is a 1280x720 remote desktop. computer_guide if you need the playbook, then screenshot, open, click, type, exec, read, write, or pi. Look once, then act. Do not invent what is on that box.",
      "If she asks for a picture, generate_image must run this turn. Never say you painted, or that Flux painted, unless that tool returned. The phone shows the picture. Do not paste pixels.",
      "Never host_*, mac_*, desk, term, docker, or subagent. This phone is not that system.",
      "Do not narrate tools. First line is the result.",
      FACT_LAW,
      memory.personality.trim().slice(0, 360),
      memory.rules.trim().slice(0, 240),
    ].filter(Boolean).join("\n");
  }
  if (bot) return teammatePrompt(bot, { local });
  if (local) {
    return [
      "You are Nova Collar. Pick tools yourself. A prefer-pack line is a hint, not a lock.",
      "Call this computer this system.",
      "host_* this system. net_report sites. computer_exec/read/write the remote workspace. term_* this window’s shell.",
      "If a job needs two or more tools in one pack, call subagent(task, pack). One-shot facts can use the pack tool directly.",
      "If a job will take a while, call pack_task and keep going. The pack does that job. Do not do it in this turn.",
      packBrief() ? `Pack finished:\n${packBrief()}` : "",
      "Do not narrate tools. The window already showed them. First line is the result, or failed and one next step. Then ≤5 new facts. No tables. No host_run if a pack tool fits.",
      "Files: host_file_read / host_file_write. Shell: host_run. Code: smallest edit. Wait for harness compile+run. First line PASS or FAIL. Do not rewrite the harness.",
      FACT_LAW,
      "No runaway loops, no yes>, no /tmp logs.",
      memory.personality.trim().slice(0, 360),
      memory.rules.trim().slice(0, 240),
      formatIntuition(readIntuition(), { local: true }),
    ].filter(Boolean).join("\n");
  }
  return [
    "You are Nova Collar — Hungry Nova Labs in one window.",
    "Call this computer this system.",
    "MCP command packs are the center of how you work. Pick the pack and tool yourself. A prefer-pack line is a hint, not a lock. Prefer a named pack tool over host_run.",
    loadConfig().hnlSearch
      ? "Packs: term, host, net, docker, incident, hnl, desk, computer (remote workspace)."
      : "Packs: term, host, net, docker, incident, desk, computer (remote workspace). Search is bring-your-own.",
    "Do not narrate tools. The window already showed them. First line is the result, or failed and one next step. Then at most five new facts. No tables.",
    "If a job will take a while, call pack_task and keep going. The pack does that job. Do not do it in this turn.",
    packBrief() ? `Pack finished:\n${packBrief()}` : "",
    "Files and commands for this window: host_file_read, host_file_write, host_run. computer_* is a different machine. Use it only when the user asked for the remote computer.",
    "Do not call bash, read_file, or write_file.",
    "Code harness (DeepSeek-style): read once, smallest patch. Engine compiles and run-probes after every write, then checks the ask checklist. If harness fails, fix that error only. Final line starts with PASS or FAIL and names the check. Never claim done with open asks. Do not expand harness/intuition/safe — those stay human-gated.",
    FACT_LAW,
    "Risky commands and broad file replacements pause for the user’s Allow once / Deny decision. A denial ends the task; never try another tool to bypass it.",
    "Files stay in the window working directory. set_workdir before writing somewhere else.",
    "Safety: never background a job. Never redirect a loop or yes/while-true to a file. Never write to /tmp for logs.",
    "",
    "## Personality",
    memory.personality.trim(),
    "",
    "## Rules you wrote",
    memory.rules.trim(),
    "",
    "## House sense",
    formatIntuition(readIntuition()),
  ].join("\n");
}

function parseSseLine(line) {
  if (!line.startsWith("data:")) return null;
  const data = line.slice(5).trim();
  if (!data || data === "[DONE]") return data === "[DONE]" ? "[DONE]" : null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function aborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error("Stopped.");
  error.name = "AbortError";
  throw error;
}

function waitTick(signal, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      const error = new Error("Stopped.");
      error.name = "AbortError";
      reject(error);
    };
    if (signal?.aborted) return stop();
    signal?.addEventListener("abort", stop, { once: true });
  });
}

export async function complete(messages, cfg, onDelta, signal, extra = {}) {
  aborted(signal);
  const target = extra.target || chatTarget(cfg);
  const lean = target.local || smallModel(target.model);
  const body = {
    model: target.model,
    messages,
    tools: extra.tools || toolDefs({ local: lean, search: Boolean(cfg.hnlSearch) }),
    tool_choice: extra.toolChoice || "auto",
    stream: true,
  };
  const predict = extra.predict || (lean ? 1536 : 0);
  const temperature = extra.temperature ?? (lean ? 0.6 : undefined);
  // mlx_lm.server reads only the top-level fields and stops at 512 tokens without max_tokens.
  if (predict) body.max_tokens = predict;
  if (temperature !== undefined) body.temperature = temperature;
  if (target.local) {
    body.think = false;
    body.options = {
      temperature,
      num_ctx: extra.ctx || 12288,
      num_predict: predict,
    };
  }
  // Silence cuts the turn. Tokens keep it open, up to the gateway's own half hour.
  const quiet = new AbortController();
  const cap = AbortSignal.timeout(30 * 60 * 1000);
  const linked = AbortSignal.any([quiet.signal, cap, ...(signal ? [signal] : [])]);
  let quietTimer = setTimeout(() => quiet.abort(), 180_000);
  const bump = () => {
    clearTimeout(quietTimer);
    quietTimer = setTimeout(() => quiet.abort(), 180_000);
  };
  const headers = {
    authorization: `Bearer ${target.key}`,
    "content-type": "application/json",
  };
  let response;
  try {
    response = await fetch(`${target.url}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: linked,
    });
    if (!response.ok && extra.toolChoice && extra.toolChoice !== "auto") {
      body.tool_choice = "auto";
      response = await fetch(`${target.url}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: linked,
      });
    }
    if (!response.ok) {
      const text = await response.text();
      throw new Error(redactSecrets(text).slice(0, 800) || `HTTP ${response.status}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let reason = "";
    const think = { buf: "", hide: false };
    const calls = new Map();
    const note = (piece) => {
      const grown = streamPiece(reason, piece);
      if (!grown.added) return;
      bump();
      reason = grown.text;
      extra.onReason?.(grown.added);
      if (thoughtLoop(reason)) {
        const error = new Error("Thinking started repeating, so that turn was cut.");
        error.name = "ThoughtLoop";
        quiet.abort(error);
        throw error;
      }
    };
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const chunk = parseSseLine(line.trim());
        if (!chunk || chunk === "[DONE]") continue;
        const delta = chunk.choices?.[0]?.delta || {};
        note(delta.reasoning_content || delta.reasoning || "");
        if (delta.content) {
          const split = pushThink(think, delta.content);
          note(split.thought);
          if (split.answer) {
            const grown = streamPiece(content, split.answer);
            if (grown.added) {
              bump();
              content = grown.text;
              onDelta?.(grown.added);
            }
          }
        }
        if (delta.tool_calls?.length) bump();
        for (const part of delta.tool_calls || []) applyToolDelta(calls, part);
      }
    }
    // A partial opening tag at EOF is ordinary answer text.
    if (think.buf && !think.hide) { content += think.buf; onDelta?.(think.buf); }
    return {
      content,
      tool_calls: finishToolCalls(calls, { max: extra.maxTools || (lean ? 3 : 6) }),
    };
  } catch (error) {
    if (error?.name === "ThoughtLoop") throw error;
    if (signal?.aborted) {
      const stopped = new Error("Stopped.");
      stopped.name = "AbortError";
      throw stopped;
    }
    if (quiet.signal.aborted) {
      const stalled = new Error("The model went quiet.");
      stalled.name = "TimeoutError";
      throw stalled;
    }
    throw error;
  } finally {
    clearTimeout(quietTimer);
  }
}

function refuseWatch(emit) {
  emit({ type: "tool", name: "laya", args: "" });
  emit({ type: "tool_result", name: "laya", ok: false, blurb: "refused", detail: "watchdog" });
  emit({ type: "mood", mood: "idle", text: "here" });
  return { assistant: "I won't do that. Ask for the job itself.", messages: [] };
}

async function restatePlain(rawArgs, history, personality, cfg, signal) {
  let words = "";
  let info = "";
  try {
    const parsed = JSON.parse(rawArgs || "{}");
    words = String(parsed.words || parsed.text || "").trim();
    info = String(parsed.info || "").trim();
  } catch {
    words = "";
  }
  const prior = earlierAnswer(history);
  const base = toPlain({ words: prior || words, info });
  const stillRaw = info && base === (prior || words) && /ssh -o\b|BatchMode|^DNS\b|TCP\s+\S+\s+\(LISTEN\)/m.test(info);
  if (!stillRaw) return { ok: true, stdout: base };
  try {
    const last = await complete([
      {
        role: "system",
        content: [
          "Turn the info into one or two sentences a person can read. Keep every number.",
          "Do not mention tools, commands, or DNS.",
          "Apply this voice at the end. Do not quote it:",
          String(personality || "").trim().slice(0, 360),
        ].join("\n"),
      },
      { role: "user", content: info.slice(0, 2000) },
    ], cfg, null, signal, { toolChoice: "none", tools: [], temperature: 0.3, predict: 180 });
    return { ok: true, stdout: acceptRestate(base, last.content, personality) };
  } catch {
    return { ok: true, stdout: base };
  }
}

export async function runTurn(history, rawText, emit, signal, extra = {}) {
  const userText = redactSecrets(String(rawText || "")).slice(0, 24_000);
  const standing = String(extra.goal || "");
  if (watchJailbreak(userText) || watchJailbreak(standing)) return refuseWatch(emit);
  const cfg = loadConfig();
  if (extra.model) cfg.model = normalizeModel(extra.model);
  const lanes = lanesFrom(cfg, chatTarget(cfg));
  const targets = lanes.on ? [lanes.fast, lanes.think] : [chatTarget(cfg)];
  if (targets.some((target) => !target.local && !target.key)) {
    throw new Error("Save an API key for the selected provider first.");
  }
  const local = isLocalModel(cfg.model) || smallModel(cfg.model) || Boolean(lanes.on && (lanes.fast.local || smallModel(lanes.fast.model)));
  const memory = readMemory();
  const terminal = readTerminal(local ? 1500 : 8000);
  const workdir = getWorkdir();
  const extras = [`cwd ${workdir}`];
  const requested = safePack(extra.pack);
  let pack = requested || inferPack(userText);
  let steer = null;
  try {
    const read = await readLaya(userText);
    steer = steerFromLaya(read, { locked: Boolean(requested), text: userText });
  } catch {
    steer = null;
  }
  if (steer?.action === "refuse") {
    emit({ type: "tool", name: "laya", args: "" });
    emit({ type: "tool_result", name: "laya", ok: false, blurb: steer.blurb, detail: steer.detail });
    emit({ type: "mood", mood: "idle", text: "here" });
    return { assistant: "I won't do that. Ask for the job itself.", messages: [] };
  }
  if (steer?.pack && !requested) pack = steer.pack;
  const tunnels = tunnelTurn(userText);
  const plain = plainTurn(userText, history);
  if (plain && !requested) {
    steer = { ...(steer || {}), toolChoice: "", action: "answer", blurb: "plain", detail: steer?.detail || "say it" };
  } else if (tunnels && !requested) {
    pack = "host";
    if (steer?.toolChoice) steer = { ...steer, toolChoice: "", action: "pack", pack: "host" };
  } else if (rewriteAsk(userText)) {
    steer = { ...(steer || {}), toolChoice: "none", action: "answer", blurb: steer?.blurb || "" };
  }
  if (!cfg.hnlSearch && pack === "hnl") pack = "";
  if (pack) extras.push(`prefer pack ${pack} (hint, others ok)`);
  if (!cfg.hnlSearch) extras.push("Search is bring-your-own. Do not call web_search, extract, scrape, or docs_search.");
  if (extra.role === "phone") {
    extras.push(cfg.hnlSearch
      ? "phone role: lookup plus the remote computer. no host, desk, mac, or term"
      : "phone role: remote computer only. search is bring-your-own. no host, desk, mac, or term");
  }
  if (extra.note) extras.push(String(extra.note).slice(0, 400));
  const goal = String(extra.goal || "").replace(/\s+/g, " ").trim().slice(0, 400);
  if (extra.bot?.name) {
    extras.push(`operator ${cleanText(extra.bot.name, 32, { singleLine: true })}: job is standing law, chat is this task`);
  }
  if (goal) {
    extras.push(`Standing goal: ${goal}. It stays open until it is true. If a tool repeats, skip it and take a different step. Do not end with Stopped while it is open. When it is true, the first line is the result.`);
  }
  const codeJob = Boolean(steer?.code || codeAsk(userText));
  const factJob = Boolean(steer?.fact || factAsk(userText));
  if (codeJob) extras.push("code job: host_file_write and host_run on this computer. Wait for harness compile+run and a clean checklist before PASS.");
  if (factJob) extras.push("fact job: look it up this turn. Names, years, and prices must appear in what you read, or say you don't know.");
  const asks = extractAsks(userText);
  if (asks.length) extras.push(`ask checklist: ${asks.join("; ")}`);
  const expects = expectFromAsk(userText);
  if (expects.length) extras.push(`harness expect stdout: ${expects.join(", ")}`);
  if (readJobSpec()) extras.push("harness.json job check is on");
  if (terminal) extras.push(`term:\n${terminal}`);
  const gate = createHarness({
    ask: userText,
    approvalAware: true,
    localExec: (command) => executeTool("host_run", { command }, cfg, { ...extra, signal }),
    remoteExec: cfg.toolsKey ? (command) => executeTool("computer_exec", { command }, cfg, { ...extra, signal, remote: true }) : null,
  });
  const ground = createGround();
  const prior = local ? history.slice(-10) : history;
  const messages = [
    { role: "system", content: systemPrompt(memory, { local, bot: extra.bot || null, role: extra.role || "" }) + "\n" + shellHint + "\nRisky actions pause for Allow once / Deny. A denial ends this task; never bypass it with another tool.\n" },
    ...prior,
    { role: "user", content: extras.length ? `${userText}\n\n${extras.join("\n")}` : userText },
  ];
  const remote = extra.role === "phone" || wantsRemoteComputer(userText) || wantsRemoteComputer(standing);
  const listed = extra.tools || (extra.role === "phone"
    ? null
    : windowToolDefs({ local, search: Boolean(cfg.hnlSearch), remote }));
  const catalog = plain && Array.isArray(listed) ? [...listed, plainToolDef()] : listed;
  const packNames = !plain && steer?.action === "pack" ? packToolNames(steer.pack || pack) : null;
  const offered = toolsForAsk(catalog, userText, history, packNames);
  const callExtra = steer?.toolChoice
    ? { tools: [], toolChoice: steer.toolChoice }
    : (offered ? { tools: offered } : {});
  if (steer?.blurb) {
    emit({ type: "tool", name: "laya", pack: steer.pack || "", args: "" });
    emit({ type: "tool_result", name: "laya", ok: true, blurb: steer.blurb, detail: steer.detail });
  }
  let rounds = 0;
  let repairs = 0;
  let repairName = "";
  let halt = "";
  let goalStatus = goal ? "open" : "";
  let goalNudges = 0;
  let debtNudges = 0;
  let failNudges = 0;
  let openFailure = "";
  let loopTries = 0;
  async function countDown(n) {
    for (let left = 3; left >= 1; left -= 1) {
      aborted(signal);
      emit({ type: "mood", mood: "think", text: `next step ${left}s · ${n}/${LOOP_CONTINUES}` });
      await waitTick(signal, 1000);
    }
  }
  let auditTries = 0;
  const archive = [];
  const trustAudit = layaAuditTrained();
  const down = new Set();
  /** One model call on the lane the path picked. If that lane does not answer, the other lane takes the call. */
  async function onLane(path, list, onText, opts = {}) {
    if (!lanes.on) return complete(list, cfg, onText, signal, { onReason, ...opts });
    let lane = path === "fast" ? lanes.fast : lanes.think;
    if (down.has(lane.role)) lane = lane === lanes.fast ? lanes.think : lanes.fast;
    emit({ type: "mood", mood: "think", text: `${shortModel(lane.model)} · ${lane.role}` });
    try {
      return await complete(list, cfg, onText, signal, { onReason, ...opts, target: lane });
    } catch (error) {
      const other = lane === lanes.fast ? lanes.think : lanes.fast;
      if (signal?.aborted || error.name === "AbortError" || error.name === "ThoughtLoop" || down.has(other.role)) throw error;
      down.add(lane.role);
      emit({ type: "retract" });
      emit({ type: "tool", name: "laya", args: "" });
      emit({
        type: "tool_result",
        name: "laya",
        ok: false,
        blurb: "lane",
        detail: `${shortModel(lane.model)} did not answer · ${shortModel(other.model)} took over`,
      });
      return complete(list, cfg, onText, signal, { onReason, ...opts, target: other });
    }
  }

  async function closeWith(draft, { allowRetry, wantDone }) {
    const claim = claimLine(draft);
    const plan = planAudit({ claim, goal, trail, failure: openFailure, checked: passedClean() });
    let verdict = null;
    if (trustAudit && plan.action !== "skip") {
      try {
        verdict = auditFromLaya(await readLaya(auditTrace({
          goal,
          claim,
          opposite: plan.opposite,
          internalGoal: plan.internalGoal,
          ask: userText,
          trail,
        }), "audit"));
      } catch {
        verdict = null;
      }
    }
    const settled = settleAudit({ plan, verdict, trust: trustAudit });
    if (settled.action !== "skip") {
      const entry = {
        userGoal: goal,
        claim,
        opposite: plan.opposite,
        internalGoal: plan.internalGoal,
        verdict: settled.action === "retry" && !allowRetry ? "unproven" : settled.action,
        detail: settled.reason,
      };
      archive.push(entry);
      emit({ type: "goal", text: goal, check: entry.verdict, opposite: plan.opposite });
    }
    if (settled.action === "retry" && allowRetry && auditTries < 2 && rounds < maxRounds) {
      auditTries += 1;
      emit({ type: "tool", name: "laya", args: "" });
      emit({ type: "tool_result", name: "laya", ok: true, blurb: "disprove", detail: settled.reason });
      messages.push({ role: "user", content: auditNudge({ opposite: plan.opposite, internalGoal: plan.internalGoal, goal }) });
      return null;
    }
    if (settled.action === "held" && goal && (wantDone || auditTries > 0 || goalNudges > 0)) goalStatus = "done";
    if (settled.action === "retry") goalStatus = goal ? "open" : "";
    const assistant = settled.action === "retry"
      ? unprovenAnswer(censorPass(draft, gate.debt()), plan.opposite)
      : censorPass(draft, gate.debt());
    emit({ type: "mood", mood: "idle", text: "here" });
    return { assistant, messages: messages.slice(1), goalStatus, archive };
  }
  const maxRounds = goal ? (local ? 12 : 16) : (local ? 8 : 12);
  let judgedAnswer = "";
  let goalJudges = 0;
  async function judgeGoal({ laya, why }) {
    goalJudges += 1;
    let parsed = null;
    try {
      const last = await onLane("think", [
        { role: "system", content: GOAL_STEP_SYSTEM },
        { role: "user", content: goalStepTrace({ goal, ask: userText, laya, why, trail }) },
      ], null, {
        toolChoice: "none",
        tools: [],
        temperature: 0.2,
        predict: 700,
      });
      parsed = goalStepFromText(last.content);
    } catch {
      parsed = null;
    }
    const settled = settleGoalStep(parsed, { goal, trail });
    emit({ type: "tool", name: "laya", args: "" });
    emit({
      type: "tool_result",
      name: "laya",
      ok: true,
      blurb: "step",
      detail: `${settled.action}: ${settled.step}`.slice(0, 180),
    });
    if (settled.action === "done") {
      judgedAnswer = settled.step;
      goalStatus = "done";
      halt = "goal accomplished";
    }
    return settled;
  }
  const trail = [];
  const seen = new Map();
  const failed = new Set();
  let lastProof = null;
  const passedClean = () => Boolean(lastProof?.ok) && gate.debt().length === 0;
  const onDelta = (delta) => {
    if (!onDelta.writing) {
      onDelta.writing = true;
      emit({ type: "mood", mood: "write", text: "writing" });
    }
    emit({ type: "delta", text: delta });
  };
  const onReason = (text) => {
    if (text) emit({ type: "think", text });
  };
  if (plain && !goal) {
    const outlet = toPlain({ words: earlierAnswer(history) });
    emit({ type: "tool", name: "say_plain", pack: "", args: "" });
    emit({ type: "tool_result", name: "say_plain", pack: "", ok: true, blurb: "In your voice", detail: outlet });
    emit({ type: "retract" });
    const closed = await closeWith(outlet, { allowRetry: false, wantDone: false });
    return closed || { assistant: outlet, messages: messages.slice(1), goalStatus, archive };
  }
  let planned = false;
  let plans = 0;
  let hashes = 0;
  const answerOnly = Array.isArray(callExtra.tools) && callExtra.tools.length === 0;
  const deep = Boolean(goal) || codeJob || factJob;
  const thinkNext = () => lanes.on && hashes < HASH_ROUNDS;
  while (rounds < maxRounds && !halt) {
    rounds += 1;
    aborted(signal);
    const lastRow = [...trail].reverse().find((row) => row.name !== "laya" && row.name !== "ground");
    const stalled = lastRow?.ok === false || loopTries > 0 || debtNudges > 0;
    const passed = Boolean(lastRow?.passed) && gate.debt().length === 0;
    const path = lanes.on
      ? pathBetween({ answer: answerOnly, deep, planned, stuck: stalled, passed, hashes })
      : "fast";
    if (path === "hash") hashes += 1;
    emit({ type: "mood", mood: "think", text: path === "plan" ? "planning" : path === "hash" ? "hashing" : "thinking" });
    onDelta.writing = false;
    const reply = await onLane(path, messages, onDelta, {
      ...(repairName
        ? { ...callExtra, toolChoice: { type: "function", function: { name: repairName } } }
        : callExtra),
      onReason,
    });
    repairName = "";
    if (answerOnly) reply.tool_calls = [];
    // Tool-call prose can claim success before an approval or execution.
    if (reply.tool_calls.length && reply.content) emit({ type: "retract" });
    if (path === "plan") {
      plans += 1;
      planned = planDone(reply.tool_calls.map((call) => realToolName(call.function.name)), plans);
    }
    if (path === "plan" || path === "hash") {
      const first = reply.tool_calls[0];
      emit({ type: "tool", name: "laya", args: "" });
      emit({
        type: "tool_result",
        name: "laya",
        ok: true,
        blurb: path,
        detail: `${shortModel(lanes.think.model)}: ${first ? `${first.function.name} ${briefArgs(first.function.arguments)}` : cleanText(reply.content, 140, { singleLine: true }) || "no step"}`.slice(0, 180),
      });
    }
    if (path === "plan" && reply.tool_calls.length === 0) {
      emit({ type: "retract" });
      if (reply.content) messages.push({ role: "assistant", content: reply.content });
      continue;
    }
    const keepAdvice = () => {
      if (path === "hash" && reply.content) messages.push({ role: "assistant", content: reply.content });
    };
    if (reply.tool_calls.length === 0) {
      const owed = answerOnly ? [] : gate.debt();
      const lastAct = [...trail].reverse().find((row) => row.name !== "laya" && row.name !== "ground");
      const toolFailed = Boolean(lastAct && lastAct.ok === false);
      if (owed.length) {
        if (rounds < maxRounds && debtNudges < 3) {
          debtNudges += 1;
          keepAdvice();
          messages.push({
            role: "user",
            content: `Harness still open: ${owed.join(", ")}. Fix the error or say FAIL. Do not claim done.`,
          });
          continue;
        }
        emit({ type: "retract" });
        const forced = `FAIL. Harness still open: ${owed.slice(0, 6).join(", ")}`;
        const closed = await closeWith(forced, { allowRetry: false, wantDone: false });
        if (!closed) continue;
        return closed;
      }
      const lied = toolFailed && (
        inventedPrint(reply.content, `${lastAct.detail || ""}\n${lastAct.blurb || ""}\n${lastAct.note || ""}`)
        || /^\s*pass\b/i.test(reply.content || "")
      );
      if (lied) {
        emit({ type: "retract" });
        const forced = `FAIL. ${String(lastAct.note || lastAct.detail || lastAct.blurb || "The last tool failed.").slice(0, 500)}`;
        const closed = await closeWith(forced, { allowRetry: false, wantDone: false });
        if (!closed) continue;
        return closed;
      }
      if (toolFailed && rounds < maxRounds && failNudges < 1) {
        failNudges += 1;
        keepAdvice();
        messages.push({
          role: "user",
          content: `The last tool failed: ${String(lastAct.note || lastAct.detail || lastAct.blurb || "").slice(0, 500)}. Fix that error. Do not describe a different printout.`,
        });
        continue;
      }
      if (factAsk(userText) && !admitsUnknown(reply.content) && rounds < maxRounds) {
        if (!ground.seen()) {
          emit({ type: "tool", name: "ground", pack: "hnl", args: "" });
          emit({
            type: "tool_result",
            name: "ground",
            pack: "hnl",
            ok: false,
            blurb: "no source this turn",
            detail: "Search or read before stating a fact.",
          });
          messages.push({
            role: "user",
            content: "You did not look this up. Search, read a file, or say you don't know. Do not invent facts.",
          });
          continue;
        }
        const missing = ground.unsupported(reply.content, userText);
        if (missing.length) {
          const aboutFolder = missing.includes("this folder");
          emit({ type: "tool", name: "ground", pack: "hnl", args: missing.join(", ") });
          emit({
            type: "tool_result",
            name: "ground",
            pack: "hnl",
            ok: false,
            blurb: aboutFolder ? "read this folder" : `not in source: ${missing.join(", ")}`,
            detail: aboutFolder ? "A web page is not this folder." : "Quote the source or say you don't know.",
          });
          messages.push({
            role: "user",
            content: aboutFolder
              ? "This question is about this folder. Read a file here, or say you don't know. Do not use the web."
              : `Those facts are not in what you read: ${missing.join(", ")}. Quote the source or say you don't know.`,
          });
          continue;
        }
      }
      if (gaveUpEarly(reply.content) && goal && rounds < maxRounds && goalJudges < 4) {
        emit({ type: "retract" });
        messages.push({ role: "assistant", content: reply.content || "" });
        let verdict = null;
        if (layaGoalTrained()) {
          try {
            verdict = goalFromLaya(await readLaya(goalTrace({
              goal,
              ask: userText,
              trail,
              why: "the model said stopped",
            }), "goal"));
          } catch {
            verdict = null;
          }
        }
        const settled = await judgeGoal({ laya: verdict?.detail || "stop sentence", why: "the model said stopped" });
        if (settled.action === "done") break;
        messages.push({ role: "user", content: `Next step: ${settled.step}` });
        continue;
      }
      if (gaveUpEarly(reply.content) && rounds < maxRounds) {
        const progressed = trail.some((row) => row.ok !== false && row.name !== "laya" && row.name !== "term_send" && row.name !== "term_read");
        const next = afterStop({ progressed, tries: loopTries, nudged: goalNudges > 0 });
        if (next === "clear") {
          goalNudges += 1;
          loopTries = 0;
          emit({ type: "retract" });
          messages.push({ role: "assistant", content: reply.content || "" });
          emit({ type: "tool", name: "laya", args: "" });
          emit({ type: "tool_result", name: "laya", ok: true, blurb: "cleared", detail: "repeat failure reset" });
          const note = openFailure
            ? `The repeat failure is reset. Internal goal: ${openFailure}. Main goal: ${goal || "the user's ask"}. Write the result from the tool that worked.`
            : `The repeat failure is reset. ${goalNudge(goal || "the user's ask")}`;
          messages.push({ role: "user", content: note });
          continue;
        }
        if (next === "done" && progressed) {
          emit({ type: "retract" });
          messages.push({ role: "assistant", content: reply.content || "" });
          halt = "write the result from the tool that worked";
          break;
        }
      }
      if (gaveUpEarly(reply.content) && loopTries < LOOP_CONTINUES && rounds < maxRounds && !trail.some((row) => row.ok !== false && row.name !== "laya")) {
        loopTries += 1;
        emit({ type: "retract" });
        messages.push({ role: "assistant", content: reply.content || "" });
        emit({ type: "tool", name: "laya", args: "" });
        emit({
          type: "tool_result",
          name: "laya",
          ok: true,
          blurb: "again",
          detail: `different step · ${loopTries}/${LOOP_CONTINUES}`,
        });
        if (!thinkNext()) await countDown(loopTries);
        messages.push({ role: "user", content: loopContinueNote(loopTries) });
        continue;
      }
      if (goal && rounds < maxRounds && !toolFailed) {
        let verdict = null;
        if (layaGoalTrained()) {
          try {
            verdict = goalFromLaya(await readLaya(goalTrace({
              goal,
              ask: userText,
              trail,
              why: "answering before the goal is checked",
            }), "goal"));
          } catch {
            verdict = null;
          }
        }
        if (goalJudges < 4) {
          const settled = await judgeGoal({
            laya: verdict?.detail || verdict?.action || "none",
            why: "the model answered before the goal was checked",
          });
          if (settled.action === "done") {
            if (!dodgesResult(reply.content)) judgedAnswer = String(reply.content).trim();
            emit({ type: "retract" });
            break;
          }
          messages.push({ role: "assistant", content: reply.content || "" });
          messages.push({ role: "user", content: `Next step: ${settled.step}` });
          continue;
        }
        if (verdict?.action === "done") goalStatus = "done";
        const keep = verdict ? verdict.action === "keep" : goalNudges < 1;
        if (keep && verdict?.action !== "done" && verdict?.action !== "stuck" && goalNudges < 2) {
          goalNudges += 1;
          emit({ type: "tool", name: "laya", args: "" });
          emit({ type: "tool_result", name: "laya", ok: true, blurb: "goal", detail: verdict?.detail || "keep" });
          messages.push({ role: "user", content: goalNudge(goal) });
          continue;
        }
      }
      const closed = await closeWith(reply.content, { allowRetry: true, wantDone: goalStatus === "done" });
      if (!closed) continue;
      return closed;
    }
    messages.push({
      role: "assistant",
      content: reply.content || "",
      tool_calls: reply.tool_calls,
    });
    if (reply.content) emit({ type: "delta", text: "\n" });
    for (const call of reply.tool_calls) {
      aborted(signal);
      const name = realToolName(call.function.name);
      const args = briefArgs(call.function.arguments);
      const sig = toolSig(name, args);
      const count = (seen.get(sig) || 0) + 1;
      seen.set(sig, count);
      let verdict = null;
      if (count === 2 && layaLoopTrained()) {
        try {
          verdict = loopFromLaya(await readLaya(loopTrace({
            ask: userText,
            trail,
            next: { name, args },
          }), "loop"));
        } catch {
          verdict = null;
        }
      }
      const changed = changedSince(trail, sig);
      const why = shouldStopLoop({
        count,
        failedBefore: failed.has(sig),
        verdict,
        changed,
        trustLaya: layaLoopTrained(),
      });
      if (!servesAsk(userText, name, history)) {
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: skipNote(name, userText, history),
        });
        const ready = answerFromAsk(userText, trail);
        if (ready && !goal) {
          halt = "write the result from the tool that worked";
          break;
        }
        continue;
      }
      if (why && !goal && (passedClean() || (/same call/.test(why) && answerFromAsk(userText, trail)))) {
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: `Skipped. ${why}.`,
        });
        halt = "write the result from the tool that worked";
        break;
      }
      if (why && goal && goalJudges < 4) {
        let goalVerdict = null;
        if (layaGoalTrained()) {
          try {
            goalVerdict = goalFromLaya(await readLaya(goalTrace({
              goal,
              ask: userText,
              trail,
              why,
            }), "goal"));
          } catch {
            goalVerdict = null;
          }
        }
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: `Skipped. ${why}.`,
        });
        const settled = await judgeGoal({ laya: goalVerdict?.detail || "none", why });
        if (settled.action === "done") break;
        messages.push({ role: "user", content: `Next step: ${settled.step}` });
        continue;
      }
      if (why) {
        let goalVerdict = null;
        if (goal && layaGoalTrained()) {
          try {
            goalVerdict = goalFromLaya(await readLaya(goalTrace({
              goal,
              ask: userText,
              trail,
              why,
            }), "goal"));
          } catch {
            goalVerdict = null;
          }
        }
        const end = goalHalt({ goal, why, verdict: goalVerdict, trust: layaGoalTrained() });
        const rescue = Boolean(end) && !halt && loopTries < LOOP_CONTINUES && !/blocked/.test(String(end));
        if (rescue) {
          loopTries += 1;
          emit({ type: "tool", name: "laya", args: "" });
          emit({
            type: "tool_result",
            name: "laya",
            ok: true,
            blurb: "again",
            detail: `different step · ${loopTries}/${LOOP_CONTINUES}`,
          });
          if (!thinkNext()) await countDown(loopTries);
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: `Skipped. ${why}. ${loopContinueNote(loopTries)}`,
          });
          continue;
        }
        if (!halt) {
          emit({ type: "tool", name: "laya", args: "" });
          emit({
            type: "tool_result",
            name: "laya",
            ok: !end,
            blurb: end ? "loop" : "goal",
            detail: end || goalVerdict?.detail || "keep",
          });
        }
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: end
            ? `Skipped. ${end}. Answer with what you already have.`
            : `Skipped. ${why}. ${goalNudge(goal)}`,
        });
        if (end) {
          halt = end;
          if (goalVerdict?.action === "done") goalStatus = "done";
        }
        continue;
      }
      const gap = unfinishedArgs(call.function.arguments, requiredFields(offered, name));
      if (gap && repairs < 2) {
        repairs += 1;
        if (!repairName) repairName = name;
        emit({ type: "tool", name, pack: packFor(name), args: call.function.arguments });
        emit({
          type: "tool_result",
          name,
          ok: false,
          blurb: "Unfinished",
          detail: `${name}: ${gap}`,
        });
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: `Unfinished ${name}: ${gap}. Call ${name} again. The arguments must be one finished JSON object.`,
        });
        continue;
      }
      emit({ type: "mood", mood: moodForTool(name), text: name });
      let callArgs = name === "net_report" && onlineAsk(userText)
        ? pinPublicHost(call.function.arguments)
        : call.function.arguments;
      callArgs = searchArgs(name, callArgs);
      emit({ type: "tool", name, pack: packFor(name), args: callArgs });
      const blocked = gate.before(name, callArgs);
      const result = blocked
        ? { ok: false, error: blocked.detail || blocked.blurb, path: blocked.path }
        : name === "say_plain"
          ? await restatePlain(callArgs, history, memory.personality, cfg, signal)
          : await executeTool(name, callArgs, cfg, {
          emit,
          signal,
          depth: 0,
          complete: (list, config, delta, abortSignal, options) => onLane("fast", list, delta, options),
          bot: extra.bot || null,
          role: extra.role || "",
          remote,
          tasker: extra.tasker || "",
          allow: Boolean(extra.allow),
          taskId: extra.taskId || "",
        });
      ground.note(name, result);
      const image = toolImage(name, result);
      if (image) emit({ type: "shot", ...image, name });
      emit({ type: "tool_result", ...describeTool(name, callArgs, result) });
      if (result.held) {
        return {
          assistant: result.error || "Held.",
          messages,
          held: true,
          archive,
          goalStatus,
        };
      }
      let toolText = compactResult(result, { max: local ? 4000 : 24_000 });
      if (result?.ok === false) {
        const why = String(result.error || result.stderr || result.note || "it failed");
        openFailure = failureGoal({ name, detail: why, goal });
        toolText += `\n\nInternal goal: ${openFailure}. Compare it to the main goal. Do not repeat this call.`;
        emit({ type: "goal", text: goal, check: "open", opposite: openFailure });
      }
      const proof = blocked || await gate.after(name, callArgs, result);
      if (proof) {
        lastProof = proof;
        emit({ type: "tool", name: "harness", pack: "host", args: proof.path });
        emit({ type: "tool_result", ...proof });
        if (proof.held) return { assistant: proof.detail || proof.blurb, messages, held: true, archive, goalStatus };
        toolText += `\n\nHARNESS ${proof.ok ? "PASS" : "FAIL"}: ${proof.detail || proof.blurb}`;
        if (proof.stdout) toolText += `\nstdout:\n${proof.stdout}`;
      }
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: toolText,
      });
      const note = name === "host_listen_ports" && result?.stdout
        ? String(result.stdout).slice(0, 8000)
        : toolNote(result);
      const harnessFailed = Boolean(proof && proof.ok === false);
      trail.push({
        name,
        args: name === "net_report" ? callArgs : args,
        sig,
        ok: result?.ok !== false && !harnessFailed,
        note: harnessFailed
          ? String(proof.detail || proof.blurb || note || "").slice(0, 800)
          : proof?.ok ? `${note}\nharness PASS${proof.stdout ? ` · stdout: ${proof.stdout}` : ""}` : note,
        passed: Boolean(proof?.ok),
        filePath: /^(host_file_read|host_file_write)$/.test(name) ? result?.path : undefined,
        fileBytes: /^(host_file_read|host_file_write)$/.test(name) ? result?.bytes : undefined,
      });
      const want = wantedTools(userText, history);
      if (!goal && want.includes(name) && answerFromAsk(userText, trail)) {
        halt = "write the result from the tool that worked";
        break;
      }
      if (result?.ok === false) failed.add(sig);
      else if (loopTries > 0) loopTries = 0;
      if (image && !local && !(extra.role === "phone" && image.kind === "paint")) {
        const caption = image.kind === "paint"
          ? "Generated image from Studio ComfyUI. Show this to the user."
          : `${name} screenshot. Coordinates match this image. Origin top-left.`;
        messages.push({
          role: "user",
          content: [
            { type: "text", text: caption },
            { type: "image_url", image_url: { url: image.dataUrl } },
          ],
        });
      }
    }
    if (halt) break;
  }
  const stuck = goal && goalStatus !== "done"
    ? `Do not call another tool. Use the tool results above. Goal still open: ${goal}. First line is the result. Do not say you did not call a tool. Do not say only Stopped.`
    : halt
      ? `Do not call another tool. ${halt}. Use the tool results above. First line is the result.`
      : "Do not call another tool. Use the tool results above. First line is the result.";
  if (judgedAnswer) {
    emit({ type: "retract" });
    const closed = await closeWith(judgedAnswer, { allowRetry: false, wantDone: true });
    goalStatus = "done";
    if (closed) closed.goalStatus = "done";
    return closed || { assistant: judgedAnswer, messages: messages.slice(1), goalStatus, archive };
  }
  const ready = answerFromAsk(userText, trail);
  if (ready && !goal) {
    emit({ type: "retract" });
    const closed = await closeWith(ready, { allowRetry: false, wantDone: goalStatus === "done" });
    return closed || { assistant: ready, messages: messages.slice(1), goalStatus, archive };
  }
  messages.push({ role: "user", content: stuck });
  const openGoal = goal && goalStatus !== "done" ? `Goal still open: ${goal}. ` : "";
  try {
    const last = await onLane("think", messages, onDelta, { toolChoice: "none", tools: [] });
    const said = String(last.content || "").trim();
    const evidence = answerFromAsk(userText, trail)
      || (passedClean() ? `PASS. ${lastProof.blurb.split(lastProof.path).join(basename(lastProof.path))}` : "");
    const dodge = dodgesResult(said) || (last.tool_calls.length > 0 && Boolean(evidence));
    const owed = answerOnly ? [] : gate.debt();
    const lastBad = [...trail].reverse().find((row) => row.ok === false && row.name !== "laya" && row.name !== "ground");
    let picked = dodge ? evidence : (said || evidence);
    if (owed.length) picked = `FAIL. Still open: ${owed.slice(0, 6).join("; ")}`;
    else if (wrongWriteBlame(picked, trail)) {
      picked = lastBad
        ? `FAIL. ${lastBad.name} failed. ${String(lastBad.note || "").slice(0, 300)}`
        : "FAIL. The file write succeeded. The job is not done.";
    }
    const draft = plainResult(picked) || (dodge
      ? "Those checks did not answer the question."
      : (halt
      ? `${openGoal}Same call already ran. ${goal ? "The goal is still open." : "Stopping so this turn does not spin."}`
      : `${openGoal}I hit the tool cap. Say go and I’ll continue from here.`));
    const closed = await closeWith(draft, { allowRetry: false, wantDone: goalStatus === "done" });
    return closed || { assistant: draft, messages: messages.slice(1), goalStatus, archive };
  } catch {
    emit({ type: "mood", mood: "idle", text: "here" });
    return {
      assistant: halt
        ? `${openGoal}Same call already ran. ${goal ? "The goal is still open." : "Stopping so this turn does not spin."}`
        : `${openGoal}I hit the tool cap. Say go and I’ll continue from here.`,
      messages: messages.slice(1),
      goalStatus,
      archive,
    };
  }
}
