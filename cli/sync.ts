import { fetchVersion, requireLogin, resolveWorkspace } from "./context.ts";
import {
  colors,
  Command,
  Confirm,
  ensureDir,
  minimatch,
  JSZip,
  path,
  ScriptService,
  FolderService,
  ResourceService,
  VariableService,
  AppService,
  FlowService,
  OpenFlow,
  FlowModule,
  RawScript,
  log,
  yamlStringify,
  yamlParse,
  ScheduleService,
  SEP,
  gitignore_parser,
} from "./deps.ts";
import {
  getTypeStrFromPath,
  GlobalOptions,
  parseFromPath,
  pushObj,
  showConflict,
  showDiff,
} from "./types.ts";
import { downloadZip } from "./pull.ts";

import { handleScriptMetadata, removeExtensionToPath } from "./script.ts";

import { handleFile } from "./script.ts";
import { deepEqual } from "./utils.ts";
import { read } from "https://deno.land/x/cbor@v1.4.1/decode.js";
import { readConfigFile } from "./conf.ts";

type DynFSElement = {
  isDirectory: boolean;
  path: string;
  // getContentBytes(): Promise<Uint8Array>;
  getContentText(): Promise<string>;
  getChildren(): AsyncIterable<DynFSElement>;
};

async function FSFSElement(p: string): Promise<DynFSElement> {
  function _internal_element(localP: string, isDir: boolean): DynFSElement {
    return {
      isDirectory: isDir,
      path: localP.substring(p.length + 1),
      async *getChildren(): AsyncIterable<DynFSElement> {
        if (!isDir) return [];
        try {
          for await (const e of Deno.readDir(localP)) {
            yield _internal_element(path.join(localP, e.name), e.isDirectory);
          }
        } catch (e) {
          log.warning(`Error reading dir: ${localP}, ${e}`);
        }
      },
      // async getContentBytes(): Promise<Uint8Array> {
      //   return await Deno.readFile(localP);
      // },
      async getContentText(): Promise<string> {
        const content = await Deno.readTextFile(localP);
        return content;
      },
    };
  }
  return _internal_element(p, (await Deno.stat(p)).isDirectory);
}

function prioritizeName(name: string): string {
  if (name == "id") return "aa";
  if (name == "type") return "ab";
  if (name == "summary") return "ad";
  if (name == "name") return "ae";
  if (name == "display_name") return "af";
  if (name == "description") return "ag";
  if (name == "value") return "ah";
  if (name == "content") return "ai";
  if (name == "modules") return "aj";
  if (name == "failure_module") return "ak";
  if (name == "input_transforms") return "al";
  if (name == "lock") return "az";

  return name;
}

export const yamlOptions = {
  sortKeys: (a: any, b: any) => {
    return prioritizeName(a).localeCompare(prioritizeName(b));
  },
  noCompatMode: true,
  noRefs: true,
};

function ZipFSElement(zip: JSZip, useYaml: boolean): DynFSElement {
  function _internal_file(p: string, f: JSZip.JSZipObject): DynFSElement {
    const isFlow = p.endsWith("flow.json");
    function transformPath() {
      if (isFlow) {
        return p.replace("flow.json", "flow");
      } else {
        return useYaml && p.endsWith(".json")
          ? p.replaceAll(".json", ".yaml")
          : p;
      }
    }

    interface InlineScript {
      path: string;
      content: string;
    }

    let counter = 0;
    const seen_names = new Set<string>();
    function assignPath(
      summary: string | undefined,
      language: RawScript.language
    ): string {
      let name;
      if (summary && summary != "" && !seen_names.has(summary)) {
        name = summary.toLowerCase().replaceAll(" ", "_");
        seen_names.add(name);
      } else {
        name = `inline_script_${counter}`;
        while (seen_names.has(name)) {
          counter++;
          name = `inline_script_${counter}`;
        }
        seen_names.add(name);
      }
      let ext;
      if (language == "python3") ext = "py";
      else if (language == "deno") ext = "ts";
      else if (language == "go") ext = "go";
      else if (language == "bash") ext = "sh";
      else if (language == "powershell") ext = "ps1";
      else if (language == "postgresql") ext = "pg.sql";
      else if (language == "mysql") ext = "my.sql";
      else if (language == "bigquery") ext = "bq.sql";
      else if (language == "snowflake") ext = "sf.sql";
      else if (language == "mssql") ext = "ms.sql";
      else if (language == "graphql") ext = "gql";
      else if (language == "bun") ext = "bun.ts";
      else if (language == "nativets") ext = "native.ts";

      return `${name}.inline_script.${ext}`;
    }

    function extractInlineScripts(modules: FlowModule[]): InlineScript[] {
      return modules.flatMap((m) => {
        if (m.value.type == "rawscript") {
          const path = assignPath(m.summary, m.value.language);
          const content = m.value.content;
          m.value.content = "!inline " + path;
          return [{ path: path, content: content }];
        } else if (m.value.type == "forloopflow") {
          return extractInlineScripts(m.value.modules);
        } else if (m.value.type == "branchall") {
          return m.value.branches.flatMap((b) =>
            extractInlineScripts(b.modules)
          );
        } else if (m.value.type == "branchone") {
          return [
            ...m.value.branches.flatMap((b) => extractInlineScripts(b.modules)),
            ...extractInlineScripts(m.value.default),
          ];
        } else {
          return [];
        }
      });
    }

    const flowPath = transformPath();
    return {
      isDirectory: isFlow,
      path: flowPath,
      async *getChildren(): AsyncIterable<DynFSElement> {
        if (isFlow) {
          const flow: OpenFlow = JSON.parse(await f.async("text"));
          const inlineScripts = extractInlineScripts(flow.value.modules);
          for (const s of inlineScripts) {
            yield {
              isDirectory: false,
              path: path.join(flowPath, s.path),
              async *getChildren() {},
              // deno-lint-ignore require-await
              async getContentText() {
                return s.content;
              },
            };
          }

          yield {
            isDirectory: false,
            path: path.join(flowPath, "flow.yaml"),
            async *getChildren() {},
            // deno-lint-ignore require-await
            async getContentText() {
              return yamlStringify(flow, yamlOptions);
            },
          };
        }
      },
      // async getContentBytes(): Promise<Uint8Array> {
      //   return await f.async("uint8array");
      // },
      async getContentText(): Promise<string> {
        const content = await f.async("text");
        return useYaml && p.endsWith(".json")
          ? yamlStringify(JSON.parse(content), yamlOptions)
          : content;
      },
    };
  }
  function _internal_folder(p: string, zip: JSZip): DynFSElement {
    return {
      isDirectory: true,
      path: p,
      async *getChildren(): AsyncIterable<DynFSElement> {
        for (const filename in zip.files) {
          const file = zip.files[filename];
          const totalPath = path.join(p, filename);
          if (file.dir) {
            const e = zip.folder(file.name)!;
            yield _internal_folder(totalPath, e);
          } else {
            yield _internal_file(totalPath, file);
          }
        }
      },
      // // deno-lint-ignore require-await
      // async getContentBytes(): Promise<Uint8Array> {
      //   throw new Error("Cannot get content of folder");
      // },
      // deno-lint-ignore require-await
      async getContentText(): Promise<string> {
        throw new Error("Cannot get content of folder");
      },
    };
  }
  return _internal_folder("." + SEP, zip);
}

async function* readDirRecursiveWithIgnore(
  ignore: (path: string, isDirectory: boolean) => boolean,
  root: DynFSElement
): AsyncGenerator<{
  path: string;
  ignored: boolean;
  isDirectory: boolean;
  // getContentBytes(): Promise<Uint8Array>;
  getContentText(): Promise<string>;
}> {
  const stack: {
    path: string;
    isDirectory: boolean;
    ignored: boolean;
    c(): AsyncIterable<DynFSElement>;
    // getContentBytes(): Promise<Uint8Array>;
    getContentText(): Promise<string>;
  }[] = [
    {
      path: root.path,
      ignored: ignore(root.path, root.isDirectory),
      isDirectory: root.isDirectory,
      c: root.getChildren,
      // getContentBytes(): Promise<Uint8Array> {
      //   throw undefined;
      // },
      getContentText(): Promise<string> {
        throw undefined;
      },
    },
  ];

  while (stack.length > 0) {
    const e = stack.pop()!;
    yield e;
    for await (const e2 of e.c()) {
      stack.push({
        path: e2.path,
        ignored: e.ignored || ignore(e2.path, e2.isDirectory),
        isDirectory: e2.isDirectory,
        // getContentBytes: e2.getContentBytes,
        getContentText: e2.getContentText,
        c: e2.getChildren,
      });
    }
  }
}

type Added = { name: "added"; path: string; content: string };
type Deleted = { name: "deleted"; path: string };
type Edit = { name: "edited"; path: string; before: string; after: string };

type Change = Added | Deleted | Edit;

async function elementsToMap(
  els: DynFSElement,
  ignore: (path: string, isDirectory: boolean) => boolean,
  json: boolean,
  skips: Skips
): Promise<{ [key: string]: string }> {
  const map: { [key: string]: string } = {};
  for await (const entry of readDirRecursiveWithIgnore(ignore, els)) {
    if (entry.isDirectory || entry.ignored) continue;
    const path = entry.path;
    if (json && path.endsWith(".yaml")) continue;
    if (!json && path.endsWith(".json")) continue;
    const ext = json ? ".json" : ".yaml";
    if (!skips.includeSchedules && path.endsWith(".schedule" + ext)) continue;
    if (skips.skipResources && path.endsWith(".resource" + ext)) continue;
    if (skips.skipVariables && path.endsWith(".variable" + ext)) continue;

    if (skips.skipResources && path.endsWith(".resource" + ext)) continue;

    if (
      !["json", "yaml", "go", "sh", "ts", "py", "sql", "gql", "ps1"].includes(
        path.split(".").pop() ?? ""
      )
    )
      continue;
    const content = await entry.getContentText();

    if (skips.skipSecrets && path.endsWith(".variable" + ext)) {
      try {
        let o;
        if (json) {
          o = JSON.parse(content);
        } else {
          o = yamlParse(content);
        }
        if (o["is_secret"]) {
          continue;
        }
      } catch (e) {
        log.warning(`Error reading variable ${path} to check for secrets`);
      }
    }
    map[entry.path] = content;
  }
  return map;
}

interface Skips {
  skipVariables?: boolean | undefined;
  skipResources?: boolean | undefined;
  skipSecrets?: boolean | undefined;
  includeSchedules?: boolean | undefined;
}

async function compareDynFSElement(
  els1: DynFSElement,
  els2: DynFSElement | undefined,
  ignore: (path: string, isDirectory: boolean) => boolean,
  json: boolean,
  skips: Skips
): Promise<Change[]> {
  const [m1, m2] = els2
    ? await Promise.all([
        elementsToMap(els1, ignore, json, skips),
        elementsToMap(els2, ignore, json, skips),
      ])
    : [await elementsToMap(els1, ignore, json, skips), {}];

  const changes: Change[] = [];

  function parseYaml(k: string, v: string) {
    if (k.endsWith(".script.yaml")) {
      const o: any = yamlParse(v);
      if (typeof o == "object" && Array.isArray(o?.["lock"])) {
        o["lock"] = o["lock"].join("\n");
      }
      return o;
    } else {
      return yamlParse(v);
    }
  }
  for (const [k, v] of Object.entries(m1)) {
    if (m2[k] === undefined) {
      changes.push({ name: "added", path: k, content: v });
    } else if (
      m2[k] != v &&
      (!k.endsWith(".json") || !deepEqual(JSON.parse(v), JSON.parse(m2[k]))) &&
      (!k.endsWith(".yaml") || !deepEqual(parseYaml(k, v), parseYaml(k, m2[k])))
    ) {
      changes.push({ name: "edited", path: k, after: v, before: m2[k] });
    }
  }

  for (const [k] of Object.entries(m2)) {
    if (
      m1[k] === undefined &&
      !k?.endsWith(".script.yaml") &&
      !k?.endsWith(".script.json")
    ) {
      changes.push({ name: "deleted", path: k });
    }
  }

  return changes;
}

const isNotWmillFile = (p: string, isDirectory: boolean) => {
  if (p.endsWith(SEP)) {
    return false;
  }
  if (isDirectory) {
    return (
      !p.startsWith("u" + SEP) &&
      !p.startsWith("f" + SEP) &&
      !p.startsWith("g" + SEP)
    );
  }

  try {
    const typ = getTypeStrFromPath(p);
    if (typ == "resource-type") {
      return p.includes(SEP);
    } else {
      return (
        !p.startsWith("u" + SEP) &&
        !p.startsWith("f" + SEP) &&
        !p.startsWith("g" + SEP)
      );
    }
  } catch {
    return true;
  }
};

export const isWhitelisted = (p: string) => {
  return p == "." + SEP || p == "" || p == "u" || p == "f" || p == "g";
};

export async function ignoreF(): Promise<
  (p: string, isDirectory: boolean) => boolean
> {
  const wmillconf = await readConfigFile();

  let whitelist: { approve(file: string): boolean } | undefined = undefined;

  if (wmillconf?.includes) {
    if (!Array.isArray(wmillconf.includes)) {
      throw new Error("wmill.yaml/includes must be an array");
    }
    if (wmillconf.includes.length > 0) {
      whitelist = {
        approve(file: string): boolean {
          return wmillconf.includes!.some((i) => minimatch(file, i));
        },
      };
    }
  }
  let ign:
    | {
        denies(file: string): boolean;
      }
    | undefined = undefined;
  try {
    const ignoreContent = await Deno.readTextFile(".wmillignore");
    const condensed = ignoreContent
      .split("\n")
      .filter((l) => l != "" && !l.startsWith("#"))
      .join(", ");
    log.info(
      colors.gray(
        `(Deprecated, use wmill.conf/includes instead) Using .wmillignore file (${condensed})`
      )
    );
    ign = gitignore_parser.compile(ignoreContent);
  } catch {}

  if (ign && whitelist) {
    throw new Error("Cannot have both .wmillignore and wmill.yaml/includes");
  }

  // new Gitignore.default({ initialRules: ignoreContent.split("\n")}).ignoreContent).compile();
  return (p: string, isDirectory: boolean) => {
    return (
      !isWhitelisted(p) &&
      (isNotWmillFile(p, isDirectory) ||
        (!isDirectory &&
          ((whitelist != undefined && !whitelist.approve(p)) ||
            (ign != undefined && ign.denies(p)))))
    );
  };
}

async function pull(
  opts: GlobalOptions & {
    raw: boolean;
    yes: boolean;
    failConflicts: boolean;
    plainSecrets?: boolean;
    json?: boolean;
    skipVariables?: boolean;
    skipResources?: boolean;
    skipSecrets?: boolean;
    includeSchedules?: boolean;
  }
) {
  if (!opts.raw) {
    await ensureDir(path.join(Deno.cwd(), ".wmill"));
  }

  const workspace = await resolveWorkspace(opts);
  await requireLogin(opts);

  log.info(
    colors.gray(
      "Computing the files to update locally to match remote (taking .wmillignore into account)"
    )
  );
  const remote = ZipFSElement(
    (await downloadZip(
      workspace,
      opts.plainSecrets,
      opts.skipVariables,
      opts.skipResources,
      opts.skipSecrets,
      opts.includeSchedules
    ))!,
    !opts.json
  );
  const local = opts.raw
    ? await FSFSElement(Deno.cwd())
    : await FSFSElement(path.join(Deno.cwd(), ".wmill"));
  const changes = await compareDynFSElement(
    remote,
    local,
    await ignoreF(),
    opts.json ?? false,
    opts
  );

  log.info(
    `remote (${workspace.name}) -> local: ${changes.length} changes to apply`
  );
  if (changes.length > 0) {
    prettyChanges(changes);
    if (
      !opts.yes &&
      !(await Confirm.prompt({
        message: `Do you want to apply these ${changes.length} changes?`,
        default: true,
      }))
    ) {
      return;
    }

    const conflicts = [];
    log.info(colors.gray(`Applying changes to files ...`));
    for await (const change of changes) {
      const target = path.join(Deno.cwd(), change.path);
      const stateTarget = path.join(Deno.cwd(), ".wmill", change.path);
      if (change.name === "edited") {
        try {
          const currentLocal = await Deno.readTextFile(target);
          if (currentLocal !== change.before && currentLocal !== change.after) {
            log.info(
              colors.red(
                `Conflict detected on ${change.path}\nBoth local and remote have been modified.`
              )
            );
            if (opts.failConflicts) {
              conflicts.push({
                local: currentLocal,
                change,
                path: change.path,
              });
              continue;
            } else if (opts.yes) {
              log.info(
                colors.red(
                  `Override local version with remote since --yes was passed and no --fail-conflicts.`
                )
              );
            } else {
              showConflict(change.path, currentLocal, change.after);
              if (
                await Confirm.prompt(
                  "Preserve local (push to change remote and avoid seeing this again)?"
                )
              ) {
                continue;
              }
            }
          }
        } catch {
          // ignore
        }
        if (!change.path.endsWith(".json") && !change.path.endsWith(".yaml")) {
          log.info(`Editing script content of ${change.path}`);
        } else {
          log.info(`Editing ${getTypeStrFromPath(change.path)} ${change.path}`);
        }
        await Deno.writeTextFile(target, change.after);

        if (!opts.raw) {
          await ensureDir(path.dirname(stateTarget));
          await Deno.copyFile(target, stateTarget);
        }
      } else if (change.name === "added") {
        await ensureDir(path.dirname(target));
        if (!opts.raw) {
          await ensureDir(path.dirname(stateTarget));
          log.info(`Adding ${getTypeStrFromPath(change.path)} ${change.path}`);
        }
        await Deno.writeTextFile(target, change.content);
        log.info(`Writing ${getTypeStrFromPath(change.path)} ${change.path}`);
        if (!opts.raw) {
          await Deno.copyFile(target, stateTarget);
        }
      } else if (change.name === "deleted") {
        try {
          log.info(
            `Deleting ${getTypeStrFromPath(change.path)} ${change.path}`
          );
          await Deno.remove(target);
          if (!opts.raw) {
            await Deno.remove(stateTarget);
          }
        } catch {
          if (!opts.raw) {
            await Deno.remove(stateTarget);
          }
        }
      }
    }
    if (opts.failConflicts) {
      if (conflicts.length > 0) {
        console.error(colors.red(`Conflicts were found`));
        log.info("Conflicts:");
        for (const conflict of conflicts) {
          showConflict(conflict.path, conflict.local, conflict.change.after);
        }
        log.info(
          colors.red(`Please resolve theses conflicts manually by either:
  - reverting the content back to its remote (\`wmill pull\` and refuse to preserve local when prompted)
  - pushing the changes with \`wmill push --skip-pull\` to override wmill with all your local changes
`)
        );
        Deno.exit(1);
      }
    }
    log.info(
      colors.bold.green.underline(
        `\nDone! All ${changes.length} changes applied locally.`
      )
    );
  }
}

function prettyChanges(changes: Change[]) {
  for (const change of changes) {
    if (change.name === "added") {
      log.info(
        colors.green(`+ ${getTypeStrFromPath(change.path)} ` + change.path)
      );
    } else if (change.name === "deleted") {
      log.info(
        colors.red(`- ${getTypeStrFromPath(change.path)} ` + change.path)
      );
    } else if (change.name === "edited") {
      log.info(
        colors.yellow(`~ ${getTypeStrFromPath(change.path)} ` + change.path)
      );
      showDiff(change.before, change.after);
    }
  }
}

// function prettyDiff(diffs: Difference[]) {
//   for (const diff of diffs) {
//     let pathString = "";
//     for (const pathSegment of diff.path) {
//       if (typeof pathSegment === "string") {
//         pathString += ".";
//         pathString += pathSegment;
//       } else {
//         pathString += "[";
//         pathString += pathSegment;
//         pathString += "]";
//       }
//     }
//     if (diff.type === "REMOVE" || diff.type === "CHANGE") {
//      log.info(colors.red("- " + pathString + " = " + diff.oldValue));
//     }
//     if (diff.type === "CREATE" || diff.type === "CHANGE") {
//      log.info(colors.green("+ " + pathString + " = " + diff.value));
//     }
//   }
// }

function removeSuffix(str: string, suffix: string) {
  return str.slice(0, str.length - suffix.length);
}

async function push(
  opts: GlobalOptions & {
    raw: boolean;
    yes: boolean;
    skipPull: boolean;
    failConflicts: boolean;
    plainSecrets?: boolean;
    json?: boolean;
    skipVariables?: boolean;
    skipResources?: boolean;
    skipSecrets?: boolean;
    includeSchedules?: boolean;
    message?: string;
  }
) {
  if (!opts.raw) {
    if (!opts.skipPull) {
      log.info(
        colors.gray("You need to be up-to-date before pushing, pulling first.")
      );
      await pull(opts);
      log.info(colors.green("Pull done, now pushing."));
      log.info("\n");
    }
  }

  const workspace = await resolveWorkspace(opts);
  await requireLogin(opts);

  log.info(
    colors.gray(
      "Computing the files to update on the remote to match local (taking .wmillignore into account)"
    )
  );
  const remote = ZipFSElement(
    (await downloadZip(
      workspace,
      opts.plainSecrets,
      opts.skipVariables,
      opts.skipResources,
      opts.skipSecrets,
      opts.includeSchedules
    ))!,
    !opts.json
  );

  const local = await FSFSElement(path.join(Deno.cwd(), ""));
  const changes = await compareDynFSElement(
    local,
    remote,
    await ignoreF(),
    opts.json ?? false,
    opts
  );

  const version = await fetchVersion(workspace.remote);

  log.info(colors.gray("Remote version: " + version));

  const reducedVersion = version
    .split(" v")[1]
    .split("-")[0]
    .split(".")
    .map((v) => parseInt(v));
  const lockfileUseArray =
    reducedVersion[1] < 246 ||
    reducedVersion[1] == 246 ||
    reducedVersion[2] < 5;
  log.info(
    `remote (${workspace.name}) <- local: ${changes.length} changes to apply`
  );

  if (changes.length > 0) {
    prettyChanges(changes);
    if (
      !opts.yes &&
      !(await Confirm.prompt({
        message: `Do you want to apply these ${changes.length} changes?`,
        default: true,
      }))
    ) {
      return;
    }
    log.info(colors.gray(`Applying changes to files ...`));

    const alreadySynced: string[] = [];
    for await (const change of changes) {
      const stateTarget = path.join(Deno.cwd(), ".wmill", change.path);
      let stateExists = true;
      try {
        await Deno.stat(stateTarget);
      } catch {
        stateExists = false;
      }

      if (change.name === "edited") {
        if (
          await handleScriptMetadata(
            change.path,
            workspace,
            alreadySynced,
            opts.message,
            lockfileUseArray
          )
        ) {
          if (!opts.raw && stateExists) {
            await Deno.writeTextFile(stateTarget, change.after);
          }
          continue;
        } else if (
          await handleFile(
            change.path,
            workspace,
            alreadySynced,
            opts.message,
            lockfileUseArray,
            opts
          )
        ) {
          if (!opts.raw && stateExists) {
            await Deno.writeTextFile(stateTarget, change.after);
          }
          continue;
        }
        if (!opts.raw) {
          await ensureDir(path.dirname(stateTarget));
          log.info(`Editing ${getTypeStrFromPath(change.path)} ${change.path}`);
        }
        const oldObj = parseFromPath(change.path, change.before);
        const newObj = parseFromPath(change.path, change.after);

        await pushObj(
          workspace.workspaceId,
          change.path,
          oldObj,
          newObj,
          opts.plainSecrets ?? false,
          opts.message
        );

        if (!opts.raw && stateExists) {
          await Deno.writeTextFile(stateTarget, change.after);
        }
      } else if (change.name === "added") {
        if (
          change.path.endsWith(".script.json") ||
          change.path.endsWith(".script.yaml")
        ) {
          continue;
        } else if (
          await handleFile(
            change.path,
            workspace,
            alreadySynced,
            opts.message,
            lockfileUseArray,
            opts
          )
        ) {
          continue;
        }
        if (!opts.raw && stateExists) {
          await ensureDir(path.dirname(stateTarget));
          log.info(`Adding ${getTypeStrFromPath(change.path)} ${change.path}`);
        }
        const obj = parseFromPath(change.path, change.content);
        await pushObj(
          workspace.workspaceId,
          change.path,
          undefined,
          obj,
          opts.plainSecrets ?? false,
          opts.message
        );

        if (!opts.raw && stateExists) {
          await Deno.writeTextFile(stateTarget, change.content);
        }
      } else if (change.name === "deleted") {
        log.info(`Deleting ${getTypeStrFromPath(change.path)} ${change.path}`);
        const typ = getTypeStrFromPath(change.path);
        const workspaceId = workspace.workspaceId;
        switch (typ) {
          case "script": {
            const script = await ScriptService.getScriptByPath({
              workspace: workspaceId,
              path: removeExtensionToPath(change.path),
            });
            await ScriptService.deleteScriptByHash({
              workspace: workspaceId,
              hash: script.hash,
            });
            break;
          }
          case "folder":
            await FolderService.deleteFolder({
              workspace: workspaceId,
              name: change.path.split(path.sep)[1],
            });
            break;
          case "resource":
            await ResourceService.deleteResource({
              workspace: workspaceId,
              path: removeSuffix(change.path, ".resource.json"),
            });
            break;
          case "resource-type":
            await ResourceService.deleteResourceType({
              workspace: workspaceId,
              path: removeSuffix(change.path, ".resource-type.json"),
            });
            break;
          case "flow":
            await FlowService.deleteFlowByPath({
              workspace: workspaceId,
              path: removeSuffix(change.path, ".flow/flow.json"),
            });
            break;
          case "app":
            await AppService.deleteApp({
              workspace: workspaceId,
              path: removeSuffix(change.path, ".app.json"),
            });
            break;
          case "schedule":
            await ScheduleService.deleteSchedule({
              workspace: workspaceId,
              path: removeSuffix(change.path, ".schedule.json"),
            });
            break;
          case "variable":
            await VariableService.deleteVariable({
              workspace: workspaceId,
              path: removeSuffix(change.path, ".variable.json"),
            });
            break;
          default:
            break;
        }
        try {
          await Deno.remove(stateTarget);
        } catch {
          // state target may not exist already
        }
      }
    }
    log.info(
      colors.bold.green.underline(
        `\nDone! All ${changes.length} changes pushed to the remote workspace ${workspace.workspaceId} named ${workspace.name}.`
      )
    );
  }
}

const command = new Command()
  .description(
    "sync local with a remote workspaces or the opposite (push or pull)"
  )

  .action(() =>
    log.info("2 actions available, pull and push. Use -h to display help.")
  )
  .command("pull")
  .description(
    "Pull any remote changes and apply them locally. Use --raw for usage without local state tracking."
  )
  .option(
    "--fail-conflicts",
    "Error on conflicts (both remote and local have changes on the same item)"
  )
  .option(
    "--raw",
    "Push without using state, just overwrite. (Will be removed as a flag and made the default behavior in the future)"
  )
  .option("--yes", "Pull without needing confirmation")
  .option(
    "--stateful",
    "Pull using state tracking (create .wmill folder and needed for --fail-conflicts). Default currently but will change in favor of --raw"
  )
  .option("--plain-secrets", "Pull secrets as plain text")
  .option("--json", "Use JSON instead of YAML")
  .option("--skip-variables", "Skip syncing variables (including secrets)")
  .option("--skip-secrets", "Skip syncing only secrets variables")
  .option("--skip-resources", "Skip syncing  resources")
  .option("--include-schedules", "Include syncing  schedules")
  // deno-lint-ignore no-explicit-any
  .action(pull as any)
  .command("push")
  .description(
    "Push any local changes and apply them remotely. Use --raw for usage without local state tracking."
  )
  .option(
    "--fail-conflicts",
    "Error on conflicts (both remote and local have changes on the same item)"
  )
  .option(
    "--raw",
    "Push without using state, just overwrite. (Will be removed as a flag and made the default behavior in the future)"
  )
  .option(
    "--stateful",
    "Pull using state tracking (use .wmill folder and needed for --fail-conflicts). Default currently but will change in favor of --raw"
  )
  .option("--skip-pull", "(stateful only) Push without pulling first")
  .option("--yes", "Push without needing confirmation")
  .option("--plain-secrets", "Push secrets as plain text")
  .option("--json", "Use JSON instead of YAML")
  .option("--skip-variables", "Skip syncing variables (including secrets)")
  .option("--skip-secrets", "Skip syncing only secrets variables")
  .option("--skip-resources", "Skip syncing  resources")
  .option("--include-schedules", "Include syncing  schedules")
  .option(
    "--message <message:string>",
    "Include a message that will be added to all scripts/flows/apps updated during this push"
  )
  // deno-lint-ignore no-explicit-any
  .action(push as any);

export default command;
