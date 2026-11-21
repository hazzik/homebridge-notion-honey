// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright (C) 2026 Alex Zaytsev

// The plugin registers as a phone with the Honey Smart Home Android app and receives the push alerts that the
// Notion/Honey service sends to the app. honey-app.json holds the settings of the app that it uses for that.
// test/push.ts runs this file without a build, so it can import only files that need no build, such as JSON files.

import type { PushReceiver } from "@eneris/push-receiver";
import type { Credentials } from "@eneris/push-receiver/dist/types.js";
import { createHash } from "node:crypto";
import type { DeviceRegistration } from "../types.js";
import app from "./honey-app.json" with { type: "json" };

// The body of `POST /devices`, which the app sends on each start and after login. Like the app, the plugin sets
// `device_id` to the MD5 hash of the package name and a random id that it keeps.
export function deviceRegistration(token: string, guid: string): DeviceRegistration {
  const deviceId = createHash("md5")
    .update(app.packageName + guid)
    .digest("hex");
  return {
    device: {
      token,
      app_version: app.appVersion,
      os_version: app.targetAndroidApiLevel,
      device_id: deviceId,
      platform: "android",
    },
  };
}

// push-receiver 4.4.0 leaves two promise rejections without a handler, and Homebridge stops on either:
// - `destroy()` rejects `whenReady` when the connection is not ready yet.
// - After a connection drops, push-receiver calls `connect()` again and ignores the promise that it returns.
// push-receiver calls both `destroy()` and `connect()` through the instance, so these wrappers handle every call.
// The function loads push-receiver on its first call, so that Homebridge does not load it when push updates are off.
export async function createPushReceiver(
  credentials: Credentials | undefined,
  onConnectError: (e: unknown) => void,
): Promise<PushReceiver> {
  const library = await import("@eneris/push-receiver");
  const receiver = new library.PushReceiver({ firebase: app.firebase, credentials });
  const { connect, destroy } = receiver;
  receiver.connect = () => connect().catch(onConnectError);
  receiver.destroy = () => {
    receiver.whenReady.catch(() => {});
    destroy();
  };
  return receiver;
}
