// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright (C) 2026 Alex Zaytsev

const REQUEST_TIMEOUT_MS = 15000;

export function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Node's `fetch` reports a network failure as "fetch failed" and puts the reason in `cause.code`.
export async function send(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } };
    const code = err.cause?.code;
    throw new Error(code ? `${err.message}: ${code}` : err.message, { cause: e });
  }
}
