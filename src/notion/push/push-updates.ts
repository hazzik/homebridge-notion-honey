// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright (C) 2026 Alex Zaytsev

// Receives the push alerts that the Notion/Honey service sends to the Honey Smart Home app. The plugin registers with
// Google as an Android phone of the app, registers that phone with the account, and calls `onPush` for each alert.

import type { PushReceiver } from "@eneris/push-receiver";
import type { Credentials, MessageEnvelope } from "@eneris/push-receiver/dist/types.js";
import type { Logging } from "homebridge";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import type { NotionClient } from "../client.js";
import { createPushReceiver, deviceRegistration } from "./honey-app.js";

// The plugin gives up on a connection to Google that is not ready after `CONNECT_WAIT_MS`. After that, or after Google
// or the service rejects the phone, it waits `RETRY_FIRST_MS` and starts push again. It doubles the wait after each
// failure, up to `RETRY_MAX_MS`.
export const CONNECT_WAIT_MS = 2 * 60 * 1000;
export const RETRY_FIRST_MS = 2 * 60 * 1000;
export const RETRY_MAX_MS = 60 * 60 * 1000;

// The plugin saves the phone so that it stays the same phone after a restart.
export interface SavedPhone {
  guid: string;
  credentials?: Credentials;
}

export interface PushUpdatesOptions {
  log: Logging;
  client: NotionClient;
  // The file in which the plugin saves the phone.
  file: string;
  onPush: () => void;
}

export class PushUpdates {
  private readonly log: Logging;
  private readonly client: NotionClient;
  private readonly file: string;
  private readonly onPush: () => void;
  private readonly stopping = new AbortController();
  private receiver?: PushReceiver;
  private connectWait?: AbortController;
  private retryMs = RETRY_FIRST_MS;

  constructor({ log, client, file, onPush }: PushUpdatesOptions) {
    this.log = log;
    this.client = client;
    this.file = file;
    this.onPush = onPush;
  }

  async start(): Promise<void> {
    let receiver: PushReceiver | undefined;
    try {
      const phone = await this.load();
      receiver = await createPushReceiver(phone.credentials, (e) => this.fail(e, receiver));
      if (this.stopping.signal.aborted) return;
      this.listen(receiver, phone);
      void this.waitForConnection(receiver);
      await receiver.connect();
      // `fail()` or `stop()` closes the receiver when it fails or when Homebridge shuts down.
      if (receiver !== this.receiver) return;
      await this.client.registerDevice(deviceRegistration(receiver.fcmToken, phone.guid));
      this.retryMs = RETRY_FIRST_MS;
      this.log.info("Push updates are on. The plugin checks the Notion/Honey service as soon as an alert arrives.");
    } catch (e) {
      this.fail(e, receiver);
    }
  }

  stop(): void {
    this.stopping.abort();
    this.close();
  }

  private listen(receiver: PushReceiver, phone: SavedPhone): void {
    this.receiver = receiver;
    receiver.on("ON_DISCONNECT", () => void this.waitForConnection(receiver));
    receiver.onReady(() => this.cancelConnectWait());
    receiver.onCredentialsChanged(({ newCredentials }) => void this.save({ ...phone, credentials: newCredentials }));
    receiver.onNotification((envelope) => this.handlePush(envelope));
  }

  private close(): void {
    this.cancelConnectWait();
    this.receiver?.destroy();
    this.receiver = undefined;
  }

  private handlePush({ message }: MessageEnvelope): void {
    const alert = message.data?.alert;
    const text = typeof alert === "string" && alert ? `: ${alert}` : "";
    this.log.debug(`The plugin received a push alert${text}. It checks the Notion/Honey service now.`);
    this.onPush();
  }

  // push-receiver reconnects on its own after a connection drops. While it cannot connect, each try keeps a listener,
  // so the plugin closes a receiver whose connection is not ready in time.
  private async waitForConnection(receiver: PushReceiver): Promise<void> {
    if (this.connectWait) return;
    const connectWait = new AbortController();
    this.connectWait = connectWait;
    try {
      await setTimeout(CONNECT_WAIT_MS, undefined, { signal: connectWait.signal });
    } catch {
      // The connection became ready, or the plugin closed the receiver.
      return;
    }
    this.connectWait = undefined;
    const minutes = CONNECT_WAIT_MS / 60000;
    this.fail(new Error(`no connection to mtalk.google.com on TCP port 5228 within ${minutes} minutes`), receiver);
  }

  private cancelConnectWait(): void {
    this.connectWait?.abort();
    this.connectWait = undefined;
  }

  // The plugin ignores the failure of a receiver that it has closed already.
  private fail(e: unknown, receiver: PushReceiver | undefined): void {
    if (this.stopping.signal.aborted || receiver !== this.receiver) return;
    this.close();
    const retryMs = this.retryMs;
    this.retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
    this.log.warn(
      `Push updates are off: ${(e as Error).message}. The plugin tries again in ${retryMs / 60000} minutes. ` +
        "Until then, sensors update only at the regular checks of the Notion/Honey service.",
    );
    void this.startAfter(retryMs);
  }

  private async startAfter(ms: number): Promise<void> {
    try {
      await setTimeout(ms, undefined, { signal: this.stopping.signal });
    } catch {
      // Homebridge shut down.
      return;
    }
    await this.start();
  }

  private async load(): Promise<SavedPhone> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { guid: randomUUID() };
      throw e;
    }
    try {
      const { guid, credentials } = JSON.parse(text) as Partial<SavedPhone>;
      if (typeof guid === "string") return { guid, credentials };
    } catch {
      // The plugin registers a new phone below.
    }
    this.log.warn(`The plugin could not read the saved phone in ${this.file}. It registers a new phone.`);
    return { guid: randomUUID() };
  }

  private async save(phone: SavedPhone): Promise<void> {
    try {
      await writeFile(this.file, JSON.stringify(phone), { mode: 0o600 });
    } catch (e) {
      this.log.warn(
        `The plugin could not save the phone to ${this.file}: ${(e as Error).message}. ` +
          "After a restart, it registers a new phone.",
      );
    }
  }
}
