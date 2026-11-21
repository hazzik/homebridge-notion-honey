// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright (C) 2026 Alex Zaytsev

import type { Logging, MatterAccessory, MatterAPI } from "homebridge";
import { MANUFACTURER, type Device, type DeviceListener } from "../devices/index.js";
import { batteryClusters, DEVICE_TYPES, readingClusters } from "./clusters.js";

// Homebridge compares the ids of the parts, not their device types, to decide whether a cached accessory changed.
function partId(listener: DeviceListener): string {
  return `${listener.reading.type}-${listener.id}`;
}

// The Matter API of Homebridge has no call that changes the device type or the parts of a registered accessory.
function shape(accessory: MatterAccessory): string {
  return JSON.stringify([accessory.deviceType.name, accessory.parts?.map((p) => p.id) ?? []]);
}

function info(accessory: MatterAccessory): string {
  const { displayName, model, serialNumber, firmwareRevision } = accessory;
  return JSON.stringify([displayName, model, serialNumber, firmwareRevision]);
}

interface Registered {
  accessory: MatterAccessory;
  shape: string;
  info: string;
  // The attribute values that the plugin last sent to Homebridge, as JSON, keyed by part id and cluster name.
  sent: Map<string, string>;
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
    for (const entry of this.registered.values()) {
      try {
        await this.send(entry, "bridgedDeviceBasicInformation", { reachable: false });
      } catch (e) {
        this.log.error(
          `The plugin could not mark "${entry.accessory.displayName}" as not reachable over Matter: ${(e as Error).message}`,
        );
      }
    }
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
    if (entry && entry.shape !== shape(accessory)) {
      await this.matter.unregisterPlatformAccessories(this.pluginName, this.platformName, [entry.accessory]);
      this.registered.delete(accessory.UUID);
      entry = undefined;
    }
    if (!entry) {
      // Homebridge keeps the cached state of a restored accessory, so `sendState()` sends every value after the
      // registration. `registerPlatformAccessories` adds attributes to the clusters that it receives, so it gets
      // its own copy from `build()`.
      await this.matter.registerPlatformAccessories(this.pluginName, this.platformName, [this.build(device)]);
      entry = { accessory, shape: shape(accessory), info: info(accessory), sent: new Map() };
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
    await this.sendState(entry, device, accessory);
    return isNew;
  }

  private async sendState(entry: Registered, device: Device, accessory: MatterAccessory): Promise<void> {
    await this.send(entry, "bridgedDeviceBasicInformation", { reachable: !device.missing });
    for (const [cluster, attributes] of Object.entries(accessory.clusters ?? {})) {
      await this.send(entry, cluster, attributes);
    }
    for (const part of accessory.parts ?? []) {
      for (const [cluster, attributes] of Object.entries(part.clusters)) {
        await this.send(entry, cluster, attributes, part.id);
      }
    }
  }

  private async send(
    entry: Registered,
    cluster: string,
    attributes: Record<string, unknown>,
    partId?: string,
  ): Promise<void> {
    const key = `${partId ?? ""}/${cluster}`;
    const json = JSON.stringify(attributes);
    if (entry.sent.get(key) === json) return;
    await this.matter.updateAccessoryState(entry.accessory.UUID, cluster, attributes, partId);
    entry.sent.set(key, json);
  }

  // Remove accessories for sensors that are gone from the account.
  private async removeStale(active: Set<string>): Promise<void> {
    const stale = [...[...this.registered.values()].map((e) => e.accessory), ...this.cached.values()].filter(
      (a) => !active.has(a.UUID),
    );
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
