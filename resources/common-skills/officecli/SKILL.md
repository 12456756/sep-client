---
name: officecli
description: Create, read, inspect and edit Word (.docx), Excel (.xlsx) and PowerPoint (.pptx) documents with the client's built-in OfficeCLI tool. No Microsoft Office installation is required for these supported commands.
---

# Office documents

This client provides OfficeCLI 1.0.156 as `mcp__officecli__officecli`.
Do not download, install, update or locate another executable. Do not use a shell
to bypass a denied Office operation. If the tool is not available, report that
the built-in Office capability is unavailable; use other permitted tools only.

## Commands

Use argument arrays: each array element is one argument. No shell quoting is
required inside the elements. Paths come from the current task, its attachments
and accepted dependency deliveries, not from another employee's private files.
Read help before guessing a property, selector or element name:

```json
{"command":["help","docx","paragraph","--json"]}
{"command":["help","xlsx","cell","--json"]}
{"command":["help","pptx","shape","--json"]}
```

Prefer structural reads, then normal document edits. Supported commands include
help, create, view, get, query, validate, raw (read only), dump, add, set, remove,
move, swap, import, batch, save and close. Administrative commands, resident and
preview servers, raw XML writes, plugins and active/external content are not
enabled by this integration. Permissions and approvals still apply.

```json
{"command":["create","deliverables/report.docx"]}
{"command":["add","deliverables/report.docx","/body","--type","paragraph","--prop","text=Executive summary","--prop","style=Heading1"]}
{"command":["create","deliverables/data.xlsx"]}
{"command":["set","deliverables/data.xlsx","/Sheet1/A1","--prop","value=Name","--prop","bold=true"]}
{"command":["create","deliverables/slides.pptx"]}
{"command":["add","deliverables/slides.pptx","/","--type","slide","--prop","title=Overview"]}
{"command":["get","deliverables/report.docx","/body","--json"]}
```

Use `batch` with inline `--commands` JSON for multiple edits to one file. Each
item is an object, not a command line; do not use stdin or a batch script file:

```json
{"command":["batch","deliverables/report.docx","--commands","[{\"command\":\"add\",\"parent\":\"/body\",\"type\":\"paragraph\",\"props\":{\"text\":\"First finding\"}},{\"command\":\"add\",\"parent\":\"/body\",\"type\":\"paragraph\",\"props\":{\"text\":\"Second finding\"}}]"]}
```

## Delivery and verification

Keep investigation files in the task's designated intermediate directory and
write final files to its declared delivery paths. Read existing files before
editing them. Do not recreate completed work without checking it first.

Before another tool reads a modified file, or before submitting it, call save
and close, then validate and read back the important content. Do not overwrite
the same file concurrently from multiple workers. If a write times out, inspect
the file before considering another write; a timeout does not prove it failed.

```json
{"command":["save","deliverables/report.docx"]}
{"command":["close","deliverables/report.docx"]}
{"command":["validate","deliverables/report.docx","--json"]}
{"command":["view","deliverables/report.docx","text","--json"]}
```

The MCP bridge currently returns text and structured results, not images to the
model. Structural validation and text readback do not prove visual layout is
correct. The user can use the client's existing preview; do not claim visual
verification without actually inspecting a rendered image through a supported
image-reading tool.

This client adaptation is based on the OfficeCLI 1.0.156 command interface.
OfficeCLI is Copyright 2026 OfficeCLI, licensed under Apache-2.0; see the
licenses distributed alongside the executable.
