// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright (C) 2026 Alex Zaytsev
// Prints each sensor service that Homebridge publishes, with the values of the characteristics in `C`.
// Homebridge must run in insecure mode, which the `-I` flag turns on.
import { Characteristic, Service, uuid } from "@homebridge/hap-nodejs";
import config from "./config.json" with { type: "json" };

interface HapCharacteristic {
  type: string;
  value: unknown;
}
interface HapAccessories {
  accessories: { aid: number; services: { type: string; characteristics: HapCharacteristic[] }[] }[];
}

const { bridge } = config;
const T: Record<string, string> = {
  [Service.AccessoryInformation.UUID]: "Info",
  [Service.ContactSensor.UUID]: "ContactSensor",
  [Service.LeakSensor.UUID]: "LeakSensor",
  [Service.SmokeSensor.UUID]: "SmokeSensor",
  [Service.TemperatureSensor.UUID]: "TemperatureSensor",
};
const C: Record<string, string> = {
  [Characteristic.ContactSensorState.UUID]: "ContactState",
  [Characteristic.LeakDetected.UUID]: "LeakDetected",
  [Characteristic.SmokeDetected.UUID]: "SmokeDetected",
  [Characteristic.CurrentTemperature.UUID]: "Temperature",
  [Characteristic.StatusLowBattery.UUID]: "LowBattery",
  [Characteristic.StatusFault.UUID]: "Fault",
  [Characteristic.StatusActive.UUID]: "Active",
  [Characteristic.ConfiguredName.UUID]: "ConfiguredName",
  [Characteristic.Name.UUID]: "Name",
};
const k = uuid.toLongForm;
const r = await fetch(`http://127.0.0.1:${bridge.port}/accessories`, { headers: { Authorization: bridge.pin } });
const d = (await r.json()) as HapAccessories;
for (const a of d.accessories) {
  if (a.aid === 1) continue;
  for (const s of a.services) {
    const t = T[k(s.type)] || s.type;
    if (t === "Info") continue;
    const parts = s.characteristics.flatMap((c) => {
      const n = C[k(c.type)];
      return n ? [`${n}=${JSON.stringify(c.value)}`] : [];
    });
    console.log(`aid ${a.aid} ${t}: ${parts.join(" ")}`);
  }
}
