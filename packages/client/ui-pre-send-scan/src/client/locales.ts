/** `presendscan` namespace dictionaries (the composer pre-send scan badge's copy). */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'badge.label.ok': 'OK',
  'badge.label.off': 'OFF',
  'badge.aria': '发送前安全扫描',
  'badge.title.on': '发送前扫描：{hits} 处命中',
  'badge.title.on.severity': '发送前扫描：{hits} 处命中，最严重：{severity}',
  'badge.title.off': '发送前扫描已关闭（点击开启）',
} satisfies Record<string, string>

/** The presendscan namespace key union. */
export type PresendScanKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'badge.label.ok': 'OK',
  'badge.label.off': 'OFF',
  'badge.aria': 'Security scan',
  'badge.title.on': 'Pre-send scan: {hits} hit(s)',
  'badge.title.on.severity': 'Pre-send scan: {hits} hit(s), worst: {severity}',
  'badge.title.off': 'Pre-send scan disabled (click to enable)',
} satisfies Record<PresendScanKey, string>
