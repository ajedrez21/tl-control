import { readFileSync, writeFileSync } from "node:fs";

const data = JSON.parse(readFileSync("tmp-sp-out.json", "utf8"));
const compact = {
  attachments: data.attachments,
  traces: data.traces.map((t: any) => ({
    azureId: t.azureId,
    title: t.title,
    screen: t.screen,
    screenInferred: t.screenInferred,
    screenSource: t.screenSource,
    captures: t.captures,
    frontendPages: t.frontendPages,
    apis: t.apis.map((a: any) => `${a.method ?? "?"} ${a.path} → ${a.sps.join(",") || "?"} [${a.usage}] ${a.controller}`),
    reads: t.reads,
    writes: t.writes,
    unknown: t.unknown,
    explanation: t.explanation,
    codeNote: t.codeNote,
    missingContract: t.missingContract
  }))
};
writeFileSync("tmp-sp-compact.json", JSON.stringify(compact, null, 2));
process.stdout.write("ok\n");
