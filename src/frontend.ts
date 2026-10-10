// LumiTag frontend entry point.
//
// The extension bundle is RAW DOM — there is no React/Preact/Solid available.
// All of the actual work lives in src/frontend/; this file is only the hook the
// Spindle host calls.

import type { SpindleFrontendContext } from 'lumiverse-spindle-types'

import { setupApp } from './frontend/app'

/** Set up the LumiTag drawer tab. Returns a teardown function. */
export function setup(ctx: SpindleFrontendContext): () => void {
  return setupApp(ctx)
}