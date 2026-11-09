import { AUTO_DL_FRAME_PAIR, AutoDlFile, AutoDlFramePairMessage } from '../utils/messages'

import { AUTO_DL_DIR } from './classifier/autoDlFrames'

// Exactly the names the offscreen tracker produces; anything else is refused
// so a message can't write outside the frames folder or pick its own file type.
const PNG_NAME = new RegExp(`^${AUTO_DL_DIR}/[0-9a-f]{8}-[0-9a-z]+/frame-\\d+\\.png$`)
const JSON_NAME = new RegExp(`^${AUTO_DL_DIR}/[0-9a-f]{8}-[0-9a-z]+/pair-\\d+-\\d+\\.json$`)
const MAX_FILES_PER_PAIR = 3

export const isAutoDlFramePairMessage = (message: unknown): message is AutoDlFramePairMessage => {
  const m = message as Partial<AutoDlFramePairMessage> | null | undefined
  return m?.target === 'background' && m?.type === AUTO_DL_FRAME_PAIR
}

const isValidFile = (file: Partial<AutoDlFile> | null | undefined): file is AutoDlFile => {
  if (typeof file?.filename !== 'string' || typeof file?.dataUrl !== 'string') return false
  if (PNG_NAME.test(file.filename)) return file.dataUrl.startsWith('data:image/png;')
  if (JSON_NAME.test(file.filename)) return file.dataUrl.startsWith('data:application/json;')
  return false
}

/** The message's files, or null if any one of them is malformed. */
export const validateAutoDlFiles = (files: unknown): AutoDlFile[] | null => {
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FILES_PER_PAIR) return null
  return files.every(isValidFile) ? files : null
}

export type AutoDlDownloadDeps = {
  /** Offscreen document URL; messages from any other sender are ignored. */
  offscreenUrl: string
  /** Read at save time, so turning the feature off stops pairs still in flight. */
  isEnabled: () => Promise<boolean>
  /** Undefined when the optional "downloads" permission is not granted. */
  download: ((file: AutoDlFile) => Promise<void>) | undefined
  log: (message: string) => void
}

export const saveAutoDlFramePair = async (
  message: AutoDlFramePairMessage,
  senderUrl: string | undefined,
  deps: AutoDlDownloadDeps
): Promise<number> => {
  if (senderUrl !== deps.offscreenUrl) return 0

  const files = validateAutoDlFiles(message.files)
  if (files === null) {
    deps.log('Auto-DL refused a malformed frame pair')
    return 0
  }

  if (!(await deps.isEnabled())) return 0

  if (deps.download === undefined) {
    deps.log('Auto-DL is on but the downloads permission is not granted; frame pair skipped')
    return 0
  }

  let saved = 0
  for (const file of files) {
    try {
      await deps.download(file)
      saved++
    } catch (error) {
      deps.log(`Auto-DL failed to save ${file.filename}: ${(error as Error)?.message ?? String(error)}`)
    }
  }
  return saved
}
