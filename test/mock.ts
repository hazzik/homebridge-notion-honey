// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright (C) 2026 Alex Zaytsev
// A fake Notion API server for testing the plugin without a real account.
//
// Run these commands in the repository root:
//   node test/mock.ts                      # starts the fake service on http://127.0.0.1:18080/api
//   yarn build
//   mkdir -p /tmp/hbp && ln -sfn "$PWD" /tmp/hbp/homebridge-notion-honey   # Homebridge loads only folders named homebridge-*
//   yarn homebridge -U test -P /tmp/hbp -I -D --strict-plugin-resolution   # test/config.json sets apiBase to the fake service
//   node test/dump.ts                      # prints what Homebridge publishes to Apple Home
// To change a state:  curl -XPOST http://127.0.0.1:18080/api/_set -d '{"id":"L-a-door","value":"open"}'
// Other controls: /_revoke, /_revokeAll, /_fahrenheit, /_fail {"on":true}, /_empty {"on":true}, /_removeSensor {"uuid":"sensor-c"}
import { UnsecuredJWT } from "jose";
import http from "node:http";
import { text } from "node:stream/consumers";
import config from "./config.json" with { type: "json" };

const account = config.platforms.find((p) => p.platform === "NotionHoney")!;
const PORT = Number(process.env.PORT || new URL(account.apiBase).port);
const JWT_TTL_S = Number(process.env.JWT_TTL_S || 90);

let tokenCounter = 0;
function makeJwt(): string {
  tokenCounter += 1;
  return new UnsecuredJWT({ n: tokenCounter }).setExpirationTime(`${JWT_TTL_S}s`).encode();
}

const USER_UUID = "user-uuid-1";
const validJwts = new Set<string>();
const validRefresh = new Set<string>();
let celsius = true;
let failAll = false;
let emptySensors = false;

function issueTokens() {
  const jwt = makeJwt();
  const refresh_token = "rt-" + tokenCounter;
  validJwts.add(jwt);
  validRefresh.add(refresh_token);
  return { jwt, refresh_token };
}

const sensors = [
  {
    id: 101,
    uuid: "sensor-a",
    name: "Front door",
    hardware_id: "0x00AA",
    hardware_revision: 9,
    firmware_version: "3.2.1",
    bridge: { id: 1, hardware_id: "br1" },
    missing_at: null,
  },
  {
    id: 102,
    uuid: "sensor-b",
    name: "Laundry",
    hardware_id: "0x00BB",
    hardware_revision: 9,
    firmware_version: "3.2.1",
    bridge: { id: 1, hardware_id: "br1" },
    missing_at: null,
  },
  {
    id: 103,
    uuid: "sensor-c",
    name: "Hallway (smoke)",
    hardware_id: "0x00CC",
    hardware_revision: 9,
    firmware_version: "3.2.1",
    bridge: { id: 1, hardware_id: "br1" },
    missing_at: null,
  },
];

function listener(id: string, def: number, sensorUuid: string, value: string, stateText?: string) {
  return {
    id,
    definition_id: def,
    sensor_id: sensorUuid,
    created_at: "2024-01-01T00:00:00Z",
    model_version: "1",
    type: "sensor",
    status_localized: { state: stateText || value, description: "" },
    insights: { primary: { origin: { id: "x", type: "Sensor" }, value, data_received_at: new Date().toISOString() } },
    configuration: {},
    pro_monitoring_status: "ineligible",
  };
}

const listeners = [
  listener("L-a-door", 6, "sensor-a", "closed"),
  listener("L-a-temp", 3, "sensor-a", "inside", "24°"),
  listener("L-a-batt", 0, "sensor-a", "high"),
  listener("L-a-conn", 10, "sensor-a", "not_missing"),
  listener("L-b-leak", 4, "sensor-b", "no_leak"),
  listener("L-b-temp", 3, "sensor-b", "inside", "21°"),
  listener("L-b-mold", 2, "sensor-b", "low"),
  listener("L-b-conn", 10, "sensor-b", "not_missing"),
  listener("L-c-alarm", 7, "sensor-c", "no_alarm"),
  listener("L-c-conn", 10, "sensor-c", "not_missing"),
];

interface Body {
  id?: string;
  value?: string;
  state?: string;
  on?: boolean;
  uuid?: string;
  auth?: { email?: string; password?: string; session_name?: string; refresh_token?: string } | null;
}

type Reply = [status: number, body: unknown];

const OK: Reply = [200, { ok: true }];

function error(status: number, title: string): Reply {
  return [status, { errors: [{ title }] }];
}

function parseBody(body: string): Body {
  if (!body) return {};
  try {
    return JSON.parse(body) as Body;
  } catch {
    return {};
  }
}

function authed(req: http.IncomingMessage): boolean {
  const h = req.headers.authorization || "";
  return h.startsWith("Bearer ") && validJwts.has(h.slice(7));
}

function setListener(json: Body): Reply {
  const l = listeners.find((x) => x.id === json.id);
  if (l) {
    if (json.value !== undefined) l.insights.primary.value = json.value;
    if (json.state) l.status_localized.state = json.state;
  }
  return [200, { ok: !!l }];
}

function removeSensor(uuid: string | undefined): Reply {
  const i = sensors.findIndex((s) => s.uuid === uuid);
  if (i >= 0) sensors.splice(i, 1);
  return [200, { ok: i >= 0 }];
}

// The test controls work while /_fail is on and need no token.
function control(url: string, method: string | undefined, json: Body): Reply | undefined {
  switch (url) {
    case "/_set":
      return method === "POST" ? setListener(json) : undefined;
    case "/_revoke":
      validJwts.clear();
      return OK;
    case "/_revokeAll":
      validJwts.clear();
      validRefresh.clear();
      return OK;
    case "/_fahrenheit":
      celsius = false;
      return OK;
    case "/_fail":
      failAll = Boolean(json.on);
      return OK;
    case "/_empty":
      emptySensors = Boolean(json.on);
      return OK;
    case "/_removeSensor":
      return removeSensor(json.uuid);
  }
  return undefined;
}

function login(req: http.IncomingMessage, a: NonNullable<Body["auth"]>): Reply {
  if (req.headers["accept-version"] !== "2") return error(400, "Unsupported API version");
  if (a.email !== account.email || a.password !== account.password || !a.session_name) {
    return error(401, "Invalid email or password");
  }
  return [200, { user: { id: 1, uuid: USER_UUID, email: a.email }, auth: issueTokens() }];
}

function refresh(userUuid: string, rt: string | undefined): Reply {
  if (userUuid !== USER_UUID || rt === undefined || !validRefresh.has(rt)) return error(401, "Invalid refresh token");
  validRefresh.delete(rt);
  return [200, { auth: issueTokens() }];
}

function signIn(url: string, req: http.IncomingMessage, json: Body): Reply | undefined {
  if (req.method !== "POST") return undefined;
  if (url === "/auth/login") return login(req, json.auth || {});
  const m = url.match(/^\/auth\/([^/]+)\/refresh$/);
  return m ? refresh(m[1], json.auth?.refresh_token) : undefined;
}

function data(url: string): Reply {
  if (url === "/sensors") return [200, { sensors: emptySensors ? [] : sensors }];
  if (url === "/sensor/listeners") {
    return [200, { listeners: listeners.filter((l) => sensors.some((s) => s.uuid === l.sensor_id)) }];
  }
  if (url === `/users/${USER_UUID}/user_preferences`) {
    return [200, { user_preferences: { user_id: 1, celsius_enabled: celsius } }];
  }
  return error(404, "Not found");
}

function route(url: string, req: http.IncomingMessage, json: Body): Reply {
  const controlReply = control(url, req.method, json);
  if (controlReply) return controlReply;
  if (failAll) return error(503, "Service unavailable");
  const signInReply = signIn(url, req, json);
  if (signInReply) return signInReply;
  if (!authed(req)) return error(401, "Unauthorized");
  return data(url);
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const json = parseBody(await text(req));
  const [status, body] = route((req.url || "").replace(/^\/api/, ""), req, json);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

http
  .createServer((req, res) => void handle(req, res))
  .listen(PORT, () => console.log(`The fake Notion service listens on port ${PORT}.`));
