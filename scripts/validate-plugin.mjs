import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);

async function readJson(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, root), "utf8"));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const manifest = await readJson("openclaw.plugin.json");
const pkg = await readJson("package.json");
const moduleUrl = new URL("dist/index.js", root);
const entryModule = await import(moduleUrl.href);
const plugin = entryModule.default;

assert(plugin && typeof plugin === "object", "dist/index.js must default-export a plugin object");
assert(plugin.id === manifest.id, `entry id ${plugin.id} must match manifest id ${manifest.id}`);
assert(plugin.name === manifest.name, "entry name must match manifest name");
assert(typeof plugin.register === "function", "entry must expose register(api)");
assert(pkg.openclaw?.extensions?.includes("./dist/index.js"), "package.json must expose ./dist/index.js in openclaw.extensions");

const tools = manifest.contracts?.tools ?? [];
for (const tool of ["workboard_controller_status", "workboard_controller_tick"]) {
  assert(tools.includes(tool), `manifest contracts.tools must include ${tool}`);
  assert(manifest.toolMetadata?.[tool]?.optional === true, `${tool} must be marked optional`);
}

const dispatch = manifest.contracts?.gatewayMethodDispatch ?? [];
assert(dispatch.includes("authenticated-request"), "manifest must declare gatewayMethodDispatch authenticated-request seam");
assert(manifest.activation?.onStartup === true, "manifest activation.onStartup must be true");
assert(manifest.activation?.onConfigPaths?.includes("plugins.entries.workboard-controller"), "manifest must watch controller config path");

const properties = manifest.configSchema?.properties ?? {};
for (const key of [
  "enabled",
  "boardId",
  "pollIntervalMs",
  "dispatchCooldownMs",
  "wakeEnabled",
  "wakeFallbackAgentId",
  "compatibleOpenClawVersions",
  "allowUntestedOpenClawVersion",
]) {
  assert(Object.hasOwn(properties, key), `manifest configSchema.properties must include ${key}`);
}

console.log(JSON.stringify({
  ok: true,
  pluginId: plugin.id,
  entry: "./dist/index.js",
  tools,
  gatewayMethodDispatch: dispatch,
}, null, 2));
