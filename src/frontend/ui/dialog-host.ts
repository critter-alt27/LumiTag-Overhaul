import type { DialogRequest } from './shell'

let opener: ((request: DialogRequest) => void) | null = null

/** Installed once by the composition root. */
export function setDialogOpener(fn: (request: DialogRequest) => void): void {
  opener = fn
}

/** Opens a dialog. No-ops safely before the app has wired an opener. */
export function requestDialog(request: DialogRequest): void {
  opener?.(request)
}