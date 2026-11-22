import { ipcMain, net, app, session } from 'electron'
import path from 'path'
import fs from 'fs/promises'
import { writeId3Tag } from './id3Tag'

const BILI_API = 'https://api.bilibili.com'
const BILI_PASSPORT = 'https://passport.bilibili.com'
const BILI_REFERER = 'https://www.bilibili.com'

/** 下载任务参数（由渲染层队列逐个提交） */
export interface DownloadTask {
  id: string // 曲目 id（bvId）
  bvid: string
  aid?: string | number
  cid?: string | number
  title: string
  artist: string
  coverUrl: string
  duration: number
  targetDir: string
  quality: '标准' | '高品质' | '无损'
  writeMeta: boolean // 写 ID3 标签 + 内嵌封面
  saveLyric: boolean // 保存 .lrc 歌词文件
  lyricText?: string // 渲染层已匹配好的 LRC 文本
}

export interface DownloadProgress {
  id: string
  phase: 'resolve' | 'audio' | 'cover' | 'meta' | 'done'
  percent: number // 0-100
}

/** Windows/ POSIX 通用文件名安全化，避免非法字符导致写盘失败 */
function safeFileName(name: string, maxLen = 120): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen)
  return cleaned || 'untitled'
}

/** 流式下载到 buffer，并通过回调报告 0-100 进度 */
async function downloadToBuffer(
  url: string,
  headers: Record<string, string>,
  onProgress?: (percent: number) => void,
): Promise<{ data: Buffer; mime: string }> {
  const response = await net.fetch(url, { headers })
  if (!response.ok) throw new Error(`下载失败: HTTP ${response.status}`)

  const mime = response.headers.get('content-type') || 'application/octet-stream'
  const total = Number(response.headers.get('content-length') || 0)

  if (!response.body) {
    return { data: Buffer.from(await response.arrayBuffer()), mime }
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      chunks.push(value)
      received += value.length
      if (total > 0 && onProgress) {
        onProgress(Math.min(99, Math.round((received / total) * 100)))
      }
    }
  }
  return { data: Buffer.concat(chunks), mime }
}

/** 从 Cookies 构造带登录态的请求头 */
async function authHeaders(): Promise<Record<string, string>> {
  const cookies = await session.defaultSession.cookies.get({ url: BILI_API })
  const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ')
  const headers: Record<string, string> = {
    Referer: BILI_REFERER,
    Origin: 'https://www.bilibili.com',
  }
  if (cookieHeader) headers['Cookie'] = cookieHeader
  return headers
}

/**
 * 解析最佳音轨地址。fnval=16 取 DASH；无损需 fnval=1 且登录态（会员），
 * 失败时回退到高品质 DASH，保证下载不因音质档位而整体失败。
 */
async function resolveAudioUrl(task: DownloadTask): Promise<{ url: string; mime: string; quality: number }> {
  let bvid = task.bvid || task.id
  let aid = task.aid || ''
  let cid = task.cid || ''

  // 搜索页 / UP 主空间等入口构造的 Track 通常只有 bvid，没有 cid。
  // playurl 必须携带正确 cid，否则 B 站返回 -400「请求错误」。
  if (!cid && bvid) {
    try {
      const detail = await fetchBiliApi(`/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`)
      if (detail?.cid) cid = String(detail.cid)
      if (!aid && detail?.aid) aid = String(detail.aid)
    } catch (err: any) {
      throw new Error(`解析视频 CID 失败: ${err?.message || String(err)}`)
    }
  }
  if (!cid) throw new Error('缺少视频 CID，无法解析音源')

  const tryFetch = async (fnval: number, qn: number) => {
    const params = new URLSearchParams({
      qn: String(qn),
      fnver: '0',
      fnval: String(fnval),
      fourk: '1',
      cid: String(cid),
    })
    if (bvid) params.set('bvid', bvid)
    else if (aid) params.set('avid', String(aid))
    else throw new Error('缺少视频标识（bvid / aid）')

    const urlPath = `/x/player/playurl?${params.toString()}`
    const data = await fetchBiliApi(urlPath)
    const streams = data?.dash?.audio || []
    if (!streams.length) {
      // DASH 无音轨时回退到 durl（整段带画面的 mp4/flv），取其中音频
      const durl = data?.durl?.[0]?.url
      if (durl) return { url: durl, mime: 'video/mp4', quality: qn }
      throw new Error('未找到可用音轨')
    }
    const best = [...streams].sort((a: any, b: any) => (b.bandwidth || 0) - (a.bandwidth || 0))[0]
    return { url: best.baseUrl || best.backupUrl?.[0], mime: best.mimeType || 'audio/mp4', quality: best.quality || qn }
  }

  if (task.quality === '无损') {
    try { return await tryFetch(1, 3) } catch { /* 回退高品质 */ }
  }
  if (task.quality === '高品质') {
    try { return await tryFetch(16, 0) } catch { /* 回退标准 */ }
  }
  return tryFetch(16, 0)
}

// ===== IPC Handlers =====

export function registerBiliApiHandlers() {
  // 搜索视频
  ipcMain.handle('bili:search', async (_event, keyword: string, page = 1, pageSize = 20) => {
    return fetchBiliApi(`/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(keyword)}&page=${page}&pagesize=${pageSize}`)
  })

  // 视频详情
  ipcMain.handle('bili:videoDetail', async (_event, bvid: string) => {
    return fetchBiliApi(`/x/web-interface/view?bvid=${bvid}`)
  })

  // 音频流地址
  ipcMain.handle('bili:playUrl', async (_event, bvid: string, cid: number) => {
    return fetchBiliApi(`/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=0&fnver=0&fnval=16&fourk=1`)
  })

  // 用户信息（登录状态）
  ipcMain.handle('bili:nav', async () => {
    return fetchBiliApi('/x/web-interface/nav')
  })

  // 热门视频
  ipcMain.handle('bili:popular', async (_event, ps = 10, pn = 1) => {
    return fetchBiliApi(`/x/web-interface/popular?ps=${ps}&pn=${pn}`)
  })

  // 推荐视频
  ipcMain.handle('bili:recommend', async (_event, ps = 10) => {
    return fetchBiliApi(`/x/web-interface/index/top/rcmd?ps=${ps}`)
  })

  // 音乐排行榜
  ipcMain.handle('bili:musicRanking', async () => {
    return fetchBiliApi('/x/web-interface/ranking/region?rid=3&day=3')
  })

  // 收藏夹列表
  ipcMain.handle('bili:favorites', async (_event, mid: number) => {
    return fetchBiliApi(`/x/v3/fav/folder/created/list-all?up_mid=${mid}`)
  })

  // 下载音频文件到本地
  ipcMain.handle('bili:downloadAudio', async (_event, audioUrl: string, filename: string) => {
    const downloadDir = path.join(app.getPath('userData'), 'downloads')
    await fs.mkdir(downloadDir, { recursive: true })
    const filePath = path.join(downloadDir, filename)

    const response = await net.fetch(audioUrl, {
      headers: { Referer: BILI_REFERER },
    })

    if (!response.ok) throw new Error(`Download failed: ${response.status}`)

    const buffer = Buffer.from(await response.arrayBuffer())
    await fs.writeFile(filePath, buffer)

    return { filePath, size: buffer.length }
  })

  /**
   * 完整下载流程（体验完善版）：
   * 解析音源 → 流式下载音频 → 可选下载封面 → 可选写 ID3（含内嵌封面）→ 可选保存 LRC。
   * 每个阶段通过 webContents 回传进度，渲染层据此更新队列 UI。
   */
  ipcMain.handle('bili:download', async (event, task: DownloadTask) => {
    const send = (phase: DownloadProgress['phase'], percent: number) => {
      event.sender.send('bili:download-progress', { id: task.id, phase, percent } as DownloadProgress)
    }
    try {
      await fs.mkdir(task.targetDir, { recursive: true })

      // 1. 解析音源
      send('resolve', 0)
      const audioSource = await resolveAudioUrl(task)
      send('resolve', 100)

      // 2. 下载音频（流式，0-90%）
      const headers = await authHeaders()
      const { data: audioData } = await downloadToBuffer(audioSource.url, headers, (p) => {
        send('audio', Math.round(p * 0.9))
      })
      send('audio', 90)

      // 3. 下载封面（可选，用于内嵌 ID3 与独立封面文件）
      let coverData: Buffer | undefined
      let coverMime = 'image/jpeg'
      if (task.writeMeta && task.coverUrl) {
        try {
          const coverUrl = task.coverUrl.startsWith('//') ? `https:${task.coverUrl}` : task.coverUrl
          const cover = await downloadToBuffer(coverUrl, { Referer: BILI_REFERER })
          coverData = cover.data
          coverMime = cover.mime.includes('png') ? 'image/png' : 'image/jpeg'
        } catch {
          // 封面失败不影响音频主体
        }
      }
      send('cover', 95)

      // 4. 写 ID3 标签（标题/歌手/专辑/封面）
      let finalData = audioData
      if (task.writeMeta) {
        try {
          finalData = writeId3Tag(audioData, {
            title: task.title,
            artist: task.artist,
            album: task.title,
            year: '',
            cover: coverData ? { data: coverData, mime: coverMime } : undefined,
          })
        } catch {
          // ID3 写入失败仍保存原始音频
          finalData = audioData
        }
      }
      send('meta', 97)

      // 5. 落盘：文件名安全化 + 扩展名按 MIME 判断
      const ext = audioSource.mime.includes('mpeg') || audioSource.mime.includes('mp3')
        ? '.mp3'
        : audioSource.mime.includes('flac') ? '.flac' : '.m4a'
      const base = safeFileName(`${task.artist ? task.artist + ' - ' : ''}${task.title}`)
      const fileName = `${base}${ext}`
      const filePath = path.join(task.targetDir, fileName)
      await fs.writeFile(filePath, finalData)

      // 6. 保存独立封面文件（可选）
      if (coverData) {
        const coverExt = coverMime === 'image/png' ? '.png' : '.jpg'
        await fs.writeFile(path.join(task.targetDir, `${base}${coverExt}`), coverData).catch(() => {})
      }

      // 7. 保存 LRC 歌词（可选）
      let lyricPath: string | undefined
      if (task.saveLyric && task.lyricText) {
        lyricPath = path.join(task.targetDir, `${base}.lrc`)
        await fs.writeFile(lyricPath, task.lyricText, 'utf8').catch(() => { lyricPath = undefined })
      }

      send('done', 100)
      return { filePath, size: finalData.length, lyricPath }
    } catch (err: any) {
      send('done', 0)
      throw new Error(err?.message || String(err))
    }
  })

  // 提取完整音频源（一键流程）
  ipcMain.handle('bili:extractAudio', async (_event, bvid: string) => {
    const detail = await fetchBiliApi(`/x/web-interface/view?bvid=${bvid}`)
    const playData = await fetchBiliApi(`/x/player/playurl?bvid=${bvid}&cid=${detail.cid}&qn=0&fnver=0&fnval=16&fourk=1`)

    const audioStreams = playData.dash?.audio || []
    if (!audioStreams.length) throw new Error('No audio stream available')

    const bestAudio = [...audioStreams].sort((a, b) => b.bandwidth - a.bandwidth)[0]

    return {
      bvid: detail.bvid,
      aid: detail.aid,
      cid: detail.cid,
      title: detail.title,
      artist: detail.owner?.name,
      coverUrl: detail.pic,
      duration: detail.duration,
      audioUrl: bestAudio.baseUrl,
      audioQuality: bestAudio.quality,
      audioMimeType: bestAudio.mimeType,
      bandwidth: bestAudio.bandwidth,
    }
  })

  // ===== 扫码登录 =====

  // 生成二维码
  ipcMain.handle('bili:qrGenerate', async () => {
    const url = `${BILI_PASSPORT}/x/passport-login/web/qrcode/generate`
    const response = await net.fetch(url, {
      headers: { Referer: `${BILI_PASSPORT}/login` },
    })
    const data = await response.json()

    if (data.code !== 0) {
      throw { code: data.code, message: data.message }
    }

    return {
      url: data.data.url,
      qrcodeKey: data.data.qrcode_key,
    }
  })

  // 轮询二维码状态
  ipcMain.handle('bili:qrPoll', async (_event, qrcodeKey: string) => {
    const url = `${BILI_PASSPORT}/x/passport-login/web/qrcode/poll?qrcode_key=${qrcodeKey}`
    const response = await net.fetch(url, {
      headers: { Referer: `${BILI_PASSPORT}/login` },
      redirect: 'manual',
    })

    const httpStatus = response.status
    const setCookieHeaders = response.headers.getSetCookie?.() || []
    const isRedirect = httpStatus === 302 || httpStatus === 301

    if (isRedirect && setCookieHeaders.length > 0) {
      for (const cookieStr of setCookieHeaders) {
        try {
          await session.defaultSession.cookies.set({
            url: BILI_API,
            name: parseCookieName(cookieStr),
            value: parseCookieValue(cookieStr),
            domain: '.bilibili.com',
            path: '/',
            secure: true,
            httpOnly: true,
          })
        } catch {
        }
      }
      return {
        code: 0,
        status: 0,
        message: '登录成功',
        url: response.headers.get('Location') || '',
      }
    }

    const text = await response.text()
    let data: any
    try {
      data = JSON.parse(text)
    } catch {
      return { code: -1, status: -1, message: 'unknown', url: '' }
    }

    // B站 poll 响应：外层 code 表示 API 调用结果，
    // 内层 data.code 才是扫码状态（86101=未扫码, 86090=已扫码, 0=成功）
    return {
      code: data.data?.code ?? data.code,
      status: data.data?.code ?? data.code,
      message: data.data?.message || data.message,
      url: data.data?.url || '',
    }
  })

  // 获取当前 Cookie 中的登录状态
  ipcMain.handle('bili:getCookies', async () => {
    const cookies = await session.defaultSession.cookies.get({ domain: '.bilibili.com' })
    const sessdata = cookies.find(c => c.name === 'SESSDATA')
    const biliJct = cookies.find(c => c.name === 'bili_jct')
    const dedeUserId = cookies.find(c => c.name === 'DedeUserID')

    return {
      isLoggedIn: !!(sessdata && biliJct && dedeUserId),
      sessdata: sessdata?.value || '',
      biliJct: biliJct?.value || '',
      dedeUserId: dedeUserId?.value || '',
    }
  })

  // 退出登录（清除 Cookie）
  ipcMain.handle('bili:logout', async () => {
    await session.defaultSession.cookies.remove(BILI_API, 'SESSDATA')
    await session.defaultSession.cookies.remove(BILI_API, 'bili_jct')
    await session.defaultSession.cookies.remove(BILI_API, 'DedeUserID')
    await session.defaultSession.cookies.remove(BILI_API, 'DedeUserID__ckMd5')
    return { success: true }
  })
}

// ===== BiliBili API Fetch Helper =====

async function fetchBiliApi(urlPath: string): Promise<any> {
  const url = `${BILI_API}${urlPath}`
  // 从 session 中获取 Cookie，确保 API 请求携带登录态
  const cookies = await session.defaultSession.cookies.get({ url: BILI_API })
  const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ')

  const headers: Record<string, string> = {
    Referer: BILI_REFERER,
    Origin: 'https://www.bilibili.com',
  }
  if (cookieHeader) {
    headers['Cookie'] = cookieHeader
  }

  const response = await net.fetch(url, { headers })
  const contentType = response.headers.get('content-type') || ''
  const looksHtml = contentType.includes('text/html') || contentType.includes('text/plain')
  if (!response.ok || looksHtml) {
    throw {
      code: response.ok ? -1 : -response.status,
      message: `请求被拦截（HTTP ${response.status}，返回 ${contentType || '非 JSON 内容'}）`,
      path: urlPath,
    }
  }

  let data: any
  try {
    data = await response.json()
  } catch {
    throw { code: -1, message: '接口返回的数据格式无效', path: urlPath }
  }

  if (data.code !== 0) {
    throw { code: data.code, message: data.message, path: urlPath }
  }

  return data.data
}

// ===== Cookie 解析辅助 =====

function parseCookieName(setCookie: string): string {
  const pair = setCookie.split(';')[0]
  return pair.split('=')[0].trim()
}

function parseCookieValue(setCookie: string): string {
  const pair = setCookie.split(';')[0]
  return pair.split('=').slice(1).join('=').trim()
}