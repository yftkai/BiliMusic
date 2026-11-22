import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { Track } from '@/types'
import type { DownloadProgress, DownloadTask, OpenPathOptions } from '@/types/electron'
import { getLyricForTrack, type LyricLine } from '@/services/lyrics'
import { loadAppSettings } from '@/utils/storage'
import { readStoredItem, writeStoredItem } from '@/utils/persistentStorage'

const DOWNLOADS_KEY = 'bilimusic_downloads'
export const DOWNLOADS_CHANGED_EVENT = 'bilimusic:downloads-changed'

export type DownloadStatus = 'queued' | 'downloading' | 'done' | 'error'

export interface DownloadRecord {
  id: string
  track: Track
  status: DownloadStatus
  phase: DownloadProgress['phase']
  percent: number
  filePath?: string
  lyricPath?: string
  coverPath?: string
  size?: number
  error?: string
  createdAt: number
  completedAt?: number
}

interface DownloadContextValue {
  records: DownloadRecord[]
  activeCount: number
  downloadedCount: number
  totalSize: number
  isDownloaded: (trackId: string) => boolean
  getLocalFile: (trackId: string) => string | undefined
  enqueue: (track: Track) => void
  enqueueBatch: (tracks: Track[]) => void
  retry: (id: string) => void
  remove: (id: string) => void
  clearCompleted: () => void
  openFile: (record: DownloadRecord) => Promise<void>
  openDir: () => Promise<void>
}

const DownloadContext = createContext<DownloadContextValue | null>(null)

function loadRecords(): DownloadRecord[] {
  try {
    const raw = readStoredItem(DOWNLOADS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // 进程重启后，未完成的任务重新排队（文件可能不完整，重下更安全）
    return parsed.map((r: DownloadRecord) => ({
      ...r,
      status: r.status === 'done' ? 'done' : 'queued',
      phase: 'resolve',
      percent: 0,
      error: undefined,
    }))
  } catch {
    return []
  }
}

function saveRecords(records: DownloadRecord[]) {
  try {
    writeStoredItem(DOWNLOADS_KEY, JSON.stringify(records))
    window.dispatchEvent(new CustomEvent(DOWNLOADS_CHANGED_EVENT))
  } catch { /* ignore */ }
}

/** 把结构化歌词行还原成标准 LRC 文本，用于落盘 */
function linesToLrc(lines: LyricLine[]): string {
  if (!lines?.length) return ''
  return lines.map((line) => {
    const min = Math.floor(Math.max(0, line.time) / 60)
    const sec = Math.max(0, line.time) % 60
    const stamp = `[${String(min).padStart(2, '0')}:${sec.toFixed(2).padStart(5, '0')}]`
    return `${stamp}${line.text || ''}`
  }).join('\n')
}

export function DownloadProvider({ children }: { children: ReactNode }) {
  const [records, setRecords] = useState<DownloadRecord[]>(() => loadRecords())
  const recordsRef = useRef(records)
  const queueRef = useRef<string[]>([])
  const runningRef = useRef(false)

  useEffect(() => { recordsRef.current = records }, [records])

  const persist = useCallback((next: DownloadRecord[]) => {
    recordsRef.current = next
    setRecords(next)
    saveRecords(next)
  }, [])

  /** 监听主进程回传的下载进度，实时更新对应记录 */
  useEffect(() => {
    const api = window.electronAPI?.biliApi
    if (!api?.onDownloadProgress) return
    return api.onDownloadProgress((progress) => {
      const next = recordsRef.current.map((r) =>
        r.id === progress.id && r.status === 'downloading'
          ? { ...r, phase: progress.phase, percent: progress.percent }
          : r,
      )
      recordsRef.current = next
      setRecords(next)
    })
  }, [])

  /** 执行单个下载任务 */
  const performDownload = useCallback(async (id: string) => {
    const record = recordsRef.current.find((r) => r.id === id)
    const api = window.electronAPI?.biliApi
    if (!record || !api?.download) return

    const settings = loadAppSettings()
    const track = record.track

    // 更新为下载中
    const started = recordsRef.current.map((r) =>
      r.id === id ? { ...r, status: 'downloading' as const, phase: 'resolve' as const, percent: 0, error: undefined } : r,
    )
    persist(started)

    try {
      // 需要歌词时，先尝试自动匹配（失败不阻断下载）
      let lyricText: string | undefined
      if (settings.downloadSaveLyric) {
        try {
          const lyric = await getLyricForTrack(track)
          if (lyric?.lines?.length) lyricText = linesToLrc(lyric.lines)
        } catch { /* ignore */ }
      }

      const task: DownloadTask = {
        id: track.id,
        bvid: track.bvid || track.id,
        aid: track.aid,
        cid: track.cid,
        title: track.title,
        artist: track.artist,
        coverUrl: track.coverUrl,
        duration: track.duration,
        targetDir: settings.downloadDir,
        quality: settings.downloadQuality,
        writeMeta: settings.downloadWriteMeta,
        saveLyric: settings.downloadSaveLyric && Boolean(lyricText),
        lyricText,
      }

      const result = await api.download(task)

      const done = recordsRef.current.map((r) =>
        r.id === id ? {
          ...r,
          status: 'done' as const,
          phase: 'done' as const,
          percent: 100,
          filePath: result.filePath,
          lyricPath: result.lyricPath,
          size: result.size,
          completedAt: Date.now(),
          error: undefined,
        } : r,
      )
      persist(done)
    } catch (err: any) {
      const failed = recordsRef.current.map((r) =>
        r.id === id ? {
          ...r,
          status: 'error' as const,
          percent: 0,
          error: err?.message || '下载失败',
        } : r,
      )
      persist(failed)
    }
  }, [persist])

  /** 串行消费队列：避免并发触发 B 站风控 */
  const pumpQueue = useCallback(async () => {
    if (runningRef.current) return
    runningRef.current = true
    try {
      while (queueRef.current.length) {
        const id = queueRef.current.shift()!
        await performDownload(id)
      }
    } finally {
      runningRef.current = false
    }
  }, [performDownload])

  const enqueueTracks = useCallback((tracks: Track[]) => {
    const existing = new Set(recordsRef.current.map((r) => r.id))
    const added: DownloadRecord[] = []
    for (const track of tracks) {
      if (existing.has(track.id)) continue
      existing.add(track.id)
      added.push({
        id: track.id,
        track,
        status: 'queued',
        phase: 'resolve',
        percent: 0,
        createdAt: Date.now(),
      })
    }
    if (!added.length) return
    queueRef.current.push(...added.map((r) => r.id))
    persist([...added, ...recordsRef.current])
    void pumpQueue()
  }, [persist, pumpQueue])

  const enqueue = useCallback((track: Track) => enqueueTracks([track]), [enqueueTracks])

  const retry = useCallback((id: string) => {
    const record = recordsRef.current.find((r) => r.id === id)
    if (!record) return
    const next = recordsRef.current.map((r) =>
      r.id === id ? { ...r, status: 'queued' as const, percent: 0, error: undefined, phase: 'resolve' as const } : r,
    )
    persist(next)
    queueRef.current.push(id)
    void pumpQueue()
  }, [persist, pumpQueue])

  const remove = useCallback((id: string) => {
    queueRef.current = queueRef.current.filter((x) => x !== id)
    persist(recordsRef.current.filter((r) => r.id !== id))
  }, [persist])

  const clearCompleted = useCallback(() => {
    persist(recordsRef.current.filter((r) => r.status !== 'done'))
  }, [persist])

  const isDownloaded = useCallback((trackId: string) => {
    return recordsRef.current.some((r) => r.id === trackId && r.status === 'done' && Boolean(r.filePath))
  }, [])

  const getLocalFile = useCallback((trackId: string) => {
    return recordsRef.current.find((r) => r.id === trackId && r.status === 'done')?.filePath
  }, [])

  const invokeOpenPath = useCallback(async (targetPath: string, options?: OpenPathOptions) => {
    const api = window.electronAPI
    if (!api || !targetPath) return
    // 兼容旧版 preload：优先顶层桥接，缺失时回退到 biliApi 下的同名方法
    if (api.openPath) return api.openPath(targetPath, options)
    if (api.biliApi?.openPath) return api.biliApi.openPath(targetPath, options)
  }, [])

  const openFile = useCallback(async (record: DownloadRecord) => {
    if (record.filePath) await invokeOpenPath(record.filePath)
  }, [invokeOpenPath])

  const openDir = useCallback(async () => {
    await invokeOpenPath(loadAppSettings().downloadDir, { createIfMissing: true })
  }, [invokeOpenPath])

  // 应用启动时把未完成任务入队
  useEffect(() => {
    const pending = recordsRef.current.filter((r) => r.status === 'queued').map((r) => r.id)
    if (pending.length) {
      queueRef.current.push(...pending)
      void pumpQueue()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const value = useMemo<DownloadContextValue>(() => ({
    records,
    activeCount: records.filter((r) => r.status === 'downloading' || r.status === 'queued').length,
    downloadedCount: records.filter((r) => r.status === 'done').length,
    totalSize: records.filter((r) => r.status === 'done').reduce((sum, r) => sum + (r.size || 0), 0),
    isDownloaded,
    getLocalFile,
    enqueue,
    enqueueBatch: enqueueTracks,
    retry,
    remove,
    clearCompleted,
    openFile,
    openDir,
  }), [records, isDownloaded, getLocalFile, enqueue, enqueueTracks, retry, remove, clearCompleted, openFile, openDir])

  return <DownloadContext.Provider value={value}>{children}</DownloadContext.Provider>
}

export function useDownloads() {
  const ctx = useContext(DownloadContext)
  if (!ctx) throw new Error('useDownloads must be used within DownloadProvider')
  return ctx
}
