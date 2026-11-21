// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright (C) 2026 Alex Zaytsev

import type { ErrorReply } from "./types.js";

export class AuthError extends Error {}

export function httpError(method: string, path: string, status: number, data: unknown): Error {
  const title = (data as ErrorReply | null)?.errors?.[0]?.title;
  const message = `${method} ${path} failed with HTTP ${status}${title ? `: ${title}` : ""}`;
  return status === 401 ? new AuthError(message) : new Error(message);
}
