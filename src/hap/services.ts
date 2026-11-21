// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright (C) 2026 Alex Zaytsev

import type { Characteristic, HAP, Service } from "homebridge";
import { hasValue, type Reading } from "../devices/index.js";

export const HAP_SERVICES = {
  contact: "ContactSensor",
  leak: "LeakSensor",
  smoke: "SmokeSensor",
  temperature: "TemperatureSensor",
} as const satisfies Record<Reading["type"], keyof typeof Service>;

const HAP_CHARACTERISTICS = {
  contact: "ContactSensorState",
  leak: "LeakDetected",
  smoke: "SmokeDetected",
  temperature: "CurrentTemperature",
} as const satisfies Record<Reading["type"], keyof typeof Characteristic>;

function hapValue(C: typeof Characteristic, reading: Reading): number | null {
  if (!hasValue(reading)) return null;
  switch (reading.type) {
    case "temperature":
      return reading.celsius;
    case "contact":
      return reading.detected ? C.ContactSensorState.CONTACT_DETECTED : C.ContactSensorState.CONTACT_NOT_DETECTED;
    case "leak":
      return reading.detected ? C.LeakDetected.LEAK_DETECTED : C.LeakDetected.LEAK_NOT_DETECTED;
    case "smoke":
      return reading.detected ? C.SmokeDetected.SMOKE_DETECTED : C.SmokeDetected.SMOKE_NOT_DETECTED;
  }
}

export function updateReading(svc: Service, hap: HAP, reading: Reading): void {
  const characteristic = hap.Characteristic[HAP_CHARACTERISTICS[reading.type]];
  const value = hapValue(hap.Characteristic, reading);
  if (value === null) {
    // Without a value, Apple Home gets an error when it reads the characteristic instead of the last value.
    svc.updateCharacteristic(characteristic, new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
  } else {
    svc.updateCharacteristic(characteristic, value);
  }
}
