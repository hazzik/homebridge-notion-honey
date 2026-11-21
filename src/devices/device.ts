// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright (C) 2026 Alex Zaytsev

export const MANUFACTURER = "Notion";

// `detected` has the same meaning as in HomeKit and Matter. For a contact sensor, `detected: true` means "closed".
export type Reading =
  { type: "contact" | "leak" | "smoke"; detected: boolean } | { type: "temperature"; celsius: number | null };

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
