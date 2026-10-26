import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'
import { Miniflare, type MiniflareOptions } from 'miniflare'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export interface SqlDatabase {
  exec(sql: string): Promise<unknown>
  prepare(sql: string): {
    bind(...values: unknown[]): {
      first<T = Record<string, unknown>>(): Promise<T | null>
      all<T = Record<string, unknown>>(): Promise<{ results: T[] }>
      run(): Promise<unknown>
    }
  }
}

export interface WorkerHarness {
  fetch(input: string, init?: RequestInit & { cf?: Record<string, unknown> }): Promise<Response>
  db: SqlDatabase
  dispose(): Promise<void>
}

export async function bootWorker(options?: { bindings?: Record<string, string> }): Promise<WorkerHarness> {
  const built = await esbuild.build({
    entryPoints: [path.join(root, 'src/worker/index.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    conditions: ['workerd', 'worker', 'browser'],
  })
  const wrangler = readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8')
  const compatibilityDate = /"compatibility_date":\s*"([^"]+)"/.exec(wrangler)?.[1] ?? '2025-09-01'
  const bindings = {
    ADMIN_PASSWORD: 'test-password',
    SESSION_SECRET: 'test-session-secret',
    ...options?.bindings,
  }
  const env: Record<string, { type: 'text'; value: string } | { type: 'd1'; name: string }> = {
    DB: { type: 'd1', name: 'minilytics' },
  }
  for (const [name, value] of Object.entries(bindings)) env[name] = { type: 'text', value: value }

  const mf = new Miniflare({
    workers: [
      {
        config: {
          name: 'minilytics',
          compatibilityDate,
          manifest: {
            mainModule: 'index.js',
            modules: { 'index.js': { type: 'esm', contents: built.outputFiles[0].text } },
          },
          env,
        },
      },
    ],
  } as MiniflareOptions)

  const db = (await mf.getD1Database('DB')) as SqlDatabase
  const migrations = readdirSync(path.join(root, 'migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort()
  for (const name of migrations) {
    // D1's exec rejects a leading `--` comment and a CREATE split across lines.
    const sql = readFileSync(path.join(root, 'migrations', name), 'utf8')
      .split('\n')
      .map((line) => {
        const comment = line.indexOf('--')
        return comment === -1 ? line : line.slice(0, comment)
      })
      .join(' ')
      .trim()
    if (sql) await db.exec(sql)
  }

  return {
    fetch(input, init) {
      return mf.dispatchFetch(input, init as Parameters<Miniflare['dispatchFetch']>[1]) as unknown as Promise<Response>
    },
    db,
    dispose: () => mf.dispose(),
  }
}
