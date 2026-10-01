/** Raw keys for the console. Arrows pick a coat. Tab finishes a command. */

import readline from "node:readline";
import { completeInput, themePartial } from "./complete.js";
import { THEME_IDS } from "./themes.js";

export function bindConsole({ screen, onLine, onLeave, isBusy, abortTurn }) {
  let input = "";
  let lockList = false;

  function showThemes(prefer) {
    const needle = lockList ? "" : (prefer || "");
    const names = needle ? THEME_IDS.filter((id) => id.startsWith(needle)) : THEME_IDS;
    const use = names.length ? names : THEME_IDS;
    const current = screen.themeId();
    const rows = use.map((id) => ({
      id,
      label: id,
      hint: id === current ? "on" : "",
      fill: `/theme ${id}`,
      run: true,
    }));
    let index = needle ? rows.findIndex((row) => row.id.startsWith(needle)) : -1;
    if (index < 0) index = rows.findIndex((row) => row.id === current);
    if (index < 0) index = 0;
    screen.setMenu({ kind: "theme", rows, index });
  }

  function showCommands(options, index = 0) {
    if (options.length < 2) {
      screen.clearMenu();
      return;
    }
    screen.setMenu({ kind: "complete", rows: options, index });
  }

  function reset() {
    input = "";
    lockList = false;
    screen.setInput("");
    screen.clearMenu();
  }

  function submit(line) {
    reset();
    screen.say(`you  ${line}`);
    onLine(line);
  }

  function applyTheme(id) {
    const name = screen.applyTheme(id);
    reset();
    if (name) screen.say(`theme  ${name}`);
    else screen.say(`No coat ${id}. ${THEME_IDS.join(" ")}`);
  }

  function onTab(shift) {
    const step = shift ? -1 : 1;
    const partial = themePartial(input);
    if (partial !== null || screen.menuKind() === "theme") {
      const matches = THEME_IDS.filter((id) => id.startsWith(partial || ""));
      const typed = input.trim().toLowerCase();
      if (partial && matches.length === 1 && typed !== `/theme ${matches[0]}`) {
        input = `/theme ${matches[0]}`;
        lockList = false;
        screen.setInput(input);
        showThemes(matches[0]);
        return;
      }
      if (screen.menuKind() !== "theme") {
        lockList = false;
        showThemes(partial || "");
        return;
      }
      lockList = true;
      const row = screen.moveMenu(step);
      if (row) {
        input = row.fill;
        screen.setInput(input);
      }
      return;
    }
    if (screen.menuKind() === "complete") {
      const row = screen.moveMenu(step);
      if (!row) return;
      input = row.fill;
      screen.setInput(input);
      if (themePartial(input.trim()) !== null) showThemes("");
      return;
    }
    const result = completeInput(input);
    if (!result.options.length) return;
    if (result.options.length === 1) {
      input = result.options[0].fill;
      screen.setInput(input);
      if (themePartial(input.trim()) !== null) showThemes("");
      return;
    }
    input = result.filled;
    screen.setInput(input);
    showCommands(result.options, 0);
  }

  function onEnter() {
    const partial = themePartial(input.trim());
    if (screen.menuKind() === "theme") {
      const typed = input.trim().toLowerCase();
      const id = screen.menuRow()?.id || "";
      if ((typed === "/theme" || typed === "/themes") && id === screen.themeId()) return;
      if (partial && !THEME_IDS.some((name) => name.startsWith(partial))) {
        reset();
        screen.say(`No coat ${partial}. ${THEME_IDS.join(" ")}`);
        return;
      }
      if (id) applyTheme(id);
      return;
    }
    if (partial && THEME_IDS.includes(partial)) {
      applyTheme(partial);
      return;
    }
    if (screen.menuKind() === "complete") {
      const row = screen.menuRow();
      if (!row) return submit(input);
      if (row.run) return submit(row.fill.trim());
      input = row.fill;
      screen.setInput(input);
      screen.clearMenu();
      if (themePartial(input.trim()) !== null) showThemes("");
      return;
    }
    submit(input);
  }

  function onArrow(delta) {
    if (themePartial(input) !== null || screen.menuKind() === "theme") {
      if (screen.menuKind() !== "theme") {
        lockList = false;
        showThemes(themePartial(input) || "");
      }
      lockList = true;
      const row = screen.moveMenu(delta);
      if (row) {
        input = row.fill;
        screen.setInput(input);
      }
      return;
    }
    if (!input.trim().startsWith("/")) return;
    if (screen.menuKind() !== "complete") {
      const result = completeInput(input);
      if (result.options.length < 2) return;
      showCommands(result.options, delta < 0 ? result.options.length - 1 : 0);
      const row = screen.menuRow();
      if (row) {
        input = row.fill;
        screen.setInput(input);
      }
      return;
    }
    const row = screen.moveMenu(delta);
    if (!row) return;
    input = row.fill;
    screen.setInput(input);
    if (themePartial(input.trim()) !== null) showThemes("");
  }

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("keypress", (str, key) => {
    if (key?.ctrl && key.name === "c") {
      if (isBusy() && abortTurn) {
        abortTurn();
        return;
      }
      onLeave();
      return;
    }
    if (isBusy()) return;
    if (key?.name === "escape" || key?.sequence === "\x1b") {
      screen.clearMenu();
      return;
    }
    if (key?.name === "tab" || key?.sequence === "\t") return onTab(Boolean(key.shift));
    if (key?.name === "up" || key?.sequence === "\x1b[A" || key?.sequence === "\x1bOA") return onArrow(-1);
    if (key?.name === "down" || key?.sequence === "\x1b[B" || key?.sequence === "\x1bOB") return onArrow(1);
    if (key?.name === "return" || key?.name === "enter") return onEnter();
    if (key?.name === "backspace" || key?.name === "delete") input = input.slice(0, -1);
    else if (key?.ctrl && key.name === "u") input = "";
    else if (key?.name === "left" || key?.name === "right") return;
    else if (str && str >= " " && !str.startsWith("\x1b") && !key?.ctrl && !key?.meta) input += str;
    else return;
    lockList = false;
    screen.setInput(input);
    const partial = themePartial(input);
    if (partial !== null) showThemes(partial);
    else if (screen.menuKind() === "theme") screen.clearMenu();
    else if (screen.menuKind() === "complete") {
      const result = completeInput(input);
      if (result.kind === "complete" && result.options.length > 1) showCommands(result.options, 0);
      else screen.clearMenu();
    }
  });
}
