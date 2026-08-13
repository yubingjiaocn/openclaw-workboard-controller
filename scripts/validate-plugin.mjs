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

assert(manifest.contracts?.gatewayMethodDispatch?.includes("authenticated-request"), "manifest contracts.gatewayMethodDispatch must include authenticated-request");
assert(manifest.activation?.onStartup === true, "manifest activation.onStartup must be true");
assert(manifest.activation?.onConfigPaths?.includes("plugins.entries.workboard-controller"), "manifest must watch controller config path");

const httpRoutes = [];
const services = [];
plugin.register({
  registrationMode: "tool-discovery",
  pluginConfig: {},
  runtime: { version: "validator", agent: {} },
  registerTool() {},
  registerHttpRoute(route) { httpRoutes.push(route); },
  registerService(service) { services.push(service); },
});
const dispatchRoute = httpRoutes.find((route) => route.path === "/plugins/workboard-controller/workboard-dispatch");
assert(dispatchRoute, "plugin must register the Workboard dispatch self-route");
assert(dispatchRoute.auth === "gateway", "Workboard dispatch self-route must require Gateway auth");
assert(dispatchRoute.match === "exact", "Workboard dispatch self-route must be exact-match only");
assert(typeof dispatchRoute.handler === "function", "Workboard dispatch self-route must provide a handler");
assert(services.length === 0, "tool-discovery registration must not register/start the service");

const gatewayClientSource = await readFile(new URL("dist/gateway-method-client.js", root), "utf8");
const dispatchSharedSource = await readFile(new URL("dist/workboard-dispatch-shared.js", root), "utf8");
assert(!gatewayClientSource.includes("workboard_dispatch"), "production dispatch path must not call the public workboard_dispatch tool");
assert(gatewayClientSource.includes("WORKBOARD_DISPATCH_ROUTE_PATH"), "production dispatch path must import the self-route constant");
assert(dispatchSharedSource.includes("/plugins/workboard-controller/workboard-dispatch"), "production dispatch path must call the authenticated self-route");

const properties = manifest.configSchema?.properties ?? {};
for (const key of [
  "enabled",
  "boardId",
  "pollIntervalMs",
  "dispatchCooldownMs",
  "gatewayBaseUrl",
  "gatewayToolSessionKey",
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
  gatewayMethodDispatch: manifest.contracts?.gatewayMethodDispatch ?? [],
  httpRoutes: httpRoutes.map((route) => ({ path: route.path, auth: route.auth, match: route.match })),
}, null, 2));
