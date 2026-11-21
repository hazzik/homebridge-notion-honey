// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright (C) 2026 Alex Zaytsev

// A small client for the Notion cloud API. In Australia, Honey Insurance runs the Notion service.

import { randomBytes } from "node:crypto";
import type { Logging } from "homebridge";
import { jwtDecode } from "jwt-decode";
import { AuthError, httpError } from "./errors.js";
import { parseJson, send } from "./http.js";
import type { AuthTokens, DeviceRegistration, Listener, Location, Sensor, UserPreferences } from "./types.js";

const DEFAULT_API_BASE = "https://api.getnotion.com/api";

export interface NotionClientOptions {
  email: string;
  password: string;
  apiBase?: string;
  log: Logging;
}

interface FetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

function jwtExpiry(jwt: string): number | null {
  try {
    const { exp } = jwtDecode<{ exp?: unknown }>(jwt);
    return typeof exp === "number" ? exp * 1000 : null;
  } catch {
    return null;
  }
}

export class NotionClient {
  private readonly apiBase: string;
  private readonly log: Logging;
  private readonly loginBody: { email: string; password: string; session_name: string };
  private jwt: string | null = null;
  private jwtExpiresAt: number | null = null;
  private refreshToken: string | null = null;
  private userUuid: string | null = null;
  private authPromise: Promise<void> | null = null;

  constructor({ email, password, apiBase, log }: NotionClientOptions) {
    this.apiBase = (apiBase || DEFAULT_API_BASE).replace(/\/+$/, "");
    this.log = log;
    this.loginBody = { email, password, session_name: "homebridge-" + randomBytes(6).toString("hex") };
  }

  // Returns the parsed JSON reply, or null for an empty reply or a reply that is not JSON.
  private async call(path: string, { method = "GET", headers = {}, body }: FetchOptions = {}): Promise<unknown> {
    const hasBody = body !== undefined;
    const res = await send(this.apiBase + path, {
      method,
      headers: { Accept: "application/json", ...(hasBody ? { "Content-Type": "application/json" } : {}), ...headers },
      body: hasBody ? JSON.stringify(body) : undefined,
    });
    const data = parseJson(await res.text());
    if (!res.ok) throw httpError(method, path, res.status, data);
    return data;
  }

  private async fetch<T>(path: string, options: FetchOptions = {}): Promise<T> {
    const data = await this.call(path, options);
    if (data === null) {
      throw new Error(`${options.method ?? "GET"} ${path} returned an empty reply or a reply that is not JSON`);
    }
    return data as T;
  }

  // The sign-in endpoints take API version 2, wrap the body in `auth`, and need no access token.
  private signIn<T>(path: string, auth: object): Promise<T> {
    return this.fetch<T>(path, { method: "POST", headers: { "Accept-Version": "2" }, body: { auth } });
  }

  private authorization(): Record<string, string> {
    return this.jwt ? { Authorization: `Bearer ${this.jwt}` } : {};
  }

  private saveTokens(auth: AuthTokens | undefined): void {
    if (!auth?.jwt) throw new Error("The sign-in reply had no access token");
    this.jwt = auth.jwt;
    this.refreshToken = auth.refresh_token || null;
    this.jwtExpiresAt = jwtExpiry(auth.jwt);
  }

  async login(): Promise<void> {
    const data = await this.signIn<{ user?: { uuid?: string }; auth?: AuthTokens }>("/auth/login", this.loginBody);
    if (!data.user?.uuid) throw new Error("The login reply had no user id");
    this.userUuid = data.user.uuid;
    this.saveTokens(data.auth);
  }

  async refresh(): Promise<void> {
    if (!this.refreshToken || !this.userUuid) throw new AuthError("The client has no refresh token");
    const data = await this.signIn<{ auth?: AuthTokens }>(`/auth/${this.userUuid}/refresh`, {
      refresh_token: this.refreshToken,
    });
    this.saveTokens(data.auth);
  }

  // Gets a new access token with the refresh token. Signs in with the password if the refresh fails or there is no
  // refresh token. Only one sign-in runs at a time: requests that start together wait for the same sign-in.
  reauthenticate(): Promise<void> {
    this.authPromise ??= (async () => {
      if (this.refreshToken) {
        try {
          await this.refresh();
          return;
        } catch (e) {
          this.log.debug(
            `The token refresh failed: ${(e as Error).message}. The plugin signs in with the password again.`,
          );
        }
      }
      await this.login();
    })().finally(() => {
      this.authPromise = null;
    });
    return this.authPromise;
  }

  private async ensureAuth(): Promise<void> {
    if (this.authPromise) await this.authPromise;
    // Without an access token, the client has no refresh token either, so `reauthenticate()` calls `login()` directly.
    if (!this.jwt || (this.jwtExpiresAt && Date.now() > this.jwtExpiresAt - 60000)) {
      await this.reauthenticate();
    }
  }

  private async withAuth<T>(send: () => Promise<T>): Promise<T> {
    await this.ensureAuth();
    try {
      return await send();
    } catch (e) {
      if (!(e instanceof AuthError)) throw e;
      // The service rejected the token before its expiry time, for example because the service revoked it.
      // Get a new token and try once more.
      await this.reauthenticate();
      return send();
    }
  }

  request<T>(path: string): Promise<T> {
    return this.withAuth(() => this.fetch<T>(path, { headers: this.authorization() }));
  }

  // Registers a phone for the push alerts of the account, like the Android app does. The plugin ignores the reply.
  async registerDevice(registration: DeviceRegistration): Promise<void> {
    await this.withAuth(() =>
      this.call("/devices", {
        method: "POST",
        headers: { "Accept-Version": "2", ...this.authorization() },
        body: registration,
      }),
    );
  }

  private async getList<T>(path: string, key: string): Promise<T[]> {
    const list = (await this.request<Record<string, unknown>>(path))[key];
    if (!Array.isArray(list)) throw new Error(`GET ${path} returned a reply without a "${key}" list`);
    return list as T[];
  }

  getSensors(): Promise<Sensor[]> {
    return this.getList("/sensors", "sensors");
  }

  getListeners(): Promise<Listener[]> {
    return this.getList("/sensor/listeners", "listeners");
  }

  // The service takes the numeric `system_id` of a sensor or the `uuid` of the system. The query is the one that the
  // Android app sends.
  getLocations(systemId: number | string): Promise<Location[]> {
    return this.getList(`/systems/${systemId}/locations?sensors=true&per_page=500`, "locations");
  }

  async getPreferences(): Promise<UserPreferences> {
    await this.ensureAuth();
    const data = await this.request<{ user_preferences?: UserPreferences }>(`/users/${this.userUuid}/user_preferences`);
    return data.user_preferences || {};
  }
}
