// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright (C) 2026 Alex Zaytsev
// An in-memory Notion service for unit tests. Pass `fetch` to `vi.stubGlobal("fetch", ...)`.
import { UnsecuredJWT } from "jose";
import type { DeviceRegistration, Listener, Location, Sensor } from "../src/notion/index.js";

export const API_BASE = "https://notion.test/api";

// The `definition_id` value of each kind of Notion listener.
export const KIND = {
  BATTERY: 0,
  MOLD: 2,
  TEMPERATURE: 3,
  LEAK: 4,
  DOOR: 6,
  ALARM: 7,
  CONNECTION: 10,
} as const;

export function sensor(id: number, uuid: string, name: string): Sensor {
  return { id, uuid, name, hardware_id: `hw-${id}`, firmware_version: "3.2.1", missing_at: null };
}

export function listener(id: string, sensorUuid: string, kind: number, value: string, state = value): Listener {
  return {
    id,
    definition_id: kind,
    sensor_id: sensorUuid,
    status_localized: { state },
    insights: { primary: { value } },
  };
}

type Reply = [status: number, body: unknown];

interface SignInBody {
  auth?: { email?: string; password?: string; refresh_token?: string };
}

function error(status: number, title: string): Reply {
  return [status, { errors: [{ title }] }];
}

function parseBody<T>(body: RequestInit["body"]): Partial<T> {
  return typeof body === "string" ? (JSON.parse(body) as Partial<T>) : {};
}

export class FakeNotion {
  email = "user@example.com";
  password = "right-password";
  readonly userUuid = "user-1";
  readonly systemId = "system-1";
  tokenTtlSeconds = 3600;
  celsius = true;
  down = false;
  preferencesDown = false;
  devicesDown = false;
  sensors: Sensor[] = [];
  listeners: Listener[] = [];
  locations: Location[] = [];
  readonly requests: string[] = [];
  // The phones that registered for the push alerts of the account.
  readonly devices: DeviceRegistration["device"][] = [];
  private readonly tokens = new Map<string, number>();
  private readonly refreshTokens = new Set<string>();
  private issued = 0;

  readonly fetch = (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const method = init.method ?? "GET";
    const path = new URL(input instanceof Request ? input.url : input).pathname.replace(/^\/api/, "");
    this.requests.push(`${method} ${path}`);
    const [status, body] = this.down
      ? error(503, "Service unavailable")
      : this.route(method, path, new Headers(init.headers), init.body);
    return Promise.resolve(Response.json(body, { status }));
  };

  count(request: string): number {
    return this.requests.filter((r) => r === request).length;
  }

  setValue(listenerId: string, value: string, state = value): void {
    this.listeners = this.listeners.map((l) =>
      l.id === listenerId ? { ...l, status_localized: { state }, insights: { primary: { value } } } : l,
    );
  }

  removeSensor(uuid: string): void {
    this.sensors = this.sensors.filter((s) => s.uuid !== uuid);
    this.listeners = this.listeners.filter((l) => l.sensor_id !== uuid);
  }

  revokeTokens(): void {
    this.tokens.clear();
  }

  revokeRefreshTokens(): void {
    this.refreshTokens.clear();
  }

  private route(method: string, path: string, headers: Headers, body: RequestInit["body"]): Reply {
    if (method === "POST") return this.post(path, headers, body);
    if (!this.authorized(headers)) return error(401, "Unauthorized");
    if (path === "/sensors") return [200, { sensors: this.sensors }];
    if (path === "/sensor/listeners") return [200, { listeners: this.listeners }];
    if (path === `/systems/${this.systemId}/locations`) return [200, { locations: this.locations }];
    if (path === `/users/${this.userUuid}/user_preferences`) {
      if (this.preferencesDown) return error(503, "Service unavailable");
      return [200, { user_preferences: { celsius_enabled: this.celsius } }];
    }
    return error(404, "Not found");
  }

  // Every POST endpoint takes API version 2.
  private post(path: string, headers: Headers, body: RequestInit["body"]): Reply {
    if (headers.get("Accept-Version") !== "2") return error(400, "Unsupported API version");
    if (path !== "/devices") return this.signIn(path, parseBody<SignInBody>(body).auth ?? {});
    if (!this.authorized(headers)) return error(401, "Unauthorized");
    return this.registerDevice(parseBody<DeviceRegistration>(body));
  }

  private signIn(path: string, auth: NonNullable<SignInBody["auth"]>): Reply {
    if (path === "/auth/login") {
      if (auth.email !== this.email || auth.password !== this.password) return error(401, "Invalid email or password");
      return [200, { user: { uuid: this.userUuid }, auth: this.issueTokens() }];
    }
    if (path === `/auth/${this.userUuid}/refresh`) {
      if (!auth.refresh_token || !this.refreshTokens.delete(auth.refresh_token)) {
        return error(401, "Invalid refresh token");
      }
      return [200, { auth: this.issueTokens() }];
    }
    return error(404, "Not found");
  }

  private registerDevice({ device }: Partial<DeviceRegistration>): Reply {
    if (this.devicesDown) return error(503, "Service unavailable");
    if (!device) return error(422, "Invalid device");
    this.devices.push(device);
    return [200, { device }];
  }

  private issueTokens(): { jwt: string; refresh_token: string } {
    this.issued += 1;
    const jwt = new UnsecuredJWT({ n: this.issued }).setExpirationTime(`${this.tokenTtlSeconds}s`).encode();
    const refreshToken = `refresh-${this.issued}`;
    this.tokens.set(jwt, Date.now() + this.tokenTtlSeconds * 1000);
    this.refreshTokens.add(refreshToken);
    return { jwt, refresh_token: refreshToken };
  }

  private authorized(headers: Headers): boolean {
    const expiresAt = this.tokens.get(headers.get("Authorization")?.replace(/^Bearer /, "") ?? "");
    return expiresAt !== undefined && Date.now() < expiresAt;
  }
}
