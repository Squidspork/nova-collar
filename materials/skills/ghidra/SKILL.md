# Ghidra MCP

Use this pack for an existing project open in the user's Ghidra desktop window. Normal app and binary investigations use the bundled Software analysis pack. This project route requires the desktop Ghidra MCP plugin at 127.0.0.1:8089 while its project window is open.

## Decide
- A function, cross-reference, or string in an existing desktop project → pack ghidra.
- A new binary or app investigation → pack analysis; no desktop window is needed.
- "What is Ghidra" or any general explanation → answer in words. Do not open the pack.
- Source you can open in the working directory → host file tools, not Ghidra.
- A site, a port, Docker, or this Mac's screen → those packs, not Ghidra.

## Order
1. ghidra_status. If Ghidra is closed, say so and stop.
2. ghidra_programs. If none are open, say to import the file in the Ghidra window and stop.
3. If more than one program is open, pass its name on every later call.
4. ghidra_functions when you need a name. Then one ghidra_decompile, or ghidra_xrefs, or ghidra_strings.

## Do not
- Do not invent pseudocode. Quote only what the tool returned.
- Do not rename, patch, or script the program. This pack is read-only.
- Do not write an exploit, a crack, or a way to hide or improve malware. Report what the code does.
- Do not use host_run to drive Ghidra when these tools exist.
