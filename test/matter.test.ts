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

function shape(accessory: MatterAccessory): string {
  return JSON.stringify([accessory.deviceType.name, accessory.parts?.map((p) => p.id) ?? []]);
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

// Like Homebridge, this fake returns a promise that rejects when the action fails.
function run(action: () => void): Promise<void> {
  return new Promise((resolve) => {
    action();
    resolve();
  });
}

// A fake of `api.matter` in Homebridge 2.5.0.
class FakeMatter {
  readonly stateUpdates: string[] = [];
  readonly rejects = new Set<string>(); // display names of the accessories that fail to register
  private readonly published = new Map<string, Published>();
  private readonly restored: Map<string, Published>;
  // The copies that Homebridge would write to the file in which it caches Matter accessories.
  private readonly cached = new Map<string, Published>();

  readonly api = {
    uuid: hap.uuid,
    deviceTypes: DEVICE_TYPES,
    registerPlatformAccessories: (_plugin: string, _platform: string, accessories: MatterAccessory[]) =>
      run(() => accessories.forEach((a) => this.register(a))),
    updatePlatformAccessories: (accessories: MatterAccessory[]) =>
      run(() => accessories.forEach((a) => this.update(a))),
    unregisterPlatformAccessories: (_plugin: string, _platform: string, accessories: MatterAccessory[]) =>
      run(() => accessories.forEach((a) => this.unregister(a.UUID))),
    updateAccessoryState: (uuid: string, cluster: string, attributes: State, partId?: string) =>
      run(() => this.setState(uuid, cluster, attributes, partId)),
  };

  constructor(cache: Published[] = []) {
    this.restored = new Map(cache.map((p) => [p.accessory.UUID, copy(p)]));
  }

  restoredAccessories(): MatterAccessory[] {
    return [...this.restored.values()].map((p) => ({ ...p.accessory }));
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

  private register(accessory: MatterAccessory): void {
    if (this.rejects.has(accessory.displayName)) throw new Error(`Failed to register ${accessory.displayName}`);
    if (this.published.has(accessory.UUID))
      throw new Error(`Matter accessory "${accessory.UUID}" is already registered`);
    // `AccessoryManager.buildCustomBehaviors` adds these attributes to a battery `powerSource`.
    const powerSource = accessory.clusters?.powerSource;
    if (powerSource) Object.assign(powerSource, { batChargeState: 0, batFunctionalWhileCharging: false });
    // A restored accessory keeps its cached state when its device type and parts did not change.
    const restored = this.restored.get(accessory.UUID);
    const state = restored && shape(restored.accessory) === shape(accessory) ? restored.state : initialState(accessory);
    this.restored.delete(accessory.UUID);
    this.published.set(accessory.UUID, { accessory, state });
    this.cached.set(accessory.UUID, copy({ accessory, state }));
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
    if (partId && !published.accessory.parts?.some((p) => p.id === partId)) {
      throw new Error(`Part ${partId} not found in accessory ${uuid}`);
    }
    const key = stateKey(partId, cluster);
    published.state.set(key, { ...published.state.get(key), ...attributes });
    this.stateUpdates.push(`${published.accessory.displayName} ${cluster}`);
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

  it("keeps publishing the other sensors when Homebridge rejects one", async () => {
    homebridge.matter.rejects.add("Laundry");

    await homebridge.start(config());
    expect(Object.keys(homebridge.matter.devices()).sort()).toEqual(["Front door", "Hallway"]);
    expect(homebridge.log.error).toHaveBeenCalledWith(expect.stringContaining("Laundry"));
    expect(homebridge.log.warn).not.toHaveBeenCalled();

    homebridge.matter.rejects.clear();
    await nextPoll();
    expect(Object.keys(homebridge.matter.devices()).sort()).toEqual(["Front door", "Hallway", "Laundry"]);
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
