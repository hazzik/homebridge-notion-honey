// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright (C) 2026 Alex Zaytsev

// The fields that the plugin reads from the replies of the Notion API.

export interface Sensor {
  id: number;
  uuid: string;
  name?: string | null;
  hardware_id?: string | null;
  hardware_revision?: number | null;
  firmware_version?: string | null;
  missing_at?: string | null;
}

export interface Listener {
  id: string;
  definition_id: number;
  sensor_id?: string | null;
  status_localized?: { state?: unknown } | null;
  insights?: { primary?: { value?: string | null } | null } | null;
}

export interface UserPreferences {
  celsius_enabled?: boolean;
}

export interface AuthTokens {
  jwt?: string;
  refresh_token?: string | null;
}

// The body of `POST /devices`.
export interface DeviceRegistration {
  device: { token: string; app_version: string; os_version: string; device_id: string; platform: "android" };
}

export interface ErrorReply {
  errors?: { title?: string }[];
}
