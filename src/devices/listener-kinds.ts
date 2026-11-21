// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright (C) 2026 Alex Zaytsev

import type { Listener } from "../notion/index.js";
import type { Reading } from "./device.js";

// The `definition_id` value of each kind of Notion listener.
export const KIND = {
  BATTERY: 0,
  TEMPERATURE: 3,
  LEAK: 4,
  SAFE: 5,
  DOOR: 6,
  ALARM: 7,
  CONNECTION: 10,
  WINDOW_HINGED_VERTICAL: 12,
  GARAGE_DOOR: 13,
  WINDOW_HINGED_HORIZONTAL: 16,
  SLIDING_DOOR_OR_WINDOW: 32,
} as const;

interface ListenerKind {
  label: string;
  // `celsius` is null when the plugin does not know the temperature unit of the account.
  read(listener: Listener, celsius: boolean | null): Reading;
}

export function primaryValue(listener: Listener | undefined): string | null {
  return listener?.insights?.primary?.value ?? null;
}

// The Honey app also knows values in which the state is unknown, such as "initializing", "calibrating_init" and
// "needs_resync" for a door, and "short" for a leak sensor that cannot detect leaks.
function detected(listener: Listener, yes: string[], no: string[]): boolean | null {
  const value = primaryValue(listener);
  if (value === null) return null;
  if (yes.includes(value)) return true;
  if (no.includes(value)) return false;
  return null;
}

function contactSensor(label: string): ListenerKind {
  return { label, read: (l) => ({ type: "contact", detected: detected(l, ["closed"], ["open"]) }) };
}

function temperature(listener: Listener, celsius: boolean | null): number | null {
  // The API returns the temperature only as text, such as "24°", in the unit that the account uses.
  const text = listener.status_localized?.state;
  const match = typeof text === "string" ? text.match(/-?\d+(?:\.\d+)?/) : null;
  if (!match || celsius === null) return null;
  const value = parseFloat(match[0]);
  return celsius ? value : ((value - 32) * 5) / 9;
}

// The listener kinds that appear in Apple Home.
export const LISTENER_KINDS: Partial<Record<number, ListenerKind>> = {
  [KIND.SAFE]: contactSensor("Safe"),
  [KIND.DOOR]: contactSensor("Door"),
  [KIND.WINDOW_HINGED_VERTICAL]: contactSensor("Window"),
  [KIND.GARAGE_DOOR]: contactSensor("Garage door"),
  [KIND.WINDOW_HINGED_HORIZONTAL]: contactSensor("Window"),
  [KIND.SLIDING_DOOR_OR_WINDOW]: contactSensor("Sliding door"),
  [KIND.LEAK]: { label: "Leak", read: (l) => ({ type: "leak", detected: detected(l, ["leak"], ["no_leak"]) }) },
  // The Honey app shows "smoke" in a task's history as a warning, so the plugin counts it as an alarm too.
  [KIND.ALARM]: {
    label: "Smoke alarm",
    read: (l) => ({ type: "smoke", detected: detected(l, ["alarm", "smoke"], ["no_alarm"]) }),
  },
  [KIND.TEMPERATURE]: {
    label: "Temperature",
    read: (l, celsius) => ({ type: "temperature", celsius: temperature(l, celsius) }),
  },
};
