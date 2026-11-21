// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright (C) 2026 Alex Zaytsev

import type { API } from "homebridge";
import { NotionPlatform } from "./platform.js";
import { PLATFORM_NAME } from "./settings.js";

export default (api: API): void => {
  api.registerPlatform(PLATFORM_NAME, NotionPlatform);
};
