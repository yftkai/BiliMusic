/**
 * 轻量 ID3v2.3 标签写入器（纯 TypeScript，无第三方依赖）
 *
 * 之所以不引入 node-id3 / music-metadata：它们是原生或含大量依赖的包，
 * 会触发 electron-builder 的 native rebuild，在本机符号链接权限受限的环境下
 * 增加打包风险。这里只需要写入最基础的标签（标题/歌手/专辑/封面），
 * 用 Buffer 直接构造 ID3v2.3 帧即可，代码量小且完全可控。
 */

export interface Id3Meta {
  title?: string
  artist?: string
  album?: string
  year?: string
  cover?: { data: Buffer; mime: string } // JPEG/PNG 封面字节
}

/** 将 ID3v2.3 标签前置到音频 buffer。若已存在 ID3 头则先剥离。 */
export function writeId3Tag(audio: Buffer, meta: Id3Meta): Buffer {
  const frames: Buffer[] = []

  if (meta.title) frames.push(textFrame('TIT2', meta.title))
  if (meta.artist) frames.push(textFrame('TPE1', meta.artist))
  if (meta.album) frames.push(textFrame('TALB', meta.album))
  if (meta.year) frames.push(textFrame('TYER', meta.year))
  if (meta.cover) frames.push(coverFrame(meta.cover.data, meta.cover.mime))

  if (frames.length === 0) return audio

  const body = Buffer.concat(frames)
  const header = buildHeader(body.length)

  // 剥离旧的 ID3v2 标签（若存在），避免重复标签
  const clean = stripExistingId3(audio)
  return Buffer.concat([header, body, clean])
}

/** 构造 10 字节 ID3v2.3 头（synchsafe 尺寸编码） */
function buildHeader(size: number): Buffer {
  const h = Buffer.alloc(10)
  h.write('ID3', 0, 'ascii')
  h[3] = 3 // 主版本 v2.3
  h[4] = 0 // 修订版本
  h[5] = 0 // flags
  // synchsafe：每字节仅低 7 位有效
  h[6] = (size >> 21) & 0x7f
  h[7] = (size >> 14) & 0x7f
  h[8] = (size >> 7) & 0x7f
  h[9] = size & 0x7f
  return h
}

/** 文本帧 TIT2/TPE1/TALB/TYER：ISO-8859-1 编码（中文用 UTF-16 需在编码字节写 1） */
function textFrame(id: string, value: string): Buffer {
  // 用 UTF-16LE 以正确保存中文；编码字节 0x01 = UTF-16 with BOM
  const hasNonAscii = /[^\x00-\x7f]/.test(value)
  const encoding = hasNonAscii ? 1 : 0
  const text = hasNonAscii
    ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(value, 'utf16le')])
    : Buffer.from(value, 'ascii')

  return dataFrame(id, Buffer.concat([Buffer.from([encoding]), text]))
}

/** 附加图片帧 APIC：MIME + 图片类型(3=封面正面) + 描述 + 二进制 */
function coverFrame(image: Buffer, mime: string): Buffer {
  const mimeBytes = Buffer.from(mime || 'image/jpeg', 'ascii')
  const desc = Buffer.from([0]) // 空描述，ISO-8859-1 结尾 0
  const payload = Buffer.concat([
    Buffer.from([0]), // 编码字节：ISO-8859-1
    mimeBytes,
    Buffer.from([0]), // MIME 结尾
    Buffer.from([3]), // 图片类型：3 = front cover
    desc,
    image,
  ])
  return dataFrame('APIC', payload)
}

/** 通用帧封装：4 字节帧 ID + 4 字节大端尺寸 + 2 字节标志 + 数据 */
function dataFrame(id: string, data: Buffer): Buffer {
  const header = Buffer.alloc(10)
  header.write(id, 0, 4, 'ascii')
  header.writeUInt32BE(data.length, 4)
  header[8] = 0
  header[9] = 0
  return Buffer.concat([header, data])
}

/** 剥离已有 ID3v2 标签 */
function stripExistingId3(audio: Buffer): Buffer {
  if (audio.length < 10 || audio.toString('ascii', 0, 3) !== 'ID3') return audio
  const size =
    ((audio[6] & 0x7f) << 21) |
    ((audio[7] & 0x7f) << 14) |
    ((audio[8] & 0x7f) << 7) |
    (audio[9] & 0x7f)
  return audio.subarray(10 + size)
}
