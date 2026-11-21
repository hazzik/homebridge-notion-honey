// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright (C) 2026 Alex Zaytsev

import type { MatterAccessory, MatterAPI } from "homebridge";
import { hasValue, type Device, type KnownReading, type Reading } from "../devices/index.js";

type Clusters = NonNullable<MatterAccessory["clusters"]>;

export const DEVICE_TYPES = {
  contact: "ContactSensor",
  leak: "LeakSensor",
  smoke: "SmokeSensor",
  temperature: "TemperatureSensor",
} as const satisfies Record<Reading["type"], keyof MatterAPI["deviceTypes"]>;

// Values of the Matter enums PowerSource.PowerSourceStatus, PowerSource.BatChargeLevel,
// SmokeCoAlarm.AlarmState and SmokeCoAlarm.ExpressedState. `api.matter.types` does not export these enums.
const POWER_SOURCE_STATUS = { ACTIVE: 1 } as const;
const BAT_CHARGE_LEVEL = { OK: 0, WARNING: 1 } as const;
const ALARM_STATE = { NORMAL: 0, CRITICAL: 2 } as const;
const EXPRESSED_STATE = { NORMAL: 0, SMOKE_ALARM: 1 } as const;

// Matter takes a null temperature, but it has no unknown state for a contact, leak or smoke sensor.
export function hasMatterValue(reading: Reading): reading is KnownReading | Extract<Reading, { type: "temperature" }> {
  return reading.type === "temperature" || hasValue(reading);
}

export function readingClusters(reading: Reading): Clusters {
  // The device keeps its last state, and `MatterSensors` marks it as not reachable.
  if (!hasMatterValue(reading)) return {};
  switch (reading.type) {
    case "contact":
    case "leak":
      return { booleanState: { stateValue: reading.detected } };
    case "smoke":
      return {
        smokeCoAlarm: {
          smokeState: reading.detected ? ALARM_STATE.CRITICAL : ALARM_STATE.NORMAL,
          expressedState: reading.detected ? EXPRESSED_STATE.SMOKE_ALARM : EXPRESSED_STATE.NORMAL,
        },
      };
    case "temperature":
      // Matter measures temperature in hundredths of a degree Celsius.
      return {
        temperatureMeasurement: {
          measuredValue: reading.celsius === null ? null : Math.round(reading.celsius * 100),
        },
      };
  }
}

export function batteryClusters(device: Device): Clusters {
  return {
    powerSource: {
      status: POWER_SOURCE_STATUS.ACTIVE,
      order: 0,
      description: "Battery",
      batChargeLevel: device.lowBattery ? BAT_CHARGE_LEVEL.WARNING : BAT_CHARGE_LEVEL.OK,
      batReplacementNeeded: device.lowBattery,
    },
  };
}
