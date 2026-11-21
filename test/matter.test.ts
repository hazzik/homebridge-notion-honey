// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright (C) 2026 Alex Zaytsev
import * as hap from "@homebridge/hap-nodejs";
import type { API, DynamicPlatformPlugin, Logging, MatterAccessory, PlatformPluginConstructor } from "homebridge";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import configSchema from "../config.schema.json" with { type: "json" };
import plugin from "../src/index.js";
import { API_BASE, FakeNotion, KIND, listener, sensor } from "./fake-notion.js";

const POLL_MS = configSchema.schema.properties.pollSeconds.minimum * 1000;
const POLLS_IN_A_LONG_OUTAGE = 10;

// Values of the Matter enums SmokeCoAlarm.AlarmState, SmokeCoAlarm.ExpressedState and PowerSource.BatChargeLevel.
const ALARM_STATE = { NORMAL: 0, CRITICAL: 2 };
const EXPRESSED_STATE = { NORMAL: 0, SMOKE_ALARM: 1 };
const BAT_CHARGE_LEVEL = { OK: 0, WARNING: 1 };

// The `name` of each matter.js device type in `api.matter.deviceTypes`.
const DEVICE_TYPES = {
  BridgedNode: { name: "BridgedNode" },
  ContactSensor: { name: "ContactSensor" },
  LeakSensor: { name: "WaterLeakDetector" },
  SmokeSensor: { name: "SmokeCoAlarm" },
  TemperatureSensor: { name: "TemperatureSensor" },
};

type State = Record<string, unknown>;

interface Published {
  accessory: MatterAccessory;
  // Attribute values keyed by part id, or "" for the accessory itself, and by cluster name.
  state: Map<string, State>;
}

function stateKey(partId: string | undefined, cluster: string): string {
  return `${partId ?? ""}/${cluster}`;
}

// Like `partShape` in Homebridge, this function sorts the part ids.
function shape(accessory: MatterAccessory): string {
  return JSON.stringify([accessory.deviceType.name, accessory.parts?.map((p) => p.id).sort() ?? []]);
}

function initialState(accessory: MatterAccessory): Map<string, State> {
  const state = new Map<string, State>([[stateKey(undefined, "bridgedDeviceBasicInformation"), { reachable: true }]]);
  for (const [cluster, attributes] of Object.entries(accessory.clusters ?? {})) {
    state.set(stateKey(undefined, cluster), { ...attributes });
  }
  for (const part of accessory.parts ?? []) {
    for (const [cluster, attributes] of Object.entries(part.clusters)) {
      state.set(stateKey(part.id, cluster), { ...attributes });
    }
  }
  return state;
}

function copy({ accessory, state }: Published): Published {
  return { accessory: { ...accessory }, state: new Map([...state].map(([key, value]) => [key, { ...value }])) };
}

// A fake of `api.matter` in Homebridge 2.5.0.
class FakeMatter {
  readonly stateUpdates: string[] = [];
  readonly registrations: string[] = [];
  // Homebridge catches an error in a registration or a state update, logs it, and resolves the promise of the call.
  readonly errors: string[] = [];
  readonly failingRegistrations = new Set<string>(); // display names of the accessories that fail to register
  readonly failingUpdates = new Set<string>(); // display names of the accessories whose state updates fail
  // UUID -> accessory that has an endpoint on the bridge. Homebridge publishes the accessories from its cache before
  // the plugin registers them.
  private readonly published: Map<string, Published>;
  // UUIDs of the accessories from the cache that the plugin has not registered yet.
  private readonly restored: Set<string>;
  // The copies that Homebridge would write to the file in which it caches Matter accessories.
  private readonly cached: Map<string, Published>;

  readonly api = {
    uuid: hap.uuid,
    deviceTypes: DEVICE_TYPES,
    registerPlatformAccessories: (_plugin: string, _platform: string, accessories: MatterAccessory[]) =>
      this.run(() => accessories.forEach((a) => this.register(a))),
    updatePlatformAccessories: (accessories: MatterAccessory[]) =>
      this.run(() => accessories.forEach((a) => this.update(a))),
    unregisterPlatformAccessories: (_plugin: string, _platform: string, accessories: MatterAccessory[]) =>
      this.run(() => accessories.forEach((a) => this.unregister(a.UUID))),
    updateAccessoryState: (uuid: string, cluster: string, attributes: State, partId?: string) =>
      this.run(() => this.setState(uuid, cluster, attributes, partId)),
    getAccessoryState: (uuid: string, cluster: string, partId?: string) =>
      Promise.resolve(this.getState(uuid, cluster, partId)),
  };

  constructor(cache: Published[] = []) {
    this.published = new Map(cache.map((p) => [p.accessory.UUID, copy(p)]));
    this.restored = new Set(this.published.keys());
    this.cached = new Map(cache.map((p) => [p.accessory.UUID, copy(p)]));
  }

  restoredAccessories(): MatterAccessory[] {
    return [...this.restored].map((uuid) => ({ ...this.published.get(uuid)!.accessory }));
  }

  cache(): Published[] {
    return [...this.cached.values()].map(copy);
  }

  devices(): Record<string, { type: string; parts: string[] }> {
    return Object.fromEntries(
      [...this.published.values()].map(({ accessory }) => [
        accessory.displayName,
        { type: accessory.deviceType.name, parts: (accessory.parts ?? []).map((p) => p.deviceType.name).sort() },
      ]),
    );
  }

  // The attributes of the first endpoint of the named device that has the cluster.
  read(name: string, cluster: string): State | undefined {
    const published = [...this.published.values()].find((p) => p.accessory.displayName === name);
    const entry = [...(published?.state ?? [])].find(([key]) => key.endsWith(`/${cluster}`));
    return entry?.[1];
  }

  // The `reachable` values of all devices, without repeats.
  reachable(): unknown[] {
    const values = [...this.published.values()].map(
      (p) => p.state.get(stateKey(undefined, "bridgedDeviceBasicInformation"))?.reachable,
    );
    return [...new Set(values)];
  }

  private run(action: () => void): Promise<void> {
    try {
      action();
    } catch (e) {
      this.errors.push((e as Error).message);
    }
    return Promise.resolve();
  }

  private register(accessory: MatterAccessory): void {
    if (this.failingRegistrations.has(accessory.displayName)) {
      throw new Error(`Failed to register ${accessory.displayName}`);
    }
    const existing = this.published.get(accessory.UUID);
    if (existing && !this.restored.has(accessory.UUID)) {
      throw new Error(`Matter accessory "${accessory.UUID}" is already registered`);
    }
    // `AccessoryManager.buildCustomBehaviors` adds these attributes to a battery `powerSource`.
    const powerSource = accessory.clusters?.powerSource;
    if (powerSource) Object.assign(powerSource, { batChargeState: 0, batFunctionalWhileCharging: false });
    // A restored accessory keeps its state when its device type and parts did not change.
    const state = existing && shape(existing.accessory) === shape(accessory) ? existing.state : initialState(accessory);
    this.restored.delete(accessory.UUID);
    this.published.set(accessory.UUID, { accessory, state });
    this.cached.set(accessory.UUID, copy({ accessory, state }));
    this.registrations.push(accessory.displayName);
  }

  // Homebridge changes only the cached copy, which it publishes on its next start.
  private update(accessory: MatterAccessory): void {
    const cached = this.cached.get(accessory.UUID);
    if (cached) cached.accessory = { ...accessory };
  }

  private unregister(uuid: string): void {
    this.published.delete(uuid);
    this.restored.delete(uuid);
    this.cached.delete(uuid);
  }

  private setState(uuid: string, cluster: string, attributes: State, partId?: string): void {
    const published = this.published.get(uuid);
    if (!published) throw new Error(`Accessory ${uuid} not found or not registered`);
    if (this.failingUpdates.has(published.accessory.displayName)) {
      throw new Error(`Failed to update ${published.accessory.displayName}`);
    }
    if (partId && !published.accessory.parts?.some((p) => p.id === partId)) {
      throw new Error(`Part ${partId} not found in accessory ${uuid}`);
    }
    const key = stateKey(partId, cluster);
    published.state.set(key, { ...published.state.get(key), ...attributes });
    this.stateUpdates.push(`${published.accessory.displayName} ${cluster}`);
  }

  // Like Homebridge, returns undefined when the accessory has no endpoint or the endpoint has no such cluster.
  private getState(uuid: string, cluster: string, partId?: string): State | undefined {
    const state = this.published.get(uuid)?.state.get(stateKey(partId, cluster));
    return state && { ...state };
  }
}

// A fake Homebridge that runs the plugin's platform with Matter turned on and HAP turned on or off.
class FakeHomebridge {
  readonly hapAccessories = new Map<string, hap.Accessory>();
  readonly log = { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  readonly matter: FakeMatter;
  private readonly api;

  constructor({ hapEnabled = false, cache = [] }: { hapEnabled?: boolean; cache?: Published[] } = {}) {
    this.matter = new FakeMatter(cache);
    this.api = Object.assign(new EventEmitter(), {
      hap,
      platformAccessory: hap.Accessory,
      matter: this.matter.api,
      isHapEnabled: () => hapEnabled,
      registerPlatform: vi.fn<(name: string, platform: PlatformPluginConstructor) => void>(),
      registerPlatformAccessories: (_plugin: string, _platform: string, added: hap.Accessory[]) => {
        for (const acc of added) this.hapAccessories.set(acc.UUID, acc);
      },
      updatePlatformAccessories: () => {},
      unregisterPlatformAccessories: (_plugin: string, _platform: string, removed: hap.Accessory[]) => {
        for (const acc of removed) this.hapAccessories.delete(acc.UUID);
      },
    });
  }

  async start(config: Record<string, unknown>): Promise<void> {
    const api = this.api as unknown as API;
    plugin(api);
    const [, Platform] = this.api.registerPlatform.mock.calls[0];
    const log = Object.assign(vi.fn(), this.log) as unknown as Logging;
    const platform = new Platform(log, { platform: configSchema.pluginAlias, ...config }, api) as DynamicPlatformPlugin;
    for (const accessory of this.matter.restoredAccessories()) platform.configureMatterAccessory?.(accessory);
    this.api.emit("didFinishLaunching");
    await vi.advanceTimersByTimeAsync(0);
  }

  stop(): void {
    this.api.emit("shutdown");
  }
}

let notion: FakeNotion;
let homebridge: FakeHomebridge;

function config(): Record<string, unknown> {
  return { email: notion.email, password: notion.password, apiBase: API_BASE, pollSeconds: POLL_MS / 1000 };
}

async function nextPoll(): Promise<void> {
  await vi.advanceTimersByTimeAsync(POLL_MS);
}

async function restart(): Promise<FakeHomebridge> {
  homebridge.stop();
  homebridge = new FakeHomebridge({ cache: homebridge.matter.cache() });
  await homebridge.start(config());
  return homebridge;
}

beforeEach(() => {
  vi.useFakeTimers();
  notion = new FakeNotion();
  notion.sensors = [
    sensor(101, "sensor-a", "Front door"),
    sensor(102, "sensor-b", "Laundry"),
    sensor(103, "sensor-c", "Hallway"),
    sensor(104, "sensor-d", "Spare"),
  ];
  notion.listeners = [
    listener("a-door", "sensor-a", KIND.DOOR, "closed"),
    listener("a-temperature", "sensor-a", KIND.TEMPERATURE, "inside", "24°"),
    listener("a-battery", "sensor-a", KIND.BATTERY, "high"),
    listener("a-connection", "sensor-a", KIND.CONNECTION, "not_missing"),
    listener("b-leak", "sensor-b", KIND.LEAK, "no_leak"),
    listener("b-mold", "sensor-b", KIND.MOLD, "low"),
    listener("c-alarm", "sensor-c", KIND.ALARM, "no_alarm"),
    listener("d-battery", "sensor-d", KIND.BATTERY, "high"),
  ];
  vi.stubGlobal("fetch", notion.fetch);
  homebridge = new FakeHomebridge();
});

afterEach(() => {
  homebridge.stop();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Matter", () => {
  it("adds a device for each sensor, with a part for each task when the sensor has more than one", async () => {
    await homebridge.start(config());

    expect(homebridge.matter.devices()).toEqual({
      "Front door": { type: "BridgedNode", parts: ["ContactSensor", "TemperatureSensor"] },
      Laundry: { type: "WaterLeakDetector", parts: [] },
      Hallway: { type: "SmokeCoAlarm", parts: [] },
    });
  });

  it.each([
    {
      shows: "an open door",
      task: listener("a-door", "sensor-a", KIND.DOOR, "open"),
      cluster: "booleanState",
      expected: { stateValue: false },
    },
    {
      shows: "a closed door",
      task: listener("a-door", "sensor-a", KIND.DOOR, "closed"),
      cluster: "booleanState",
      expected: { stateValue: true },
    },
    {
      shows: "a leak",
      task: listener("a-leak", "sensor-a", KIND.LEAK, "leak"),
      cluster: "booleanState",
      expected: { stateValue: true },
    },
    {
      shows: "a smoke alarm",
      task: listener("a-alarm", "sensor-a", KIND.ALARM, "alarm"),
      cluster: "smokeCoAlarm",
      expected: { smokeState: ALARM_STATE.CRITICAL, expressedState: EXPRESSED_STATE.SMOKE_ALARM },
    },
    {
      shows: "smoke as a smoke alarm",
      task: listener("a-alarm", "sensor-a", KIND.ALARM, "smoke"),
      cluster: "smokeCoAlarm",
      expected: { smokeState: ALARM_STATE.CRITICAL, expressedState: EXPRESSED_STATE.SMOKE_ALARM },
    },
    {
      shows: "a quiet smoke alarm",
      task: listener("a-alarm", "sensor-a", KIND.ALARM, "no_alarm"),
      cluster: "smokeCoAlarm",
      expected: { smokeState: ALARM_STATE.NORMAL, expressedState: EXPRESSED_STATE.NORMAL },
    },
    {
      shows: "the temperature in hundredths of a degree",
      task: listener("a-temperature", "sensor-a", KIND.TEMPERATURE, "inside", "21.5°"),
      cluster: "temperatureMeasurement",
      expected: { measuredValue: 2150 },
    },
  ])("shows $shows", async ({ task, cluster, expected }) => {
    notion.listeners = [task];

    await homebridge.start(config());

    expect(homebridge.matter.read("Front door", cluster)).toEqual(expected);
  });

  it("converts Fahrenheit to Celsius when the account uses Fahrenheit", async () => {
    notion.celsius = false;
    notion.setValue("a-temperature", "inside", "77°");

    await homebridge.start(config());

    expect(homebridge.matter.read("Front door", "temperatureMeasurement")).toEqual({ measuredValue: 2500 });
  });

  it("reports a low battery and an offline sensor", async () => {
    notion.setValue("a-battery", "low");
    notion.listeners.push(listener("c-connection", "sensor-c", KIND.CONNECTION, "missing"));

    await homebridge.start(config());

    expect(homebridge.matter.read("Front door", "powerSource")).toMatchObject({
      batChargeLevel: BAT_CHARGE_LEVEL.WARNING,
      batReplacementNeeded: true,
    });
    expect(homebridge.matter.read("Laundry", "powerSource")).toMatchObject({
      batChargeLevel: BAT_CHARGE_LEVEL.OK,
      batReplacementNeeded: false,
    });
    expect(homebridge.matter.read("Front door", "bridgedDeviceBasicInformation")).toEqual({ reachable: true });
    expect(homebridge.matter.read("Hallway", "bridgedDeviceBasicInformation")).toEqual({ reachable: false });
  });

  it.each([
    {
      shows: "a device as not reachable while its contact state is neither open nor closed",
      task: "a-door",
      sensor: "Front door",
      cluster: "booleanState",
      unknown: "needs_resync",
      last: { stateValue: true },
      known: "open",
      next: { stateValue: false },
    },
    {
      shows: "a leak sensor as not reachable while it cannot detect leaks",
      task: "b-leak",
      sensor: "Laundry",
      cluster: "booleanState",
      unknown: "short",
      last: { stateValue: false },
      known: "leak",
      next: { stateValue: true },
    },
    {
      shows: "a smoke alarm as not reachable while its state is neither alarm nor no alarm",
      task: "c-alarm",
      sensor: "Hallway",
      cluster: "smokeCoAlarm",
      unknown: "undefined",
      last: { smokeState: ALARM_STATE.NORMAL, expressedState: EXPRESSED_STATE.NORMAL },
      known: "alarm",
      next: { smokeState: ALARM_STATE.CRITICAL, expressedState: EXPRESSED_STATE.SMOKE_ALARM },
    },
  ])("shows $shows", async ({ task, sensor, cluster, unknown, last, known, next }) => {
    await homebridge.start(config());

    notion.setValue(task, unknown);
    await nextPoll();
    expect(homebridge.matter.read(sensor, "bridgedDeviceBasicInformation")).toEqual({ reachable: false });
    expect(homebridge.matter.read(sensor, cluster)).toEqual(last);

    notion.setValue(task, known);
    await nextPoll();
    expect(homebridge.matter.read(sensor, "bridgedDeviceBasicInformation")).toEqual({ reachable: true });
    expect(homebridge.matter.read(sensor, cluster)).toEqual(next);
  });

  it("registers a new device only once its contact state is open or closed", async () => {
    notion.setValue("a-door", "calibrating_init");

    await homebridge.start(config());
    expect(Object.keys(homebridge.matter.devices()).sort()).toEqual(["Hallway", "Laundry"]);

    notion.setValue("a-door", "closed");
    await nextPoll();
    expect(homebridge.matter.devices()["Front door"]).toEqual({
      type: "BridgedNode",
      parts: ["ContactSensor", "TemperatureSensor"],
    });
  });

  it("shows a restored device as not reachable while its contact state is neither open nor closed", async () => {
    await homebridge.start(config());
    notion.setValue("a-door", "needs_resync");

    const restarted = await restart();

    expect(restarted.matter.read("Front door", "bridgedDeviceBasicInformation")).toEqual({ reachable: false });
  });

  it("sends only the values that changed on later polls", async () => {
    await homebridge.start(config());
    homebridge.matter.stateUpdates.length = 0;

    await nextPoll();
    expect(homebridge.matter.stateUpdates).toEqual([]);

    notion.setValue("a-door", "open");
    await nextPoll();
    expect(homebridge.matter.stateUpdates).toEqual(["Front door booleanState"]);
    expect(homebridge.matter.read("Front door", "booleanState")).toEqual({ stateValue: false });
  });

  it("removes the device of a sensor that is gone from the account", async () => {
    await homebridge.start(config());

    notion.removeSensor("sensor-c");
    await nextPoll();

    expect(Object.keys(homebridge.matter.devices()).sort()).toEqual(["Front door", "Laundry"]);
  });

  it("sends the current values to the devices that Homebridge restores after a restart", async () => {
    await homebridge.start(config());
    const devices = homebridge.matter.devices();
    notion.setValue("a-door", "open");

    const restarted = await restart();

    expect(restarted.matter.devices()).toEqual(devices);
    expect(restarted.matter.read("Front door", "booleanState")).toEqual({ stateValue: false });
    expect(restarted.log.info).not.toHaveBeenCalledWith(expect.stringContaining("The plugin added"));
  });

  it("registers the device again when a sensor loses a task", async () => {
    await homebridge.start(config());

    notion.listeners = notion.listeners.filter((l) => l.id !== "a-temperature");
    await nextPoll();

    expect(homebridge.matter.devices()["Front door"]).toEqual({ type: "ContactSensor", parts: [] });
    expect(homebridge.matter.read("Front door", "booleanState")).toEqual({ stateValue: true });
  });

  it("registers the device again when a sensor gains a task", async () => {
    await homebridge.start(config());

    notion.listeners.push(listener("c-leak", "sensor-c", KIND.LEAK, "leak"));
    await nextPoll();

    expect(homebridge.matter.devices().Hallway).toEqual({
      type: "BridgedNode",
      parts: ["SmokeCoAlarm", "WaterLeakDetector"],
    });
    expect(homebridge.matter.read("Hallway", "booleanState")).toEqual({ stateValue: true });
  });

  it("shows a renamed sensor under its new name after a restart", async () => {
    await homebridge.start(config());

    notion.sensors = notion.sensors.map((s) => (s.uuid === "sensor-a" ? { ...s, name: "Main door" } : s));
    await nextPoll();
    const restarted = await restart();

    expect(Object.keys(restarted.matter.devices()).sort()).toEqual(["Hallway", "Laundry", "Main door"]);
  });

  it("shows sensors as not reachable during a long outage and recovers afterwards", async () => {
    await homebridge.start(config());
    notion.down = true;

    await nextPoll();
    expect(homebridge.matter.reachable()).toEqual([true]);

    for (let i = 0; i < POLLS_IN_A_LONG_OUTAGE; i++) await nextPoll();
    expect(homebridge.matter.reachable()).toEqual([false]);

    notion.down = false;
    await nextPoll();
    expect(homebridge.matter.reachable()).toEqual([true]);
  });

  it("shows the devices that Homebridge restores as not reachable when the service is down after a restart", async () => {
    await homebridge.start(config());
    notion.down = true;

    const restarted = await restart();
    for (let i = 0; i < POLLS_IN_A_LONG_OUTAGE; i++) await nextPoll();

    expect(restarted.matter.reachable()).toEqual([false]);
  });

  it("keeps the device when the service returns the listeners in another order", async () => {
    await homebridge.start(config());
    const registrations = homebridge.matter.registrations.length;

    notion.listeners = notion.listeners.toReversed();
    await nextPoll();

    expect(homebridge.matter.registrations).toHaveLength(registrations);
  });

  it("registers a device again when Homebridge failed to register it", async () => {
    homebridge.matter.failingRegistrations.add("Laundry");

    await homebridge.start(config());
    expect(Object.keys(homebridge.matter.devices()).sort()).toEqual(["Front door", "Hallway"]);

    homebridge.matter.failingRegistrations.clear();
    await nextPoll();
    expect(Object.keys(homebridge.matter.devices()).sort()).toEqual(["Front door", "Hallway", "Laundry"]);
  });

  it("sends a value again when Homebridge failed to apply it", async () => {
    await homebridge.start(config());
    homebridge.matter.failingUpdates.add("Front door");

    notion.setValue("a-door", "open");
    await nextPoll();
    expect(homebridge.matter.read("Front door", "booleanState")).toEqual({ stateValue: true });

    homebridge.matter.failingUpdates.clear();
    await nextPoll();
    expect(homebridge.matter.read("Front door", "booleanState")).toEqual({ stateValue: false });
  });

  it("publishes over HAP and Matter when Homebridge has both turned on", async () => {
    homebridge = new FakeHomebridge({ hapEnabled: true });

    await homebridge.start(config());

    const hapNames = [...homebridge.hapAccessories.values()].map((acc) => acc.displayName).sort();
    expect(hapNames).toEqual(["Front door", "Hallway", "Laundry"]);
    expect(Object.keys(homebridge.matter.devices()).sort()).toEqual(hapNames);
    expect(homebridge.log.info).toHaveBeenCalledWith(
      "The plugin signed in to the Notion/Honey service. Sensors in Apple Home: 3. New sensors: 3.",
    );
  });

  it("publishes nothing over HAP when Homebridge has HAP turned off", async () => {
    await homebridge.start(config());

    expect(homebridge.hapAccessories.size).toBe(0);
    expect(Object.keys(homebridge.matter.devices())).toHaveLength(3);
  });
});
