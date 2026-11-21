// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright (C) 2026 Alex Zaytsev
// A fake of `PushReceiver` from @eneris/push-receiver for unit tests. Replace the module with
// `vi.mock("@eneris/push-receiver", () => import("./fake-push.js"))`, and control the fake Google service with `google`.
import type { ClientConfig, Credentials } from "@eneris/push-receiver/dist/types.js";
import { EventEmitter } from "node:events";

type Listener = (data: unknown) => void;

export const google = {
  // When `failing` is true, the service rejects every check-in and registration.
  failing: false,
  // When `reachable` is false, no connection becomes ready until a test calls `becomeReady()`.
  reachable: true,
  registrations: 0,
  receivers: [] as PushReceiver[],
  reset(): void {
    this.failing = false;
    this.reachable = true;
    this.registrations = 0;
    this.receivers = [];
  },
};

function credentialsFor(registration: number): Credentials {
  return {
    keys: { privateKey: "private-key", publicKey: "public-key", authSecret: "auth-secret" },
    gcm: { androidId: `${registration}`, securityToken: "security-token", appId: "app-id", token: "gcm-token" },
    fcm: {
      token: `fcm-token-${registration}`,
      installation: {
        token: "fis-token",
        createdAt: Date.now(),
        expiresIn: 1,
        refreshToken: "fis-refresh",
        fid: "fid",
      },
    },
    config: { projectId: "notion-46d6f", vapidKey: "", bundleId: "receiver.push.com" },
  };
}

export class PushReceiver {
  destroyed = false;
  private credentials?: Credentials;
  private readonly events = new EventEmitter();
  private ready = Promise.withResolvers<void>();
  private persistentId = 0;

  constructor(config: ClientConfig) {
    this.credentials = config.credentials;
    google.receivers.push(this);
  }

  get fcmToken(): string {
    return this.credentials?.fcm.token ?? "";
  }

  get whenReady(): Promise<unknown> {
    return this.ready.promise;
  }

  on(event: string, listener: Listener): () => void {
    this.events.on(event, listener);
    return () => this.events.off(event, listener);
  }

  onNotification(listener: Listener): () => void {
    return this.on("ON_MESSAGE_RECEIVED", listener);
  }

  onCredentialsChanged(listener: Listener): () => void {
    return this.on("ON_CREDENTIALS_CHANGE", listener);
  }

  onReady(listener: Listener): () => void {
    return this.on("ON_READY", listener);
  }

  // Like push-receiver, `connect()` registers the phone when it has no credentials and resolves when the connection
  // is ready.
  connect = async (): Promise<void> => {
    this.destroyed = false;
    await this.registerIfNeeded();
    const ready = new Promise<void>((resolve) => {
      const dispose = this.onReady(() => {
        dispose();
        resolve();
      });
    });
    if (google.reachable) this.becomeReady();
    return ready;
  };

  // Like push-receiver, `destroy()` rejects `whenReady` when the connection is not ready.
  destroy = (): void => {
    this.destroyed = true;
    this.ready.reject(new Error("Client destroyed"));
    this.ready = Promise.withResolvers<void>();
  };

  becomeReady(): void {
    this.ready.resolve();
    this.emit("ON_READY");
  }

  // Like push-receiver after the connection drops: it destroys the connection, calls `connect()` again, and ignores the
  // promise that `connect()` returns.
  dropConnection(): void {
    this.emit("ON_DISCONNECT");
    this.destroy();
    void this.connect();
  }

  push(data: Record<string, string>): void {
    this.persistentId += 1;
    this.emit("ON_MESSAGE_RECEIVED", { message: { data }, persistentId: `0:${this.persistentId}` });
  }

  private emit(event: string, data?: unknown): void {
    this.events.emit(event, data);
  }

  private async registerIfNeeded(): Promise<void> {
    await Promise.resolve();
    if (google.failing) {
      throw new Error("Request to https://android.clients.google.com/checkin failed after 4 attempts: 503");
    }
    if (this.credentials) return;
    google.registrations += 1;
    const credentials = credentialsFor(google.registrations);
    this.emit("ON_CREDENTIALS_CHANGE", { oldCredentials: this.credentials, newCredentials: credentials });
    this.credentials = credentials;
  }
}
