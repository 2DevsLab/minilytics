export const DEFAULT_SITE_TIMEZONE = 'Europe/Prague'

export function createSiteTimezone(requested: string | undefined, valid: (tz: string) => boolean): string {
  return requested && valid(requested) ? requested : DEFAULT_SITE_TIMEZONE
}
