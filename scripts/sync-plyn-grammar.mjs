#!/usr/bin/env node
// Refresh src/plain/plain.tmLanguage.json from plyn (https://github.com/plainlang/plyn, MIT), the ***plain
// editor extension: the panels highlight spec diffs with its grammar. From a local clone when one is given,
// else from plyn's main branch on GitHub.
//
//   npm run grammar:sync                 # from GitHub
//   npm run grammar:sync -- ../plyn      # from a clone
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const target = new URL("../src/plain/plain.tmLanguage.json", import.meta.url);
const clone = process.argv[2];
const text = clone !== undefined
  ? readFileSync(join(clone, "syntaxes", "plain.tmLanguage.json"), "utf8")
  : await (await fetch("https://raw.githubusercontent.com/plainlang/plyn/main/syntaxes/plain.tmLanguage.json")).text();
JSON.parse(text);
writeFileSync(target, text);
console.log(`plain.tmLanguage.json updated from ${clone ?? "github.com/plainlang/plyn"}`);
