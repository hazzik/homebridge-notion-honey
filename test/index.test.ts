// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright (C) 2026 Alex Zaytsev
import * as hap from "@homebridge/hap-nodejs";
import type { CharacteristicValue, WithUUID } from "@homebridge/hap-nodejs";
import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformPluginConstructor } from "homebridge";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import configSchema from "../config.schema.json" with { type: "json" };
import plugin from "../src/index.js";
import { API_BASE, FakeNotion, KIND, listener, sensor } from "./fake-notion.js";

const { Accessory, Characteristic, HAPStatus, Service } = hap;
const { ContactSensorState, LeakDetected, SmokeDetected, StatusFault, StatusLowBattery } = Characteristic;

const POLL_MS = configSchema.schema.properties.pollSeconds.minimum * 1000;
const AN_HOUR_MS = 60 * 60 * 1000;
const POLLS_IN_A_LONG_OUTAGE = 10;

const SENSOR_SERVICES = new Map<string, string>([
  [Service.ContactSensor.UUID, "ContactSensor"],
  [Service.LeakSensor.UUID, "LeakSensor"],
  [Service.SmokeSensor.UUID, "SmokeSensor"],
  [Service.TemperatureSensor.UUID, "TemperatureSensor"],
]);

// A fake Homebridge that runs the plugin's platform and keeps the accessory cache.
class FakeHomebridge {
  readonly accessories = new Map<string, hap.Accessory>();
  readonly registered: hap.Accessory[] = [];
  readonly log = { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  private readonly api;

  // Homebridge 2.0 to 2.4 has no `isHapEnabled()`.
  constructor({ hasIsHapEnabled = true }: { hasIsHapEnabled?: boolean } = {}) {
    this.api = Object.assign(new EventEmitter(), {
      hap,
      platformAccessory: Accessory,
      ...(hasIsHapEnabled ? { isHapEnabled: () => true } : {}),
      registerPlatform: vi.fn<(name: string, platform: PlatformPluginConstructor) => void>(),
      registerPlatformAccessories: (_plugin: string, _platform: string, added: hap.Accessory[]) => {
        for (const acc of added) this.accessories.set(acc.UUID, acc);
        this.registered.push(...added);
      },
      updatePlatformAccessories: () => {},
      unregisterPlatformAccessories: (_plugin: string, _platform: string, removed: hap.Accessory[]) => {
        for (const acc of removed) this.accessories.delete(acc.UUID);
      },
    });
  }

  async start(config: Record<string, unknown>, cached: hap.Accessory[] = []): Promise<void> {
    const api = this.api as unknown as API;
    plugin(api);
    const [, Platform] = this.api.registerPlatform.mock.calls[0];
    const log = Object.assign(vi.fn(), this.log) as unknown as Logging;
    const platform = new Platform(log, { platform: configSchema.pluginAlias, ...config }, api) as DynamicPlatformPlugin;
    for (const acc of cached) {
      this.accessories.set(acc.UUID, acc);
      platform.configureAccessory(acc as unknown as PlatformAccessory);
    }
    this.api.emit("didFinishLaunching");
    await vi.advanceTimersByTimeAsync(0);
  }

  stop(): void {
    this.api.emit("shutdown");
  }

  // The accessories that Homebridge would read back from its cache file on the next start.
  cache(): hap.Accessory[] {
    return [...this.accessories.values()].map((acc) => Accessory.deserialize(Accessory.serialize(acc)));
  }

  services(): Record<string, string[]> {
    return Object.fromEntries(
      [...this.accessories.values()].map((acc) => [
        acc.displayName,
        acc.services.flatMap((svc) => SENSOR_SERVICES.get(svc.UUID) ?? []).sort(),
      ]),
    );
  }

  characteristic(
    name: string,
    service: WithUUID<typeof hap.Service>,
    characteristic: WithUUID<new () => hap.Characteristic>,
  ): hap.Characteristic | undefined {
    const acc = [...this.accessories.values()].find((a) => a.displayName === name);
    return acc?.getService(service)?.getCharacteristic(characteristic);
  }

  read(
    name: string,
    service: WithUUID<typeof hap.Service>,
    characteristic: WithUUID<new () => hap.Characteristic>,
  ): CharacteristicValue | null | undefined {
    return this.characteristic(name, service, characteristic)?.value;
  }

  // The StatusFault values of all sensor services, without repeats.
  faults(): (CharacteristicValue | null)[] {
    const services = [...this.accessories.values()].flatMap((acc) => acc.services);
    const values = services
      .filter((svc) => SENSOR_SERVICES.has(svc.UUID))
      .map((svc) => svc.getCharacteristic(StatusFault).value);
    return [...new Set(values)];
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

describe("Notion platform", () => {
  it("adds an accessory for each sensor with a service for each supported task", async () => {
    await homebridge.start(config());

    expect(homebridge.services()).toEqual({
      "Front door": ["ContactSensor", "TemperatureSensor"],
      Laundry: ["LeakSensor"],
      Hallway: ["SmokeSensor"],
    });
  });

  it.each([
    {
      shows: "an open door",
      task: listener("a-door", "sensor-a", KIND.DOOR, "open"),
      service: Service.ContactSensor,
      characteristic: ContactSensorState,
      expected: ContactSensorState.CONTACT_NOT_DETECTED,
    },
    {
      shows: "a closed door",
      task: listener("a-door", "sensor-a", KIND.DOOR, "closed"),
      service: Service.ContactSensor,
      characteristic: ContactSensorState,
      expected: ContactSensorState.CONTACT_DETECTED,
    },
    {
      shows: "a leak",
      task: listener("a-leak", "sensor-a", KIND.LEAK, "leak"),
      service: Service.LeakSensor,
      characteristic: LeakDetected,
      expected: LeakDetected.LEAK_DETECTED,
    },
    {
      shows: "a smoke alarm",
      task: listener("a-alarm", "sensor-a", KIND.ALARM, "alarm"),
      service: Service.SmokeSensor,
      characteristic: SmokeDetected,
      expected: SmokeDetected.SMOKE_DETECTED,
    },
    {
      shows: "the temperature",
      task: listener("a-temperature", "sensor-a", KIND.TEMPERATURE, "inside", "21.5°"),
      service: Service.TemperatureSensor,
      characteristic: Characteristic.CurrentTemperature,
      expected: 21.5,
    },
  ])("shows $shows", async ({ task, service, characteristic, expected }) => {
    notion.listeners = [task];

    await homebridge.start(config());

    expect(homebridge.read("Front door", service, characteristic)).toBe(expected);
  });

  it("converts Fahrenheit to Celsius when the account uses Fahrenheit", async () => {
    notion.celsius = false;
    notion.setValue("a-temperature", "inside", "77°");

    await homebridge.start(config());

    expect(homebridge.read("Front door", Service.TemperatureSensor, Characteristic.CurrentTemperature)).toBe(25);
  });

  it("shows no temperature until it reads the temperature unit of the account", async () => {
    notion.celsius = false;
    notion.preferencesDown = true;
    notion.setValue("a-temperature", "inside", "77°");

    await homebridge.start(config());
    expect(homebridge.services()["Front door"]).toEqual(["ContactSensor"]);
    expect(homebridge.log.warn).toHaveBeenCalledWith(expect.stringContaining("temperature unit"));

    notion.preferencesDown = false;
    await nextPoll();
    expect(homebridge.read("Front door", Service.TemperatureSensor, Characteristic.CurrentTemperature)).toBe(25);
  });

  it("adds a temperature tile only with its first reading", async () => {
    notion.setValue("a-temperature", "inside", "--");

    await homebridge.start(config());
    expect(homebridge.services()["Front door"]).toEqual(["ContactSensor"]);

    notion.setValue("a-temperature", "inside", "21°");
    await nextPoll();
    expect(homebridge.read("Front door", Service.TemperatureSensor, Characteristic.CurrentTemperature)).toBe(21);
  });

  it("shows an error on a temperature tile that loses its reading", async () => {
    await homebridge.start(config());

    notion.setValue("a-temperature", "inside", "--");
    await nextPoll();

    const temperature = homebridge.characteristic(
      "Front door",
      Service.TemperatureSensor,
      Characteristic.CurrentTemperature,
    );
    expect(temperature?.statusCode).toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  });

  it("shows a low battery and an offline sensor as warnings", async () => {
    notion.setValue("a-battery", "low");
    notion.listeners.push(listener("c-connection", "sensor-c", KIND.CONNECTION, "missing"));

    await homebridge.start(config());

    expect(homebridge.read("Front door", Service.ContactSensor, StatusLowBattery)).toBe(
      StatusLowBattery.BATTERY_LEVEL_LOW,
    );
    expect(homebridge.read("Front door", Service.ContactSensor, StatusFault)).toBe(StatusFault.NO_FAULT);
    expect(homebridge.read("Hallway", Service.SmokeSensor, StatusFault)).toBe(StatusFault.GENERAL_FAULT);
  });

  it("updates states on later polls without adding accessories again", async () => {
    await homebridge.start(config());
    const registered = homebridge.registered.length;

    notion.setValue("a-door", "open");
    await nextPoll();

    expect(homebridge.read("Front door", Service.ContactSensor, ContactSensorState)).toBe(
      ContactSensorState.CONTACT_NOT_DETECTED,
    );
    expect(homebridge.registered).toHaveLength(registered);
  });

  it("removes the accessory of a sensor that is gone from the account", async () => {
    await homebridge.start(config());

    notion.removeSensor("sensor-c");
    await nextPoll();

    expect(Object.keys(homebridge.services()).sort()).toEqual(["Front door", "Laundry"]);
  });

  it("keeps all accessories when the service returns no listeners", async () => {
    await homebridge.start(config());
    const services = homebridge.services();

    notion.listeners = [];
    await nextPoll();

    expect(homebridge.services()).toEqual(services);
  });

  it("publishes over HAP on Homebridge versions that have no isHapEnabled()", async () => {
    homebridge = new FakeHomebridge({ hasIsHapEnabled: false });

    await homebridge.start(config());

    expect(Object.keys(homebridge.services()).sort()).toEqual(["Front door", "Hallway", "Laundry"]);
  });

  it("checks the service once per the largest allowed pollSeconds when the setting is larger", async () => {
    const largest = configSchema.schema.properties.pollSeconds.maximum;
    const largestMs = largest * 1000;

    await homebridge.start({ ...config(), pollSeconds: largest * 1000 });
    await vi.advanceTimersByTimeAsync(largestMs - 1);
    expect(notion.count("GET /sensors")).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(notion.count("GET /sensors")).toBe(2);
  });

  it("reuses cached accessories after a restart", async () => {
    await homebridge.start(config());
    homebridge.stop();
    notion.setValue("a-door", "open");

    const restarted = new FakeHomebridge();
    await restarted.start(config(), homebridge.cache());
    restarted.stop();

    expect(restarted.registered).toEqual([]);
    expect(restarted.services()).toEqual(homebridge.services());
    expect(restarted.read("Front door", Service.ContactSensor, ContactSensorState)).toBe(
      ContactSensorState.CONTACT_NOT_DETECTED,
    );
  });

  it("waits before it tries a rejected password again", async () => {
    await homebridge.start({ ...config(), password: "wrong-password" });
    expect(homebridge.log.error).toHaveBeenCalled();

    await nextPoll();
    expect(notion.count("POST /auth/login")).toBe(1);

    await vi.advanceTimersByTimeAsync(AN_HOUR_MS);
    expect(notion.count("POST /auth/login")).toBeGreaterThan(1);
  });

  it("shows sensors as not responding during a long outage and recovers afterwards", async () => {
    await homebridge.start(config());
    notion.down = true;

    await nextPoll();
    expect(homebridge.faults()).toEqual([StatusFault.NO_FAULT]);

    for (let i = 0; i < POLLS_IN_A_LONG_OUTAGE; i++) await nextPoll();
    expect(homebridge.faults()).toEqual([StatusFault.GENERAL_FAULT]);

    notion.down = false;
    await nextPoll();
    expect(homebridge.faults()).toEqual([StatusFault.NO_FAULT]);
  });

  it("does not contact the service without an email and password", async () => {
    await homebridge.start({ apiBase: API_BASE });
    await nextPoll();

    expect(homebridge.log.error).toHaveBeenCalled();
    expect(notion.requests).toEqual([]);
  });
});
