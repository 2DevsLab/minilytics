export const SHARE_PERIODS = ['24h', '7d', '30d'] as const
export type SharePeriod = (typeof SHARE_PERIODS)[number]
export const DEFAULT_SHARE_PERIOD: SharePeriod = '7d'

export interface PublicLive {
  online: number
  today: number
  last24h: number
}

export interface PublicRow {
  label: string
  visitors: number
  pageviews: number
}

export interface PublicShare {
  period: SharePeriod
  visitors: number
  pageviews: number
  pages: PublicRow[]
  referrers: PublicRow[]
  countries: PublicRow[]
}
