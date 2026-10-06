// @effect-diagnostics nodeBuiltinImport:off globalConsole:off preferSchemaOverJson:off - offline analysis of explicitly supplied local lab logs.
import * as NodeFSP from "node:fs/promises";
import { coordinationMetrics } from "../src/peerHub/coordinationMetrics.ts";
const files = process.argv.slice(2);
if (files.length === 0)
  throw new Error("Usage: node apps/server/scripts/peer-coordination-report.ts <broker.jsonl>...");
const samples = (await Promise.all(files.map((file) => NodeFSP.readFile(file, "utf8")))).flatMap(
  (text) =>
    text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
);
console.log(JSON.stringify(coordinationMetrics(samples), null, 2));
