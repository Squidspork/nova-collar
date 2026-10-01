/** Ask-as-you-go install. One question at a time. Enter keeps the default. */

import { createInterface } from "node:readline";
import {
  applyEndpoint,
  applyFound,
  applyPull,
  choiceList,
  inspectInstall,
  linkNp,
  parseChoice,
} from "./install.js";

function ask(rl, prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(String(answer || "").trim()));
  });
}

function askHidden(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    if (!process.stdin.isTTY) {
      resolve("");
      return;
    }
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    let buf = "";
    const onData = (chunk) => {
      const text = chunk.toString();
      if (text === "\u0003") {
        stdin.setRawMode(false);
        process.stdout.write("\n");
        process.exit(1);
      }
      if (text === "\r" || text === "\n" || text === "\u0004") {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.off("data", onData);
        process.stdout.write("\n");
        resolve(buf);
        return;
      }
      if (text === "\u007f" || text === "\b") {
        buf = buf.slice(0, -1);
        return;
      }
      buf += text;
    };
    stdin.on("data", onData);
  });
}

function say(text) {
  process.stdout.write(`${text}\n`);
}

export async function runInstaller(argv = []) {
  const scanOnly = argv.includes("--scan");
  const yes = argv.includes("--yes");
  const info = await inspectInstall();
  if (scanOnly) {
    const pub = {
      memory: info.memory,
      found: info.found.map((row) => ({ name: row.name, url: row.url, models: row.models, kind: row.kind })),
      laya: { ready: info.laya.ready, diskGb: info.laya.diskGb, ramGb: info.laya.ramGb },
      localFit: info.localFit,
    };
    process.stdout.write(`${JSON.stringify(pub, null, 2)}\n`);
    return 0;
  }

  say("Nova Collar install");
  say("");
  say("Bring your own model. Nova Collar is not locked to one.");
  say(`This computer has ${info.memory.totalGb} GB of memory.`);
  say(`Laya, the small decider, needs about ${info.laya.diskGb} GB on disk and ${info.laya.ramGb} GB while it chooses.`);
  say(info.laya.ready ? "Laya is already in this copy." : "Laya is optional. The window runs without it. materials/catalog.json names the download when you want it.");
  say("");
  if (info.found.length) {
    say("Already answering on this computer:");
    for (const row of info.found) say(`  ${row.name}: ${(row.models || []).slice(0, 6).join(", ") || "no names"}`);
    say("");
  }
  for (const line of choiceList(info)) say(line);
  say("");

  if (yes || !process.stdin.isTTY) {
    say("The model already saved on this computer was left as it is.");
    const linked = linkNp();
    say(linked.note || (linked.linked ? `nova-collar is ${linked.path}` : "nova-collar was left as it is."));
    say("Install finished. Open Nova Collar, or run nova-collar.");
    return 0;
  }

  const rlPick = createInterface({ input: process.stdin, output: process.stdout });
  const choice = parseChoice(await ask(rlPick, "Where should answers come from? [1]: "), info);
  rlPick.close();
  if (choice.error) {
    say(choice.error);
    return 1;
  }

  if (choice.source === "endpoint") {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const url = await ask(rl, "Model address (https://…/v1): ");
    const model = await ask(rl, "Model name: ");
    rl.close();
    let chatKey = "";
    if (process.stdin.isTTY) {
      say("Paste a key if that address wants one, or press enter.");
      chatKey = await askHidden("Key: ");
    }
    const saved = applyEndpoint({ url, model, chatKey });
    if (!saved.ok) {
      say(saved.error);
      return 1;
    }
    say(`Using ${saved.model}.`);
  } else if (choice.source === "found") {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const hit = info.found[0];
    say(`${hit.name} models: ${(hit.models || []).join(", ")}`);
    const name = await ask(rl, `Model [${hit.models?.[0] || ""}]: `);
    rl.close();
    const saved = applyFound(hit, name || hit.models?.[0]);
    if (!saved.ok) {
      say(saved.error);
      return 1;
    }
    say(`Using ${saved.localModel || saved.model}.`);
  } else {
    say(`Downloading ${choice.model}. This can take a while.`);
    const saved = await applyPull((line) => say(line));
    if (!saved.ok) {
      say(saved.error || "The download stopped.");
      return 1;
    }
    say(`Using ${saved.localModel}.`);
  }

  {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const link = (await ask(rl, "Put nova-collar on your PATH? [yes]: ")).toLowerCase();
    rl.close();
    if (!link || link === "y" || link === "yes") {
      const linked = linkNp();
      say(linked.note || (linked.linked ? `nova-collar is ${linked.path}` : "nova-collar was left as it is."));
    }
  }
  say("Install finished. Open Nova Collar, or run nova-collar.");
  return 0;
}
