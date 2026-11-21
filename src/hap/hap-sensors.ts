// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright (C) 2026 Alex Zaytsev

import type { API, Logging, PlatformAccessory, Service } from "homebridge";
import { hasValue, MANUFACTURER, type Device, type DeviceListener } from "../devices/index.js";
import { HAP_SERVICES, updateReading } from "./services.js";

export class HapSensors {
  private readonly log: Logging;
  private readonly api: API;
  private readonly pluginName: string;
  private readonly platformName: string;
  // UUID -> accessory that Homebridge restored from its cache or that `syncSensor` created.
  private readonly accessories = new Map<string, PlatformAccessory>();

  constructor(log: Logging, api: API, pluginName: string, platformName: string) {
    this.log = log;
    this.api = api;
    this.pluginName = pluginName;
    this.platformName = platformName;
  }

  configure(accessory: PlatformAccessory): void {
    this.accessories.set(accessory.UUID, accessory);
  }

  // Returns the Notion UUIDs of the sensors that got a new HomeKit accessory.
  sync(devices: Device[], removeStale: boolean): string[] {
    const activeUuids = new Set<string>();
    const added: PlatformAccessory[] = [];
    const addedDevices: string[] = [];
    const changed: PlatformAccessory[] = [];

    for (const device of devices) {
      const synced = this.syncSensor(device);
      if (!synced) continue;
      const { acc, isNew, dirty } = synced;
      activeUuids.add(acc.UUID);
      if (isNew) {
        added.push(acc);
        addedDevices.push(device.uuid);
      } else if (dirty) changed.push(acc);
    }

    if (added.length) this.api.registerPlatformAccessories(this.pluginName, this.platformName, added);
    if (changed.length) this.api.updatePlatformAccessories(changed);
    if (removeStale) this.removeStale(activeUuids);
    return addedDevices;
  }

  markAllFaulty(): void {
    for (const acc of this.accessories.values()) this.setFault(acc);
  }

  // Homebridge rewrites its whole cache file each time the plugin calls `registerPlatformAccessories` or
  // `updatePlatformAccessories`. `dirty` is true when this poll changed a value that the cache stores.
  // Returns undefined when the sensor has no service to show yet.
  private syncSensor(device: Device): { acc: PlatformAccessory; isNew: boolean; dirty: boolean } | undefined {
    const uuid = this.api.hap.uuid.generate(`notion-sensor:${device.uuid}`);
    let acc = this.accessories.get(uuid);
    const listeners = this.shownListeners(acc, device);
    if (!listeners.length) return undefined;
    const isNew = !acc;
    if (!acc) {
      acc = new this.api.platformAccessory(device.name, uuid);
      this.accessories.set(uuid, acc);
      const tasks = listeners.map((l) => l.label).join(", ");
      this.log.info(`The plugin added "${device.name}" to HomeKit with these tasks: ${tasks}.`);
    }

    const infoChanged = this.updateInfo(acc, device);
    const servicesChanged = this.updateServices(acc, device, listeners);
    return { acc, isNew, dirty: infoChanged || servicesChanged };
  }

  // A new service would show the default value of its characteristic, such as 0 °C, so the plugin adds the service
  // of a listener only once the listener has a value.
  private shownListeners(acc: PlatformAccessory | undefined, device: Device): DeviceListener[] {
    return device.listeners.filter((l) => hasValue(l.reading) || acc?.getServiceById(this.serviceType(l), l.id));
  }

  private serviceType(listener: DeviceListener): typeof Service.ContactSensor {
    return this.api.hap.Service[HAP_SERVICES[listener.reading.type]];
  }

  private updateInfo(acc: PlatformAccessory, device: Device): boolean {
    const { Service, Characteristic } = this.api.hap;
    const info = acc.getService(Service.AccessoryInformation)!;
    let dirty = false;
    for (const [c, value] of [
      [Characteristic.Manufacturer, MANUFACTURER],
      [Characteristic.Model, device.model],
      [Characteristic.SerialNumber, device.serialNumber],
      [Characteristic.FirmwareRevision, device.firmwareRevision],
    ] as const) {
      if (info.getCharacteristic(c).value === value) continue;
      info.setCharacteristic(c, value);
      dirty = true;
    }
    return dirty;
  }

  private updateServices(acc: PlatformAccessory, device: Device, listeners: DeviceListener[]): boolean {
    const { Characteristic } = this.api.hap;
    const { BATTERY_LEVEL_LOW, BATTERY_LEVEL_NORMAL } = Characteristic.StatusLowBattery;
    const { GENERAL_FAULT, NO_FAULT } = Characteristic.StatusFault;
    const wanted = listeners.map((l) => ({ l, type: this.serviceType(l) }));
    let dirty = false;

    // Remove the services whose listener is gone from the app or now has another type.
    const keep = new Set(wanted.map((w) => `${w.type.UUID}|${w.l.id}`));
    for (const svc of this.sensorServices(acc)) {
      if (keep.has(`${svc.UUID}|${svc.subtype}`)) continue;
      acc.removeService(svc);
      dirty = true;
    }

    for (const w of wanted) {
      let svc = acc.getServiceById(w.type, w.l.id);
      if (!svc) {
        const name = `${device.name} ${w.l.label}`;
        svc = acc.addService(w.type, name, w.l.id);
        svc.addOptionalCharacteristic(Characteristic.ConfiguredName);
        svc.setCharacteristic(Characteristic.ConfiguredName, name);
        dirty = true;
      }
      updateReading(svc, this.api.hap, w.l.reading);
      svc.updateCharacteristic(
        Characteristic.StatusLowBattery,
        device.lowBattery ? BATTERY_LEVEL_LOW : BATTERY_LEVEL_NORMAL,
      );
      svc.updateCharacteristic(Characteristic.StatusFault, device.missing ? GENERAL_FAULT : NO_FAULT);
      svc.updateCharacteristic(Characteristic.StatusActive, !device.missing);
    }
    return dirty;
  }

  private removeStale(activeUuids: Set<string>): void {
    const stale = [...this.accessories.entries()].filter(([u]) => !activeUuids.has(u));
    if (!stale.length) return;
    for (const [u, acc] of stale) {
      this.log.info(
        `The plugin is removing "${acc.displayName}" from HomeKit because the sensor is no longer in your Notion/Honey account.`,
      );
      this.accessories.delete(u);
    }
    this.api.unregisterPlatformAccessories(
      this.pluginName,
      this.platformName,
      stale.map(([, a]) => a),
    );
  }

  private setFault(acc: PlatformAccessory): void {
    const { Characteristic } = this.api.hap;
    for (const svc of this.sensorServices(acc)) {
      svc.updateCharacteristic(Characteristic.StatusFault, Characteristic.StatusFault.GENERAL_FAULT);
    }
  }

  private sensorServices(acc: PlatformAccessory): Service[] {
    return acc.services.filter((svc) => svc.UUID !== this.api.hap.Service.AccessoryInformation.UUID);
  }
}
