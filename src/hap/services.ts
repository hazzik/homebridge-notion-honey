// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright (C) 2026 Alex Zaytsev

import type { HAP, Service } from "homebridge";
import type { Reading } from "../devices/index.js";

// The HomeKit service that each reading type appears as.
export const HAP_SERVICES = {
  contact: "ContactSensor",
  leak: "LeakSensor",
  smoke: "SmokeSensor",
  temperature: "TemperatureSensor",
} as const satisfies Record<Reading["type"], keyof HAP["Service"]>;

export function hasValue(reading: Reading): boolean {
  return reading.type !== "temperature" || reading.celsius !== null;
}

export function updateReading(svc: Service, hap: HAP, reading: Reading): void {
  const C = hap.Characteristic;
  switch (reading.type) {
    case "contact": {
      const { CONTACT_DETECTED, CONTACT_NOT_DETECTED } = C.ContactSensorState;
      svc.updateCharacteristic(C.ContactSensorState, reading.detected ? CONTACT_DETECTED : CONTACT_NOT_DETECTED);
      return;
    }
    case "leak": {
      const { LEAK_DETECTED, LEAK_NOT_DETECTED } = C.LeakDetected;
      svc.updateCharacteristic(C.LeakDetected, reading.detected ? LEAK_DETECTED : LEAK_NOT_DETECTED);
      return;
    }
    case "smoke": {
      const { SMOKE_DETECTED, SMOKE_NOT_DETECTED } = C.SmokeDetected;
      svc.updateCharacteristic(C.SmokeDetected, reading.detected ? SMOKE_DETECTED : SMOKE_NOT_DETECTED);
      return;
    }
    case "temperature":
      if (reading.celsius !== null) {
        svc.updateCharacteristic(C.CurrentTemperature, reading.celsius);
      } else {
        // Without a reading, Apple Home gets an error when it reads the temperature instead of the last value.
        svc.updateCharacteristic(
          C.CurrentTemperature,
          new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE),
        );
      }
  }
}
