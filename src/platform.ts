// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright (C) 2026 Alex Zaytsev

import type {
  API,
  DynamicPlatformPlugin,
  Logging,
  MatterAccessory,
  PlatformAccessory,
  PlatformConfig,
} from "homebridge";
import { toDevices } from "./devices/index.js";
import { HapSensors } from "./hap/index.js";
import { MatterSensors } from "./matter/index.js";
import { join } from "node:path";
import { AuthError, NotionClient, PushUpdates, type Listener, type Sensor } from "./notion/index.js";
import { PLATFORM_NAME, PLUGIN_NAME, POLL_SECONDS, PUSH } from "./settings.js";

const AUTH_FAIL_BACKOFF_MS = 10 * 60 * 1000;
const PREFS_REFRESH_MS = 60 * 60 * 1000;
const FAILURES_BEFORE_FAULT = 5;

interface NotionConfig extends PlatformConfig {
  email?: string;
  password?: string;
  pollSeconds?: number | string;
  push?: boolean;
  apiBase?: string;
}

export class NotionPlatform implements DynamicPlatformPlugin {
  private readonly log: Logging;
  private readonly api: API;
  private readonly hap: HapSensors;
  private readonly matter?: MatterSensors;
  private timer?: NodeJS.Timeout;
  private seenOnce = false;
  private polling = false;
  private pollAgain = false;
  private failures = 0;
  private authBlockedUntil = 0;
  // The temperature unit of the account. It is null until the plugin reads the account preferences.
  private celsius: boolean | null = null;
  private prefsFetchedAt = 0;
  private warnedUnitUnknown = false;

  constructor(log: Logging, config: NotionConfig, api: API) {
    this.log = log;
    this.api = api;
    this.hap = new HapSensors(log, api, PLUGIN_NAME, PLATFORM_NAME);
    // Homebridge sets `api.matter` whenever `isMatterEnabled()` returns true.
    if (this.isMatterEnabled()) this.matter = new MatterSensors(log, api.matter!, PLUGIN_NAME, PLATFORM_NAME);

    if (!config.email || !config.password) {
      this.log.error(
        "The email or the password is missing from the plugin settings. Enter both, then restart Homebridge.",
      );
      return;
    }

    const pollSeconds = Number(config.pollSeconds) || POLL_SECONDS.default;
    const pollMs = Math.min(POLL_SECONDS.maximum, Math.max(POLL_SECONDS.minimum, pollSeconds)) * 1000;
    const client = new NotionClient({
      email: config.email,
      password: config.password,
      apiBase: config.apiBase,
      log,
    });

    const push =
      (config.push ?? PUSH.default) === true
        ? new PushUpdates({
            log,
            client,
            file: join(api.user.storagePath(), `${PLUGIN_NAME}-push.json`),
            onPush: () => this.pollNow(client),
          })
        : undefined;

    api.on("didFinishLaunching", () => {
      void this.poll(client);
      this.timer = setInterval(() => void this.poll(client), pollMs);
      void push?.start();
    });
    api.on("shutdown", () => {
      clearInterval(this.timer);
      push?.stop();
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.hap.configure(accessory);
  }

  configureMatterAccessory(accessory: MatterAccessory): void {
    this.matter?.configure(accessory);
  }

  // A push alert means that a state has changed. A check that is running may have read the state before the change, so
  // the plugin checks once more after it.
  private pollNow(client: NotionClient): void {
    // The regular check right after this one would read the same states, so the plugin moves it a full interval later.
    this.timer?.refresh();
    if (this.polling) this.pollAgain = true;
    else void this.poll(client);
  }

  async poll(client: NotionClient): Promise<void> {
    if (this.polling || Date.now() < this.authBlockedUntil) return;
    this.polling = true;
    try {
      const reply = await this.readService(client);
      if (reply) await this.updateSensors(reply.sensors, reply.listeners);
    } finally {
      this.polling = false;
      if (this.pollAgain) {
        this.pollAgain = false;
        void this.poll(client);
      }
    }
  }

  // Returns undefined when a request to the service fails.
  private async readService(client: NotionClient): Promise<{ sensors: Sensor[]; listeners: Listener[] } | undefined> {
    try {
      const prefsDue = Date.now() - this.prefsFetchedAt > PREFS_REFRESH_MS;
      const [sensors, listeners, prefs] = await Promise.all([
        client.getSensors(),
        client.getListeners(),
        prefsDue && client.getPreferences().catch((e) => this.logPreferencesError(e as Error)),
      ]);
      if (prefs) {
        if (typeof prefs.celsius_enabled === "boolean") this.celsius = prefs.celsius_enabled;
        this.prefsFetchedAt = Date.now();
      }
      if (this.failures >= FAILURES_BEFORE_FAULT) this.log.info("The Notion/Honey service is reachable again.");
      this.failures = 0;
      return { sensors, listeners };
    } catch (e) {
      this.handlePollError(e);
      return undefined;
    }
  }

  // An error here comes from the plugin or from Homebridge, not from the service, so it does not count as a failed
  // check of the service.
  private async updateSensors(sensors: Sensor[], listeners: Listener[]): Promise<void> {
    try {
      await this.sync(sensors, listeners);
    } catch (e) {
      this.log.error(`The plugin could not update the sensors in Apple Home: ${(e as Error).message}`);
    }
  }

  private logPreferencesError(e: Error): void {
    const message = `The plugin could not read the account preferences: ${e.message}`;
    if (this.celsius !== null || this.warnedUnitUnknown) {
      this.log.debug(message);
      return;
    }
    this.warnedUnitUnknown = true;
    this.log.warn(`${message}. Temperature sensors show no reading until the plugin reads the temperature unit.`);
  }

  private handlePollError(e: unknown): void {
    const message = (e as Error).message;
    this.failures += 1;
    if (e instanceof AuthError) {
      this.authBlockedUntil = Date.now() + AUTH_FAIL_BACKOFF_MS;
      this.log.error(
        "The Notion/Honey service rejected the email or the password. " +
          "Check that you can sign in to the Honey Smart Home app with the same email and password. " +
          `The plugin will try again in ${AUTH_FAIL_BACKOFF_MS / 60000} minutes.`,
      );
    } else if (this.failures === 1 || this.failures === FAILURES_BEFORE_FAULT) {
      this.log.warn(`The plugin could not reach the Notion/Honey service: ${message}`);
    } else {
      this.log.debug(`The last ${this.failures} checks of the Notion/Honey service failed: ${message}`);
    }
    if (this.failures === FAILURES_BEFORE_FAULT) {
      this.log.warn("The plugin marks all Notion sensors as not responding until the service is reachable again.");
      this.hap.markAllFaulty();
      void this.matter?.markAllUnreachable();
    }
  }

  async sync(sensors: Sensor[], listeners: Listener[]): Promise<void> {
    const devices = toDevices(sensors, listeners, this.celsius);
    // Keep all accessories when no sensor in the reply has a supported task, for example when the service returns no
    // sensors or no listeners. If that reply is wrong, removing the accessories would also remove them from their
    // rooms and automations in Apple Home.
    const removeStale = devices.length > 0;
    const added = new Set<string>();
    if (this.isHapEnabled()) {
      for (const uuid of this.hap.sync(devices, removeStale)) added.add(uuid);
    }
    if (this.matter) {
      for (const uuid of await this.matter.sync(devices, removeStale)) added.add(uuid);
    }

    if (!this.seenOnce) {
      this.seenOnce = true;
      this.logFirstSync(sensors.length, devices.length, added.size);
    }
  }

  // Homebridge 2.0 to 2.4 has no `isHapEnabled()`.
  private isHapEnabled(): boolean {
    return this.api.isHapEnabled?.() ?? true;
  }

  // Homebridge 2.0 sets `api.matter` on the main bridge when only a child bridge has Matter.
  private isMatterEnabled(): boolean {
    return this.api.isMatterEnabled?.() ?? false;
  }

  private logFirstSync(sensorCount: number, activeCount: number, addedCount: number): void {
    const added = addedCount ? ` New sensors: ${addedCount}.` : "";
    this.log.info(`The plugin signed in to the Notion/Honey service. Sensors in Apple Home: ${activeCount}.${added}`);
    if (!sensorCount) {
      this.log.warn("The account has no sensors. Set up your sensors in the Honey Smart Home app first.");
    } else if (!activeCount) {
      this.log.warn(
        "The account has sensors, but none of them has a door, window, leak, temperature or alarm task in the app yet.",
      );
    }
  }
}
