// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright (C) 2026 Alex Zaytsev

import configSchema from "../config.schema.json" with { type: "json" };

// Vite replaces `__PLUGIN_NAME__` with the `name` field of package.json. See `define` in vite.config.ts.
declare const __PLUGIN_NAME__: string;

export const PLUGIN_NAME = __PLUGIN_NAME__;
export const PLATFORM_NAME = configSchema.pluginAlias;
export const POLL_SECONDS = configSchema.schema.properties.pollSeconds;
export const PUSH = configSchema.schema.properties.push;
