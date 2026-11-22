import { Download, FolderOpen, HardDrive, Music, RefreshCw, Trash2, Check, X, Play } from 'lucide-react'
import type { ReactNode } from 'react'
import {
  ActionButton,
  EmptyLibrary,
  MusicHero,
  MusicPageShell,
  MusicSection,
  formatCount,
  formatDuration,
} from '@/components/AppleMusicPage'
import { useDownloads, type DownloadRecord } from '@/contexts/DownloadContext'
import { usePlayer } from '@/contexts/PlayerContext'
import { loadAppSettings } from '@/utils/storage'

function formatBytes(bytes: number): string {
  if (!bytes) return '0 KB'
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export default function Downloads() {
  const downloads = useDownloads()
  const { records, activeCount, downloadedCount, totalSize } = downloads
  const downloadDir = loadAppSettings().downloadDir

  return (
    <MusicPageShell>
      <MusicHero
        eyebrow="Downloads"
        title="本地下载"
        subtitle="离线音乐会整齐地收在这里，像 Apple Music 资料库一样干净。"
        tone="blue"
        action={(
          <ActionButton tone="subtle" onClick={() => downloads.openDir()}>
            <FolderOpen size={16} />
            打开目录
          </ActionButton>
        )}
      />

      <div className="download-dashboard">
        <DownloadMetric icon={<Download size={19} />} label="已下载" value={`${downloadedCount} 首`} />
        <DownloadMetric icon={<HardDrive size={19} />} label="占用空间" value={formatBytes(totalSize)} />
        <DownloadMetric
          icon={<Music size={19} />}
          label="离线可听"
          value={downloadedCount > 0 ? `${downloadedCount} 首可离线播放` : activeCount > 0 ? `${activeCount} 项下载中` : '未开始'}
        />
      </div>

      <MusicSection title="下载列表" icon={<Music size={22} />}>
        {records.length === 0 ? (
          <div className="download-empty-shell">
            <EmptyLibrary
              icon={<Download size={40} />}
              title="还没有本地音乐"
              subtitle={`在搜索或歌单中点击下载按钮，歌曲会保存到 ${downloadDir}`}
            />
          </div>
        ) : (
          <>
            {downloadedCount > 0 && (
              <div className="download-list-toolbar">
                <span>共 {records.length} 项 · {activeCount > 0 ? `${activeCount} 项进行中` : '全部完成'}</span>
                <button type="button" onClick={() => downloads.clearCompleted()}>
                  <Trash2 size={14} /> 清除已完成记录
                </button>
              </div>
            )}
            <div className="download-list">
              {records.map((record) => (
                <DownloadRow key={record.id} record={record} />
              ))}
            </div>
          </>
        )}
      </MusicSection>
    </MusicPageShell>
  )
}

function DownloadRow({ record }: { record: DownloadRecord }) {
  const downloads = useDownloads()
  const player = usePlayer()
  const { track, status, percent, phase, error } = record
  const phaseText: Record<string, string> = {
    resolve: '解析音源', audio: '下载音频', cover: '处理封面', meta: '写入信息', done: '完成',
  }

  return (
    <div className={`download-row download-row--${status}`}>
      <div className="download-row__cover">
        {track.coverUrl ? <img src={track.coverUrl} alt="" loading="lazy" /> : <Music size={20} />}
      </div>
      <div className="download-row__main">
        <div className="download-row__title">{track.title}</div>
        <div className="download-row__meta">
          {track.artist} · {formatDuration(track.duration)}
          {track.playCount ? ` · ${formatCount(track.playCount)}播放` : ''}
        </div>
        {status === 'downloading' && (
          <div className="download-row__progress">
            <div className="download-row__progress-track">
              <div className="download-row__progress-fill" style={{ width: `${percent}%` }} />
            </div>
            <span>{phaseText[phase] || phase} {percent}%</span>
          </div>
        )}
        {status === 'error' && <div className="download-row__error">{error || '下载失败'}</div>}
        {status === 'done' && (
          <div className="download-row__done">
            <Check size={13} /> 已保存到本地{record.lyricPath ? ' · 含歌词' : ''}
            {record.size ? ` · ${formatBytes(record.size)}` : ''}
          </div>
        )}
      </div>
      <div className="download-row__actions">
        {status === 'done' && (
          <>
            <button type="button" title="播放本地文件" onClick={() => player.playNow(track)}>
              <Play size={15} />
            </button>
            <button type="button" title="打开文件" onClick={() => downloads.openFile(record)}>
              <FolderOpen size={15} />
            </button>
          </>
        )}
        {status === 'error' && (
          <button type="button" title="重试" onClick={() => downloads.retry(record.id)}>
            <RefreshCw size={15} />
          </button>
        )}
        {status === 'downloading' && <span className="download-row__spinner" title="下载中" />}
        <button type="button" title="移除记录" onClick={() => downloads.remove(record.id)}>
          <X size={15} />
        </button>
      </div>
    </div>
  )
}

function DownloadMetric({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <article className="download-metric">
      <span>{icon}</span>
      <div>
        <p>{label}</p>
        <strong>{value}</strong>
      </div>
    </article>
  )
}
