// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright (C) 2026 Alex Zaytsev

import type { Listener, Sensor } from "../notion/index.js";
import type { Device } from "./device.js";
import { batteryLevel, KIND, LISTENER_KINDS, primaryValue } from "./listener-kinds.js";

function cleanName(name: string): string {
  // HomeKit names must start and end with a letter or digit.
  const cleaned = String(name)
    .replace(/[^\p{L}\p{N} '’.,-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  return cleaned || "Notion sensor";
}

function groupBySensor(listeners: Listener[]): Map<string, Listener[]> {
  return Map.groupBy(
    listeners.filter((l) => l?.sensor_id != null),
    (l) => String(l.sensor_id),
  );
}

function sensorStatus(sensor: Sensor, ls: Listener[]): Pick<Device, "battery" | "missing"> {
  const battery = ls.find((l) => l.definition_id === KIND.BATTERY);
  const connection = ls.find((l) => l.definition_id === KIND.CONNECTION);
  return {
    battery: batteryLevel(battery),
    missing: connection ? primaryValue(connection) !== "not_missing" : Boolean(sensor.missing_at),
  };
}

function sensorInfo(sensor: Sensor): Pick<Device, "name" | "model" | "serialNumber" | "firmwareRevision"> {
  return {
    name: cleanName(sensor.name || `Notion ${sensor.id}`),
    model: `Notion sensor${sensor.hardware_revision ? ` rev ${sensor.hardware_revision}` : ""}`,
    serialNumber: String(sensor.hardware_id || sensor.id || sensor.uuid),
    firmwareRevision: String(sensor.firmware_version || "1.0.0"),
  };
}

function toDevice(sensor: Sensor, bySensor: Map<string, Listener[]>, celsius: boolean | null): Device | null {
  if (!sensor?.uuid) return null;
  const ls = bySensor.get(String(sensor.uuid)) || bySensor.get(String(sensor.id)) || [];
  const listeners = ls.flatMap((l) => {
    const kind = LISTENER_KINDS[l.definition_id];
    return kind ? [{ id: String(l.id), label: kind.label, reading: kind.read(l, celsius) }] : [];
  });
  if (listeners.length === 0) return null;
  return { uuid: String(sensor.uuid), ...sensorInfo(sensor), ...sensorStatus(sensor, ls), listeners };
}

// Leaves out the sensors that have no listener of a kind in `LISTENER_KINDS`.
export function toDevices(sensors: Sensor[], listeners: Listener[], celsius: boolean | null): Device[] {
  const bySensor = groupBySensor(listeners);
  return sensors.flatMap((sensor) => {
    const device = toDevice(sensor, bySensor, celsius);
    return device ? [device] : [];
  });
}
