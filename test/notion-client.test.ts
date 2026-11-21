// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright (C) 2026 Alex Zaytsev
import type { Logging } from "homebridge";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError, NotionClient, type Listener } from "../src/notion/index.js";
import { API_BASE, FakeNotion, KIND, listener, sensor } from "./fake-notion.js";

let notion: FakeNotion;

function createClient(password = notion.password): NotionClient {
  const log = { debug: vi.fn() } as unknown as Logging;
  return new NotionClient({ email: notion.email, password, apiBase: API_BASE, log });
}

beforeEach(() => {
  notion = new FakeNotion();
  notion.sensors = [sensor(101, "sensor-a", "Front door")];
  notion.listeners = [listener("a-door", "sensor-a", KIND.DOOR, "closed")];
  vi.stubGlobal("fetch", notion.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("NotionClient", () => {
  it("reads sensors, listeners and preferences from the account", async () => {
    notion.celsius = false;
    const client = createClient();

    expect(await client.getSensors()).toEqual(notion.sensors);
    expect(await client.getListeners()).toEqual(notion.listeners);
    expect(await client.getPreferences()).toEqual({ celsius_enabled: false });
  });

  it("signs in once for requests that start together", async () => {
    const client = createClient();

    await Promise.all([client.getSensors(), client.getListeners(), client.getPreferences()]);

    expect(notion.count("POST /auth/login")).toBe(1);
  });

  it("uses the refresh token instead of the password when the access token expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const client = createClient();
    await client.getSensors();

    vi.setSystemTime(Date.now() + notion.tokenTtlSeconds * 1000);

    expect(await client.getSensors()).toEqual(notion.sensors);
    expect(notion.count("POST /auth/login")).toBe(1);
    expect(notion.count(`POST /auth/${notion.userUuid}/refresh`)).toBe(1);
  });

  it("gets a new token when the service rejects the current one", async () => {
    const client = createClient();
    await client.getSensors();

    notion.revokeTokens();

    expect(await client.getSensors()).toEqual(notion.sensors);
  });

  it("signs in with the password when the service rejects the refresh token", async () => {
    const client = createClient();
    await client.getSensors();

    notion.revokeTokens();
    notion.revokeRefreshTokens();

    expect(await client.getSensors()).toEqual(notion.sensors);
    expect(notion.count("POST /auth/login")).toBe(2);
  });

  it("throws when a reply has no list", async () => {
    notion.listeners = null as unknown as Listener[];

    await expect(createClient().getListeners()).rejects.toThrow('a reply without a "listeners" list');
  });

  it("throws AuthError when the service rejects the password", async () => {
    await expect(createClient("wrong-password").getSensors()).rejects.toBeInstanceOf(AuthError);
  });

  it("throws an error other than AuthError when the service is down", async () => {
    notion.down = true;

    const error = await createClient()
      .getSensors()
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(AuthError);
  });

  it("puts the network error code in the message", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } })));

    await expect(createClient().getSensors()).rejects.toThrow(/ECONNREFUSED/);
  });
});
