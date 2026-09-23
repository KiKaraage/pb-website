import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { IMAGE_SBOM_REGISTRY, validateImageSbomRegistry } from '../lib/image-sbom-registry.js'
import { extractMappedVersions } from '../lib/spdx-version-extractor.js'

const record = {
  id: 'bluefin-stable',
  product: 'bluefin',
  required: true,
  image: 'ghcr.io/ublue-os/bluefin:stable',
  certificateIdentityRegexp: '^https://github.com/ublue-os/bluefin/.github/workflows/[^@]+@refs/.+$',
  certificateOidcIssuer: 'https://token.actions.githubusercontent.com',
  packages: {
    base: { name: 'kernel-core', type: 'rpm', required: true },
  },
}

describe('validateImageSbomRegistry', () => {
  it('rejects duplicate image registry ids', () => {
    expect(() => validateImageSbomRegistry([
      record,
      { ...record, image: 'ghcr.io/ublue-os/bluefin-nvidia-open:stable' },
    ])).toThrow('duplicate image registry id "bluefin-stable"')
  })

  it('rejects image references without a tag or digest', () => {
    expect(() => validateImageSbomRegistry([
      { ...record, image: 'ghcr.io/ublue-os/bluefin' },
    ])).toThrow('image registry id "bluefin-stable" must use a tagged image reference')
  })

  it('rejects empty certificate identity constraints', () => {
    expect(() => validateImageSbomRegistry([
      { ...record, certificateIdentityRegexp: '' },
    ])).toThrow('image registry id "bluefin-stable" must define certificateIdentityRegexp')

    expect(() => validateImageSbomRegistry([
      { ...record, certificateOidcIssuer: ' ' },
    ])).toThrow('image registry id "bluefin-stable" must define certificateOidcIssuer')
  })

  it('rejects package mappings without a name', () => {
    expect(() => validateImageSbomRegistry([
      {
        ...record,
        packages: {
          base: { required: true },
        },
      },
    ])).toThrow('image registry id "bluefin-stable" package "base" must define name')
  })

  it('rejects package mappings without a required flag', () => {
    expect(() => validateImageSbomRegistry([
      {
        ...record,
        packages: {
          base: { name: 'kernel-core' },
        },
      },
    ])).toThrow('image registry id "bluefin-stable" package "base" must define required as a boolean')
  })

  it('rejects package mappings with non-boolean required flags', () => {
    expect(() => validateImageSbomRegistry([
      {
        ...record,
        packages: {
          base: { name: 'kernel-core', required: 'yes' as unknown as boolean },
        },
      },
    ])).toThrow('image registry id "bluefin-stable" package "base" must define required as a boolean')
  })

  it('rejects an empty packages object unless pendingSbom is true', () => {
    expect(() => validateImageSbomRegistry([
      { ...record, packages: {} },
    ])).toThrow('image registry id "bluefin-stable" must define packages unless pendingSbom is true')
  })

  it('allows empty packages when pendingSbom is true', () => {
    expect(() => validateImageSbomRegistry([
      {
        ...record,
        pendingSbom: true,
        packages: {},
      },
    ])).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Live-evidence selectors
//
// These fixtures are trimmed copies of the published SBOMs. They exist so the
// selectors that disambiguate a real package name stay pinned to the evidence
// that justified them, and so a regression is a test failure rather than a
// silently omitted version on the website.
// ---------------------------------------------------------------------------

const dakotaElements = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/dakota-mesa-systemd-elements.spdx.json'), 'utf8'),
)
const bluefinCatalogers = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/bluefin-stable-catalogers.syft.json'), 'utf8'),
)

function recordFor(id: string) {
  const record = IMAGE_SBOM_REGISTRY.find(r => r.id === id)
  expect(record, `registry record ${id} not found`).toBeDefined()
  return record!
}

describe('registry selectors resolve known live ambiguities', () => {
  it('pins Dakota mesa to the mesa extension element', () => {
    const { packages } = recordFor('dakota')
    expect(packages.mesa.element).toBe('freedesktop-sdk.bst:extensions/mesa/mesa.bst')

    const result = extractMappedVersions(dakotaElements, { mesa: packages.mesa })
    expect(result.ambiguous).toEqual([])
    expect(result.values.mesa).toBe('26.0.6')
  })

  it('pins Dakota systemd to the gnome-build-meta systemd-base element', () => {
    const { packages } = recordFor('dakota')
    expect(packages.systemd.element).toBe('gnome-build-meta.bst:core-deps/systemd-base.bst')

    const result = extractMappedVersions(dakotaElements, { systemd: packages.systemd })
    expect(result.ambiguous).toEqual([])
    expect(result.values.systemd).toBe('260.2')
  })

  it('is ambiguous for Dakota mesa and systemd without the element pins', () => {
    const result = extractMappedVersions(dakotaElements, {
      mesa: { name: 'mesa', required: true },
      systemd: { name: 'systemd', required: false },
    })
    expect(result.ambiguous.sort()).toEqual(['mesa', 'systemd'])
  })

  it('pins Bluefin podman to the RPM database cataloger', () => {
    const { packages } = recordFor('bluefin-stable')
    expect(packages.podman.foundBy).toBe('rpm-db-cataloger')

    const result = extractMappedVersions(bluefinCatalogers, { podman: packages.podman })
    expect(result.ambiguous).toEqual([])
    // Raw RPM evidence keeps its epoch; the projection strips it for display.
    expect(result.values.podman).toBe('5:5.8.4-1.fc44')
  })

  it('pins Bluefin mesa to the installed RPM database package', () => {
    const { packages } = recordFor('bluefin-stable')
    expect(packages.mesa.required).toBe(false)
    expect(packages.mesa).toMatchObject({
      name: 'mesa-dri-drivers',
      type: 'rpm',
      foundBy: 'rpm-db-cataloger',
    })

    const result = extractMappedVersions(bluefinCatalogers, { mesa: packages.mesa })
    expect(result.ambiguous).toEqual([])
    expect(result.values.mesa).toBe('1:26.1.4-4.fc44')
  })

  it('resolves Bluefin kernel-core and systemd unambiguously', () => {
    const { packages } = recordFor('bluefin-stable')
    const result = extractMappedVersions(bluefinCatalogers, {
      kernel: packages.kernel,
      systemd: packages.systemd,
    })
    expect(result.ambiguous).toEqual([])
    expect(result.values.kernel).toBe('7.1.6-201.fc44')
    expect(result.values.systemd).toBe('259.8-1.fc44')
  })
})

describe('dakota image references name tags the publisher actually publishes', () => {
  // ghcr.io/projectbluefin/dakota publishes `latest`, but its variant
  // repositories do not: they publish `testing`/`stable` only. A variant
  // pinned to `:latest` can never resolve, which is what produced the
  // recurring `image-not-found` verification failure for dakota-nvidia.
  const dakotaVariants = IMAGE_SBOM_REGISTRY.filter(
    entry => entry.product === 'dakota' && entry.id !== 'dakota',
  )

  it('covers every dakota variant', () => {
    expect(dakotaVariants.map(entry => entry.id).sort()).toEqual([
      'dakota-gaming',
      'dakota-nvidia',
      'dakota-nvidia-gaming',
    ])
  })

  it.each(dakotaVariants.map(entry => entry.id))('%s does not point at the unpublished :latest tag', (id) => {
    const { image } = recordFor(id)
    expect(image.endsWith(':latest')).toBe(false)
    expect(image).toMatch(/:(?:testing|stable)$/)
  })

  it('keeps dakota-nvidia pending until it publishes an SPDX referrer', () => {
    const entry = recordFor('dakota-nvidia')
    expect(entry.image).toBe('ghcr.io/projectbluefin/dakota-nvidia:testing')
    expect(entry.pendingSbom).toBe(true)
    // The nvidia mapping stays declared: SectionPicker.vue consumes the key,
    // and pendingSbom short-circuits before the mapping is resolved.
    expect(Object.keys(entry.packages)).toEqual(['nvidia'])
  })

  it('still lets the base dakota image use :latest', () => {
    expect(recordFor('dakota').image).toBe('ghcr.io/projectbluefin/dakota:latest')
  })
})
