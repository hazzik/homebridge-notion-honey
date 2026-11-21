// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright (C) 2026 Alex Zaytsev
// Registers this computer with a Notion account as an Android phone of the Honey Smart Home app, then prints every push
// alert that the phone receives.
//
// Run this command in the repository root:
//   NOTION_EMAIL=you@example.com NOTION_PASSWORD='your password' node test/push.ts
// The script saves the push credentials in test/push-credentials.json, so the next run reuses the same phone.
// Set NOTION_API_BASE to use another Notion API, such as the fake service in test/mock.ts.
import type { MessageEnvelope } from "@eneris/push-receiver/dist/types.js";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { parseJson, send } from "../src/notion/http.ts";
import { createPushReceiver, deviceRegistration } from "../src/notion/push/honey-app.ts";
import type { SavedPhone } from "../src/notion/push/push-updates.ts";

const FILE = new URL("push-credentials.json", import.meta.url);
const API_BASE = process.env.NOTION_API_BASE || "https://api.getnotion.com/api";
const { NOTION_EMAIL: email, NOTION_PASSWORD: password } = process.env;
if (!email || !password) {
  console.error("Set NOTION_EMAIL and NOTION_PASSWORD to the email and password of your Honey Smart Home account.");
  process.exit(1);
}

async function load(): Promise<SavedPhone> {
  try {
    return JSON.parse(await readFile(FILE, "utf8")) as SavedPhone;
  } catch {
    return { guid: randomUUID() };
  }
}

async function post(path: string, body: unknown, jwt?: string): Promise<{ status: number; text: string }> {
  const res = await send(API_BASE + path, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "Accept-Version": "2",
      ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

// The `notion` field of an alert holds JSON text.
function print({ message, persistentId }: MessageEnvelope): void {
  const data: Record<string, unknown> = { ...message.data };
  if (typeof data.notion === "string") data.notion = parseJson(data.notion) ?? data.notion;
  console.log(`\n${new Date().toISOString()} push ${persistentId}`);
  console.log(JSON.stringify({ ...message, data }, null, 2));
}

const saved = await load();
const receiver = await createPushReceiver(saved.credentials, (e) => {
  console.error(`The script could not connect to the Google push service again: ${(e as Error).message}`);
  process.exit(1);
});
receiver.onCredentialsChanged(({ newCredentials }) => {
  saved.credentials = newCredentials;
  writeFile(FILE, JSON.stringify(saved, null, 2), { mode: 0o600 }).catch((e: unknown) => {
    console.error(`The script could not save the push credentials: ${(e as Error).message}`);
  });
});
receiver.onNotification(print);
receiver.on("ON_DISCONNECT", () => {
  console.log("The connection to the Google push service dropped. The script connects again.");
});
process.on("SIGINT", () => {
  receiver.destroy();
  process.exit(0);
});

await receiver.connect();
const registration = deviceRegistration(receiver.fcmToken, saved.guid);
console.log(`The script connected to the Google push service as phone ${registration.device.device_id}.`);

const login = await post("/auth/login", { auth: { email, password, session_name: "homebridge-push-test" } });
if (login.status !== 200) {
  console.error(`POST /auth/login failed with HTTP ${login.status}: ${login.text}`);
  process.exit(1);
}
const { auth } = JSON.parse(login.text) as { auth: { jwt: string } };
const device = await post("/devices", registration, auth.jwt);
console.log(`POST /devices returned HTTP ${device.status}: ${device.text || "an empty reply"}`);
console.log("The script waits for pushes. Open a door or a window that has a sensor. Press Ctrl+C to stop.");
