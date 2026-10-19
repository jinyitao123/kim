import { useCallback, useEffect, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import type { HarnessId, PromptImage, WorkspaceMaterialReference } from '@/types/api'

const supportedImageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
export const MAX_COMPOSER_FILE_COUNT = 8
export const MAX_COMPOSER_IMAGE_SOURCE_BYTES = 1_350_000
export const MAX_COMPOSER_MATERIAL_SOURCE_BYTES = 2 * 1024 * 1024
export const MAX_COMPOSER_MATERIAL_TOTAL_BYTES = 8 * 1024 * 1024

export interface ComposerImage extends PromptImage {
  id: string
  name: string
  size: number
}

export interface ComposerUnsupportedFile {
  id: string
  name: string
  size: number
  mimeType: string
}

export interface ComposerTextFile {
  id: string
  reference: WorkspaceMaterialReference
  size: number
}

interface UseComposerImagesOptions {
  shortName: string
  projectId?: string
  harness?: HarnessId
  importTextFile?: (name: string, bytes: Uint8Array) => Promise<WorkspaceMaterialReference>
}

function isSupportedTextFile(file: File): boolean {
  const extension = file.name.slice(file.name.lastIndexOf('.')).toLowerCase()
  return ['.txt', '.md', '.markdown', '.csv', '.json', '.pdf', '.docx', '.xlsx'].includes(extension)
}

function base64FromBuffer(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  return window.btoa(binary)
}

function isFileDrag(event: DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types).includes('Files')
}

export function useComposerImages({ shortName, projectId, harness, importTextFile }: UseComposerImagesOptions) {
  const [images, setImages] = useState<ComposerImage[]>([])
  const [textFiles, setTextFiles] = useState<ComposerTextFile[]>([])
  const [unsupportedFiles, setUnsupportedFiles] = useState<ComposerUnsupportedFile[]>([])
  const [error, setError] = useState('')
  const [processing, setProcessing] = useState(false)
  const [dragging, setDragging] = useState(false)
  const imagesRef = useRef<ComposerImage[]>([])
  const textFilesRef = useRef<ComposerTextFile[]>([])
  const unsupportedFilesRef = useRef<ComposerUnsupportedFile[]>([])
  const pendingBatchesRef = useRef(0)
  const errorRevisionRef = useRef(0)
  const reservedCountRef = useRef(0)
  const reservedImageBytesRef = useRef(0)
  const reservedTextBytesRef = useRef(0)
  const dragDepthRef = useRef(0)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const updateError = useCallback((message: string) => {
    errorRevisionRef.current += 1
    setError(message)
  }, [])

  const ingest = useCallback(async (files: readonly File[]) => {
    if (files.length === 0) return
    const startingErrorRevision = errorRevisionRef.current
    if (imagesRef.current.length + textFilesRef.current.length + unsupportedFilesRef.current.length + reservedCountRef.current + files.length > MAX_COMPOSER_FILE_COUNT) {
      updateError(`You can attach up to ${MAX_COMPOSER_FILE_COUNT} files.`)
      return
    }

    const textCandidates = files.filter(isSupportedTextFile)
    const imageFiles = files.filter((file) => !isSupportedTextFile(file) && supportedImageTypes.has(file.type.toLowerCase()))
    const textFilesToImport = importTextFile ? textCandidates : []
    const otherFiles = files.filter((file) => !imageFiles.includes(file) && !textFilesToImport.includes(file))
    if (otherFiles.length > 0) {
      const added = otherFiles.map((file, index): ComposerUnsupportedFile => ({
        id: crypto.randomUUID(),
        name: file.name || `Attached file ${index + 1}`,
        size: file.size,
        mimeType: file.type.toLowerCase() || 'application/octet-stream',
      }))
      const next = [...unsupportedFilesRef.current, ...added]
      unsupportedFilesRef.current = next
      setUnsupportedFiles(next)
      setError('')
    }
    if (imageFiles.length === 0 && textFilesToImport.length === 0) return

    const imageSourceBytes = imageFiles.reduce((sum, file) => sum + file.size, 0)
    const currentBytes = imagesRef.current.reduce((sum, image) => sum + image.size, 0)
    if (currentBytes + reservedImageBytesRef.current + imageSourceBytes > MAX_COMPOSER_IMAGE_SOURCE_BYTES) {
      updateError('These images are too large to send. Attach smaller images (about 1.3 MB total).')
      return
    }
    const textSourceBytes = textFilesToImport.reduce((sum, file) => sum + file.size, 0)
    const currentTextBytes = textFilesRef.current.reduce((sum, file) => sum + file.size, 0)
    if (textFilesToImport.some((file) => file.size < 1 || file.size > MAX_COMPOSER_MATERIAL_SOURCE_BYTES)
      || currentTextBytes + reservedTextBytesRef.current + textSourceBytes > MAX_COMPOSER_MATERIAL_TOTAL_BYTES) {
      updateError('Each source material must be at most 2 MiB and all selected materials must total at most 8 MiB.')
      return
    }

    const reservedCount = imageFiles.length + textFilesToImport.length
    reservedCountRef.current += reservedCount
    reservedImageBytesRef.current += imageSourceBytes
    reservedTextBytesRef.current += textSourceBytes
    pendingBatchesRef.current += 1
    setProcessing(true)
    try {
      const [imageResults, textResults] = await Promise.all([
        Promise.allSettled(imageFiles.map(async (file, index): Promise<ComposerImage> => ({
          id: crypto.randomUUID(),
          name: file.name || `Attached image ${index + 1}`,
          size: file.size,
          type: 'image',
          mimeType: file.type.toLowerCase(),
          data: base64FromBuffer(await file.arrayBuffer()),
        }))),
        Promise.allSettled(textFilesToImport.map(async (file): Promise<ComposerTextFile> => {
          const reference = await importTextFile!(file.name, new Uint8Array(await file.arrayBuffer()))
          if ((projectId && reference.projectId !== projectId) || (harness && reference.harness !== harness)) {
            throw new Error('The active workspace changed while the attachment was importing.')
          }
          return {
          id: crypto.randomUUID(),
            reference,
            size: reference.bytes,
          }
        })),
      ])
      if (!mountedRef.current) return
      const addedImages = imageResults.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
      const addedTextFiles = textResults.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
      if (addedImages.length > 0) {
        const next = [...imagesRef.current, ...addedImages]
        imagesRef.current = next
        setImages(next)
      }
      if (addedTextFiles.length > 0) {
        const next = [...textFilesRef.current, ...addedTextFiles]
        textFilesRef.current = next
        setTextFiles(next)
      }
      const failedImage = imageResults.find((result) => result.status === 'rejected')
      const failedText = textResults.find((result) => result.status === 'rejected')
      if (failedImage) updateError(`${shortName} could not read the image.`)
      else if (failedText) {
        const failure = failedText.reason
        updateError(failure instanceof Error && failure.message.startsWith('Workspace authorization timed out before attaching this file.')
          ? failure.message
          : `${shortName} could not import the selected material.`)
      }
      else if (errorRevisionRef.current === startingErrorRevision) setError('')
    } catch {
      if (mountedRef.current) updateError(`${shortName} could not read the image.`)
    } finally {
      reservedCountRef.current -= reservedCount
      reservedImageBytesRef.current -= imageSourceBytes
      reservedTextBytesRef.current -= textSourceBytes
      pendingBatchesRef.current -= 1
      if (mountedRef.current && pendingBatchesRef.current === 0) setProcessing(false)
    }
  }, [harness, importTextFile, projectId, shortName, updateError])

  const clear = useCallback(() => {
    imagesRef.current = []
    textFilesRef.current = []
    unsupportedFilesRef.current = []
    setImages([])
    setTextFiles([])
    setUnsupportedFiles([])
  }, [])

  const remove = useCallback((id: string) => {
    const nextImages = imagesRef.current.filter((image) => image.id !== id)
    const nextTextFiles = textFilesRef.current.filter((file) => file.id !== id)
    const nextFiles = unsupportedFilesRef.current.filter((file) => file.id !== id)
    imagesRef.current = nextImages
    textFilesRef.current = nextTextFiles
    unsupportedFilesRef.current = nextFiles
    setImages(nextImages)
    setTextFiles(nextTextFiles)
    setUnsupportedFiles(nextFiles)
    updateError('')
  }, [updateError])

  const restoreWithinLimits = useCallback((restored: ComposerImage[]) => {
    const current = imagesRef.current
    const currentIds = new Set(current.map((image) => image.id))
    let count = current.length + textFilesRef.current.length + unsupportedFilesRef.current.length + reservedCountRef.current
    let bytes = current.reduce((sum, image) => sum + image.size, 0) + reservedImageBytesRef.current
    const accepted: ComposerImage[] = []
    let omitted = 0
    for (const image of restored) {
      if (currentIds.has(image.id)) continue
      if (count >= MAX_COMPOSER_FILE_COUNT || bytes + image.size > MAX_COMPOSER_IMAGE_SOURCE_BYTES) {
        omitted += 1
        continue
      }
      accepted.push(image)
      currentIds.add(image.id)
      count += 1
      bytes += image.size
    }
    if (accepted.length > 0) {
      const next = [...accepted, ...current]
      imagesRef.current = next
      setImages(next)
    }
    return { restored: accepted.length, omitted }
  }, [])

  const restoreTextFilesWithinLimits = useCallback((restored: ComposerTextFile[]) => {
    const current = textFilesRef.current
    const currentIds = new Set(current.map((file) => file.id))
    let count = imagesRef.current.length + current.length + unsupportedFilesRef.current.length + reservedCountRef.current
    let bytes = current.reduce((sum, file) => sum + file.size, 0) + reservedTextBytesRef.current
    const accepted: ComposerTextFile[] = []
    let omitted = 0
    for (const file of restored) {
      if (currentIds.has(file.id)) continue
      if (count >= MAX_COMPOSER_FILE_COUNT || file.size > MAX_COMPOSER_MATERIAL_SOURCE_BYTES || bytes + file.size > MAX_COMPOSER_MATERIAL_TOTAL_BYTES) {
        omitted += 1
        continue
      }
      accepted.push(file)
      currentIds.add(file.id)
      count += 1
      bytes += file.size
    }
    if (accepted.length > 0) {
      const next = [...accepted, ...current]
      textFilesRef.current = next
      setTextFiles(next)
    }
    return { restored: accepted.length, omitted }
  }, [])

  const onDragEnter = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(event)) return
    event.preventDefault()
    dragDepthRef.current += 1
    setDragging(true)
  }, [])

  const onDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }, [])

  const onDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (dragDepthRef.current === 0) return
    event.preventDefault()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setDragging(false)
  }, [])

  const onDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(event)) return
    event.preventDefault()
    dragDepthRef.current = 0
    setDragging(false)
    void ingest(Array.from(event.dataTransfer.files))
  }, [ingest])

  return {
    images,
    imagesRef,
    textFiles,
    textFilesRef,
    unsupportedFiles,
    unsupportedFilesRef,
    error,
    setError: updateError,
    processing,
    hasPending: () => pendingBatchesRef.current > 0,
    dragging,
    ingest,
    clear,
    remove,
    restoreWithinLimits,
    restoreTextFilesWithinLimits,
    dragHandlers: { onDragEnter, onDragOver, onDragLeave, onDrop },
  }
}
