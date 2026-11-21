// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright (C) 2026 Alex Zaytsev

export const MANUFACTURER = "Notion";

// `detected` has the same meaning as in HomeKit and Matter. For a contact sensor, `detected: true` means "closed".
// For a contact, leak or smoke sensor, null means that the service reports a value that is neither state, for example
// while the sensor calibrates.
export type Reading =
  { type: "contact" | "leak" | "smoke"; detected: boolean | null } | { type: "temperature"; celsius: number | null };

export type KnownReading =
  { type: "contact" | "leak" | "smoke"; detected: boolean } | { type: "temperature"; celsius: number };

export function hasValue(reading: Reading): reading is KnownReading {
  return reading.type === "temperature" ? reading.celsius !== null : reading.detected !== null;
}

export interface DeviceListener {
  id: string;
  label: string;
  reading: Reading;
}

export interface Device {
  uuid: string;
  name: string;
  model: string;
  serialNumber: string;
  firmwareRevision: string;
  lowBattery: boolean;
  missing: boolean;
  listeners: DeviceListener[];
}
