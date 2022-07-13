import { intersects } from 'semver'
import { Dict, pick } from 'cosmokit'
import pMap from 'p-map'

export interface User {
  name: string
  email: string
  username?: string
}

export interface BasePackage {
  name: string
  version: string
  description: string
}

export interface PackageJson extends BasePackage {
  koishi?: Manifest
  keywords: string[]
  dependencies?: Dict<string>
  devDependencies?: Dict<string>
  peerDependencies?: Dict<string>
  optionalDependencies?: Dict<string>
}

export interface Manifest {
  hidden?: boolean
  description?: Dict<string>
  service?: {
    required?: string[]
    optional?: string[]
    implements?: string[]
  }
  locales?: string[]
  recommends?: string[]
}

export interface RemotePackage extends PackageJson {
  deprecated?: string
  author: User
  maintainers: User[]
  license: string
  dist: RemotePackage.Dist
}

export namespace RemotePackage {
  export interface Dist {
    shasum: string
    integrity: string
    tarball: string
    fileCount: number
    unpackedSize: number
  }
}

export interface Registry extends BasePackage {
  versions: Dict<RemotePackage>
  time: {
    created: string
    modified: string
  }
  license: string
  readme: string
  readmeFilename: string
}

export interface SearchPackage extends BasePackage {
  date: string
  links: Dict<string>
  author: User
  publisher: User
  maintainers: User[]
  keywords: string[]
}

export interface SearchObject {
  package: SearchPackage
  score: SearchObject.Score
  searchScore: number
}

export namespace SearchObject {
  export interface Score {
    final: number
    detail: Score.Detail
  }

  export namespace Score {
    export interface Detail {
      quality: number
      popularity: number
      maintenance: number
    }
  }
}

export interface SearchResult {
  total: number
  time: string
  objects: SearchObject[]
}

export interface AnalyzedPackage extends SearchPackage, SearchObject.Score.Detail {
  shortname: string
  official: boolean
  size: number
  license: string
  versions: RemotePackage[]
  manifest: Manifest
}

export interface CollectConfig {
  step?: number
  request<T>(url: string): Promise<T>
}

export interface AnalyzeConfig {
  version?: string
  concurrency?: number
  onSuccess(item: AnalyzedPackage): void
  onFailure?(name: string, reason: any): void
}

export interface ScanConfig extends CollectConfig, AnalyzeConfig {}

export function conclude(meta: PackageJson) {
  const manifest: Manifest = {
    description: {
      en: meta.description,
    },
    locales: [],
    recommends: [],
    ...meta.koishi,
    service: {
      required: [],
      optional: [],
      implements: [],
      ...meta.koishi?.service,
    },
  }

  for (const keyword of meta.keywords ?? []) {
    if (keyword === 'market:hidden') {
      manifest.hidden = true
    } else if (keyword.startsWith('required:')) {
      manifest.service.required.push(keyword.slice(9))
    } else if (keyword.startsWith('optional:')) {
      manifest.service.optional.push(keyword.slice(9))
    } else if (keyword.startsWith('impl:')) {
      manifest.service.implements.push(keyword.slice(5))
    } else if (keyword.startsWith('locale:')) {
      manifest.locales.push(keyword.slice(7))
    }
  }

  return manifest
}

export class Scanner {
  public objects: Dict<SearchObject> = Object.create(null)

  constructor(private config: CollectConfig) {}

  private async search(offset: number) {
    const { step = 250, request } = this.config
    const result = await request<SearchResult>(`/-/v1/search?text=koishi+plugin&size=${step}&offset=${offset}`)
    for (const object of result.objects) {
      this.objects[object.package.name] = object
    }
    return result.total
  }

  public async collect() {
    const { step = 250 } = this.config
    const total = await this.search(0)
    for (let offset = step; offset < total; offset += step) {
      await this.search(offset)
    }
    return this.objects
  }

  public async analyze(config: AnalyzeConfig) {
    const { request } = this.config
    const { concurrency = 10, version, onSuccess, onFailure } = config

    await pMap(Object.values(this.objects), async (object) => {
      const { name } = object.package
      const official = name.startsWith('@koishijs/plugin-')
      const community = name.startsWith('koishi-plugin-')
      if (!official && !community) return

      let registry: Registry
      try {
        registry = await request<Registry>(`/${name}`)
      } catch (error) {
        onFailure?.(name, error)
        return
      }

      const versions = Object.values(registry.versions).filter((remote) => {
        const { dependencies, peerDependencies, deprecated } = remote
        const declaredVersion = { ...dependencies, ...peerDependencies }['koishi']
        try {
          return !deprecated && declaredVersion && intersects(version, declaredVersion)
        } catch {}
      }).reverse()
      if (!versions.length) return

      const latest = registry.versions[versions[0].version]
      latest.keywords ??= []
      const manifest = conclude(latest)
      if (manifest.hidden) return

      const shortname = official ? name.slice(17) : name.slice(14)
      onSuccess({
        name,
        manifest,
        shortname,
        official,
        versions,
        size: latest.dist.unpackedSize,
        ...pick(object.package, ['date', 'links', 'publisher', 'maintainers']),
        ...pick(latest, ['keywords', 'version', 'description', 'license', 'author']),
        ...object.score.detail,
      })
    }, { concurrency })
  }
}

export default async function scan(config: ScanConfig) {
  const scanner = new Scanner(config)
  await scanner.collect()
  await scanner.analyze(config)
}