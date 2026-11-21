// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright (C) 2026 Alex Zaytsev

import type { Logging, MatterAccessory, MatterAPI } from "homebridge";
import { isDeepStrictEqual } from "node:util";
import { MANUFACTURER, type Device, type DeviceListener } from "../devices/index.js";
import { batteryClusters, DEVICE_TYPES, readingClusters } from "./clusters.js";

// Homebridge compares the ids of the parts, not their device types, to decide whether a cached accessory changed.
function partId(listener: DeviceListener): string {
  return `${listener.reading.type}-${listener.id}`;
}

// The Matter API of Homebridge has no call that changes the device type or the parts of a registered accessory.
// The part ids are sorted because the service can return the listeners of a sensor in any order.
function shape(accessory: MatterAccessory): string {
  return JSON.stringify([accessory.deviceType.name, accessory.parts?.map((p) => p.id).sort() ?? []]);
}

function info(accessory: MatterAccessory): string {
  const { displayName, model, serialNumber, firmwareRevision } = accessory;
  return JSON.stringify([displayName, model, serialNumber, firmwareRevision]);
}

interface Registered {
  accessory: MatterAccessory;
  shape: string;
  info: string;
}

export class MatterSensors {
  private readonly log: Logging;
  private readonly matter: MatterAPI;
  private readonly pluginName: string;
  private readonly platformName: string;
  // UUID -> accessory that Homebridge restored from its cache and that the plugin has not registered yet.
  private readonly cached = new Map<string, MatterAccessory>();
  // UUID -> accessory that the plugin registered after Homebridge started.
  private readonly registered = new Map<string, Registered>();

  constructor(log: Logging, matter: MatterAPI, pluginName: string, platformName: string) {
    this.log = log;
    this.matter = matter;
    this.pluginName = pluginName;
    this.platformName = platformName;
  }

  configure(accessory: MatterAccessory): void {
    this.cached.set(accessory.UUID, accessory);
  }

  // Returns the Notion UUIDs of the sensors that got a new Matter accessory.
  async sync(devices: Device[], removeStale: boolean): Promise<string[]> {
    const added: string[] = [];
    const active = new Set<string>();
    for (const device of devices) {
      const accessory = this.build(device);
      active.add(accessory.UUID);
      try {
        if (await this.syncDevice(device, accessory)) added.push(device.uuid);
      } catch (e) {
        this.log.error(`The plugin could not publish "${device.name}" over Matter: ${(e as Error).message}`);
      }
    }
    if (removeStale) await this.removeStale(active);
    return added;
  }

  async markAllUnreachable(): Promise<void> {
    for (const accessory of this.all()) {
      try {
        await this.send(accessory.UUID, "bridgedDeviceBasicInformation", { reachable: false });
      } catch (e) {
        this.log.error(
          `The plugin could not mark "${accessory.displayName}" as not reachable over Matter: ${(e as Error).message}`,
        );
      }
    }
  }

  // Homebridge publishes the accessories from its cache before the plugin registers them again.
  private all(): MatterAccessory[] {
    return [...[...this.registered.values()].map((e) => e.accessory), ...this.cached.values()];
  }

  private build(device: Device): MatterAccessory {
    const accessory = {
      UUID: this.matter.uuid.generate(`notion-sensor:${device.uuid}`),
      displayName: device.name,
      manufacturer: MANUFACTURER,
      model: device.model,
      serialNumber: device.serialNumber,
      firmwareRevision: device.firmwareRevision,
      context: {},
    };
    if (device.listeners.length === 1) {
      const [{ reading }] = device.listeners;
      return {
        ...accessory,
        deviceType: this.matter.deviceTypes[DEVICE_TYPES[reading.type]],
        clusters: { ...batteryClusters(device), ...readingClusters(reading) },
      };
    }
    // A sensor with more than one listener appears as one accessory with one part per listener.
    return {
      ...accessory,
      deviceType: this.matter.deviceTypes.BridgedNode,
      clusters: batteryClusters(device),
      parts: device.listeners.map((l) => ({
        id: partId(l),
        displayName: `${device.name} ${l.label}`,
        deviceType: this.matter.deviceTypes[DEVICE_TYPES[l.reading.type]],
        clusters: readingClusters(l.reading),
      })),
    };
  }

  // Returns true when the sensor got a new accessory.
  private async syncDevice(device: Device, accessory: MatterAccessory): Promise<boolean> {
    const isNew = !this.registered.has(accessory.UUID) && !this.cached.has(accessory.UUID);
    let entry = this.registered.get(accessory.UUID);
    if (entry && (entry.shape !== shape(accessory) || !(await this.hasEndpoint(accessory.UUID)))) {
      await this.matter.unregisterPlatformAccessories(this.pluginName, this.platformName, [entry.accessory]);
      this.registered.delete(accessory.UUID);
      entry = undefined;
    }
    if (!entry) {
      // `registerPlatformAccessories` adds attributes to the clusters that it receives, so it gets its own copy from
      // `build()`.
      await this.matter.registerPlatformAccessories(this.pluginName, this.platformName, [this.build(device)]);
      entry = { accessory, shape: shape(accessory), info: info(accessory) };
      this.registered.set(accessory.UUID, entry);
      this.cached.delete(accessory.UUID);
      const tasks = device.listeners.map((l) => l.label).join(", ");
      if (isNew) this.log.info(`The plugin added "${device.name}" to Matter with these tasks: ${tasks}.`);
    } else if (entry.info !== info(accessory)) {
      // `updatePlatformAccessories` changes only the cached copy, which Homebridge uses on its next start.
      await this.matter.updatePlatformAccessories([accessory]);
      entry.accessory = accessory;
      entry.info = info(accessory);
    }
    await this.sendState(device, accessory);
    return isNew;
  }

  // Homebridge resolves `registerPlatformAccessories` even when the registration fails, and Homebridge 2.0 to 2.4
  // resolves it before the bridge adds the endpoint. A later poll finds out whether the endpoint exists.
  private async hasEndpoint(uuid: string): Promise<boolean> {
    return (await this.matter.getAccessoryState(uuid, "bridgedDeviceBasicInformation")) !== undefined;
  }

  private async sendState(device: Device, accessory: MatterAccessory): Promise<void> {
    await this.send(accessory.UUID, "bridgedDeviceBasicInformation", { reachable: !device.missing });
    for (const [cluster, attributes] of Object.entries(accessory.clusters ?? {})) {
      await this.send(accessory.UUID, cluster, attributes);
    }
    for (const part of accessory.parts ?? []) {
      for (const [cluster, attributes] of Object.entries(part.clusters)) {
        await this.send(accessory.UUID, cluster, attributes, part.id);
      }
    }
  }

  // Sends only the attributes whose value differs from the state of the endpoint. Homebridge resolves
  // `updateAccessoryState` even when the update fails, so the plugin compares with the endpoint and not with what it
  // sent before.
  private async send(
    uuid: string,
    cluster: string,
    attributes: Record<string, unknown>,
    partId?: string,
  ): Promise<void> {
    const state = await this.matter.getAccessoryState(uuid, cluster, partId);
    if (state && Object.entries(attributes).every(([name, value]) => isDeepStrictEqual(state[name], value))) return;
    await this.matter.updateAccessoryState(uuid, cluster, attributes, partId);
  }

  // Remove accessories for sensors that are gone from the account.
  private async removeStale(active: Set<string>): Promise<void> {
    const stale = this.all().filter((a) => !active.has(a.UUID));
    if (!stale.length) return;
    for (const a of stale) {
      this.log.info(
        `The plugin is removing "${a.displayName}" from Matter because the sensor is no longer in your Notion/Honey account.`,
      );
    }
    try {
      await this.matter.unregisterPlatformAccessories(this.pluginName, this.platformName, stale);
    } catch (e) {
      this.log.error(`The plugin could not remove accessories from Matter: ${(e as Error).message}`);
      return;
    }
    for (const a of stale) {
      this.registered.delete(a.UUID);
      this.cached.delete(a.UUID);
    }
  }
}
