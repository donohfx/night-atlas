import {
  copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  renameSync, rmSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const root = resolve(import.meta.dirname, "..");
const desktop = join(root, "dotfiles/noctalia/plugins/night-atlas-ais");
const shared = [
  "aids.json",
  "atlas-core.mjs",
  "atlas-extras.mjs",
  "atlas-marks.mjs",
  "atlas-reach-table.mjs",
  "atlas-shore.mjs",
  "beam-reach.json",
  "ccg-buoy-matches.json",
  "chart-data.json",
  "chs-marks.json",
  "open-lights.json",
  "seamarks.json",
];
const optionalTrace = "tss-traced.json";

function regularFile(path) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat && !stat.isFile()) throw new Error(`Expected a regular file: ${path}`);
  return stat;
}

function sourceFiles() {
  return shared.map(name => [`live/${name}`, readFileSync(join(root, "web", name))]);
}

function uniqueAnchor(text, anchor) {
  if (!text.includes(anchor) || text.indexOf(anchor) !== text.lastIndexOf(anchor)) {
    throw new Error(`Unrecognized desktop launcher; expected one ${anchor.trim()} anchor`);
  }
}

function extendLauncher(text) {
  const opening = "ASSETS = {\n";
  const closing = "\n}\n";
  uniqueAnchor(text, opening);
  const start = text.indexOf(opening) + opening.length;
  const end = text.indexOf(closing, start);
  if (end < 0) throw new Error("Unrecognized desktop launcher asset table");
  const table = text.slice(start, end);
  const entries = table.split("\n");
  const additions = [];
  for (const name of shared) {
    const mime = name.endsWith(".mjs") ? "text/javascript" : "application/json";
    const entry = `    "/${name}": ("${name}", "${mime}"),`;
    if (entries.includes(entry)) continue;
    if (table.includes(`"/${name}"`)) throw new Error(`Conflicting launcher route: /${name}`);
    additions.push(entry);
  }
  if (additions.length) text = text.slice(0, end) + "\n" + additions.join("\n") + text.slice(end);

  const optionalGuard = `        elif self.path == "/${optionalTrace}":\n`;
  if (!text.includes(optionalGuard)) {
    const assetsGuard = "        elif self.path in ASSETS:\n";
    uniqueAnchor(text, assetsGuard);
    const optionalRoute = optionalGuard +
      `            collection = load_json(ROOT / "live" / "${optionalTrace}", {"type": "FeatureCollection", "features": []})\n` +
      '            self.reply(json.dumps(collection).encode(), "application/json")\n';
    text = text.replace(assetsGuard, optionalRoute + assetsGuard);
  }
  return text;
}

function changedFiles(target, entries) {
  return entries.flatMap(([name, contents]) => {
    const path = join(target, name);
    const stat = regularFile(path);
    const previous = stat ? readFileSync(path) : undefined;
    return previous?.equals(contents) ? [] : [{ name, path, contents, previous, mode: stat?.mode }];
  });
}

function update(target, changes, preserveBackup) {
  const stage = mkdtempSync(join(dirname(target), `.${basename(target)}-stage.`));
  let backup;
  const applied = [];
  try {
    if (preserveBackup) {
      backup = mkdtempSync(join(dirname(target), `${basename(target)}-backup.`));
      mkdirSync(join(backup, "live"));
      const created = changes.filter(change => !change.previous).map(change => change.name);
      writeFileSync(join(backup, "created-files.txt"), created.length ? created.join("\n") + "\n" : "");
      console.log(`Backup: ${backup}`);
    }
    for (const [index, change] of changes.entries()) {
      writeFileSync(join(stage, String(index)), change.contents, { mode: change.mode ?? 0o644 });
      if (change.previous && backup) {
        copyFileSync(change.path, join(backup, change.name));
      }
    }
    for (const [index, change] of changes.entries()) {
      renameSync(join(stage, String(index)), change.path);
      applied.push(change);
    }
  } catch (error) {
    for (const [index, change] of applied.reverse().entries()) {
      if (!change.previous) {
        rmSync(change.path);
        continue;
      }
      const undo = join(stage, `undo-${index}`);
      writeFileSync(undo, change.previous, { mode: change.mode });
      renameSync(undo, change.path);
    }
    throw error;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

function main() {
  const { values } = parseArgs({ options: {
    help: { type: "boolean" },
    check: { type: "boolean" },
    install: { type: "string" },
    apply: { type: "boolean" },
  } });
  if (values.help) {
    console.log("node tools/sync-desktop.mjs [--check | --install PLUGIN_DIR [--apply]]");
    return;
  }
  if ((values.check && values.install) || (values.apply && !values.install)) {
    throw new Error("Use --check for the repo copy or --install PLUGIN_DIR [--apply] for an existing plugin");
  }
  const entries = sourceFiles();
  let target = desktop;
  if (values.install) {
    target = realpathSync(values.install);
    if (target === desktop || !regularFile(join(target, "plugin.toml"))) {
      throw new Error("Use --install with an existing plugin directory outside the repo plugin copy");
    }
    if (!lstatSync(join(target, "live")).isDirectory()) throw new Error("Expected a live/ directory");
    const launcher = join(target, "live_desktop.py");
    if (!regularFile(launcher)) throw new Error("Missing desktop launcher");
    entries.push(["live_desktop.py", Buffer.from(extendLauncher(readFileSync(launcher, "utf8")))]);
    const map = "live/map.mjs";
    if (!regularFile(join(target, map))) throw new Error("Missing desktop map entry");
    entries.push([map, readFileSync(join(desktop, map))]);
  }
  const changes = changedFiles(target, entries);
  if (!changes.length) {
    console.log("Night Atlas desktop files are current");
    return;
  }
  const names = changes.map(change => change.name).join("\n  ");
  if (values.check) throw new Error(`Stale Night Atlas desktop files:\n  ${names}\nRun npm run sync:desktop`);
  const dryRun = values.install && !values.apply;
  console.log(`${dryRun ? "Would update" : "Updating"} ${target}:\n  ${names}`);
  if (!dryRun) update(target, changes, Boolean(values.install));
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
