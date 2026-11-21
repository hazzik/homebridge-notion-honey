// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright (C) 2026 Alex Zaytsev

import type { Logging, MatterAccessory, MatterAPI } from "homebridge";
import { MANUFACTURER, type Device, type DeviceListener } from "../devices/index.js";
import { batteryClusters, DEVICE_TYPES, hasMatterValue, readingClusters } from "./clusters.js";

// Homebridge compares the ids of the parts, not their device types, to decide whether a cached accessory changed.
function partId(listener: DeviceListener): string {
  return `${listener.reading.type}-${listener.id}`;
}

// The Matter API of Homebridge has no call that changes the device type or the parts of a registered accessory.
// The order of the listeners can change.
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
  private readonly basicInfoCluster: string;
  // UUID -> accessory that Homebridge restored from its cache and that the plugin has not registered yet.
  private readonly cached = new Map<string, MatterAccessory>();
  // UUID -> accessory that the plugin registered after Homebridge started.
  private readonly registered = new Map<string, Registered>();

  constructor(log: Logging, matter: MatterAPI, pluginName: string, platformName: string) {
    this.log = log;
    this.matter = matter;
    this.pluginName = pluginName;
    this.platformName = platformName;
    this.basicInfoCluster = matter.clusterNames.BridgedDeviceBasicInformation;
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
        await this.matter.updateAccessoryState(accessory.UUID, this.basicInfoCluster, { reachable: false });
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
    const known = device.listeners.every((l) => hasMatterValue(l.reading));
    const entry = await this.currentEntry(accessory);
    if (!entry) {
      // Homebridge already publishes a cached device.
      if (!known) {
        if (this.cached.has(accessory.UUID)) {
          await this.matter.updateAccessoryState(accessory.UUID, this.basicInfoCluster, { reachable: false });
        }
        return false;
      }
      await this.register(device, accessory, isNew);
    } else if (known && entry.info !== info(accessory)) {
      // `updatePlatformAccessories` also replaces the cached clusters.
      await this.matter.updatePlatformAccessories([accessory]);
      entry.accessory = accessory;
      entry.info = info(accessory);
    }
    await this.sendState(accessory, !device.missing && known);
    return isNew;
  }

  // `registerPlatformAccessories` can resolve without an endpoint, so a later poll checks for one.
  private async currentEntry(accessory: MatterAccessory): Promise<Registered | undefined> {
    const entry = this.registered.get(accessory.UUID);
    if (!entry) return undefined;
    if (
      entry.shape === shape(accessory) &&
      (await this.matter.getAccessoryState(accessory.UUID, this.basicInfoCluster))
    ) {
      return entry;
    }
    await this.matter.unregisterPlatformAccessories(this.pluginName, this.platformName, [entry.accessory]);
    this.registered.delete(accessory.UUID);
    return undefined;
  }

  private async register(device: Device, accessory: MatterAccessory, isNew: boolean): Promise<void> {
    // `registerPlatformAccessories` changes the clusters that it receives, so it gets a copy.
    await this.matter.registerPlatformAccessories(this.pluginName, this.platformName, [this.build(device)]);
    this.registered.set(accessory.UUID, { accessory, shape: shape(accessory), info: info(accessory) });
    this.cached.delete(accessory.UUID);
    const tasks = device.listeners.map((l) => l.label).join(", ");
    if (isNew) this.log.info(`The plugin added "${device.name}" to Matter with these tasks: ${tasks}.`);
  }

  // matter.js ignores a value that did not change, so the plugin sends every value on each poll.
  private async sendState(accessory: MatterAccessory, reachable: boolean): Promise<void> {
    await this.matter.updateAccessoryState(accessory.UUID, this.basicInfoCluster, { reachable });
    const endpoints = [{ id: undefined, clusters: accessory.clusters ?? {} }, ...(accessory.parts ?? [])];
    for (const { id, clusters } of endpoints) {
      for (const [cluster, attributes] of Object.entries(clusters)) {
        await this.matter.updateAccessoryState(accessory.UUID, cluster, attributes, id);
      }
    }
  }

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
