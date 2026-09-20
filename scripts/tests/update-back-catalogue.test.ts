import type { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { auditExperience, buildExperience, refreshMetadata } from '../update-back-catalogue.js'

const album = { id: 'PLtest', title: 'Test Album', description: 'A test album' }

function entry(overrides = {}) {
  return { id: 'vid00000001', title: 'Artist - Song', duration: 200, ...overrides }
}

describe('buildExperience', () => {
  it('applies the artist override for the Voice of Baceprot channel name', () => {
    const experience = buildExperience(album, [
      entry({ id: '4aZX-C8HKJc', title: 'VoB (Voice of Baceprot) - School Revolution' }),
    ])

    expect(experience.segments[0].artist).toBe('Voice of Baceprot')
  })
})

describe('auditExperience', () => {
  it('accepts a well-formed experience', () => {
    const entries = [entry()]
    expect(() => auditExperience(album, entries, buildExperience(album, entries))).not.toThrow()
  })

  it('rejects an empty artist', () => {
    const entries = [entry()]
    const experience = buildExperience(album, entries)
    experience.segments[0].artist = '   '

    expect(() => auditExperience(album, entries, experience)).toThrow(/empty artist/)
  })

  it('rejects an empty title', () => {
    const entries = [entry()]
    const experience = buildExperience(album, entries)
    experience.segments[0].title = ''

    expect(() => auditExperience(album, entries, experience)).toThrow(/empty title/)
  })

  it('rejects an implausible duration', () => {
    const entries = [entry()]
    const experience = buildExperience(album, entries)
    experience.segments[0].durationSeconds = 60 * 60 * 5

    expect(() => auditExperience(album, entries, experience)).toThrow(/implausible duration/)
  })

  it('rejects a non-finite duration', () => {
    const entries = [entry()]
    const experience = buildExperience(album, entries)
    experience.segments[0].durationSeconds = Number.POSITIVE_INFINITY

    expect(() => auditExperience(album, entries, experience)).toThrow(/implausible duration/)
  })

  it('still rejects a zero duration', () => {
    const entries = [entry()]
    const experience = buildExperience(album, entries)
    experience.segments[0].durationSeconds = 0

    expect(() => auditExperience(album, entries, experience)).toThrow(/bad duration/)
  })
})

describe('refreshMetadata', () => {
  it('recovers an album from git HEAD when the cached catalogue on disk is missing it', async () => {
    const onDiskCatalogue = {
      experiences: [
        { id: 'PL1', title: 'Album 1', subtitle: 'Old Sub', artwork: 'experiences/PL1.jpg', segments: [] },
      ],
    }
    const gitTrackedCatalogue = {
      experiences: [
        { id: 'PL1', title: 'Album 1', subtitle: 'Old Sub', artwork: 'experiences/PL1.jpg', segments: [] },
        { id: 'PL2', title: 'Album 2', subtitle: 'Sub 2', artwork: 'experiences/PL2.jpg', segments: [] },
      ],
    }
    const upstreamMetadata = [
      { id: 'PL1', title: 'Album 1 New', description: 'New Sub 1' },
      { id: 'PL2', title: 'Album 2', description: 'Sub 2' },
    ]

    const writtenFiles = new Map<string, string>()

    const { missing } = await refreshMetadata({
      fetch: async () => ({
        ok: true,
        json: async () => upstreamMetadata,
        arrayBuffer: async () => new ArrayBuffer(8),
      }),
      readFile: async () => JSON.stringify(onDiskCatalogue),
      writeFile: async (path: string, content: string | Buffer) => {
        writtenFiles.set(path, typeof content === 'string' ? content : 'binary')
      },
      gitShow: () => JSON.stringify(gitTrackedCatalogue),
      cataloguePath: '/fake/catalogue.json',
      experiencesDir: '/fake',
    })

    expect(missing).toHaveLength(0)
    const savedCatalogue = JSON.parse(writtenFiles.get('/fake/catalogue.json')!)
    expect(savedCatalogue.experiences).toHaveLength(2)
    expect(savedCatalogue.experiences.map((e: { id: string }) => e.id)).toEqual(['PL1', 'PL2'])
    expect(savedCatalogue.experiences[0].title).toBe('Album 1 New')
  })

  it('reports missing albums when absent from both disk and git HEAD', async () => {
    const onDiskCatalogue = { experiences: [] }
    const upstreamMetadata = [
      { id: 'PL_new', title: 'Unpublished Album', description: 'Desc' },
    ]
    const writtenFiles = new Map<string, string>()

    const { missing } = await refreshMetadata({
      fetch: async () => ({
        ok: true,
        json: async () => upstreamMetadata,
        arrayBuffer: async () => new ArrayBuffer(8),
      }),
      readFile: async () => JSON.stringify(onDiskCatalogue),
      writeFile: async (path: string, content: string | Buffer) => {
        writtenFiles.set(path, typeof content === 'string' ? content : 'binary')
      },
      gitShow: () => JSON.stringify({ experiences: [] }),
      cataloguePath: '/fake/catalogue.json',
      experiencesDir: '/fake',
      missingAlbumsFile: '/fake/missing.txt',
    })

    expect(missing).toHaveLength(1)
    expect(missing[0].id).toBe('PL_new')
    expect(writtenFiles.get('/fake/missing.txt')).toContain('Unpublished Album (PL_new)')
  })
})
